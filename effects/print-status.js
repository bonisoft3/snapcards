// Airlock external effect handler: what Prodigi says of an order, asked because
// its unsigned callback said to ask. An order with a blocking issue goes to the
// operator; the ones Prodigi retries itself do not.
const PASSING = ["order.items.assets.NotDownloaded", "destinationCountryCode.UsSalesTaxWarning"];

export async function issue(input, sink) {
  const res = await sink.fetch(`/v4.0/orders/${encodeURIComponent(input.vendor_order_id)}`);
  // Its read lags its callback, so a 404 is worth asking again.
  if (res.status >= 300) throw new Error(`Prodigi answered ${res.status}`);
  const { order } = res.body;
  if (order.merchantReference !== input.id) return { failed: { state: "mismatch", order: order.id } };
  const stage = order.status?.stage ?? "OnHold";
  const shipments = Array.isArray(order.shipments) ? order.shipments : [];
  const shipment = shipments.find((s) => s?.tracking?.number || s?.tracking?.url || s?.dispatchDate) ?? shipments[0] ?? null;
  const trackingNumber = String(shipment?.tracking?.number ?? "").trim() || null;
  const trackingUrl = String(shipment?.tracking?.url ?? "").trim() || null;
  const carrier = [shipment?.carrier?.name, shipment?.carrier?.service].filter(Boolean).join(" · ") || null;
  const shipped = ["Complete", "InProgress"].includes(order.status?.details?.shipping) || Boolean(trackingNumber || shipment?.dispatchDate);
  const state = stage === "Cancelled" ? "cancelled" : stage === "Complete" ? "completed" : stage === "OnHold" ? "on_hold" : shipped ? "shipped" : "in_progress";
  const issues = (order.status?.issues ?? []).filter((i) => !PASSING.includes(i.errorCode)).map((i) => [i.errorCode, i.description].filter(Boolean).join(": "));
  if (state === "cancelled" || issues.length > 0) return { failed: { state, issues } };
  return { done: { state, carrier, tracking_number: trackingNumber, tracking_url: trackingUrl } };
}
