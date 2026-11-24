// Airlock external effect handler: one card's picture at one level (card-art.cue).
// Level 2 is the cheap tier's quick drawing, level 3 the heavy tier's. The prompt is
// the card's word and what the reader wrote of the deck (its title, details and
// audience, and a redraw's description): no description a model wrote reaches the
// image model, since one invented a coin that never existed and the picture followed
// it. Level 3's Gemini reads the reader's language and takes their words as written.
// Level 2's model reads English alone, so the cheap text tier translates them, and
// the card's own word rides beside its translation: a translator that swaps a
// regional species for a related one (paca for agouti) then misleads less.

// Diffusion reads every word it is given as something to draw, a "no" included: what must not
// appear lives here alone, for the models that take one (Gemini does not).
const NEGATIVE = "frame, border, card, panel, box, plate, drop shadow, cast shadow, sticker outline, rounded rectangle, gray background, grey background, off-white background, gradient, vignette, ground plane, paper texture, text, words, letters, typography, writing, labels, captions, watermark, signature, tiny subject, small subject, distant subject, lots of empty space, wide margins, multiple objects, many objects, collage, pattern, pile, group, ground, grass, scenery, landscape, stars, sparkles, puddle, splash, decorations";

// The style a deck's audience asks of its pictures: each preset its own, a reader's own
// range said as theirs, and none where the reader named none.
const STYLE = {
  diff_toddler: "Style: a simple flat cartoon icon for toddlers, thick black outlines, two or three solid colors, no shading, no texture, minimal detail.",
  diff_kids: "Style: a colorful children's picture-book illustration, soft rounded shapes, gentle shading, friendly and playful.",
  diff_teens: "Style: a realistic studio photograph, true-to-life colors, textures and details.",
};
const WHITE = "Isolated on a pure white (#FFFFFF) background that runs to every edge of the image; the subject fills the frame.";

const LEVELS = {
  2: {
    body: (input, prompt) => ({
      tier: "cheap",
      prompt,
      size: "256x256",
      steps: 2,
      seed: 42 + (input.position - 1) * 313 + input.redraws * 7919,
    }),
  },
  3: {
    body: (input, prompt) => ({
      tier: "heavy",
      prompt,
      seed: 101 + (input.position - 1) * 997 + input.redraws * 7919,
    }),
  },
};

// The answer carries bytes, not their type: Workers AI answers PNG, Gemini JPEG.
const mimeOf = (b64) => b64.startsWith("iVBORw0KGgo") ? "image/png" : b64.startsWith("/9j/") ? "image/jpeg" : null;

// tsbifrost answers every Workers AI error as a 503 whose body carries the
// AiError's text, `<code>: <message>`. 3040 is capacity, which passes; any
// other code is the provider's verdict on this prompt, 8007's NSFW refusal
// among them. Without a code, 429, other 5xx and a call that never answered
// pass too, and the airlock retries them with its backoff up to the
// declaration's attempts.
function classify(res) {
  if ("thrown" in res) return { retry: `network ${res.thrown}` };
  if (res.status >= 200 && res.status < 300) return null;
  const error = String(res.body?.error ?? "");
  const code = error.match(/\b(\d{4}): /)?.[1];
  if (code === "3040") return { retry: `3040 ${error}` };
  if (code === undefined && res.status === 429) return { retry: "429 rate limited" };
  if (code === undefined && res.status >= 500) return { retry: `${res.status} provider error` };
  return { failed: { status: res.status, ...(code ? { code } : {}), detail: res.body } };
}

const TRANSLATE = "Translate each value of this JSON object into English, word for word in meaning. " +
  "A species takes its established English common name. Add nothing, explain nothing, keep proper names as they are. " +
  "Reply with the JSON object alone.";

async function call(sink, path, body) {
  try {
    return await sink.fetch(path, { method: "POST", body });
  } catch (e) {
    return { thrown: e instanceof Error ? e.message : String(e) };
  }
}

// The text the model answered, with any reasoning block or code fence a model wraps it in removed.
const answerOf = (body) => String(body?.choices?.[0]?.message?.content ?? body?.message?.content ?? "")
  .replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

// The reader's words, each as they wrote it: only what they wrote is translated.
function readerWords(input) {
  const words = { word: String(input.word ?? "").trim(), title: String(input.title ?? "").trim() };
  for (const k of ["details", "description"]) if (String(input[k] ?? "").trim()) words[k] = String(input[k]).trim();
  if (!input.audience_key && String(input.audience ?? "").trim()) words.audience = String(input.audience).trim();
  return words;
}

function prompt(en, audienceKey, original) {
  const word = original && original.toLowerCase() !== en.word.toLowerCase() ? `${en.word} (${original})` : en.word;
  const subject = en.description ? `${word}: ${en.description}` : word;
  const context = en.details ? `${en.title}; ${en.details}` : en.title;
  const style = audienceKey ? STYLE[audienceKey] : en.audience ? `Target age range: ${en.audience}.` : "";
  return [`Subject: a single ${subject}.`, `Context: ${context}.`, style, WHITE].filter(Boolean).join(" ");
}

export async function issue(input, sink) {
  const level = LEVELS[input?.level];
  if (!level) throw new TypeError(`illustrate-card draws levels 2 and 3, got ${JSON.stringify(input?.level)}`);
  if (!Number.isInteger(input.redraws)) throw new TypeError(`illustrate-card seeds by the row's redraws, got ${JSON.stringify(input.redraws)}`);
  // What the row names, read when it was claimed: a card or deck deleted since, or an audience
  // this handler does not know, fails the card at once rather than through every attempt.
  const words = readerWords(input);
  if (!words.word || !words.title) return { failed: { status: 422, detail: `no card word or deck title to draw: ${JSON.stringify(words)}` } };
  if (input.audience_key && !STYLE[input.audience_key]) return { failed: { status: 422, detail: `no style for audience ${JSON.stringify(input.audience_key)}` } };
  const drawn = input.level === 3
    ? prompt(words, input.audience_key ?? "")
    : await translated(words, sink, input.audience_key ?? "");
  if (typeof drawn !== "string") return drawn;
  const res = await call(sink, "/v1/images/generations", {
    ...level.body(input, drawn), negative_prompt: NEGATIVE, background: "white", n: 1, response_format: "b64_json",
  });
  const refusal = classify(res);
  if (refusal) return refusal;
  const b64 = String(res.body?.data?.[0]?.b64_json || "");
  if (!b64) return { failed: { status: 502, detail: "the answer carries no image" } };
  const mime = mimeOf(b64);
  if (!mime) return { failed: { status: 502, detail: `the image is neither PNG nor JPEG: ${b64.slice(0, 16)}` } };
  // Bytes, which the airlock stores in the blob plane and settles as their URL.
  return { done: { image: { $blob: { base64: b64, type: mime } } } };
}

// The prompt in English, or the outcome that ends the attempt.
async function translated(words, sink, audienceKey) {
  const text = await call(sink, "/v1/chat/completions", {
    tier: "cheap",
    temperature: 0,
    max_tokens: 512,
    messages: [{ role: "system", content: TRANSLATE }, { role: "user", content: JSON.stringify(words) }],
  });
  const refused = classify(text);
  if (refused) return refused;
  const answer = answerOf(text.body);
  let en;
  try {
    en = JSON.parse(answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1));
  } catch {
    return { retry: `the translation is not JSON: ${answer.slice(0, 120)}` };
  }
  if (typeof en?.word !== "string" || !en.word.trim() || typeof en?.title !== "string") {
    return { retry: `the translation lost the word or the title: ${answer.slice(0, 120)}` };
  }
  return prompt(en, audienceKey, words.word);
}
