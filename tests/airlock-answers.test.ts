import assert from "node:assert/strict";
import { issue as draft } from "../effects/smollm3-draft.js";
import { issue as heavy } from "../effects/heavy-draft.js";

type Answer = { status: number; body: unknown } | "throw";
type Sink = { fetch: (path: string, init: { body: Record<string, unknown> }) => Promise<{ status: number; body: unknown }> };

const words = { cards: ["Caju", "Goiaba", "Manga"].map((w) => ({ front_text: w, emoji: "🍎" })) };
const chatOk: Answer = { status: 200, body: { choices: [{ message: { content: JSON.stringify(words) } }] } };

// The text answer; every call is recorded, so an image call would show.
const sink = (chat: Answer, paths: string[] = []): Sink => ({
  fetch: (path) => {
    paths.push(path);
    if (chat === "throw") throw new TypeError("connection reset");
    return Promise.resolve(chat);
  },
});
const input = { topic: "frutas", locale: "pt-BR", card_count: 3 };

for (const [name, issue] of [["smollm3-draft", draft], ["heavy-draft", heavy]] as const) {
  Deno.test(`${name} asks the airlock to retry a rate limit, a server fault and a lost call`, async () => {
    assert.deepEqual(await issue(input, sink({ status: 429, body: { error: "slow down" } })), { retry: "429 rate limited" });
    assert.deepEqual(await issue(input, sink({ status: 503, body: "busy" })), { retry: "503 provider error" });
    assert.deepEqual(await issue(input, sink("throw")), { retry: "network connection reset" });
  });

  // A refusal the provider means is final; dropping its body hid why a level never drew.
  Deno.test(`${name} answers a refused text call as failed with the provider's detail`, async () => {
    assert.deepEqual(await issue(input, sink({ status: 400, body: { error: "bad prompt" } })), {
      failed: { status: 400, topic: "frutas", detail: { error: "bad prompt" } },
    });
  });

  // A deck-wide effect that drew every card retried all of them for one refusal;
  // each card's picture is now its own illustrate-card effect, drawn from the card's word.
  Deno.test(`${name} makes one text call and hands the fan-out each card's word and nothing a model described`, async () => {
    const paths: string[] = [];
    const outcome = await issue(input, sink(chatOk, paths));
    assert.deepEqual(paths, ["/v1/chat/completions"]);
    const cards = JSON.parse(outcome.done!.cards_json);
    assert.deepEqual(cards.map((c: { word: string }) => c.word), ["Caju", "Goiaba", "Manga"]);
    for (const c of cards) assert.deepEqual(Object.keys(c).filter((k) => !["word", "emoji", "color"].includes(k)), []);
  });
}

Deno.test("heavy-draft fails when its text names no card", async () => {
  const empty: Answer = { status: 200, body: { choices: [{ message: { content: '{"cards":[]}' } }] } };
  assert.deepEqual(await heavy(input, sink(empty)), {
    failed: { status: 422, topic: "frutas", detail: "the heavy text named no cards" },
  });
});

// The deck title was the whole prompt, so details became the deck's name. The text levels
// also wrote an English picture description and a reader-facing one, which reached the
// image model and invented what it drew: they write the cards' words alone, for whom the
// reader said the deck is.
for (const [name, issue] of [["smollm3-draft", draft], ["heavy-draft", heavy]] as const) {
  Deno.test(`${name} asks for the title and the details apart, for the deck's audience, and for words alone`, async () => {
    let body: Record<string, unknown> = {};
    const ask = async (extra: Record<string, unknown>) => {
      const outcome = await issue({ topic: "Bichos", details: "só da Mata Atlântica", locale: "pt-BR", card_count: 3, ...extra }, {
        fetch: (_path: string, init: { body: Record<string, unknown> }) => {
          body = init.body;
          return Promise.resolve(chatOk as { status: number; body: unknown });
        },
      });
      assert.ok("done" in outcome);
      return body.messages as { role: string; content: string }[];
    };
    const messages = await ask({ audience_key: "diff_teens" });
    const asked = messages.at(-1)!.content;
    assert.ok(asked.includes('Topic: "Bichos" Details: "só da Mata Atlântica"'), asked);
    assert.ok(messages[0].content.includes("teenagers and adults") && messages[0].content.includes("Português do Brasil"));
    assert.ok(!messages.some((m) => /image_description|frame_percent|"description"/.test(m.content)));
    // No example is drawn from a deck the tests generate.
    assert.ok(!messages.some((m) => /frutas|Caju|Goiaba|quadrinhos|Bichos.*Onça/.test(m.content)));
    assert.ok((await ask({ audience_key: "diff_toddler" }))[0].content.includes("toddlers in early childhood"));
    assert.ok((await ask({ audience_key: "", audience: "adultos aprendendo português" }))[0].content.includes("adultos aprendendo português"));
    assert.ok((await ask({}))[0].content.includes("learners of any age"));
    await assert.rejects(async () => await ask({ audience_key: "diff_babies" }), TypeError);
    const bare = await issue({ topic: "Bichos", locale: "pt-BR", card_count: 3 }, {
      fetch: (_path: string, init: { body: Record<string, unknown> }) => {
        body = init.body;
        return Promise.resolve(chatOk as { status: number; body: unknown });
      },
    });
    assert.ok("done" in bare);
    assert.ok(!(body.messages as { content: string }[]).at(-1)!.content.includes("Details:"));
  });
}
