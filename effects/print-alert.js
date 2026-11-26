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

export async function issue(input, sink, secrets) {
  const file = await printFile(input, sink);
  const live = String(input.session_id ?? "").startsWith("cs_live_");
  const test = live ? "" : "[TEST] ";
  const br = input.country === "BR" && Boolean(input.cover_file);
  const vendor = br ? "Cloudprinter" : "Prodigi";
  const format = br ? `spiral flip-deck (${input.cards} cards)` : `${input.cards} postcards`;
  const ref = br ? `reference is ${input.id}` : `merchantReference is ${input.id}`;
  const deliveryLines = formatDelivery(input.delivery, input.email);
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
        `Action required: reconcile with ${vendor} first (its ${ref}). Only if it never placed the order, resolve it by hand.`,
        ``,
        `Order`,
        `  ID: ${input.id}`,
        `  Deck: ${input.title}`,
        `  Format: ${format}, ${input.stock}`,
        ``,
        `Payment`,
        `  Charged: ${formatMoney(input.total, input.currency)}`,
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
  // A refusal is thrown too: a revoked token or a sender gone unverified is
  // fixed by hand, and the alert's attempts outlast the fix.
  if (res.status >= 300) throw new Error(`mail answered ${res.status}: ${JSON.stringify(res.body)}`);
  return { done: { sent: true } };
}
