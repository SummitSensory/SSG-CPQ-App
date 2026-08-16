import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { env, isEntraConfigured } from '../config/env.js';
import { isRole } from '../authz/permissions.js';
import { createState, authorizeUrl, readState, completeLogin } from '../auth/entra.js';
import { parseRoleMap, pickRole } from '../auth/entraRoles.js';
import { hashPassword } from '../auth/password.js';
import { signAccessToken } from '../auth/tokens.js';
import { createSession } from '../auth/session.js';
import { inviteSender } from '../auth/invite.js';
import { logger } from '../lib/logger.js';

/** Escape a value for safe interpolation into an HTML attribute or body. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Hand the freshly minted tokens to the browser through the URL fragment.
 * A fragment is never sent to the server or written to server logs, and the
 * client clears it from history immediately on pickup.
 */
function handoffPage(returnTo: string, accessToken: string, refreshToken: string): string {
  const payload = JSON.stringify({ at: accessToken, rt: refreshToken, to: returnTo });
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Signing you in…</title></head>
<body style="font-family:system-ui;padding:40px;text-align:center;color:#82877d;">Signing you in…
<script>(function(){var d=${payload};try{localStorage.setItem('ssg_at',d.at);localStorage.setItem('ssg_rt',d.rt);}catch(e){}location.replace(d.to||'/');})();</script>
</body></html>`;
}

function errorPage(message: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sign-in failed</title></head>
<body style="font-family:system-ui;max-width:520px;margin:80px auto;padding:0 24px;color:#20241f;">
<h1 style="font-size:20px;">Sign-in failed</h1>
<p style="color:#82877d;line-height:1.6;">${esc(message)}</p>
<p><a href="/" style="color:#3d4a55;">Back to sign in</a></p>
</body></html>`;
}

export function registerSsoRoutes(app: FastifyInstance): void {
  // Lets the login screen decide whether to show the Microsoft button.
  app.get('/auth/sso/status', async () => ({ enabled: isEntraConfigured() }));

  app.get('/auth/sso/start', async (req, reply) => {
    if (!isEntraConfigured()) return reply.status(404).send({ message: 'SSO is not configured' });
    const returnTo =
      typeof (req.query as { returnTo?: string }).returnTo === 'string'
        ? (req.query as { returnTo: string }).returnTo
        : '/';
    // Only same-site paths, so the state cannot be used as an open redirect.
    const safeReturn = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
    const { state, nonce } = await createState(safeReturn);
    return reply.redirect(authorizeUrl(state, nonce));
  });

  app.get('/auth/sso/callback', async (req, reply) => {
    if (!isEntraConfigured()) return reply.status(404).send({ message: 'SSO is not configured' });
    const q = req.query as {
      code?: string;
      state?: string;
      error_description?: string;
      error?: string;
    };

    if (q.error) {
      return reply
        .type('text/html; charset=utf-8')
        .status(400)
        .send(errorPage(q.error_description ?? q.error));
    }
    if (!q.code || !q.state) {
      return reply
        .type('text/html; charset=utf-8')
        .status(400)
        .send(errorPage('The sign-in response was incomplete.'));
    }

    try {
      const pending = await readState(q.state);
      const identity = await completeLogin(q.code, pending.nonce);

      /**
       * What this person's Entra groups say their role should be, or null.
       *
       * Null covers three different situations that must all behave the same way —
       * no map configured, no groups claim, or groups that match nothing in the map.
       * In every one of them Azure has expressed no opinion, so an existing user's
       * role is left exactly as an admin set it. Only a positive match moves anyone.
       */
      const roleMap = parseRoleMap(env.ENTRA_ROLE_MAP);
      if (roleMap.problems.length) {
        logger.warn({ problems: roleMap.problems }, 'sso: ENTRA_ROLE_MAP has unreadable entries');
      }
      if (identity.groupsOverage) {
        logger.warn(
          { email: identity.email },
          'sso: groups claim overflowed the token — role mapping skipped for this sign-in',
        );
      }
      const mappedRole = identity.groupsOverage ? null : pickRole(identity.groups, roleMap);

      let user = await prisma.user.findUnique({ where: { email: identity.email } });

      if (!user) {
        // First sign-in: the mapped role if Azure named one, otherwise least
        // privilege. The password hash is random and never shared, so the account is
        // SSO-only until an admin (or the user, via Change password) sets a real one.
        const fallback = isRole(env.ENTRA_DEFAULT_ROLE) ? env.ENTRA_DEFAULT_ROLE : 'READ_ONLY';
        const role = mappedRole ?? fallback;
        user = await prisma.user.create({
          data: {
            email: identity.email,
            name: identity.name ?? identity.email,
            role,
            passwordHash: await hashPassword(randomBytes(32).toString('base64url')),
          },
        });
        logger.info({ email: user.email, role }, 'sso: auto-provisioned new user');
        await inviteSender
          .send({
            email: user.email,
            name: user.name ?? undefined,
            role,
            appUrl: new URL(env.ENTRA_REDIRECT_URI!).origin,
          })
          .catch((e) => logger.error({ err: e }, 'sso: invite delivery failed'));
      } else if (!user.isActive) {
        return reply
          .type('text/html; charset=utf-8')
          .status(403)
          .send(errorPage('That account has been deactivated. Contact an administrator.'));
      } else if (mappedRole && mappedRole !== user.role) {
        /**
         * A mapped group makes Azure the source of truth, in both directions: moving
         * somebody out of the Accounting group takes their QuickBooks access with it
         * on their next sign-in. Group membership is only a real control if losing it
         * does something.
         *
         * The one exception is the last administrator. Demoting them would leave a
         * deployment nobody can administer — including nobody who can fix the group
         * mapping that caused it — so that demotion is refused and logged loudly. Any
         * other admin, and the demotion proceeds normally.
         */
        let apply = true;
        if (user.role === 'SYSTEM_ADMIN') {
          const otherAdmins = await prisma.user.count({
            where: { role: 'SYSTEM_ADMIN', isActive: true, id: { not: user.id } },
          });
          if (otherAdmins === 0) {
            apply = false;
            logger.warn(
              { email: user.email, wouldBecome: mappedRole },
              'sso: refused to demote the last active system admin from a group mapping',
            );
          }
        }
        if (apply) {
          const previous = user.role;
          user = await prisma.user.update({
            where: { id: user.id },
            data: { role: mappedRole },
          });
          logger.info(
            { email: user.email, from: previous, to: mappedRole },
            'sso: role updated from Entra group membership',
          );
        }
      }

      const accessToken = await signAccessToken({ sub: user.id, role: user.role });
      const refreshToken = await createSession(user.id, {
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      });
      return (
        reply
          .type('text/html; charset=utf-8')
          // This one page carries an inline bootstrap script; the app-wide CSP
          // (script-src 'self') would block it.
          .header('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'")
          .send(handoffPage(pending.returnTo, accessToken, refreshToken))
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong.';
      logger.warn({ err }, 'sso: sign-in failed');
      return reply.type('text/html; charset=utf-8').status(401).send(errorPage(message));
    }
  });
}
