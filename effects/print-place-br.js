// Airlock external effect handler: places a paid Brazil spiral flip-deck order
// at Cloudprinter. CloudCore enforces unique order `reference` (409 on repeat),
// so a retry reads /orders/info for the same order id instead of duplicating it.
const ERROR_STATES = new Set([7, 11, 31, 35, 39, 41]);
const STOCKS = {
  gloss: { pageblock: "pageblock_150mcs", cover: "cover_250ecb", finish: "cover_finish_gloss", binding: "wire_o_binding" },
  mohawk: { pageblock: "pageblock_120off", cover: "cover_250ecb", finish: "cover_finish_matte", binding: "wire_o_binding" },
};
const CEP_STATES = [
  [1000000, 9999999, "BR-Sao Paulo Metropolitan Region and suburbs"],
  [11000000, 19999999, "BR-Sao Paulo"],
  [20000000, 28999999, "BR-Rio de Janeiro"],
  [29000000, 29999999, "BR-Espirito Santo"],
  [30000000, 39999999, "BR-Minas Gerais"],
  [40000000, 48999999, "BR-Bahia"],
  [49000000, 49999999, "BR-Sergipe"],
  [50000000, 56999999, "BR-Pernambuco"],
  [57000000, 57999999, "BR-Alagoas"],
  [58000000, 58999999, "BR-Paraiba"],
  [59000000, 59999999, "BR-Rio Grande do Norte"],
  [60000000, 63999999, "BR-Ceara"],
  [64000000, 64999999, "BR-Piaui"],
  [65000000, 65999999, "BR-Maranhao"],
  [66000000, 68899999, "BR-Para"],
  [68900000, 68999999, "BR-Amapa"],
  [69000000, 69299999, "BR-Amazonas 1"],
  [69300000, 69399999, "BR-Roraima"],
  [69400000, 69899999, "BR-Amazonas 2"],
  [69900000, 69999999, "BR-Acre"],
  [70000000, 72799999, "BR-Federal District 1"],
  [72800000, 72999999, "BR-Goias 1"],
  [73000000, 73699999, "BR-Federal District 2"],
  [73700000, 76799999, "BR-Goias 2"],
  [76800000, 76999999, "BR-Rondonia 1"],
  [77000000, 77999999, "BR-Tocantins"],
  [78000000, 78899999, "BR-Mato Grosso"],
  [78900000, 78999999, "BR-Rondonia 2"],
  [79000000, 79999999, "BR-Mato Grosso do Sul"],
  [80000000, 87999999, "BR-Parana"],
  [88000000, 89999999, "BR-Santa Catarina"],
  [90000000, 99999999, "BR-Rio Grande do Sul"],
];

function stateForCep(postalCode) {
  const digits = String(postalCode ?? "").replace(/\D/g, "");
  if (digits.length !== 8) return null;
  const n = Number(digits);
  for (const [min, max, state] of CEP_STATES) {
    if (n >= min && n <= max) return state;
  }
  return null;
}

function formatCpf(value) {
  const d = String(value ?? "").replace(/\D/g, "");
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return null;
  for (const len of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    if (((sum * 10) % 11) % 10 !== Number(d[len])) return null;
  }
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

// RFC 1321 MD5: CloudCore validates order files by their 32-hex md5sum.
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);

function md5Hex(bytes) {
  const bitLen = bytes.length * 8;
  const padLen = (((bytes.length + 8) >>> 6) + 1) << 6;
  const buf = new Uint8Array(padLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(padLen - 8, bitLen >>> 0, true);
  view.setUint32(padLen - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  for (let off = 0; off < padLen; off += 64) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f = 0, g = 0;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const sum = (a + f + MD5_K[i] + view.getUint32(off + g * 4, true)) >>> 0;
      a = d;
      d = c;
      c = b;
      const rot = ((sum << MD5_S[i]) | (sum >>> (32 - MD5_S[i]))) >>> 0;
      b = (b + rot) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return [...out].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function splitName(fullName) {
  const parts = String(fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return { firstname: parts[0].slice(0, 60), lastname: "—" };
  return {
    firstname: parts[0].slice(0, 60),
    lastname: parts.slice(1).join(" ").slice(0, 80),
  };
}

function formatCep(postalCode) {
  const d = String(postalCode ?? "").replace(/\D/g, "");
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : null;
}

export async function issue(input, sink, secrets) {
  const apikey = secrets.CLOUDPRINTER_API_KEY;
  if (!apikey) throw new Error("CLOUDPRINTER_API_KEY is not set on this deployment");
  if (!input.cover_file || !input.print_file) {
    return { failed: { status: "missing_files" } };
  }
  if (!input.sku || !input.shipping_method || !input.title) {
    return { failed: { status: "missing_order_spec" } };
  }
  const raw = input.delivery?.address ?? {};
  const name = splitName(raw.recipient);
  const street1 = String(raw.line1 ?? "").trim().slice(0, 100);
  const street2 = [raw.line2, raw.district].filter(Boolean).join(", ").slice(0, 100);
  const city = String(raw.city ?? "").trim().slice(0, 50);
  if (!name || !street1 || !city) {
    return { failed: { status: "missing_address" } };
  }
  const zip = formatCep(raw.postalCode);
  const state = stateForCep(raw.postalCode);
  const cpf = formatCpf(raw.taxId);
  if (zip === null || state === null) return { failed: { status: "invalid_postal_code" } };
  if (cpf === null) return { failed: { status: "invalid_cpf" } };
  const spec = STOCKS[input.stock];
  if (!spec) return { failed: { status: "invalid_stock" } };

  const [coverBytes, bookBytes] = await Promise.all([
    sink.blob(input.cover_file),
    sink.blob(input.print_file),
  ]);
  const { phone = "", email = "" } = input.delivery?.contact ?? {};
  const customerEmail = email || input.email || "davi@davi.eng.br";
  // Prefix 00000 is unallocated in Anatel's numbering plan, so an omitted phone
  // satisfies CloudCore's schema without routing courier SMS to a stranger.
  const customerPhone = phone.trim() || "+55 11 00000-0000";
  const pages = String(Math.max(24, input.cards * 2));

  const res = await sink.fetch("/cloudcore/1.0/orders/add", {
    method: "POST",
    body: {
      apikey,
      reference: input.id,
      email: "davi@davi.eng.br",
      addresses: [{
        type: "delivery",
        firstname: name.firstname,
        lastname: name.lastname,
        street1,
        ...(street2 ? { street2 } : {}),
        zip,
        city,
        state,
        country: "BR",
        email: customerEmail,
        phone: customerPhone,
        customer_identification: cpf,
      }],
      items: [{
        reference: "deck-1",
        product: input.sku,
        shipping_level: input.shipping_method,
        title: String(input.title).slice(0, 120),
        count: "1",
        files: [
          {
            type: "cover",
            url: `${sink.origin}/blobs/mecha-objects/${input.cover_file}`,
            md5sum: md5Hex(coverBytes),
          },
          {
            type: "book",
            url: `${sink.origin}/blobs/mecha-objects/${input.print_file}`,
            md5sum: md5Hex(bookBytes),
          },
        ],
        options: [
          { type: "total_pages", count: pages },
          { type: spec.pageblock, count: pages },
          { type: spec.cover, count: "1" },
          { type: spec.finish, count: "1" },
          { type: spec.binding, count: "1" },
        ],
      }],
    },
  });
  if (res.status >= 500 || res.status === 429) throw new Error(`Cloudprinter answered ${res.status}`);
  if ((res.status === 409 || res.status === 400) && res.body?.error?.type === "order_reference_not_unique") {
    const existing = await sink.fetch("/cloudcore/1.0/orders/info", {
      method: "POST",
      body: { apikey, reference: input.id },
    });
    if (existing.status !== 200) throw new Error(`Cloudprinter info answered ${existing.status}`);
    const code = Number(existing.body?.state ?? 1);
    if (code === 500) return { failed: { status: res.status, detail: "cancelled" } };
    if (ERROR_STATES.has(code)) {
      return { failed: { status: res.status, detail: existing.body?.state_code ?? `error_${code}` } };
    }
    const shipped = code === 100 || code === 501 ||
      (existing.body?.items ?? []).some((item) => Boolean(item.tracking));
    const stage = code === 100 ? "completed" : shipped ? "shipped" : "in_progress";
    return { done: { id: existing.body?.order ?? existing.body?.reference ?? input.id, stage } };
  }
  if (res.status !== 201 && res.status !== 200) {
    return { failed: { status: res.status, detail: res.body?.error?.type ?? "order_refused" } };
  }
  return { done: { id: res.body?.order ?? input.id, stage: "in_progress" } };
}
