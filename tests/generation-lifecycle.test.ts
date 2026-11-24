import assert from "node:assert/strict";
import { cluster } from "./cortex-cluster.ts";

Deno.test("either first draft slot provisions exactly one cheap and heavy slot after insertion", async () => {
  const db = await cluster();
  try {
    for (const first of ["cheap", "heavy"]) {
      const key = first === "cheap" ? "0123456789abcdef" : "fedcba9876543210";
      const insert = () => db.query(`INSERT INTO generation_draft
        (id, topic, category, locale, region, card_count, status, set_id, details)
        VALUES ($1, 'kept', '', 'pt-BR', '', 0, 'idle', '', '') ON CONFLICT (id) DO NOTHING`, [`${key}:draft-${first}`]);
      await insert();
      await insert();
      const { rows } = await db.query(`SELECT id, topic, locale, status FROM generation_draft
        WHERE id LIKE $1 ORDER BY id`, [`${key}:draft-%`]);
      assert.deepEqual(rows, ["cheap", "heavy"].map((tier) => ({
        id: `${key}:draft-${tier}`, topic: tier === first ? "kept" : "", locale: "pt-BR", status: "idle",
      })));
    }
  } finally {
    await db.close();
  }
});

Deno.test("CardSet insertion provisions its initial durable progress without a browser write", async () => {
  const db = await cluster();
  try {
    await db.exec(`INSERT INTO card_set (id, name, category, locale, region, count, cover_emoji, device, audience_key)
      VALUES ('provisioned-deck', 'Frutas', '#01 · Frutas', 'pt-BR', 'Brasil', 3, '🍎', '0123456789abcdef', 'diff_kids')`);
    assert.deepEqual((await db.query(`SELECT id, run, status FROM deck_progress WHERE id='provisioned-deck'`)).rows,
      [{ id: "provisioned-deck", run: "run-0", status: "drafting" }]);
  } finally {
    await db.close();
  }
});

Deno.test("raw translation start reaches the generation actor beside guarded facts.text transitions", async () => {
  const db = await cluster();
  try {
    const id = "0123456789abcdef:draft-cheap";
    const topic = 'translation-deck :: [TRANSLATE:pt] :: {"name":"Pets","cards":[{"id":"cat","word":"Cat"}]}';
    await db.query(`INSERT INTO generation_draft
      (id, topic, category, locale, region, card_count, status, set_id, details)
      VALUES ($1, '', '', 'en', '', 0, 'idle', '', '')`, [id]);
    await db.query(`UPDATE generation_draft SET status='drafting', topic=$2, locale='pt',
      region='xlat-pt :: tx-1', card_count=1 WHERE id=$1`, [id, topic]);
    assert.deepEqual((await db.query(`SELECT status, set_id FROM generation_draft WHERE id=$1`, [id])).rows,
      [{ status: "drafting", set_id: "" }]);
    const { rows } = await db.query(`SELECT l.effect, l.input->>'topic' AS topic, l.input->>'locale' AS locale
      FROM airlock.external_effect_ledger l JOIN graphile_worker._private_jobs j ON j.payload->>'key'=l.key
      WHERE l.input->>'topic'=$1`, [topic]);
    assert.deepEqual(rows, [{ effect: "smollm3-draft", topic, locale: "pt" }]);
  } finally {
    await db.close();
  }
});
