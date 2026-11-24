import assert from "node:assert/strict";
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";

// A composed handler's module is handed its machines as the second argument.
// deno-lint-ignore no-explicit-any
const composed = (leaf: any) => (state: any, event?: any, machine?: any, machines?: any) => leaf({ context: state, event }, { machine, machines });

// The screens read a device's two draft slots by id, each under its own name.
const slotted = (drafts: any[]) => ({
  draft_cheap: drafts.filter((d) => String(d?.id ?? "").endsWith(":draft-cheap")),
  draft_heavy: drafts.filter((d) => String(d?.id ?? "").endsWith(":draft-heavy")),
});

const appDir = new URL("../", import.meta.url);
const mechaDir = import.meta.resolve("@bonisoft3/mecha/");
const readApp = (p: string) => Deno.readTextFile(new URL(p, appDir));
const readMecha = (p: string) => Deno.readTextFile(new URL(p, mechaDir));

// 010_machines.sql over the tables its other machines name, and the fan-out a
// settled text calls; a translation names no deck, so it fans nothing out, and
// these tables hold no deck for the advance it calls (card-art.test.ts covers it).
const machines = async () => `
  ${await readMecha("services/database/rls/rls.sql")}
  CREATE TABLE card_art (id text PRIMARY KEY, status text);
  CREATE TABLE deck_level (id text PRIMARY KEY, status text);
  CREATE TABLE deck_progress (id text PRIMARY KEY, run text, status text);
  CREATE TABLE flashcard (id text PRIMARY KEY, redraw text);
  CREATE TABLE card_set (id text PRIMARY KEY, audience_key text DEFAULT '', audience text DEFAULT '');
  CREATE FUNCTION snapcards_advance_decks() RETURNS void LANGUAGE sql AS 'SELECT';
  ${await readApp("services/database/sql/017_card_art_fan_out.sql")}
  ${(await readApp("migrations/20261105_cortex_generation.sql")).split("-- services/database/migrations/010_machines.sql\n")[1].split("-- services/database/sql/017_card_art_fan_out.sql\n")[0]}`;
// A device's key, which names its two text slots.
const KEY = "0123456789abcdef";

Deno.test("long heavy-text topics enqueue with bounded keys and intact ledger inputs", async () => {
  const db = new PGlite();
  try {
    await db.exec(await readMecha("services/durex/graphile.sql"));
    await db.exec(await readMecha("services/ticker/schedule.sql"));
    await db.exec(await readMecha("services/airlock/airlock.sql"));
    await db.exec(`CREATE TABLE generation_draft (id text PRIMARY KEY, topic text, locale text, region text, status text, category text, card_count integer, set_id text DEFAULT '', details text DEFAULT '');`);
    await db.exec(await machines());
    await db.exec(`INSERT INTO generation_draft VALUES ('${KEY}:draft-heavy', '', 'pt-BR', 'run-1', 'idle', '', 5)`);
    const topic = "Instrumentos Musicais :: " + "A detailed musical instrument on a white background. ".repeat(30);
    await assert.rejects(() => db.query(`UPDATE generation_draft SET status='illustrating', topic=$1 WHERE id='${KEY}:draft-heavy'`, [topic]), /jobs_key_check/);
    const exported = await new Deno.Command("cue", { args: ["export", "effect-queue.cue", "-e", 'code.state.migrations["20261028_bounded_effect_jobs"].operations[0].sql.up', "--out", "text"], cwd: new URL("../", import.meta.url), stdout: "piped", stderr: "piped" }).output();
    assert.ok(exported.success, new TextDecoder().decode(exported.stderr));
    await db.exec(new TextDecoder().decode(exported.stdout));
    await db.query(`UPDATE generation_draft SET status='illustrating', topic=$1 WHERE id='${KEY}:draft-heavy'`, [topic]);
    const { rows } = await db.query<{ key: string; topic: string; payload_key: string; ledger_key: string }>(`SELECT j.key, l.input->>'topic' AS topic, j.payload->>'key' AS payload_key, l.key AS ledger_key FROM graphile_worker._private_jobs j JOIN airlock.external_effect_ledger l ON j.payload->>'key'=l.key`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key.length, 64);
    assert.equal(rows[0].topic, topic);
    assert.equal(rows[0].payload_key, rows[0].ledger_key);
  } finally {
    await db.close();
  }
});

Deno.test("translation attempts share a committed revision and survive region resets", async () => {
  const db = new PGlite();
  const select = composed((0, eval)(await readApp("machines/play_select.js")));
  try {
    await db.exec(await readMecha("services/durex/graphile.sql"));
    await db.exec(await readMecha("services/ticker/schedule.sql"));
    await db.exec(await readMecha("services/airlock/airlock.sql"));
    await db.exec(`CREATE TABLE generation_draft (id text PRIMARY KEY, topic text, locale text, region text, status text, category text, card_count integer, txid bigint DEFAULT pg_current_xact_id()::text::bigint);
      CREATE FUNCTION restamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.txid := pg_current_xact_id()::text::bigint; RETURN NEW; END $$;
      CREATE TRIGGER restamp BEFORE UPDATE ON generation_draft FOR EACH ROW EXECUTE FUNCTION restamp();
      ALTER TABLE generation_draft ADD COLUMN set_id text DEFAULT '';
      ALTER TABLE generation_draft ADD COLUMN details text DEFAULT '';`);
    await db.exec(await machines());
    await db.exec(`INSERT INTO generation_draft VALUES ('${KEY}:draft-cheap', '', 'en', '', 'idle', '', 1)`);
    const request = async (lang = "pt") => {
      const draft = (await db.query<Record<string, unknown>>(`SELECT * FROM generation_draft WHERE id='${KEY}:draft-cheap'`)).rows[0];
      draft.txid = String(draft.txid);
      const session = { id: "session", set_id: "set-x", card_index: 0 };
      return select({ items: [session], locale: lang, rows: {
        device: [{ id: "device", key: KEY }], ...slotted([draft]), card_set: [{ id: "set-x", name: "Pets", category: "", locale: "en", count: 1 }],
        flashcard: [{ id: "c1", set_id: "set-x", front: "Cat", hint: "" }], play_session: [session],
      } }, { type: "mutation", from: "translation-asks" }, { execute: () => ({ state: { card_index: 0, total: 1, status: "playing", flipped: "no", mastered: 0 } }) }).then?.with.update;
    };
    const write = (update: { ifTxid: string; row: Record<string, unknown> }) => {
      const row = update.row;
      return db.query(`UPDATE generation_draft SET status=$1, topic=$2, locale=$3, region=$4, card_count=$5 WHERE id='${KEY}:draft-cheap' AND txid=$6 RETURNING id`, [row.status, row.topic, row.locale, row.region, row.card_count, update.ifTxid]);
    };
    const first = await request();
    const competing = await request("es");
    assert.deepEqual(await request(), first);
    assert.equal(first.ifTxid, competing.ifTxid);
    assert.equal((await write(first)).rows.length, 1);
    assert.equal((await write(first)).rows.length, 0);
    assert.equal((await write(competing)).rows.length, 0);
    assert.equal((await db.query("SELECT * FROM airlock.external_effect_ledger")).rows.length, 1);
    await db.exec(`UPDATE airlock.external_effect_ledger SET outcome='{"target":"failed","kind":"failed","data":{}}';
      UPDATE generation_draft SET status='failed' WHERE id='${KEY}:draft-cheap';`);
    const completed = (await db.query<{ txid: string }>(`SELECT txid::text FROM generation_draft WHERE id='${KEY}:draft-cheap'`)).rows[0];
    await db.exec(`UPDATE generation_draft SET status='idle', topic='', region='' WHERE id='${KEY}:draft-cheap'`);
    const next = await request();
    assert.equal(next.row.topic, first.row.topic);
    assert.notEqual(next.row.region, first.row.region);
    assert.equal((await write(next)).rows.length, 1);
    const staleSettlement = await db.query(`UPDATE generation_draft SET status='idle', category='' WHERE id='${KEY}:draft-cheap' AND txid=$1 RETURNING id`, [completed.txid]);
    assert.equal(staleSettlement.rows.length, 0);
    assert.equal((await db.query<{ status: string }>(`SELECT status FROM generation_draft WHERE id='${KEY}:draft-cheap'`)).rows[0].status, "drafting");
    assert.equal((await db.query("SELECT * FROM airlock.external_effect_ledger")).rows.length, 2);
  } finally {
    await db.close();
  }
});
