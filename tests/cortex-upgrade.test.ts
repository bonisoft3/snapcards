import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { baselineCluster, upgrade } from "./cortex-cluster.ts";

Deno.test("the Cortex cutover preserves existing decks, active effects, and their jobs", async () => {
  const db = await baselineCluster();
  try {
    await db.exec(`INSERT INTO card_set (id, name, category, locale, region, count, cover_emoji, device, audience_key)
      VALUES ('kept', 'Kept', 'Animals', 'en', 'US', 2, '🍎', '0123456789abcdef', 'diff_kids'),
      ('cheap-only', 'Kept too', 'Animals', 'en', 'US', 2, '🍎', 'abcdef0123456789', 'diff_kids');
      INSERT INTO generation_draft (id, topic, category, locale, region, card_count, status, set_id, details)
      VALUES ('abcdef0123456789:draft-cheap', '', '', 'en', '', 0, 'idle', '', '');
      INSERT INTO flashcard (id, set_id, front, back, hint, difficulty, emoji, color)
      VALUES ('kept-card', 'kept', 'Cat', '', 'run-1', 'easy', '🐈', '#FED7AA');
      INSERT INTO generation_draft (id, topic, category, locale, region, card_count, status, set_id, details)
      VALUES ('0123456789abcdef:draft-heavy', '', '', 'en', '', 0, 'idle', '', '');
      UPDATE generation_draft SET status='illustrating', topic='Pending', region='run-9', card_count=1
      WHERE id='0123456789abcdef:draft-heavy';`);
    const read = async (sql: string) => (await db.query(sql)).rows;
    const cards = await read("SELECT id, set_id, front, back, hint FROM flashcard WHERE id='kept-card'");
    const decks = await read("SELECT id, name, device FROM card_set WHERE id='kept'");
    const ledger = await read("SELECT key, effect, input, outcome FROM airlock.external_effect_ledger ORDER BY key");
    const jobs = await read("SELECT key, payload FROM graphile_worker._private_jobs ORDER BY key");
    assert.equal(ledger.length, 1);
    assert.equal(jobs.length, 1);
    await upgrade(db);
    assert.deepEqual(await read("SELECT id, set_id, front, back, hint FROM flashcard WHERE id='kept-card'"), cards);
    assert.deepEqual(await read("SELECT id, name, device FROM card_set WHERE id='kept'"), decks);
    assert.deepEqual(await read("SELECT key, effect, input, outcome FROM airlock.external_effect_ledger ORDER BY key"), ledger);
    assert.deepEqual(await read("SELECT key, payload FROM graphile_worker._private_jobs ORDER BY key"), jobs);
    assert.deepEqual(await read("SELECT id FROM generation_draft WHERE id LIKE '0123456789abcdef:draft-%' ORDER BY id"),
      [{ id: "0123456789abcdef:draft-cheap" }, { id: "0123456789abcdef:draft-heavy" }]);
    assert.deepEqual(await read("SELECT id FROM generation_draft WHERE id LIKE 'abcdef0123456789:draft-%' ORDER BY id"),
      [{ id: "abcdef0123456789:draft-cheap" }, { id: "abcdef0123456789:draft-heavy" }]);
    assert.equal((await read("SELECT id FROM deck_progress WHERE id='kept'")).length, 1);
    await db.exec("UPDATE airlock.external_effect_ledger SET outcome='{\"target\":\"failed\",\"kind\":\"failed\",\"data\":{}}' WHERE effect='heavy-draft'; UPDATE generation_draft SET status='failed' WHERE id='0123456789abcdef:draft-heavy'");
    assert.deepEqual(await read("SELECT status FROM generation_draft WHERE id='0123456789abcdef:draft-heavy'"), [{ status: "failed" }]);
    await db.exec("UPDATE generation_draft SET status='idle' WHERE id='0123456789abcdef:draft-heavy'");
    const longTopic = "a detailed subject ".repeat(90);
    await db.query("UPDATE generation_draft SET status='illustrating', topic=$1, region='run-10' WHERE id='0123456789abcdef:draft-heavy'", [longTopic]);
    const newJob = await db.query<{ key: string }>("SELECT j.key FROM graphile_worker._private_jobs j JOIN airlock.external_effect_ledger l ON j.payload->>'key'=l.key WHERE l.input->>'topic'=$1", [longTopic]);
    assert.equal(newJob.rows.length, 1);
    assert.equal(newJob.rows[0].key.length, 64);
  } finally {
    await db.close();
  }
});

Deno.test("a failed Cortex cutover rolls back without changing retained data", async () => {
  const db = await baselineCluster();
  try {
    await db.exec(`INSERT INTO card_set (id, name, category, locale, region, count, cover_emoji, device, audience_key)
      VALUES ('rollback-deck', 'Kept', 'Animals', 'en', 'US', 2, '🍎', 'fedcba9876543210', 'diff_kids')`);
    const sql = await Deno.readTextFile(new URL("../migrations/20261105_cortex_generation.sql", import.meta.url));
    await assert.rejects(() => db.exec(`BEGIN; ${sql}\nSELECT 1 / 0; COMMIT;`));
    await db.exec("ROLLBACK");
    assert.deepEqual((await db.query("SELECT id, name FROM card_set WHERE id='rollback-deck'")).rows, [{ id: "rollback-deck", name: "Kept" }]);
    assert.deepEqual((await db.query("SELECT to_regnamespace('cortex_runtime') AS runtime")).rows, [{ runtime: null }]);
    await upgrade(db);
    assert.equal((await db.query("SELECT id FROM deck_progress WHERE id='rollback-deck'")).rows.length, 1);
  } finally {
    await db.close();
  }
});

Deno.test("a kept edge directory accepts the cutover and records a no-op replay", async () => {
  const { baselineScripts, boundedSql } = await import("./cortex-cluster.ts");
  const { applyScripts, recordScripts } = await import("@bonisoft3/mecha/packages/pglite-workerd/scripts.ts");
  const db = await baselineCluster();
  try {
    await db.exec(`INSERT INTO card_set (id, name, category, locale, region, count, cover_emoji, device, audience_key)
      VALUES ('edge-kept', 'Kept', 'Animals', 'en', 'US', 2, '🍎', '0011223344556677', 'diff_kids')`);
    const old = [...await baselineScripts(), { name: "20261028_bounded_effect_jobs", sql: await boundedSql() }];
    await recordScripts(db, old);
    const upgradeSql = await Deno.readTextFile(new URL("../migrations/20261105_cortex_generation.sql", import.meta.url));
    const next = [...old, { name: "20261105_cortex_generation", sql: upgradeSql }];
    assert.deepEqual(await applyScripts(db, next, () => {}), ["20261105_cortex_generation"]);
    assert.deepEqual(await applyScripts(db, next, () => {}), []);
    const carried = [...next, { name: "20261113_origin_reducers", sql: await Deno.readTextFile(new URL("../migrations/20261113_origin_reducers.sql", import.meta.url)) }];
    assert.deepEqual(await applyScripts(db, carried, () => {}), ["20261113_origin_reducers"]);
    assert.deepEqual(await applyScripts(db, carried, () => {}), []);
    // The one PGlite session serves requests and the airlock alike. A request
    // sets its claims LOCAL; once its transaction ends the setting reads back
    // as '' rather than NULL, and the released reducer's ''::json refused every
    // move the airlock made afterwards, so no deck generated (2026-11-14).
    await db.transaction(async (tx) => {
      await tx.exec(`SELECT set_config('request.jwt.claims', '{"role":"app_user","sub":"00000000-0000-4000-8000-000000000001"}', true)`);
    });
    const move = `UPDATE generation_draft SET status = 'illustrating', topic = 'Kept', region = 'run-1', card_count = 2, set_id = 'edge-kept'
      WHERE id = '0011223344556677:draft-cheap' AND status = 'idle'`;
    await assert.rejects(() => db.exec(move), /invalid input syntax for type json/);
    const again = [...carried, { name: "20261113_trigger_origin_reducers", sql: await Deno.readTextFile(new URL("../migrations/20261113_trigger_origin_reducers.sql", import.meta.url)) }];
    assert.deepEqual(await applyScripts(db, again, () => {}), ["20261113_trigger_origin_reducers"]);
    assert.deepEqual(await applyScripts(db, again, () => {}), []);
    await db.exec(move);
    assert.deepEqual((await db.query("SELECT status FROM generation_draft WHERE id = '0011223344556677:draft-cheap'")).rows, [{ status: "illustrating" }]);
    assert.deepEqual((await db.query("SELECT id, name FROM card_set WHERE id='edge-kept'")).rows, [{ id: "edge-kept", name: "Kept" }]);
    assert.equal((await db.query("SELECT id FROM deck_progress WHERE id='edge-kept'")).rows.length, 1);
  } finally {
    await db.close();
  }
});

Deno.test("edge release selects the retained bootstrap bytes", async () => {
  const { releaseFiles } = await import("@bonisoft3/pronto/bundle/edge-scripts.ts");
  const app = fileURLToPath(new URL("../", import.meta.url));
  const mecha = fileURLToPath(import.meta.resolve("@bonisoft3/mecha/"));
  const shell = JSON.parse(await Deno.readTextFile(new URL("../shell/shell.json", import.meta.url)));
  const files = await releaseFiles(app, mecha, shell.migrations);
  for (const name of ["003_rls.sql", "010_machines.sql", "017_card_art_fan_out.sql", "018_deck_level.sql", "019_deck_advance.sql"]) {
    const matches = files.filter((file) => file.name === name);
    assert.equal(matches.length, 1, name);
    assert.equal(matches[0].sql, await Deno.readTextFile(new URL(`../migrations/baseline/${name}`, import.meta.url)), name);
  }
});
