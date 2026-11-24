// Airlock external effect handler: a paid order that is not with its printer,
// for the operator to reconcile. The customer has been told not to pay again.

// Stored before the order could be paid (print-session), under its content key,
// so what is attached is the bytes the order was paid with. The link is the
// mail's promise; a file the plane cannot give back only loses the attachment.
async function printFile(input, sink) {
  try {
    return { content: await sink.blob(input.print_file) };
  } catch (e) {
    return { unread: e.message };
  }
}

// The cage endows no URL: the origin's host is read by its shape, an https origin the airlock was given.
function host(origin) {
  const match = /^https?:\/\/([^:/]+)(?::\d+)?$/.exec(origin ?? "");
  if (!match) throw new Error(`sink origin ${origin} is no http(s) origin`);
  return match[1];
}

export async function issue(input, sink, secrets) {
  const file = await printFile(input, sink);
  const live = String(input.session_id ?? "").startsWith("cs_live_");
  const test = live ? "" : "[TEST] ";
  const br = input.country === "BR" && Boolean(input.cover_file);
  const vendor = br ? "Cloudprinter" : "Prodigi";
  const format = br ? `spiral flip-deck (${input.cards} cards)` : `${input.cards} postcards`;
  const ref = br ? `reference is ${input.id}` : `merchantReference is ${input.id}`;
  const res = await sink.fetch(`/client/v4/accounts/${secrets.MAIL_ACCOUNT_ID}/email/sending/send`, {
    method: "POST",
    body: {
      // Sent as the deployment it comes from: staging mail never reads as production's.
      from: `snapcards@${host(sink.origin)}`,
      to: input.to,
      subject: `${test}[ALERT] Snapcards order ${input.id}`,
      text: [
        live ? "" : "Stripe test-mode order: no real payment collected; do not print or ship.",
        `A paid order is not with ${vendor}: ${input.failure}`,
        `Reconcile with ${vendor} first: its ${ref}. Only if it never placed the order, resolve it by hand.`,
        `Deck: ${input.title}`,
        `Stock: ${input.stock}, ${format}`,
        `Charged: ${input.total} ${input.currency} (minor units)`,
        `Customer: ${input.email ?? "not supplied"}`,
        `Delivery, as the customer stated it; payment verifies none of it: ${JSON.stringify(input.delivery)}`,
        `Print file: ${sink.origin}/blobs/mecha-objects/${input.print_file}`,
        input.cover_file ? `Cover file: ${sink.origin}/blobs/mecha-objects/${input.cover_file}` : "",
        file.unread ? `The print file is not attached: ${file.unread}` : "",
      ].filter(Boolean).join("\n"),
      attachments: file.content ? [{ content: file.content, filename: `snapcards-${input.id}.pdf`, type: "application/pdf", disposition: "attachment" }] : [],
    },
  });
  // A refusal is thrown too: a revoked token or a sender gone unverified is
  // fixed by hand, and the alert's attempts outlast the fix.
  if (res.status >= 300) throw new Error(`mail answered ${res.status}: ${JSON.stringify(res.body)}`);
  return { done: { sent: true } };
}
