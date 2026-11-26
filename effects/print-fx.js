// Airlock external effect handler: an order's charge in its own currency, from
// Prodigi's USD cost and a Stripe FX quote (commerce/README.md#price). The
// account settles in BRL, so the price is a BRL amount at the reference rate,
// and another currency is charged what Stripe's own rate, its FX fee in it,
// pays out as that amount: every order receives the same BRL. Checkout takes no
// quote, so the quote prices the order and does not hold Checkout to its rate.
const STRIPE_VERSION = "2025-04-30.preview";
// Minor units per unit, as commerce/money.ts's currencyScale says of each.
const SCALE = { brl: 100n, ars: 100n, ils: 100n, usd: 100n, gbp: 100n, cny: 100n, inr: 100n };
const form = (fields) => fields.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");

// A rate exactly as its JSON number reads, as a fraction, so no float carries a price.
function ratio(rate) {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(rate));
  if (match === null || Number(rate) <= 0) throw new Error(`not a rate: ${JSON.stringify(rate)}`);
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? 0) - fraction.length;
  return exponent >= 0
    ? [BigInt(match[1] + fraction) * 10n ** BigInt(exponent), 1n]
    : [BigInt(match[1] + fraction), 10n ** BigInt(-exponent)];
}
// Up to the next minor unit, so rounding never eats the markup or the payout.
const ceil = (num, den) => (num + den - 1n) / den;

export async function issue(input, sink) {
  const scale = SCALE[input.currency];
  if (scale === undefined) throw new Error(`no scale for ${input.currency}`);
  const from = ["usd", input.currency].filter((c, i, all) => c !== "brl" && all.indexOf(c) === i);
  const res = await sink.fetch("/v1/fx_quotes", {
    method: "POST",
    headers: { "Stripe-Version": STRIPE_VERSION },
    body: form([["to_currency", "brl"], ...from.map((c, i) => [`from_currencies[${i}]`, c]), ["lock_duration", "none"]]),
  });
  if (res.status >= 500 || res.status === 429) throw new Error(`Stripe answered ${res.status}`);
  if (res.status >= 300) return { failed: { status: res.status, detail: res.body } };
  const { id, to_currency: to, rates } = res.body;
  if (to !== "brl" || from.some((c) => rates?.[c] === undefined)) return { failed: { status: "inconsistent", detail: res.body } };
  const [refNum, refDen] = ratio(rates.usd.rate_details.reference_rate);
  // Markup applies to Prodigi's non-shipping cost alone; courier shipping passes through at 1x.
  const itemsCost = BigInt(input.cost) - BigInt(input.shipping);
  if (itemsCost < 0n) throw new Error(`shipping ${input.shipping} exceeds cost ${input.cost}`);
  const brl = ceil((itemsCost * BigInt(100 + input.markup_percent) + BigInt(input.shipping) * 100n) * refNum * SCALE.brl, SCALE.usd * refDen * 100n);
  const shippingBrl = ceil(BigInt(input.shipping) * refNum * SCALE.brl, SCALE.usd * refDen);
  const charged = (centavos) => {
    if (input.currency === "brl") return centavos;
    const [num, den] = ratio(rates[input.currency].exchange_rate);
    return ceil(centavos * den * scale, SCALE.brl * num);
  };
  const total = charged(brl);
  // Prodigi's shipping, as true a line as the cost: the item line is the rest.
  const shipping = charged(shippingBrl);
  return { done: { quote: id, rates, brl: Number(brl), item: Number(total - shipping), shipping: Number(shipping), total: Number(total) } };
}
