import assert from "node:assert/strict";
import { issue } from "../effects/illustrate-card.js";

type Answer = { status: number; body: unknown } | "throw";
type Call = { path: string; body: Record<string, unknown> };

// The card's calls in order, each answered by the next answer: level 2's translation, then the image.
const sink = (...answers: Answer[]) => {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (path: string, init: { body: Record<string, unknown> }) => {
      calls.push({ path, body: init.body });
      const answer = answers[calls.length - 1];
      if (answer === "throw") throw new TypeError("connection reset");
      return Promise.resolve(answer);
    },
  };
};
const card = (level: number, extra: Record<string, unknown> = {}) => ({
  level, position: 3, redraws: 0, description: "", word: "Caju", title: "Frutas do Brasil", details: "só frutas nativas",
  audience_key: "diff_kids", audience: "", ...extra,
});
// What the cheap text tier answers for the reader's words, here wrapped as Gemma 4 wraps it.
const english = (words: Record<string, string>) => ({
  status: 200, body: { choices: [{ message: { content: "```json\n" + JSON.stringify(words) + "\n```" } }] },
});
const caju = english({ word: "Cashew apple", title: "Fruits of Brazil", details: "only native fruits" });
const png = { status: 200, body: { data: [{ b64_json: "iVBORw0KGgoAAA" }] } };
const jpeg = { status: 200, body: { data: [{ b64_json: "/9j/4AAQSkZJRg" }] } };
// tsbifrost's answer to a thrown Workers AI error: a 503 carrying the error's text.
const workersAi = (error: string) => ({ status: 503, body: { error, provider: "cloudflare", model: "flux-1-schnell", tier: "heavy" } });

// A model's description of the picture once reached the image model, and the picture
// followed it: a coin that never existed. The prompt is the card's word and what the
// reader wrote. Level 2's model reads English alone: the cheap text tier translates, and
// the reader's word rides beside its translation, since one translator turned a paca
// into an agouti. Gemini at level 3 reads the reader's language and drew the paca, the
// giant anteater and the coins right from the words as written.
Deno.test("illustrate-card draws the card's word in its deck's context, from the reader's words alone", async () => {
  const cheap = sink(caju, png);
  const two = await issue(card(2), cheap);
  assert.ok("done" in two);
  assert.deepEqual(cheap.calls.map((c) => c.path), ["/v1/chat/completions", "/v1/images/generations"]);
  const asked = JSON.parse((cheap.calls[0].body.messages as { content: string }[])[1].content);
  assert.deepEqual(asked, { word: "Caju", title: "Frutas do Brasil", details: "só frutas nativas" });
  const image = cheap.calls[1].body;
  assert.deepEqual([image.tier, image.size, image.seed], ["cheap", "256x256", 42 + 2 * 313]);
  assert.ok(String(image.prompt).startsWith("Subject: a single Cashew apple (Caju). Context: Fruits of Brazil; only native fruits. Style: a colorful children's picture-book illustration"));
  assert.ok(String(image.prompt).endsWith("Isolated on a pure white (#FFFFFF) background that runs to every edge of the image; the subject fills the frame."));
  // Bytes, never a data URL: the airlock stores them in the blob plane, and the row holds the URL.
  assert.deepEqual(two, { done: { image: { $blob: { base64: "iVBORw0KGgoAAA", type: "image/png" } } } });
  const same = sink(english({ word: "Paca", title: "Animals of Brazil" }), png);
  await issue(card(2, { word: "Paca", title: "Animais do Brasil", details: "" }), same);
  assert.ok(String(same.calls[1].body.prompt).startsWith("Subject: a single Paca. Context: Animals of Brazil."));
  const heavy = sink(jpeg);
  // Gemini answers JPEG, Workers AI PNG: the blob says which.
  assert.deepEqual(await issue(card(3), heavy), { done: { image: { $blob: { base64: "/9j/4AAQSkZJRg", type: "image/jpeg" } } } });
  assert.deepEqual(heavy.calls.map((c) => c.path), ["/v1/images/generations"]);
  assert.deepEqual([heavy.calls[0].body.tier, heavy.calls[0].body.seed], ["heavy", 101 + 2 * 997]);
  assert.ok(String(heavy.calls[0].body.prompt).startsWith("Subject: a single Caju. Context: Frutas do Brasil; só frutas nativas. Style: a colorful children's picture-book illustration"));
  assert.ok("failed" in await issue(card(3), sink({ status: 200, body: { data: [{ b64_json: "R0lGODlh" }] } })));
});

Deno.test("each audience preset asks for its own style, a reader's own range is said as theirs, and none asks for none", async () => {
  const styleOf = async (extra: Record<string, unknown>) => {
    const s = sink(png);
    await issue(card(3, extra), s);
    return String(s.calls[0].body.prompt);
  };
  assert.ok((await styleOf({ audience_key: "diff_toddler" })).includes("Style: a simple flat cartoon icon for toddlers"));
  assert.ok((await styleOf({ audience_key: "diff_teens" })).includes("Style: a realistic studio photograph"));
  assert.ok((await styleOf({ audience_key: "", audience: "adultos que aprendem português" })).includes("Target age range: adultos que aprendem português."));
  const none = await styleOf({ audience_key: "" });
  assert.ok(!none.includes("Style:") && !none.includes("Target age range"));
  // Level 2 translates the reader's range with the rest of their words.
  const two = sink(english({ word: "Cashew apple", title: "Fruits of Brazil", details: "only native fruits", audience: "adults learning Portuguese" }), png);
  await issue(card(2, { audience_key: "", audience: "adultos que aprendem português" }), two);
  assert.equal(JSON.parse((two.calls[0].body.messages as { content: string }[])[1].content).audience, "adultos que aprendem português");
  assert.ok(String(two.calls[1].body.prompt).includes("Target age range: adults learning Portuguese."));
  // Read from the deck, so it fails the card at once instead of through every attempt.
  assert.ok("failed" in await issue(card(3, { audience_key: "diff_babies" }), sink(png)));
});

// A deck's calls at once meet Workers AI's 3040 capacity refusal; it passes, so the
// airlock retries this card alone with its backoff.
Deno.test("illustrate-card asks for a retry on capacity, rate limits, other server faults and lost calls", async () => {
  for (const error of ["3040: Capacity temporarily exceeded, please try again.", "AiError: 3040: Capacity temporarily exceeded, please try again."]) {
    assert.deepEqual(await issue(card(3), sink(workersAi(error))), { retry: `3040 ${error}` });
  }
  assert.deepEqual(await issue(card(3), sink({ status: 429, body: { error: "slow down" } })), { retry: "429 rate limited" });
  assert.deepEqual(await issue(card(3), sink(workersAi("fetch failed"))), { retry: "503 provider error" });
  assert.deepEqual(await issue(card(2), sink(caju, { status: 500, body: "busy" })), { retry: "500 provider error" });
  assert.deepEqual(await issue(card(2), sink(caju, "throw")), { retry: "network connection reset" });
});

// tsbifrost reports 8007 (NSFW, false positives on ordinary fruit among them) as a 503;
// retried, it re-ran the same refusal through every attempt. It is the provider's
// verdict on the prompt, so the card fails with it.
Deno.test("illustrate-card fails a card on a coded refusal, a 4xx or an answer with no image", async () => {
  const nsfw = workersAi("8007: Input prompt contains NSFW content.");
  assert.deepEqual(await issue(card(3), sink(nsfw)), { failed: { status: 503, code: "8007", detail: nsfw.body } });
  assert.deepEqual(await issue(card(2), sink(caju, { status: 400, body: { error: "bad prompt" } })), {
    failed: { status: 400, detail: { error: "bad prompt" } },
  });
  assert.deepEqual(await issue(card(3), sink({ status: 200, body: { data: [] } })), {
    failed: { status: 502, detail: "the answer carries no image" },
  });
});

// A reader's redraw carries their description in the deck's language; it describes the
// subject, as written at level 3 and translated with the rest at level 2.
Deno.test("a redraw draws the word with the reader's description at a new seed", async () => {
  const three = sink(png);
  const outcome = await issue(card(3, { description: "Um caju maduro no galho", redraws: 2 }), three);
  assert.deepEqual(outcome, { done: { image: { $blob: { base64: "iVBORw0KGgoAAA", type: "image/png" } } } });
  assert.ok(String(three.calls[0].body.prompt).startsWith("Subject: a single Caju: Um caju maduro no galho. Context:"));
  assert.equal(three.calls[0].body.seed, 101 + 2 * 997 + 2 * 7919);
  const two = sink(english({ word: "Cashew apple", title: "Fruits of Brazil", details: "only native fruits", description: "a ripe cashew on a branch" }), png);
  await issue(card(2, { description: "Um caju maduro no galho", redraws: 2 }), two);
  assert.equal(JSON.parse((two.calls[0].body.messages as { content: string }[])[1].content).description, "Um caju maduro no galho");
  assert.ok(String(two.calls[1].body.prompt).startsWith("Subject: a single Cashew apple (Caju): a ripe cashew on a branch. Context:"));
});

Deno.test("the translation retries what passes and what came back unusable, and fails what the provider refused", async () => {
  const translation = async (answer: Answer) => {
    const s = sink(answer, png);
    return { outcome: await issue(card(2), s), paths: s.calls.map((c) => c.path) };
  };
  assert.deepEqual(await translation({ status: 429, body: { error: "slow down" } }), { outcome: { retry: "429 rate limited" }, paths: ["/v1/chat/completions"] });
  assert.deepEqual(await translation("throw"), { outcome: { retry: "network connection reset" }, paths: ["/v1/chat/completions"] });
  assert.deepEqual((await translation({ status: 400, body: { error: "bad" } })).outcome, { failed: { status: 400, detail: { error: "bad" } } });
  assert.ok("retry" in (await translation({ status: 200, body: { choices: [{ message: { content: "  " } }] } })).outcome);
  assert.ok("retry" in (await translation(english({ title: "Fruits of Brazil" } as never))).outcome);
});

Deno.test("illustrate-card refuses a row with no redraw count, which seeds every drawing, and fails a card gone since", async () => {
  await assert.rejects(() => issue({ ...card(3), redraws: undefined } as never, sink(caju, png)), TypeError);
  const gone = sink(caju, png);
  assert.ok("failed" in await issue(card(3, { word: null }), gone));
  assert.equal(gone.calls.length, 0);
});
