// Airlock external effect handler: what Stripe says of an order's session. This
// read, never a webhook's body, is what marks an order paid, and only a session
// matching the order counts. A Pix completes the session unpaid until the bank
// settles it, and only its payment says whether it still can.
const STRIPE_VERSION = "2026-09-30.endive";
const SETTLING = ["processing", "requires_action"];
const ENDED = ["requires_payment_method", "canceled"];

export async function issue(input, sink) {
  const res = await sink.fetch(`/v1/checkout/sessions/${encodeURIComponent(input.session_id)}?expand%5B%5D=payment_intent`, { headers: { "Stripe-Version": STRIPE_VERSION } });
  if (res.status >= 300) throw new Error(`Stripe answered ${res.status}`);
  const session = res.body;
  if (session.mode !== "payment" || session.client_reference_id !== input.id ||
    session.amount_total !== input.total || session.currency !== input.currency) {
    // Not this order's session: nothing it does later can pay this order, so
    // it ends the order as an ended session does, with the mismatch as the reason.
    return { failed: { state: "failed", reason: "mismatch", session: session.id } };
  }
  const payment = session.payment_intent;
  if (session.status === "complete" && session.payment_status === "paid") {
    return { done: { payment_intent: payment.id, email: session.customer_details?.email ?? null } };
  }
  if (session.status === "complete") {
    if (SETTLING.includes(payment?.status)) return { failed: { state: "processing" } };
    if (ENDED.includes(payment?.status)) return { failed: { state: "failed" } };
    throw new Error(`a complete, unpaid session's payment is ${JSON.stringify(payment?.status)}`);
  }
  return { failed: { state: session.status } };
}
