import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createDatabase } from "@bonisoft3/mecha/packages/mecha-browser/src/database.ts";
import { browserTier } from "@bonisoft3/mecha/packages/mecha-browser/fence.ts";
import { releaseFiles } from "@bonisoft3/pronto/bundle/edge-scripts.ts";

const app = fileURLToPath(new URL("../", import.meta.url));
const mecha = fileURLToPath(import.meta.resolve("@bonisoft3/mecha/"));

export async function boundedSql(): Promise<string> {
  const result = await new Deno.Command("cue", {
    args: ["export", "effect-queue.cue", "-e", 'code.state.migrations["20261028_bounded_effect_jobs"].operations[0].sql.up', "--out", "text"],
    cwd: app, stdout: "piped", stderr: "piped",
  }).output();
  assert.ok(result.success, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout);
}

export async function baselineScripts() {
  const shell = JSON.parse(await Deno.readTextFile(new URL("../shell/shell.json", import.meta.url)));
  const baseline = new Set(["003_rls.sql", "010_machines.sql", "017_card_art_fan_out.sql", "018_deck_level.sql", "019_deck_advance.sql"]);
  return await Promise.all((await releaseFiles(app, mecha, shell.migrations)).map(async ({ name, sql }) => ({
    name, sql: baseline.has(name) ? await Deno.readTextFile(new URL(`../migrations/baseline/${name}`, import.meta.url)) : sql,
  })));
}

export async function baselineCluster() {
  const db = await createDatabase({});
  for (const { sql } of await baselineScripts()) await db.exec(browserTier(sql));
  await db.exec(browserTier(await boundedSql()));
  return db;
}

export async function upgrade(db: Awaited<ReturnType<typeof baselineCluster>>) {
  await db.exec(browserTier(await Deno.readTextFile(new URL("../migrations/20261105_cortex_generation.sql", import.meta.url))));
  await db.exec(browserTier(await Deno.readTextFile(new URL("../migrations/20261113_origin_reducers.sql", import.meta.url))));
  await db.exec(browserTier(await Deno.readTextFile(new URL("../migrations/20261113_trigger_origin_reducers.sql", import.meta.url))));
  await db.exec(browserTier(await Deno.readTextFile(new URL("../migrations/20261114_card_count_bound.sql", import.meta.url))));
}

export async function cluster() {
  const db = await baselineCluster();
  await upgrade(db);
  return db;
}
