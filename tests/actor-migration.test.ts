import assert from "node:assert/strict";
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";
import { browserTier } from "@bonisoft3/mecha/packages/mecha-browser/fence.ts";
import { applyScripts, digest, recordScripts } from "@bonisoft3/mecha/packages/pglite-workerd/scripts.ts";
import { compileMechaReducer, type MechaReducerMachine } from "@bonisoft3/pronto/mecha-reducer.ts";
import { instrument } from "@bonisoft3/omnishell/instrument.ts";
import ses from "@bonisoft3/omnishell/interpreter/vendor/ses.umd.min.js" with { type: "text" };

Deno.test("actor lock migration preserves the applied baseline and every live instance record", async () => {
  const baseline = await Deno.readTextFile(new URL("../migrations/baseline/016_mecha_actors.sql", import.meta.url));
  assert.equal(await digest(baseline), "71bb9d66ebceafe00883d630d689a241f7553a4e6371eff640689c2904bcb329");
  const upgrade = await Deno.readTextFile(new URL("../migrations/20261028_deck_press_actor_locks.sql", import.meta.url));
  const engines = await Deno.readTextFile(new URL("../migrations/20261105_mecha_engines.sql", import.meta.url));
  const rule = await Deno.readTextFile(new URL("../migrations/20261113_rule_argument_engines.sql", import.meta.url));
  const transition = await Deno.readTextFile(new URL("../migrations/20261120_transition_engines.sql", import.meta.url));
  const current = await Deno.readTextFile(new URL("../migrations/20261121_after_engines.sql", import.meta.url));
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE app_user; CREATE ROLE service;
      CREATE TABLE deck_press_seat (id text PRIMARY KEY, instance_id uuid, actor uuid, seat text, revision bigint, phase text, view jsonb);`);
    await db.exec(browserTier(baseline));
    const room = "00000000-0000-0000-0000-000000000001";
    const actor = "00000000-0000-0000-0000-000000000002";
    await db.query("INSERT INTO hybrid_deck_press.instance VALUES ($1, 1, 7, '{\"phase\":\"editing\"}')", [room]);
    await db.query("INSERT INTO hybrid_deck_press.member VALUES ($1, $2, 'owner')", [room, actor]);
    await db.query("INSERT INTO hybrid_deck_press.receipt VALUES ($1, $2, 'prior', '{\"request\":1}', '{\"result\":2}', 42, 'entropy')", [room, actor]);
    const snapshot = async () => Promise.all(["instance", "member", "receipt"].map(async table => (await db.query(`SELECT * FROM hybrid_deck_press.${table}`)).rows));
    const before = await snapshot();
    const original = { name: "016_mecha_actors.sql", sql: baseline };
    await recordScripts(db, [original]);
    const migration = { name: "20261028_deck_press_actor_locks", sql: upgrade };
    assert.deepEqual(await applyScripts(db, [original, migration], () => {}), [migration.name]);
    assert.deepEqual(await snapshot(), before);
    assert.equal((await db.query<{ sha256: string }>("SELECT sha256 FROM _pronto_migrations WHERE name=$1", [original.name])).rows[0].sha256, await digest(baseline));
    await db.exec("SELECT hybrid_deck_press.serial()");
    await db.query("SELECT hybrid_deck_press.hold_instance($1::uuid)", [room]);
    assert.deepEqual((await db.query("SELECT rolname FROM pg_roles WHERE rolname IN ('app_user', 'service') AND rolconfig IS NOT NULL")).rows, []);
    const engineMigration = { name: "20261105_mecha_engines", sql: engines };
    assert.deepEqual(await applyScripts(db, [original, migration, engineMigration], () => {}), [engineMigration.name]);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await applyScripts(db, [original, migration, engineMigration], () => {}), []);
    assert.deepEqual(await snapshot(), before);
    const ruleMigration = { name: "20261113_rule_argument_engines", sql: rule };
    assert.deepEqual(await applyScripts(db, [original, migration, engineMigration, ruleMigration], () => {}), [ruleMigration.name]);
    assert.deepEqual(await snapshot(), before);
    const transitionMigration = { name: "20261120_transition_engines", sql: transition };
    assert.deepEqual(await applyScripts(db, [original, migration, engineMigration, ruleMigration, transitionMigration], () => {}), [transitionMigration.name]);
    assert.deepEqual(await snapshot(), before);
    const currentMigration = { name: "20261121_after_engines", sql: current };
    assert.deepEqual(await applyScripts(db, [original, migration, engineMigration, ruleMigration, transitionMigration, currentMigration], () => {}), [currentMigration.name]);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await applyScripts(db, [original, migration, engineMigration, ruleMigration, transitionMigration, currentMigration], () => {}), []);
  } finally {
    await db.close();
  }
});

Deno.test("the engine upgrade contains the current deck press engine", async () => {
  const inputs = JSON.parse(await Deno.readTextFile(new URL("../.pronto/check-inputs.json", import.meta.url)));
  const spec = inputs.reducers.deck_press as MechaReducerMachine;
  const rules = await Deno.readTextFile(new URL("../machines/deck_press_rules.js", import.meta.url));
  const { sql } = await compileMechaReducer(spec, rules, { instrument, ses });
  const engine = sql.match(/CREATE OR REPLACE FUNCTION hybrid_deck_press\.engine\(input jsonb\) RETURNS jsonb LANGUAGE plv8 AS \$mecha\$[\s\S]*?\$mecha\$;/)?.[0];
  assert(engine, "missing compiled deck press engine");
  const upgrade = await Deno.readTextFile(new URL("../migrations/20261121_after_engines.sql", import.meta.url));
  assert(upgrade.includes(engine), "the engine upgrade is stale");
});
