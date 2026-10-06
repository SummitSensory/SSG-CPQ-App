import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Files uploaded against a vendor's Bill of Materials go out with the BOM email only
 * when the sender ticks them: each ticked file is attached alongside the sheet, the
 * send records which files it carried, an id that is not this section's stops the
 * send before anything leaves, and an oversize set of attachments is refused rather
 * than bounced by the provider.
 */

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/config/env.js', () => ({
  env: {
    RESEND_API_KEY: 're_test',
    BOM_FROM_NAME: 'Summit',
    BOM_FROM_EMAIL: 'bom@example.com',
    BOM_REPLY_TO: 'ops@example.com',
    BLOB_READ_WRITE_TOKEN: 'blob-token',
  },
}));

interface FileRow {
  id: string;
  sectionId: string;
  orderId: string;
  filename: string;
  contentType: string;
  byteSize: number;
  url: string;
  pathname: string;
  uploadedById: string;
  createdAt: Date;
}

const state = {
  files: [] as FileRow[],
  sendCreates: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
};

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    bomVendorSection: {
      findUnique: vi.fn(async () => ({
        id: 'sec1',
        orderId: 'o1',
        vendor: 'Acme Fab',
        status: 'SUBMITTED',
        order: { id: 'o1', number: 'SO-2026-000036' },
      })),
    },
    bomSectionFile: {
      findMany: vi.fn(async ({ where }: { where: { sectionId: string; id: { in: string[] } } }) =>
        state.files.filter((f) => f.sectionId === where.sectionId && where.id.in.includes(f.id)),
      ),
    },
    bomSend: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.sendCreates.push(data);
        return { id: 'send1', ...data };
      }),
      update: vi.fn(async () => ({})),
    },
    orderEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.events.push(data);
        return data;
      }),
    },
  },
}));

vi.mock('../../src/handoff/bomDocuments.js', () => ({
  renderBomHtml: vi.fn(async () => ({ html: '<p>bom</p>', doc: { customer: { name: 'Wiggle' } } })),
  renderBomXlsx: vi.fn(async () => ({ buffer: Buffer.from('xlsx') })),
  bomFilename: () => 'Wiggle-SO-2026-000036-Acme_Fab',
}));
vi.mock('../../src/handoff/bomSections.js', () => ({
  confirmSection: vi.fn(async () => undefined),
  submissionBlockers: vi.fn(async () => []),
}));
vi.mock('../../src/render/pdf.js', () => ({
  pdfAvailable: vi.fn(async () => true),
  renderPdf: vi.fn(async () => Buffer.from('%PDF-bom')),
}));

const blobBytes = new Map<string, Buffer>();
vi.mock('../../src/lib/fileStore.js', async (orig) => {
  const real = await orig<typeof import('../../src/lib/fileStore.js')>();
  return {
    ...real,
    getFile: vi.fn(async (url: string) => {
      const b = blobBytes.get(url);
      if (!b) throw new Error('404');
      return b;
    }),
  };
});

const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
  void _url;
  void _init;
  return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
});
vi.stubGlobal('fetch', fetchMock);

const { sendBom } = await import('../../src/handoff/bomSend.js');
const { bomFileContentType, bomFilePath } = await import('../../src/handoff/bomFiles.js');

const file = (id: string, filename: string, bytes: Buffer, sectionId = 'sec1'): FileRow => {
  const url = `https://blob.example/${id}`;
  blobBytes.set(url, bytes);
  return {
    id,
    sectionId,
    orderId: 'o1',
    filename,
    contentType: 'application/pdf',
    byteSize: bytes.length,
    url,
    pathname: `bom-files/x/${id}`,
    uploadedById: 'u1',
    createdAt: new Date(),
  };
};

const input = (attachmentIds?: string[]) => ({
  to: 'buyer@acme.example',
  subject: 'BOM',
  body: 'Hello',
  format: 'PDF' as const,
  attachmentIds,
});

function sentAttachments(): Array<{ filename: string; content: string }> {
  const init = fetchMock.mock.calls.at(-1)?.[1];
  return (
    JSON.parse(String(init?.body)) as { attachments: Array<{ filename: string; content: string }> }
  ).attachments;
}

beforeEach(() => {
  state.files = [];
  state.sendCreates = [];
  state.events = [];
  blobBytes.clear();
  fetchMock.mockClear();
});

describe('BOM email attachments', () => {
  it('attaches only the ticked files, after the sheet, and records them on the send', async () => {
    state.files = [
      file('f1', 'Frame drawing.pdf', Buffer.from('drawing')),
      file('f2', 'Finish sample.jpg', Buffer.from('sample')),
    ];
    await sendBom('sec1', input(['f2']), 'u1');

    const att = sentAttachments();
    expect(att.map((a) => a.filename)).toEqual([
      'Wiggle-SO-2026-000036-Acme_Fab.pdf',
      'Finish sample.jpg',
    ]);
    expect(Buffer.from(att[1]!.content, 'base64').toString()).toBe('sample');
    expect(state.sendCreates[0]!.attachedFiles).toEqual([
      { id: 'f2', filename: 'Finish sample.jpg', byteSize: 6 },
    ]);
    expect((state.events[0]!.detail as { files?: string[] }).files).toEqual(['Finish sample.jpg']);
  });

  it('sends just the sheet when nothing is ticked', async () => {
    state.files = [file('f1', 'Frame drawing.pdf', Buffer.from('drawing'))];
    await sendBom('sec1', input([]), 'u1');
    expect(sentAttachments()).toHaveLength(1);
    expect(state.sendCreates[0]!.attachedFiles).toBeUndefined();
  });

  it("refuses a file from another vendor's section, before anything is sent", async () => {
    state.files = [file('f9', 'Other vendor.pdf', Buffer.from('x'), 'sec2')];
    await expect(sendBom('sec1', input(['f9']), 'u1')).rejects.toThrow(/no longer on this Bill/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.sendCreates).toHaveLength(0);
  });

  it('refuses a file that cannot be read back from storage', async () => {
    const f = file('f1', 'Frame drawing.pdf', Buffer.from('drawing'));
    blobBytes.delete(f.url);
    state.files = [f];
    await expect(sendBom('sec1', input(['f1']), 'u1')).rejects.toThrow(/Frame drawing\.pdf/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses attachments over what one email can carry', async () => {
    state.files = [
      file('f1', 'a.pdf', Buffer.alloc(15 * 1024 * 1024)),
      file('f2', 'b.pdf', Buffer.alloc(15 * 1024 * 1024)),
    ];
    await expect(sendBom('sec1', input(['f1', 'f2']), 'u1')).rejects.toThrow(/Untick some files/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('BOM file types and paths', () => {
  it('types a file by its extension, including CAD files a browser leaves untyped', () => {
    expect(bomFileContentType('Drawing.PDF')).toBe('application/pdf');
    expect(bomFileContentType('frame.dwg')).toBe('image/vnd.dwg');
    expect(bomFileContentType('bracket.step')).toBe('model/step');
    expect(bomFileContentType('setup.exe')).toBeNull();
    expect(bomFileContentType('no-extension')).toBeNull();
  });

  it("files each upload under its order and vendor's own folder", () => {
    expect(
      bomFilePath({
        orderNumber: 'SO-2026-000036',
        vendor: 'Acme Fab, Inc.',
        fileId: 'bomf_1',
        filename: 'Frame drawing (rev B).pdf',
      }),
    ).toBe('bom-files/SO-2026-000036/Acme-Fab-Inc/bomf_1-Frame-drawing-rev-B-.pdf');
  });
});
