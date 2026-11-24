// Airlock external effect handler: the cheap text for a whole deck, or a deck's translation,
// via tsbifrost. Each card's picture is its own illustrate-card effect (card-art.cue).
function isPictographicEmoji(str) {
  return /\p{Extended_Pictographic}/u.test(String(str || ""));
}

const TOPIC_ICON_SETS = {
  marcial: ["🥋", "🥊", "🤼", "🤺", "🥷"],
  danca: ["💃", "🕺", "🩰", "🪗", "🪭"],
  fazenda: ["🐄", "🐎", "🐖", "🐓", "🐑"],
  instrument: ["🎸", "🎹", "🥁", "🎺", "🎻"],
  anima: ["🐾", "🦜", "🐢", "🐒", "🦋"],
  fruta: ["🍍", "🥭", "🍓", "🍉", "🍌"],
  planeta: ["🪐", "🌍", "☀️", "🌙", "☄️"],
  espacia: ["🚀", "🛰️", "🌌", "👨‍🚀", "🔭"],
  default: ["🎨", "🌟", "🌿", "🔮", "🎭"],
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
  if (key && !AUDIENCE[key]) throw new TypeError(`smollm3-draft knows no audience ${JSON.stringify(key)}`);
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
  const topic = String(input?.topic || "Instrumentos Musicais").trim();
  const details = String(input?.details || "").trim();
  const audience = audienceOf(input);
  const locale = String(input?.locale || "pt-BR").trim();
  const count = Math.max(1, Math.min(20, Number(input?.card_count) || 5));
  const langNames = {
    "pt": "Português do Brasil",
    "pt-br": "Português do Brasil",
    "português": "Português do Brasil",
    "portugues": "Português do Brasil",
    "es": "Español",
    "es-la": "Español",
    "español": "Español",
    "espanol": "Español",
    "en": "English",
    "en-us": "English",
    "english": "English",
    "he": "עברית (Hebrew)",
    "he-il": "עברית (Hebrew)",
    "עברית": "עברית (Hebrew)",
    "zh": "简体中文 (Simplified Chinese)",
    "zh-cn": "简体中文 (Simplified Chinese)",
    "中文": "简体中文 (Simplified Chinese)",
    "fr": "Français",
    "fr-fr": "Français",
    "français": "Français",
    "de": "Deutsch",
    "de-de": "Deutsch",
    "deutsch": "Deutsch",
    "it": "Italiano",
    "it-it": "Italiano",
    "italiano": "Italiano",
    "ja": "日本語 (Japanese)",
    "ja-jp": "日本語 (Japanese)",
    "日本語": "日本語 (Japanese)",
    "klingon": "tlhIngan Hol (Klingon)",
  };
  const regionNames = {
    "pt": "Brazil",
    "pt-br": "Brazil",
    "português": "Brazil",
    "portugues": "Brazil",
    "es": "Latin America",
    "es-la": "Latin America",
    "español": "Latin America",
    "espanol": "Latin America",
    "en": "North America",
    "en-us": "North America",
    "english": "North America",
    "he": "Israel",
    "he-il": "Israel",
    "עברית": "Israel",
    "zh": "China",
    "zh-cn": "China",
    "中文": "China",
  };
  const langLabel = langNames[locale.toLowerCase()] || locale;
  const rawRegion = String(input?.region || "").replace(/\s*::\s*run-\d+$/, "").trim();
  const culturalRegion = (rawRegion && !/^run-\d+$/.test(rawRegion) && !rawRegion.startsWith("xlat-"))
    ? rawRegion
    : (regionNames[locale.toLowerCase()] || "Global");

  const xlatMatch = topic.match(/^(.*?)\s*::\s*\[TRANSLATE:([a-z-]+)\]\s*::\s*(.+)$/i);
  const translationInput = xlatMatch && xlatMatch[3].trim().startsWith("{")
    ? JSON.parse(xlatMatch[3].trim()) : null;
  const messages = xlatMatch
    ? [
        {
          role: "system",
          content:
            `Translate all supplied user content into ${langLabel} (${locale}). Preserve the EXACT order of the ${count} card words, and any category number prefix. Keep card words concise (1-3 words); preserve the meaning of the full title. Return only a JSON object with name, category and cards. No markdown, no explanations.`,
        },
        {
          role: "user",
          content: `Translate into ${langLabel} (${locale}): ${xlatMatch[3].trim()}`,
        },
      ]
    : [
        {
          role: "system",
          content:
            `You are generating flashcards for a **visual dictionary** app for ${audience} learning new words.\n` +
            `Each flashcard has exactly two sides:\n` +
            `  SIDE A: a picture of a single subject (nothing else).\n` +
            `  SIDE B: the name of that subject, like a label under the picture.\n` +
            `This is NOT a quiz. NOT a riddle. NOT a trivia game. NOT "Who am I?". NOT definitions. Just: PICTURE on one side, WORD on the other.\n` +
            `Cultural region: ${culturalRegion}. Use subjects, animals, foods, and references familiar to ${audience} in this region.\n` +
            `FIELD RULES:\n` +
            `- front_text: the NAME of the subject, in ${langLabel} (${locale}). One noun or short noun phrase (maximum 3 words). Just the noun.\n` +
            `- emoji: one emoji that stands for the subject.\n` +
            `The topic is the deck's title. Details, when given, refine every card and are never a card or a title.\n` +
            `Reply ONLY with a single-line JSON object {"cards":[{"front_text":"...","emoji":"🔨"}]} containing ${count} items. No markdown, no explanations.`,
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
          content: `Topic: "${topic}"${details ? ` Details: "${details}"` : ""} (Generate exactly ${count} specific items in ${langLabel} (${locale}) for Cultural region: ${culturalRegion})`,
        },
      ];

  const res = await call(sink, "/v1/chat/completions", {
    method: "POST",
    body: {
      tier: "cheap",
      temperature: 0.2,
      max_tokens: xlatMatch ? 2048 : 1024,
      ...(xlatMatch ? { response_format: {
        type: "json_schema",
        json_schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            category: { type: "string" },
            cards: { type: "array", items: { type: "string" }, minItems: count, maxItems: count },
          },
          required: ["name", "category", "cards"],
          additionalProperties: false,
        },
      } } : {}),
      messages,
    },
  });
  const textRetry = retryOf(res);
  if (textRetry) return { retry: textRetry };
  if (res.status < 200 || res.status >= 300) {
    return { failed: { status: res.status, topic, detail: res.body } };
  }

  const palette = ["#FED7AA", "#FEF08A", "#BFDBFE", "#A7F3D0", "#FBCFE8"];
  const topicIcons = pickTopicIconSet(topic);
  let rawCards = [];
  let translatedMetadata = null;
  const rawBodyContent = res.body?.message?.content ?? res.body?.choices?.[0]?.message?.content ?? res.body;
  const rawContent = extractJsonObject(rawBodyContent);
  try {
    const parsed = typeof rawContent === "string" ? JSON.parse(rawContent) : rawContent;
    if (translationInput) {
      if (typeof parsed?.name !== "string" || !parsed.name.trim() ||
          (translationInput.category && (typeof parsed.category !== "string" || !parsed.category.trim()))) {
        return { failed: { status: 422, topic } };
      }
      translatedMetadata = { name: parsed.name.trim(), category: String(parsed.category || "").trim() };
    }
    if (Array.isArray(parsed)) {
      rawCards = parsed;
    } else if (Array.isArray(parsed?.cards)) {
      rawCards = parsed.cards;
    } else if (Array.isArray(parsed?.items)) {
      rawCards = parsed.items;
    }
  } catch (_err) {
    if (xlatMatch) return { failed: { status: 422, topic } };
    if (typeof rawContent === "string") {
      const afterCards = rawContent.replace(/^[\s\S]*?"cards"\s*:\s*\[/i, "");
      const matches = [...afterCards.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map((m) => m[1].trim()).filter(Boolean);
      if (matches.length >= count) {
        rawCards = matches;
      } else {
        return { failed: { status: 422, topic } };
      }
    } else {
      return { failed: { status: 422, topic } };
    }
  }

  if (!Array.isArray(rawCards) || rawCards.length < count) {
    return { failed: { status: 422, topic } };
  }

  const usedEmojis = new Set();
  const normalized = [];
  for (let i = 0; i < count; i++) {
    const item = rawCards[i];
    const word = String(
      typeof item === "string"
        ? item
        : (item?.word || item?.front_text || item?.front || item?.name || item?.title || "")
    ).replace(/\^\{\\?prime\}|[{}]/g, "").replace(/[,.;:!?]+$/g, "").trim();
    if (!word) {
      return { failed: { status: 422, topic } };
    }
    const rawEmoji = (typeof item === "object" && item !== null && item.emoji) ? String(item.emoji).trim() : "";
    const validRawEmoji = isPictographicEmoji(rawEmoji) && rawEmoji !== "🧭" && rawEmoji !== "⏳" && !usedEmojis.has(rawEmoji)
      ? rawEmoji
      : "";
    const emoji = validRawEmoji || topicIcons[i % topicIcons.length];
    usedEmojis.add(emoji);
    normalized.push({ word, emoji, color: palette[i % palette.length] });
  }

  return {
    done: {
      topic,
      locale,
      cards_json: JSON.stringify(translatedMetadata ? { ...translatedMetadata, cards: normalized } : normalized),
    },
  };
}
