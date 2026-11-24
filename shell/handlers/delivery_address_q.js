// delivery_address_q — the postal fields as one question, taken when a field
// is committed (its change), never while the reader types: Nominatim's policy
// forbids asking as-you-type. `params.field` is the field that changed, read
// from the event since the row may not hold it yet; `params.what` projects
// street-change staleness onto `line2`, `line2_stale`, and `line2_ghost`.
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
({ context, event }, params) => {
  const prev = context.items[0] ?? {};
  const what = params?.what;
  if (what === "order_id") {
    return event?.value !== undefined ? String(event.value) : (prev.order_id ?? "");
  }
  if (what === "line2_ghost_from_line2") {
    const v = String(event?.value ?? "").trim();
    return v !== "" ? v : (prev.line2_ghost ?? "");
  }
  if (what === "line2" || what === "line2_stale" || what === "line2_ghost") {
    const prevLine1 = String(prev.line1 ?? "").trim();
    const nextLine1 = String(event?.value ?? "").trim();
    const prevLine2 = String(prev.line2 ?? "").trim();
    const changed = prevLine1 !== "" && nextLine1 !== "" && !sameStreet(prevLine1, nextLine1) && prevLine2 !== "";
    if (what === "line2") return changed ? "" : (prev.line2 ?? "");
    if (what === "line2_stale") return changed ? "true" : (prev.line2_stale ?? "");
    return changed ? prevLine2 : (prev.line2_ghost ?? "");
  }
  const row = params?.field ? { ...prev, [params.field]: event.value } : { ...prev };
  return [row.line1, row.district, row.postal_code, row.city, row.region, row.country].filter((v) => Boolean(v && v !== "")).join(" ");
};
