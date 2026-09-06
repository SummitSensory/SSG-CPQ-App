import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

/**
 * IP → "City, Country" for the Certificate of Signature's per-signer Location
 * line. A distinct, optional capability from DocuSeal itself: DocuSeal reports
 * each signer's raw IP address, never a resolved place name, so this is the one
 * piece of the certificate that talks to a service DocuSeal doesn't front for us.
 *
 * Best-effort throughout, matching how fx.ts treats an external rate lookup: a
 * signed proposal must never fail to store because a geolocation lookup timed
 * out or the account ran out of quota. Every failure mode here returns null,
 * and the certificate simply omits the Location line rather than showing one.
 */

const REQUEST_TIMEOUT_MS = 3_000;

/** Private/loopback/link-local ranges — always local test traffic, never worth
 *  spending a lookup on, and ipinfo.io would just report them as "bogon" anyway. */
function isPrivateOrLocalIp(ip: string): boolean {
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  if (/^(fe80|fc00|fd00):/i.test(ip)) return true;
  return false;
}

function countryNameFor(code: string): string | null {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) ?? null;
  } catch {
    return null;
  }
}

interface IpinfoResponse {
  city?: string;
  country?: string;
  bogon?: boolean;
}

/** Resolves an IP to "City, Country", or null if unavailable, unconfigured, or
 *  the address is private/local. `fetchImpl` is injectable for tests, same as
 *  fetchCompletedPdf in docuseal/client.ts. */
export async function resolveIpLocation(
  ip: string | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!ip || !env.IPINFO_TOKEN) return null;
  if (isPrivateOrLocalIp(ip)) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(
      `https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${env.IPINFO_TOKEN}`,
      { signal: controller.signal },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as IpinfoResponse;
    if (data.bogon || !data.city || !data.country) return null;
    return `${data.city}, ${countryNameFor(data.country) ?? data.country}`;
  } catch (err) {
    logger.warn({ err, ip }, 'geolocation: ip lookup failed');
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
