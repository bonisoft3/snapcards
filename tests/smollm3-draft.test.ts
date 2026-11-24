import assert from "node:assert/strict";
import { issue } from "../effects/smollm3-draft.js";

Deno.test("translation requests structured JSON and validates a full fifteen-card Hebrew result", async () => {
  const cards = ["דוב קוטב", "אווז ים", "זאב ארקטי", "ארנבת ארקטית", "לווייתן בלוגה", "יונת הים", "גירית", "וולרוס", "תנשמת שלג", "פוקה", "אורקה", "שועל ארקטי", "נרוואל", "אייל הצפון", "בקר המושק"];
  const result = { name: "בעלי חיים של הקוטב הצפוני", category: "מדעי הטבע", cards };
  const topic = `north-pole :: [TRANSLATE:he] :: ${JSON.stringify({ name: "North Pole Animals", category: "Ciência Natural", cards: Array.from({ length: 15 }, (_, i) => `animal ${i}`) })}`;
  for (const malformed of [false, true]) {
    let calls = 0;
    const outcome = await issue({ topic, locale: "he", card_count: 15 }, {
      fetch: async (_path: string, options: { body: Record<string, unknown> }) => {
        calls++;
        assert.deepEqual(options.body.response_format, {
          type: "json_schema",
          json_schema: {
            type: "object",
            properties: { name: { type: "string" }, category: { type: "string" }, cards: { type: "array", items: { type: "string" }, minItems: 15, maxItems: 15 } },
            required: ["name", "category", "cards"], additionalProperties: false,
          },
        });
        assert.equal(options.body.max_tokens, 2048);
        const content = JSON.stringify(result);
        return { status: 200, body: { choices: [{ finish_reason: "stop", message: { content: malformed ? content.replace(/\]}$/, "}") : content } }] } };
      },
    });
    assert.equal(calls, 1);
    if (malformed) assert.deepEqual(outcome, { failed: { status: 422, topic } });
    else {
      assert.ok(outcome.done);
      const saved = JSON.parse(outcome.done.cards_json);
      assert.deepEqual({ ...saved, cards: saved.cards.map((card: { word: string }) => card.word) }, result);
    }
  }
});
