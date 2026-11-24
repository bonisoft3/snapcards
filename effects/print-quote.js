// Airlock external effect handler: Prodigi's price for a deck to a country, in
// the one currency it quotes; print-fx makes the charge of it
// (commerce/README.md#price). An answer in any other currency is refused.
const SKU = { gloss: "GLOBAL-POST-GLOS-6X4", mohawk: "GLOBAL-POST-MOH-6X4" };

// Prodigi's Money is a decimal string; the charge is an integer in minor units,
// so no float ever carries a price.
function minor(money, currency) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(money?.amount));
  if (match === null || money.currency !== currency) throw new Error(`not a ${currency} price: ${JSON.stringify(money)}`);
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

export async function issue(input, sink) {
  const currency = input.currency.toUpperCase();
  const sku = SKU[input.stock];
  const res = await sink.fetch("/v4.0/quotes", {
    method: "POST",
    body: {
      destinationCountryCode: input.country,
      currencyCode: currency,
      // One line per card, the shape the order has.
      items: new Array(input.cards).fill(null).map(() => ({ sku, copies: 1, attributes: {}, assets: [{ printArea: "default" }] })),
    },
  });
  if (res.status >= 500 || res.status === 429) throw new Error(`Prodigi answered ${res.status}`);
  if (res.status >= 300) return { failed: { status: res.status, detail: res.body } };
  const quotes = [...res.body.quotes].sort((a, b) => Number(a.costSummary.totalCost.amount) - Number(b.costSummary.totalCost.amount));
  if (quotes.length === 0) return { failed: { status: "no_shipping" } };
  const { costSummary, shipmentMethod } = quotes[0];
  const shipping = minor(costSummary.shipping, currency);
  const total = minor(costSummary.totalCost, currency);
  if (minor(costSummary.items, currency) + shipping + minor(costSummary.totalTax, currency) !== total) {
    return { failed: { status: "inconsistent", detail: costSummary } };
  }
  return { done: { sku, shipping_method: shipmentMethod, shipping, cost: total } };
}
