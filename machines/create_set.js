({ context, event }) => {
  if (event.type === "mutation" && context.ssr) return { updates: [] };
  const requests = (context.rows?.generation_ask ?? []).slice().sort((a, b) => {
    const left = String(a.created_at ?? "");
    const right = String(b.created_at ?? "");
    if (left !== right) return left < right ? -1 : 1;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  });
  const requested = event.with?.request;
  const ask = requested ? requests.find((row) => row.id === requested) : requests[0];
  const fromAsk = event.type === "mutation" && event.from === "generation-asks";
  if ((fromAsk || event.type === "mint-deck" || event.type === "complete-create") && !ask) return { updates: [] };
  if (event.type === "complete-create") {
    return { updates: [
      ...(requests.some((row) => row.id !== ask.id) ? [] : [event.with.form]),
      { op: "delete", entity: "generation_ask", id: ask.id }
    ] };
  }
  const claim = (fromAsk || event.type === "mint-deck") && ask?.set_id ? ask : null;
  const input = claim ? JSON.parse(claim.input) : null;
  if (claim) {
    if (!claim.run || !input.draft || !input.device) throw new Error("incomplete generation acceptance");
    context = { ...context, locale: input.locale, rows: { ...context.rows, generation_form: [input.draft], device: [input.device], browser_draft: input.browser_draft } };
    event = { type: "click", from: "btn-create", detail: input.detail };
  } else if ((fromAsk || event.type === "mint-deck") && ask?.input) {
    context = { ...context, rows: { ...context.rows, generation_form: [JSON.parse(ask.input)] } };
  }

  const canonSort = (arr) => (arr ?? []).slice().sort((a, b) => {
    const ida = String(a?.id ?? "");
    const idb = String(b?.id ?? "");
    if (ida !== idb) return ida < idb ? -1 : 1;
    const ja = JSON.stringify(a ?? null);
    const jb = JSON.stringify(b ?? null);
    return ja < jb ? -1 : ja > jb ? 1 : 0;
  });

  // The form is this browser's own row; the text slots are this device's, among every device's.
  const draft = canonSort(context.rows?.generation_form ?? context.reads?.generation_form ?? context.items ?? [])
    .find((d) => d && d.id === "draft") || {};
  // The form chart owns status; Cortex correlates its accepted run with backend progress.
  const FORM = { id: "draft", topic: "", category: "", locale: "", region: "", card_count: 5, status: "idle", set_id: "", details: "", words: "", next: 0, audience_key: "diff_kids", audience: "", run: "" };
  const formUpdate = (changes) => ({ op: "put", entity: "generation_form", id: "draft", row: { id: "draft", ...changes }, absent: FORM });
  const device = canonSort(context.rows?.device ?? context.reads?.device ?? []).find((d) => d && d.id === "device");
  // The reader's own `me` row, the one visible to them: a deck is theirs when it names it.
  const meId = String(canonSort(context.rows?.me ?? context.reads?.me ?? [])[0]?.id ?? "");
  const key = String(device?.key ?? "");
  // The device's two slots, each read by its id (the screens' data-read-draft_*): every other
  // device's slots were the whole table, and every render carried them.
  const cheapDraft = key ? (context.rows?.draft_cheap ?? []).find((d) => d && d.id === `${key}:draft-cheap`) : undefined;
  const heavyDraft = key ? (context.rows?.draft_heavy ?? []).find((d) => d && d.id === `${key}:draft-heavy`) : undefined;

  // What a form starts from and a quick pick asks for, in the reader's language: a deck's title
  // is written in it, so a Portuguese default became an English reader's deck.
  const DEFAULTS = {
    pt: { locale: "Português", code: "pt-BR", city: "São Paulo, Brasil", land: "Brasil", topic: "Animais Brasileiros", category: "Fauna", anyTopic: "Instrumentos Musicais", anyCategory: "Exploração",
      quick: { animals: ["Animais Brasileiros", "Fauna"], planets: ["Planetas e Estrelas", "Espaço"], fruits: ["Frutas Tropicais", "Frutas"], home: ["Palavras do Cotidiano", "Cotidiano"], letters: ["Alfabeto Divertido", "Alfabeto"] } },
    en: { locale: "English", code: "en-US", city: "New York, USA", land: "USA", topic: "Brazilian Animals", category: "Animals", anyTopic: "Musical Instruments", anyCategory: "Exploration",
      quick: { animals: ["Brazilian Animals", "Animals"], planets: ["Planets and Stars", "Space"], fruits: ["Tropical Fruits", "Fruits"], home: ["Everyday Words", "Everyday"], letters: ["Fun Alphabet", "Alphabet"] } },
    es: { locale: "Español", code: "es-LA", city: "Ciudad de México, México", land: "México", topic: "Animales de Brasil", category: "Fauna", anyTopic: "Instrumentos Musicales", anyCategory: "Exploración",
      quick: { animals: ["Animales de Brasil", "Fauna"], planets: ["Planetas y Estrellas", "Espacio"], fruits: ["Frutas Tropicales", "Frutas"], home: ["Palabras Cotidianas", "Cotidiano"], letters: ["Alfabeto Divertido", "Alfabeto"] } },
    he: { locale: "עברית", code: "he-IL", city: "תל אביב, ישראל", land: "ישראל", topic: "חיות מברזיל", category: "חיות", anyTopic: "כלי נגינה", anyCategory: "חקירה",
      quick: { animals: ["חיות מברזיל", "חיות"], planets: ["כוכבי לכת וכוכבים", "חלל"], fruits: ["פירות טרופיים", "פירות"], home: ["מילים יומיומיות", "יומיום"], letters: ["אלפבית מהנה", "אלפבית"] } },
    zh: { locale: "中文", code: "zh-CN", city: "北京, 中国", land: "中国", topic: "巴西动物", category: "动物", anyTopic: "乐器", anyCategory: "探索",
      quick: { animals: ["巴西动物", "动物"], planets: ["行星与恒星", "太空"], fruits: ["热带水果", "水果"], home: ["日常词汇", "日常"], letters: ["趣味字母", "字母"] } },
    hi: { locale: "हिन्दी", code: "hi-IN", city: "नई दिल्ली, भारत", land: "भारत", topic: "ब्राज़ील के जानवर", category: "जानवर", anyTopic: "वाद्य यंत्र", anyCategory: "खोज",
      quick: { animals: ["ब्राज़ील के जानवर", "जानवर"], planets: ["ग्रह और तारे", "अंतरिक्ष"], fruits: ["उष्णकटिबंधीय फल", "फल"], home: ["रोज़मर्रा के शब्द", "रोज़मर्रा"], letters: ["मज़ेदार वर्णमाला", "वर्णमाला"] } },
  };
  const said = DEFAULTS[String(context.locale ?? "pt").slice(0, 2)] ?? DEFAULTS.pt;
  const isMutation = event.type === "mutation";
  const isIntent = isMutation && event.from === "generation-asks";
  const isBrowserDraft = event.type === "draft";
  // Its columns are for an absent row only: a slot that arrived while this wake ran keeps its work.
  const slotRow = (id) => ({
    op: "put",
    entity: "generation_draft",
    id,
    row: { id },
    absent: { topic: "", category: "", locale: "", region: "", card_count: 0, status: "idle", set_id: "", details: "" }
  });

  // A slot is a server write, and in a step it held the screen until the server took it, so
  // unless a Create is waiting for one, slots are put behind the screen.
  const slotsAhead = (ids) => ({ type: "ensure-slots", delay: 1, with: { ids } });
  if (event.type === "ensure-slots") return { updates: event.with.ids.map(slotRow) };
  // A finished translation's words are a write each, which held whatever screen was opening.
  const settledBehind = (updates) => ({ updates: [], then: { type: "settle-translation", delay: 1, with: { updates } } });
  if (event.type === "settle-translation") return { updates: event.with.updates };

  // The device's key: 64 bits from two of the terminal's draws, gathered one step each, put
  // once with the device's two idle text slots. A chain that finds a key another one put
  // writes nothing.
  if (event.type === "mint-device") {
    const draws = [...(event.with?.draws ?? []), event.seed];
    if (draws.length < 2) return { updates: [], then: { type: "mint-device", seed: true, with: { draws, ...(event.with?.intent ? { intent: event.with.intent, request: event.with.request } : {}) } } };
    // A row with no key is one the theme chart wrote from the region's fallback
    // before any deck was made: it is unminted, and keeps what it holds.
    if (device?.key) return { updates: [], ...(event.with?.intent ? { then: { type: "mutation", from: event.with.intent, with: { request: event.with.request } } } : {}) };
    const minted = draws.map((n) => (Number(n) >>> 0).toString(16).padStart(8, "0")).join("");
    const slots = [`${minted}:draft-cheap`, `${minted}:draft-heavy`];
    const keyRow = { op: "put", entity: "device", id: "device", row: { ...(device ?? {}), id: "device", key: minted } };
    if (event.with?.intent) return {
      updates: [slotRow(slots[0]), keyRow, slotRow(slots[1])],
      then: { type: "mutation", from: event.with.intent, with: { request: event.with.request } }
    };
    return { updates: [keyRow], then: slotsAhead(slots) };
  }

  // A deck's id is the terminal's draw, so a replay mints the same one. Its title is a column:
  // two decks may share it, and a deck created again under its title once replaced the other's
  // cards. The step carries the Create that asked, as plain data, and ends as that Create.
  let minted = "";
  if (event.type === "mint-deck") {
    if (typeof event.uuid !== "string") throw new Error("mint-deck needs the terminal's uuid");
    minted = event.uuid;
    event = event.with.event;
  }

  // One card of a deck this tab generated, once its delete button was tapped twice (the
  // card_delete chart): the card goes, the deck's count follows, and a session on the deck
  // keeps its place among the cards left. Its art rows go server-side once they settle
  // (018_deck_level.sql). A deck's last card goes with the deck, and a card of a deck this tab
  // did not generate stays; either way the intent row goes, which returns the button to idle.
  const confirmedDelete = isMutation
    ? canonSort(context.rows?.card_delete ?? []).find((d) => d && d.state === "confirmed")
    : undefined;
  if (confirmedDelete) {
    const cardId = String(confirmedDelete.id);
    const dropIntent = { op: "delete", entity: "card_delete", id: cardId };
    const allCardRows = canonSort(context.rows?.flashcard ?? context.reads?.flashcard ?? []);
    const deckId = String(allCardRows.find((c) => c && c.id === cardId)?.set_id || "");
    const deckRow = canonSort(context.rows?.card_set ?? context.reads?.card_set ?? []).find((s) => s && s.id === deckId);
    const press = canonSort(context.rows?.print_config ?? context.reads?.print_config ?? []).find((c) => c && c.id === "press");
    const owned = Boolean(deckRow?.owner) && deckRow.owner === meId;
    const deckCards = allCardRows.filter((c) => c && c.set_id === deckId);
    const at = deckCards.findIndex((c) => c.id === cardId);
    if (!deckRow || !owned || at < 0 || deckCards.length < 2) return { updates: [dropIntent] };
    const left = deckCards.filter((c) => c.id !== cardId);
    // The press lease rewritten as it is keeps the two server writes out of one /crud/tx batch.
    const cardUpdates = [
      dropIntent,
      { op: "patch", entity: "card_set", id: deckId, row: { count: left.length } },
      { op: "patch", entity: "print_config", id: "press", row: { set_id: press.set_id } },
      { op: "delete", entity: "flashcard", id: cardId }
    ];
    const session = canonSort(context.rows?.play_session ?? context.reads?.play_session ?? []).find((x) => x && x.id === "session");
    if (session && session.set_id === deckId) {
      const current = Math.max(0, Math.min(deckCards.length - 1, Math.floor(Number(session.card_index)) || 0));
      const index = Math.min(left.length - 1, current > at ? current - 1 : current);
      const shown = left[index];
      cardUpdates.push({
        op: "patch",
        entity: "play_session",
        id: "session",
        row: { card_index: index, total: left.length, flipped: "no", front: shown.front, card_id: shown.id, original_front: shown.front || "", emoji: shown.emoji || "✨", back: "" }
      });
    }
    return { updates: cardUpdates };
  }
  const allBrowserDrafts = canonSort(context.rows?.browser_draft ?? context.reads?.browser_draft ?? []);
  const inferDefaultCategory = (t) => {
    const s = String(t || "").toLowerCase();
    if (s.includes("planeta") || s.includes("estrela") || s.includes("solar") || s.includes("espacia")) return "Astronomia";
    if (s.includes("fruta") || s.includes("flor") || s.includes("planta")) return "Frutas & Botânica";
    if (s.includes("quadrinho") || s.includes("revista") || s.includes("comic")) return "Arte & Quadrinhos";
    if (s.includes("cotidiano") || s.includes("casa")) return "Cotidiano";
    if (s.includes("alfabeto") || s.includes("letra")) return "Alfabeto";
    if (s.includes("carro") || s.includes("veículo") || s.includes("veiculo")) return "Automotivo";
    if (s.includes("comida") || s.includes("culin")) return "Gastronomia";
    if (s.includes("esporte") || s.includes("jogo")) return "Esportes";
    if (s.includes("dino") || s.includes("fóssil")) return "Paleontologia";
    if (s.includes("instrument") || s.includes("músic") || s.includes("music")) return "Música";
    if (s.includes("anima") || s.includes("fauna") || s.includes("fazenda")) return "Fauna";
    return "Cultura & Exploração";
  };

  if (event.type === "keydown") {
    // A modified Tab is a reader leaving backwards or switching away, which asks for nothing.
    if (event.key !== "Tab" || event.modified || !event.from || String(event.value ?? "").trim() !== "") {
      return { updates: [] };
    }
    const dTopic = String(draft?.topic || said.topic).trim();
    const dLocale = String(draft?.locale || said.locale).trim();
    const idleMemo =
      allBrowserDrafts.find(
        (b) =>
          b &&
          String(b.status || "").trim() === "idle" &&
          String(b.topic || "").trim().toLowerCase() === dTopic.toLowerCase() &&
          String(b.locale || "").trim() === dLocale
      ) ||
      allBrowserDrafts.find((b) => b && String(b.status || "").trim() === "idle") ||
      {};
    let tabPatch = null;
    if (event.from === "category-input") {
      tabPatch = { category: String(idleMemo.w0 || (said === DEFAULTS.pt ? inferDefaultCategory(dTopic) : dTopic === said.topic ? said.category : said.anyCategory)).trim() || said.category };
    } else if (event.from === "locale-input") {
      tabPatch = { locale: String(idleMemo.w2 || said.locale).trim() || said.locale };
    } else if (event.from === "region-input") {
      tabPatch = { region: String(idleMemo.w3 || said.city).trim() || said.city };
    } else if (event.from === "difficulty-select") {
      tabPatch = { audience_key: "diff_kids", audience: "" };
    } else if (event.from === "topic-input") {
      tabPatch = { topic: String(idleMemo.w4 || said.topic).trim() || said.topic };
    }
    if (!tabPatch) return { updates: [] };
    return {
      updates: [
        formUpdate(tabPatch)
      ]
    };
  }

  const fromId = event.from || event.target?.id || "";
  const cmd = event.command;
  if (event.type !== "click" && cmd === undefined && !isMutation && !isBrowserDraft && !isIntent) return { updates: [] };

  const rawDetailForAction = (event && typeof event.detail === "object" && event.detail !== null) ? event.detail : {};
  const actionKind =
    cmd ||
    rawDetailForAction.action ||
    event.action ||
    event.target?.dataset?.action ||
    event.target?.closest?.("[data-action]")?.dataset?.action ||
    "";
  if (actionKind === "delete" || fromId.startsWith("btn-delete-")) {
    const delSetId = String(
      rawDetailForAction.setId ||
      rawDetailForAction.id ||
      event.setId ||
      event.target?.dataset?.setId ||
      event.target?.dataset?.id ||
      event.target?.closest?.("[data-set-id]")?.dataset?.setId ||
      event.target?.closest?.("[data-id]")?.dataset?.id ||
      event.id ||
      ""
    ).trim();
    if (!delSetId) return { updates: [] };
    const allSetsForDel = canonSort(context.rows?.card_set ?? context.reads?.card_set ?? []);
    const allCardsForDel = canonSort(context.rows?.flashcard ?? context.reads?.flashcard ?? []);
    const allSessionsForDel = canonSort(context.rows?.play_session ?? context.reads?.play_session ?? []);
    const allConfigsForDel = canonSort(context.rows?.print_config ?? context.reads?.print_config ?? []);
    const curSess = allSessionsForDel.find((s) => s && s.id === "session");
    const curCfg = allConfigsForDel.find((c) => c && c.id === "config");
    const pressCfg = allConfigsForDel.find((c) => c && c.id === "press");
    const targetSetRow = allSetsForDel.find((s) => s && s.id === delSetId);
    if (!targetSetRow || !targetSetRow.owner || targetSetRow.owner !== meId) return { updates: [] };
    const remainingGenSets = allSetsForDel
      .filter((s) => s && s.owner === meId && s.id !== delSetId)
      .sort((a, b) => Number(b?.number ?? 0) - Number(a?.number ?? 0));
    const fallbackSet =
      remainingGenSets[0] ||
      allSetsForDel.find((s) => s && s.id !== delSetId) ||
      { id: "69618be6-9206-f9c7-59eb-b5e4b072cf3d", count: 20 };
    const fallbackCards = allCardsForDel.filter((c) => c && c.set_id === fallbackSet.id);
    const fallbackCard = fallbackCards[0] || { front: "", emoji: "" };

    const delUpdates = [];
    const serverEnts = new Set(["generation_draft", "card_set", "flashcard"]);
    const pushDelServer = (u) => {
      if (delUpdates.length > 0 && serverEnts.has(delUpdates[delUpdates.length - 1].entity)) {
        delUpdates.push({
          op: "patch",
          entity: "print_config",
          id: "config",
          row: { set_id: fallbackSet.id }
        });
      }
      delUpdates.push(u);
    };

    if (curSess && curSess.set_id === delSetId) {
      delUpdates.push({
        op: "patch",
        entity: "play_session",
        id: "session",
        row: {
          set_id: fallbackSet.id,
          card_index: 0,
          flipped: "no",
          mastered: remainingGenSets.length,
          total: Math.max(1, Number(fallbackSet.count) || fallbackCards.length || 5),
          finished: "",
          front: fallbackCard.front,
          card_id: fallbackCard.id || "",
          original_front: fallbackCard.front || "",
          back: "",
          hint: remainingGenSets[0]?.name || "",
          emoji: fallbackCard.emoji
        }
      });
    }
    if (curCfg && curCfg.set_id === delSetId) {
      delUpdates.push({
        op: "patch",
        entity: "print_config",
        id: "config",
        row: { set_id: fallbackSet.id }
      });
    }
    if (pressCfg && String(pressCfg.set_id || "").split("|").includes(delSetId)) {
      const nextLeased = String(pressCfg.set_id || "").split("|").filter((id) => id && id !== delSetId).join("|");
      delUpdates.push({
        op: "patch",
        entity: "print_config",
        id: "press",
        row: { set_id: nextLeased || "none" }
      });
    }
    pushDelServer({
      op: "delete",
      entity: "card_set",
      id: delSetId
    });
    return { updates: delUpdates };
  }

  const quickMap = Object.fromEntries(Object.entries(said.quick).map(([pick, words]) => [`quick-${pick}`, words]));
  const locByCode = {
    "geo-city": ["Português", "São Paulo, Brasil", "Animais Brasileiros", "Fauna"],
    "pt-BR": ["Português", "São Paulo, Brasil", "Animais Brasileiros", "Fauna"],
    "Português": ["Português", "São Paulo, Brasil", "Animais Brasileiros", "Fauna"],
    "es-LA": ["Español", "Cidade do México, México", "Fauna de Sudamérica", "Fauna"],
    "Español": ["Español", "Cidade do México, México", "Fauna de Sudamérica", "Fauna"],
    "en-US": ["English", "Nova York, EUA", "Amazon Rainforest Wildlife", "Fauna"],
    "English": ["English", "Nova York, EUA", "Amazon Rainforest Wildlife", "Fauna"],
    "he-IL": ["עברית", "Tel Aviv, Israel", "חיות בר ואמזונס", "Fauna"],
    "עברית": ["עברית", "Tel Aviv, Israel", "חיות בר ואמזונס", "Fauna"],
    "zh-CN": ["中文", "Pequim, China", "南美与自然野生动物", "Fauna"],
    "中文": ["中文", "Pequim, China", "南美与自然野生动物", "Fauna"],
    "hi-IN": ["हिन्दी", "Nova Délhi, Índia", "अमेज़न के जंगली जानवर", "Fauna"],
    "हिन्दी": ["हिन्दी", "Nova Délhi, Índia", "अमेज़न के जंगली जानवर", "Fauna"],
    "fr-FR": ["Français", "Paris, França", "Faune d'Amérique du Sud", "Fauna"],
    "Français": ["Français", "Paris, França", "Faune d'Amérique du Sud", "Fauna"],
    "de-DE": ["Deutsch", "Berlim, Alemanha", "Wildtiere Südamerikas", "Fauna"],
    "Deutsch": ["Deutsch", "Berlim, Alemanha", "Wildtiere Südamerikas", "Fauna"],
    "it-IT": ["Italiano", "Roma, Itália", "Fauna del Sudamerica", "Fauna"],
    "Italiano": ["Italiano", "Roma, Itália", "Fauna del Sudamerica", "Fauna"],
    "ja-JP": ["日本語", "Tóquio, Japão", "アマゾンの野生動物", "Fauna"],
    "日本語": ["日本語", "Tóquio, Japão", "アマゾンの野生動物", "Fauna"]
  };
  const locMap = {
    "draft-geo-city": locByCode["geo-city"],
    "draft-loc-pt": locByCode["pt-BR"],
    "draft-loc-es": locByCode["es-LA"],
    "draft-loc-en": locByCode["en-US"],
    "draft-loc-he": locByCode["he-IL"],
    "draft-loc-zh": locByCode["zh-CN"],
    "draft-loc-hi": locByCode["hi-IN"],
    "draft-loc-fr": locByCode["fr-FR"],
    "draft-loc-de": locByCode["de-DE"],
    "draft-loc-it": locByCode["it-IT"],
    "draft-loc-ja": locByCode["ja-JP"]
  };
  const fromQuick = fromId ? quickMap[fromId] : null;
  const fromLoc = fromId ? locMap[fromId] : null;
  const defaultTopics = [
    "",
    "instrumentos musicais",
    "animais brasileiros",
    "fauna de sudamérica",
    "amazon rainforest wildlife",
    "חיות בר ואמזונס",
    "南美与自然野生动物",
    "faune d'amérique du sud",
    "wildtiere südamerikas",
    "fauna del sudamerica",
    "アマゾンの野生動物"
  ];
  const draftTopicTrimmed = String(draft.topic ?? "").trim();
  const hasCustomTopic = draftTopicTrimmed.length > 0 && !defaultTopics.includes(draftTopicTrimmed.toLowerCase());
  const detail = (event && typeof event.detail === "object" && event.detail !== null) ? event.detail : {};

  const topic = (
    detail.topic ??
    event.topic ??
    event.target?.dataset?.topic ??
    event.target?.closest?.("[data-topic]")?.dataset?.topic ??
    fromQuick?.[0] ??
    (hasCustomTopic ? draftTopicTrimmed : (fromLoc?.[2] ?? (draftTopicTrimmed || said.anyTopic)))
  ).trim() || said.anyTopic;

  const rawCat = String(
    detail.category ??
    event.category ??
    event.target?.dataset?.category ??
    fromQuick?.[1] ??
    (hasCustomTopic ? (draft.category ?? "") : (fromLoc?.[3] ?? draft.category ?? ""))
  ).trim();
  const categoryName = rawCat || said.anyCategory;
  const loc = String(detail.locale || event.locale || event.target?.dataset?.locale || fromLoc?.[0] || draft.locale || said.code).trim() || said.code;
  const reg = String(detail.region || event.region || event.target?.dataset?.region || fromLoc?.[1] || draft.region || said.land).trim() || said.land;
  const cardCount = Math.max(1, Math.min(20, Math.floor(Number(draft.card_count)) || 5));

  const isPresetPill = !isBrowserDraft && (Boolean(fromQuick || fromLoc) || Boolean(event.target?.dataset?.topic && !detail.modelTier && !event.modelTier && !event.target?.dataset?.modelTier && fromId !== "btn-create"));
  if (!isMutation && isPresetPill) {
    // A pill states only the columns it changes: this reduce reads the form
    // before an edit typed meanwhile, and restating a column from that read
    // would undo the edit. A language pill keeps a topic the reader wrote.
    const keepsTopic = Boolean(fromLoc && hasCustomTopic);
    return {
      updates: [
        formUpdate({
            ...(keepsTopic ? {} : { topic, category: rawCat || categoryName }),
            locale: loc,
            region: reg
          })
      ]
    };
  }

  // A deck and its slots are named by the device's key, minted first. A region that does not
  // read the device would mint a new key on every wake.
  if (!key) {
    if (!Array.isArray(context.rows?.device ?? context.reads?.device)) throw new Error("create_set needs a region that reads device");
    return { updates: [], then: { type: "mint-device", seed: true, ...(isIntent ? { with: { intent: "generation-asks", request: ask.id } } : {}) } };
  }

  // A device outlives the database it was minted against, and with no cheap slot it would read
  // every deck untranslated, silently: a translation runs on a slot it finds.
  if (isMutation && Array.isArray(context.rows?.draft_cheap) && !cheapDraft) {
    const slots = [`${key}:draft-cheap`, ...(heavyDraft ? [] : [`${key}:draft-heavy`])];
    if (requests.length) return { updates: slots.map(slotRow), ...(isIntent ? { then: { type: "mutation", from: "generation-asks", with: { request: ask.id } } } : {}) };
    return { updates: [], then: slotsAhead(slots) };
  }

  const explicitSetId = detail.setId || event.target?.dataset?.setId;
  const allSets = canonSort(context.rows?.card_set ?? context.reads?.card_set ?? []);
  const allCards = canonSort(context.rows?.flashcard ?? context.reads?.flashcard ?? []);
  const allSessions = canonSort(context.rows?.play_session ?? context.reads?.play_session ?? []);
  const rawConfigs = context.rows?.print_config ?? context.reads?.print_config;
  const hasPrintConfigRead = Array.isArray(rawConfigs);
  const allConfigs = canonSort(rawConfigs ?? []);
  // A Create mints its deck's id first; a draft or a wake afterwards is of the deck its form
  // names. A deck is never found by its title.
  const setId = claim?.set_id || explicitSetId || minted || (isBrowserDraft || isMutation ? String(draft.set_id || "") : "");
  if (isIntent && !minted) {
    return { updates: [], then: { type: "mint-deck", uuid: true, with: { request: ask.id, event: { type: "click", from: "btn-create" } } } };
  }
  if (!setId && !isMutation && !isBrowserDraft && !isIntent) return { updates: [] };
  const palette = ["#FED7AA", "#FEF08A", "#BFDBFE", "#A7F3D0", "#FBCFE8"];
  const coverEmoji = "🎨";

  const existingSetCards = allCards.filter((c) => c && c.set_id === setId);
  const currentSession = allSessions.find((s) => s && s.id === "session");
  const currentConfig = allConfigs.find((c) => c && c.id === "config");
  const pressLease = allConfigs.find((c) => c && c.id === "press");
  const isBackgroundSync = ["generated-drafts-sync", "generated-flashcards-sync"].includes(fromId);

  // A hint is deckmeta:… (card 0 only) | run key | orig:… | xlat:…; the run key is what is left.
  const hintRunKeyOf = (h) => String(h || "").split("|").map((p) => p.trim())
    .filter((p) => p && !/^(?:deckmeta|orig|xlat):/.test(p)).join("|");
  const runNumOf = (r) => {
    const m = hintRunKeyOf(r).match(/(?:^|::\s*)run-(\d+)$/);
    return m ? Number(m[1]) : 0;
  };

  const serverEntities = new Set(["generation_draft", "card_set", "flashcard", "deck_translation", "card_translation"]);
  const tabOwnsSet = (targetSetId) => {
    if (!hasPrintConfigRead) return true;
    if (!pressLease || !pressLease.set_id) return !isBackgroundSync && targetSetId === setId;
    return String(pressLease.set_id).split("|").includes(targetSetId);
  };
  const pushServerUpdate = (arr, u, cfgSetId = setId) => {
    if (arr.length > 0 && serverEntities.has(arr[arr.length - 1].entity)) {
      const targetCfgId = isMutation && pressLease ? "press" : "config";
      const targetCfgSetId = targetCfgId === "press" && pressLease?.set_id
        ? pressLease.set_id
        : (isBackgroundSync && currentConfig?.set_id ? currentConfig.set_id : cfgSetId);
      arr.push({
        op: "patch",
        entity: "print_config",
        id: targetCfgId,
        row: { set_id: targetCfgSetId }
      });
    }
    arr.push(u);
  };

  if (isMutation) {
    const xlatTopicMatch = String(cheapDraft?.topic || "").match(/^(.*?)\s*::\s*\[TRANSLATE:([a-z-]+)\]\s*::\s*(.+)$/i);
    if (xlatTopicMatch && cheapDraft?.status === "done") {
      if (cheapDraft.$synced === false || !/^[1-9][0-9]*$/.test(String(cheapDraft.txid || ""))) return { updates: [] };
      const xlatSetId = xlatTopicMatch[1].trim();
      const xlatLang = xlatTopicMatch[2].trim().toLowerCase();
      const xlatCards = allCards.filter((c) => c && c.set_id === xlatSetId);
      if (xlatCards.some((c) => c.$synced === false || !/^[1-9][0-9]*$/.test(String(c.txid || "")))) return { updates: [] };
      const payloadText = xlatTopicMatch[3].trim();
      const input = payloadText.startsWith("{") ? JSON.parse(payloadText) : null;
      const requestedCount = input?.cards?.length || Number(cheapDraft.card_count) || 0;
      if (cheapDraft.status === "done" && (!xlatCards.length || (requestedCount && xlatCards.length < requestedCount))) return { updates: [] };
      const xlatUpdates = [];
      if (cheapDraft.status === "done" && cheapDraft.category && xlatCards.length > 0) {
        const translation = JSON.parse(String(cheapDraft.category));
        const parsedXlat = Array.isArray(translation) ? translation : translation.cards;
        if (!Array.isArray(parsedXlat) || parsedXlat.length !== xlatCards.length) throw new Error("invalid translation card count");
        if (input && (!translation.name || (input.category && !translation.category))) throw new Error("missing translated deck metadata");
        const deckRow = allSets.find((d) => d && d.id === xlatSetId);
        const words = {};
        for (let i = 0; i < xlatCards.length; i++) {
          const item = parsedXlat[i];
          const word = String(
            typeof item === "string"
              ? item
              : (item?.word || item?.front_text || item?.front || item?.name || "")
          ).replace(/[,.;:!?]+$/g, "").trim();
          if (word) words[xlatCards[i].id] = word;
        }
        const id = `${xlatSetId}:${xlatLang}`;
        const deckTranslation = {
          id,
          set_id: xlatSetId,
          lang: xlatLang,
          name: String(translation.name || deckRow?.name || ""),
          category: String(translation.category ?? deckRow?.category ?? "")
        };
        const cachedDeck = canonSort(context.rows?.deck_translation ?? context.reads?.deck_translation ?? []).find((t) => t && t.id === id);
        if (!cachedDeck || Object.keys(deckTranslation).some((k) => cachedDeck[k] !== deckTranslation[k])) {
          pushServerUpdate(xlatUpdates, { op: "put", entity: "deck_translation", id, row: deckTranslation }, xlatSetId);
        }
        const cachedCards = canonSort(context.rows?.card_translation ?? context.reads?.card_translation ?? []);
        for (const [cardId, word] of Object.entries(words)) {
          const cardKey = `${cardId}:${xlatLang}`;
          if (cachedCards.some((t) => t && t.id === cardKey && t.word === word)) continue;
          pushServerUpdate(xlatUpdates, { op: "put", entity: "card_translation", id: cardKey, row: { id: cardKey, card_id: cardId, set_id: xlatSetId, lang: xlatLang, word } }, xlatSetId);
        }
      }
      if (xlatUpdates.length) return settledBehind(xlatUpdates);
      pushServerUpdate(
        xlatUpdates,
        {
          op: "patch",
          entity: "generation_draft",
          id: cheapDraft.id,
          ifTxid: String(cheapDraft.txid),
          row: { status: "idle", category: "", details: "" }
        },
        xlatSetId
      );
      return settledBehind(xlatUpdates);
    }


    return { updates: [] };
  }

  const buildBrowserPlaceholderSvg = () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" data-tier="tier-browser">` +
      `<rect width="256" height="256" fill="#FFFFFF"/>` +
      `<rect x="88" y="80" width="80" height="64" rx="8" fill="none" stroke="#D6D3D1" stroke-width="3"/>` +
      `<circle cx="111" cy="102" r="6" fill="#D6D3D1"/>` +
      `<path d="M89 135l24-22 16 14 13-12 25 22" fill="none" stroke="#D6D3D1" stroke-width="3"/>` +
      `<g fill="#A8A29E"><circle cx="112" cy="170" r="3"/><circle cx="128" cy="170" r="3"/><circle cx="144" cy="170" r="3"/></g></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  };

  if (isBrowserDraft && (draft.status !== "generating" || detail.set_id !== draft.set_id || detail.run !== draft.run || existingSetCards.length === 0 || !tabOwnsSet(setId))) {
    return { updates: [] };
  }

  const memoRow =
    allBrowserDrafts.find(
      (b) =>
        b &&
        String(b.topic || "").trim().toLowerCase() === topic.toLowerCase() &&
        String(b.locale || "").trim() === loc &&
        String(b.status || "").trim() === "generating"
    ) ||
    {};


  if (isBrowserDraft) {
    if (!tabOwnsSet(setId) || existingSetCards.length === 0 || existingSetCards.some((c) => c.emoji && c.emoji !== "⏳")) {
      return { updates: [] };
    }
    const browserUpdates = [];
    const browserWords = [];
    const pendingCardUpdates = [];
    for (let i = 0; i < existingSetCards.length; i++) {
      const ex = existingSetCards[i];
      const wKey = `w${i % 5}`;
      const word = String(detail[wKey] || memoRow[wKey] || ex.front || `${topic} #${i + 1}`).trim() || `${topic} #${i + 1}`;
      browserWords.push(word);
      const color = ex.color || palette[i % palette.length];
      const sketch = buildBrowserPlaceholderSvg();
      if (ex.emoji === "⏳" && (ex.front !== word || ex.back !== sketch || ex.emoji !== "🧭")) {
        pendingCardUpdates.push({
          idx: i,
          update: {
            op: "put",
            entity: "flashcard",
            id: ex.id,
            row: {
              id: ex.id,
              set_id: setId,
              front: word,
              back: sketch,
              hint: ex.hint || "run-1",
              difficulty: ex.difficulty || "easy",
              emoji: "🧭",
              color,
              ...(meId ? { owner: meId } : {})
            }
          }
        });
      }
    }
    if (pendingCardUpdates.length === 0) {
      return { updates: [] };
    }
    const selectedBrowserIdx = (currentSession && currentSession.set_id === setId)
      ? Math.max(0, Math.min(existingSetCards.length - 1, Math.floor(Number(currentSession.card_index)) || 0))
      : 0;
    const selectedBrowserFront = browserWords[selectedBrowserIdx] || browserWords[0] || "";
    const browserSessionSynced = Boolean(
      currentSession &&
      currentSession.set_id === setId &&
      currentSession.front === selectedBrowserFront &&
      currentSession.emoji === "🧭"
    );
    const orderedBrowserCards = pendingCardUpdates.slice().sort(
      (a, b) => (a.idx === selectedBrowserIdx ? -1 : b.idx === selectedBrowserIdx ? 1 : 0)
    );
    let browserSessionPushed = !(selectedBrowserFront && (!currentSession?.set_id || (currentSession.set_id === setId && !browserSessionSynced)));
    const pushBrowserSession = () => {
      if (browserSessionPushed) return;
      browserSessionPushed = true;
      browserUpdates.push({
        op: "patch",
        entity: "play_session",
        id: "session",
        row: {
          set_id: setId,
          card_index: selectedBrowserIdx,
          flipped: "no",
          total: existingSetCards.length,
          finished: "",
          front: selectedBrowserFront,
          card_id: existingSetCards[selectedBrowserIdx].id,
          original_front: selectedBrowserFront,
          back: "",
          hint: topic,
          emoji: "🧭"
        }
      });
    };
    pushBrowserSession();
    browserUpdates.push(formUpdate({ words: "complete" }));
    for (let i = 0; i < orderedBrowserCards.length; i++) {
      pushServerUpdate(browserUpdates, orderedBrowserCards[i].update);
    }
    return { updates: browserUpdates };
  }

  const prevJobs = Number(currentSession?.mastered) || 0;
  const nextJobs = input?.nextJobs ?? Math.min(2, Math.max(1, prevJobs + 1));
  const prevRunNum = Math.max(
    runNumOf(cheapDraft?.region),
    runNumOf(heavyDraft?.region),
    ...allCards.map((c) => runNumOf(c?.hint)),
    prevJobs
  );
  const runKey = claim?.run || `run-${prevRunNum + 1}`;

  if (minted) {
    return {
      updates: [{ op: "put", entity: "generation_ask", id: ask.id, row: {
        id: ask.id, set_id: minted, run: runKey, ...(ask.created_at ? { created_at: ask.created_at } : {}),
        input: JSON.stringify({ draft, device, locale: context.locale ?? "pt", detail, browser_draft: allBrowserDrafts, nextJobs })
      } }],
      then: { type: "mutation", from: "generation-asks", with: { request: ask.id } }
    };
  }

  const customCards = Array.isArray(detail.cards) ? detail.cards : [];
  const customImageUrl = String(detail.imageUrl || "");
  const customHeavyUrls = customImageUrl ? customImageUrl.split("|||").filter(Boolean) : [];
  const hasPrecomputedMemo = Boolean(
    customCards.length === 0 &&
    typeof memoRow.w0 === "string" &&
    memoRow.w0.trim().length > 1 &&
    memoRow.w0.trim().toLowerCase() !== topic.toLowerCase()
  );
  const useInstantBrowserSeed = customCards.length === 0;
  const fallbackBrowserWords = (() => {
    if (!useInstantBrowserSeed || hasPrecomputedMemo) return [];
    const cleanTopic = String(topic || "Instrumentos Musicais").split("::")[0].trim() || "Instrumentos Musicais";
    const lc = String(loc || "pt-BR").toLowerCase();
    const facetsMap = {
      pt: ["Origem", "Tradição", "Símbolo", "Costume", "Patrimônio"],
      es: ["Origen", "Tradición", "Símbolo", "Costumbre", "Patrimonio"],
      en: ["Origin", "Tradition", "Symbol", "Heritage", "Craft"],
      he: ["מקור", "מסורת", "סמל", "מנהג", "מורשת"],
      zh: ["起源", "传统", "象征", "习俗", "文化"],
      hi: ["उत्पत्ति", "परंपरा", "प्रतीक", "रीति-रिवाज", "विरासत"]
    };
    const lang =
      lc.startsWith("es") || lc.includes("españ")
        ? "es"
        : lc.startsWith("en") || lc.includes("engl")
        ? "en"
        : lc.startsWith("he") || lc.includes("עבר")
        ? "he"
        : lc.startsWith("zh") || lc.includes("中文")
        ? "zh"
        : lc.startsWith("hi") || lc.includes("हिन्दी")
        ? "hi"
        : "pt";
    const facets = facetsMap[lang] || facetsMap.pt;
    const headWord = cleanTopic.split(/\s+/)[0] || cleanTopic;
    return facets.map((facet) => `${headWord} · ${facet}`);
  })();

  const cards = [];
  for (let i = 0; i < cardCount; i++) {
    const id = `card-${setId}-${i + 1}`;
    const cItem = customCards[i];
    const color = palette[i % palette.length];
    const memoWord = hasPrecomputedMemo
      ? String(memoRow[`w${i % 5}`] || "").trim()
      : (useInstantBrowserSeed ? String(fallbackBrowserWords[i % 5] || "").trim() : "");
    const front = String(
      cItem?.word ||
      cItem?.front ||
      memoWord ||
      `${topic} #${i + 1}`
    ).trim() || `${topic} #${i + 1}`;
    const emoji = String(cItem?.emoji || (useInstantBrowserSeed ? "🧭" : "⏳"));
    const cardCustomHeavy = customHeavyUrls[i] || customHeavyUrls[0] || "";
    const defaultBrowserSvg = useInstantBrowserSeed ? buildBrowserPlaceholderSvg() : "";
    const back = cardCustomHeavy || String(cItem?.svg || defaultBrowserSvg || "");
    cards.push({
      id,
      front,
      emoji,
      hint: runKey,
      back,
      color
    });
  }

  const cardIdSet = new Set(cards.map((c) => c.id));
  const staleSetCards = existingSetCards.filter(
    (c) => c.id && !cardIdSet.has(c.id) && String(c.hint || "").startsWith("run-")
  );
  const firstCard = cards[0];
  const selectedIdx = 0;
  const selectedCard = firstCard;

  const draftUpdate = formUpdate({
      topic,
      details: String(draft.details ?? ""),
      set_id: setId,
      run: runKey,
      category: rawCat,
      locale: loc,
      region: reg,
      card_count: cards.length,
      words: cards.some((c) => c.emoji === "⏳") ? "running" : "complete",
      next: 2
    });
  const sessionUpdate = {
    op: "patch",
    entity: "play_session",
    id: "session",
    row: {
      set_id: setId,
      card_index: selectedIdx,
      flipped: "no",
      mastered: nextJobs,
      total: cardCount,
      finished: "",
      front: selectedCard.front,
          card_id: selectedCard.id,
          original_front: selectedCard.front || "",
      back: "",
      hint: topic,
      emoji: selectedCard.emoji
    }
  };


  const prevLeasedIds = String(pressLease?.set_id || "").split("|").filter(Boolean);
  const leasedSetIds = prevLeasedIds.length > 0
    ? [setId, ...prevLeasedIds.filter((id) => id !== setId)].join("|")
    : setId;
  const pressLeaseUpdate = {
    op: "put",
    entity: "print_config",
    id: "press",
    row: {
      id: "press",
      set_id: leasedSetIds,
      paper: currentConfig?.paper === "letter" ? "letter" : "a4",
      card_size: ["standard", "mini", "jumbo", "poster"].includes(currentConfig?.card_size) ? currentConfig.card_size : "standard",
      layout: ["fold", "duplex_h", "duplex_v", "2x2", "3x3"].includes(currentConfig?.layout) ? currentConfig.layout : "fold",
      cut_lines: currentConfig?.cut_lines === "no" ? "no" : "yes",
      orientation: currentConfig?.orientation === "landscape" ? "landscape" : "portrait",
      vendor: ["prodigi", "print_shop"].includes(currentConfig?.vendor) ? currentConfig.vendor : "print_at_home",
      stock: currentConfig?.stock === "mohawk" ? "mohawk" : "gloss"
    }
  };
  const updates = [sessionUpdate, pressLeaseUpdate];

  pushServerUpdate(updates, {
    op: "put",
    entity: "card_set",
    id: setId,
    row: {
      id: setId,
      name: topic,
      category: categoryName,
      locale: Object.entries(locByCode).find(([code, entry]) => /^[a-z]{2}-[A-Z]{2}$/.test(code) && entry[0] === loc)?.[0] || loc,
      region: reg,
      count: cards.length,
      cover_emoji: coverEmoji,
      details: String(draft.details ?? ""),
      device: key,
      ...(meId ? { owner: meId } : {}),
      audience_key: String(draft.audience_key ?? "diff_kids"),
      audience: String(draft.audience ?? "")
    }
  });

  for (let i = 0; !claim && i < staleSetCards.length; i++) {
    pushServerUpdate(updates, {
      op: "delete",
      entity: "flashcard",
      id: staleSetCards[i].id
    });
  }

  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    pushServerUpdate(updates, {
      op: "put",
      entity: "flashcard",
      id: c.id,
      row: {
        id: c.id,
        set_id: setId,
        front: c.front,
        back: c.back,
        hint: c.hint,
        difficulty: "easy",
        emoji: c.emoji,
        color: c.color,
        ...(meId ? { owner: meId } : {})
      }
    });
  }

  if (claim) {
    for (const update of updates) {
      if (update.op === "put" && ["card_set", "flashcard"].includes(update.entity)) {
        update.absent = update.row;
        update.row = { id: update.id };
      }
    }
  }
  if (claim) return { updates, then: { type: "complete-create", with: { request: ask.id, form: draftUpdate } } };
  updates.push(draftUpdate);
  return { updates };
}
