// Airlock external effect handler: once the printer accepts a paid order, replies
// to the customer in the same email thread as print-confirm and sends the
// operator's archive record with the stored print file.

async function printFile(input, sink) {
  try {
    return { content: await sink.blob(input.print_file) };
  } catch (e) {
    return { unread: e.message };
  }
}

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

function formatDelivery(delivery, fallbackEmail) {
  const a = delivery?.address ?? {};
  const c = delivery?.contact ?? {};
  const street = [a.line1, a.line2].filter(Boolean).join(", ");
  const cityState = [a.city, a.region].filter(Boolean).join(" - ");
  const locality = [a.district, cityState].filter(Boolean).join(", ");
  const postalCountry = [a.postalCode, a.country].filter(Boolean).join(" · ");
  const typed = String(delivery?.text ?? "").trim();
  const email = String(c.email || fallbackEmail || "").trim();
  const phone = String(c.phone ?? "").trim();
  const instructions = String(delivery?.instructions ?? "").trim();
  const lat = delivery?.pin?.latitude;
  const lon = delivery?.pin?.longitude;
  const hasPin = typeof lat === "number" && Number.isFinite(lat) && typeof lon === "number" && Number.isFinite(lon);
  return [
    a.recipient ? `  Recipient: ${a.recipient}` : "",
    street ? `  Address: ${street}` : "",
    locality ? `  Area: ${locality}` : "",
    postalCountry ? `  Postal: ${postalCountry}` : "",
    typed && typed !== String(a.line1 ?? "").trim() ? `  Typed address: ${typed}` : "",
    a.taxId ? `  CPF / Tax ID: ${a.taxId}` : "",
    `  Email: ${email || "not supplied"}`,
    phone ? `  Phone: ${phone}` : "",
    instructions ? `  Instructions: ${instructions}` : "",
    hasPin ? `  Map pin: ${lat}, ${lon} (https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon})` : "",
  ].filter(Boolean);
}

function customerSubject(input, test, br) {
  const shortId = String(input.id ?? "").slice(0, 8);
  return br
    ? `${test}Pedido Snapcards #${shortId} — ${input.title}`
    : `${test}Snapcards order #${shortId} — ${input.title}`;
}

export async function issue(input, sink, secrets) {
  const file = await printFile(input, sink);
  const live = String(input.session_id ?? "").startsWith("cs_live_");
  const test = live ? "" : "[TEST] ";
  const br = (input.country === "BR" && Boolean(input.cover_file)) || input.sku === "textbook_co_a6_l_fc";
  const vendor = br ? "Cloudprinter" : "Prodigi";
  const format = br ? `spiral flip-deck (${input.cards} cards)` : `${input.cards} postcards`;
  const sender = `snapcards@${host(sink.origin)}`;

  const buyerEmail = String(input.delivery?.contact?.email || input.email || "").trim();
  if (buyerEmail) {
    const threadId = String(input.mail_message_id ?? "").trim();
    const baseSubject = customerSubject(input, test, br);
    const buyerText = br
      ? [
        live ? "" : "[Pedido em modo de teste — nenhuma cobrança real foi efetuada.]",
        `Boas notícias: a gráfica no Brasil confirmou o recebimento do seu pedido e iniciou a preparação para impressão!`,
        ``,
        `Pedido: ${input.id}`,
        `Referência na gráfica: ${input.vendor_order_id}`,
        `Coleção: ${input.title} (${input.cards} fichas · Livreto espiral Wire-O A6)`,
        `Envio: Correios SEDEX`,
        `Acompanhar pedido: ${sink.origin}/print?order=${input.id}`,
      ].filter(Boolean).join("\n")
      : [
        live ? "" : "[Test-mode order — no real payment was collected.]",
        `Good news: the printer (${vendor}) confirmed your order and queued it for production!`,
        ``,
        `Order: ${input.id}`,
        `Printer reference: ${input.vendor_order_id}`,
        `Collection: ${input.title} (${format})`,
        `Track your order: ${sink.origin}/print?order=${input.id}`,
      ].filter(Boolean).join("\n");

    const buyerRes = await sink.fetch(`/client/v4/accounts/${secrets.MAIL_ACCOUNT_ID}/email/sending/send`, {
      method: "POST",
      body: {
        from: sender,
        to: buyerEmail,
        subject: `Re: ${baseSubject}`,
        ...(threadId ? { headers: { "In-Reply-To": threadId, References: threadId } } : {}),
        text: buyerText,
      },
    });
    if (buyerRes.status >= 500 || buyerRes.status === 429) throw new Error(`buyer mail answered ${buyerRes.status}`);
  }

  const sameBrl = String(input.currency ?? "").toLowerCase() === "brl" && input.fx_brl != null && Number(input.fx_brl) === Number(input.total);
  const fxNote = input.fx_quote ? `Stripe FX quote ${input.fx_quote}` : "";
  const payoutNote = input.fx_brl != null
    ? `payout target ${formatMoney(input.fx_brl, "brl")}${fxNote ? `, ${fxNote}` : ""}`
    : fxNote;
  const chargedLine = sameBrl
    ? `  Charged: ${formatMoney(input.total, input.currency)}${fxNote ? ` (${fxNote})` : ""}`
    : `  Charged: ${formatMoney(input.total, input.currency)}${payoutNote ? ` (${payoutNote})` : ""}`;
  const costLine = input.cost != null ? `  ${vendor} cost: ${formatMoney(input.cost, "usd")}` : "";
  const deliveryLines = formatDelivery(input.delivery, buyerEmail);

  const res = await sink.fetch(`/client/v4/accounts/${secrets.MAIL_ACCOUNT_ID}/email/sending/send`, {
    method: "POST",
    body: {
      from: sender,
      to: input.to,
      subject: `${test}Snapcards order ${input.id}`,
      text: [
        live ? "" : "Stripe test-mode order: no real payment collected; do not print or ship.",
        `${vendor} prints and posts this order — there is nothing to do.`,
        ``,
        `Order`,
        `  ID: ${input.id}`,
        `  ${vendor} order: ${input.vendor_order_id}`,
        `  Deck: ${input.title}`,
        `  Format: ${format}, ${input.stock} (${input.sku})`,
        `  Track: ${sink.origin}/print?order=${input.id}`,
        ``,
        `Payment`,
        chargedLine,
        ...(costLine ? [costLine] : []),
        ``,
        `Customer & Delivery (as stated by customer; unverified)`,
        ...deliveryLines,
        ``,
        `Files`,
        `  Print file: ${sink.origin}/blobs/mecha-objects/${input.print_file}`,
        input.cover_file ? `  Cover file: ${sink.origin}/blobs/mecha-objects/${input.cover_file}` : "",
        file.unread ? `  The print file is not attached: ${file.unread}` : "",
      ].filter((line, idx, arr) => line !== "" || (idx > 0 && arr[idx - 1] !== "")).join("\n"),
      attachments: file.content ? [{ content: file.content, filename: `snapcards-${input.id}.pdf`, type: "application/pdf", disposition: "attachment" }] : [],
    },
  });
  if (res.status >= 500 || res.status === 429) throw new Error(`mail answered ${res.status}`);
  if (res.status >= 300) return { failed: { status: res.status, detail: res.body } };
  return { done: { sent: true } };
}
