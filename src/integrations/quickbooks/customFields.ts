import { query } from './client.js';
import { logger } from './../../lib/logger.js';

/**
 * Resolve a QuickBooks sales-form custom field to the DefinitionId the API
 * wants.
 *
 * Custom fields are POSITIONAL in the API. A document carries them as
 * `CustomField: [{ DefinitionId: '2', Name: 'Project ID', StringValue: '…' }]`,
 * and QuickBooks matches on the DefinitionId — the slot number — not on the
 * name. Send the wrong slot and the value lands in whatever field occupies it,
 * which on this company would print the Project ID into "Customer Purchase
 * Order #".
 *
 * The slot is not guessable: it depends on the order the fields were created in
 * years ago. It IS readable, though. Company Preferences expose the sales-form
 * custom fields as name/value pairs:
 *
 *   SalesFormsPrefs.UseSalesCustom1  = "true"
 *   SalesFormsPrefs.SalesCustomName1 = "Customer Purchase Order #"
 *   SalesFormsPrefs.UseSalesCustom2  = "true"
 *   SalesFormsPrefs.SalesCustomName2 = "Project ID"
 *
 * so the slot is looked up by name once and cached for the life of the process.
 * An env var still overrides it, for a company whose preferences cannot be read
 * or where the field is named something else.
 */

interface PrefsRow {
  SalesFormsPrefs?: {
    CustomField?: Array<{ CustomField?: Array<{ Name?: string; Value?: string }> }>;
  };
}

/** realmId -> (lower-cased field name -> DefinitionId). */
const cache = new Map<string, Map<string, string>>();

async function loadSlots(
  realmId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, string>> {
  const hit = cache.get(realmId);
  if (hit) return hit;

  const slots = new Map<string, string>();
  try {
    const res = await query<{ Preferences?: PrefsRow[] }>(
      realmId,
      'select * from Preferences',
      fetchImpl,
    );
    const groups = res.Preferences?.[0]?.SalesFormsPrefs?.CustomField ?? [];
    for (const group of groups) {
      const pairs = group.CustomField ?? [];
      // Within a group the enabled flag and the name arrive as separate pairs,
      // so the slot number is read off the key rather than the array position.
      const enabled = new Map<string, boolean>();
      const names = new Map<string, string>();
      for (const p of pairs) {
        const key = String(p.Name ?? '');
        const useMatch = /UseSalesCustom(\d+)$/.exec(key);
        if (useMatch) enabled.set(useMatch[1] as string, String(p.Value) === 'true');
        const nameMatch = /SalesCustomName(\d+)$/.exec(key);
        if (nameMatch) names.set(nameMatch[1] as string, String(p.Value ?? '').trim());
      }
      for (const [slot, name] of names) {
        if (name && enabled.get(slot) !== false) slots.set(name.toLowerCase(), slot);
      }
    }
  } catch (err) {
    // A preferences read failure must never stop a document being created. The
    // field is simply omitted, and the env override remains available.
    logger.warn({ err, realmId }, 'QuickBooks custom field preferences could not be read');
  }

  cache.set(realmId, slots);
  return slots;
}

/**
 * DefinitionId for a named sales-form custom field, or null when the company
 * does not have one. `envOverride` wins when set.
 */
export async function customFieldId(
  realmId: string,
  fieldName: string,
  envOverride?: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const forced = String(envOverride ?? '').trim();
  if (forced) return forced;
  const slots = await loadSlots(realmId, fetchImpl);
  return slots.get(fieldName.trim().toLowerCase()) ?? null;
}

/** Testing / reconnect hook — drops the cached slot map for a company. */
export function clearCustomFieldCache(realmId?: string): void {
  if (realmId) cache.delete(realmId);
  else cache.clear();
}
