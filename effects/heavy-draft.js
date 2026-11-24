// Airlock external effect handler: the heavy text for a whole deck via tsbifrost, the words and
// subjects level 3 draws. Each card's picture is its own illustrate-card effect (card-art.cue).
function isPictographicEmoji(str) {
  return /\p{Extended_Pictographic}/u.test(String(str || ""));
}

const TOPIC_ICON_SETS = {
  marcial: ["🥊", "🥋", "🤺", "🤼", "🏹"],
  danca: ["🩰", "💃", "🕺", "🪭", "🪗"],
  fazenda: ["🐑", "🐖", "🐄", "🐓", "🐎"],
  instrument: ["🎻", "🎺", "🎹", "🥁", "🎸"],
  anima: ["🦁", "🐘", "🦒", "🦓", "🐼"],
  fruta: ["🍎", "🍒", "🥝", "🍇", "🍑"],
  planeta: ["🪐", "🌍", "🌕", "☀️", "☄️"],
  espacia: ["🛸", "🚀", "🛰️", "🌌", "🔭"],
  default: ["🏛️", "🌟", "🎭", "🌿", "🔮"],
};

function pickTopicIconSet(topic) {
  const t = String(topic || "").toLowerCase();
  if (t.includes("marcia") || t.includes("martial") || /\blutas?\b/.test(t)) return TOPIC_ICON_SETS.marcial;
  if (t.includes("danç") || t.includes("danc") || t.includes("bail")) return TOPIC_ICON_SETS.danca;
  if (t.includes("fazenda") || t.includes("farm") || t.includes("granja")) return TOPIC_ICON_SETS.fazenda;
  if (t.includes("instrument") || t.includes("orquestra") || t.includes("músic") || t.includes("music")) return TOPIC_ICON_SETS.instrument;
  if (t.includes("anima") || t.includes("fauna") || t.includes("bicho")) return TOPIC_ICON_SETS.anima;
  if (t.includes("fruta") || t.includes("fruit")) return TOPIC_ICON_SETS.fruta;
  if (t.includes("planeta") || t.includes("planet") || t.includes("solar")) return TOPIC_ICON_SETS.planeta;
  if (t.includes("espacia") || t.includes("space") || t.includes("foguete")) return TOPIC_ICON_SETS.espacia;
  return TOPIC_ICON_SETS.default;
}

function extractJsonObject(raw) {
  if (typeof raw !== "string") return raw;
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .replace(/\\(?!["\\/bfnrtu])/g, "")
    .trim();
  const cardBlocks = [...cleaned.matchAll(/\{\s*"(?:cards|flashcards)"\s*:\s*\[[\s\S]*?\]\s*\}/g)]
    .map((m) => m[0])
    .filter((b) => !/\[\s*"\.\.\."\s*\]/.test(b));
  for (let i = cardBlocks.length - 1; i >= 0; i--) {
    try {
      JSON.parse(cardBlocks[i]);
      return cardBlocks[i];
    } catch (_e) {}
  }
  if (cardBlocks.length > 0) {
    return cardBlocks[cardBlocks.length - 1];
  }
  const firstBrace = cleaned.indexOf("{");
  const firstBracket = cleaned.indexOf("[");
  if (firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket)) {
    const lastBrace = cleaned.lastIndexOf("}");
    if (lastBrace > firstBrace) {
      return cleaned.slice(firstBrace, lastBrace + 1);
    }
  }
  if (firstBracket >= 0) {
    const lastBracket = cleaned.lastIndexOf("]");
    if (lastBracket > firstBracket) {
      return cleaned.slice(firstBracket, lastBracket + 1);
    }
  }
  return cleaned;
}

// Who the deck is for, from the age combo box: a preset's message key, or the reader's own words.
const AUDIENCE = {
  diff_toddler: "toddlers in early childhood",
  diff_kids: "children aged 6 to 10",
  diff_teens: "teenagers and adults",
};
const audienceOf = (input) => {
  const key = String(input?.audience_key || "");
  if (key && !AUDIENCE[key]) throw new TypeError(`heavy-draft knows no audience ${JSON.stringify(key)}`);
  return key ? AUDIENCE[key] : String(input?.audience || "").trim() || "learners of any age";
};

// The airlock reruns the effect on {retry}, with its backoff, up to the
// declaration's attempts; rate limiting, a server fault or no answer at all may
// pass by then. Any other refusal is the provider's verdict.
async function call(sink, path, init) {
  try {
    return await sink.fetch(path, init);
  } catch (e) {
    return { thrown: e instanceof Error ? e.message : String(e) };
  }
}

function retryOf(res) {
  if ("thrown" in res) return `network ${res.thrown}`;
  if (res.status === 429) return "429 rate limited";
  if (res.status >= 500) return `${res.status} provider error`;
  return null;
}

export async function issue(input, sink) {
  const rawTopic = String(input?.topic || "Instrumentos Musicais").trim();
  const locale = String(input?.locale || "pt-BR").trim();
  const rawRegion = String(input?.region || "Brasil").replace(/\s*::\s*run-\d+$/, "").trim() || "Brasil";
  const count = Math.max(1, Math.min(20, Number(input?.card_count) || 5));
  const baseTopic = rawTopic.split("::")[0].trim() || "Instrumentos Musicais";
  const details = String(input?.details || "").trim();
  const audience = audienceOf(input);

  const langNames = {
    "pt": "Português do Brasil",
    "pt-br": "Português do Brasil",
    "es": "Español",
    "es-la": "Español",
    "en": "English",
    "en-us": "English",
    "he": "עברית (Hebrew)",
    "he-il": "עברית (Hebrew)",
    "zh": "简体中文 (Simplified Chinese)",
    "zh-cn": "简体中文 (Simplified Chinese)",
  };
  const langLabel = langNames[locale.toLowerCase()] || locale;
  const topicIcons = pickTopicIconSet(baseTopic);

  const heavyCards = [];
  const chatRes = await call(sink, "/v1/chat/completions", {
    method: "POST",
    body: {
      tier: "heavy",
      temperature: 0.35,
      max_tokens: 1024,
      messages: [
        {
          role: "system",
          content:
            `[TIER:HEAVY] You are generating flashcards for a **visual dictionary** app for ${audience} learning new words.\n` +
            `Each flashcard has exactly two sides:\n` +
            `  SIDE A: a picture of a single subject (nothing else).\n` +
            `  SIDE B: the name of that subject, like a label under the picture.\n\n` +
            `This is NOT a quiz. NOT a riddle. NOT a trivia game. NOT Jeopardy. NOT "Who am I?". NOT first-person descriptions. NOT questions. NOT fun-facts. NOT definitions.\n` +
            `Just: PICTURE on one side, WORD on the other. Like a picture book, or a museum label next to an exhibit.\n\n` +
            `Cultural region: ${rawRegion}. Use subjects, animals, foods, and references familiar to ${audience} in this region.\n\n` +
            `FIELD RULES:\n` +
            `front_text — the NAME of the subject, in ${langLabel} (${locale}). One noun, occasionally a short noun phrase (maximum 3 words). This is a label, not a sentence.\n` +
            `  GOOD: "lion", "guitar", "red apple", "Eiffel Tower", "letter A"\n` +
            `  BAD:  "I am the king of the jungle", "who am I?", "what animal roars?", "a stringed instrument"\n` +
            `emoji — one emoji that stands for the subject.\n\n` +
            `The topic is the deck's title. Details, when given, refine every card and are never a card or a title.\n` +
            `Reply ONLY with a single-line JSON object {"cards":[{"front_text":"noun in ${langLabel}","emoji":"🔨"}]} containing ${count} items. No markdown, no explanations.`,
        },
        {
          role: "user",
          content: `Topic: "ferramentas" (3 items in Português do Brasil)`,
        },
        {
          role: "assistant",
          content: `{"cards":[{"front_text":"Martelo","emoji":"🔨"},{"front_text":"Serrote","emoji":"🪚"},{"front_text":"Alicate","emoji":"🔧"}]}`,
        },
        {
          role: "user",
          content: `[TIER:HEAVY] Topic: "${baseTopic}"${details ? ` Details: "${details}"` : ""} (Generate exactly ${count} iconic items in ${langLabel} (${locale}) for Cultural region: ${rawRegion})`,
        },
      ],
    },
  });

  const chatRetry = retryOf(chatRes);
  if (chatRetry) return { retry: chatRetry };
  if (chatRes.status < 200 || chatRes.status >= 300) {
    return { failed: { status: chatRes.status, topic: rawTopic, detail: chatRes.body } };
  }
  const rawBodyContent = chatRes.body?.message?.content ?? chatRes.body?.choices?.[0]?.message?.content ?? "";
  const rawContent = extractJsonObject(rawBodyContent);
  if (rawContent) {
    let arr = [];
    try {
      const parsed = typeof rawContent === "string" ? JSON.parse(rawContent) : rawContent;
      arr = Array.isArray(parsed)
        ? parsed
        : (Array.isArray(parsed?.cards) ? parsed.cards : (Array.isArray(parsed?.flashcards) ? parsed.flashcards : []));
    } catch (_err) {
      if (typeof rawContent === "string") {
        const afterCards = rawContent.replace(/^[\s\S]*?"cards"\s*:\s*\[/i, "");
        arr = [...afterCards.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map((m) => m[1].trim()).filter(Boolean);
      }
    }
    if (arr.length > 0) {
      const usedEmojis = new Set();
      const usedWords = new Set();
      for (let i = 0; i < arr.length && heavyCards.length < count; i++) {
        const item = arr[i];
        const word = String(
          typeof item === "string"
            ? item
            : (item?.front_text || item?.word || item?.front || item?.name || "")
        ).replace(/\^\{\\?prime\}|[{}]/g, "").replace(/[,.;:!?]+$/g, "").trim();
        const rawEmoji = (typeof item === "object" && item !== null && item.emoji) ? String(item.emoji).trim() : "";
        const validEmoji = isPictographicEmoji(rawEmoji) && rawEmoji !== "🧭" && rawEmoji !== "⏳" && !usedEmojis.has(rawEmoji)
          ? rawEmoji
          : "";
        const emoji = validEmoji || topicIcons[heavyCards.length % topicIcons.length];
        usedEmojis.add(emoji);
        const normWord = word.toLowerCase();
        if (word && !/\b\d+$/.test(word) && !usedWords.has(normWord)) {
          usedWords.add(normWord);
          heavyCards.push({ word, emoji });
        }
      }
    }
  }

  if (heavyCards.length === 0) {
    return { failed: { status: 422, topic: rawTopic, detail: "the heavy text named no cards" } };
  }
  return { done: { topic: rawTopic, cards_json: JSON.stringify(heavyCards) } };
}
