import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createEdgeAirlock, type EdgeEffects } from "@bonisoft3/mecha/packages/mecha-edge/src/airlock.ts";
import { type DispatchedRun, dispatchRun } from "@bonisoft3/mecha/packages/mecha-edge/src/dispatch.ts";
import { cluster as cortexCluster } from "./cortex-cluster.ts";
import * as illustrate from "../effects/illustrate-card.js";

// The edge's own database and airlock: the release's files through the browser
// tier, the bounded enqueue migration, the edge airlock with the real
// illustrate-card handler, a Workers AI binding that answers level 2's images by
// prompt and translates by echoing (a redraw's description marked as English),
// and a Gemini endpoint that answers level 3's on production's AI_IMAGE_HEAVY
// route. Each image's prompt reaches the test as "<tier> <subject>…". The two
// text effects answer what each test hands them.
const app = fileURLToPath(new URL("../", import.meta.url));
const mecha = fileURLToPath(import.meta.resolve("@bonisoft3/mecha/"));
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const MOON = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const MOON_RESEEDED = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==";
// The blob plane the airlock stores each picture in; a card's back is the URL it is served at.
const PLANE = new Map<string, Uint8Array>();
const SERVED = "/img/insecure/plain/s3://test/";
const blobs = {
  put: (key: string, bytes: Uint8Array) => Promise.resolve(void PLANE.set(key, bytes)),
  get: (key: string) => PLANE.has(key) ? Promise.resolve(PLANE.get(key)!) : Promise.reject(new Error(`blob ${key} is not in the plane`)),
  url: (key: string) => `${SERVED}${key}`,
};
const stored = (back: string) => back.startsWith(SERVED) && PLANE.has(back.slice(SERVED.length));
// A device's key, its deck and its two text slots, as create_set writes them.
const KEY = "0123456789abcdef";
const DECK = `set-frutas-${KEY}`;
const CHEAP = `${KEY}:draft-cheap`;
const HEAVY = `${KEY}:draft-heavy`;
const WORDS = ["Caju", "Goiaba", "Manga"];
const cards = (_level: string) => JSON.stringify(WORDS.map((w) => ({ word: w, emoji: "🍎" })));

type Text = Record<string, unknown>;
type Images = (prompt: string) => string | Error;

async function cluster() {
  const db = await cortexCluster();
  const shell = JSON.parse(await Deno.readTextFile(new URL("../shell/shell.json", import.meta.url)));
  const declarations = JSON.parse(await Deno.readTextFile(new URL("../services/airlock/effects.json", import.meta.url))).effects;
  return { db, shell, declarations };
}

/** A device's two idle text slots, as create_set puts them when it mints the key. */
async function slots(db: Awaited<ReturnType<typeof cluster>>["db"], key: string) {
  for (const slot of ["draft-cheap", "draft-heavy"]) {
    await db.exec(`INSERT INTO generation_draft (id, topic, category, locale, region, card_count, status, set_id, details)
      VALUES ('${key}:${slot}', '', '', '', '', 0, 'idle', '', '') ON CONFLICT (id) DO NOTHING`);
  }
}

/** One deck of three cards as create_set writes it, on the device's slots. */
async function deck(db: Awaited<ReturnType<typeof cluster>>["db"], withSlots = true) {
  if (withSlots) await slots(db, KEY);
  await db.exec(`INSERT INTO card_set (id, name, category, locale, region, count, cover_emoji, device, audience_key)
    VALUES ('${DECK}', 'frutas', '#01 · Frutas', 'pt-BR', 'Brasil', 3, '🎨', '${KEY}', 'diff_kids')`);
  for (const [i] of WORDS.entries()) {
    await db.exec(`INSERT INTO flashcard (id, set_id, front, back, hint, difficulty, emoji, color)
      VALUES ('card-frutas-${KEY}-${i + 1}', '${DECK}', 'frutas #${i + 1}', '', 'run-1', 'easy', '🧭', '#FED7AA')`);
  }
}

/** The edge airlock's passes until no effect is owed. Graphile holds a failed attempt for its
 * backoff; each pass moves the clock past it, so no pass waits. */
async function run(ctx: Awaited<ReturnType<typeof cluster>>, text: Record<string, Text>, images: Images, calls: string[], models: Array<[string, unknown]> = []) {
  const effects: EdgeEffects = {
    "smollm3-draft": { declaration: ctx.declarations["smollm3-draft"], target: { kind: "tsbifrost" }, issue: () => text["smollm3-draft"] },
    "heavy-draft": { declaration: ctx.declarations["heavy-draft"], target: { kind: "tsbifrost" }, issue: () => text["heavy-draft"] },
    "illustrate-card": { declaration: ctx.declarations["illustrate-card"], target: { kind: "tsbifrost" }, issue: illustrate.issue },
  };
  const asked = (tier: string, prompt: string) => `${tier} ${prompt.replace(/^Subject: a single /, "")}`;
  const AI = {
    run: (model: string, input: { prompt: string; guidance?: number; messages?: { role: string; content: string }[] }) => {
      if (input.messages) {
        const words = JSON.parse(input.messages.at(-1)!.content);
        if (words.description) words.description = `English for ${words.description}`;
        return Promise.resolve({ response: JSON.stringify(words) });
      }
      const prompt = asked("cheap", input.prompt);
      calls.push(prompt);
      models.push([model, input.guidance]);
      const answer = images(prompt);
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve({ image: answer });
    },
  };
  const gemini = (url: string, init: { body: string }) => {
    const model = new URL(url).pathname.split("/").at(-1)!.split(":")[0];
    const prompt = asked("heavy", JSON.parse(init.body).contents[0].parts[0].text);
    calls.push(prompt);
    models.push([model, JSON.parse(init.body).generationConfig?.imageConfig?.aspectRatio]);
    const answer = images(prompt);
    return Promise.resolve(answer instanceof Error
      ? new Response(JSON.stringify({ error: { message: answer.message } }), { status: 400 })
      : Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: answer } }] } }] }));
  };
  for (let pass = 0; pass < 12; pass++) {
    const owed = await ctx.db.query("SELECT 1 FROM airlock.external_effect_ledger WHERE outcome IS NULL");
    if (owed.rows.length === 0) return;
    await ctx.db.exec("UPDATE graphile_worker._private_jobs SET run_at = now() WHERE locked_at IS NULL AND run_at > now()");
    // The object enqueues each run; the dispatcher Worker runs it and answers.
    const queued: DispatchedRun[] = [];
    const airlock = createEdgeAirlock({ db: ctx.db, serialize: (fn) => fn(), effects, dispatch: (run) => Promise.resolve(void queued.push(run)), log: () => {} });
    await airlock.drain();
    const object = { effectClaim: airlock.claim, effectAnswer: airlock.answer };
    for (const run of queued) await dispatchRun(object, effects, run, { ai: ctx.shell.ai, env: { AI, AI_IMAGE_HEAVY: "google", GEMINI_API_KEY: "test" }, fetcher: gemini as never, log: () => {}, blobs });
  }
  throw new Error("effects still owed after twelve passes");
}

const startCheap = (db: Awaited<ReturnType<typeof cluster>>["db"]) =>
  db.exec(`UPDATE generation_draft SET status = 'drafting', topic = 'frutas', set_id = '${DECK}', locale = 'pt-BR', region = 'Brasil :: run-1', card_count = 3 WHERE id = '${CHEAP}'`);
const startHeavy = (db: Awaited<ReturnType<typeof cluster>>["db"]) =>
  db.exec(`UPDATE generation_draft SET status = 'illustrating', topic = 'frutas', set_id = '${DECK}', locale = 'pt-BR', region = 'Brasil :: run-1', card_count = 3 WHERE id = '${HEAVY}'`);
const count = (db: Awaited<ReturnType<typeof cluster>>["db"]) => db.exec("SELECT snapcards_count_art()");
const levels = async (db: Awaited<ReturnType<typeof cluster>>["db"]) =>
  (await db.query<Record<string, unknown>>(`SELECT level, run, total, drawn, failed, unknown, pending, status FROM deck_level WHERE set_id = '${DECK}' ORDER BY level`)).rows;
// The deck's progress (DeckProgressMachine), which the deck-level drain moves from its levels.
const progress = async (db: Awaited<ReturnType<typeof cluster>>["db"]) =>
  (await db.query<{ run: string; status: string }>(`SELECT run, status FROM deck_progress WHERE id = '${DECK}'`)).rows[0];
const arts = async (db: Awaited<ReturnType<typeof cluster>>["db"]) =>
  (await db.query<{ id: string; status: string; detail: string }>(`SELECT id, status, detail FROM card_art ORDER BY id`)).rows;
const done = (prefix: string) => ({ done: { topic: "frutas", cards_json: cards(prefix) } });

// One effect drew the whole deck: a capacity refusal on one card retried all
// twenty through the backoff, and an NSFW refusal on another failed them all.
Deno.test("a refused card fails alone, a capacity retry re-runs only its own card, and the deck settles partial", async () => {
  const ctx = await cluster();
  try {
    await deck(ctx.db);
    const calls: string[] = [];
    let capacity = true;
    const images: Images = (prompt) => {
      if (prompt.includes("Goiaba")) return new Error("8007: Input prompt contains NSFW content.");
      if (prompt.startsWith("cheap Manga") && capacity) {
        capacity = false;
        return new Error("3040: Capacity temporarily exceeded, please try again.");
      }
      return PNG;
    };
    // A rewritten word drops the deck's translations, which were of the words it replaced.
    await ctx.db.exec(`INSERT INTO deck_translation (id, set_id, lang, name, category) VALUES ('${DECK}:en', '${DECK}', 'en', 'Fruits', '');
      INSERT INTO card_translation (id, card_id, set_id, lang, word) VALUES ('card-frutas-${KEY}-1:en', 'card-frutas-${KEY}-1', '${DECK}', 'en', 'fruit 1')`);
    await startCheap(ctx.db);
    await run(ctx, { "smollm3-draft": done("cheap"), "heavy-draft": done("heavy") }, images, calls);
    await count(ctx.db);
    assert.equal((await ctx.db.query(`SELECT 1 FROM deck_translation WHERE set_id = '${DECK}' UNION ALL SELECT 1 FROM card_translation WHERE set_id = '${DECK}'`)).rows.length, 0);
    const fronts = (await ctx.db.query<{ front: string; description: string }>(`SELECT front, description FROM flashcard WHERE set_id = '${DECK}' ORDER BY id`)).rows;
    assert.deepEqual(fronts.map((r) => r.front), WORDS);
    // The text levels write words alone: a card's description is the reader's to write.
    assert.deepEqual(fronts.map((r) => r.description), ["", "", ""]);
    assert.deepEqual(calls.filter((p) => p.startsWith("cheap ")).map((p) => p.split(".")[0]).sort(), ["cheap Caju", "cheap Goiaba", "cheap Manga", "cheap Manga"]);
    assert.deepEqual(calls.filter((p) => p.startsWith("heavy ")).map((p) => p.split(".")[0]).sort(), ["heavy Caju", "heavy Goiaba", "heavy Manga"]);
    const art = await arts(ctx.db);
    assert.deepEqual(art.map((a) => [a.id, a.status]), [
      [`card-frutas-${KEY}-1:2`, "drawn"], [`card-frutas-${KEY}-1:3`, "drawn"],
      [`card-frutas-${KEY}-2:2`, "failed"], [`card-frutas-${KEY}-2:3`, "failed"],
      [`card-frutas-${KEY}-3:2`, "drawn"], [`card-frutas-${KEY}-3:3`, "drawn"],
    ]);
    assert.ok(art.filter((a) => a.status === "failed").every((a) => JSON.parse(a.detail).code === "8007"));
    const backs = (await ctx.db.query<{ back: string }>(`SELECT back FROM flashcard WHERE set_id = '${DECK}' ORDER BY id`)).rows.map((r) => r.back);
    assert.ok([backs[0], backs[2]].every(stored));
    assert.ok(decodeURIComponent(backs[1]).includes('data-tier="tier-none"'));
    assert.deepEqual((await levels(ctx.db)).map((l) => [l.level, l.run, l.drawn, l.failed, l.status]), [[2, "run-1", 2, 1, "partial"], [3, "run-1", 2, 1, "partial"]]);
    assert.deepEqual(await progress(ctx.db), { run: "run-1", status: "partial" });
  } finally {
    await ctx.db.close();
  }
});

Deno.test("a card's level 3 starts when its own level 2 settles, and every card drawn settles the deck done", async () => {
  const ctx = await cluster();
  try {
    await deck(ctx.db);
    const calls: string[] = [];
    await startCheap(ctx.db);
    // The heavy text settles before any level-2 image is drawn.
    await ctx.db.exec(`UPDATE airlock.external_effect_ledger SET outcome = '${JSON.stringify({ target: "done", kind: "done", data: done("cheap").done, reconciled: false })}'::jsonb WHERE effect = 'smollm3-draft'`);
    await ctx.db.exec(`UPDATE generation_draft SET status = 'done' WHERE id = '${CHEAP}'`);
    await startHeavy(ctx.db);
    await ctx.db.exec(`UPDATE airlock.external_effect_ledger SET outcome = '${JSON.stringify({ target: "done", kind: "done", data: done("heavy").done, reconciled: false })}'::jsonb WHERE effect = 'heavy-draft'`);
    await ctx.db.exec(`UPDATE generation_draft SET status = 'done' WHERE id = '${HEAVY}'`);
    assert.deepEqual((await arts(ctx.db)).map((a) => [a.id, a.status]), [
      [`card-frutas-${KEY}-1:2`, "pending"], [`card-frutas-${KEY}-1:3`, "waiting"],
      [`card-frutas-${KEY}-2:2`, "pending"], [`card-frutas-${KEY}-2:3`, "waiting"],
      [`card-frutas-${KEY}-3:2`, "pending"], [`card-frutas-${KEY}-3:3`, "waiting"],
    ]);
    const models: Array<[string, unknown]> = [];
    await run(ctx, {}, () => PNG, calls, models);
    await count(ctx.db);
    assert.equal(calls.length, 6);
    // Level 3 is Gemini at the square the program asks for; level 2 stays on Workers AI.
    assert.deepEqual(models.toSorted(), [
      ...Array(3).fill(["@cf/black-forest-labs/flux-1-schnell", undefined]),
      ...Array(3).fill(["gemini-3.1-flash-lite-image", "1:1"]),
    ]);
    assert.deepEqual((await levels(ctx.db)).map((l) => [l.level, l.drawn, l.status]), [[2, 3, "complete"], [3, 3, "complete"]]);
    assert.deepEqual(await progress(ctx.db), { run: "run-1", status: "done" });
    // A second outcome for a run already fanned out restarted its rows, and re-entering
    // pending under the same key refused the whole settlement.
    const outcome = JSON.stringify({ kind: "done", data: done("cheap").done });
    await ctx.db.query("SELECT snapcards_fan_out_art($1, 'Brasil :: run-1', 2, $2::jsonb)", [DECK, outcome]);
    assert.deepEqual((await arts(ctx.db)).filter((a) => a.id.endsWith(":2")).map((a) => a.status), ["drawn", "drawn", "drawn"]);
    assert.equal((await ctx.db.query("SELECT 1 FROM airlock.external_effect_ledger WHERE effect = 'illustrate-card'")).rows.length, 6);
  } finally {
    await ctx.db.close();
  }
});

Deno.test("a refused text fails its level's cards, attempts run out as unknown, and a deck nothing drew settles failed", async () => {
  const ctx = await cluster();
  try {
    await deck(ctx.db);
    const calls: string[] = [];
    await startCheap(ctx.db);
    const text = { "smollm3-draft": { failed: { status: 400, topic: "frutas", detail: "refused" } }, "heavy-draft": done("heavy") };
    await run(ctx, text, () => new Error("3040: Capacity temporarily exceeded, please try again."), calls);
    await count(ctx.db);
    assert.equal(calls.length, 3 * 5);
    assert.deepEqual((await arts(ctx.db)).filter((a) => a.id.endsWith(":3")).map((a) => a.status), ["unknown", "unknown", "unknown"]);
    assert.deepEqual((await levels(ctx.db)).map((l) => [l.level, l.unknown, l.status]), [[2, 0, "failed"], [3, 3, "failed"]]);
    assert.deepEqual(await progress(ctx.db), { run: "run-1", status: "failed" });
  } finally {
    await ctx.db.close();
  }
});

Deno.test("counting art closes its facts read before deck-level actions change art", async () => {
  const ctx = await cluster();
  try {
    await deck(ctx.db);
    await ctx.db.query("SELECT snapcards_fan_out_art($1, 'Brasil :: run-1', 2, $2::jsonb)", [DECK, JSON.stringify({ kind: "done", data: done("cheap").done })]);
    await ctx.db.exec(`CREATE FUNCTION count_art_nested_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE card_art SET detail = detail || 'x' WHERE set_id = '${DECK}' AND detail NOT LIKE '%x'; RETURN NULL; END $$;
      CREATE TRIGGER count_art_nested_write AFTER INSERT OR UPDATE ON deck_level FOR EACH STATEMENT EXECUTE FUNCTION count_art_nested_write();`);
    await count(ctx.db);
    assert.deepEqual((await levels(ctx.db)).map((l) => [l.level, l.total]), [[2, 3]]);
    assert.ok((await arts(ctx.db)).every((a) => a.detail.endsWith("x")));
  } finally {
    await ctx.db.close();
  }
});

Deno.test("a deleted card leaves the counts and its settled art goes; the next call writes nothing", async () => {
  const ctx = await cluster();
  try {
    await deck(ctx.db);
    await startCheap(ctx.db);
    await run(ctx, { "smollm3-draft": done("cheap"), "heavy-draft": done("heavy") }, () => PNG, []);
    await count(ctx.db);
    await ctx.db.exec(`DELETE FROM flashcard WHERE id = 'card-frutas-${KEY}-2'`);
    await count(ctx.db);
    assert.deepEqual((await levels(ctx.db)).map((l) => [l.level, l.total, l.drawn]), [[2, 2, 2], [3, 2, 2]]);
    assert.deepEqual((await arts(ctx.db)).map((a) => a.id), [`card-frutas-${KEY}-1:2`, `card-frutas-${KEY}-1:3`, `card-frutas-${KEY}-3:2`, `card-frutas-${KEY}-3:3`]);
    const before = (await ctx.db.query<{ txid: string }>("SELECT txid::text FROM deck_level")).rows;
    await count(ctx.db);
    assert.deepEqual((await ctx.db.query<{ txid: string }>("SELECT txid::text FROM deck_level")).rows, before);
  } finally {
    await ctx.db.close();
  }
});

const backOf = async (db: Awaited<ReturnType<typeof cluster>>["db"], id: string) =>
  (await db.query<{ back: string; redraw: string }>(`SELECT back, redraw FROM flashcard WHERE id = '${id}'`)).rows[0];
const art3 = async (db: Awaited<ReturnType<typeof cluster>>["db"], id: string) =>
  (await db.query<{ status: string; redraws: number; description: string; run: string }>(`SELECT status, redraws, description, run FROM card_art WHERE id = '${id}:3'`)).rows[0];
const redraw = (db: Awaited<ReturnType<typeof cluster>>["db"], id: string, description: string) =>
  db.query("UPDATE flashcard SET description = $1, redraw = 'drawing' WHERE id = $2", [description, id]);

// A tab started each level from what it saw of deck_level, so a deck stalled whenever no
// tab of its author stayed open; the levels now start from the rows themselves.
Deno.test("deck-advance starts the cheap text once every card reached the server and the heavy text as the cheap one settles", async () => {
  const ctx = await cluster();
  try {
    await slots(ctx.db, KEY);
    await ctx.db.exec(`INSERT INTO card_set (id, name, details, category, locale, region, count, cover_emoji, device)
      VALUES ('${DECK}', 'frutas', 'só do cerrado', '#01 · Frutas', 'pt-BR', 'Brasil', 3, '🎨', '${KEY}')`);
    const cheap = async () => (await ctx.db.query<Record<string, unknown>>(`SELECT status, topic, details, set_id, region, card_count FROM generation_draft WHERE id = '${CHEAP}'`)).rows[0];
    for (const i of [1, 2]) {
      await ctx.db.exec(`INSERT INTO flashcard (id, set_id, front, back, hint, difficulty, emoji, color)
        VALUES ('card-frutas-${KEY}-${i}', '${DECK}', 'frutas #${i}', '', 'run-1', 'easy', '🧭', '#FED7AA')`);
    }
    await count(ctx.db);
    assert.notEqual((await cheap()).status, "drafting");
    await ctx.db.exec(`INSERT INTO flashcard (id, set_id, front, back, hint, difficulty, emoji, color)
      VALUES ('card-frutas-${KEY}-3', '${DECK}', 'frutas #3', '', 'run-1', 'easy', '🧭', '#FED7AA')`);
    await count(ctx.db);
    assert.deepEqual(await cheap(), { status: "drafting", topic: "frutas", details: "só do cerrado", set_id: DECK, region: "Brasil :: run-1", card_count: 3 });
    // A second call starts nothing twice.
    await count(ctx.db);
    assert.equal((await ctx.db.query("SELECT 1 FROM airlock.external_effect_ledger WHERE effect = 'smollm3-draft'")).rows.length, 1);
    const calls: string[] = [];
    await run(ctx, { "smollm3-draft": done("cheap"), "heavy-draft": done("heavy") }, () => PNG, calls);
    await count(ctx.db);
    const heavy = (await ctx.db.query<{ details: string; region: string }>(`SELECT details, region FROM generation_draft WHERE id = '${HEAVY}'`)).rows[0];
    assert.deepEqual(heavy, { details: "só do cerrado", region: "Brasil :: run-1" });
    assert.equal(calls.length, 6);
  } finally {
    await ctx.db.close();
  }
});

Deno.test("a deck waiting for the heavy slot starts once it frees", async () => {
  const ctx = await cluster();
  try {
    await deck(ctx.db);
    // Another deck's heavy text holds the slot while this deck's cheap text settles.
    await ctx.db.exec(`UPDATE generation_draft SET status = 'illustrating', topic = 'outra', set_id = 'set-outra', locale = 'pt-BR', region = 'run-1', card_count = 1 WHERE id = '${HEAVY}'`);
    await ctx.db.query("SELECT snapcards_fan_out_art($1, 'Brasil :: run-1', 2, $2::jsonb)", [DECK, JSON.stringify({ kind: "done", data: done("cheap").done })]);
    await count(ctx.db);
    assert.equal((await ctx.db.query<{ set_id: string }>(`SELECT set_id FROM generation_draft WHERE id = '${HEAVY}'`)).rows[0].set_id, "set-outra");
    await ctx.db.exec(`UPDATE airlock.external_effect_ledger SET outcome = '${JSON.stringify({ target: "done", kind: "done", data: { cards_json: "[]" }, reconciled: false })}'::jsonb WHERE effect = 'heavy-draft'`);
    await ctx.db.exec(`UPDATE generation_draft SET status = 'done' WHERE id = '${HEAVY}'`);
    await count(ctx.db);
    const heavy = (await ctx.db.query<Record<string, unknown>>(`SELECT status, set_id, region FROM generation_draft WHERE id = '${HEAVY}'`)).rows[0];
    assert.deepEqual(heavy, { status: "illustrating", set_id: DECK, region: "Brasil :: run-1" });
  } finally {
    await ctx.db.close();
  }
});

// Every visitor shared one cheap and one heavy slot: one device's deck waited on, and its
// translations rewrote, another's. Each device's decks now run on that device's own slots.
Deno.test("two devices generating the same title at once run on their own slots, never touch each other's rows, and both decks settle", async () => {
  const ctx = await cluster();
  try {
    const keys = [KEY, "fedcba9876543210"];
    const deckOf = (key: string) => `set-frutas-${key}`;
    // Every write to a slot, as the trigger chain leaves it.
    await ctx.db.exec(`CREATE TABLE slot_writes (id text, set_id text, status text);
      CREATE FUNCTION log_slot_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO slot_writes VALUES (NEW.id, NEW.set_id, NEW.status); RETURN NEW; END $$;
      CREATE TRIGGER log_slot_write AFTER INSERT OR UPDATE ON generation_draft FOR EACH ROW EXECUTE FUNCTION log_slot_write();`);
    for (const [n, key] of keys.entries()) {
      await slots(ctx.db, key);
      await ctx.db.exec(`INSERT INTO card_set (id, name, details, category, locale, region, count, cover_emoji, device)
        VALUES ('${deckOf(key)}', 'frutas', 'device ${n}', '#01 · Frutas', 'pt-BR', 'Brasil', 3, '🎨', '${key}')`);
      for (const [i] of WORDS.entries()) {
        await ctx.db.exec(`INSERT INTO flashcard (id, set_id, front, back, hint, difficulty, emoji, color)
          VALUES ('card-frutas-${key}-${i + 1}', '${deckOf(key)}', 'frutas #${i + 1}', '', 'run-1', 'easy', '🧭', '#FED7AA')`);
      }
    }
    await count(ctx.db);
    const slot = async (id: string) => (await ctx.db.query<Record<string, unknown>>(`SELECT status, set_id, details FROM generation_draft WHERE id = '${id}'`)).rows[0];
    for (const [n, key] of keys.entries()) {
      assert.deepEqual(await slot(`${key}:draft-cheap`), { status: "drafting", set_id: deckOf(key), details: `device ${n}` });
    }
    const calls: string[] = [];
    await run(ctx, { "smollm3-draft": done("cheap"), "heavy-draft": done("heavy") }, () => PNG, calls);
    await count(ctx.db);
    assert.equal(calls.length, keys.length * 6);
    for (const key of keys) {
      const settled = (await ctx.db.query<Record<string, unknown>>(`SELECT level, drawn, status FROM deck_level WHERE set_id = '${deckOf(key)}' ORDER BY level`)).rows;
      assert.deepEqual(settled.map((l) => [l.level, l.drawn, l.status]), [[2, 3, "complete"], [3, 3, "complete"]]);
      const art = (await ctx.db.query<{ id: string; set_id: string }>(`SELECT id, set_id FROM card_art WHERE set_id = '${deckOf(key)}' ORDER BY id`)).rows;
      assert.ok(art.length === 6 && art.every((a) => a.id.startsWith(`card-frutas-${key}-`)));
    }
    // A slot only ever named its own device's deck.
    const writes = (await ctx.db.query<{ id: string; set_id: string }>("SELECT id, set_id FROM slot_writes WHERE set_id <> ''")).rows;
    assert.ok(writes.length > 0);
    for (const w of writes) assert.equal(w.set_id, deckOf(w.id.split(":")[0]), JSON.stringify(w));
    // Each slot was its own effect key.
    const keyed = (await ctx.db.query<{ key: string }>("SELECT key FROM airlock.external_effect_ledger WHERE effect IN ('smollm3-draft', 'heavy-draft')")).rows;
    assert.equal(keyed.length, keys.length * 2);
  } finally {
    await ctx.db.close();
  }
});

// A tab's DB reset left its device holding a key whose slots were gone, so its decks never started.
Deno.test("a deck whose device's slots the database lost puts them back and starts", async () => {
  const ctx = await cluster();
  try {
    await deck(ctx.db, false);
    await count(ctx.db);
    const rows = (await ctx.db.query<Record<string, unknown>>("SELECT id, status, set_id FROM generation_draft ORDER BY id")).rows;
    assert.deepEqual(rows, [
      { id: CHEAP, status: "drafting", set_id: DECK },
      { id: HEAVY, status: "idle", set_id: "" },
    ]);
  } finally {
    await ctx.db.close();
  }
});

// The edit sheet's "Gerar de novo": a new run of the card's level-3 effect from the reader's
// description, drawn as written; the card's art changes only when it is drawn.
Deno.test("a redraw draws the reader's description as a new run of the card's level 3 and replaces its art; a refusal keeps the art", async () => {
  const ctx = await cluster();
  try {
    await deck(ctx.db);
    await startCheap(ctx.db);
    const calls: string[] = [];
    // A new seed draws other bytes; the plane keys a drawing by its bytes, so the
    // same text drawn twice settles a new URL only when the drawing differs.
    let moons = 0;
    const images: Images = (prompt) => prompt.includes("NSFW") ? new Error("8007: Input prompt contains NSFW content.") : prompt.includes("ao luar") ? [MOON, MOON_RESEEDED][moons++ % 2] : PNG;
    await run(ctx, { "smollm3-draft": done("cheap"), "heavy-draft": done("heavy") }, images, calls);
    const first = await backOf(ctx.db, `card-frutas-${KEY}-1`);

    await redraw(ctx.db, `card-frutas-${KEY}-1`, "Um caju ao luar");
    assert.deepEqual(await art3(ctx.db, `card-frutas-${KEY}-1`), { status: "pending", redraws: 1, description: "Um caju ao luar", run: "run-1" });
    await run(ctx, {}, images, calls);
    assert.ok(calls.at(-1)!.includes(": Um caju ao luar. Context:"));
    const drawn = await backOf(ctx.db, `card-frutas-${KEY}-1`);
    assert.ok(stored(drawn.back) && drawn.back !== first.back);
    assert.equal(drawn.redraw, "settled");
    assert.equal((await art3(ctx.db, `card-frutas-${KEY}-1`)).status, "drawn");

    // The same text again is still a new run, drawn at a new seed.
    await redraw(ctx.db, `card-frutas-${KEY}-1`, "Um caju ao luar");
    assert.equal((await art3(ctx.db, `card-frutas-${KEY}-1`)).redraws, 2);
    await run(ctx, {}, images, calls);
    assert.equal((await ctx.db.query(`SELECT 1 FROM airlock.external_effect_ledger WHERE effect = 'illustrate-card' AND key LIKE '%card-frutas-${KEY}-1:3%'`)).rows.length, 3);

    // A refused redraw fails the row and settles the card with the art it had.
    const had = (await backOf(ctx.db, `card-frutas-${KEY}-1`)).back;
    assert.ok(stored(had) && had !== drawn.back);
    await redraw(ctx.db, `card-frutas-${KEY}-1`, "NSFW caju");
    await run(ctx, {}, images, calls);
    const refused = await art3(ctx.db, `card-frutas-${KEY}-1`);
    assert.equal(refused.status, "failed");
    assert.equal((await backOf(ctx.db, `card-frutas-${KEY}-1`)).back, had);
    // The reader may redraw a failed card again.
    await redraw(ctx.db, `card-frutas-${KEY}-1`, "Um caju ao luar");
    assert.equal((await art3(ctx.db, `card-frutas-${KEY}-1`)).status, "pending");
  } finally {
    await ctx.db.close();
  }
});

Deno.test("a redraw is refused while the card's level 3 has not settled", async () => {
  const ctx = await cluster();
  try {
    await deck(ctx.db);
    await startCheap(ctx.db);
    await ctx.db.exec(`UPDATE airlock.external_effect_ledger SET outcome = '${JSON.stringify({ target: "done", kind: "done", data: done("cheap").done, reconciled: false })}'::jsonb WHERE effect = 'smollm3-draft'`);
    await ctx.db.exec(`UPDATE generation_draft SET status = 'done' WHERE id = '${CHEAP}'`);
    // Level 3 has no rows yet, and then waits on its level 2.
    await assert.rejects(() => redraw(ctx.db, `card-frutas-${KEY}-1`, "Um caju"), /guard failed/);
    await ctx.db.exec(`UPDATE airlock.external_effect_ledger SET outcome = '${JSON.stringify({ target: "done", kind: "done", data: done("heavy").done, reconciled: false })}'::jsonb WHERE effect = 'heavy-draft'`);
    await ctx.db.exec(`UPDATE generation_draft SET status = 'done' WHERE id = '${HEAVY}'`);
    assert.equal((await art3(ctx.db, `card-frutas-${KEY}-1`)).status, "waiting");
    await assert.rejects(() => redraw(ctx.db, `card-frutas-${KEY}-1`, "Um caju"), /guard failed/);
    assert.equal((await backOf(ctx.db, `card-frutas-${KEY}-1`)).redraw, "settled");
  } finally {
    await ctx.db.close();
  }
});

// A slot's set_id is any reader's to write, and generated ids look like curated ones, so the
// shape of an id could not keep a slot's outcome off a curated deck's words.
Deno.test("a curated deck takes no fan-out", async () => {
  const ctx = await cluster();
  try {
    await ctx.db.exec(`INSERT INTO card_set (id, name, category, locale, region, count, cover_emoji)
      VALUES ('curated', 'Curated', 'Cat', 'pt-BR', 'Brasil', 1, '📚')`);
    await assert.rejects(
      ctx.db.query(`SELECT snapcards_fan_out_art('curated', 'Brasil :: run-1', 3, '{"kind":"done","data":{"cards_json":"[]"}}'::jsonb)`),
      /art fan-out needs a generated deck/,
    );
  } finally {
    await ctx.db.close();
  }
});

// The number was a browser's count over the decks it could see, so two tabs took the same
// one and every reader's first deck continued someone else's sequence.
Deno.test("a deck's number counts its owner's decks alone, and a deck with no owner has none", async () => {
  const ctx = await cluster();
  try {
    const [ann, bob] = ["7c9e6679-7425-40de-944b-e07fc1f90ae7", "16fd2706-8baf-433b-82eb-8c7fada847da"];
    await ctx.db.query("INSERT INTO app_user (id, handle) VALUES ($1, 'ann'), ($2, 'bob')", [ann, bob]);
    const insert = (id: string, owner: string | null) => ctx.db.query(
      "INSERT INTO card_set (id, name, category, locale, region, count, cover_emoji, owner) VALUES ($1, 'Deck', 'Cat', 'pt-BR', 'Brasil', 1, '🎨', $2)", [id, owner]);
    for (const [id, owner] of [["a1", ann], ["a2", ann], ["b1", bob], ["a3", ann], ["c1", null]] as const) await insert(id, owner);
    const { rows } = await ctx.db.query<{ id: string; number: number }>("SELECT id, number FROM card_set WHERE id IN ('a1','a2','a3','b1','c1') ORDER BY id");
    assert.deepEqual(rows.map((r) => [r.id, r.number]), [["a1", 1], ["a2", 2], ["a3", 3], ["b1", 1], ["c1", 0]]);
    // A deleted deck's number is not a hole the next one fills under the highest.
    await ctx.db.query("DELETE FROM card_set WHERE id = 'a2'");
    await insert("a4", ann);
    assert.equal((await ctx.db.query<{ number: number }>("SELECT number FROM card_set WHERE id = 'a4'")).rows[0].number, 4);
  } finally {
    await ctx.db.close();
  }
});

Deno.test("Cortex starts and completes generation from stored cards without a browser wake", async () => {
  const ctx = await cluster();
  try {
    await deck(ctx.db);
    const textSlot = await ctx.db.query<{ status: string; set_id: string }>("SELECT status, set_id FROM generation_draft WHERE id = $1", [CHEAP]);
    assert.deepEqual(textSlot.rows, [{ status: "drafting", set_id: DECK }]);
    await run(ctx, { "smollm3-draft": done("cheap"), "heavy-draft": done("heavy") }, () => PNG, []);
    await count(ctx.db);
    assert.deepEqual(await progress(ctx.db), { run: "run-1", status: "done" });
    assert.deepEqual((await levels(ctx.db)).map(({ level, total, drawn, pending }) => ({ level, total, drawn, pending })),
      [2, 3].map((level) => ({ level, total: 3, drawn: 3, pending: 0 })));
    const effects = (await ctx.db.query("SELECT key FROM airlock.external_effect_ledger ORDER BY key")).rows;
    await ctx.db.exec("SELECT snapcards_advance_decks(); SELECT snapcards_advance_decks()");
    assert.deepEqual((await ctx.db.query("SELECT key FROM airlock.external_effect_ledger ORDER BY key")).rows, effects);
  } finally {
    await ctx.db.close();
  }
});
