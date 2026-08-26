import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { env, isOutlookConfigured } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { UnauthorizedError, ValidationError } from '../../lib/errors.js';

/**
 * Microsoft Graph — write a message into the rep's own mailbox, as a draft they
 * finish, or sent outright from their own address.
 *
 * Why this exists. The .eml route works, but it downloads a file the rep then has
 * to find and open, and every rep has to tick "always open files of this type"
 * once per machine before that stops being two clicks. Graph removes the file: the
 * message is written straight into the mailbox and the reply comes back with a
 * link that opens it. The draft is in Drafts on every device the moment it is
 * created, so a rep who starts one at a desk finishes it on a phone.
 *
 * Delegated, never application. `Mail.ReadWrite` and `Mail.Send` as DELEGATED
 * scopes let the app write to and send from the mailbox of the person who
 * consented and no one else's. The application-level equivalent would grant the
 * app every mailbox in the tenant, which is a far larger thing to hold than this
 * feature needs — a rep sending their own email. It also means the message
 * genuinely comes from that person: the From address, the Sent Items copy and the
 * reply path are all theirs, because Microsoft is sending it as them. Nothing here
 * spoofs a From header, which is the only way a "from my account" email survives
 * SPF and DKIM at the recipient.
 *
 * Tokens are encrypted at rest with the same AES-256-GCM shape QuickBooks uses. A
 * refresh token for a mailbox is a durable credential; it does not sit in the
 * database in the clear.
 *
 * This deliberately reuses the SSO app registration's client id and secret — one
 * app, one secret to rotate, one consent screen the tenant admin already knows.
 * Only the redirect URI is its own, because the callback lands somewhere different.
 */

const AUTH_HOST = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * `Mail.Send` was added when payment requests were built. A mailbox connected
 * before that holds a token WITHOUT it, and Microsoft does not widen an existing
 * grant on refresh — the refresh returns the scopes originally consented to. So
 * the stored scope string is checked before a send is attempted and the rep is
 * told to connect again, which is a complete repair (completeConsent upserts).
 * Attempting the send instead produces a bare 403 from Graph, which reads like a
 * broken feature rather than a one-time reconnect.
 */
const SCOPES = 'offline_access Mail.ReadWrite Mail.Send';
export const SEND_SCOPE = 'Mail.Send';

/** Refresh this far ahead of expiry, so a slow request cannot outlive its token. */
const REFRESH_SKEW_MS = 120_000;
const STATE_TTL = 600;

/** Graph's inline-attachment ceiling. Anything larger needs an upload session. */
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
/** Total across a message. Well inside what any recipient's gateway accepts. */
const MAX_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;

function tenant(): string {
  if (!env.ENTRA_TENANT_ID) throw new ValidationError('Microsoft sign-in is not configured.');
  return env.ENTRA_TENANT_ID;
}

function clientId(): string {
  return env.GRAPH_CLIENT_ID ?? env.ENTRA_CLIENT_ID!;
}

function clientSecret(): string {
  return env.GRAPH_CLIENT_SECRET ?? env.ENTRA_CLIENT_SECRET!;
}

/* -------------------------------------------------------------- token encryption */

function encKey(): Buffer {
  if (!env.GRAPH_TOKEN_ENC_KEY) throw new Error('GRAPH_TOKEN_ENC_KEY not configured');
  return createHash('sha256').update(env.GRAPH_TOKEN_ENC_KEY).digest();
}

function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, enc, cipher.getAuthTag()]).toString('base64');
}

function decrypt(encoded: string): string {
  const buf = Buffer.from(encoded, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const enc = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', encKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/* ------------------------------------------------------------------ consent flow */

const stateKey = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

/**
 * The `state` is a short-lived signed JWT carrying the user id, so the callback
 * knows whose mailbox consented without a server-side pending-request table. Same
 * reasoning as the SSO flow: on a serverless host there is no memory between the
 * two requests.
 */
export async function createConsentState(userId: string, returnTo = '/'): Promise<string> {
  return new SignJWT({ uid: userId, returnTo })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + STATE_TTL)
    .sign(stateKey);
}

export async function readConsentState(state: string): Promise<{ uid: string; returnTo: string }> {
  try {
    const { payload } = await jwtVerify(state, stateKey);
    return { uid: String(payload.uid), returnTo: String(payload.returnTo ?? '/') };
  } catch {
    throw new UnauthorizedError('That connect link expired. Start again from Administration.');
  }
}

export function consentUrl(state: string, loginHint?: string | null): string {
  const u = new URL(`${AUTH_HOST}/${tenant()}/oauth2/v2.0/authorize`);
  u.searchParams.set('client_id', clientId());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', env.GRAPH_REDIRECT_URI!);
  u.searchParams.set('response_mode', 'query');
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('state', state);
  // Skips the account chooser when we already know which mailbox this is, and stops a
  // rep connecting their personal account to their work login by accident.
  if (loginHint) u.searchParams.set('login_hint', loginHint);
  return u.toString();
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${AUTH_HOST}/${tenant()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = (await res.json()) as TokenResponse;
  if (!res.ok || !data.access_token) {
    throw new UnauthorizedError(
      data.error_description ?? 'Microsoft would not issue a token for that mailbox.',
    );
  }
  return data;
}

/** Which mailbox this token belongs to, asked of Graph rather than assumed. */
async function whoAmI(accessToken: string): Promise<{ mailbox: string; displayName?: string }> {
  const res = await fetch(`${GRAPH}/me?$select=mail,userPrincipalName,displayName`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok)
    throw new UnauthorizedError(
      'Microsoft accepted the sign-in but would not identify the mailbox.',
    );
  const me = (await res.json()) as {
    mail?: string;
    userPrincipalName?: string;
    displayName?: string;
  };
  const mailbox = (me.mail ?? me.userPrincipalName ?? '').trim().toLowerCase();
  if (!mailbox) throw new ValidationError('That Microsoft account has no mailbox attached.');
  return { mailbox, displayName: me.displayName };
}

/**
 * Finish the consent flow and store the connection.
 *
 * Upsert on userId: reconnecting replaces the tokens rather than accumulating rows, and
 * clears any previous revocation, so "connect again" is a complete repair for a mailbox
 * whose refresh token expired — and for one connected before Mail.Send was requested.
 */
export async function completeConsent(code: string, userId: string): Promise<{ mailbox: string }> {
  const tok = await tokenRequest({
    client_id: clientId(),
    client_secret: clientSecret(),
    grant_type: 'authorization_code',
    code,
    redirect_uri: env.GRAPH_REDIRECT_URI!,
    scope: SCOPES,
  });
  const { mailbox } = await whoAmI(tok.access_token!);
  if (!tok.refresh_token) {
    throw new ValidationError(
      'Microsoft did not return a refresh token. Check that offline_access is on the app registration.',
    );
  }
  const expiresAt = new Date(Date.now() + (tok.expires_in ?? 3600) * 1000);
  await prisma.outlookConnection.upsert({
    where: { userId },
    create: {
      userId,
      mailbox,
      accessToken: encrypt(tok.access_token!),
      refreshToken: encrypt(tok.refresh_token),
      expiresAt,
      scope: tok.scope ?? SCOPES,
    },
    update: {
      mailbox,
      accessToken: encrypt(tok.access_token!),
      refreshToken: encrypt(tok.refresh_token),
      expiresAt,
      scope: tok.scope ?? SCOPES,
      revokedAt: null,
      lastError: null,
    },
  });
  logger.info({ userId, mailbox }, 'outlook: mailbox connected');
  return { mailbox };
}

/* ------------------------------------------------------------------ access tokens */

export class OutlookNotConnectedError extends Error {
  constructor(message = 'Your Outlook mailbox is not connected.') {
    super(message);
    this.name = 'OutlookNotConnectedError';
  }
}

/** Raised when the mailbox is connected but was never granted the send scope. */
export class OutlookSendNotGrantedError extends Error {
  constructor(
    message = 'Your Outlook mailbox was connected before this app could send on your behalf. Connect Outlook again — it takes one click and keeps everything else as it is.',
  ) {
    super(message);
    this.name = 'OutlookSendNotGrantedError';
  }
}

/**
 * A usable access token for this user, refreshing when it is close to expiry.
 *
 * A refresh failure marks the connection revoked and records why. The alternative —
 * retrying a dead grant on every send — turns one expired token into a rep who is told
 * "try again" forever with nothing telling them to reconnect.
 */
async function accessTokenFor(userId: string): Promise<string> {
  const conn = await prisma.outlookConnection.findUnique({ where: { userId } });
  if (!conn || conn.revokedAt) throw new OutlookNotConnectedError();

  if (conn.expiresAt.getTime() - Date.now() > REFRESH_SKEW_MS) {
    return decrypt(conn.accessToken);
  }

  try {
    const tok = await tokenRequest({
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: 'refresh_token',
      refresh_token: decrypt(conn.refreshToken),
      scope: SCOPES,
    });
    await prisma.outlookConnection.update({
      where: { userId },
      data: {
        accessToken: encrypt(tok.access_token!),
        // Microsoft rotates the refresh token on most grants but not all; keep the old
        // one when none comes back rather than storing an empty string.
        ...(tok.refresh_token ? { refreshToken: encrypt(tok.refresh_token) } : {}),
        expiresAt: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000),
        // The scope Microsoft actually issued, which is how a mailbox connected
        // before Mail.Send existed is recognised as still lacking it.
        ...(tok.scope ? { scope: tok.scope } : {}),
        lastError: null,
      },
    });
    return tok.access_token!;
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'refresh failed';
    await prisma.outlookConnection.update({
      where: { userId },
      data: { revokedAt: new Date(), lastError: reason.slice(0, 400) },
    });
    logger.warn({ userId, reason }, 'outlook: refresh failed, connection marked revoked');
    throw new OutlookNotConnectedError(
      'Microsoft would not renew access to your mailbox. Connect Outlook again.',
    );
  }
}

/** Whether this user can have a draft written for them right now. */
export async function outlookStatusFor(userId: string): Promise<{
  configured: boolean;
  connected: boolean;
  canSend: boolean;
  mailbox: string | null;
  lastError: string | null;
}> {
  if (!isOutlookConfigured()) {
    return { configured: false, connected: false, canSend: false, mailbox: null, lastError: null };
  }
  const conn = await prisma.outlookConnection.findUnique({ where: { userId } });
  const connected = Boolean(conn && !conn.revokedAt);
  return {
    configured: true,
    connected,
    // Case-insensitive: Microsoft returns the scope string in whatever case the
    // request used, and it has changed casing between API versions before.
    canSend: connected && (conn?.scope ?? '').toLowerCase().includes(SEND_SCOPE.toLowerCase()),
    mailbox: conn?.mailbox ?? null,
    lastError: conn?.revokedAt ? (conn.lastError ?? 'The connection was revoked.') : null,
  };
}

export async function disconnectOutlook(userId: string): Promise<void> {
  await prisma.outlookConnection.deleteMany({ where: { userId } });
  logger.info({ userId }, 'outlook: mailbox disconnected');
}

/* ----------------------------------------------------------------------- sending */

export interface MailAttachment {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

export interface DraftResult {
  id: string;
  /** Opens the draft in Outlook on the web, already in the compose view. */
  webLink: string;
  mailbox: string;
}

export interface SentResult {
  /** Graph's id for the message. Findable in Sent Items. */
  id: string;
  mailbox: string;
}

/** The rep's stored signature, appended after the body. */
async function withSignature(userId: string, html: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { emailSignatureHtml: true },
  });
  const signature = (user?.emailSignatureHtml ?? '').trim();
  return signature ? `${html}<div style="margin-top:18pt;">${signature}</div>` : html;
}

function assertAttachmentsFit(attachments: MailAttachment[]): void {
  let total = 0;
  for (const a of attachments) {
    total += a.bytes.length;
    if (a.bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new ValidationError(
        `"${a.filename}" is ${(a.bytes.length / 1024 / 1024).toFixed(1)} MB. Outlook accepts attachments up to 3 MB through this route — send it from Outlook directly, or reduce the file.`,
      );
    }
  }
  if (total > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw new ValidationError(
      `The attachments come to ${(total / 1024 / 1024).toFixed(1)} MB, over the 20 MB this send allows. Leave one off, or send it from Outlook directly.`,
    );
  }
}

/** Recipient list in Graph's shape. Empty in, empty out. */
function recipients(list: Array<{ email: string; name?: string | null }>): unknown[] {
  return list
    .filter((r) => String(r.email ?? '').trim())
    .map((r) => ({
      emailAddress: { address: r.email.trim(), ...(r.name ? { name: r.name } : {}) },
    }));
}

async function graphFetch(
  token: string,
  path: string,
  init: { method: 'POST' | 'GET'; body?: unknown },
): Promise<Response> {
  return fetch(`${GRAPH}${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}

/** Turn a Graph failure into something a person can act on. */
async function graphFailure(res: Response, what: string): Promise<never> {
  const detail = await res.text().catch(() => '');
  logger.error(
    { status: res.status, detail: detail.slice(0, 500), what },
    'outlook: graph call failed',
  );
  if (res.status === 401) {
    throw new OutlookNotConnectedError(
      'Microsoft refused access to your mailbox. Connect Outlook again.',
    );
  }
  if (res.status === 403) {
    throw new OutlookSendNotGrantedError();
  }
  throw new ValidationError(`Outlook would not ${what} (HTTP ${res.status}).`);
}

/**
 * Create the message as a draft in the mailbox.
 *
 * Shared by the draft route and the send route: sending is "create it, hang the
 * attachments on it, then tell Microsoft to send it". Doing it in that order
 * rather than through /me/sendMail is deliberate — sendMail takes the whole
 * message in one request body, which caps the total at about 4 MB including
 * base64 overhead, and gives back no message id to record.
 */
async function createDraft(
  token: string,
  input: {
    to: Array<{ email: string; name?: string | null }>;
    cc?: Array<{ email: string; name?: string | null }>;
    subject: string;
    html: string;
  },
): Promise<{ id: string; webLink: string }> {
  const res = await graphFetch(token, '/me/messages', {
    method: 'POST',
    body: {
      subject: input.subject,
      body: { contentType: 'HTML', content: `<html><body>${input.html}</body></html>` },
      toRecipients: recipients(input.to),
      ...(input.cc?.length ? { ccRecipients: recipients(input.cc) } : {}),
    },
  });
  if (!res.ok) await graphFailure(res, 'create the message');
  const msg = (await res.json()) as { id?: string; webLink?: string };
  if (!msg.id)
    throw new ValidationError('Outlook created the message but did not say where it is.');
  return { id: msg.id, webLink: msg.webLink ?? '' };
}

async function attach(token: string, messageId: string, a: MailAttachment): Promise<void> {
  const res = await graphFetch(token, `/me/messages/${encodeURIComponent(messageId)}/attachments`, {
    method: 'POST',
    body: {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.filename,
      contentType: a.contentType,
      contentBytes: a.bytes.toString('base64'),
    },
  });
  if (!res.ok) await graphFailure(res, `attach "${a.filename}"`);
}

async function markUsed(userId: string): Promise<void> {
  await prisma.outlookConnection
    .update({ where: { userId }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);
}

/**
 * Write the message into the mailbox as a draft. Nothing is sent.
 *
 * `isDraft` is implicit: a POST to /me/messages creates an unsent message, which
 * is what Drafts is. The rep still reads it, edits it and presses Send, which is
 * the point of a follow-up they are supposed to have judged.
 *
 * A note on signatures. Outlook signatures live in the client, not in the mailbox,
 * and Graph cannot read them — so a Graph-created draft would arrive with no
 * signature and OWA will not insert one into a message that already exists. That
 * is why the signature is appended here from the copy stored on the user. It goes
 * last, after the body, which is the placement the .eml route had to fight Outlook
 * for.
 */
export async function createOutlookDraft(input: {
  userId: string;
  to: { email: string; name?: string | null };
  cc?: Array<{ email: string; name?: string | null }>;
  subject: string;
  html: string;
  attachments?: MailAttachment[];
}): Promise<DraftResult> {
  const attachments = input.attachments ?? [];
  assertAttachmentsFit(attachments);

  const token = await accessTokenFor(input.userId);
  const conn = await prisma.outlookConnection.findUnique({
    where: { userId: input.userId },
    select: { mailbox: true },
  });

  const draft = await createDraft(token, {
    to: [input.to],
    cc: input.cc,
    subject: input.subject,
    html: await withSignature(input.userId, input.html),
  });
  for (const a of attachments) await attach(token, draft.id, a);
  if (!draft.webLink) {
    throw new ValidationError('Outlook created the draft but did not return a link to it.');
  }
  await markUsed(input.userId);
  return { id: draft.id, webLink: draft.webLink, mailbox: conn?.mailbox ?? '' };
}

/**
 * Send the message from the rep's own mailbox, now.
 *
 * The From address is theirs because Microsoft is the one sending it — there is no
 * header being set here. That is what makes it pass SPF and DKIM at the
 * recipient's gateway, land in the customer's existing thread with that person,
 * and appear in the sender's own Sent Items where they can see what went out.
 *
 * The send is confirmed before anything is recorded as sent: Graph answers a
 * successful /send with 202 and an empty body, and treating any other answer as
 * success is how a log comes to claim a customer was chased when they were not.
 */
export async function sendOutlookMail(input: {
  userId: string;
  to: Array<{ email: string; name?: string | null }>;
  cc?: Array<{ email: string; name?: string | null }>;
  subject: string;
  html: string;
  attachments?: MailAttachment[];
}): Promise<SentResult> {
  if (!input.to.length) throw new ValidationError('Give at least one recipient.');
  const attachments = input.attachments ?? [];
  assertAttachmentsFit(attachments);

  const conn = await prisma.outlookConnection.findUnique({ where: { userId: input.userId } });
  if (!conn || conn.revokedAt) throw new OutlookNotConnectedError();
  if (!(conn.scope ?? '').toLowerCase().includes(SEND_SCOPE.toLowerCase())) {
    throw new OutlookSendNotGrantedError();
  }

  const token = await accessTokenFor(input.userId);
  const draft = await createDraft(token, {
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    html: await withSignature(input.userId, input.html),
  });

  try {
    for (const a of attachments) await attach(token, draft.id, a);
    const res = await graphFetch(token, `/me/messages/${encodeURIComponent(draft.id)}/send`, {
      method: 'POST',
    });
    if (!res.ok) await graphFailure(res, 'send the message');
  } catch (err) {
    // The half-built draft is left in Drafts on purpose. It carries the body and
    // whatever attached before the failure, so the rep can finish it by hand
    // instead of retyping — and a stray draft is a far smaller harm than a
    // deleted one that was actually sent.
    logger.warn(
      { err, messageId: draft.id, userId: input.userId },
      'outlook: send failed; draft left in the mailbox',
    );
    throw err;
  }

  await markUsed(input.userId);
  logger.info(
    { userId: input.userId, mailbox: conn.mailbox, to: input.to.map((t) => t.email) },
    'outlook: message sent',
  );
  return { id: draft.id, mailbox: conn.mailbox };
}
