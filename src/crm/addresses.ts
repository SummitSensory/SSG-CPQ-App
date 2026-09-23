/**
 * Which of a customer's addresses is "the" shipping address.
 *
 * Several readers took the first SHIPPING row in whatever order the database
 * returned it. Once the delivery portal began adding its own SHIPPING addresses
 * (`source = 'PORTAL'`, one per order), that became a coin toss between the address
 * typed or imported into the CRM and a per-order delivery site — and QuickBooks'
 * bill-to fallback could land on the delivery site, which is never the bill-to.
 *
 * So: an address typed or imported into the CRM always wins. A portal address is
 * used only when the customer has no other shipping address, and only where the
 * caller allows it; QuickBooks never takes one.
 */
interface AddressLike {
  type: string;
  source?: string | null;
}

export function primaryShippingAddress<T extends AddressLike>(
  addresses: T[] | null | undefined,
  opts: { allowPortal?: boolean } = {},
): T | null {
  const shipping = (addresses ?? []).filter((a) => a.type === 'SHIPPING');
  const own = shipping.find((a) => a.source !== 'PORTAL');
  if (own) return own;
  return opts.allowPortal === false ? null : (shipping[0] ?? null);
}
