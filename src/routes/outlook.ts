import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { env, isOutlookConfigured } from '../config/env.js';
import { ValidationError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import {
  completeConsent,
  consentUrl,
  createConsentState,
  disconnectOutlook,
  outlookStatusFor,
  readConsentState,
} from '../integrations/microsoft/graph.js';

/**
 * Connecting a rep's Outlook mailbox, and their email signature.
 *
 * Per USER, not per organization. A draft is written into one person's mailbox with their
 * own delegated consent, so there is no shared credential here and no way for one rep's
 * connection to write into another's mail. An admin cannot connect on someone's behalf,
 * which is the correct answer to "can you set mine up for me": no, and that is the point.
 *
 * The callback is a browser redirect from Microsoft, so it cannot carry the app's bearer
 * token — it authenticates on the signed `state` instead, which names the user who
 * started the flow and expires in ten minutes.
 */

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * A plain page for the callback, which lands in a browser tab rather than the app.
 *
 * No inline script: the app sends a strict Content-Security-Policy with `script-src
 * 'self'`, so anything inline here would be blocked and log an error in the one place a
 * rep is most likely to be reading the screen carefully.
 */
function resultPage(title: string, detail: string, ok: boolean): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body style="font-family:system-ui,'Segoe UI',sans-serif;max-width:520px;margin:80px auto;padding:0 24px;color:#20241f;">
<h1 style="font-size:20px;font-weight:600;">${esc(title)}</h1>
<p style="color:#82877d;line-height:1.6;">${esc(detail)}</p>
${ok ? '<p style="color:#82877d;line-height:1.6;">You can close this tab.</p>' : ''}
<p><a href="/" style="color:#3d4a55;">Back to the CRM</a></p>
</body></html>`;
}

const SignatureInput = z.object({
  /**
   * The signature as HTML. Capped generously: a real Outlook signature pasted from the
   * clipboard carries a logo as a data URI and runs to a few thousand characters.
   */
  html: z.string().max(120_000),
});

export function registerOutlookRoutes(app: FastifyInstance): void {
  const read = { preHandler: requirePermission(Permission.CRM_READ) };

  /** Whether this deployment can do Graph drafts, and whether THIS user is connected. */
  app.get('/me/outlook', read, async (req) => {
    const status = await outlookStatusFor(req.user!.sub);
    const user = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: { emailSignatureHtml: true },
    });
    return {
      ...status,
      hasSignature: Boolean((user?.emailSignatureHtml ?? '').trim()),
      signatureHtml: user?.emailSignatureHtml ?? '',
    };
  });

  /**
   * Start the consent flow.
   *
   * Returns the URL rather than redirecting, because the caller is a fetch from the app
   * with a bearer token — a 302 would be followed by the fetch, not by the browser, and
   * the rep would never see the Microsoft page.
   */
  app.post('/me/outlook/connect', read, async (req) => {
    if (!isOutlookConfigured()) {
      throw new ValidationError(
        'Outlook drafts are not configured on this deployment. An administrator needs to add the Graph settings.',
      );
    }
    const me = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: { email: true },
    });
    const state = await createConsentState(req.user!.sub, '/');
    return { url: consentUrl(state, me?.email ?? null) };
  });

  /** Where Microsoft sends the browser back. Authenticated by the signed state only. */
  app.get('/me/outlook/callback', async (req, reply) => {
    const q = req.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };
    reply.header('Content-Type', 'text/html; charset=utf-8');

    if (q.error) {
      return reply
        .status(400)
        .send(resultPage('Outlook was not connected', q.error_description ?? q.error, false));
    }
    if (!q.code || !q.state) {
      return reply
        .status(400)
        .send(
          resultPage('Outlook was not connected', 'Microsoft sent an incomplete response.', false),
        );
    }

    try {
      const { uid } = await readConsentState(q.state);
      const { mailbox } = await completeConsent(q.code, uid);
      await recordAudit({
        actorId: uid,
        action: 'outlook.connected',
        entity: 'User',
        entityId: uid,
        details: { mailbox },
      });
      return reply.send(
        resultPage(
          'Outlook connected',
          `Follow-up emails will now open as drafts in ${mailbox}.`,
          true,
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong.';
      logger.warn({ err }, 'outlook: consent callback failed');
      return reply.status(400).send(resultPage('Outlook was not connected', message, false));
    }
  });

  app.delete('/me/outlook', read, async (req, reply) => {
    await disconnectOutlook(req.user!.sub);
    await recordAudit({
      actorId: req.user!.sub,
      action: 'outlook.disconnected',
      entity: 'User',
      entityId: req.user!.sub,
      details: {},
    });
    return reply.status(204).send();
  });

  /**
   * The rep's email signature, stored because Graph cannot read the one in Outlook.
   *
   * Sanitized to the tags a signature legitimately needs. This is HTML a user pastes,
   * and it ends up in an email sent to a customer under the company's name — a <script>
   * surviving the round trip would be a stored-XSS hole in the CRM as well as an
   * embarrassment in a customer's inbox.
   */
  app.put('/me/outlook/signature', read, async (req) => {
    const parsed = SignatureInput.safeParse(req.body);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid signature');

    const clean = sanitizeSignature(parsed.data.html);
    await prisma.user.update({
      where: { id: req.user!.sub },
      data: { emailSignatureHtml: clean || null },
    });
    return { ok: true, hasSignature: Boolean(clean), signatureHtml: clean };
  });

  // Exposed so an admin can see what the deployment is missing without reading logs.
  app.get(
    '/admin/outlook/config',
    { preHandler: requirePermission(Permission.RULES_MANAGE) },
    async () => ({
      configured: isOutlookConfigured(),
      redirectUri: env.GRAPH_REDIRECT_URI ?? null,
      usesSsoAppRegistration: !env.GRAPH_CLIENT_ID,
      missing: [
        !env.ENTRA_TENANT_ID ? 'ENTRA_TENANT_ID' : null,
        !(env.GRAPH_CLIENT_ID ?? env.ENTRA_CLIENT_ID) ? 'ENTRA_CLIENT_ID' : null,
        !(env.GRAPH_CLIENT_SECRET ?? env.ENTRA_CLIENT_SECRET) ? 'ENTRA_CLIENT_SECRET' : null,
        !env.GRAPH_REDIRECT_URI ? 'GRAPH_REDIRECT_URI' : null,
        !env.GRAPH_TOKEN_ENC_KEY ? 'GRAPH_TOKEN_ENC_KEY' : null,
      ].filter(Boolean),
    }),
  );
}

/**
 * Strip a pasted signature down to presentational HTML.
 *
 * Allow-list, not deny-list: anything not named here is removed, so a tag nobody thought
 * of is safe by default rather than dangerous by default. Inline styles survive because a
 * signature is nothing but inline styles; `style` blocks, scripts, iframes, event
 * handlers and non-http(s)/data URLs do not.
 */
export function sanitizeSignature(input: string): string {
  let html = String(input ?? '');

  // Whole elements whose CONTENT must go too, not just their tags.
  html = html.replace(/<(script|style|iframe|object|embed|link|meta)\b[\s\S]*?<\/\1\s*>/gi, '');
  html = html.replace(/<(script|style|iframe|object|embed|link|meta)\b[^>]*\/?>/gi, '');
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  const allowed = new Set([
    'a',
    'b',
    'br',
    'div',
    'em',
    'i',
    'img',
    'p',
    'small',
    'span',
    'strong',
    'sub',
    'sup',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'u',
    'ul',
    'ol',
    'li',
    'hr',
    'font',
  ]);

  html = html.replace(
    /<\/?([a-z0-9-]+)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi,
    (tag, rawName, rawAttrs) => {
      const name = String(rawName).toLowerCase();
      if (!allowed.has(name)) return '';
      if (tag.startsWith('</')) return `</${name}>`;

      const attrs: string[] = [];
      const attrRe = /([a-z0-9:_-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/gi;
      let m: RegExpExecArray | null;
      while ((m = attrRe.exec(String(rawAttrs))) !== null) {
        const key = m[1]!.toLowerCase();
        const value = m[2]!.replace(/^["']|["']$/g, '');
        // No event handlers, ever, and nothing that can execute through a URL.
        if (key.startsWith('on')) continue;
        if (key === 'srcdoc' || key === 'formaction') continue;
        if (
          (key === 'href' || key === 'src') &&
          !/^(https?:|mailto:|tel:|cid:|data:image\/)/i.test(value)
        )
          continue;
        if (
          !/^(href|src|alt|title|width|height|style|align|valign|border|cellpadding|cellspacing|colspan|rowspan|color|size|face|target|class)$/.test(
            key,
          )
        )
          continue;
        if (
          key === 'style' &&
          /(expression|javascript:|url\s*\(\s*['"]?\s*javascript)/i.test(value)
        )
          continue;
        attrs.push(`${key}="${value.replace(/"/g, '&quot;')}"`);
      }
      const selfClosing = name === 'br' || name === 'img' || name === 'hr';
      return `<${name}${attrs.length ? ` ${attrs.join(' ')}` : ''}${selfClosing ? ' /' : ''}>`;
    },
  );

  return html.trim();
}
