// Airlock external effect handler: the Checkout session of a quoted order, and
// its print file. A BRL order may also pay by Pix, which completes the session
// before the bank settles it (print-check). Stripe keeps a repeat of the
// ledger's key to the session it made.
//
// The file is answered with the session, so the host stores it before the
// outcome settles: no order can be paid whose print file is not in the blob
// plane, and an operator can always print a paid order by hand.
const LIFETIME_SECONDS = 2 * 60 * 60;
// The answer's shape is this version's, whatever the account defaults to.
const STRIPE_VERSION = "2026-09-30.endive";
const form = (fields) => Object.entries(fields).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");

// A page per card face: each card's artwork is both faces side by side at
// Prodigi's print size (commerce/catalogue.ts's postcard, 3708×1263 px at 300
// dpi), so a page the size of one face shows the front at x 0 and the back
// shifted a face to the left. The keys are content keys, so each read is the
// bytes the order was frozen with, or the order does not open.
const POINTS = 72 / 300;
const FACE = { width: 1854 * POINTS, height: 1263 * POINTS };
// Cloudprinter's domestic Brazil A6 landscape Wire-O SKU (148×105 mm + 3 mm
// bleed): a 2-page cover PDF and an unimposed pageblock padded to >= 24 pages.
const COIL_PAGE = { width: (154 * 72) / 25.4, height: (111 * 72) / 25.4 };
const COIL_MIN_PAGES = 24;

async function printFiles(input, sink) {
  const jpegs = await Promise.all(input.artwork.map((key) => sink.blob(key)));
  if (input.country === "BR") {
    const faceH = COIL_PAGE.width * (1263 / 1854);
    const y = (COIL_PAGE.height - faceH) / 2;
    const blank = { jpeg: jpegs[0], x: 2 * COIL_PAGE.width, y, width: 2 * COIL_PAGE.width, height: faceH };
    const faces = jpegs.flatMap((jpeg) => [0, -COIL_PAGE.width].map((x) => ({ jpeg, x, y, width: 2 * COIL_PAGE.width, height: faceH })));
    while (faces.length < COIL_MIN_PAGES) faces.push(blank);
    const [file, cover] = await Promise.all([
      Pdf.fromJpegs({ size: COIL_PAGE, title: input.title, pages: faces }),
      Pdf.fromJpegs({
        size: COIL_PAGE,
        title: `${input.title} — Cover`,
        pages: [{ jpeg: jpegs[0], x: 0, y, width: 2 * COIL_PAGE.width, height: faceH }, blank],
      }),
    ]);
    return { file, cover };
  }
  const pages = jpegs.flatMap((jpeg) => [0, -FACE.width].map((x) => ({ jpeg, x, y: 0, width: 2 * FACE.width, height: FACE.height })));
  return { file: await Pdf.fromJpegs({ size: FACE, title: input.title, pages }), cover: null };
}

export async function issue(input, sink, secrets) {
  const publishable = secrets.STRIPE_PUBLISHABLE_KEY;
  if (!publishable) throw new Error("STRIPE_PUBLISHABLE_KEY is not set on this deployment");
  const { file, cover } = await printFiles(input, sink);
  const methods = input.currency === "brl" ? ["card", "pix"] : ["card"];
  const lineName = input.country === "BR" ? "Snapcards spiral flip-deck" : "Snapcards printed postcards";
  const returned = `${sink.origin}/print?order=${input.id}`;
  const res = await sink.fetch("/v1/checkout/sessions", {
    method: "POST",
    headers: { "Stripe-Version": STRIPE_VERSION },
    body: form({
      mode: "payment",
      client_reference_id: input.id,
      // From the moment the order asked to open, which the row records, so a
      // repeat asks Stripe the same; from its quote, a reader who paid later
      // than 90 minutes on asked under Stripe's 30-minute floor.
      expires_at: input.opened_epoch + LIFETIME_SECONDS,
      ...Object.fromEntries(methods.map((method, i) => [`allowed_payment_method_types[${i}]`, method])),
      "metadata[order_id]": input.id,
      "payment_intent_data[metadata][order_id]": input.id,
      "line_items[0][quantity]": 1,
      "line_items[0][price_data][currency]": input.currency,
      "line_items[0][price_data][unit_amount]": input.total,
      "line_items[0][price_data][product_data][name]": lineName,
      billing_address_collection: "auto",
      // The recipient's email, which Checkout offers the payer to keep.
      ...(input.email ? { customer_email: input.email } : {}),
      ui_mode: "elements",
      return_url: returned,
    }),
  });
  if (res.status >= 500 || res.status === 429) throw new Error(`Stripe answered ${res.status}`);
  if (res.status >= 300) return { failed: { status: res.status, detail: res.body } };
  if (typeof res.body.client_secret !== "string" || !res.body.client_secret) {
    throw new Error("Stripe returned no client_secret");
  }
  // Stripe.js from the Clover release, whose initCheckout takes the client
  // secret and answers loadActions, as the payment unit calls it: v3 refuses
  // initCheckout, and Basil's wants a fetchClientSecret function.
  const sdk = res.body.simulator_origin ?? "https://js.stripe.com";
  const url = `${sdk}/clover/stripe.js#client_secret=${encodeURIComponent(res.body.client_secret)}&publishable_key=${encodeURIComponent(publishable)}`;
  return {
    done: {
      id: res.body.id,
      url,
      file: { $blob: { bytes: file, type: "application/pdf" } },
      ...(cover ? { cover: { $blob: { bytes: cover, type: "application/pdf" } } } : {}),
    },
  };
}
