import { fileURLToPath } from "node:url";
// Cards imported from the app that served snapcards.fun before this one could
// name their pictures by its address, and the page's CSP let every deployment
// fetch from production to show them. The migration names them by path, so the
// allowance is gone and a staging copy of the data links nothing to production.
import assert from "node:assert/strict";
import { browserTier } from "@bonisoft3/mecha/packages/mecha-browser/fence.ts";
import { createDatabase } from "@bonisoft3/mecha/packages/mecha-browser/src/database.ts";
import { applyScripts, pgrollScripts, recordScripts } from "@bonisoft3/mecha/packages/pglite-workerd/scripts.ts";
import { releaseFiles } from "@bonisoft3/pronto/bundle/edge-scripts.ts";

const app = fileURLToPath(new URL("..", import.meta.url));
const mecha = fileURLToPath(import.meta.resolve("@bonisoft3/mecha/"));
const read = (path: string) => Deno.readTextFile(new URL(`../${path}`, import.meta.url));
const pgroll: Record<string, { operations: Record<string, unknown>[] }> = {};
for await (const file of Deno.readDir(new URL("../services/database/pgroll", import.meta.url))) {
  pgroll[file.name.replace(/\.json$/, "")] = JSON.parse(await read(`services/database/pgroll/${file.name}`));
}
const name = "20261115_pictures_same_origin";
const object = "/img/insecure/plain/s3://mecha-objects/imported/a.webp";

Deno.test("a picture named by snapcards.fun's address is named by its path, and a rerun changes nothing", async () => {
  const files = await releaseFiles(app, mecha, JSON.parse(await read("shell/shell.json")).migrations);
  const scripts = pgrollScripts(pgroll);
  const db = await createDatabase({});
  try {
    const before = scripts.filter((s) => s.name < name);
    for (const { sql } of files) await db.exec(browserTier(sql));
    for (const { sql } of before) await db.exec(browserTier(sql!));
    await recordScripts(db, [...files, ...before]);
    const cards = {
      legacy: "https://snapcards.fun/img/insecure/plain/s3://trash-362115-snapcards-bytes/imported/a.webp",
      www: "https://www.snapcards.fun/img/insecure/plain/s3://mecha-objects/imported/a.webp",
      path: object,
      elsewhere: "https://snapcards.fun.example/a.webp",
      none: "",
    };
    await db.exec(`SET session_replication_role = replica;
      ${Object.entries(cards).map(([id, back]) => `INSERT INTO flashcard (id, set_id, front, back, hint, difficulty, emoji, color) VALUES ('${id}', 'deck', 'card', '${back}', '', 'easy', '🃏', 'red');
      INSERT INTO deck_stats (deck_id, favorite_count, counted_txid, cover) VALUES ('${id}', 0, 0, '${back}');`).join("\n")}
      SET session_replication_role = origin;`);
    // Later migrations are theirs to test; this one applies alone after what precedes it.
    assert.deepEqual(await applyScripts(db, [...files, ...scripts.filter((s) => s.name <= name)], () => {}), [name]);
    const rows = async () => ({
      backs: Object.fromEntries((await db.query<{ id: string; back: string }>("SELECT id, back FROM flashcard WHERE id = ANY($1) ORDER BY id", [Object.keys(cards)])).rows.map((r) => [r.id, r.back])),
      covers: Object.fromEntries((await db.query<{ deck_id: string; cover: string }>("SELECT deck_id, cover FROM deck_stats WHERE deck_id = ANY($1) ORDER BY deck_id", [Object.keys(cards)])).rows.map((r) => [r.deck_id, r.cover])),
    });
    const moved = { legacy: object, www: object, path: object, elsewhere: cards.elsewhere, none: "" };
    assert.deepEqual(await rows(), { backs: moved, covers: moved });
    await db.exec(`BEGIN; ${await read(`migrations/${name}.sql`)} COMMIT;`);
    assert.deepEqual(await rows(), { backs: moved, covers: moved });
  } finally {
    await db.close();
  }
});
