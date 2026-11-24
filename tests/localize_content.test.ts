import assert from "node:assert/strict";

// The assertions below state a leaf's world and its event side by side; the
// leaf itself takes them as XState's one argument.
// deno-lint-ignore no-explicit-any
const positional = (leaf: any) => (state: any, event?: any, ...rest: any[]) => leaf({ context: state, event }, ...rest);

const localize = positional((0, eval)(await Deno.readTextFile(new URL("../shell/handlers/localize_content.js", import.meta.url))));
const translation = (lang: string, name: string, category: string) => ({ id: `deck:${lang}`, set_id: "deck", lang, name, category });
const word = (card: string, lang: string, word: string) => ({ id: `${card}:${lang}`, card_id: card, set_id: "deck", lang, word });
const fixture = () => ({
  card_set: [{ id: "deck", name: "North Pole Animals", category: "Ciência Natural", locale: "en-US", region: "US", count: 2, cover_emoji: "🐻‍❄️", owner: "u1" }],
  flashcard: [
    { id: "b", set_id: "deck", front: "Arctic fox", hint: "run-1", emoji: "🦊", back: "/images/b", txid: "11" },
    { id: "a", set_id: "deck", front: "Polar bear", hint: "run-1", emoji: "🐻‍❄️", back: "/images/a", txid: "12" },
  ],
  deck_translation: [
    translation("en", "North Pole Animals", "Natural Sciences"),
    translation("es", "Animales del Polo Norte", "Ciencias Naturales"),
    translation("he", "חיות הקוטב הצפוני", "מדעי הטבע"),
  ],
  card_translation: [
    word("a", "en", "Polar bear"), word("b", "en", "Arctic fox"),
    word("a", "es", "Oso polar"), word("b", "es", "Zorro ártico"),
    word("a", "he", "דוב קוטב"), word("b", "he", "שועל קוטב"),
  ],
  localized_card: [] as Record<string, unknown>[],
  localized_deck: [] as Record<string, unknown>[],
});
const apply = (rows: ReturnType<typeof fixture>, updates: Record<string, any>[]) => {
  const result = structuredClone(rows);
  for (const update of updates) {
    assert.ok(update.entity === "localized_card" || update.entity === "localized_deck");
    const table = result[update.entity as "localized_card" | "localized_deck"];
    const at = table.findIndex(row => row.id === update.id);
    if (update.op === "delete") table.splice(at, 1);
    else if (at < 0) table.push({ id: update.id, ...update.row });
    else table[at] = { id: update.id, ...update.row };
  }
  return result;
};

Deno.test("two readers derive independent labels without rewriting shared content or images", () => {
  const rows = fixture();
  const before = structuredClone(rows);
  const english = apply(rows, localize({ rows, locale: "en-US" }).updates);
  const spanish = apply(rows, localize({ rows, locale: "es" }).updates);
  assert.equal(english.localized_card[0].front, "Polar bear");
  assert.equal(spanish.localized_card[0].front, "Oso polar");
  assert.equal(english.localized_deck[0].name, "North Pole Animals");
  assert.equal(spanish.localized_deck[0].name, "Animales del Polo Norte");
  assert.equal(english.localized_deck[0].category, "Natural Sciences");
  assert.equal(english.localized_deck[0].original_name, "North Pole Animals");
  assert.equal(spanish.localized_card[0].original_front, "Polar bear");
  assert.deepEqual(rows, before);
  assert.ok(english.localized_card.every(row => !Object.hasOwn(row, "back") && !Object.hasOwn(row, "hint") && !Object.hasOwn(row, "txid")));
});

Deno.test("a screen's cards are the only ones it touches, and a screen with none needs none", () => {
  const rows = fixture();
  const other = { id: "elsewhere", set_id: "another-deck", front: "Otter", original_front: "Otter", emoji: "🦦" };
  // Every card the app has was rewritten on every wake of every screen, for a screen showing one deck.
  const living = [...rows.card_set, { ...rows.card_set[0], id: "another-deck" }];
  const updates = localize({ rows: { ...rows, card_set: living, localized_card: [other] }, locale: "en" }).updates;
  assert.equal(updates.some((u: Record<string, unknown>) => u.id === other.id), false);
  const { flashcard: _cards, card_translation: _words, localized_card: _labels, ...decksOnly } = rows;
  const decks = localize({ rows: decksOnly, locale: "en" }).updates;
  assert.ok(decks.length > 0 && decks.every((u: Record<string, unknown>) => u.entity === "localized_deck"));
});

Deno.test("an absent locale cache displays immutable originals even when shared labels were translated", () => {
  const rows = apply(fixture(), localize({ rows: fixture(), locale: "es" }).updates);
  const portuguese = apply(rows, localize({ rows, locale: "pt-BR" }).updates);
  assert.equal(portuguese.localized_card[0].front, "Polar bear");
  assert.equal(portuguese.localized_deck[0].name, "North Pole Animals");
  assert.equal(portuguese.localized_deck[0].category, "Ciência Natural");
});

Deno.test("SSR derives the same Hebrew cache as the hydrated tab", () => {
  const rows = fixture();
  const rendered = localize({ rows, locale: "he", ssr: true });
  assert.deepEqual(rendered, localize({ rows, locale: "he", ssr: false }));
  const hebrew = apply(rows, rendered.updates);
  assert.equal(hebrew.localized_deck[0].name, "חיות הקוטב הצפוני");
  assert.equal(hebrew.localized_deck[0].category, "מדעי הטבע");
  assert.equal(hebrew.localized_card[0].front, "דוב קוטב");
});

Deno.test("settled projections are silent and delete only rows absent from their source", () => {
  let rows = fixture();
  rows = apply(rows, localize({ rows, locale: "en" }).updates);
  assert.deepEqual(localize({ rows, locale: "en" }).updates, []);
  rows.flashcard = rows.flashcard.filter(card => card.id === "a");
  assert.deepEqual(localize({ rows, locale: "en" }).updates, [{ op: "delete", entity: "localized_card", id: "b" }]);
  rows.flashcard = [];
  rows.card_set = [];
  assert.deepEqual(localize({ rows, locale: "en" }).updates.map((u: any) => [u.op, u.entity, u.id]), [
    ["delete", "localized_card", "a"], ["delete", "localized_card", "b"], ["delete", "localized_deck", "deck"],
  ]);
});

Deno.test("uncached UGC and empty translated categories remain exact scalar content", () => {
  const rows = fixture();
  const content = "50%_.* Café: North";
  rows.flashcard[0].front = content;
  rows.deck_translation = [translation("en", "North Pole Animals", "")];
  rows.card_translation = [word("a", "en", "Polar bear")];
  const projected = apply(rows, localize({ rows, locale: "en" }).updates);
  assert.equal(projected.localized_card.find(card => card.id === "b")?.front, content);
  assert.equal(projected.localized_card.find(card => card.id === "b")?.original_front, content);
  assert.equal(projected.localized_deck[0].category, "");
});

Deno.test("missing declared reads fail instead of deleting a partial view", () => {
  assert.throws(() => localize({ rows: { card_set: [] }, locale: "en" }), /requires deck_translation/);
  assert.throws(() => localize({ rows: { card_set: [], deck_translation: [], localized_deck: [], localized_card: [] }, locale: "en" }), /requires flashcard/);
  assert.throws(() => localize({ rows: fixture() }), /requires a locale/);
});

Deno.test("each localized deck carries its owner for the reader's ownership probe", () => {
  const rows = fixture();
  assert.equal(apply(rows, localize({ rows, locale: "pt" }).updates).localized_deck[0].owner, "u1");
  rows.card_set[0] = { ...rows.card_set[0], owner: null as unknown as string };
  assert.equal(apply(rows, localize({ rows, locale: "pt" }).updates).localized_deck[0].owner, "");
});
