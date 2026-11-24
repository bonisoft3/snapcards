// delivery_offers — the fold that keeps the two reconciling offers true to the
// draft: `pin`, the street the memo found near the pin, and `address`, where
// the memo placed the postal fields. Each is offered only where the two
// statements disagree: the street near the pin is not the street in the
// fields, or the fields' street lies more than AGREE_METRES from the pin.
// Agreement needs no reconciling, and an answer not yet in the memo offers
// nothing. Woken by the draft and by the memo, so a pin moved after the
// address was found is weighed again.
const FIELDS = ["label", "line1", "city", "region", "postal_code", "country", "latitude", "longitude", "district"];
const placeOf = (column) => {
  const cells = column.split("\t");
  return Object.fromEntries(FIELDS.map((f, i) => [f, cells[i] ?? ""]));
};
const AGREE_METRES = 50;
const SEARCH = ["s0", "s1", "s2", "s3", "s4"];
const norm = (v) => v.toLowerCase().split(" ").filter((w) => w !== "").join(" ");
const metres = (a, b) => {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};
// The street near the pin often comes without a number ("Rua Augusta"), and
// then it agrees with any number on that street in the fields.
const sameStreet = (near, fields) => {
  const a = norm(near);
  const b = norm(fields);
  return a === b || (a !== "" && (b.startsWith(`${a},`) || b.startsWith(`${a} `)));
};
const firstPlace = (answers, kind, q) => {
  const answer = answers.find((a) => a.kind === kind && a.q === q);
  return answer && answer.p0 !== "" ? placeOf(answer.p0) : null;
};
const same = (a, b) => FIELDS.every((f) => a[f] === b[f]);
({ context, event }) => {
  if (event.type !== "mutation") return { updates: [] };
  const draft = (context.rows.delivery_draft ?? [])[0];
  if (!draft) return { updates: [] };
  const answers = context.rows.place_answer ?? [];
  const near = draft.pin_q === "" ? null : firstPlace(answers, "reverse", draft.pin_q);
  const placed = draft.address_q === "" ? null : firstPlace(answers, "address", draft.address_q);
  const want = {
    pin: near && near.line1 !== "" && !sameStreet(near.line1, draft.line1) ? near : null,
    address: placed && (draft.pin_latitude === "" || metres(
        { lat: Number(placed.latitude), lon: Number(placed.longitude) },
        { lat: Number(draft.pin_latitude), lon: Number(draft.pin_longitude) },
      ) > AGREE_METRES)
      ? placed
      : null,
  };
  const rows = context.rows.place_suggestion ?? [];
  const shown = Object.fromEntries(rows.map((s) => [s.id, s]));
  // A search list answers the search it was asked for; a newer or cleared one
  // takes it off the screen before its own answer arrives, and a cached answer
  // restores its suggestions on a memo hit when `found` is not raised again.
  const searchAnswer = draft.search_q === "" ? null : answers.find((a) => a.kind === "search" && a.q === draft.search_q);
  const searchUpdates = searchAnswer
    ? (() => {
      const places = [searchAnswer.p0, searchAnswer.p1, searchAnswer.p2, searchAnswer.p3, searchAnswer.p4]
        .filter((p) => p !== "")
        .map(placeOf);
      return SEARCH.flatMap((id, i) => {
        if (i < places.length) {
          const row = { ...places[i], q: draft.search_q };
          return shown[id] && shown[id].q === row.q && same(shown[id], row)
            ? []
            : [{ op: "put", entity: "place_suggestion", id, row }];
        }
        return shown[id] ? [{ op: "delete", entity: "place_suggestion", id }] : [];
      });
    })()
    : rows.filter((s) => SEARCH.includes(s.id) && s.q !== draft.search_q)
      .map((s) => ({ op: "delete", entity: "place_suggestion", id: s.id }));
  return {
    updates: [...searchUpdates, ...["pin", "address"].flatMap((id) => {
      if (want[id]) return shown[id] && same(shown[id], want[id]) ? [] : [{ op: "put", entity: "place_suggestion", id, row: want[id] }];
      return shown[id] ? [{ op: "delete", entity: "place_suggestion", id }] : [];
    })],
  };
};
