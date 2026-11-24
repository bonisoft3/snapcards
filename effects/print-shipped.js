// Airlock external effect handler: sends the 3rd email in the customer's order
// thread once the printer dispatches the parcel with carrier & tracking details.

function host(origin) {
  const match = /^https?:\/\/([^:/]+)(?::\d+)?$/.exec(origin ?? "");
  if (!match) throw new Error(`sink origin ${origin} is no http(s) origin`);
  return match[1];
}

function customerSubject(input, test, br) {
  const shortId = String(input.id ?? "").slice(0, 8);
  return br
    ? `${test}Pedido Snapcards #${shortId} — ${input.title}`
    : `${test}Snapcards order #${shortId} — ${input.title}`;
}

export async function issue(input, sink, secrets) {
  const buyerEmail = String(input.delivery?.contact?.email || input.email || "").trim();
  if (!buyerEmail) {
    return { done: { sent: false } };
  }
  const live = String(input.session_id ?? "").startsWith("cs_live_");
  const test = live ? "" : "[TEST] ";
  const br = (input.country === "BR" && Boolean(input.cover_file)) || input.sku === "textbook_co_a6_l_fc";
  const threadId = String(input.mail_message_id ?? "").trim();
  const baseSubject = customerSubject(input, test, br);
  const statusUrl = `${sink.origin}/print?order=${input.id}`;
  const carrier = String(input.tracking_carrier ?? "").trim() || (br ? "Correios SEDEX" : "Postal service");
  const trackingNumber = String(input.tracking_number ?? "").trim();
  const trackingUrl = String(input.tracking_url ?? "").trim();

  const text = br
    ? [
      live ? "" : "[Pedido em modo de teste — nenhuma cobrança real foi efetuada.]",
      `Seu pedido da Snapcards foi enviado e está a caminho!`,
      ``,
      `Pedido: ${input.id}`,
      input.vendor_order_id ? `Referência na gráfica: ${input.vendor_order_id}` : "",
      `Coleção: ${input.title} (${input.cards} fichas · Livreto espiral Wire-O A6)`,
      `Transportadora: ${carrier}`,
      trackingNumber ? `Código de rastreio: ${trackingNumber}` : "",
      trackingUrl ? `Rastrear nos Correios: ${trackingUrl}` : "",
      ``,
      `Acompanhar pedido na Snapcards: ${statusUrl}`,
    ].filter((line, idx, arr) => line !== "" || (idx > 0 && arr[idx - 1] !== "")).join("\n")
    : [
      live ? "" : "[Test-mode order — no real payment was collected.]",
      `Your Snapcards print order has shipped and is on its way!`,
      ``,
      `Order: ${input.id}`,
      input.vendor_order_id ? `Printer reference: ${input.vendor_order_id}` : "",
      `Collection: ${input.title} (${input.cards} postcards)`,
      `Carrier: ${carrier}`,
      trackingNumber ? `Tracking number: ${trackingNumber}` : "",
      trackingUrl ? `Track shipment: ${trackingUrl}` : "",
      ``,
      `Track your order on Snapcards: ${statusUrl}`,
    ].filter((line, idx, arr) => line !== "" || (idx > 0 && arr[idx - 1] !== "")).join("\n");

  const res = await sink.fetch(`/client/v4/accounts/${secrets.MAIL_ACCOUNT_ID}/email/sending/send`, {
    method: "POST",
    body: {
      from: `snapcards@${host(sink.origin)}`,
      to: buyerEmail,
      subject: `Re: ${baseSubject}`,
      ...(threadId ? { headers: { "In-Reply-To": threadId, References: threadId } } : {}),
      text,
    },
  });
  if (res.status >= 500 || res.status === 429) throw new Error(`mail answered ${res.status}`);
  if (res.status >= 300) return { failed: { status: res.status, detail: res.body } };
  return { done: { sent: true } };
}
