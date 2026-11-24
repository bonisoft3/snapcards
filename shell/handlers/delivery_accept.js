// delivery_accept — the reader applies one offer, and only what it names moves.
//
// A search suggestion places the pin, fills the postal fields it knows, and
// completes the search box minimally to the first structured component plus any
// prefix needed to disambiguate it from the other suggestions (including any
// house number the reader typed); the pin's offer fills the postal fields; the
// postal fields' offer moves the pin. The recipient, unit line and instructions
// are the reader's own words. Each application is kept as a delivery_choice
// row, a0 the oldest, which the order carries as provenance.
const KEPT = ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7"];
const NUMBER_FIRST = new Set(["US", "CA", "GB", "IE", "AU", "NZ", "FR", "IN", "SG", "IL"]);
const STREET_COMMA_NUMBER = new Set(["BR", "PT", "ES", "IT", "AR", "CL", "CO", "UY", "PY", "MX"]);
const HOUSE_NUMBER = /^\d{1,5}[a-z]?$/i;
const tokens = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().split(/[\s,.]+/).filter((t) => t !== "");
const hasHouseNumber = (street) => {
  const s = (street ?? "").trim();
  return s !== "" && (/\bs\/n\b/i.test(s) || /^\d{1,5}[a-z]?\s+\S/i.test(s) || /(?:,\s*|\s+)\d{1,5}[a-zA-Z0-9/-]*$/.test(s));
};
const formatLine1 = (street, number, country) => {
  if (street === "" || number === "") return street;
  const joined = NUMBER_FIRST.has(country)
    ? `${number} ${street}`
    : STREET_COMMA_NUMBER.has(country)
    ? `${street}, ${number}`
    : `${street} ${number}`;
  return joined.slice(0, 200);
};
const typedNumber = (words, street, country) => {
  if (!words || !street || hasHouseNumber(street)) return "";
  const typed = tokens(words);
  const name = tokens(street);
  if (name.length === 0) return "";
  const first = NUMBER_FIRST.has(country);
  const at = first ? typed.indexOf(name[0]) : typed.lastIndexOf(name[name.length - 1]);
  if (at !== -1) {
    const next = typed[first ? at - 1 : at + 1];
    if (next !== undefined && HOUSE_NUMBER.test(next)) return next.toUpperCase();
  }
  const streetSet = new Set(name);
  const extra = typed.filter((t) => HOUSE_NUMBER.test(t) && !streetSet.has(t));
  return extra.length > 0 ? extra[extra.length - 1].toUpperCase() : "";
};
const partsOf = (s, line1Override) => {
  const seen = new Set();
  const out = [];
  const push = (v) => {
    const t = (v ?? "").trim();
    const k = t.toLowerCase();
    if (t !== "" && !seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  };
  for (const v of [line1Override ?? s.line1, s.district, s.city, s.region, s.postal_code, s.country]) push(v);
  for (const seg of (s.label ?? "").split(",")) push(seg);
  return out;
};
const completedText = (offer, effectiveLine1, rows) => {
  const myParts = partsOf(offer, effectiveLine1);
  if (myParts.length === 0) return "";
  const others = rows
    .filter((s) => s.id.startsWith("s") && s.id !== offer.id)
    .map((s) => partsOf(s));
  let k = 1;
  while (
    k < myParts.length &&
    others.some((o) => o.length >= k && myParts.slice(0, k).every((p, i) => p.toLowerCase() === o[i].toLowerCase()))
  ) {
    k++;
  }
  return myParts.slice(0, k).join(", ").slice(0, 2000);
};
const pinAt = (s) => ({ pin_latitude: s.latitude, pin_longitude: s.longitude, pin_source: "search", pin_q: `${s.latitude},${s.longitude}` });
const baseStreet = (s) =>
  String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^\d{1,5}[a-z]?\s+/i, "")
    .replace(/(?:,\s*|\s+)(?:s\/n|\d{1,5}[a-z0-9/-]*)$/i, "")
    .replace(/,\s*$/, "")
    .trim();
const sameStreet = (a, b) => {
  const ba = baseStreet(a);
  const bb = baseStreet(b);
  if (!ba || !bb) return false;
  return ba === bb || (Math.min(ba.length, bb.length) >= 4 && (ba.startsWith(bb) || bb.startsWith(ba)));
};
// A place that names no postcode leaves the reader's own; only what the offer
// states is written. The bairro is the street's, so a new street replaces it,
// named or not.
const postal = (s) => ({
  ...Object.fromEntries(["line1", "city", "region", "postal_code", "country"].filter((f) => s[f] !== "").map((f) => [f, s[f]])),
  district: s.district,
});
({ context, event }) => {
  if (event.type !== "click") return { updates: [] };
  const id = event.id;
  const allSuggestions = context.rows.place_suggestion ?? [];
  const offer = allSuggestions.find((s) => s.id === id);
  const draft = (context.rows.delivery_draft ?? [])[0];
  if (!offer || !draft) return { updates: [] };
  const fromSearch = id.startsWith("s");
  const country = offer.country || draft.country || "";
  const num = fromSearch ? typedNumber(draft.text, offer.line1, country) : "";
  const effectiveLine1 = num !== "" ? formatLine1(offer.line1, num, country) : offer.line1;
  const effectiveOffer = { ...offer, line1: effectiveLine1 };
  const completed = fromSearch ? completedText(offer, effectiveLine1, allSuggestions) : "";
  // The postal fields just changed, so the question about the old ones is
  // withdrawn: its answer would be offered against fields it no longer describes.
  // Changing from one street to another also clears an apartment from the old street.
  const newStreet = draft.line1 !== "" && effectiveLine1 !== "" && !sameStreet(draft.line1, effectiveLine1) && draft.line2 !== ""
    ? { line2: "", ...("line2_stale" in draft ? { line2_stale: "true", line2_ghost: draft.line2 } : {}) }
    : {};
  const freshPin = "pin_stale" in draft ? { pin_stale: "false" } : {};
  const freshSearch = fromSearch && "search_stale" in draft ? { search_stale: "" } : {};
  const row = id === "address"
    ? { ...pinAt(offer), ...freshPin }
    : {
      ...postal(effectiveOffer),
      ...newStreet,
      ...freshSearch,
      ...(completed !== "" ? { text: completed } : {}),
      address_q: "",
      ...(id === "pin" ? {} : { ...pinAt(offer), ...freshPin }),
    };
  const kept = [...(context.rows.delivery_choice ?? [])]
    .filter((c) => KEPT.includes(c.id))
    .sort((a, b) => KEPT.indexOf(a.id) - KEPT.indexOf(b.id))
    .map((c) => ({ source: c.source, label: c.label }));
  const choices = [...kept, { source: id === "pin" ? "pin" : "search", label: offer.label.slice(0, 300) }].slice(-KEPT.length);
  // A search list stays, out of sight until the search has focus again, so
  // the search button on the same words shows it back; an applied reconciling
  // offer goes.
  const cleared = fromSearch ? [] : [{ op: "delete", entity: "place_suggestion", id }];
  return {
    updates: [
      { op: "patch", entity: "delivery_draft", id: "draft", row: { ...row, step: "details" } },
      ...choices.map((c, i) => ({ op: "put", entity: "delivery_choice", id: KEPT[i], row: c })),
      ...cleared,
    ],
  };
};
