import {
  applyRate, sum, formatMinor, type RoundingPolicy, DEFAULT_ROUNDING,
} from './decimal.js';

export const PRICING_ENGINE_VERSION = '1.0.0';

/** A monetary input that may be genuinely unknown. null NEVER means zero. */
export type MoneyOrMissing = bigint | null;

export interface PricingLineInput {
  ref: string;
  productId: string;
  kind?: string;
  quantity: number;
  unitPrice: MoneyOrMissing;
  unitCost: MoneyOrMissing;
  priceSource: string; // 'customer' | 'promotional' | 'price-list' | 'bundle' | ...
  lineDiscountBps?: number; // quantity adjustment / line discount
}

export interface FeeInput {
  amount: MoneyOrMissing;
  confirmed: boolean;
  taxable?: boolean;
}

export interface PricingInput {
  currency: string;
  lines: PricingLineInput[];
  orderDiscounts?: Array<{ amount?: bigint; bps?: number; reason: string; authorizedById?: string; authorizedRole?: string }>;
  fees?: {
    freight?: FeeInput;
    installation?: FeeInput;
    travel?: FeeInput;
    perDiem?: FeeInput;
    mileage?: { miles: number; ratePerMile: MoneyOrMissing; confirmed: boolean; taxable?: boolean };
    other?: Array<{ label: string; amount: MoneyOrMissing; confirmed?: boolean; taxable?: boolean }>;
    creditCardBps?: number;
  };
  tax?: { rateBps: number; exempt: boolean; exemptionRef?: string };
  payment?: { depositBps: number; progressBps: number; finalBps: number };
  thresholds?: { minMarginBps?: number; discountAuthorityBps?: number };
  rounding?: Partial<RoundingPolicy>;
}

export interface Finding {
  code: 'MISSING_VALUE' | 'UNCONFIRMED' | 'REQUIRE_APPROVAL' | 'TAX_EXEMPT_NO_REF' | 'CONFIG_ERROR';
  message: string;
  field?: string;
}

export interface LineBreakdown {
  ref: string;
  extendedPrice: bigint | null;
  discount: bigint;
  net: bigint | null;
  cost: bigint | null;
  margin: bigint | null;
  marginBps: number | null;
  explanation: string;
  missing: string[];
}

export interface PricingBreakdown {
  currency: string;
  engineVersion: string;
  lines: LineBreakdown[];
  subtotal: bigint;
  orderDiscount: bigint;
  goodsNet: bigint;
  fees: Record<string, { amount: bigint; confirmed: boolean; unconfirmed: boolean; explanation: string }>;
  feesTotal: bigint;
  taxableBase: bigint;
  tax: bigint;
  creditCardFee: bigint;
  grandTotal: bigint;
  totalCost: bigint | null;
  totalMargin: bigint | null;
  marginBps: number | null;
  payment: { deposit: bigint; progress: bigint; final: bigint; explanation: string };
  findings: Finding[];
  requiresApproval: boolean;
  incomplete: boolean;
  explanations: string[];
}

/**
 * Centralized pricing calculation. Pure and deterministic. Every amount is
 * explained; missing values are surfaced (never coerced to 0); unconfirmed
 * freight/installation are flagged; threshold breaches require approval.
 */
export function computePricing(input: PricingInput): PricingBreakdown {
  const R: RoundingPolicy = { ...DEFAULT_ROUNDING, ...(input.rounding ?? {}) };
  const cur = input.currency;
  const findings: Finding[] = [];
  const explanations: string[] = [];
  let incomplete = false;

  // ----- Lines -----
  const lines: LineBreakdown[] = input.lines.map((l) => {
    const missing: string[] = [];
    const qty = BigInt(l.quantity);
    let extended: bigint | null = null;
    let net: bigint | null = null;
    let discount = 0n;

    if (l.unitPrice === null) {
      missing.push('unitPrice');
      findings.push({ code: 'MISSING_VALUE', field: `line:${l.ref}.unitPrice`, message: `Unit price for ${l.ref} is not resolved.` });
      incomplete = true;
    } else {
      extended = l.unitPrice * qty;
      discount = l.lineDiscountBps ? applyRate(extended, l.lineDiscountBps, R.lineDiscount) : 0n;
      net = extended - discount;
    }

    let cost: bigint | null = null;
    let margin: bigint | null = null;
    let marginBps: number | null = null;
    if (l.unitCost === null) {
      missing.push('unitCost');
      // Cost may be legitimately restricted; flag but do not assume 0.
    } else {
      cost = l.unitCost * qty;
      if (net !== null) {
        margin = net - cost;
        marginBps = net > 0n ? Number((margin * 10000n) / net) : null;
      }
    }

    const priceStr = extended === null ? '(price unresolved)' : `${l.quantity} × unit = ${formatMinor(extended, cur)}`;
    const explanation = `[${l.priceSource}] ${priceStr}` +
      (discount > 0n ? `, less ${l.lineDiscountBps} bps discount ${formatMinor(discount, cur)}` : '') +
      (net !== null ? ` → net ${formatMinor(net, cur)}` : '');

    return { ref: l.ref, extendedPrice: extended, discount, net, cost, margin, marginBps, explanation, missing };
  });

  const subtotal = sum(lines.map((l) => l.net ?? 0n));

  // ----- Order-level discounts -----
  let orderDiscount = 0n;
  for (const d of input.orderDiscounts ?? []) {
    if (!d.reason) findings.push({ code: 'CONFIG_ERROR', field: 'orderDiscount.reason', message: 'Discount requires a reason.' });
    const amt = d.amount ?? (d.bps ? applyRate(subtotal, d.bps, R.orderDiscount) : 0n);
    orderDiscount += amt;
    explanations.push(`Order discount (${d.reason}): ${formatMinor(amt, cur)}${d.authorizedById ? ` [authorized by ${d.authorizedById}]` : ''}`);
  }

  // Discount authority: total discount vs authorized ceiling.
  const authorityBps = input.thresholds?.discountAuthorityBps;
  if (authorityBps !== undefined && subtotal > 0n) {
    const effBps = Number((orderDiscount * 10000n) / subtotal);
    if (effBps > authorityBps) {
      findings.push({ code: 'REQUIRE_APPROVAL', field: 'orderDiscount', message: `Discount ${effBps} bps exceeds authority ${authorityBps} bps — approval required.` });
    }
  }

  const goodsNet = subtotal - orderDiscount;

  // ----- Fees -----
  const feesOut: PricingBreakdown['fees'] = {};
  const taxableFeeAmounts: bigint[] = [];
  const allFeeAmounts: bigint[] = [];

  const addFee = (key: string, fee: FeeInput | undefined, defaultTaxable: boolean, flagUnconfirmed: boolean) => {
    if (!fee) return;
    if (fee.amount === null) {
      findings.push({ code: 'MISSING_VALUE', field: `fee.${key}`, message: `${key} amount is not provided.` });
      incomplete = true;
      return;
    }
    const unconfirmed = flagUnconfirmed && !fee.confirmed;
    if (unconfirmed) findings.push({ code: 'UNCONFIRMED', field: `fee.${key}`, message: `${key} is an UNCONFIRMED estimate.` });
    feesOut[key] = {
      amount: fee.amount,
      confirmed: fee.confirmed,
      unconfirmed,
      explanation: `${key}: ${formatMinor(fee.amount, cur)}${unconfirmed ? ' (UNCONFIRMED)' : ''}`,
    };
    allFeeAmounts.push(fee.amount);
    if (fee.taxable ?? defaultTaxable) taxableFeeAmounts.push(fee.amount);
  };

  const f = input.fees ?? {};
  addFee('freight', f.freight, true, true);        // freight & installation flagged if unconfirmed
  addFee('installation', f.installation, true, true);
  addFee('travel', f.travel, false, false);
  addFee('perDiem', f.perDiem, false, false);
  if (f.mileage) {
    if (f.mileage.ratePerMile === null) {
      findings.push({ code: 'MISSING_VALUE', field: 'fee.mileage', message: 'Mileage rate not provided.' });
      incomplete = true;
    } else {
      const amt = f.mileage.ratePerMile * BigInt(f.mileage.miles);
      const unconfirmed = !f.mileage.confirmed;
      feesOut.mileage = { amount: amt, confirmed: f.mileage.confirmed, unconfirmed, explanation: `mileage: ${f.mileage.miles} mi × rate = ${formatMinor(amt, cur)}` };
      allFeeAmounts.push(amt);
      if (f.mileage.taxable) taxableFeeAmounts.push(amt);
    }
  }
  for (const o of f.other ?? []) {
    if (o.amount === null) {
      findings.push({ code: 'MISSING_VALUE', field: `fee.other:${o.label}`, message: `${o.label} amount not provided.` });
      incomplete = true;
      continue;
    }
    const unconfirmed = o.confirmed === false;
    feesOut[`other:${o.label}`] = { amount: o.amount, confirmed: o.confirmed ?? true, unconfirmed, explanation: `${o.label}: ${formatMinor(o.amount, cur)}` };
    allFeeAmounts.push(o.amount);
    if (o.taxable) taxableFeeAmounts.push(o.amount);
  }
  const feesTotal = sum(allFeeAmounts);

  // ----- Tax -----
  const taxableBase = goodsNet + sum(taxableFeeAmounts);
  let tax = 0n;
  if (input.tax) {
    if (input.tax.exempt) {
      if (!input.tax.exemptionRef) findings.push({ code: 'TAX_EXEMPT_NO_REF', field: 'tax', message: 'Tax-exempt claimed without an exemption reference.' });
      explanations.push(`Tax exempt${input.tax.exemptionRef ? ` (ref ${input.tax.exemptionRef})` : ''}: ${formatMinor(0n, cur)}`);
    } else {
      tax = applyRate(taxableBase, input.tax.rateBps, R.tax);
      explanations.push(`Tax ${input.tax.rateBps} bps on ${formatMinor(taxableBase, cur)} = ${formatMinor(tax, cur)}`);
    }
  }

  // ----- Credit-card fee (on goods + fees + tax) -----
  const preCc = goodsNet + feesTotal + tax;
  const creditCardFee = f.creditCardBps ? applyRate(preCc, f.creditCardBps, R.ccFee) : 0n;
  if (creditCardFee > 0n) explanations.push(`Credit-card fee ${f.creditCardBps} bps on ${formatMinor(preCc, cur)} = ${formatMinor(creditCardFee, cur)}`);

  const grandTotal = preCc + creditCardFee;

  // ----- Margin -----
  const anyCostMissing = lines.some((l) => l.missing.includes('unitCost'));
  let totalCost: bigint | null = null;
  let totalMargin: bigint | null = null;
  let marginBps: number | null = null;
  if (!anyCostMissing) {
    totalCost = sum(lines.map((l) => l.cost ?? 0n));
    totalMargin = goodsNet - totalCost;
    marginBps = goodsNet > 0n ? Number((totalMargin * 10000n) / goodsNet) : null;
    if (input.thresholds?.minMarginBps !== undefined && marginBps !== null && marginBps < input.thresholds.minMarginBps) {
      findings.push({ code: 'REQUIRE_APPROVAL', field: 'margin', message: `Margin ${marginBps} bps below threshold ${input.thresholds.minMarginBps} bps — approval required.` });
    }
  }

  // ----- Payment schedule (final absorbs rounding residual) -----
  const pay = input.payment ?? { depositBps: 0, progressBps: 0, finalBps: 10000 };
  if (pay.depositBps + pay.progressBps + pay.finalBps !== 10000) {
    findings.push({ code: 'CONFIG_ERROR', field: 'payment', message: 'Payment schedule bps must sum to 10000.' });
  }
  const deposit = applyRate(grandTotal, pay.depositBps, R.payment);
  const progress = applyRate(grandTotal, pay.progressBps, R.payment);
  const finalPay = grandTotal - deposit - progress; // remainder — guarantees exact total
  const paymentExplanation = `deposit ${formatMinor(deposit, cur)} + progress ${formatMinor(progress, cur)} + final ${formatMinor(finalPay, cur)} = ${formatMinor(grandTotal, cur)} (final absorbs rounding residual)`;

  return {
    currency: cur,
    engineVersion: PRICING_ENGINE_VERSION,
    lines,
    subtotal,
    orderDiscount,
    goodsNet,
    fees: feesOut,
    feesTotal,
    taxableBase,
    tax,
    creditCardFee,
    grandTotal,
    totalCost,
    totalMargin,
    marginBps,
    payment: { deposit, progress, final: finalPay, explanation: paymentExplanation },
    findings,
    requiresApproval: findings.some((x) => x.code === 'REQUIRE_APPROVAL'),
    incomplete,
    explanations,
  };
}
