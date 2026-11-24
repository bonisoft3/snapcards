// Airlock external effect handler: immediate customer order confirmation sent the
// moment payment settles, before the printer accepts the order; returns the
// RFC 5322 Message-ID so the printer confirmation replies in the same thread.

function host(origin) {
  const match = /^https?:\/\/([^:/]+)(?::\d+)?$/.exec(origin ?? "");
  if (!match) throw new Error(`sink origin ${origin} is no http(s) origin`);
  return match[1];
}

const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "vnd", "vuv", "xaf", "xof", "xpf"]);

function formatMoney(total, currency) {
  const cur = String(currency ?? "usd").toUpperCase();
  const minor = Number(total ?? 0);
  if (ZERO_DECIMAL.has(cur.toLowerCase())) {
    return `${Math.round(minor)} ${cur}`;
  }
  const fixed = (minor / 100).toFixed(2);
  if (cur === "BRL") return `R$ ${fixed.replace(".", ",")}`;
  if (cur === "USD") return `$${fixed} USD`;
  return `${fixed} ${cur}`;
}

function formatAddress(delivery) {
  const a = delivery?.address ?? {};
  return [
    a.recipient,
    [a.line1, a.line2].filter(Boolean).join(", "),
    [a.district, a.city, a.region].filter(Boolean).join(" - "),
    [a.postalCode, a.country].filter(Boolean).join(" · "),
  ].filter(Boolean).join("\n  ");
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
    return { done: { sent: false, message_id: "" } };
  }
  const live = String(input.session_id ?? "").startsWith("cs_live_");
  const test = live ? "" : "[TEST] ";
  const br = (input.country === "BR" && Boolean(input.cover_file)) || input.sku === "textbook_co_a6_l_fc";
  const subject = customerSubject(input, test, br);
  const amount = formatMoney(input.total, input.currency);
  const addressBlock = formatAddress(input.delivery);
  const stockLine = br
    ? `${input.cards} fichas · Livreto espiral Wire-O A6 (${input.stock === "mohawk" ? "Offset 120 g/m²" : "Couché 150 g/m²"})`
    : `${input.cards} postcards · 6 × 4 in (${input.stock})`;

  const text = br
    ? [
      live ? "" : "[Pedido em modo de teste — nenhuma cobrança real foi efetuada.]",
      `Recebemos seu pagamento! Aqui estão os detalhes do seu pedido na Snapcards:`,
      ``,
      `Pedido: ${input.id}`,
      `Coleção: ${input.title}`,
      `Formato: ${stockLine}`,
      `Total pago: ${amount}`,
      addressBlock ? `Entrega:\n  ${addressBlock}` : "",
      ``,
      `Status atual: Pagamento confirmado — enviando seu pedido para a gráfica no Brasil (Correios SEDEX).`,
      `Assim que a gráfica confirmar o recebimento para produção, enviaremos um segundo e-mail nesta mesma conversa.`,
      `Acompanhar pedido: ${sink.origin}/print?order=${input.id}`,
    ].filter((line, idx, arr) => line !== "" || (idx > 0 && arr[idx - 1] !== "")).join("\n")
    : [
      live ? "" : "[Test-mode order — no real payment was collected.]",
      `We received your payment! Here are the details of your Snapcards print order:`,
      ``,
      `Order: ${input.id}`,
      `Collection: ${input.title}`,
      `Format: ${stockLine}`,
      `Total paid: ${amount}`,
      addressBlock ? `Delivery:\n  ${addressBlock}` : "",
      ``,
      `Current status: Payment confirmed — sending your order to the printer now.`,
      `As soon as the printer confirms production, we will send a follow-up email in this same thread.`,
      `Track your order: ${sink.origin}/print?order=${input.id}`,
    ].filter((line, idx, arr) => line !== "" || (idx > 0 && arr[idx - 1] !== "")).join("\n");

  const res = await sink.fetch(`/client/v4/accounts/${secrets.MAIL_ACCOUNT_ID}/email/sending/send`, {
    method: "POST",
    body: {
      from: `snapcards@${host(sink.origin)}`,
      to: buyerEmail,
      subject,
      text,
    },
  });
  if (res.status >= 500 || res.status === 429) throw new Error(`mail answered ${res.status}`);
  if (res.status >= 300) return { failed: { status: res.status, detail: res.body } };
  const messageId = String(res.body?.result?.message_id ?? "");
  return { done: { sent: true, message_id: messageId } };
}
