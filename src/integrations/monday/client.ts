import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

const API_URL = 'https://api.monday.com/v2';
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  error_code?: string;
  status_code?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function backoff(attempt: number, retryAfterSec?: number): number {
  if (retryAfterSec && retryAfterSec > 0) return Math.min(retryAfterSec * 1000, MAX_BACKOFF_MS);
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return exp + Math.floor(Math.random() * 250); // jitter
}

/**
 * monday.com GraphQL v2 client with rate-limit handling. Retries on HTTP 429
 * (honoring Retry-After) and on monday complexity/limit error codes, with
 * capped exponential backoff. Token comes only from env.
 */
export async function mondayQuery<T>(
  query: string,
  variables: Record<string, unknown> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  if (!env.MONDAY_API_TOKEN) throw new Error('MONDAY_API_TOKEN not configured');

  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetchImpl(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: env.MONDAY_API_TOKEN,
        'API-Version': '2024-01',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '') || undefined;
      const wait = backoff(attempt, retryAfter);
      logger.warn({ attempt, wait }, 'monday 429 rate-limited; backing off');
      await sleep(wait);
      lastErr = new Error('monday API HTTP 429');
      continue;
    }
    if (!res.ok) throw new Error(`monday API HTTP ${res.status}`);

    const body = (await res.json()) as GraphQLResponse<T>;
    const code = body.error_code ?? body.errors?.[0]?.extensions?.code;
    if (code === 'ComplexityException' || code === 'RATE_LIMIT_EXCEEDED') {
      const wait = backoff(attempt);
      logger.warn({ attempt, code, wait }, 'monday complexity/rate limit; backing off');
      await sleep(wait);
      lastErr = new Error(`monday ${code}`);
      continue;
    }
    if (body.errors?.length)
      throw new Error('monday API error: ' + body.errors.map((e) => e.message).join('; '));
    if (!body.data) throw new Error('monday API returned no data');
    return body.data;
  }
  throw lastErr ?? new Error('monday API: exhausted retries');
}

export { backoff };

export async function createItem(
  boardId: string,
  name: string,
  columnValues: Record<string, unknown>,
): Promise<string> {
  const data = await mondayQuery<{ create_item: { id: string } }>(
    `mutation ($board: ID!, $name: String!, $cols: JSON!) {
       create_item (board_id: $board, item_name: $name, column_values: $cols) { id }
     }`,
    { board: boardId, name, cols: JSON.stringify(columnValues) },
  );
  return data.create_item.id;
}

/**
 * Create a subitem under an existing item.
 *
 * No board id: a subitem belongs to its parent's own subitem board, which monday
 * creates on demand. The column ids in `columnValues` are therefore the SUBITEM
 * board's ids, not the parent board's — see FREIGHT_REQUEST_COL.
 *
 * `create_labels_if_missing` is on because these writes carry status labels that are
 * data, not configuration: a vendor new to the board must not fail the write because
 * nobody added their label to the column by hand first.
 */
export async function createSubitem(
  parentItemId: string,
  name: string,
  columnValues: Record<string, unknown>,
): Promise<string> {
  const data = await mondayQuery<{ create_subitem: { id: string } }>(
    `mutation ($parent: ID!, $name: String!, $cols: JSON!) {
       create_subitem (
         parent_item_id: $parent,
         item_name: $name,
         column_values: $cols,
         create_labels_if_missing: true
       ) { id }
     }`,
    { parent: parentItemId, name, cols: JSON.stringify(columnValues) },
  );
  return data.create_subitem.id;
}

/**
 * Set specific columns on an existing item without touching its name. `updateItem`
 * always rewrites the name, which is wrong when the item is a monday-owned deal row
 * and we only own two of its columns.
 */
export async function setColumnValues(
  boardId: string,
  itemId: string,
  columnValues: Record<string, unknown>,
): Promise<void> {
  await mondayQuery(
    `mutation ($board: ID!, $item: ID!, $cols: JSON!) {
       change_multiple_column_values (board_id: $board, item_id: $item, column_values: $cols) { id }
     }`,
    { board: boardId, item: itemId, cols: JSON.stringify(columnValues) },
  );
}

/**
 * Upload a file into a file column. This is the one monday call that is NOT plain
 * GraphQL-over-JSON: it goes to /v2/file as multipart, with the item and column
 * inlined in the query and the bytes in `variables[file]`. Retries on 429 with the
 * same backoff as `mondayQuery`.
 */
export async function uploadFileToColumn(
  itemId: string,
  columnId: string,
  filename: string,
  bytes: Buffer,
  contentType = 'application/pdf',
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!env.MONDAY_API_TOKEN) throw new Error('MONDAY_API_TOKEN not configured');
  const query = `mutation ($file: File!) {
       add_file_to_column (item_id: ${JSON.stringify(String(itemId))}, column_id: ${JSON.stringify(columnId)}, file: $file) { id }
     }`;

  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const form = new FormData();
    form.append('query', query);
    // A fresh Blob per attempt — a consumed body cannot be replayed on a retry.
    form.append(
      'variables[file]',
      new Blob([new Uint8Array(bytes)], { type: contentType }),
      filename,
    );

    const res = await fetchImpl(`${API_URL}/file`, {
      method: 'POST',
      headers: { Authorization: env.MONDAY_API_TOKEN, 'API-Version': '2024-01' },
      body: form,
    });

    if (res.status === 429) {
      const wait = backoff(attempt, Number(res.headers.get('retry-after') ?? '') || undefined);
      logger.warn({ attempt, wait }, 'monday file upload 429; backing off');
      await sleep(wait);
      lastErr = new Error('monday file upload HTTP 429');
      continue;
    }
    if (!res.ok) throw new Error(`monday file upload HTTP ${res.status}`);

    const body = (await res.json()) as GraphQLResponse<{ add_file_to_column: { id: string } }>;
    if (body.errors?.length) {
      throw new Error('monday file upload error: ' + body.errors.map((e) => e.message).join('; '));
    }
    const id = body.data?.add_file_to_column?.id;
    if (!id) throw new Error('monday file upload returned no asset id');
    return id;
  }
  throw lastErr ?? new Error('monday file upload: exhausted retries');
}

export async function updateItem(
  boardId: string,
  itemId: string,
  name: string,
  columnValues: Record<string, unknown>,
): Promise<void> {
  await mondayQuery(
    `mutation ($board: ID!, $item: ID!, $cols: JSON!) {
       change_multiple_column_values (board_id: $board, item_id: $item, column_values: $cols) { id }
     }`,
    { board: boardId, item: itemId, cols: JSON.stringify({ name, ...columnValues }) },
  );
}
