// Airlock external effect handler: Cloudprinter's domestic Brazil quote for an
// A6 landscape Wire-O spiral flip-deck (Correios SEDEX), in USD cents for
// print-fx. Textbooks require >= 24 pages, so smaller decks pad blank leaves.
const SKU = "textbook_co_a6_l_fc";
const STOCKS = {
  gloss: { pageblock: "pageblock_150mcs", cover: "cover_250ecb", finish: "cover_finish_gloss", binding: "wire_o_binding" },
  mohawk: { pageblock: "pageblock_120off", cover: "cover_250ecb", finish: "cover_finish_matte", binding: "wire_o_binding" },
};
const CEP_STATES = [
  [1000000, 9999999, "BR-Sao Paulo Metropolitan Region and suburbs"],
  [11000000, 19999999, "BR-Sao Paulo"],
  [20000000, 28999999, "BR-Rio de Janeiro"],
  [29000000, 29999999, "BR-Espirito Santo"],
  [30000000, 39999999, "BR-Minas Gerais"],
  [40000000, 48999999, "BR-Bahia"],
  [49000000, 49999999, "BR-Sergipe"],
  [50000000, 56999999, "BR-Pernambuco"],
  [57000000, 57999999, "BR-Alagoas"],
  [58000000, 58999999, "BR-Paraiba"],
  [59000000, 59999999, "BR-Rio Grande do Norte"],
  [60000000, 63999999, "BR-Ceara"],
  [64000000, 64999999, "BR-Piaui"],
  [65000000, 65999999, "BR-Maranhao"],
  [66000000, 68899999, "BR-Para"],
  [68900000, 68999999, "BR-Amapa"],
  [69000000, 69299999, "BR-Amazonas 1"],
  [69300000, 69399999, "BR-Roraima"],
  [69400000, 69899999, "BR-Amazonas 2"],
  [69900000, 69999999, "BR-Acre"],
  [70000000, 72799999, "BR-Federal District 1"],
  [72800000, 72999999, "BR-Goias 1"],
  [73000000, 73699999, "BR-Federal District 2"],
  [73700000, 76799999, "BR-Goias 2"],
  [76800000, 76999999, "BR-Rondonia 1"],
  [77000000, 77999999, "BR-Tocantins"],
  [78000000, 78899999, "BR-Mato Grosso"],
  [78900000, 78999999, "BR-Rondonia 2"],
  [79000000, 79999999, "BR-Mato Grosso do Sul"],
  [80000000, 87999999, "BR-Parana"],
  [88000000, 89999999, "BR-Santa Catarina"],
  [90000000, 99999999, "BR-Rio Grande do Sul"],
];

function stateForCep(postalCode) {
  const digits = String(postalCode ?? "").replace(/\D/g, "");
  if (digits.length !== 8) return null;
  const n = Number(digits);
  for (const [min, max, state] of CEP_STATES) {
    if (n >= min && n <= max) return state;
  }
  return null;
}

// CloudCore writes 4-decimal strings ("8.0266"); round up to USD cents so a
// sub-cent fraction is never absorbed into the payout.
function ceilCents(amount) {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(amount ?? ""));
  if (match === null) throw new Error(`not a decimal amount: ${JSON.stringify(amount)}`);
  const micro = BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
  return Number((micro + 9999n) / 10_000n);
}

export async function issue(input, sink, secrets) {
  const apikey = secrets.CLOUDPRINTER_API_KEY;
  if (!apikey) throw new Error("CLOUDPRINTER_API_KEY is not set on this deployment");
  const currency = String(input.currency ?? "").toUpperCase();
  if (currency !== "USD") return { failed: { status: "unsupported_currency" } };
  const state = stateForCep(input.postal_code);
  if (state === null) return { failed: { status: "invalid_postal_code" } };
  const spec = STOCKS[input.stock];
  if (!spec) return { failed: { status: "invalid_stock" } };
  const pages = String(Math.max(24, input.cards * 2));
  const res = await sink.fetch("/cloudcore/1.0/orders/quote", {
    method: "POST",
    body: {
      apikey,
      currency,
      country: "BR",
      state,
      items: [{
        reference: "deck-1",
        product: SKU,
        count: "1",
        options: [
          { type: "total_pages", count: pages },
          { type: spec.pageblock, count: pages },
          { type: spec.cover, count: "1" },
          { type: spec.finish, count: "1" },
          { type: spec.binding, count: "1" },
        ],
      }],
    },
  });
  if (res.status >= 500 || res.status === 429) throw new Error(`Cloudprinter answered ${res.status}`);
  if (res.status >= 300) return { failed: { status: res.status, detail: res.body?.error?.type ?? "quote_refused" } };
  if (res.body?.currency !== currency) throw new Error(`not a ${currency} quote`);
  const shipments = res.body?.shipments ?? [];
  if (shipments.length !== 1 || !Array.isArray(shipments[0]?.quotes) || shipments[0].quotes.length === 0) {
    return { failed: { status: "no_shipping" } };
  }
  const quotes = [...shipments[0].quotes].sort((a, b) => Number(a.price) - Number(b.price));
  const chosen = quotes[0];
  if (chosen.currency !== currency) throw new Error(`not a ${currency} shipping quote`);
  const items = ceilCents(res.body.price) + ceilCents(res.body.vat ?? "0");
  const shipping = ceilCents(chosen.price) + ceilCents(chosen.vat ?? "0");
  return {
    done: {
      sku: SKU,
      shipping_method: chosen.shipping_level,
      shipping,
      cost: items + shipping,
    },
  };
}
