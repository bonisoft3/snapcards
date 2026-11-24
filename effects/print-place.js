// Airlock external effect handler: the Prodigi order of a paid one. The ledger's
// key is its idempotencyKey, so a repeat finds the order rather than making
// another; Prodigi fetches each card's image from the blob plane's raw route,
// since /img re-encodes and the print area wants the very bytes written.

export async function issue(input, sink) {
  const raw = input.delivery.address ?? {};
  const fallback = (input.delivery.text || "—").trim() || "—";
  const recipient = raw.recipient || fallback.slice(0, 100);
  const line1 = raw.line1 || fallback.slice(0, 100);
  const city = raw.city || fallback.slice(0, 50);
  const region = raw.region || "";
  const postalCode = raw.postalCode || "00000";
  const country = raw.country || "US";
  // Prodigi has no field for the district a Brazilian, Mexican or Chinese
  // address carries, so it rides on line2; an order whose two overrun the line
  // does not open (migrations/20261107_print_order_file.json's print_order_frozen).
  const line2 = [input.delivery.address.line2, input.delivery.address.district].filter(Boolean).join(", ");
  // Orders frozen before the delivery stated a contact have none.
  const { phone = "", email = "" } = input.delivery.contact ?? {};
  const res = await sink.fetch("/v4.0/Orders", {
    method: "POST",
    body: {
      merchantReference: input.id,
      idempotencyKey: sink.key,
      callbackUrl: `${sink.origin}/signal/prodigi/${input.id}`,
      shippingMethod: input.shipping_method,
      recipient: {
        name: recipient,
        // Couriers ask for them on international parcels, and Prodigi says it
        // otherwise substitutes its own email: the recipient's own, else the payer's.
        ...(email || input.email ? { email: email || input.email } : {}),
        ...(phone ? { phoneNumber: phone } : {}),
        address: {
          line1,
          ...(line2 ? { line2 } : {}),
          postalOrZipCode: postalCode,
          countryCode: country,
          townOrCity: city,
          ...(region ? { stateOrCounty: region } : {}),
        },
      },
      items: input.artwork.map((key, index) => ({
        merchantReference: `card-${index + 1}`,
        sku: input.sku,
        copies: 1,
        sizing: "fillPrintArea",
        assets: [{ printArea: "default", url: `${sink.origin}/blobs/mecha-objects/${key}` }],
      })),
    },
  });
  // A 5xx does not say whether the order exists; the same key will.
  if (res.status >= 500 || res.status === 429) throw new Error(`Prodigi answered ${res.status}`);
  if (res.status >= 300) return { failed: { status: res.status, detail: res.body } };
  return { done: { id: res.body.order.id, stage: res.body.order.status?.stage ?? "OnHold" } };
}
