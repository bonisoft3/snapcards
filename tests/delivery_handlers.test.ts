// The assertions below state a leaf's world and its event side by side; the
// leaf itself takes them as XState's one argument.
// deno-lint-ignore no-explicit-any
const positional = (leaf: any) => (state: any, event?: any, ...rest: any[]) => leaf({ context: state, event }, ...rest);
// The delivery handlers keep the reader's three statements independent: an
// offer moves only what it names, and an answer to a question no longer asked
// never reaches the screen.
const assertEquals = (actual: unknown, expected: unknown, what = "") => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};
const assertThrows = (fn: () => unknown) => {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error("expected a throw");
};

type Row = Record<string, string>;
type Update = { op: string; entity?: string; id: string; row?: Row };
type Handler = (state: { rows: Record<string, Row[]> }, event: Record<string, unknown>) => { updates: Update[] };
const load = async (name: string): Promise<Handler> =>
  positional((0, eval)(await Deno.readTextFile(new URL(`../shell/handlers/${name}.js`, import.meta.url))));
const found = await load("delivery_found");
const pin = await load("delivery_pin");
const accept = await load("delivery_accept");
const offers = await load("delivery_offers");

const draft = (over: Row = {}): Row => ({
  id: "draft", step: "search", text: "rua augusta 150", search_q: "rua augusta 150", address_q: "", pin_latitude: "", pin_longitude: "", pin_source: "", pin_q: "", near: "",
  recipient: "Marina", line1: "", line2: "Apto 72", city: "", region: "", postal_code: "", country: "",
  instructions: "Portaria", ...over,
});
const place = (over: Row = {}): Row => ({
  label: "Rua Augusta, 1508 - Consolação, São Paulo - SP, 01305-000", line1: "Rua Augusta, 1508", city: "São Paulo",
  region: "SP", postal_code: "01305-000", country: "BR", latitude: "-23.556100", longitude: "-46.659200", district: "Consolação", ...over,
});
const FIELDS = ["label", "line1", "city", "region", "postal_code", "country", "latitude", "longitude", "district"];
const answer = (kind: string, q: string, places: Row[]) => ({
  id: "a", kind, q, lang: "pt",
  ...Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`p${i}`, places[i] ? FIELDS.map((f) => places[i][f]).join("\t") : ""])),
});

// Regression: a delete of a row the store does not hold throws, and aborts
// the batch it rides in, which left the old list on screen.
Deno.test("a search answer becomes s0..s4, deleting only offers still shown", () => {
  const { updates } = found(
    { rows: { delivery_draft: [draft()], place_suggestion: [{ id: "s3", ...place() }], place_answer: [answer("search", "rua augusta 150", [place(), place({ line1: "Rua Augusta, 150" })])] } },
    { type: "found", detail: { kind: "search", q: "rua augusta 150", lang: "pt" } },
  );
  assertEquals(updates.map((u) => [u.op, u.id]), [["put", "s0"], ["put", "s1"], ["delete", "s3"]]);
  assertEquals(updates[1].row!.line1, "Rua Augusta, 150");
});

Deno.test("an answer to a search the reader has submitted past is dropped", () => {
  const { updates } = found(
    { rows: { delivery_draft: [draft({ search_q: "rua augusta 1508" })], place_answer: [answer("search", "rua augusta 150", [place()])] } },
    { type: "found", detail: { kind: "search", q: "rua augusta 150", lang: "pt" } },
  );
  assertEquals(updates, []);
});

Deno.test("an answer the memo does not hold is the app's bug", () => {
  assertThrows(() => found({ rows: { delivery_draft: [draft()], place_answer: [] } }, { type: "found", detail: { kind: "search", q: "rua augusta 150", lang: "pt" } }));
});

Deno.test("the pin's street is offered only where it is not the street in the fields", () => {
  const at = draft({ pin_latitude: "-23.556100", pin_longitude: "-46.659200", pin_q: "-23.556100,-46.659200" });
  const ask = (line1: string, shown: Row[] = []) =>
    offers(
      { rows: { delivery_draft: [{ ...at, line1 }], place_suggestion: shown, place_answer: [answer("reverse", at.pin_q, [place({ line1: "Rua Haddock Lobo, 595" })])] } },
      { type: "mutation" },
    ).updates.map((u) => [u.op, u.id]);
  assertEquals(ask("Rua Augusta, 1508"), [["put", "pin"]]);
  assertEquals(ask("rua  haddock lobo, 595"), []);
  // Seen live: the pin placed by a search reverse-geocodes to its street with
  // no number, which is no disagreement with the street the fields name.
  const unnumbered = offers(
    { rows: { delivery_draft: [{ ...at, line1: "Rua Augusta, 1508" }], place_answer: [answer("reverse", at.pin_q, [place({ line1: "Rua Augusta" })])] } },
    { type: "mutation" },
  ).updates;
  assertEquals(unnumbered, []);
  assertEquals(ask("rua haddock lobo, 595", [{ id: "pin", ...place() }]), [["delete", "pin"]]);
});

// Regression: the street-address offer was weighed only when its answer
// arrived, so a pin dragged away afterwards was never offered back.
Deno.test("the fields' street is offered whenever it lies more than 50 m from the pin, however late the pin moved", () => {
  const fields = { line1: "Rua Augusta, 1508", postal_code: "01305-000", city: "São Paulo", region: "SP", country: "BR" };
  const q = "Rua Augusta, 1508 01305-000 São Paulo SP BR";
  const ask = (lat: string) =>
    offers(
      { rows: { delivery_draft: [draft({ ...fields, address_q: q, pin_latitude: lat, pin_longitude: "-46.659200" })], place_answer: [answer("address", q, [place()])] } },
      { type: "mutation" },
    ).updates.map((u) => [u.op, u.id]);
  assertEquals(ask("-23.556300"), []);
  assertEquals(ask("-23.560100"), [["put", "address"]]);
});

Deno.test("an offer already shown as it should be is not written again", () => {
  const at = draft({ pin_latitude: "-23.556100", pin_longitude: "-46.659200", pin_q: "-23.556100,-46.659200", line1: "Rua Augusta, 1508" });
  const near = place({ line1: "Rua Haddock Lobo, 595" });
  const { updates } = offers({ rows: { delivery_draft: [at], place_suggestion: [{ id: "pin", ...near }], place_answer: [answer("reverse", at.pin_q, [near])] } }, { type: "mutation" });
  assertEquals(updates, []);
});

// Regression: "Use my location" as the first act patched a draft no keystroke
// had written yet, and the store refused it.
Deno.test("the reader's position starts the draft when it is their first act", () => {
  const { updates } = pin({ rows: { delivery_draft: [] } }, { type: "pin", detail: { latitude: "-23.1", longitude: "-46.2", source: "gps" } });
  assertEquals([updates[0].op, updates[0].row!.pin_q, updates[0].row!.text], ["put", "-23.1,-46.2", ""]);
});

Deno.test("a pin from the map or the reader's position moves the pin alone", () => {
  const { updates } = pin({ rows: { delivery_draft: [draft()] } }, { type: "pin", detail: { latitude: "-23.1", longitude: "-46.2", source: "gps" } });
  assertEquals(updates[0].row, { pin_latitude: "-23.1", pin_longitude: "-46.2", pin_source: "gps", pin_q: "-23.1,-46.2", step: "details", near: "-23.1,-46.2", text: "" });
});

Deno.test("a search suggestion places the pin, fills the postal fields, and completes the search box minimally", () => {
  const { updates } = accept({ rows: { delivery_draft: [draft()], place_suggestion: [{ id: "s0", ...place() }] } }, { type: "click", id: "s0" });
  const row = updates[0].row!;
  assertEquals(row.line1, "Rua Augusta, 1508");
  assertEquals(row.text, "Rua Augusta, 1508");
  assertEquals(row.pin_source, "search");
  for (const own of ["recipient", "line2", "instructions"]) assertEquals(own in row, false, own);
  assertEquals(updates[1], { op: "put", entity: "delivery_choice", id: "a0", row: { source: "search", label: place().label } });
  // Regression: the list was deleted, so the search button on the same words,
  // whose question is unchanged and asks nobody, showed nothing.
  assertEquals(updates.slice(2), []);
});

Deno.test("accepting a suggestion disambiguates the search box against sibling suggestions and covers a typed house number", () => {
  const s0 = { id: "s0", ...place({ line1: "Rua Augusta", district: "Consolação", city: "São Paulo" }) };
  const s1 = { id: "s1", ...place({ line1: "Rua Augusta", district: "Cerqueira César", city: "São Paulo" }) };
  const disambiguated = accept(
    { rows: { delivery_draft: [draft({ text: "rua augusta" })], place_suggestion: [s0, s1] } },
    { type: "click", id: "s0" },
  ).updates[0].row!;
  assertEquals(disambiguated.text, "Rua Augusta, Consolação");

  const withTypedNum = accept(
    { rows: { delivery_draft: [draft({ text: "rua augusta 1508" })], place_suggestion: [s0, s1] } },
    { type: "click", id: "s0" },
  ).updates[0].row!;
  assertEquals(withTypedNum.line1, "Rua Augusta, 1508");
  assertEquals(withTypedNum.text, "Rua Augusta, 1508");
});

Deno.test("the reader's position, once its street is known, is written in the search box and searched near them", () => {
  const here = draft({ text: "", search_q: "", pin_latitude: "-23.1", pin_longitude: "-46.2", pin_source: "gps", pin_q: "-23.1,-46.2" });
  const street = answer("reverse", "-23.1,-46.2", [place({ line1: "Rua Vergueiro, 3000", city: "São Paulo" })]);
  const arrived = found({ rows: { delivery_draft: [here], place_answer: [street] } }, { type: "found", detail: { kind: "reverse", q: "-23.1,-46.2", lang: "pt" } });
  assertEquals(arrived.updates, [{ op: "patch", entity: "delivery_draft", id: "draft", row: { text: "Rua Vergueiro, 3000, São Paulo", search_q: "Rua Vergueiro, 3000, São Paulo\t-23.1,-46.2" } }]);
  // The same position again is answered by the memo, which raises no `found`.
  const again = pin({ rows: { delivery_draft: [draft({ text: "" })], place_answer: [street] } }, { type: "pin", detail: { latitude: "-23.1", longitude: "-46.2", source: "gps" } });
  assertEquals([again.updates[0].row!.text, again.updates[0].row!.search_q], ["Rua Vergueiro, 3000, São Paulo", "Rua Vergueiro, 3000, São Paulo\t-23.1,-46.2"]);
  // Regression: words typed while the position was found were replaced by its
  // street, and a search for it went out instead of theirs.
  const typing = found({ rows: { delivery_draft: [{ ...here, text: "av paulista 10" }], place_answer: [street] } }, { type: "found", detail: { kind: "reverse", q: "-23.1,-46.2", lang: "pt" } });
  assertEquals(typing.updates, []);
  const typed = pin({ rows: { delivery_draft: [draft({ text: "av paulista 10" })], place_answer: [street] } }, { type: "pin", detail: { latitude: "-23.1", longitude: "-46.2", source: "gps" } });
  assertEquals([typed.updates[0].row!.text, typed.updates[0].row!.near], ["Rua Vergueiro, 3000, São Paulo", "-23.1,-46.2"]);
  // A pin the reader dropped by hand is only weighed, never searched.
  const dropped = found({ rows: { delivery_draft: [{ ...here, pin_source: "map" }], place_answer: [street] } }, { type: "found", detail: { kind: "reverse", q: "-23.1,-46.2", lang: "pt" } });
  assertEquals(dropped.updates, []);
});

// Regression: the toggle read the pin's source, so picking a suggestion
// turned the reader's position off and pressing it again turned it back on.
Deno.test("the reader's position stays on, wherever the pin goes, until they turn it off", () => {
  const on = pin({ rows: { delivery_draft: [draft()] } }, { type: "pin", detail: { latitude: "-23.1", longitude: "-46.2", source: "gps" } });
  assertEquals(on.updates[0].row!.near, "-23.1,-46.2");
  const picked = accept({ rows: { delivery_draft: [draft({ near: "-23.1,-46.2" })], place_suggestion: [{ id: "s0", ...place() }] } }, { type: "click", id: "s0" });
  assertEquals("near" in picked.updates[0].row!, false);
  const dropped = pin({ rows: { delivery_draft: [draft({ near: "-23.1,-46.2" })] } }, { type: "pin", detail: { latitude: "-23.3", longitude: "-46.4", source: "map" } });
  assertEquals("near" in dropped.updates[0].row!, false);
});

Deno.test("turning the position off forgets it, takes away a pin that was it, and leaves every word", () => {
  const off = { type: "pin", detail: { latitude: "", longitude: "", source: "" } };
  const atHome = pin({ rows: { delivery_draft: [draft({ near: "-23.1,-46.2", pin_source: "gps", pin_q: "-23.1,-46.2" })] } }, off);
  assertEquals(atHome.updates, [{ op: "patch", entity: "delivery_draft", id: "draft", row: { near: "", pin_latitude: "", pin_longitude: "", pin_source: "", pin_q: "" } }]);
  const uneditedGps = pin({
    rows: {
      delivery_draft: [draft({
        near: "-23.1,-46.2",
        pin_source: "gps",
        pin_q: "-23.1,-46.2",
        text: "Rua Vergueiro, 3000, São Paulo",
        search_q: "Rua Vergueiro, 3000, São Paulo\t-23.1,-46.2",
      })],
    },
  }, off);
  assertEquals(uneditedGps.updates, [{
    op: "patch",
    entity: "delivery_draft",
    id: "draft",
    row: { near: "", pin_latitude: "", pin_longitude: "", pin_source: "", pin_q: "", text: "", search_q: "", step: "details" },
  }]);
  const elsewhere = pin({ rows: { delivery_draft: [draft({ near: "-23.1,-46.2", pin_source: "search", pin_q: "-23.5,-46.6" })] } }, off);
  assertEquals(elsewhere.updates, [{ op: "patch", entity: "delivery_draft", id: "draft", row: { near: "" } }]);
});

Deno.test("a search asked with the position on carries it, after a tab", async () => {
  const submitted = positional((0, eval)(await Deno.readTextFile(new URL("../shell/handlers/delivery_submitted.js", import.meta.url)))) as (state: { items: Row[] }) => string;
  assertEquals(submitted({ items: [draft({ text: "rua augusta", near: "-23.1,-46.2" })] }), "rua augusta\t-23.1,-46.2");
  assertEquals(submitted({ items: [draft({ text: "rua augusta", near: "" })] }), "rua augusta");
});

Deno.test("the pin's offer fills the fields and leaves the pin; the fields' offer moves the pin and leaves the fields", () => {
  const rows = { delivery_draft: [draft()], place_suggestion: [{ id: "pin", ...place() }, { id: "address", ...place() }] };
  const fromPin = accept({ rows }, { type: "click", id: "pin" }).updates;
  assertEquals("pin_latitude" in fromPin[0].row!, false);
  assertEquals(fromPin[1].row!.source, "pin");
  const toAddress = accept({ rows }, { type: "click", id: "address" }).updates[0].row!;
  assertEquals("line1" in toAddress, false);
  assertEquals(toAddress.pin_q, "-23.556100,-46.659200");
});

Deno.test("applied offers are kept to the eight the order carries, oldest dropped", () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, source: "search", label: `old ${i}` }));
  const { updates } = accept({ rows: { delivery_draft: [draft()], delivery_choice: many.reverse(), place_suggestion: [{ id: "s0", ...place() }] } }, { type: "click", id: "s0" });
  const kept = updates.filter((u) => u.entity === "delivery_choice");
  assertEquals(kept.map((u) => u.id), ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7"]);
  assertEquals(kept[0].row!.label, "old 1");
  assertEquals(kept[7].row!.label, place().label);
});

Deno.test("an event that is not the handler's writes nothing", () => {
  assertEquals(found({ rows: {} }, { type: "click", id: "x" }).updates, []);
  assertEquals(offers({ rows: {} }, { type: "click", id: "x" }).updates, []);
  assertEquals(pin({ rows: {} }, { type: "click", id: "x" }).updates, []);
  assertEquals(accept({ rows: {} }, { type: "mutation" }).updates, []);
});

Deno.test("an offer writes only what it names: a place with no postcode leaves the reader's", () => {
  const row = accept(
    { rows: { delivery_draft: [draft({ postal_code: "01305-000" })], place_suggestion: [{ id: "s0", ...place({ postal_code: "" }) }] } },
    { type: "click", id: "s0" },
  ).updates[0].row!;
  assertEquals("postal_code" in row, false);
  assertEquals(row.line1, "Rua Augusta, 1508");
});

// Regression: a place with no bairro left the last street's, so a new street
// went out beside an old neighbourhood; changing from one street to another also
// clears the old apartment line.
Deno.test("a new street replaces the bairro, named or not, and clears a prior street's apartment", () => {
  const row = accept(
    { rows: { delivery_draft: [draft({ line1: "Rua Haddock Lobo, 595", line2: "Apto 72", district: "Consolação" })], place_suggestion: [{ id: "s0", ...place({ district: "" }) }] } },
    { type: "click", id: "s0" },
  ).updates[0].row!;
  assertEquals(row.district, "");
  assertEquals(row.line2, "");
});

Deno.test("a pin over a park, with no street, offers nothing to fill", () => {
  const at = draft({ pin_latitude: "-23.5", pin_longitude: "-46.6", pin_q: "-23.5,-46.6", line1: "Rua Augusta, 1508" });
  const { updates } = offers({ rows: { delivery_draft: [at], place_answer: [answer("reverse", at.pin_q, [place({ line1: "" })])] } }, { type: "mutation" });
  assertEquals(updates, []);
});

Deno.test("a search list answers its own search: a newer or cleared one takes it off the screen", () => {
  const shown = [{ id: "s0", ...place(), q: "rua augusta 150" }, { id: "s1", ...place(), q: "rua augusta 150" }];
  const ask = (search_q: string) =>
    offers({ rows: { delivery_draft: [draft({ search_q })], place_suggestion: shown } }, { type: "mutation" }).updates.map((u) => [u.op, u.id]);
  assertEquals(ask("rua augusta 150"), []);
  assertEquals(ask(""), [["delete", "s0"], ["delete", "s1"]]);
  assertEquals(ask("rua augusta 1508"), [["delete", "s0"], ["delete", "s1"]]);
  const put = found(
    { rows: { delivery_draft: [draft()], place_answer: [answer("search", "rua augusta 150", [place()])] } },
    { type: "found", detail: { kind: "search", q: "rua augusta 150", lang: "pt" } },
  ).updates[0];
  assertEquals(put.row!.q, "rua augusta 150");
});

Deno.test("the address question is the committed fields, the changing one read from its event", async () => {
  const addressQ = await load("delivery_address_q") as unknown as (s: unknown, e: unknown, p: unknown) => string;
  const row = { line1: "Rua Augusta, 1508", line2: "Apto 42", district: "Consolação", postal_code: "", city: "São Paulo", region: "SP", country: "" };
  assertEquals(addressQ({ items: [row] }, { value: "BR" }, { field: "country" }), "Rua Augusta, 1508 Consolação São Paulo SP BR");
  assertEquals(addressQ({ items: [row] }, { value: "Rua Augusta, 2000" }, { what: "line2" }), "Apto 42");
  assertEquals(addressQ({ items: [row] }, { value: "Rua Augusta, 2000" }, { what: "line2_stale" }), "");
  assertEquals(addressQ({ items: [row] }, { value: "Av. Atlântica, 1702" }, { what: "line2" }), "");
  assertEquals(addressQ({ items: [row] }, { value: "Av. Atlântica, 1702" }, { what: "line2_stale" }), "true");
  assertEquals(addressQ({ items: [row] }, { value: "Av. Atlântica, 1702" }, { what: "line2_ghost" }), "Apto 42");
  assertEquals(addressQ({ items: [{ ...row, line2_ghost: "Apto 42" }] }, { value: "Casa 3" }, { what: "line2_ghost_from_line2" }), "Casa 3");
  assertEquals(addressQ({ items: [row] }, { value: "ord-123" }, { what: "order_id" }), "ord-123");
  assertEquals(addressQ({ items: [{ ...row, order_id: "ord-123" }] }, {}, { what: "order_id" }), "ord-123");
  assertEquals(addressQ({ items: [{ ...row, order_id: "ord-123" }] }, { value: "" }, { what: "order_id" }), "");
});

Deno.test("staleness columns on the draft track street changes and pin refreshes across offers and pins", () => {
  const fullDraft = draft({
    line1: "Rua Augusta, 1508",
    line2: "Apto 42",
    pin_stale: "true",
    line2_stale: "",
    line2_ghost: "",
    search_stale: "true",
  });
  const accepted = accept(
    { rows: { delivery_draft: [fullDraft], place_suggestion: [{ id: "s0", ...place({ line1: "Av. Atlântica, 1702", city: "Rio de Janeiro", region: "RJ" }) }] } },
    { type: "click", id: "s0" },
  ).updates[0].row!;
  assertEquals(accepted.line2, "");
  assertEquals(accepted.line2_stale, "true");
  assertEquals(accepted.line2_ghost, "Apto 42");
  assertEquals(accepted.pin_stale, "false");
  assertEquals(accepted.search_stale, "");
  assertEquals(accepted.step, "details");

  const pinned = pin(
    { rows: { delivery_draft: [fullDraft] } },
    { type: "pin", detail: { latitude: "-22.9711", longitude: "-43.1822", source: "map" } },
  ).updates[0].row!;
  assertEquals(pinned.pin_stale, "false");
});

Deno.test("applying the pin's offer withdraws the question about the fields it replaced", async () => {
  const offer = { id: "pin", ...place({ line1: "Rua Haddock Lobo, 595" }) };
  const out = await accept(
    { rows: { place_suggestion: [offer], delivery_draft: [draft({ address_q: "rua augusta 1508", line1: "Rua Augusta, 1508" })], delivery_choice: [] } },
    { type: "click", id: "pin" },
  );
  const patch = out.updates.find((u) => u.op === "patch")!;
  if (patch.row!.line1 !== "Rua Haddock Lobo, 595") throw new Error("The offer did not fill the fields");
  if (patch.row!.address_q !== "") throw new Error("The old address question stayed, and its offer would come back");
  // The fold, given what the patch leaves, offers nothing about the old fields.
  const answer = { kind: "address", q: "rua augusta 1508", p0: FIELDS.map((f) => place()[f]).join("\t") };
  const fold = await offers(
    { rows: { delivery_draft: [draft({ ...patch.row!, pin_latitude: "-23.560000", pin_longitude: "-46.660000" })], place_answer: [answer], place_suggestion: [{ id: "address", ...place() }] } },
    { type: "mutation" },
  );
  if (!fold.updates.some((u) => u.op === "delete" && u.id === "address")) throw new Error("The stale address offer stayed on screen");
});
Deno.test("applying the address offer moves only the pin, and keeps the question", async () => {
  const out = await accept(
    { rows: { place_suggestion: [{ id: "address", ...place() }], delivery_draft: [draft({ address_q: "rua augusta 1508" })], delivery_choice: [] } },
    { type: "click", id: "address" },
  );
  const patch = out.updates.find((u) => u.op === "patch")!;
  if ("address_q" in patch.row! || "line1" in patch.row!) throw new Error("The address offer touched the fields' statement");
  if (patch.row!.pin_latitude !== "-23.556100") throw new Error("The pin did not move");
});
