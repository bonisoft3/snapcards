import { deepStrictEqual } from "node:assert/strict";
import { machineAttribute, screenMarkup } from "./screen-markup.js";
// Unit tests for Snapcards Jessie handlers (Cortex local-handler folds over deck_press)
import { Statechart } from "@bonisoft3/omnishell/interpreter/statechart.js";

// The assertions below state a leaf's world and its event side by side; the
// leaf itself takes them as XState's one argument.
// deno-lint-ignore no-explicit-any
const positional = (leaf: any) => (state: any, event?: any, ...rest: any[]) => leaf({ context: state, event }, ...rest);
// A composed handler's module is handed its machines as the second argument.
// deno-lint-ignore no-explicit-any
const composed = (leaf: any) => (state: any, event?: any, machine?: any, machines?: any) => leaf({ context: state, event }, { machine, machines });

// The screens read a device's two draft slots by id, each under its own name.
const slotted = (drafts: any[]) => ({
  draft_cheap: drafts.filter((d) => String(d?.id ?? "").endsWith(":draft-cheap")),
  draft_heavy: drafts.filter((d) => String(d?.id ?? "").endsWith(":draft-heavy")),
});

(globalThis as unknown as { Statechart: typeof Statechart }).Statechart = Statechart;
(globalThis as unknown as { harden?: <T>(x: T) => T }).harden ??= (x) => x;

type Update = { absent?: Record<string, unknown>; op: string; entity?: string; id?: string; ifTxid?: string; row?: Record<string, unknown> };
type Reply = { updates: Update[] };
type Handler = (state: { items?: Record<string, unknown>[] }, event: Record<string, unknown>) => Reply;

// A Create the form's chart wrote, as its seat wakes to it.
const ASK = { type: "mutation", from: "generation-asks" };
// A Create mints its deck's id with a step the terminal answers, here with DECK.
const DECK = "00000001-0000-4002-8000-000300000004";
type Step = (...a: unknown[]) => Reply & { then?: { type: string; with?: unknown } };
// deno-lint-ignore no-explicit-any
const chained = (handler: Step, uuid = DECK): any => ((state: unknown, event: unknown, ...rest: unknown[]) => {
  const asked = event === ASK ? { ...(state as object), rows: { ...(state as { rows?: object }).rows, generation_ask: [{ id: "ask" }] } } : state;
  let reply = handler(asked, event, ...rest);
  if (reply.then?.type === "ask-translation" || reply.then?.type === "ensure-slots" || reply.then?.type === "settle-translation") return { updates: [...reply.updates, ...handler(asked, reply.then).updates] };
  if (reply.then?.type === "mint-deck") {
    reply = handler(asked, { type: "mint-deck", uuid, with: reply.then.with }, ...rest);
    const claim = reply.updates.find((u) => u.entity === "generation_ask");
    if (claim && reply.then) {
      const accepted = { ...(asked as object), rows: { ...(asked as { rows?: object }).rows, generation_ask: [claim.row] } };
      reply = handler(accepted, reply.then, ...rest);
      if (reply.then?.type === "complete-create") {
        reply = { updates: [...reply.updates, ...handler(accepted, reply.then, ...rest).updates] };
      }
    }
  }
  // These assertions describe inserted rows; recovery tests use the raw absent-only writes.
  return { ...reply, updates: reply.updates.map((u) => u.absent && ["card_set", "flashcard"].includes(u.entity ?? "") ? { ...u, row: { ...u.absent, ...u.row } } : u) };
});
// The route's seat and the translation's, as one wake reaches both.
const bothSeats = (handler: Step): any => (state: unknown, event: { type: string; from?: string }, ...rest: unknown[]) => {
  const fold = chained(handler);
  const card = fold(state, event, ...rest);
  if (event.type !== "mutation" || event.from !== undefined) return card;
  return { ...card, updates: [...card.updates, ...fold(state, { ...event, from: "translation-asks" }, ...rest).updates] };
};
const load = async (name: string): Promise<Handler> =>
  chained(positional((0, eval)(await Deno.readTextFile(new URL(`../shell/handlers/${name}.js`, import.meta.url)))));

// One device's key and the two text slots create_set mints with it.
const KEY = "0123456789abcdef";
const DEVICE = { id: "device", key: KEY };
// A deck's cached translation into one language: its DeckTranslation and a CardTranslation per word.
const cache = (setId: string, lang: string, name: string, category: string, words: Record<string, string>) => ({
  deck_translation: [{ id: `${setId}:${lang}`, set_id: setId, lang, name, category }],
  card_translation: Object.entries(words).map(([card_id, word]) => ({ id: `${card_id}:${lang}`, card_id, set_id: setId, lang, word })),
});
const asking = <T extends object>(form: T) => ({ ...form, status: "generating", set_id: "", run: "" });
// The reader, as their `me` row names them; a deck is theirs when its owner is.
const ME = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const FORM_KEYS = { id: "draft", topic: "", category: "", locale: "", region: "", card_count: 5, status: "idle", set_id: "", details: "", words: "", next: 0, audience_key: "diff_kids", audience: "", run: "" };
const formPut = (changes: Record<string, unknown>) => ({ op: "put", entity: "generation_form", id: "draft", row: { id: "draft", ...changes }, absent: FORM_KEYS });
const merged = (...caches: ReturnType<typeof cache>[]) => ({
  deck_translation: caches.flatMap((c) => c.deck_translation),
  card_translation: caches.flatMap((c) => c.card_translation),
});
const CHEAP = `${KEY}:draft-cheap`;
const HEAVY = `${KEY}:draft-heavy`;

const assertEquals = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

Deno.test("study synchronization cannot overwrite a library search", async () => {
  const select = await load("play_select");
  const deck = { id: "deck-1", count: 1, locale: "en" };
  const cards = [{ id: "a", set_id: deck.id, front: "Sun", emoji: "☀️", hint: "" }];
  {
    const session = { id: "session", set_id: deck.id, card_index: 0, library_query: "solar", hint: "", back: "" };
    for (const routed of [false, true]) {
      const result = select({ items: [session], locale: "en", rows: { deck_level: [], play_session: [session], card_set: [deck], flashcard: cards, ...(routed ? { route_deck: [deck], route_cards: cards } : {}) } } as any, { type: "mutation", visit: true });
      const patch = result.updates.find((u) => u.entity === "play_session");
      if (!patch) throw new Error("Expected study synchronization");
      const saved = { ...session, ...patch.row };
      assertEquals(saved.library_query, "solar");
    }
  }
});

Deno.test("deck entry replaces its address with the first ordered card only on the client", async () => {
  const select = await load("play_select");
  const deck = { id: "deck-1", count: 2, locale: "en" };
  const cards = [{ id: "a", set_id: deck.id, front: "Pikachu", emoji: "✨", hint: "" }, { id: "b", set_id: deck.id, front: "Charmander", emoji: "✨", hint: "" }];
  const session = { id: "session", set_id: deck.id, card_index: 1, front: "Charmander", status: "playing", finished: "", total: 2 };
  const state = { items: [session], params: { deck: deck.id }, locale: "en", rows: { deck_level: [], route_deck: [deck], route_cards: cards, card_set: [deck], flashcard: cards, play_session: [session] } };
  const result = select(state as any, { type: "mutation", from: "deck-entry" }) as Reply & { then: unknown };
  assertEquals(result.updates.find((u) => u.entity === "play_session")?.row?.front, "Pikachu");
  assertEquals(result.updates.find((u) => u.entity === "play_session")?.row?.card_index, 0);
  assertEquals(result.then, { type: "intent:navigate", with: { route: "card", params: { deck: deck.id, card: "Pikachu" }, replace: true } });
  const completed = select({ ...state, items: [{ ...session, finished: "yes" }] } as any, { type: "mutation", from: "deck-entry" });
  assertEquals(completed.updates.find((u) => u.entity === "play_session")?.row?.finished, "");
  assertEquals(completed.updates.find((u) => u.entity === "play_session")?.row?.card_index, 0);
  const ready = { ...session, card_index: 0, card_id: "a", original_front: "Pikachu", translation_failed_topic: "", front: "Pikachu", flipped: "no", mastered: 0, back: "", hint: "deck-1#lang=en", emoji: "✨" };
  assertEquals(select({ ...state, items: [ready] } as any, { type: "mutation", from: "deck-entry" }).updates.some((u) => u.entity === "play_session"), false);
  assertEquals(select({ ...state, ssr: true } as any, { type: "mutation", from: "deck-entry" }), { updates: [] });
  assertEquals(select({ ...state, rows: { ...state.rows, route_cards: [] } } as any, { type: "mutation", from: "deck-entry" }), { updates: [] });
});

Deno.test("generation retains ownership of earlier decks beyond five", async () => {
  const createSet = chained(composed((0, eval)(await Deno.readTextFile(new URL("../machines/create_set.js", import.meta.url)))));
  const previous = ["a", "b", "c", "d", "e"];
  const draft = { id: "draft", topic: "Topic F", category: "Fauna", locale: "pt-BR", region: "Brasil", card_count: 1, status: "generating" };
  const result = createSet({
    items: [draft],
    rows: { deck_level: [], generation_form: [draft], device: [DEVICE], print_config: [{ id: "press", set_id: previous.join("|") }] },
  }, ASK, { execute: () => ({ state: { model_tier: "cheap", generation_status: "generating" } }) });
  const lease = result.updates.find((u: Update) => u.entity === "print_config" && u.id === "press" && u.op === "put");
  assertEquals(String(lease?.row?.set_id).split("|").slice(1), previous);
});

Deno.test("translation settlement waits for its cards and preserves failed request topics", async () => {
  const createSet = chained(composed((0, eval)(await Deno.readTextFile(new URL("../machines/create_set.js", import.meta.url)))));
  const topic = 'set-x :: [TRANSLATE:pt] :: {"name":"Animals","category":"Fauna","cards":["Cat"]}';
  const draft = { id: "draft", topic: "Instrumentos Musicais", status: "idle", locale: "pt", region: "Brasil", category: "Música", card_count: 5 };
  const cheap = { id: CHEAP, topic, status: "done", txid: "42", category: '{"name":"Animais","category":"Fauna","cards":["Gato"]}' };
  const rows = { generation_form: [draft], device: [DEVICE], ...slotted([cheap]), flashcard: [], card_set: [], play_session: [], print_config: [] };
  const event = { type: "mutation", from: "generated-drafts-sync" };
  assertEquals(createSet({ items: [draft, cheap], rows }, event).updates, []);
  cheap.status = "failed";
  const failed = createSet({ items: [draft, cheap], rows }, event);
  assertEquals(failed.updates, []);
});

Deno.test("translation settlement observes every cache patch before releasing the draft", async () => {
  const create = chained(composed((0, eval)(await Deno.readTextFile(new URL("../machines/create_set.js", import.meta.url)))));
  const select = bothSeats(composed((0, eval)(await Deno.readTextFile(new URL("../machines/play_select.js", import.meta.url)))));
  const deck = { id: "set-x", name: "Animals", category: "Fauna", locale: "en", count: 2 };
  const cards = ["Cat", "Dog"].map((front, i) => ({ id: `c${i}`, set_id: deck.id, front, hint: "", txid: "99" }));
  const main = { id: "draft", topic: "Animals", status: "idle", card_count: 2 };
  const cheap = { id: CHEAP, topic: "", region: "", status: "idle", category: "", txid: "9007199254740993" };
  const rows = { card_set: [deck], flashcard: cards, generation_form: [main], device: [DEVICE], ...slotted([cheap]), play_session: [{ id: "session", set_id: deck.id, card_index: 0 }] };
  const choose = (r: any, lang = "pt") => select({ items: r.play_session, rows: r, locale: lang }, { type: "mutation" }, { execute: () => ({ state: { card_index: 0, total: 2, flipped: "no", mastered: 0, status: "playing" } }) }).updates.find((u: Update) => u.entity === "generation_draft");
  const initial = choose(rows);
  assertEquals(initial.ifTxid, cheap.txid);
  const request = initial.row;
  assertEquals(request.region, "xlat-pt :: tx-9007199254740993");
  assertEquals(choose(rows).row, request);
  assertEquals(choose({ ...rows, ...slotted([{ ...cheap, txid: undefined }])}), undefined);
  assertEquals(choose({ ...rows, ...slotted([{ ...cheap, $synced: false }])}), undefined);
  const generated = choose({ ...rows, ...slotted([{ ...cheap, status: "done", topic: "Animals :: Cat | Dog", region: "Brasil :: run-4", txid: "9007199254740994" }])}).row;
  assertEquals(generated.region, "xlat-pt :: tx-9007199254740994");
  const done = { ...cheap, ...request, status: "done", category: JSON.stringify({ name: "Animais", category: "Fauna", cards: ["Gato", "Cachorro"] }) };
  const pending = { ...rows, ...slotted([done])};
  const failedDraft = { ...cheap, ...request, status: "failed", txid: "9007199254740995" };
  const failedRows = { ...rows, ...slotted([failedDraft])};
  assertEquals(choose(failedRows), undefined);
  const retry = select({ items: rows.play_session, rows: failedRows, locale: "pt" }, { type: "mutation", visit: true }, { execute: () => ({ state: { card_index: 0, total: 2, flipped: "no", mastered: 0, status: "playing" } }) }).updates.find((u: Update) => u.entity === "generation_draft");
  assertEquals(retry.ifTxid, failedDraft.txid);
  assertEquals(select({ items: rows.play_session, rows: failedRows, locale: "pt", ssr: true }, { type: "mutation", visit: true }, { execute: () => ({ state: { card_index: 0, total: 2, flipped: "no", mastered: 0, status: "playing" } }) }).updates.some((u: Update) => u.entity === "generation_draft"), false);
  const settle = (r: any) => create({ items: [main], rows: r }, { type: "mutation", from: "generated-drafts-sync" }).updates as Update[];
  assertEquals(settle({ ...pending, flashcard: [cards[0]] }), []);
  const puts = settle(pending);
  assertEquals(puts.some(u => u.entity === "generation_draft"), false);
  // The translation is a cache beside the deck: nothing of the deck's own is written.
  assertEquals(puts.some(u => u.entity === "card_set" || u.entity === "flashcard"), false);
  assertEquals(puts.filter(u => u.op === "put").map(u => [u.entity, u.id]), [["deck_translation", "set-x:pt"], ["card_translation", "c0:pt"], ["card_translation", "c1:pt"]]);
  assertEquals(choose(pending, "es"), undefined);
  const rowsOf = (entity: string) => puts.filter(u => u.op === "put" && u.entity === entity).map(u => u.row);
  const partial = { ...pending, deck_translation: rowsOf("deck_translation"), card_translation: rowsOf("card_translation").slice(0, 1) };
  assertEquals(settle(partial).some(u => u.entity === "generation_draft"), false);
  const complete = { ...pending, deck_translation: rowsOf("deck_translation"), card_translation: rowsOf("card_translation") };
  const release = settle(complete).find(u => u.entity === "generation_draft")!;
  assertEquals(release.row, { status: "idle", category: "", details: "" });
  assertEquals(release.ifTxid, done.txid);
  assertEquals(settle({ ...complete, ...slotted([{ ...done, $synced: false }])}), []);
  assertEquals(settle({ ...complete, ...slotted([{ ...done, txid: undefined }])}), []);
  const idle = { ...done, ...release.row, txid: "9007199254740997" };
  // Draft sync can precede the card snapshot even after the cache was persisted.
  assertEquals(choose({ ...rows, ...slotted([idle])}).ifTxid, idle.txid);
  const cached = { ...complete, ...slotted([idle])};
  assertEquals(choose(cached), undefined);
  const next = choose(cached, "es").row;
  assertEquals(next.region, "xlat-es :: tx-9007199254740997");
  const afterOtherRequest = { ...cheap, ...next, region: "", status: "idle", txid: "9007199254741001" };
  assertEquals(choose({ ...cached, ...slotted([afterOtherRequest])}), undefined);
  const refreshed = choose({ ...rows, ...slotted([afterOtherRequest])}).row;
  assertEquals(refreshed.topic, request.topic);
  assertEquals(refreshed.region, "xlat-pt :: tx-9007199254741001");
});

Deno.test("late Spanish translation caches without replacing the active English card", async () => {
  const create = chained(composed((0, eval)(await Deno.readTextFile(new URL("../machines/create_set.js", import.meta.url)))));
  const deck = { id: "set-x", name: "Animals", category: "Nature", locale: "en", count: 1 };
  const card = { id: "c1", set_id: deck.id, front: "Capybara", back: "image.png", hint: "run-1", txid: "99" };
  const draft = { id: "draft", status: "idle" };
  const cheap = { id: CHEAP, status: "done", txid: "42", topic: 'set-x :: [TRANSLATE:es] :: {"name":"Animals","category":"Nature","cards":["Capybara"]}', category: '{"name":"Animales","category":"Naturaleza","cards":["Capibara"]}' };
  const updates = create({ items: [draft], rows: { deck_level: [], generation_form: [draft], device: [DEVICE], ...slotted([cheap]), flashcard: [card], card_set: [deck] } }, { type: "mutation", from: "generated-drafts-sync" }).updates;
  assertEquals(updates.some((u: Update) => u.entity === "card_set" || u.entity === "flashcard" || u.entity === "play_session"), false);
  assertEquals(updates.find((u: Update) => u.entity === "deck_translation")?.row, { id: "set-x:es", set_id: "set-x", lang: "es", name: "Animales", category: "Naturaleza" });
  assertEquals(updates.find((u: Update) => u.entity === "card_translation")?.row, { id: "c1:es", card_id: "c1", set_id: "set-x", lang: "es", word: "Capibara" });
});

// One whole read anywhere put every card in the app, from every deck, in each page's document and each browser.
Deno.test("cards are read a deck at a time on every screen", async () => {
  const facts = JSON.parse(await Deno.readTextFile(new URL("../.pronto/facts.json", import.meta.url)));
  for (const table of ["flashcard", "card_translation"]) {
    assertEquals(facts.read_mode.find((r: { table: string }) => r.table === table).mode, "lazy");
  }
  for (const screen of ["card", "cards", "deck", "explore", "generate", "print"]) {
    const html = await screenMarkup(screen);
    for (const tag of html.match(/<[a-z]+ [^>]*data-live="[^"]*"[^>]*>/g) ?? []) {
      const reads = tag.match(/data-reads="([^"]*)"/)?.[1].split(",") ?? [];
      assertEquals([screen, reads.includes("flashcard") || reads.includes("card_translation")], [screen, false]);
      if (tag.includes('data-live="flashcard"')) assertEquals([screen, tag.includes("data-filter=")], [screen, true]);
    }
  }
});

Deno.test("a card screen names no deck's card before it knows its own", async () => {
  // The seed and the default row pointed at the seed deck's capybara, which showed on every deck while a served page was adopted.
  const { seed } = JSON.parse(await Deno.readTextFile(new URL("../shell/shell.json", import.meta.url)));
  const seeded = seed.play_session[0];
  assertEquals([seeded.card_id, seeded.front, seeded.original_front, seeded.emoji], ["", "", "", ""]);
  const html = await screenMarkup("card");
  const row = JSON.parse(html.match(/data-live="play_session" data-filter="id=eq.session" data-empty-row='([^']*)'/)![1]);
  assertEquals([row.set_id, row.card_id, row.front, row.emoji], ["{param.deck}", "", "", ""]);
});

Deno.test("a finished translation is written behind the screen", async () => {
  // A word is a write, and a job that finished as a deck opened kept it hidden for up to eleven seconds.
  const raw = positional((0, eval)(await Deno.readTextFile(new URL("../shell/handlers/create_set.js", import.meta.url))));
  const form = { id: "draft", status: "idle" };
  const card = { id: "c1", set_id: "set-x", front: "Cat", txid: "9" };
  const cheap = { id: CHEAP, status: "done", txid: "42", topic: 'set-x :: [TRANSLATE:pt] :: {"name":"Pets","category":"","cards":["Cat"]}', category: '{"name":"Bichos","category":"","cards":["Gato"]}' };
  const rows = { deck_level: [], generation_form: [form], device: [DEVICE], ...slotted([cheap]), flashcard: [card], card_set: [{ id: "set-x", name: "Pets" }], card_translation: [], deck_translation: [] };
  const step = raw({ items: [form], rows }, { type: "mutation", from: "translation-settles" });
  assertEquals(step.updates, []);
  assertEquals(step.then.type, "settle-translation");
  assertEquals(step.then.delay, 1);
  assertEquals(raw({ items: [form], rows }, step.then).updates.some((u: Update) => u.entity === "card_translation"), true);
  const routes = JSON.parse(await Deno.readTextFile(new URL("../shell/shell.json", import.meta.url))).routes;
  // A screen that only redirects, kept, shows its loading line when it is returned to.
  assertEquals(routes.find((r: { screen: string }) => r.screen === "deck").keep, 0);
});

Deno.test("a translation is asked for behind the screen, from a seat of its own", async () => {
  const select = composed((0, eval)(await Deno.readTextFile(new URL("../machines/play_select.js", import.meta.url))));
  const deck = { id: "set-fr", name: "Animaux", category: "Nature", locale: "fr", count: 1 };
  const card = { id: "c1", set_id: deck.id, front: "Chat", hint: "", emoji: "🐈" };
  const session = { id: "session", set_id: deck.id, card_index: 0, front: "Chat", total: 1, status: "playing" };
  const rows = { deck_level: [], play_session: [session], route_deck: [deck], route_cards: [card], card_set: [deck], flashcard: [card], ...slotted([{ id: CHEAP, status: "idle", txid: "42" }]), device: [DEVICE] };
  const machine = { execute: () => ({ state: { card_index: 0, total: 1, flipped: "no", mastered: 0, status: "playing" } }) };
  const fold = (event: unknown) => select({ items: [session], locale: "en", params: { deck: deck.id, card: "Chat" }, rows }, event, machine);
  // A seat is held through its waits, so on the card's seat this write kept Back and the card column waiting for the server.
  const onCard = fold({ type: "mutation" });
  assertEquals(onCard.updates.some((u: Update) => u.entity === "generation_draft"), false);
  assertEquals(onCard.then, undefined);
  const asks = fold({ type: "mutation", from: "translation-asks" });
  // Its conditional write has to reach the server, and in the step it kept the screen hidden until it had.
  assertEquals(asks.updates, []);
  assertEquals(asks.then.type, "ask-translation");
  // Settling a job reads the cards of the deck it names, so the job has to name it.
  assertEquals(asks.then.with.update.row.details, deck.id);
  assertEquals(fold(asks.then).updates, [asks.then.with.update]);
  // The redirect screen leaves at once, and the card screen asks: both asking sent two writes, one bound to lose.
  const entry = select({ items: [session], locale: "en", params: { deck: deck.id }, rows }, { type: "mutation", from: "deck-entry" }, machine);
  assertEquals(entry.then.type, "intent:navigate");
  assertEquals(entry.updates.some((u: Update) => u.entity === "generation_draft"), false);
  for (const screen of ["card", "explore"]) {
    const html = await screenMarkup(screen);
    const readsOf = (mark: string) => html.match(new RegExp(`${mark}[^>]*?data-reads="([^"]*)"`))![1];
    // One handler over one world is one seat, whichever regions declare it.
    assertEquals(readsOf('id="translation-asks"') === readsOf('class="play-container"'), false);
  }
});

Deno.test("mixed original metadata requires an explicit translation even for the declared locale", async () => {
  const select = bothSeats(composed((0, eval)(await Deno.readTextFile(new URL("../machines/play_select.js", import.meta.url)))));
  const deck = { id: "set-x", name: "North Pole Animals", category: "Ciência Natural", locale: "he", count: 1 };
  const card = { id: "c1", set_id: deck.id, front: "beluga whale", hint: "" };
  const session = { id: "session", set_id: deck.id, card_index: 0, card_id: card.id, front: card.front, total: 1, status: "playing" };
  const cheap = { id: CHEAP, status: "idle", txid: "42" };
  const updates = select({ items: [session], locale: "he", params: { deck: deck.id, card: card.front }, rows: { deck_level: [], route_deck: [deck], route_cards: [card], card_set: [deck], flashcard: [card], device: [DEVICE], ...slotted([cheap])} }, { type: "mutation" }, { execute: () => ({ state: { card_index: 0, total: 1, status: "playing", flipped: "no", mastered: 0 } }) }).updates;
  const request = updates.find((u: Update) => u.entity === "generation_draft");
  assertEquals(request.row.topic.includes("[TRANSLATE:he]"), true);
});

Deno.test("an observed failure survives another deck job until this view is revisited", async () => {
  const select = bothSeats(composed((0, eval)(await Deno.readTextFile(new URL("../machines/play_select.js", import.meta.url)))));
  const deck = { id: "set-a", name: "Animals", category: "Nature", locale: "en", count: 1 };
  const card = { id: "c1", set_id: deck.id, front: "Cat", hint: "", emoji: "🐈" };
  const session = { id: "session", set_id: deck.id, card_index: 0, card_id: "c1", original_front: "Cat", front: "Cat", total: 1, status: "playing", hint: "set-a:cat#lang=he", flipped: "no", mastered: 0, back: "", emoji: "🐈", translation_failed_topic: "" };
  const machine = { execute: () => ({ state: { card_index: 0, total: 1, flipped: "no", mastered: 0, status: "playing" } }) };
  const fold = (s: any, draft: any, visit = false) => select({ items: [draft], locale: "he", params: { deck: deck.id, card: "Cat" }, rows: { deck_level: [], play_session: [s], route_deck: [deck], route_cards: [card], card_set: [deck], flashcard: [card], device: [DEVICE], ...slotted([draft])} }, { type: "mutation", visit }, machine);
  const failed = { id: CHEAP, status: "failed", topic: 'set-a :: [TRANSLATE:he] :: {}', txid: "41" };
  const observed = fold(session, failed);
  const saved = { ...session, ...observed.updates.find((u: Update) => u.entity === "play_session")?.row };
  assertEquals(saved.translation_failed_topic, "set-a|he");
  assertEquals(observed.updates.some((u: Update) => u.entity === "generation_draft"), false);
  const otherFinished = { ...failed, status: "idle", topic: 'set-b :: [TRANSLATE:es] :: {}', txid: "42" };
  assertEquals(fold(saved, otherFinished).updates.some((u: Update) => u.entity === "generation_draft"), false);
  const revisited = fold(saved, otherFinished, true);
  assertEquals(revisited.updates.find((u: Update) => u.entity === "play_session")?.row?.translation_failed_topic, "");
  assertEquals(revisited.updates.find((u: Update) => u.entity === "generation_draft")?.row?.locale, "he");
  const cached = select({ items: [otherFinished], locale: "he", params: { deck: deck.id, card: "Cat" }, rows: { deck_level: [], play_session: [saved], route_deck: [deck], route_cards: [card], card_set: [deck], flashcard: [card], device: [DEVICE], ...slotted([otherFinished]), ...cache(deck.id, "he", "חיות", "טבע", { c1: "חתול" }) } }, { type: "mutation" }, machine);
  assertEquals(cached.updates.find((u: Update) => u.entity === "play_session")?.row?.translation_failed_topic, "");
  assertEquals(cached.updates.some((u: Update) => u.entity === "generation_draft"), false);
  const otherFailed = { ...otherFinished, status: "failed" };
  assertEquals(fold(session, otherFailed).updates.find((u: Update) => u.entity === "generation_draft")?.row?.locale, "he");
});

Deno.test("a deck with a non-UI source language can request a UI translation", async () => {
  const select = bothSeats(composed((0, eval)(await Deno.readTextFile(new URL("../machines/play_select.js", import.meta.url)))));
  const deck = { id: "set-fr", name: "Animaux", category: "Nature", locale: "fr", count: 1 };
  const card = { id: "c1", set_id: deck.id, front: "Chat", hint: "", emoji: "🐈" };
  const session = { id: "session", set_id: deck.id, card_index: 0, front: "Chat", total: 1, status: "playing" };
  const draft = { id: CHEAP, status: "idle", txid: "42" };
  const result = select({ items: [session], locale: "en", params: { deck: deck.id, card: "Chat" }, rows: { deck_level: [], play_session: [session], route_deck: [deck], route_cards: [card], card_set: [deck], flashcard: [card], device: [DEVICE], ...slotted([draft])} }, { type: "mutation" }, { execute: () => ({ state: { card_index: 0, total: 1, flipped: "no", mastered: 0, status: "playing" } }) });
  assertEquals(result.updates.find((u: Update) => u.entity === "generation_draft")?.row?.locale, "en");
});

Deno.test("a freed translation queue wakes the active card route", async () => {
  const select = bothSeats(composed((0, eval)(await Deno.readTextFile(new URL("../machines/play_select.js", import.meta.url)))));
  const html = await screenMarkup("card");
  assertEquals(html.includes('data-live="generation_draft" data-filter="id=eq.{device.key}:draft-cheap" data-reads="play_session,card_set,localized_card,device,me,deck_translation" data-read-draft_cheap="generation_draft?id=eq.{device.key}:draft-cheap" data-read-draft_heavy="generation_draft?id=eq.{device.key}:draft-heavy" data-read-flashcard="flashcard?set_id=eq.{param.deck}" data-read-card_translation="card_translation?set_id=eq.{param.deck}" data-read-route_deck='), true);
  assertEquals(html.includes('data-live="flashcard" data-filter="set_id=eq.{param.deck}" data-reads="play_session,card_set,localized_card,device,me,deck_translation" data-read-draft_cheap="generation_draft?id=eq.{device.key}:draft-cheap" data-read-draft_heavy="generation_draft?id=eq.{device.key}:draft-heavy" data-read-flashcard="flashcard?set_id=eq.{param.deck}" data-read-card_translation="card_translation?set_id=eq.{param.deck}" data-read-route_deck='), true);
  const deck = { id: "set-he", name: "Animals", category: "Nature", locale: "en", count: 1 };
  const card = { id: "c1", set_id: deck.id, front: "Cat", hint: "", emoji: "🐈" };
  const session = { id: "session", set_id: deck.id, card_index: 0, card_id: "c1", original_front: "Cat", front: "Cat", total: 1, status: "playing" };
  const draft = { id: CHEAP, status: "idle", topic: "set-other :: [TRANSLATE:es] :: {}", txid: "43" };
  const result = select({ items: [draft], locale: "he", params: { deck: deck.id, card: "Cat" }, rows: { deck_level: [], play_session: [session], route_deck: [deck], route_cards: [card], card_set: [deck], flashcard: [card], device: [DEVICE], ...slotted([draft])} }, { type: "mutation" }, { execute: () => ({ state: { card_index: 0, total: 1, flipped: "no", mastered: 0, status: "playing" } }) });
  assertEquals(result.updates.find((u: Update) => u.entity === "generation_draft")?.row?.locale, "he");
});

Deno.test("translated direct card aliases retain card identity across locales", async () => {
  const select = bothSeats(composed((0, eval)(await Deno.readTextFile(new URL("../machines/play_select.js", import.meta.url)))));
  const deck = { id: "set-x", name: "Animals", category: "Nature", locale: "pt", count: 2 };
  const cards = [
    { id: "a", set_id: deck.id, front: "Gato", hint: "", emoji: "🐈" },
    { id: "b", set_id: deck.id, front: "Capivara", hint: "", emoji: "🦫" },
  ];
  const translations = merged(
    cache(deck.id, "en", "Animals", "Nature", { a: "Cat", b: "Capybara" }),
    cache(deck.id, "es", "Animales", "Naturaleza", { a: "Gato", b: "Capibara" }),
    cache(deck.id, "he", "חיות", "טבע", { a: "חתול", b: "קפיברה" }),
  );
  const session = { id: "session", set_id: deck.id, card_index: 0, card_id: "a", original_front: "Gato", front: "Cat", total: 2, status: "playing" };
  const machine = { execute: ({ event }: any) => ({ state: { card_index: event?.payload?.card_index ?? 0, total: 2, flipped: "no", mastered: 0, status: "playing" } }) };
  for (const locale of ["es", "en", "he"]) {
    const result = select({ items: [session], locale, params: { deck: deck.id, card: "Capybara" }, rows: { deck_level: [], route_deck: [deck], route_cards: cards, card_set: [deck], flashcard: cards, play_session: [session], ...translations } }, { type: "mutation" }, machine);
    const patch = result.updates.find((u: Update) => u.entity === "play_session");
    assertEquals(patch.row.card_id, "b");
    assertEquals(patch.row.original_front, "Capivara");
    assertEquals(patch.row.front, { es: "Capibara", en: "Capybara", he: "קפיברה" }[locale]);
  }
});

Deno.test("direct card routes resolve exact original words after translation metadata is cached", async () => {
  const select = bothSeats(composed((0, eval)(await Deno.readTextFile(new URL("../machines/play_select.js", import.meta.url)))));
  const deck = { id: "bones", name: "Bones", count: 3 };
  const cards = [
    { id: "c1", set_id: deck.id, front: "rib", hint: "", emoji: "🦴" },
    { id: "c2", set_id: deck.id, front: "rib cage", hint: "", emoji: "🦴" },
    { id: "c3", set_id: deck.id, front: "50%_.* (test), Café", hint: "", emoji: "🦴" },
  ];
  const session = { id: "session", set_id: "default", front: "capybara", card_index: 0, total: 20, hint: "" };
  const machine = { execute: ({ event }: any) => ({ state: { ...event?.payload, flipped: "no", mastered: 0, status: "playing" } }) };
  const translations = merged(
    cache(deck.id, "pt", "Ossos", "", { c1: "costela", c2: "caixa torácica", c3: "símbolos" }),
    cache(deck.id, "es", "Huesos", "", { c2: "caja torácica" }),
  );
  const state = { items: [session], ssr: true, rows: { deck_level: [], play_session: [session], route_deck: [deck], route_cards: cards, card_set: [deck], flashcard: cards, ...translations } };
  const route = (card: string, rows = state.rows) => select({ ...state, rows, params: { deck: deck.id, card } }, { type: "mutation" }, machine).updates;
  const selected = route("rib cage").find((u: Update) => u.entity === "play_session");
  assertEquals(selected.row.set_id, deck.id);
  assertEquals(selected.row.card_index, 1);
  // Rendered on the server, with no reader's language: the deck's own word.
  assertEquals(selected.row.front, "rib cage");
  assertEquals(selected.row.total, 3);
  assertEquals(route("50%_.* (test), Café").find((u: Update) => u.entity === "play_session").row.card_index, 2);
  assertEquals(route("caixa torácica").find((u: Update) => u.entity === "play_session").row.card_index, 1);
  assertEquals(route("rib ca"), []);
  assertEquals(route("rib cage", { ...state.rows, route_cards: [] }), []);
});

Deno.test("play_select activates session with chosen deck", async () => {
  const playSelect = await load("play_select");
  const items = [
    { id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d", count: 5 },
    { id: "0c1baad8-3f5b-d497-a8af-2f31a5076a0a", count: 8 }
  ];
  const rows = {
    flashcard: [
      { id: "0388119e-7f06-4c15-a453-a9e1b23f2e6b", set_id: "0c1baad8-3f5b-d497-a8af-2f31a5076a0a", front: "giant anteater", emoji: "🐾", hint: "", back: "" }
    ]
  };
  // When event has id directly
  const res = playSelect({ items, rows } as any, { type: "click", id: "0c1baad8-3f5b-d497-a8af-2f31a5076a0a" });
  assertEquals(res.updates.filter((u: Update) => u.entity !== "next_picture"), [
    {
      op: "patch",
      entity: "play_session",
      id: "session",
      row: {
        set_id: "0c1baad8-3f5b-d497-a8af-2f31a5076a0a",
        card_index: 0,
        flipped: "no",
        mastered: 0,
        total: 8,
        finished: "",
        card_id: "0388119e-7f06-4c15-a453-a9e1b23f2e6b",
        original_front: "giant anteater",
        front: "giant anteater",
        back: "",
        hint: "",
        emoji: "🐾"
      },
    },
  ]);
});

Deno.test("play_next and play_prev traverse cards in deck", async () => {
  const playNext = await load("play_next");
  const playPrev = await load("play_prev");
  const rows = {
    flashcard: [
      { id: "c1", set_id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d", front: "capybara", emoji: "🦫", hint: "", back: "" },
      { id: "c2", set_id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d", front: "giant river otter", emoji: "🦦", hint: "", back: "" },
      { id: "c3", set_id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d", front: "harpy eagle", emoji: "🦅", hint: "", back: "" }
    ]
  };

  const s0 = [{ id: "session", set_id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d", card_index: 0, total: 3, status: "playing" }];
  const resNext = playNext({ items: s0, rows } as any, { type: "click" });
  assertEquals(resNext.updates[0]?.row?.card_index, 1);
  assertEquals(resNext.updates[0]?.row?.front, "giant river otter");
  assertEquals(resNext.updates[0]?.row?.emoji, "🦦");

  const s1 = [{ id: "session", set_id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d", card_index: 1, total: 3, status: "playing" }];
  const resPrev = playPrev({ items: s1, rows } as any, { type: "click" });
  assertEquals(resPrev.updates[0]?.row?.card_index, 0);
  assertEquals(resPrev.updates[0]?.row?.front, "capybara");
  assertEquals(resPrev.updates[0]?.row?.emoji, "🦫");

  // Last card finishes session
  const sLast = [{ id: "session", set_id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d", card_index: 2, total: 3, status: "playing" }];
  const resComplete = playNext({ items: sLast, rows } as any, { type: "click" });
  assertEquals(resComplete.updates, [{ op: "patch", id: "session", row: { finished: "yes" } }]);
});

Deno.test("card navigation follows the rail order and names each moved card", async () => {
  const next = await load("play_next");
  const prev = await load("play_prev");
  const deck = "2de92aa5-10ce-1167-feb2-40cf161917f2";
  const cards = [
    { id: "3829f39c-e19b-4703-ad81-55394fac7195", set_id: deck, front: "Pikachu", hint: "", back: "", emoji: "✨" },
    { id: "3a6ad7b7-2410-46d3-b931-70c6d8f78473", set_id: deck, front: "Charmander", hint: "", back: "", emoji: "✨" },
  ];
  const state = { items: [{ id: "session", set_id: deck, card_index: 0, total: 2, status: "playing" }], rows: { deck_level: [], route_cards: cards, flashcard: cards }, params: { deck, card: "Pikachu" } };
  assertEquals(prev(state as any, { type: "click" }).updates, []);
  const moved = next(state as any, { type: "click" }) as Reply & { then: unknown };
  assertEquals(moved.updates[0].row?.front, "Charmander");
  assertEquals(moved.then, { type: "intent:navigate", with: { route: "card", params: { deck, card: "Charmander" } } });
  const last = { ...state, items: [{ ...state.items[0], card_index: 1, front: "Charmander" }], params: { deck, card: "Charmander" } };
  assertEquals(next(last as any, { type: "click" }).updates, [{ op: "patch", id: "session", row: { finished: "yes" } }]);
  const back = prev(last as any, { type: "click" }) as Reply & { then: unknown };
  assertEquals(back.then, { type: "intent:navigate", with: { route: "card", params: { deck, card: "Pikachu" } } });
});

Deno.test("play_master records mastery and advances card", async () => {
  const playMaster = await load("play_master");
  const rows = {
    flashcard: [
      { id: "c1", set_id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d", front: "capybara", emoji: "🦫", hint: "", back: "" },
      { id: "c2", set_id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d", front: "giant river otter", emoji: "🦦", hint: "", back: "" },
      { id: "c3", set_id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d", front: "harpy eagle", emoji: "🦅", hint: "", back: "" }
    ]
  };
  const s = [{ id: "session", set_id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d", card_index: 0, mastered: 1, total: 3, status: "playing" }];
  const res = playMaster({ items: s, rows } as any, { type: "click" });
  assertEquals(res.updates[0]?.row?.mastered, 2);
  assertEquals(res.updates[0]?.row?.card_index, 1);
  assertEquals(res.updates[0]?.row?.front, "giant river otter");
});

Deno.test("play_restart resets session state", async () => {
  const playRestart = await load("play_restart");
  const rows = {
    flashcard: [
      { id: "c1", set_id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d", front: "capybara", emoji: "🦫", hint: "", back: "" }
    ]
  };
  const s = [{ id: "session", set_id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d", card_index: 3, mastered: 3, status: "completed" }];
  const res = playRestart({ items: s, rows } as any, { type: "click" });
  assertEquals(res.updates.filter((u: Update) => u.entity !== "next_picture"), [
    {
      op: "patch",
      id: "session",
      row: {
        card_index: 0,
        flipped: "no",
        mastered: 0,
        card_id: "c1",
        original_front: "capybara",
        front: "capybara",
        back: "",
        hint: "",
        emoji: "🦫"
      }
    },
  ]);
});

Deno.test("create_set kills table-based preview in idle and dispatches parallel Airlock models on #btn-create", async () => {
  const createSet = await load("create_set");
  const draftState = {
    items: [
      { id: "draft", topic: "Instrumentos Musicais", category: "Music", locale: "pt-BR", region: "Brasil", card_count: 5, status: "idle" }
    ],
    rows: { deck_level: [], device: [DEVICE] }
  };

  // 1. A Create writes the deck. The cheap text waits for the deck's cards to reach the server,
  //    since its outcome fans out to them.
  const resDraft = createSet({ ...draftState, items: [draftState.items[0]] }, ASK);
  assertEquals(resDraft.updates.at(-1), { op: "delete", entity: "generation_ask", id: "ask" });
  const draftUpdates = resDraft.updates.filter((u: Update) => u.entity === "generation_form");
  assertEquals(draftUpdates, [formPut({ topic: "Instrumentos Musicais", details: "", set_id: DECK, run: "run-1", category: "Music", locale: "pt-BR", region: "Brasil", card_count: 5, words: "complete", next: 2 })]);
  const cardSetUpdate = resDraft.updates.find((u: Update) => u.entity === "card_set");
  assertEquals(cardSetUpdate?.op, "put");
  assertEquals(cardSetUpdate?.id, DECK);
  assertEquals(cardSetUpdate?.row?.count, 5);

  const flashcards = resDraft.updates.filter((u: Update) => u.entity === "flashcard");
  assertEquals(flashcards.length, 5);
  assertEquals(flashcards[0].id, `card-${DECK}-1`);

  const playSessionUpdate = resDraft.updates.find((u: Update) => u.entity === "play_session");
  assertEquals(playSessionUpdate?.row?.set_id, DECK);

  const printConfigUpdate = resDraft.updates.find((u: Update) => u.entity === "print_config");
  assertEquals(printConfigUpdate?.row?.set_id, DECK);

  // 2. Quick pick click ONLY updates draft fields in "idle" state (no table-based preview cards emitted)
  const resQuickPick = createSet(draftState, {
    type: "click",
    from: "quick-animals",
    target: { dataset: { topic: "Animais Brasileiros", category: "Fauna" } }
  });
  assertEquals(resQuickPick.updates, [
    formPut({ topic: "Animais Brasileiros", category: "Fauna", locale: "pt-BR", region: "Brasil" })
  ]);

  // 3. Language quick pick updates draft locale/region while (zero fake cards emitted)
  const resHebrew = createSet(draftState, {
    type: "click",
    from: "draft-loc-he",
    target: { dataset: { locale: "he-IL", region: "ישראל" } }
  });
  assertEquals(resHebrew.updates.length, 1);
  assertEquals(resHebrew.updates[0].row?.locale, "he-IL");

  // 4. Non-click returns empty updates
  const resIgnore = createSet(draftState, { type: "keydown" });
  assertEquals(resIgnore.updates, []);

  // 6. Custom topic ("revistas em quadrinhos") + clicking Português (#draft-loc-pt) updates draft in idle
  const customDraftState = {
    items: [
      { id: "draft", topic: "revistas em quadrinhos", category: "", locale: "pt-BR", region: "Brasil", card_count: 5, status: "idle" }
    ]
  };
  const resLocWithCustomTopic = createSet(customDraftState, {
    type: "click",
    from: "draft-loc-pt"
  });
  // The reduce reads the form before a topic typed meanwhile lands; a pill that
  // restated the topic it read clobbered that edit, and Create then named the
  // deck after the topic the reader had replaced.
  assertEquals(resLocWithCustomTopic.updates, [formPut({ locale: "Português", region: "São Paulo, Brasil" })]);

  // 6b. Picking an extra country (#draft-loc-fr) from the #draft-loc-menu popover updates locale & city/country region while preserving custom topic
  const resMoreLoc = createSet(customDraftState, {
    type: "click",
    from: "draft-loc-fr"
  } as any);
  assertEquals(resMoreLoc.updates, [
    formPut({ locale: "Français", region: "Paris, França" })
  ]);

  // 6c. Pressing Tab on an empty #category-input auto-completes the grayed default from browser_draft
  const resTabCat = createSet(
    {
      rows: { deck_level: [],
        generation_form: [
          { id: "draft", topic: "planetas e estrelas", category: "", locale: "Português", region: "São Paulo, Brasil", card_count: 5, status: "idle" }
        ],
        browser_draft: [
          { id: "bd-1", topic: "planetas e estrelas", locale: "Português", status: "idle", w0: "Astronomia", w1: "Crianças (6–10)", w2: "Português", w3: "São Paulo, Brasil", w4: "Animais Brasileiros" }
        ]
      }
    } as any,
    {
      type: "keydown",
      key: "Tab",
      from: "category-input",
      value: ""
    } as any
  );
  assertEquals(resTabCat.updates, [
    formPut({ category: "Astronomia" })
  ]);
});

Deno.test("play_select selects non-Latin (Hebrew and Chinese) cards without empty-slug collision", async () => {
  const playSelect = await load("play_select");
  const heDeck = [
    { id: "card-he-capybara", set_id: "set-animals-he", front: "קפיבארה", back: "", hint: "", emoji: "🦫" },
    { id: "card-he-jaguar", set_id: "set-animals-he", front: "יגואר", back: "", hint: "", emoji: "🐆" }
  ];
  const resHe = playSelect(
    {
      items: [{ id: "set-animals-he", count: 2 }],
      rows: { deck_level: [], flashcard: heDeck, card_set: [{ id: "set-animals-he", count: 2 }] }
    } as any,
    { type: "click", id: "set-animals-he", name: "יגואר" }
  );
  assertEquals(resHe.updates[0]?.row?.card_index, 1);
  assertEquals(resHe.updates[0]?.row?.front, "יגואר");

  const zhDeck = [
    { id: "card-zh-capybara", set_id: "set-animals-zh", front: "水豚", back: "", hint: "", emoji: "🦫" },
    { id: "card-zh-jaguar", set_id: "set-animals-zh", front: "美洲豹", back: "", hint: "", emoji: "🐆" }
  ];
  const resZh = playSelect(
    {
      items: [{ id: "set-animals-zh", count: 2 }],
      rows: { deck_level: [], flashcard: zhDeck, card_set: [{ id: "set-animals-zh", count: 2 }] }
    } as any,
    { type: "click", id: "set-animals-zh", name: "美洲豹" }
  );
  assertEquals(resZh.updates[0]?.row?.card_index, 1);
  assertEquals(resZh.updates[0]?.row?.front, "美洲豹");
});

Deno.test("play_restart preserves route hint so deep-linked /explore/:deck/:card does not snap back", async () => {
  const playRestart = await load("play_restart");
  const routeCards = [
    { id: "c1", set_id: "deck-1", front: "capybara", back: "", hint: "", emoji: "🦫" },
    { id: "c2", set_id: "deck-1", front: "puma", back: "", hint: "", emoji: "🐆" }
  ];
  const res = playRestart(
    {
      items: [{ id: "session", set_id: "deck-1", card_index: 1, hint: "deck-1:puma", status: "playing" }],
      rows: { deck_level: [], route_cards: routeCards }
    } as any,
    { type: "click" }
  );
  assertEquals(res.updates[0]?.row?.card_index, 0);
  assertEquals(res.updates[0]?.row?.front, "capybara");
  assertEquals(res.updates[0]?.row?.hint, "deck-1:puma");
});

Deno.test("shell configuration declares all 4 primary routes with valid assets", async () => {
  const shellRaw = await Deno.readTextFile(new URL("../shell/shell.json", import.meta.url));
  const shell = JSON.parse(shellRaw);
  // The library's route takes its shelf as an optional segment: /, /mine, /gallery.
  const expectedRoutes = ["/:shelf?", "/generate", "/explore", "/print"];
  const registered = shell.routes.map((r: { path: string }) => r.path);
  for (const route of expectedRoutes) {
    if (!registered.includes(route)) {
      throw new Error(`missing route registration for ${route} in shell.json`);
    }
  }
});

Deno.test("all message expressions in screen templates resolve in pt, es, en, he, and zh catalogues", async () => {
  const locales = ["pt", "es", "en", "he", "zh"] as const;
  const catalogues: Record<string, Record<string, string>> = {};
  for (const loc of locales) {
    catalogues[loc] = JSON.parse(await Deno.readTextFile(new URL(`../messages/${loc}.json`, import.meta.url)));
  }

  const screens = ["cards", "explore", "deck", "card", "generate", "print"];
  const requiredKeys = ["keep_decks_offer", "keep_decks_action", "chrome_signin", "lang_pt", "lang_es", "lang_en", "lang_he", "lang_zh"];
  for (const k of requiredKeys) {
    for (const loc of locales) {
      if (!(k in catalogues[loc])) throw new Error(`Missing required key "${k}" in messages/${loc}.json`);
    }
  }

  for (const s of screens) {
    const html = await screenMarkup(s);
    const matches = html.matchAll(/\{msg\.([a-zA-Z0-9_]+)\}/g);
    for (const m of matches) {
      const key = m[1];
      for (const loc of locales) {
        if (!(key in catalogues[loc])) {
          throw new Error(`Screen "${s}.html" references {msg.${key}} which is missing in messages/${loc}.json`);
        }
      }
    }
  }
});

Deno.test("printable cards in print.css and generate.css enforce ink-saving white backgrounds even in dark mode", async () => {
  const printCss = await Deno.readTextFile(new URL("../shell/screens/print.css", import.meta.url));
  if (printCss.includes("background-color: var(--surface) !important;")) {
    throw new Error("print.css must not use var(--surface) on printable card illustrations (turns black in dark mode)");
  }
  if (!printCss.includes("color-scheme: light !important;")) {
    throw new Error("print.css must enforce color-scheme: light on .sheet-paper");
  }
});

Deno.test("every seeded CardSet in seed.cue has seeded flashcards with embedded WebP illustrations and single centralized cover CSS", async () => {
  const cue = await Deno.readTextFile(new URL("../seed.cue", import.meta.url));
  const cardsCss = await Deno.readTextFile(new URL("../shell/screens/cards.css", import.meta.url));

  const csMatch = cue.match(/CardSet:\s*\{[\s\S]*?seed:\s*\[([\s\S]*?)\]\s*\}/);
  if (!csMatch) throw new Error("Could not find CardSet.seed in seed.cue");
  const seededIds = [...csMatch[1].matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]);
  assertEquals(seededIds.length, 8);

  for (const id of seededIds) {
    if (!cue.includes(`set_id: "${id}"`)) {
      throw new Error(`Seeded deck "${id}" has no flashcards in seed.cue`);
    }
  }

  assertEquals(cardsCss.includes('.cover-illustration-img:first-of-type:not([src=""])'), true);
  // A cover listed every card of its deck and CSS showed the first, yet a browser fetches a
  // hidden img: 201 decks of pictures by URL rendered 1680 of them on each visit home. The
  // cover is the deck's one deck_stats row, the read its favourite counts already make.
  const cardsHtml = await screenMarkup("cards");
  assertEquals(cardsHtml.includes('class="cover-illustration-list" data-live="deck_stats" data-filter="deck_id=eq.{id}"'), true);
  // Auto sizing clears Chromium's selected source when the retained library is hidden.
  assertEquals(cardsHtml.includes('<img class="cover-illustration-img" data-image-src="{cover}" sizes="(max-width: 720px) 100vw, 33vw" alt="" loading="lazy" />'), true);
  for (const s of ["explore", "card"]) {
    const css = await Deno.readTextFile(new URL(`../shell/screens/${s}.css`, import.meta.url));
    if (!css.includes('.card-illustration-img:first-of-type:not([src=""])')) {
      throw new Error(`shell/screens/${s}.css is missing single-centralized card rule :first-of-type:not([src=""])`);
    }
  }
});

// The chrome lived in a copy per screen, so a screen without one (the About page) drew a bare
// nav in the browser's colours; every screen now wears the one shared sheet.
// The sheet once hid the nav's passkey and provider ways because a modal of the app's own drew them.
Deno.test("every screen wears the shared chrome, which leaves the nav's ways in visible", async () => {
  const shell = JSON.parse(await Deno.readTextFile(new URL("../shell/shell.json", import.meta.url)));
  for (const route of shell.routes) assertEquals(route.files.shared.includes("shell/shared/chrome.css"), true);
  const css = await Deno.readTextFile(new URL("../shell/shared/chrome.css", import.meta.url));
  for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (/\.shell-(signin|passkey|provider|register)\b/.test(rule[1]) && /display:\s*none/.test(rule[2])) {
      throw new Error(`chrome.css hides the nav's sign-in: ${rule[1].trim()}`);
    }
  }
});

Deno.test("play_select resolves a direct card route after its deck rows arrive", async () => {
  const playSelect = await load("play_select");
  const session = [{ id: "session", set_id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d", card_index: 6, total: 20, front: "capybara", hint: "69618be6-9206-f9c7-59eb-b5e4b072cf3d" }];
  const routeDeck = [{ id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d", name: "South American Giants", count: 20 }];
  const routeCards = [
    { id: "05d3ade0-0000-4000-8000-000000000001", set_id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d", front: "titan arum", back: "", hint: "", emoji: "✨" },
    { id: "4106cc67-b152-415d-b472-bc00e91dc071", set_id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d", front: "puma", back: "", hint: "", emoji: "🐆" }
  ];
  const params = { deck: routeDeck[0].id, card: "puma" };

  const clickRes = playSelect(
    {
      items: session,
      rows: { deck_level: [],
        play_session: session,
        flashcard: [routeCards[1], routeCards[0]],
        card_set: routeDeck
      }
    } as any,
    { type: "click", id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d", name: "puma" }
  );
  assertEquals(clickRes.updates[0]?.row?.front, "puma");
  assertEquals(clickRes.updates[0]?.row?.card_index, 1);
  assertEquals(clickRes.updates[0]?.row?.hint, "69618be6-9206-f9c7-59eb-b5e4b072cf3d:puma");

  // A card route waits for its requested identity instead of selecting the first card.
  const pendingRouteCardRes = playSelect(
    {
      items: [clickRes.updates[0]?.row],
      params,
      rows: { deck_level: [],
        route_deck: routeDeck,
        route_cards: [routeCards[0]],
        flashcard: routeCards,
        card_set: routeDeck
      }
    } as any,
    { type: "mutation" }
  );
  assertEquals(pendingRouteCardRes.updates, []);

  const res = playSelect(
    {
      items: session,
      params,
      rows: { deck_level: [],
        route_deck: routeDeck,
        route_cards: routeCards,
        flashcard: routeCards,
        card_set: routeDeck
      }
    } as any,
    { type: "mutation" }
  );

  assertEquals(res.updates[0]?.row?.front, "puma");
  assertEquals(res.updates[0]?.row?.card_index, 1);
  assertEquals(res.updates[0]?.row?.hint, "69618be6-9206-f9c7-59eb-b5e4b072cf3d:puma");
  assertEquals(res.updates[1], {
    op: "patch",
    entity: "print_config",
    id: "config",
    row: { set_id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d" }
  });
});

Deno.test("print_select resolves set_id from play_session slot when event.id is absent", async () => {
  const printSelect = await load("print_select");
  const sessionSlot = [{ id: "session", set_id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d", front: "puma" }];
  const res = printSelect({ items: sessionSlot }, { type: "click", from: "btn-header-print" });
  assertEquals(res.updates, [
    { op: "patch", entity: "print_config", id: "config", row: { set_id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d" } }
  ]);
});

Deno.test("printing a collection does not cancel another generation", async () => {
  const printSelect = await load("print_select");
  const draft = { id: "draft", topic: "Animals", status: "generating" };
  const result = printSelect({ items: [{ id: "set-fruits" }], rows: { deck_level: [], ...slotted([draft])} } as any, { type: "click", id: "set-fruits" });
  assertEquals(result.updates, [{ op: "patch", entity: "print_config", id: "config", row: { set_id: "set-fruits" } }]);
  assertEquals(draft.status, "generating");
});

Deno.test("flashcard faces are image-only front and word-only back with clean seed metadata", async () => {
  for (const s of ["explore", "card"]) {
    const html = await screenMarkup(s);
    if (html.includes("front-word-label") || html.includes("back-emoji-seal") || html.includes("card-back-desc-card")) {
      throw new Error(`Screen "${s}.html" still contains legacy front word label or back description/emoji seal`);
    }
    if (!html.includes("card-back-title")) {
      throw new Error(`Screen "${s}.html" is missing .card-back-title on the back face`);
    }
  }
  const printHtml = await screenMarkup("print");
  if (!printHtml.includes("print-card-word") || printHtml.includes("print-card-desc")) {
    throw new Error("Screen print.html is missing .print-card-word or still contains .print-card-desc");
  }
  const cue = await Deno.readTextFile(new URL("../seed.cue", import.meta.url));
  const nonImageBack = [...cue.matchAll(/back:\s*"([^"]+)"/g)].filter(
    (m) => !m[1].startsWith("/img/insecure/plain/s3://mecha-objects/seed/"),
  );
  if (nonImageBack.length > 0) {
    throw new Error(`Expected all Flashcard seed rows in seed.cue to name a seed object in back, found ${nonImageBack.length} textual back strings`);
  }
});

Deno.test("airlock effects manifest runs the two deck texts on GenerationMachine and each card's art on CardArtMachine", async () => {
  const manifest = JSON.parse(await Deno.readTextFile(new URL("../services/airlock/effects.json", import.meta.url)));
  assertEquals(manifest.effects["smollm3-draft"]?.state, "drafting");
  assertEquals(manifest.effects["smollm3-draft"]?.handler, "effects/smollm3-draft.js");
  assertEquals(manifest.effects["heavy-draft"]?.state, "illustrating");
  assertEquals(manifest.effects["heavy-draft"]?.handler, "effects/heavy-draft.js");
  assertEquals([manifest.effects["illustrate-card"]?.table, manifest.effects["illustrate-card"]?.state, manifest.effects["illustrate-card"]?.attempts], ["card_art", "pending", 5]);

  const sql = await Deno.readTextFile(new URL("../services/database/migrations/010_machines.sql", import.meta.url));
  assertEquals(sql.includes("PERFORM snapcards_fan_out_art(NEW.set_id, NEW.region, 2, outcome)"), true);
  assertEquals(sql.includes("PERFORM snapcards_fan_out_art(NEW.set_id, NEW.region, 3, outcome)"), true);
});

Deno.test("shell manifest and screens contain no pdf-press references, the ai-browser worker unit on generate and only the delivery and payment units on print", async () => {
  const shellJson = await Deno.readTextFile(new URL("../shell/shell.json", import.meta.url));
  if (shellJson.includes("pdf-press")) {
    throw new Error("shell/shell.json still contains pdf-press references");
  }
  const parsedShell = JSON.parse(shellJson);
  assertEquals(parsedShell.units?.["ai-browser"]?.isolation, "agent");
  assertEquals(parsedShell.units?.["print-payment"]?.subdomain, "payments");
  assertEquals(parsedShell.units?.["print-payment"]?.grants, ["payment"]);
  assertEquals(parsedShell.ai?.text, ["browser", "cheap", "heavy"]);
  assertEquals(parsedShell.ai?.image, ["browser", "cheap", "heavy"]);
  const hatchSrc = await Deno.readTextFile(new URL("../shell/hatches/window-print.js", import.meta.url));
  assertEquals(hatchSrc.trim().split("\n").length, 4);
  const screens = ["cards", "generate", "explore", "deck", "card", "print"];
  for (const screen of screens) {
    const html = await screenMarkup(screen);
    if (html.includes("pdf-press")) throw new Error(`screen ${screen} still contains pdf-press`);
    const units = new Set([...html.matchAll(/data-hatch="([^"]+)"/g)].map((m) => m[1]));
    const expected: Record<string, string[]> = { generate: ["ai-browser"], print: ["delivery-map", "geocoder", "print-payment"] };
    assertEquals([...units].sort(), expected[screen] ?? []);
  }
});

Deno.test("generate screen scopes collection history and progress to owned, active decks", async () => {
  const generateHtml = await screenMarkup("generate");
  const generateCss = await Deno.readTextFile(new URL("../shell/screens/generate.css", import.meta.url));

  assertEquals(generateHtml.includes('id="generation-jobs-list"'), true);
  assertEquals(generateHtml.includes('data-live="localized_deck" data-filter="cover_emoji=eq.🎨"'), true);
  assertEquals(generateHtml.includes(">01</span>"), false);
  assertEquals(generateHtml.includes(">02</span>"), false);

  assertEquals(generateCss.includes(".generated-deck-banner:has(.owned-generation)"), true);
  assertEquals(generateCss.includes('@keyframes dreamyPreviewDance'), false);
  assertEquals(generateCss.includes('.gen-job-row:not(:has(.owned-generation))'), true);
  assertEquals(generateCss.includes('.gen-job-card.gen-job-row:first-child'), false);
  assertEquals(generateHtml.includes('data-live="deck_level" data-filter="set_id=eq.{id}"><template data-item><span class="deck-level-state"'), true);
  assertEquals(generateCss.includes('.studio-container:not([data-status="done"]):not([data-status="generating"]):not([data-status="partial"]) ~ .generator-preview-panel .card-illustration-img'), true);

});

// A deck's id was its title and device, so a deck created again under its title replaced
// the first one's cards: a reader changing only the audience lost the deck they had.
// The ids once made a repeat land on one deck, so these clicks cost nothing. A minted id makes
// each of them a deck and a paid generation.
// The chart took the click and the fold hears the chart's write: a fold hearing the click too
// could read the chart's "generating" first and take a first Create for a second.
Deno.test("only an unanswered Create mints a deck, and only its seat answers", async () => {
  const handler = positional((0, eval)(await Deno.readTextFile(new URL("../shell/handlers/create_set.js", import.meta.url))));
  const reply = (draft: object, sets: object[], event: object = ASK, generation_ask: object[] = [{ id: "ask" }]) => handler({
    items: [{ id: "draft", topic: "animais", category: "Fauna", locale: "pt-BR", region: "Brasil", card_count: 5, details: "", audience_key: "diff_kids", ...draft }],
    rows: { deck_level: [], device: [DEVICE], card_set: sets, flashcard: [], generation_ask },
  }, event);
  const running = { id: DECK, name: "animais", details: "", audience_key: "diff_kids" };
  assertEquals(reply({ status: "generating", set_id: DECK }, [running], ASK, []), { updates: [] });
  assertEquals(reply({ status: "generating", set_id: "" }, [], { type: "click", from: "btn-create" }), { updates: [] });
  assertEquals(reply({ status: "generating", set_id: "" }, [], { type: "mutation", from: "generated-drafts-sync" }).then, undefined);
  assertEquals(reply({ status: "generating", set_id: DECK }, [running]).then?.type, "mint-deck");
  // The same title for another audience is the deck that was once overwritten.
  assertEquals(reply({ status: "generating", set_id: "", audience_key: "diff_toddler" }, [running]).then?.type, "mint-deck");
  // From an end the chart clears the deck, so the same form asks for a new one.
  assertEquals(reply({ status: "generating", set_id: "" }, [running]).then?.type, "mint-deck");
});

// Every wake with no device minted one, which wrote its slots: the renderer refuses any remote
// write, so turning on server rendering answered 500 on every page.
Deno.test("a server render's wake writes nothing", async () => {
  const handler = positional((0, eval)(await Deno.readTextFile(new URL("../shell/handlers/create_set.js", import.meta.url))));
  const rows = { deck_level: [], device: [], generation_form: [], card_set: [], flashcard: [], ...slotted([])};
  assertEquals(handler({ ssr: true, rows }, { type: "mutation", from: "generated-drafts-sync" }), { updates: [] });
  assertEquals(handler({ ssr: true, rows: { ...rows, device: [DEVICE] } }, { type: "mutation", from: "generated-drafts-sync" }), { updates: [] });
});

// A release that replaced the database left every returning browser its device key and no slots,
// so decks stayed untranslated with no sign anything had been asked for.
Deno.test("a device whose slots the database lost gets them back idle, on a wake", async () => {
  const handler = chained(positional((0, eval)(await Deno.readTextFile(new URL("../shell/handlers/create_set.js", import.meta.url)))));
  const wake = (generation_draft: unknown[]) => handler({ rows: { deck_level: [], device: [DEVICE], generation_form: [], card_set: [], flashcard: [], ...slotted(generation_draft) } }, { type: "mutation", from: "generated-drafts-sync" });
  const idle = (id: string) => ({ op: "put", entity: "generation_draft", id, row: { id }, absent: { topic: "", category: "", locale: "", region: "", card_count: 0, status: "idle", set_id: "", details: "" } });
  assertEquals(wake([]).updates, [idle(CHEAP), idle(HEAVY)]);
  // A tab closed mid-mint can leave either, and only the cheap one holds translations back.
  assertEquals(wake([{ id: HEAVY, status: "idle" }]).updates, [idle(CHEAP)]);
  // A slot still held is no lost database, and a wake must not idle what it is running.
  assertEquals(wake([{ id: CHEAP, status: "drafting" }]).updates.some((u: Update) => u.entity === "generation_draft" && u.op === "put"), false);
});

Deno.test("each Create is a deck of its own minted id, whatever its title, and touches no curated deck", async () => {
  const handler = positional((0, eval)(await Deno.readTextFile(new URL("../shell/handlers/create_set.js", import.meta.url))));
  const OTHER = "00000005-0000-4006-8000-000700000008";
  const click = (uuid: string) => chained(handler, uuid)(
    {
      items: [{ id: "draft", topic: "animais", category: "Fauna", locale: "pt-BR", region: "Brasil", card_count: 5, status: "generating" }],
      rows: { deck_level: [],
        device: [DEVICE],
        card_set: [{ id: "set-animais", name: "Animais", cover_emoji: "🐾", count: 5 }],
        flashcard: [{ id: "card-capivara", set_id: "set-animais", front: "Capivara", hint: "curated", emoji: "🦫", back: "" }],
      },
    } as any,
    ASK,
  );
  const ids = [DECK, OTHER].map((uuid) => {
    const res = click(uuid);
    const csPut = res.updates.find((u: Update) => u.entity === "card_set")!;
    assertEquals(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(csPut.id)), true);
    assertEquals([csPut.row?.name, csPut.row?.device], ["animais", KEY]);
    assertEquals(res.updates.filter((u: Update) => u.entity === "flashcard").every((u: Update) => String(u.id).startsWith(`card-${csPut.id}-`)), true);
    assertEquals(res.updates.filter((u: Update) => u.op === "delete" && u.entity !== "generation_ask"), []);
    return csPut.id;
  });
  assertEquals(ids, [DECK, OTHER]);
});

Deno.test("play_next and play_master use actual flashcard deck length and cap mastered at total", async () => {
  const playNext = await load("play_next");
  const playMaster = await load("play_master");
  const flashcards = [
    { id: "c2", set_id: "deck-real", front: "Two", emoji: "2️⃣", hint: "", back: "" },
    { id: "c1", set_id: "deck-real", front: "One", emoji: "1️⃣", hint: "", back: "" },
  ];
  const nextRes = playNext(
    {
      items: [{ id: "session", set_id: "deck-real", card_index: 1, total: 5, status: "playing" }],
      rows: { deck_level: [], flashcard: flashcards },
    } as any,
    { type: "click" },
  );
  assertEquals(nextRes.updates, [{ op: "patch", id: "session", row: { finished: "yes" } }]);

  const masterRes = playMaster(
    {
      items: [{ id: "session", set_id: "deck-real", card_index: 1, mastered: 2, total: 5, status: "playing" }],
      rows: { deck_level: [], flashcard: flashcards },
    } as any,
    { type: "click" },
  );
  assertEquals(masterRes.updates[0]?.row?.mastered, 2);
  assertEquals(masterRes.updates[0]?.row?.finished, "yes");
  assertEquals(masterRes.updates[0]?.row?.front, "Two");
  assertEquals(masterRes.updates[0]?.row?.emoji, "2️⃣");
});

Deno.test("create_set starts a new deck on a fresh run", async () => {
  const createSet = await load("create_set");

  // Starting a second job while run-2 is queued in flashcard.hint allocates run-3 instead of colliding on run-2
  const queuedClick = createSet(
    {
      items: [{ id: "draft", topic: "Topic C", category: "Fauna", locale: "pt-BR", region: "Brasil", card_count: 1, status: "generating", set_id: "set-topic-b" }],
      rows: { deck_level: [],
        generation_form: [{ id: "draft", topic: "Topic C", category: "Fauna", locale: "pt-BR", region: "Brasil", card_count: 1, status: "generating", set_id: "set-topic-b" }],
        device: [DEVICE],
        ...slotted([
          { id: CHEAP, topic: "Topic A", category: "", locale: "pt-BR", region: "run-1", card_count: 1, status: "drafting" },
          { id: HEAVY, topic: "", category: "", locale: "pt-BR", region: "", card_count: 1, status: "idle" },
        ]),
        card_set: [{ id: "set-topic-b", name: "Topic B", count: 1 }],
        flashcard: [{ id: "card-topic-b-1", set_id: "set-topic-b", front: "Topic B #1", hint: "run-2", emoji: "⏳", back: "" }],
      },
    } as any,
    ASK as any,
  );
  const cCardPut = queuedClick.updates.find((u: Update) => u.entity === "flashcard");
  assertEquals(cCardPut?.row?.hint, "run-3");
});

Deno.test("smollm3-draft rejects malformed JSON or insufficient card counts and print.css binds duplex 2-col and @page rules", async () => {
  const { issue } = await import("../effects/smollm3-draft.js");
  const badJsonRes = await issue(
    { topic: "astronomia", locale: "pt-BR", card_count: 5 },
    {
      fetch: async () => ({
        status: 200,
        body: { message: { content: "not valid json" } },
      }),
    },
  );
  assertEquals(badJsonRes, { failed: { status: 422, topic: "astronomia" } });

  const tooFewRes = await issue(
    { topic: "astronomia", locale: "pt-BR", card_count: 5 },
    {
      fetch: async () => ({
        status: 200,
        body: { message: { content: JSON.stringify({ cards: [{ word: "Sol", emoji: "☀️", subject_en: "sun" }] }) } },
      }),
    },
  );
  assertEquals(tooFewRes, { failed: { status: 422, topic: "astronomia" } });

  const printCss = await Deno.readTextFile(new URL("../shell/screens/print.css", import.meta.url));
  assertEquals(printCss.includes("@page a4-portrait"), true);
  assertEquals(printCss.includes("@page a4-landscape"), true);
  assertEquals(printCss.includes("@page letter-portrait"), true);
  assertEquals(printCss.includes("@page letter-landscape"), true);
  assertEquals(printCss.includes("grid-template-columns: repeat(4, minmax(0, 1fr))"), false);

  const cardsHtml = await screenMarkup("cards");
  assertEquals(cardsHtml.includes("input@library-search"), true);
  assertEquals(cardsHtml.includes('data-filter="name=ilike.*{library_query}*"'), true);

  let capturedPrompt = "";
  const okRegionRes = await issue(
    { topic: "culinária", locale: "pt-BR", region: "Nordeste :: run-1", card_count: 1 },
    {
      fetch: async (_path: string, init: any) => {
        capturedPrompt = String(init?.body?.messages?.[0]?.content || "");
        return {
          status: 200,
          body: { message: { content: JSON.stringify({ cards: [{ word: "Acarajé", emoji: "🧆", subject_en: "acaraje" }] }) } },
        };
      },
    },
  );
  assertEquals(Boolean((okRegionRes as any).done), true);
  assertEquals(capturedPrompt.includes("Cultural region: Nordeste."), true);
});

Deno.test("create_set fills placeholder cards from the browser tier, ignores its late answer after a server text, and regenerates a failed draft", async () => {
  const createSet = await load("create_set");

  const placeholderCards = [1, 2, 3, 4, 5].map((i) => ({
    id: `card-orquestra-${KEY}-${i}`,
    set_id: `set-orquestra-${KEY}`,
    front: `Orquestra #${i}`,
    hint: "run-1",
    emoji: "⏳",
    back: "",
    color: "#FED7AA",
  }));

  const generatingState = {
    items: [{ id: "draft", topic: "Orquestra", category: "Música", locale: "pt-BR", region: "Brasil", card_count: 5, status: "generating" }],
    rows: { deck_level: [],
      generation_form: [{ id: "draft", topic: "Orquestra", category: "Música", locale: "pt-BR", region: "Brasil", card_count: 5, status: "generating", set_id: `set-orquestra-${KEY}`, run: "run-1" }],
      device: [DEVICE],
      ...slotted([
        { id: CHEAP, topic: "Orquestra", category: "", locale: "pt-BR", region: "Brasil :: run-1", card_count: 5, status: "drafting" },
        { id: HEAVY, topic: "", category: "", locale: "pt-BR", region: "", card_count: 5, status: "idle" },
      ]),
      play_session: [{ id: "session", set_id: `set-orquestra-${KEY}`, front: "Orquestra #1", back: "", emoji: "⏳" }],
      print_config: [
        { id: "config", set_id: `set-orquestra-${KEY}`, paper: "a4", card_size: "standard", layout: "fold", cut_lines: "yes", orientation: "portrait" },
        { id: "press", set_id: `set-orquestra-${KEY}`, paper: "a4", card_size: "standard", layout: "fold", cut_lines: "yes", orientation: "portrait" },
      ],
      card_set: [{ id: `set-orquestra-${KEY}`, name: "Orquestra", count: 5, cover_emoji: "🎨" }],
      flashcard: placeholderCards,
    },
  };

  // 1. Tier 0 (browser worker) resolves while cheap is still drafting -> promotes placeholder cards to browser words + procedural SVG sketches
  const browserEvent = {
    type: "draft",
    detail: {
      topic: "Orquestra",
      locale: "pt-BR",
      status: "generating",
      set_id: `set-orquestra-${KEY}`,
      run: "run-1",
      w0: "Violino",
      w1: "Piano",
      w2: "Flauta",
      w3: "Violão",
      w4: "Trompete",
    },
  };
  assertEquals(createSet(generatingState as any, { ...browserEvent, detail: { ...browserEvent.detail, run: "run-0" } } as any).updates, []);
  assertEquals(createSet(generatingState as any, { ...browserEvent, detail: { ...browserEvent.detail, set_id: "another-deck" } } as any).updates, []);
  const browserRes = createSet(generatingState as any, browserEvent as any);
  const browserCards = browserRes.updates.filter((u: Update) => u.entity === "flashcard");
  assertEquals(browserCards.length, 5);
  assertEquals(browserCards[0]?.row?.front, "Violino");
  assertEquals(browserCards[0]?.row?.emoji, "🧭");
  assertEquals(String(browserCards[0]?.row?.back || "").includes("tier-browser"), true);
  assertEquals(new Set(browserCards.map(c => c.row?.back)).size, 1);
  assertEquals(decodeURIComponent(String(browserCards[0]?.row?.back)).includes("<text"), false);
  assertEquals(browserRes.updates.find((u: Update) => u.entity === "generation_form")?.row?.words, "complete");

  // 2. Out-of-order: if cheap tier already resolved, a late browser worker response is ignored
  const afterCheapState = {
    ...generatingState,
    rows: {
      ...generatingState.rows,
      flashcard: placeholderCards.map((c, idx) => ({
        ...c,
        front: `CheapWord${idx + 1}`,
        emoji: "🎻",
        back: `data:image/svg+xml;utf8,cheap-${idx + 1}`,
      })),
    },
  };
  const lateBrowserAfterCheap = createSet(afterCheapState as any, browserEvent as any);
  assertEquals(lateBrowserAfterCheap.updates, []);

  // 3. Out-of-order: if heavy tier already resolved, a late browser worker response is ignored
  const afterHeavyState = {
    ...generatingState,
    rows: {
      ...generatingState.rows,
      flashcard: placeholderCards.map((c, idx) => ({
        ...c,
        front: `HeavyWord${idx + 1}`,
        emoji: "🎻",
        back: `data:image/png;base64,heavy-${idx + 1}`,
      })),
    },
  };
  const lateBrowserAfterHeavy = createSet(afterHeavyState as any, browserEvent as any);
  assertEquals(lateBrowserAfterHeavy.updates, []);

  // 7. A Create after a draft stuck in "failed" writes a deck of 5 cards
  const stuckFailedClickRes = createSet(
    {
      items: [{ id: "draft", topic: "Famous Actors", category: "Cultura", locale: "en-US", region: "USA", card_count: 5, status: "generating" }],
      rows: { deck_level: [], device: [DEVICE] },
    } as any,
    ASK as any,
  );
  assertEquals(stuckFailedClickRes.updates.filter((u: Update) => u.entity === "flashcard").length, 5);
});

// A picture inline in its row went to every reader's sync and every rendered document.
Deno.test("every seeded Flashcard names an object the seed holds, by its hash, and sidebar status avoids Convidado · Offline jargon", async () => {
  const cue = await Deno.readTextFile("seed.cue");
  const chromeCss = await Deno.readTextFile("shell/shared/chrome.css");

  const cardMatches = [...cue.matchAll(/\{id:\s*"([^"]+)",\s*set_id:\s*"([^"]+)",\s*front:\s*"([^"]+)",\s*back:\s*"([^"]*)"/g)];
  assertEquals(cardMatches.length, 82);
  for (const [, id, , , back] of cardMatches) {
    const file = /^\/img\/insecure\/plain\/s3:\/\/mecha-objects\/seed\/([0-9a-f]{64}\.webp)$/.exec(back)?.[1];
    if (!file) throw new Error(`Seeded card ${id} names no seed object: ${back.slice(0, 60)}`);
    await Deno.stat(`assets/seed/${file}`);
  }

  assertEquals(chromeCss.includes("Convidado · Offline"), false);
  assertEquals(chromeCss.includes('content: "Not signed in"'), false);
});

Deno.test("play_select preserves non-UI learning languages and fullscreen navigation", async () => {
  const playSelect = await load("play_select");
  const playNext = await load("play_next");

  const profDeck = {
    id: "40e83dce-ffdc-548b-7079-1d9f0a51ce88",
    name: "Occupations and Professions",
    locale: "en",
    count: 3,
  };
  const profCards = [
    { id: "c-1", set_id: profDeck.id, front: "Librarian", hint: "", emoji: "📚", back: "data:image/webp;base64,lib" },
    { id: "c-2", set_id: profDeck.id, front: "Ballerina", hint: "", emoji: "🩰", back: "data:image/webp;base64,bal" },
    { id: "c-3", set_id: profDeck.id, front: "Farmer", hint: "", emoji: "🌾", back: "data:image/webp;base64,far" },
  ];

  // 3. A deck created in Klingon ("tlh" or "Klingon") is NOT one of the 5 UI languages and is NEVER translated
  const klingonDeck = {
    id: "deck-klingon",
    name: "tlhIngan Hol",
    locale: "tlh",
    count: 2,
  };
  const klingonCards = [
    { id: "k-1", set_id: "deck-klingon", front: "Librarian", hint: "", emoji: "⚔️", back: "data:image/webp;base64,k1" },
    { id: "k-2", set_id: "deck-klingon", front: "Qapla'", hint: "", emoji: "🖖", back: "data:image/webp;base64,k2" },
  ];
  const mutKlingonRes = playSelect(
    {
      items: [{ id: "session", set_id: profDeck.id, card_index: 0, status: "playing", front: "Librarian", hint: "" }],
      rows: { deck_level: [],
        route_deck: [klingonDeck],
        route_cards: klingonCards,
        card_set: [klingonDeck],
        flashcard: klingonCards,
      },
    } as any,
    { type: "mutation" },
  );
  assertEquals(mutKlingonRes.updates.filter((u: Update) => u.entity === "flashcard"), []);
  const klingonSessionPatch = mutKlingonRes.updates.find((u: Update) => u.entity === "play_session");
  assertEquals(klingonSessionPatch?.row?.front, "Librarian");

  // 4. Fullscreen mode is modeled on study screens and preserved across play_next
  for (const s of ["explore", "card"]) {
    const html = await screenMarkup(s);
    assertEquals(html.includes('"click@btn-fullscreen-toggle":"fullscreen"'), true);
    assertEquals(html.includes('"click@btn-fullscreen-exit":"playing"'), true);
  }
  const nextInFs = playNext(
    {
      items: [{ id: "session", set_id: profDeck.id, card_index: 0, total: 3, status: "fullscreen", flipped: "no", mastered: 0 }],
      rows: { deck_level: [], flashcard: profCards },
    } as any,
    { type: "click" },
  );
  assertEquals(nextInFs.updates[0]?.row?.status, undefined);
  assertEquals(nextInFs.updates[0]?.row?.card_index, 1);
});

Deno.test("create_set deletes a user-created deck with its cards", async () => {
  const createSet = await load("create_set");

  // 1. Delete user-created deck
  const delRes = createSet(
    {
      items: [{ id: "draft", topic: "animais da fazenda", category: "Fauna", locale: "pt-BR", region: "Brasil", card_count: 2, status: "done", set_id: "set-animais-da-fazenda" }],
      rows: { deck_level: [],
        generation_form: [{ id: "draft", topic: "animais da fazenda", category: "Fauna", locale: "pt-BR", region: "Brasil", card_count: 2, status: "done", set_id: "set-animais-da-fazenda" }],
        card_set: [
          { id: "set-animais-da-fazenda", name: "animais da fazenda", cover_emoji: "🎨", count: 2, owner: ME },
          { id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d", name: "Animais Brasileiros", cover_emoji: "🐾", count: 5 },
        ],
        me: [{ id: ME }],
        flashcard: [
          { id: "card-animais-da-fazenda-1", set_id: "set-animais-da-fazenda", front: "Cavalo", emoji: "🐴", hint: "tier-heavy", back: "data:image/png;base64,h1" },
          { id: "card-animais-da-fazenda-2", set_id: "set-animais-da-fazenda", front: "Vaca", emoji: "🐮", hint: "tier-heavy", back: "data:image/png;base64,h2" },
          { id: "c82890b5-5e84-48d6-9b73-36d3ef45b610", set_id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d", front: "capybara", emoji: "🦫", hint: "", back: "data:image/webp;base64,cap" },
        ],
        play_session: [
          { id: "session", set_id: "set-animais-da-fazenda", card_index: 0, flipped: "no", mastered: 1, total: 2, status: "playing", front: "Cavalo", back: "", hint: "set-animais-da-fazenda#lang=pt", library_query: "fazenda", emoji: "🎨" },
        ],
        print_config: [
          { id: "config", set_id: "set-animais-da-fazenda" },
        ],
      },
    } as any,
    { type: "click", target: { dataset: { action: "delete", setId: "set-animais-da-fazenda" } } } as any,
  );
  // The database takes its cards: a list reads none of them, and one deleted from it left them all behind.
  assertEquals(delRes.updates.some((u: Update) => u.entity === "flashcard"), false);
  const deletedSet = delRes.updates.find((u: Update) => u.entity === "card_set" && u.op === "delete");
  assertEquals(deletedSet?.id, "set-animais-da-fazenda");
  const sessionAfterDel = delRes.updates.find((u: Update) => u.entity === "play_session");
  assertEquals(sessionAfterDel?.row?.set_id, "69618be6-9206-f9c7-59eb-b5e4b072cf3d");
  assertEquals(sessionAfterDel?.row?.library_query, undefined);
  const draftAfterDel = delRes.updates.find((u: Update) => u.entity === "generation_form" && u.id === "draft");
  assertEquals(draftAfterDel, undefined);
});

Deno.test("UGC titles, categories and words use AI once and retain originals across language switches", async () => {
  const select: Handler = bothSeats(positional((0, eval)(await Deno.readTextFile(new URL("../shell/handlers/play_select.js", import.meta.url)))));
  const create = await load("create_set");
  const { issue } = await import("../effects/smollm3-draft.js");
  const deck = { id: "set-orchestra", name: "Instrumentos da Orquestra", category: "#08 · Música", locale: "pt-BR", count: 2 };
  const cards = ["Violino", "Flauta"].map((front, i) => ({ id: `card-${i}`, set_id: deck.id, front, hint: "run-1", emoji: "🎵", txid: "99" }));
  const session = { id: "session", set_id: deck.id, card_index: 1, front: "Flauta", total: 2, status: "playing", hint: `${deck.id}#lang=en`, back: "", emoji: "🎵", flipped: "no", mastered: 0 };
  const main = { id: "draft", status: "idle", topic: "orchestra", card_count: 2 };
  const cheap = { id: CHEAP, status: "idle", topic: "", txid: "42" };
  const state = { items: [session], locale: "en", rows: { deck_level: [], card_set: [deck], flashcard: cards, play_session: [session], route_deck: [deck], route_cards: cards, generation_form: [main], device: [DEVICE], ...slotted([cheap])} };
  const first = select(state as any, { type: "mutation" });
  const request = first.updates.find(u => u.entity === "generation_draft")?.row!;
  assertEquals(JSON.parse(String(request.topic).split(" :: ")[2]), { name: deck.name, category: deck.category, cards: ["Violino", "Flauta"] });
  assertEquals(first.updates.some(u => u.entity === "flashcard"), false);
  let calls = 0;
  const result = await issue({ ...request }, { fetch: async (_path: string, options: any) => {
    calls++;
    assertEquals(options.body.messages[1].content.includes(deck.name), true);
    return { status: 200, body: { choices: [{ message: { content: JSON.stringify({ name: "Orchestra Instruments", category: "#08 · Music", cards: ["Violin", "Flute"] }) } }] } };
  } } as any);
  assertEquals(calls, 1);
  const completed = result.done;
  if (!completed) throw new Error("Deck metadata translation did not complete");
  const done = { ...cheap, ...request, status: "done", category: completed.cards_json };
  const applied = create({ items: [main], rows: { ...state.rows, ...slotted([done])} } as any, { type: "mutation", from: "generated-drafts-sync" });
  assertEquals(applied.updates.some(u => u.entity === "card_set" || u.entity === "play_session"), false);
  assertEquals(applied.updates.some(u => u.entity === "flashcard"), false);
  const translatedDeck = deck;
  const rowsOf = (entity: string) => applied.updates.filter(u => u.op === "put" && u.entity === entity).map(u => u.row);
  const translatedState = { ...state, rows: { ...state.rows, deck_translation: rowsOf("deck_translation"), card_translation: rowsOf("card_translation") } };
  const settled = select(translatedState as any, { type: "mutation" });
  assertEquals(settled.updates.find(u => u.entity === "play_session")?.row, { card_id: "card-1", original_front: "Flauta", translation_failed_topic: "", front: "Flute" });
  assertEquals(settled.updates.some(u => u.entity === "generation_draft"), false);
  assertEquals(settled.updates.some(u => u.entity === "card_set" || u.entity === "flashcard"), false);
  const restored = select({ ...translatedState, locale: "pt" } as any, { type: "mutation" });
  assertEquals(restored.updates.find(u => u.entity === "card_set"), undefined);
  assertEquals(translatedDeck.locale, "pt-BR");
});

Deno.test("shell/index.html and shell/favicon.svg provide a crisp Snapcards SVG favicon", async () => {
  const indexHtml = await Deno.readTextFile(new URL("../shell/index.html", import.meta.url));
  const faviconSvg = await Deno.readTextFile(new URL("../shell/favicon.svg", import.meta.url));
  assertEquals(indexHtml.includes('<link rel="icon" type="image/svg+xml" href="./favicon.svg">'), true);
  assertEquals(indexHtml.includes('href="data:,"'), false);
  assertEquals(faviconSvg.includes("<svg"), true);
  assertEquals(faviconSvg.includes("#E5A744"), true);
  assertEquals(faviconSvg.includes("#B97B3C"), true);
});





Deno.test("generation deletion targets the clicked deck without mutating an in-flight effect", async () => {
  const createSet = await load("create_set");
  const state = { rows: { deck_level: [],
    generation_form: [{ id: "draft", topic: "Cats", status: "generating", set_id: "set-cats" }],
    device: [DEVICE],
    ...slotted([{ id: CHEAP, topic: "Cats", status: "illustrating" }, { id: HEAVY, topic: "Cats :: A cat", status: "illustrating" }]),
    card_set: [{ id: "set-cats", name: "Cats", cover_emoji: "🎨", owner: ME }, { id: "set-dogs", name: "Dogs", cover_emoji: "🎨", owner: ME }, { id: "set-cats-old", name: "Cats", cover_emoji: "🎨", owner: ME }],
    me: [{ id: ME }],
    flashcard: [],
    print_config: [{ id: "press", set_id: "set-cats" }, { id: "config", set_id: "set-cats" }],
    play_session: [{ id: "session", set_id: "set-cats" }],
  } };
  const result = createSet(state as any, { type: "click", id: "set-dogs", target: { dataset: { action: "delete", setId: "set-cats" } } });
  assertEquals(result.updates.filter(u => u.op === "delete" && u.entity === "card_set").map(u => u.id), ["set-cats"]);
  assertEquals(result.updates.find(u => u.entity === "print_config" && u.id === "press")?.row?.set_id, "none");
  assertEquals(result.updates.some(u => u.entity === "generation_form"), false);
  for (const id of [CHEAP, HEAVY]) assertEquals(result.updates.some(u => u.entity === "generation_draft" && u.id === id), false);
  assertEquals(createSet(state as any, { type: "click", detail: { action: "delete", setId: "set-dogs" } }).updates.some(u => u.op === "delete" && u.id === "set-dogs"), true);
  // Titles repeat: deleting an older deck of the form's title once idled the deck still generating.
  assertEquals(createSet(state as any, { type: "click", detail: { action: "delete", setId: "set-cats-old" } }).updates.some(u => u.entity === "generation_form" && u.row?.status === "idle"), false);
});

// Ownership was a tab-only list of the decks this tab generated, so a reload or a new tab
// made every deck someone else's: it is now the deck's owner against the reader's own `me`.
Deno.test("every ownership probe names the deck's owner against me", async () => {
  for (const [screen, n] of [["generate", 2], ["explore", 1], ["card", 1], ["cards", 1]] as const) {
    const html = await screenMarkup(screen);
    assertEquals(html.includes("id=eq.press"), false);
    assertEquals(html.split('data-live="me" data-filter="id=eq.{owner}"').length - 1, n);
    // An item's root is the row's node, never mounted as a region of its own.
    assertEquals(html.includes('<template data-item><span data-live="me"'), false);
  }
});

Deno.test("shared generating status cannot display progress in a tab without its own active job", async () => {
  const css = await Deno.readTextFile(new URL("../shell/screens/generate.css", import.meta.url));
  // But for this device's own form generating, which is this reader's deck before its rows prove it.
  assertEquals(css.includes('.generator-shell:not(:has(.studio-container[data-status="generating"])) .generated-deck-banner:not(:has(.owned-generation))'), true);
  const html = await screenMarkup("generate");
  assertEquals(html.includes('class="ai-tier-pipeline"'), true);
  assertEquals(html.includes('class="gen-job-progress" data-live="generation_form" data-filter="id=eq.draft&amp;set_id=eq.{id}"'), true);
  assertEquals(html.includes('cancel-generation'), false);
  assertEquals(html.includes('id="gen-phase-sub-ai"'), false);
  assertEquals(css.includes('grid-template-rows: 36px 22px 12px'), true);
  assertEquals(css.includes('.gen-job-progress { display: block;'), true);
  assertEquals(html.includes('gen-job-badge-ready'), true);
});

Deno.test("the owner's /generate preview keeps every deck card's art selectable, not just the first", async () => {
  // Regression: generate.css once copied explore/card.css's single-card idiom
  // (".card-illustration .card-illustration-img:not(:first-of-type) { display:
  // none !important }") onto #preview-front-box, whose .card-illustration lists
  // every card of the deck. The !important always beat the nth-child selection
  // rule below it as soon as the session (or a clicked deck-strip chip) landed
  // on any card but the first, leaving the preview blank.
  const css = await Deno.readTextFile(new URL("../shell/screens/generate.css", import.meta.url));
  assertEquals(css.includes('.card-illustration .card-illustration-img:not(:first-of-type)'), false);
  assertEquals(css.includes('.card-illustration-img[src=""]'), true);
  // The selection rule it must not be overridden by is still the one in force.
  assertEquals(css.includes('.preview-card-container:has(.preview-selection [data-index="2"]) :is(#preview-status-pill, .preview-card-illustration, #preview-specimen-name) > *:not(:nth-child(3)) { display: none; }'), true);
});

Deno.test("collection positions do not depend on asynchronously translated deck names", async () => {
  for (const [screen, className] of [["cards", "deck-grid"], ["print", "deck-picker-carousel"]]) {
    const html = await screenMarkup(screen);
    const collection = html.match(new RegExp(`<div class="${className}"[^>]+>`))?.[0];
    assertEquals(collection?.match(/data-order="([^"]+)"/)?.[1], "id.asc");
  }
});

Deno.test("translation sync preserves Previous selection when its old label no longer matches", async () => {
  const select = await load("play_select");
  const deck = { id: "set-orchestra", count: 3, locale: "pt-BR" };
  const cards = [0, 1, 2].map((i) => ({ id: `card-${i}`, set_id: deck.id, front: `original-${i}`, hint: "", emoji: "🎵" }));
  const english = cache(deck.id, "en", "Orchestra", "", { "card-0": "Violin", "card-1": "Flute", "card-2": "Cello" });
  for (const cardRoute of [false, true]) {
    const session = { id: "session", set_id: deck.id, card_index: 1, front: "Flauta", hint: `${deck.id}${cardRoute ? ":original-0" : ""}#lang=en`, flipped: "yes", mastered: 2, total: 3, status: "playing", back: "", emoji: "🎵" };
    const result = select({ items: [session], locale: "en", params: cardRoute ? { deck: deck.id, card: "original-0" } : {}, rows: { deck_level: [],
      route_deck: [deck], route_cards: cards,
      card_set: [deck], flashcard: cards, play_session: [session], ...english
    } } as any, { type: "mutation" });
    const patch = result.updates.find(u => u.entity === "play_session");
    assertEquals(patch?.row, { card_id: "card-1", original_front: "original-1", translation_failed_topic: "", front: "Flute" });
  }
});

Deno.test("late translation preserves completion until restart or selecting another deck", async () => {
  const select = await load("play_select");
  const next = await load("play_next");
  const restart = await load("play_restart");
  const deck = { id: "set-minas", count: 2, locale: "pt-BR" };
  const cards = [0, 1].map((i) => ({ id: `card-${i}`, set_id: deck.id, front: `original-${i}`, hint: "", emoji: "🐾" }));
  const session = { id: "session", set_id: deck.id, card_index: 1, front: "Lobo", hint: `${deck.id}#lang=en`, flipped: "no", mastered: 0, total: 2, status: "playing", back: "", emoji: "🐾" };
  const rows = { card_set: [deck], flashcard: cards, route_deck: [deck], route_cards: cards, ...cache(deck.id, "en", "Minas", "", { "card-0": "Fox", "card-1": "Wolf" }) };
  const completion = next({ items: [session], rows } as any, { type: "click" });
  const completed = { ...session, ...completion.updates[0].row };
  assertEquals(completion.updates[0].row?.finished, "yes");
  const sync = select({ items: [completed], rows, locale: "en" } as any, { type: "mutation" });
  const patch = sync.updates.find(u => u.entity === "play_session")?.row;
  assertEquals(patch, { card_id: "card-1", original_front: "original-1", translation_failed_topic: "", front: "Wolf" });
  const settled = { ...completed, ...patch };
  assertEquals(select({ items: [settled], rows, locale: "en" } as any, { type: "mutation" }).updates, []);
  assertEquals(restart({ items: [settled], rows } as any, { type: "click" }).updates[0].row?.card_index, 0);
  const otherDeck = { ...deck, id: "set-other" };
  const otherCards = cards.map(c => ({ ...c, set_id: otherDeck.id }));
  const navigation = select({ items: [settled], rows: { deck_level: [], card_set: [otherDeck], flashcard: otherCards, route_deck: [otherDeck], route_cards: otherCards }, locale: "en" } as any, { type: "mutation" });
  assertEquals(navigation.updates.find(u => u.entity === "play_session")?.row?.finished, "");
});

// The server writes each card's words and art (card-art.cue); a tab starts the deck's heavy text
// once deck_level shows the cheap text of this run settled, whichever tab owns the deck.
const deckOfFour = () => ({
  rows: { deck_level: [],
    device: [DEVICE],
    card_set: [{ id: "set-frutas", name: "frutas", count: 4, cover_emoji: "🎨", owner: ME }, { id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d", name: "Animais", count: 5, cover_emoji: "🐾" }],
    me: [{ id: ME }],
    flashcard: [
      ...[1, 2, 3, 4].map((i) => ({ id: `card-frutas-${i}`, set_id: "set-frutas", front: `Fruta ${i}`, emoji: "🍎", hint: "run-1" })),
      { id: "capybara", set_id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d", front: "capybara", emoji: "🦫", hint: "" },
    ],
    play_session: [{ id: "session", set_id: "set-frutas", card_index: 2, total: 4, front: "Fruta 3", emoji: "🍎" }],
    print_config: [{ id: "press", set_id: "set-frutas" }],
  } as Record<string, Record<string, unknown>[]>,
});
// The delete button's chart confirmed this card's intent row; create_set's fold applies it.
const confirmed = (state: ReturnType<typeof deckOfFour>, cardId: string) => {
  state.rows.card_delete = [{ id: cardId, state: "confirmed" }];
  return state;
};
const fold = { type: "mutation", from: "card-delete-sync" };

Deno.test("deleting one card of an owned deck drops the card and its count, and the session keeps its place", async () => {
  const createSet = await load("create_set");
  const before = createSet(confirmed(deckOfFour(), "card-frutas-1") as any, fold as any).updates;
  assertEquals(before.map((u: Update) => [u.op, u.entity, u.id]), [
    ["delete", "card_delete", "card-frutas-1"], ["patch", "card_set", "set-frutas"], ["patch", "print_config", "press"], ["delete", "flashcard", "card-frutas-1"], ["patch", "play_session", "session"],
  ]);
  assertEquals(before[1].row, { count: 3 });
  // The card shown was third of four and is second of three: the same card, one position earlier.
  const shifted = before[4].row!;
  assertEquals([shifted.card_index, shifted.total, shifted.front, shifted.card_id], [1, 3, "Fruta 3", "card-frutas-3"]);
  // Deleting the card shown shows the next one at its position; deleting the last position shows the new last.
  const shown = createSet(confirmed(deckOfFour(), "card-frutas-3") as any, fold as any).updates.find((u: Update) => u.entity === "play_session")!.row!;
  assertEquals([shown.card_index, shown.front], [2, "Fruta 4"]);
  const last = deckOfFour();
  last.rows.play_session[0] = { ...last.rows.play_session[0], card_index: 3, front: "Fruta 4" };
  const tail = createSet(confirmed(last, "card-frutas-4") as any, fold as any).updates.find((u: Update) => u.entity === "play_session")!.row!;
  assertEquals([tail.card_index, tail.front], [2, "Fruta 3"]);
});

// A refused intent that stayed confirmed left the button red and inert.
Deno.test("a card is deleted only from a deck the reader owns, and never the deck's last card; a refused intent returns the button", async () => {
  const createSet = await load("create_set");
  const dropped = (id: string) => [{ op: "delete", entity: "card_delete", id }];
  assertEquals(createSet(confirmed(deckOfFour(), "capybara") as any, fold as any).updates, dropped("capybara"));
  const unowned = deckOfFour();
  unowned.rows.me = [{ id: "someone-else" }];
  assertEquals(createSet(confirmed(unowned, "card-frutas-1") as any, fold as any).updates, dropped("card-frutas-1"));
  const single = deckOfFour();
  single.rows.flashcard = single.rows.flashcard.filter((c) => c.id === "card-frutas-1" || c.id === "capybara");
  assertEquals(createSet(confirmed(single, "card-frutas-1") as any, fold as any).updates, dropped("card-frutas-1"));
  // An armed button is the chart's alone: the fold writes nothing until the second tap.
  const armed = deckOfFour();
  armed.rows.card_delete = [{ id: "card-frutas-1", state: "armed" }];
  assertEquals(createSet(armed as any, fold as any).updates, []);
});

// The job badge read "ready" while a level was still running: it now reads deck_level alone.
Deno.test("the job badge and the explore indicator read deck_level, and the delete control is in-page", async () => {
  const html = await screenMarkup("generate");
  const css = await Deno.readTextFile(new URL("../shell/screens/generate.css", import.meta.url));
  assertEquals(/data-art\d?=/.test(html) || css.includes("data-art"), false);
  const settled = '.gen-job-row:has(.deck-level-state[data-level="3"]):not(:has(.deck-level-state[data-state="running"]))';
  assertEquals(css.includes(`${settled}:not(:has(.deck-level-state:is([data-state="partial"], [data-state="failed"]))) .gen-job-badge-ready { display: inline; }`), true);
  assertEquals(css.includes(`${settled}:has(.deck-level-state:is([data-state="partial"], [data-state="failed"])) .gen-job-badge-incomplete { display: inline; }`), true);
  assertEquals(css.includes(`${settled} .gen-job-badge-ai { display: none; }`), true);
  assertEquals(css.includes(".gen-job-badge-ready, .gen-job-badge-incomplete { display: none; }"), true);
  // Progress is the bar's colour, not words: counts reach CSS as variables, and no level count is printed.
  const counts = 'style="--drawn: {drawn}; --failed: {failed}; --unknown: {unknown}; --total: {total}"';
  assertEquals(html.includes(counts), true);
  assertEquals(html.includes("gen_level_count") || html.includes("gen-job-levels"), false);
  assertEquals(css.includes("calc(var(--drawn) / var(--total) * 100%)"), true);
  for (const screen of ["explore", "card"]) {
    const page = await screenMarkup(screen);
    assertEquals(page.includes('data-live="deck_level" data-filter="set_id=eq.{id}&amp;status=eq.running"'), true);
    assertEquals(page.includes("gen_level_count"), false);
    assertEquals(page.includes('<details class="card-delete">'), false);
    assertEquals(page.includes("confirm("), false);
  }
});

// The delete box once asked its question in a native details disclosure; two taps on one
// styled button replace it, and the revert is the chart's own clock.
Deno.test("a card's delete button arms on one tap, confirms on the next and reverts after four seconds", async () => {
  for (const screen of ["explore", "card"]) {
    const page = await screenMarkup(screen);
    const chart = machineAttribute(page.match(/data-live="card_delete" data-filter="id=eq.\{id\}"[^>]*data-machine='([^']+)'/)![1]);
    deepStrictEqual(chart, { field: "state", initial: "idle", states: { idle: { on: { click: "armed" } }, armed: { after: { "4000": "idle" }, on: { click: "confirmed" } }, confirmed: {} } });
    assertEquals(page.includes('data-live="card_delete" data-filter="state=eq.confirmed"') && page.includes('data-on-mutation="create_set"'), true);
    assertEquals(page.includes('class="btn-delete-card"') && page.includes('aria-live="polite"'), true);
  }
  const css = await Deno.readTextFile(new URL("../shell/shared/card-art.css", import.meta.url));
  assertEquals(css.includes(".card-rail-item:not(:only-child) .card-delete { display: block; }"), true);
  // The screens listed the sheet among their shared files and never imported it, so the rail's
  // button, the edit sheet and the drawing bar drew unstyled.
  for (const screen of ["explore", "card"]) {
    const sheet = await Deno.readTextFile(new URL(`../shell/screens/${screen}.css`, import.meta.url));
    assertEquals(sheet.includes('@import url("shared/card-art.css");'), true);
  }
});

// The preview bound play_session, which create_set would not move during a generation, so it
// went on showing a deck explored before.
Deno.test("the generate preview binds the draft's deck, and the form names a title and details apart", async () => {
  const html = await screenMarkup("generate");
  assertEquals(html.includes('<aside class="generator-preview-panel" data-live="generation_form" data-filter="id=eq.draft"'), true);
  assertEquals(html.includes('data-live="play_session" data-filter="id=eq.session&amp;set_id=eq.{set_id}"'), true);
  assertEquals(html.includes('<input id="topic-input" type="text"') && html.includes('<textarea id="details-input" name="details"'), true);
  const createSet = await load("create_set");
  const details = "só bichos da Mata Atlântica";
  const created = createSet({ items: [{ id: "draft", topic: "Bichos", details, category: "", locale: "pt-BR", region: "Brasil", card_count: 5, status: "generating" }], rows: { deck_level: [], device: [DEVICE] } } as any, ASK).updates;
  const deck = created.find((u: Update) => u.entity === "card_set")!.row!;
  assertEquals([deck.name, deck.details], ["Bichos", details]);
  assertEquals(created.find((u: Update) => u.entity === "generation_form")!.row!.details, details);
  // No mutation moves the session onto a generated deck.
  const generating = { items: [], rows: { deck_level: [],
    generation_form: [{ id: "draft", topic: "Bichos", set_id: "set-bichos", status: "generating", next: 2 }],
    device: [DEVICE],
    card_set: [{ id: "set-bichos", name: "Bichos", count: 1, cover_emoji: "🎨" }],
    flashcard: [{ id: "card-bichos-1", set_id: "set-bichos", front: "Onça", emoji: "🐆", hint: "run-1", txid: "9" }],
    play_session: [{ id: "session", set_id: "set-other", card_index: 0, front: "Outro", emoji: "🦫" }],
    print_config: [{ id: "press", set_id: "set-bichos" }],
  } };
  assertEquals(createSet(generating as any, { type: "mutation" }).updates, []);
});

// The form was one public row every visitor shared: a fresh browser showed another reader's
// title and details, and a concurrent writer reverted a reader's card count. Then it was the
// tab's, and a reload mid-generation forgot the deck the server went on drawing.
Deno.test("the form lives in this browser's generation_form; only the device's own text slots reach the server", async () => {
  const shell = JSON.parse(await Deno.readTextFile(new URL("../shell/shell.json", import.meta.url)));
  assertEquals([shell.schema.generation_form.durability, shell.schema.device.durability], ["device", "device"]);
  assertEquals(Object.hasOwn(shell.access, "generation_form") || Object.hasOwn(shell.access, "device"), false);
  const createSet = await load("create_set");
  const form = { id: "draft", topic: "Moedas do mundo", details: "só moedas antigas", category: "", locale: "pt-BR", region: "Brasil", card_count: 5, status: "idle" };
  const edits = [
    { type: "click", from: "quick-animals", target: { dataset: { topic: "Animais Brasileiros", category: "Fauna" } } },
    { type: "keydown", key: "Tab", from: "region-input", value: "" },
  ];
  for (const event of edits) {
    const { updates } = createSet({ items: [form], rows: { deck_level: [], generation_form: [form], device: [DEVICE] } } as any, event as any);
    assertEquals(updates.length > 0 && updates.every((u: Update) => u.entity === "generation_form" && u.id === "draft"), true);
  }
  // A Create writes the deck under the device's key and leaves every slot to the server.
  const { updates } = createSet({ items: [form], rows: { deck_level: [], generation_form: [form], device: [DEVICE] } } as any, ASK);
  assertEquals(updates.some((u: Update) => u.entity === "generation_draft"), false);
  assertEquals(updates.find((u: Update) => u.entity === "generation_form")?.row?.set_id, DECK);
  assertEquals(updates.find((u: Update) => u.entity === "card_set")?.row?.device, KEY);
});

Deno.test("create_set mints the device's key from two draws, with its two idle slots, once", async () => {
  const createSet = await load("create_set");
  const form = { id: "draft", topic: "Moedas", category: "", locale: "pt-BR", region: "Brasil", card_count: 5, status: "idle" };
  const bare = { items: [form], rows: { deck_level: [], generation_form: [form], device: [], ...slotted([]), flashcard: [], card_set: [] } };
  for (const event of [{ type: "mutation" }, ASK]) {
    assertEquals(createSet(bare as any, event as any), { updates: [], then: { type: "mint-device", seed: true, ...(event === ASK ? { with: { intent: ASK.from, request: "ask" } } : {}) } });
  }
  // A Create that waited for the key was lost: nothing woke its seat once the key landed.
  const waiting = { items: [asking(form)], rows: { ...bare.rows, generation_form: [asking(form)] } };
  const resumed = createSet(waiting as any, { type: "mint-device", seed: 0x89abcdef, with: { draws: [0x01234567], intent: ASK.from, request: "ask" } } as any) as Reply & { then: unknown };
  assertEquals(resumed.then, { ...ASK, with: { request: "ask" } });
  // A region that does not read the device minted a fresh key on every wake, and the card
  // screen never settled.
  let refused = "";
  try { createSet({ items: [], rows: { deck_level: [], card_delete: [], flashcard: [] } } as any, { type: "mutation" }); } catch (e) { refused = String(e); }
  assertEquals(refused.includes("reads device"), true);
  for (const html of await Promise.all(["cards", "generate", "explore", "card", "deck", "print"].map((n) => screenMarkup(n)))) {
    for (const tag of html.match(/<[a-z]+ [^>]*data-on-mutation="create_set"[^>]*>/g) ?? []) assertEquals(/data-reads="[^"]*\bdevice\b/.test(tag), true);
  }
  const first = createSet(bare as any, { type: "mint-device", seed: 0x01234567 } as any) as Reply & { then: unknown };
  assertEquals(first, { updates: [], then: { type: "mint-device", seed: true, with: { draws: [0x01234567] } } });
  const minted = createSet(bare as any, { type: "mint-device", seed: 0x89abcdef, with: { draws: [0x01234567] } } as any).updates;
  const idle = (id: string) => ({ op: "put", entity: "generation_draft", id, row: { id }, absent: { topic: "", category: "", locale: "", region: "", card_count: 0, status: "idle", set_id: "", details: "" } });
  const keyRow = { op: "put", entity: "device", id: "device", row: { id: "device", key: KEY } };
  assertEquals(minted, [keyRow, idle(CHEAP), idle(HEAVY)]);
  // Regression: the theme chart's first write materialises the device region's fallback row,
  // {id: device, key: ""}; mint-device took any row for a minted one and a visitor who chose a
  // theme before their first deck never got a key. A keyless row is unminted and keeps its theme.
  const keyless = { ...bare, rows: { ...bare.rows, device: [{ id: "device", key: "", theme: "dark" }] } };
  const mintedOver = createSet(keyless as any, { type: "mint-device", seed: 0x89abcdef, with: { draws: [0x01234567] } } as any).updates;
  assertEquals(mintedOver[0], { op: "put", entity: "device", id: "device", row: { id: "device", key: KEY, theme: "dark" } });
  const keyed = { ...bare, rows: { ...bare.rows, device: [{ id: "device", key: KEY, theme: "dark" }] } };
  assertEquals(createSet(keyed as any, { type: "mint-device", seed: 0x89abcdef, with: { draws: [0x01234567] } } as any).updates, []);
  // Slots are server writes, and in the step they held every fresh guest's screen for their round trips.
  const raw = positional((0, eval)(await Deno.readTextFile(new URL("../shell/handlers/create_set.js", import.meta.url))));
  const behind = raw(bare, { type: "mint-device", seed: 0x89abcdef, with: { draws: [0x01234567] } });
  assertEquals(behind.updates, [keyRow]);
  assertEquals(behind.then, { type: "ensure-slots", delay: 1, with: { ids: [CHEAP, HEAVY] } });
  assertEquals(raw(bare, behind.then).updates, [idle(CHEAP), idle(HEAVY)]);
  const lost = { ...bare, rows: { ...bare.rows, device: [DEVICE] } };
  assertEquals(raw(lost, { type: "mutation" }).then, { type: "ensure-slots", delay: 1, with: { ids: [CHEAP, HEAVY] } });
  // A Create runs on its slots, so it does not wait for the screen.
  const asked = raw({ ...lost, rows: { ...lost.rows, generation_ask: [{ id: "ask" }] } }, { type: "mutation" });
  assertEquals(asked, { updates: [idle(CHEAP), idle(HEAVY)] });
  assertEquals(raw(waiting, { type: "mint-device", seed: 0x89abcdef, with: { draws: [0x01234567], intent: ASK.from, request: "ask" } }).updates.slice(0, 3), [idle(CHEAP), keyRow, idle(HEAVY)]);
  // A second chain that started before the first one's key landed writes nothing.
  assertEquals(createSet({ ...bare, rows: { ...bare.rows, device: [DEVICE] } } as any, { type: "mint-device", seed: 7, with: { draws: [8] } } as any).updates, []);
});

Deno.test("a tab translates and settles only on its own device's cheap slot", async () => {
  const select = bothSeats(composed((0, eval)(await Deno.readTextFile(new URL("../machines/play_select.js", import.meta.url)))));
  const create = await load("create_set");
  const deck = { id: "set-fr", name: "Animaux", category: "Nature", locale: "fr", count: 1 };
  const card = { id: "c1", set_id: deck.id, front: "Chat", hint: "", emoji: "🐈", txid: "9" };
  const session = { id: "session", set_id: deck.id, card_index: 0, front: "Chat", total: 1, status: "playing" };
  const machine = { execute: () => ({ state: { card_index: 0, total: 1, flipped: "no", mastered: 0, status: "playing" } }) };
  const other = { id: "fedcba9876543210:draft-cheap", status: "idle", txid: "41" };
  const mine = { id: CHEAP, status: "idle", txid: "42" };
  const ask = (drafts: unknown[]) => select({ items: [session], locale: "en", params: { deck: deck.id, card: "Chat" }, rows: { deck_level: [], play_session: [session], route_deck: [deck], route_cards: [card], card_set: [deck], flashcard: [card], device: [DEVICE], ...slotted(drafts)} } as any, { type: "mutation" }, machine as any).updates.filter((u: Update) => u.entity === "generation_draft");
  assertEquals(ask([other]), []);
  assertEquals(ask([other, mine]).map((u: Update) => [u.id, u.ifTxid]), [[CHEAP, "42"]]);
  // A slot read from the server carries its txid as a number; the guard is a string.
  assertEquals(ask([{ ...mine, txid: 42 }]).map((u: Update) => u.ifTxid), ["42"]);
  // Another device's finished translation is never applied or released by this tab.
  const done = { status: "done", txid: "43", topic: 'set-fr :: [TRANSLATE:en] :: {"name":"Animaux","category":"Nature","cards":["Chat"]}', category: '{"name":"Animals","category":"Nature","cards":["Cat"]}' };
  const settle = (drafts: unknown[]) => create({ items: [], rows: { deck_level: [], device: [DEVICE], ...slotted(drafts), flashcard: [card], card_set: [deck], play_session: [session], print_config: [] } } as any, { type: "mutation" }).updates;
  assertEquals(settle([{ ...other, ...done }, mine]), []);
  assertEquals(settle([{ ...mine, ...done }]).some((u: Update) => u.entity === "card_translation" && u.id === "c1:en"), true);
});

// Cortex owns the correlated progress connection; the materializer cannot race it by
// inferring a second lifecycle from whichever rows happened to wake the fold.
Deno.test("the materializer leaves backend progress to the invoked source", async () => {
  const createSet = await load("create_set");
  const form = { id: "draft", topic: "Frutas", status: "generating", set_id: "deck", run: "run-2", words: "running", next: 2 };
  const rows = { generation_form: [form], device: [DEVICE], ...slotted([{ id: CHEAP, status: "idle" }]), flashcard: [], card_set: [], deck_level: [], deck_progress: [{ id: "deck", run: "run-2", status: "done" }] };
  assertEquals(createSet({ items: [], rows } as any, { type: "mutation" }).updates, []);
  const html = await screenMarkup("generate");
  const chart = machineAttribute(/class="generator-form-panel[^>]*data-machine='([^']*)'/.exec(html)![1]);
  for (const end of ["done", "partial", "failed"]) {
    deepStrictEqual(chart.states.generating.on[`signal:deck_progress.${end}`], { target: end, assign: { next: 0, words: "complete" }, reenter: false });
  }
  for (const at of ["drawing2", "drawn2_complete", "drawn2_partial", "drawn2_failed"]) {
    deepStrictEqual(chart.states.generating.on[`signal:deck_progress.${at}`], { target: "generating", assign: { next: 3, words: "complete" }, reenter: false });
  }
  for (const at of ["drawing23", "drawing3_complete", "drawing3_partial", "drawing3_failed"]) {
    deepStrictEqual(chart.states.generating.on[`signal:deck_progress.${at}`], { target: "generating", assign: { next: 0, words: "complete" }, reenter: false });
  }
  deepStrictEqual(chart.states.generating.on["signal:deck_progress.drafting"], { target: "generating", assign: { next: 2 }, reenter: false });
  deepStrictEqual(chart.states.generating.on["signal:deck.removed"], { target: "idle", assign: { set_id: "", run: "" }, reenter: false });
});

// Level 1 read as finished before generation started: CSS inferred it from a level-2 row, and
// levels 2 and 3 had no bar until their art was enqueued.
Deno.test("every level's bar exists from submit: level 1 is the form's words, levels 2 and 3 deck_level's", async () => {
  const html = await screenMarkup("generate");
  assertEquals(html.includes('<span class="ai-tier-step" data-state="{words}"></span>'), true);
  for (const n of [2, 3]) assertEquals(html.includes(`<span class="ai-tier-step" data-live="deck_level" data-filter="id=eq.{set_id}:${n}"><template data-item><span class="ai-tier-fill" data-state="{status}"`), true);
  const css = await Deno.readTextFile(new URL("../shell/screens/generate.css", import.meta.url));
  assertEquals(css.includes(".deck-level-state[data-level=\"2\"]) .ai-tier"), false);
  const createSet = await load("create_set");
  const submit = createSet({ items: [{ id: "draft", topic: "Bichos", category: "", locale: "pt-BR", region: "Brasil", card_count: 5, status: "generating" }], rows: { deck_level: [], device: [DEVICE] } } as any, ASK).updates;
  // The browser seeds every card's words with the submit itself; level 2's text is next.
  assertEquals([submit.find((u: Update) => u.entity === "generation_form")!.row!.words, submit.find((u: Update) => u.entity === "generation_form")!.row!.next], ["complete", 2]);
});

// data-attr-* is no terminal attribute: it rendered as itself, so these labels reached no reader,
// and the leaks behind them went unseen. A stylesheet's words reach only the languages it spells.
Deno.test("screens bind real attributes, and a stylesheet's words reach every language", async () => {
  const messages = JSON.parse(await Deno.readTextFile(new URL("../messages/en.json", import.meta.url)));
  for (const screen of ["card", "cards", "explore", "generate", "print"]) {
    const html = await screenMarkup(screen);
    assertEquals(html.includes("data-attr-"), false);
    for (const key of [...html.matchAll(/data-label-[a-z0-9-]+="\{msg\.([a-z0-9_]+)\}"/g)].map((m) => m[1])) assertEquals(typeof messages[key], "string");
  }
  const print = await Deno.readTextFile(new URL("../shell/screens/print.css", import.meta.url));
  assertEquals(/-spec="[^"]+"\]::before \{ content: "[^"]*[A-Za-zÀ-ÿ]{3}/.test(print.replace(/\[data-paper-spec[^\n]*\n/g, "")), false);
});

// A quick pick wrote the same Portuguese title for every reader, whatever language they read in.
Deno.test("a quick pick and a Tab's default are in the reader's language", async () => {
  const createSet = await load("create_set");
  const form = { id: "draft", topic: "", category: "", locale: "", region: "", card_count: 5, status: "idle" };
  const read = (locale: string, event: object) => createSet({ items: [form], locale, rows: { deck_level: [], device: [DEVICE], generation_form: [form] } } as any, event as any).updates[0]?.row;
  assertEquals(read("en", { type: "click", from: "quick-animals" })?.topic, "Brazilian Animals");
  assertEquals(read("es", { type: "click", from: "quick-planets" })?.topic, "Planetas y Estrellas");
  assertEquals(read("pt", { type: "click", from: "quick-animals" })?.topic, "Animais Brasileiros");
  assertEquals(read("en", { type: "keydown", key: "Tab", from: "region-input", value: "" })?.region, "New York, USA");
  // A title it knows nothing about files under nothing in particular, not under the default's animals.
  const titled = { ...form, topic: "Planets and Stars" };
  assertEquals(createSet({ items: [titled], locale: "en", rows: { deck_level: [], device: [DEVICE], generation_form: [titled] } } as any, { type: "keydown", key: "Tab", from: "category-input", value: "" } as any).updates[0]?.row?.category, "Exploration");
});

// A Tab that filled a field used to stay on it; now it moves on, so going back with Shift+Tab
// would fill every empty field it passed.
Deno.test("Tab completes a field going forward only, the audience among them", async () => {
  const createSet = await load("create_set");
  const form = { id: "draft", topic: "Bichos", category: "", locale: "pt-BR", region: "Brasil", card_count: 5, status: "idle", audience_key: "", audience: "" };
  const tab = (from: string, shiftKey: boolean) => createSet({ items: [form], rows: { deck_level: [], device: [DEVICE], generation_form: [form] } } as any, { type: "keydown", key: "Tab", modified: shiftKey, from, value: "" } as any).updates;
  assertEquals(tab("category-input", true), []);
  assertEquals(tab("difficulty-select", true), []);
  assertEquals(tab("difficulty-select", false).map((u: Update) => u.row?.audience_key), ["diff_kids"]);
});

// Next waited on the next card's picture, 650 ms and more, where one already fetched showed in 95.
Deno.test("a move names the next card's picture, for the screen to fetch ahead of the click", async () => {
  const next = await load("play_next");
  const cards = ["a", "b", "c"].map((id) => ({ id, set_id: "d", front: id, back: `/img/${id}`, emoji: "x", hint: "" }));
  const session = { id: "session", set_id: "d", card_index: 0, total: 3, status: "playing" };
  const picture = (card_index: number) => next({ items: [{ ...session, card_index }], rows: { deck_level: [], flashcard: cards } } as any, { type: "click" }).updates.find((u: Update) => u.entity === "next_picture")?.row?.back;
  assertEquals([picture(0), picture(1)], ["/img/c", ""]);
  for (const screen of ["card", "explore"]) {
    assertEquals((await screenMarkup(screen)).includes('data-live="next_picture"'), true);
  }
});

// The form's chart idled it on every edit, and a form idled mid-generation never settled and hid
// its preview. A new topic does let the running deck go: the form then describes another one.
Deno.test("the form's chart: an edit waits for a running deck and sends an ended form back to idle", async () => {
  const html = await screenMarkup("generate");
  const chart = machineAttribute(/class="generator-form-panel[^>]*data-machine='([^']*)'/.exec(html)![1]);
  const arrows = (key: string) => [chart.on[key]].flat();
  const edits = Object.keys(chart.on).filter((k) => arrows(k).some((a) => a.raise === "edited"));
  // The count's three arrows (minus, plus, the typed field) among them.
  assertEquals(edits.length, 29);
  for (const key of edits) assertEquals(arrows(key).every((a) => a.target === undefined), true);
  const newDeck = Object.keys(chart.on).filter((k) => /^(input|keydown|click)@/.test(k) && !edits.includes(k));
  assertEquals(newDeck.every((k) => chart.on[k].target === "idle" && chart.on[k].assign.run === ""), true);
  const createMore = machineAttribute(/class="generated-banner-actions[^>]*data-machine='([^']*)'/.exec(html)![1]);
  assertEquals(createMore.on["click@btn-create-more"], { target: "idle", assign: { run: "" } });
  assertEquals(newDeck.filter((k) => !/^click@(quick|draft)-/.test(k)), ["input@topic-input", "keydown@topic-input"]);
  deepStrictEqual(chart.states.generating.on?.edited, undefined);
  deepStrictEqual(chart.states.idle.on?.edited, undefined);
  for (const end of ["done", "partial", "failed"]) {
    assertEquals(chart.states[end].on.edited, { target: "idle", assign: { run: "" } });
    assertEquals(chart.states[end].on["click@btn-create"], { target: "generating", assign: { set_id: "", run: "" }, effect: { op: "create", entity: "generation_ask", values: { set_id: "", run: "", input: { type: "generation-input" }, created_at: "{now}" } } });
  }
  // Every Create is a fresh request; a title never identifies a previous deck.
  deepStrictEqual(chart.states.generating.on["click@btn-create"], { target: "generating", assign: { set_id: "", run: "" }, effect: { op: "create", entity: "generation_ask", values: { set_id: "", run: "", input: { type: "generation-input" }, created_at: "{now}" } } });
});

// A modified Tab is a reader leaving backwards or switching away, and a "done" form went idle for it.
Deno.test("a chart's guards read the event as the control holds it", async () => {
  const guard = async (name: string) => positional((0, eval)(await Deno.readTextFile(new URL(`../shell/handlers/${name}.js`, import.meta.url))));
  const tabFill = await guard("tab-fill");
  const params = { key: "Tab", value: "" };
  assertEquals(tabFill({}, { key: "Tab", value: " " }, params), true);
  assertEquals(tabFill({}, { key: "Tab", value: "", modified: true }, params), false);
  assertEquals(tabFill({}, { key: "Tab", value: "Fauna" }, params), false);
  assertEquals(tabFill({}, { key: "a", value: "" }, params), false);
  const valueIs = await guard("value-is");
  assertEquals(valueIs({}, { value: " Author:Me " }, { value: "author:me" }), true);
  assertEquals(valueIs({}, { value: "solar" }, { value: "author:me" }), false);
  // The count an arrow steps or the field takes typed, held to the deck sizes
  // the form makes; a typed non-number keeps the count rather than blanking it.
  const countStep = await guard("count-step");
  const holding = (card_count: number) => ({ items: [{ card_count }] });
  assertEquals(countStep(holding(5), {}, { delta: -1 }), 4);
  assertEquals(countStep(holding(1), {}, { delta: -1 }), 1);
  assertEquals(countStep(holding(20), {}, { delta: 1 }), 20);
  assertEquals(countStep(holding(5), { value: "7" }, { delta: 0 }), 7);
  assertEquals(countStep(holding(5), { value: "99" }, { delta: 0 }), 20);
  assertEquals(countStep(holding(5), { value: "" }, { delta: 0 }), 5);
  assertEquals(countStep({ items: [] }, {}, { delta: 1 }), 6);
});

Deno.test("browser replies retain accepted deck and run identity even when the topic repeats", async () => {
  const source = await Deno.readTextFile(new URL("../shell/units/ai-browser/unit.js", import.meta.url));
  let receive: (event: unknown) => void;
  const messages: any[] = [];
  new Function("self", source)({ addEventListener: (_type: string, callback: (event: unknown) => void) => { receive = callback; }, postMessage: (message: unknown) => messages.push(message) });
  const props = { topic: "Animals", locale: "English", status: "generating", set_id: "deck-a", run: "run-1" };
  receive!({ data: { type: "pronto:props", props } });
  receive!({ data: { type: "pronto:props", props: { ...props, set_id: "deck-b", run: "run-2" } } });
  const replies = messages.filter((m) => m.name === "draft");
  assertEquals(replies.map((m) => [m.detail.set_id, m.detail.run]), [["deck-a", "run-1"], ["deck-b", "run-2"]]);
});

// Sign-in is the nav's alone: a modal copied into every screen drifted from the terminal's, so a
// screen offers only a guest's passkey, beside what it would keep. chrome_signout must never be
// mistranslated as "Sign in" / "Entrar".
Deno.test("no screen draws its own sign-in, every screen offers ⋯ for the routes a phone's bar leaves out, and generate offers a guest a passkey for its collections", async () => {
  const shell = JSON.parse(await Deno.readTextFile(new URL("../shell/shell.json", import.meta.url)));
  assertEquals(shell.auth?.providers, ["google"]);
  assertEquals(shell.hostDom?.["window-print"]?.src, "shell/hatches/window-print.js");
  for (const screen of ["cards", "generate", "explore", "card", "print", "about"]) {
    const html = await screenMarkup(screen);
    for (const own of ["login-modal", "btn-top-login", 'data-auth-action="passkey-signin"', "data-auth-provider"]) {
      if (html.includes(own)) throw new Error(`${screen} draws its own sign-in (${own})`);
    }
    assertEquals(html.includes('data-auth-action="passkey-register"'), screen === "generate");
    // On a phone the bar keeps Home, Create and Print; ⋯ opens the rest, each screen its own sheet
    // since a kept screen stays in the page.
    if (!html.includes(`popovertarget="more-sheet-${screen}"`) || !html.includes(`id="more-sheet-${screen}"`)) throw new Error(`${screen} has no ⋯ sheet`);
    for (const route of ['data-param-shelf="mine"', 'data-param-shelf="gallery"', 'data-route="about"']) {
      if (!html.includes(`class="more-link"`) || !html.includes(route)) throw new Error(`${screen}'s sheet does not link ${route}`);
    }
  }
  const generateCss = await Deno.readTextFile(new URL("../shell/screens/generate.css", import.meta.url));
  assertEquals(generateCss.includes('body[data-auth="guest"] .generated-deck-banner:has(.owned-generation) .keep-decks-offer'), true);

  assertEquals(JSON.stringify(shell.cortex).includes('"login":'), false);

  for (const loc of ["en", "pt", "es", "he", "zh"]) {
    const msg = JSON.parse(await Deno.readTextFile(new URL(`../messages/${loc}.json`, import.meta.url)));
    if (!msg.chrome_signout || msg.chrome_signout === msg.chrome_passkey || msg.chrome_signout === msg.chrome_signin) {
      throw new Error(`messages/${loc}.json mistranslates chrome_signout as sign-in (${JSON.stringify(msg.chrome_signout)})`);
    }
    if (!msg.chrome_signin_apple || !msg.login_apple_title || !msg.account_delete_title) {
      throw new Error(`messages/${loc}.json is missing Apple Sign-In or Account Deletion strings`);
    }
  }

  const { default: mount } = await import("../shell/hatches/window-print.js");
  let printed = 0;
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  g.window = { print: () => { printed++; } };
  try {
    let clickFn: (() => void) | undefined;
    const ac = new AbortController();
    mount(
      {
        querySelectorAll: (sel: string) =>
          sel.includes("#btn-window-print")
            ? [{ addEventListener: (_t: string, fn: () => void) => { clickFn = fn; } }]
            : [],
      },
      { signal: ac.signal },
    );
    clickFn?.();
    assertEquals(printed, 1);
    ac.abort();
  } finally {
    g.window = prevWindow;
  }
});

Deno.test("create_set stamps me.id as owner on newly created card_set and flashcard rows for offline ownership", async () => {
  const createSet = await load("create_set");
  const ownerId = "019a0000-0000-7000-8000-000000000042";
  const draft = { id: "draft", topic: "Capivaras", category: "Fauna", locale: "pt-BR", region: "Brasil", card_count: 2, status: "generating", set_id: "" };
  const res = createSet(
    {
      items: [draft],
      locale: "pt",
      rows: {
        deck_level: [],
        me: [{ id: ownerId }],
        generation_form: [draft],
        device: [DEVICE],
        ...slotted([
          { id: CHEAP, topic: "", category: "", locale: "pt-BR", region: "", card_count: 2, status: "idle" },
          { id: HEAVY, topic: "", category: "", locale: "pt-BR", region: "", card_count: 2, status: "idle" },
        ]),
        card_set: [],
        flashcard: [],
      },
    } as any,
    ASK as any,
  );
  const deckPut = res.updates.find((u: Update) => u.entity === "card_set");
  const cardPuts = res.updates.filter((u: Update) => u.entity === "flashcard");
  assertEquals((deckPut?.absent ?? deckPut?.row)?.owner, ownerId);
  assertEquals(cardPuts.length, 2);
  for (const cardPut of cardPuts) {
    assertEquals((cardPut.absent ?? cardPut.row)?.owner, ownerId);
  }
});
