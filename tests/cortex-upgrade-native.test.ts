import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { releaseFiles } from "@bonisoft3/pronto/bundle/edge-scripts.ts";

const dbImage = Deno.env.get("SNAPCARDS_NATIVE_DB_IMAGE");
const migrateImage = Deno.env.get("SNAPCARDS_MIGRATE_IMAGE");
const app = fileURLToPath(new URL("../", import.meta.url));
const mecha = fileURLToPath(import.meta.resolve("@bonisoft3/mecha/"));

Deno.test({ name: "native pgroll upgrades retained Cortex data and replays without changes", ignore: !dbImage || !migrateImage, sanitizeOps: false, sanitizeResources: false, async fn() {
  const name = `snapcards-upgrade-${crypto.randomUUID().slice(0, 8)}`;
  const dir = await Deno.makeTempDir({ prefix: "snapcards-upgrade-" });
  const run = async (args: string[], input?: string) => {
    const process = new Deno.Command("docker", { args, stdin: input === undefined ? "null" : "piped", stdout: "piped", stderr: "piped" }).spawn();
    if (input !== undefined) { const writer = process.stdin.getWriter(); await writer.write(new TextEncoder().encode(input)); await writer.close(); }
    const out = await process.output();
    return { ok: out.success, out: new TextDecoder().decode(out.stdout).trim(), err: new TextDecoder().decode(out.stderr).trim() };
  };
  const must = async (args: string[], input?: string) => {
    const result = await run(args, input);
    assert.ok(result.ok, `${args.join(" ")}: ${result.err}\n${result.out}`);
    return result.out;
  };
  const psql = (sql: string, database = "postgres") => must(["exec", "-i", name, "psql", "-XqtA", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database], sql);
  let started = false;
  try {
    await must(["run", "-d", "--name", name, "-e", "POSTGRES_PASSWORD=temporary", dbImage!]);
    started = true;
    for (let i = 0; ; i++) {
      const logs = await run(["logs", name]);
      const ready = await run(["exec", name, "pg_isready", "-qU", "postgres"]);
      if (ready.ok && (`${logs.out}\n${logs.err}`.match(/database system is ready to accept connections/g) ?? []).length >= 2) break;
      if (i === 119) throw Error("temporary PostgreSQL did not start");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const shell = JSON.parse(await Deno.readTextFile(new URL("../shell/shell.json", import.meta.url)));
    const files = await releaseFiles(app, mecha, shell.migrations);
    for (const { name: file, sql } of files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (file === "900_seed.sql") continue;
      await psql(sql);
    }
    const migration = async (file: string, sql: string) => await Deno.writeTextFile(`${dir}/${file}.json`, JSON.stringify({ operations: [{ sql: { up: sql } }] }));
    const bounded = await new Deno.Command("cue", { args: ["export", "effect-queue.cue", "-e", 'code.state.migrations["20261028_bounded_effect_jobs"].operations[0].sql.up', "--out", "text"], cwd: app, stdout: "piped", stderr: "piped" }).output();
    assert.ok(bounded.success, new TextDecoder().decode(bounded.stderr));
    await migration("20261028_bounded_effect_jobs", new TextDecoder().decode(bounded.stdout));
    const migrate = (database = "postgres") => must(["run", "--rm", "--network", `container:${name}`, "-v", `${dir}:/pgroll:ro`, "-e", `DATABASE_URL=postgres://postgres:temporary@127.0.0.1:5432/${database}?sslmode=disable`, migrateImage!]);
    await migrate();
    await psql(`INSERT INTO card_set (id, name, category, locale, region, count, cover_emoji, device, audience_key)
      VALUES ('kept', 'Kept', 'Animals', 'en', 'US', 2, '🍎', '0123456789abcdef', 'diff_kids'),
      ('cheap-only', 'Kept too', 'Animals', 'en', 'US', 2, '🍎', 'abcdef0123456789', 'diff_kids');
      INSERT INTO generation_draft (id, topic, category, locale, region, card_count, status, set_id, details)
      VALUES ('abcdef0123456789:draft-cheap', '', '', 'en', '', 0, 'idle', '', '');
      INSERT INTO flashcard (id, set_id, front, back, hint, difficulty, emoji, color)
      VALUES ('kept-card', 'kept', 'Cat', '', 'run-1', 'easy', '🐈', '#FED7AA');
      INSERT INTO generation_draft (id, topic, category, locale, region, card_count, status, set_id, details)
      VALUES ('0123456789abcdef:draft-heavy', '', '', 'en', '', 0, 'idle', '', '');
      UPDATE generation_draft SET status='illustrating', topic='Pending', region='run-9', card_count=1 WHERE id='0123456789abcdef:draft-heavy';`);
    const retained = await psql("SELECT json_build_object('decks',(SELECT json_agg(t ORDER BY id) FROM (SELECT id,name,device FROM card_set) t),'cards',(SELECT json_agg(t ORDER BY id) FROM (SELECT id,set_id,front,back,hint FROM flashcard) t),'ledger',(SELECT json_agg(t ORDER BY key) FROM (SELECT key,effect,input,outcome FROM airlock.external_effect_ledger) t),'jobs',(SELECT json_agg(t ORDER BY key) FROM (SELECT key,payload FROM graphile_worker._private_jobs) t))");
    await migration("20261105_cortex_generation", await Deno.readTextFile(new URL("../migrations/20261105_cortex_generation.sql", import.meta.url)));
    await migration("20261113_origin_reducers", await Deno.readTextFile(new URL("../migrations/20261113_origin_reducers.sql", import.meta.url)));
    await migration("20261113_trigger_origin_reducers", await Deno.readTextFile(new URL("../migrations/20261113_trigger_origin_reducers.sql", import.meta.url)));
    await migrate();
    assert.equal(await psql("SELECT json_build_object('decks',(SELECT json_agg(t ORDER BY id) FROM (SELECT id,name,device FROM card_set) t),'cards',(SELECT json_agg(t ORDER BY id) FROM (SELECT id,set_id,front,back,hint FROM flashcard) t),'ledger',(SELECT json_agg(t ORDER BY key) FROM (SELECT key,effect,input,outcome FROM airlock.external_effect_ledger) t),'jobs',(SELECT json_agg(t ORDER BY key) FROM (SELECT key,payload FROM graphile_worker._private_jobs) t))"), retained);
    assert.equal(await psql("SELECT count(*) FROM generation_draft WHERE id LIKE '0123456789abcdef:draft-%'"), "2");
    assert.equal(await psql("SELECT count(*) FROM generation_draft WHERE id LIKE 'abcdef0123456789:draft-%'"), "2");
    assert.equal(await psql("SELECT count(*) FROM deck_progress WHERE id='kept'"), "1");
    // Native Postgres leaves a setting a transaction set LOCAL as '' for the
    // session, as PGlite does (cortex-upgrade.test.ts): the carried reducer
    // must read it as no role, or a move after any request fails on ''::json.
    assert.equal(await psql(`BEGIN;
      SELECT set_config('request.jwt.claims', '{"role":"app_user","sub":"00000000-0000-4000-8000-000000000001"}', true) \\gset a_
      COMMIT;
      SELECT current_setting('request.jwt.claims', true) = '';
      UPDATE generation_draft SET status='illustrating', topic='Kept', region='run-1', card_count=1 WHERE id='abcdef0123456789:draft-cheap' AND status='idle';
      SELECT status FROM generation_draft WHERE id='abcdef0123456789:draft-cheap';`), "t\nillustrating");
    const ledger = await psql("SELECT name || ':' || done FROM pgroll.migrations WHERE name LIKE '2026%' ORDER BY name");
    await migrate();
    assert.equal(await psql("SELECT name || ':' || done FROM pgroll.migrations WHERE name LIKE '2026%' ORDER BY name"), ledger);
    await psql("CREATE DATABASE fresh");
    for (const { name: file, sql } of files) {
      if (file === "900_seed.sql") continue;
      await psql(sql, "fresh");
    }
    await migrate("fresh");
    const definitions = `SELECT md5(string_agg(pg_get_functiondef(p.oid), E'\\n' ORDER BY p.proname)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('app_pre_request', 'snapcards_advance_decks', 'snapcards_count_art', 'trg_generation_draft_status_machine')`;
    assert.equal(await psql(definitions, "fresh"), await psql(definitions));
    const triggers = `SELECT md5(string_agg(pg_get_triggerdef(t.oid), E'\\n' ORDER BY c.relname,t.tgname)) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal AND c.relname IN ('card_art','card_set','card_translation','deck_level','deck_progress','deck_translation','flashcard','generation_draft')`;
    assert.equal(await psql(triggers, "fresh"), await psql(triggers));
    assert.equal(await psql("SELECT extversion FROM pg_extension WHERE extname='pg_ivm'", "fresh"), "1.13");
  } finally {
    if (started) {
      const removed = await run(["rm", "-f", name]);
      assert.ok(removed.ok, removed.err);
    }
    await Deno.remove(dir, { recursive: true });
  }
}});
