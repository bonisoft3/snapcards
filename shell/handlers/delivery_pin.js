// delivery_pin — the reader's position or the dropped pin becomes the pin; the
// position is also kept as `near`, which searches prefer until the reader
// turns it off with an empty pin, which takes a pin that was it away too. The
// postal fields and the free text are left as they are: the pin is a
// statement of its own, reconciled only by an offer the reader applies, which
// delivery_offers weighs again once the pin has moved. A position whose street
// is known writes it in the search box (delivery_found does when it arrives).
const EMPTY = {
  step: "search", text: "", search_q: "", pin_latitude: "", pin_longitude: "", pin_source: "", pin_q: "", near: "",
  recipient: "", line1: "", line2: "", city: "", region: "", postal_code: "", country: "", address_q: "", instructions: "",
  pin_stale: "false", line2_stale: "", line2_ghost: "", search_stale: "",
};
const FIELDS = ["label", "line1", "city", "region", "postal_code", "country", "latitude", "longitude", "district"];
const placeOf = (column) => {
  const cells = column.split("\t");
  return Object.fromEntries(FIELDS.map((f, i) => [f, cells[i] ?? ""]));
};
({ context, event }) => {
  if (event.type !== "pin") return { updates: [] };
  const { latitude, longitude, source } = event.detail;
  const draft = (context.rows.delivery_draft ?? [])[0];
  if (source === "") {
    if (!draft) return { updates: [] };
    const unpinned = draft.pin_source === "gps"
      ? { pin_latitude: "", pin_longitude: "", pin_source: "", pin_q: "", ...("pin_stale" in draft ? { pin_stale: "true" } : {}) }
      : {};
    const gpsText = draft.near && draft.search_q?.endsWith(`\t${draft.near}`)
      ? draft.search_q.slice(0, -(draft.near.length + 1))
      : "";
    const erased = gpsText !== "" && draft.text === gpsText ? { text: "", search_q: "", step: "details" } : {};
    return { updates: [{ op: "patch", entity: "delivery_draft", id: "draft", row: { near: "", ...unpinned, ...erased } }] };
  }
  const pin_q = `${latitude},${longitude}`;
  // The same position again is a memo hit, which raises no `found`. Clicking
  // the GPS icon fills the search box with the reverse-geocoded address (or
  // clears prior text so delivery_found fills it when the answer arrives).
  const hadText = (draft?.text ?? "") !== "";
  const known = source === "gps" ? (context.rows.place_answer ?? []).find((a) => a.kind === "reverse" && a.q === pin_q && a.p0 !== "") : undefined;
  const place = known ? placeOf(known.p0) : undefined;
  const text = place ? [place.line1, place.city].filter((part) => part !== "").join(", ") : "";
  const pin = {
    pin_latitude: latitude, pin_longitude: longitude, pin_source: source, pin_q, step: "details",
    ...(draft && "pin_stale" in draft ? { pin_stale: "false" } : {}),
    ...(source === "gps" ? { near: pin_q } : {}),
    ...(text !== "" ? { text, search_q: `${text}\t${pin_q}` } : source === "gps" && hadText ? { text: "" } : {}),
  };
  // "Use my location" may be the reader's first act, before any keystroke has
  // written the draft: then the pin starts it.
  if (!(context.rows.delivery_draft ?? []).length) {
    return { updates: [{ op: "put", entity: "delivery_draft", id: "draft", row: { ...EMPTY, ...pin } }] };
  }
  return {
    updates: [
      { op: "patch", entity: "delivery_draft", id: "draft", row: pin },
    ],
  };
};
