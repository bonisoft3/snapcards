// delivery_found — a search answer becomes the list of places the screen
// offers. The memo dispatches the question's key and the answer is read off
// its row; an answer to a search the reader has submitted past is dropped.
// The street at the reader's own position, once known, is written into the
// search box and searched near them, as if they had typed it. Address and
// other reverse answers are delivery_offers' to weigh, which it does on every
// change of the draft or the memo, not only when an answer arrives.
const SEARCH = ["s0", "s1", "s2", "s3", "s4"];
// A place column is its fields joined by tabs (shell/units/geocoder), so a
// short or empty row reads as empty fields and no value can fail to read.
const FIELDS = ["label", "line1", "city", "region", "postal_code", "country", "latitude", "longitude", "district"];
const placeOf = (column) => {
  const cells = column.split("\t");
  return Object.fromEntries(FIELDS.map((f, i) => [f, cells[i] ?? ""]));
};
({ context, event }) => {
  if (event.type !== "found") return { updates: [] };
  const { kind, q, lang } = event.detail;
  const draft = (context.rows.delivery_draft ?? [])[0];
  if (kind === "reverse") {
    // Words the reader typed meanwhile are theirs: their own search carries
    // the position when they submit it.
    if (!draft || draft.pin_source !== "gps" || draft.pin_q !== q || draft.text !== "") return { updates: [] };
    const here = (context.rows.place_answer ?? []).find((a) => a.kind === "reverse" && a.q === q && a.lang === lang);
    if (!here || here.p0 === "") return { updates: [] };
    const place = placeOf(here.p0);
    const text = [place.line1, place.city].filter((part) => part !== "").join(", ");
    if (text === "") return { updates: [] };
    // The question carries the position after a tab, as delivery_submitted writes it.
    return { updates: [{ op: "patch", entity: "delivery_draft", id: "draft", row: { text, search_q: `${text}\t${q}` } }] };
  }
  if (kind !== "search") return { updates: [] };
  if (!draft || draft.search_q !== q) return { updates: [] };
  const answer = (context.rows.place_answer ?? []).find((a) => a.kind === "search" && a.q === q && a.lang === lang);
  if (!answer) throw new Error(`delivery_found: no place_answer row for search ${JSON.stringify(q)}`);
  const places = [answer.p0, answer.p1, answer.p2, answer.p3, answer.p4].filter((p) => p !== "").map(placeOf);
  const shown = new Set((context.rows.place_suggestion ?? []).map((s) => s.id));
  return {
    updates: SEARCH.flatMap((id, i) =>
      i < places.length
        ? [{ op: "put", entity: "place_suggestion", id, row: { ...places[i], q } }]
        : shown.has(id) ? [{ op: "delete", entity: "place_suggestion", id }] : []
    ),
  };
};
