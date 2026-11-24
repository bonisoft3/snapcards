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

  const res = await sink.fetch(`/client/v4/accounts/${secrets.MAIL_ACCOUNT_ID}/email/sending/send`, {
    method: "POST",
    body: {
      from: sender,
      to: input.to,
      subject: `${test}Snapcards order ${input.id}`,
      text: [
        live ? "" : "Stripe test-mode order: no real payment collected; do not print or ship.",
        `Order record ${input.id}. ${vendor} prints and posts this order; there is nothing to do.`,
        `Deck: ${input.title}`,
        `Stock: ${input.stock} (${input.sku}), ${format}`,
        `Charged: ${input.total} ${input.currency} (minor units), priced to receive ${input.fx_brl} brl by Stripe FX quote ${input.fx_quote}; ${vendor}'s cost ${input.cost} usd`,
        `${vendor} order: ${input.vendor_order_id}`,
        `Customer: ${buyerEmail || "not supplied"}`,
        `Delivery, as the customer stated it; payment verifies none of it: ${JSON.stringify(input.delivery)}`,
        `Print file: ${sink.origin}/blobs/mecha-objects/${input.print_file}`,
        input.cover_file ? `Cover file: ${sink.origin}/blobs/mecha-objects/${input.cover_file}` : "",
        file.unread ? `The print file is not attached: ${file.unread}` : "",
      ].filter(Boolean).join("\n"),
      attachments: file.content ? [{ content: file.content, filename: `snapcards-${input.id}.pdf`, type: "application/pdf", disposition: "attachment" }] : [],
    },
  });
  if (res.status >= 500 || res.status === 429) throw new Error(`mail answered ${res.status}`);
  if (res.status >= 300) return { failed: { status: res.status, detail: res.body } };
  return { done: { sent: true } };
}
