({ context, event }, { machine }) => {
  // A translation is asked for behind the screen, from its own seat: the write has to reach the
  // server, and in a step it hid the screen until it had, while a seat is held through its waits,
  // so on the card's own seat it kept the card from following a click until the server answered.
  if (event.type === "ask-translation") return { updates: [event.with.update] };
  const isMutation = event.type === "mutation";
  if (event.type !== "click" && event.command === undefined && !isMutation) return { updates: [] };

  const UI_LANGS = {
    pt: "pt", "pt-br": "pt", "pt_br": "pt", "pt-pt": "pt", portuguese: "pt", "português": "pt", portugues: "pt", brasil: "pt", brazil: "pt",
    es: "es", "es-es": "es", "es-la": "es", "es-mx": "es", "es-ar": "es", spanish: "es", "español": "es", espanol: "es",
    en: "en", "en-us": "en", "en_us": "en", "en-gb": "en", english: "en", "inglês": "en", ingles: "en", us: "en", usa: "en",
    he: "he", "he-il": "he", "he_il": "he", iw: "he", hebrew: "he", "עברית": "he", israel: "he",
    zh: "zh", "zh-cn": "zh", "zh_cn": "zh", "zh-tw": "zh", chinese: "zh", "中文": "zh", china: "zh",
    hi: "hi", "hi-in": "hi", "hi_in": "hi", hindi: "hi", "हिन्दी": "hi", "हिंदी": "hi", india: "hi"
  };
  const normalizeUiLang = (loc) => {
    if (!loc) return null;
    const raw = String(loc).trim().toLowerCase();
    if (UI_LANGS[raw]) return UI_LANGS[raw];
    const prefix = raw.split(/[-_\s,]/)[0];
    return UI_LANGS[prefix] || null;
  };
  const extractSessionLang = (s, loc) => {
    const fromLoc = normalizeUiLang(loc);
    if (fromLoc) return fromLoc;
    const m = String(s?.hint || "").match(/#lang=(pt|es|en|he|zh|hi)\b/);
    return m ? m[1] : "pt";
  };
  const stripLangTag = (h) => String(h || "").replace(/#lang=(pt|es|en|he|zh|hi)\b/g, "");
  const withLangTag = (h, lang) => {
    const baseHint = stripLangTag(h);
    return lang && lang !== "pt" ? `${baseHint}#lang=${lang}` : baseHint;
  };

  // A deck's words in one more language: a cache any reader fills, whoever reads it first.
  const cardTranslations = context.rows?.card_translation ?? context.reads?.card_translation ?? [];
  const translationOf = (deckId, lang) => {
    const row = (context.rows?.deck_translation ?? context.reads?.deck_translation ?? []).find((t) => t && t.set_id === deckId && t.lang === lang);
    return row ? { ...row, words: Object.fromEntries(cardTranslations.filter((t) => t && t.set_id === deckId && t.lang === lang).map((t) => [t.card_id, t.word])) } : null;
  };
  const wordsIn = (c) => cardTranslations.filter((t) => t && t.card_id === c.id).map((t) => t.word);

  const buildLazyTranslationUpdates = (deck, deckMeta, targetLang, cheapDraft, setsToCheck, retryFailed = false) => {
    const sourceLang = normalizeUiLang(deckMeta?.locale);
    const translatedMap = Object.create(null);
    if (!targetLang) return { translatedMap, bgDraftUpdate: null };
    const original = { name: deckMeta.name || "", category: deckMeta.category || "" };
    // A deck's declared language can differ from what its words are in, so even that language
    // is asked for once.
    const cached = translationOf(deckMeta.id, targetLang);
    let needsBgAi = !cached;
    const origWords = [];
    for (const c of deck) {
      const origWord = String(c.front || "");
      origWords.push(origWord);
      const translated = cached?.words[c.id] || (sourceLang === targetLang ? origWord : null);
      if (!translated) needsBgAi = true;
      const nextFront = translated || origWord;
      translatedMap[c.id] = nextFront;
    }
    let bgDraftUpdate = null;
    const xlatTopic = `${deckMeta.id} :: [TRANSLATE:${targetLang}] :: ${JSON.stringify({ ...original, cards: origWords })}`;
    if (needsBgAi && deckMeta?.id && deck.length && cheapDraft &&
        cheapDraft.$synced !== false && /^[1-9][0-9]*$/.test(String(cheapDraft.txid || "")) &&
        (cheapDraft.status === "idle" ||
          (cheapDraft.status === "failed" && (retryFailed || cheapDraft.topic !== xlatTopic)) ||
          (cheapDraft.status === "done" && !String(cheapDraft.topic || "").includes(" :: [TRANSLATE:")))) {
      bgDraftUpdate = {
        op: "patch", entity: "generation_draft", id: cheapDraft.id, ifTxid: String(cheapDraft.txid),
        row: { status: "drafting", topic: xlatTopic, set_id: "", details: deckMeta.id, category: "", locale: targetLang, region: `xlat-${targetLang} :: tx-${cheapDraft.txid}`, card_count: deck.length }
      };
    }
    return { translatedMap, bgDraftUpdate };
  };

  const canonSort = (arr) => (arr ?? []).slice().sort((a, b) => {
    const ida = String(a?.id ?? "");
    const idb = String(b?.id ?? "");
    if (ida !== idb) return ida < idb ? -1 : 1;
    const ja = JSON.stringify(a ?? null);
    const jb = JSON.stringify(b ?? null);
    return ja < jb ? -1 : ja > jb ? 1 : 0;
  });

  const allCards = canonSort(context.rows?.flashcard ?? context.reads?.flashcard ?? []);
  const allSets = canonSort(context.rows?.card_set ?? context.reads?.card_set ?? []);
  const allSessions = canonSort(context.rows?.play_session ?? context.reads?.play_session ?? []);
  // A translation runs on this device's cheap slot, which create_set mints with the device's key.
  const deviceKey = String(canonSort(context.rows?.device ?? context.reads?.device ?? []).find((d) => d && d.id === "device")?.key ?? "");
  const cheapDraft = (deviceKey && (context.rows?.draft_cheap ?? []).find((d) => d && d.id === `${deviceKey}:draft-cheap`)) || null;
  const currentSession =
    allSessions.find((s) => s && s.id === "session") ||
    (context.items?.[0]?.id === "session" ? context.items[0] : null);

  const toSlug = (s) => (s || "").toLowerCase().trim().replace(/[\s_]+/g, "-").replace(/[^a-z0-9\u00c0-\u024f\u0590-\u05ff\u0900-\u097f\u4e00-\u9fff-]/g, "");
  const sameSlug = (a, b) => {
    const sa = toSlug(a);
    const sb = toSlug(b);
    return sa.length > 0 && sa === sb;
  };
  const cardMatchesSlug = (c, target) => {
    if (!c || !target) return false;
    return (c.front || "").toLowerCase() === String(target).toLowerCase() || sameSlug(c.front, target);
  };

  const langClickMap = {
    "lang-pt": "pt",
    "lang-es": "es",
    "lang-en": "en",
    "lang-he": "he",
    "lang-zh": "zh",
    "lang-hi": "hi"
  };
  const clickedLang = event.lang ? normalizeUiLang(event.lang) : (event.from ? langClickMap[event.from] : null);
  if (clickedLang) return { updates: [] };

  const base = machine.execute({ initialize: true, payload: {}, context: { tier: "mecha" }, viewers: [] }).state;

  if (isMutation) {
    const isDeckEntry = event.from === "deck-entry";
    if (isDeckEntry && context.ssr) return { updates: [] };
    const session = context.items?.[0]?.id === "session" ? context.items[0] : currentSession;
    if (!session) return { updates: [] };

    const routeDeckRows = canonSort(context.rows?.route_deck ?? []);
    const routeCardsRows = canonSort(context.rows?.route_cards ?? []);
    if (isDeckEntry && routeCardsRows.length === 0) return { updates: [] };
    const routeWord = context.params?.card;
    const matchingCards = routeCardsRows.filter(c => c.set_id === context.params?.deck);
    const requestedCard = matchingCards.find(c => c.front === routeWord) || matchingCards.find(c => wordsIn(c).includes(routeWord));
    const isCardRoute = routeWord !== undefined;

    if (isCardRoute && !requestedCard) {
      return { updates: [] };
    }

    const hasRouteParamReads = Boolean(
      context.rows && ("route_deck" in context.rows || "route_cards" in context.rows || isCardRoute)
    );
    const targetDeckId =
      routeDeckRows[0]?.id ||
      routeCardsRows[0]?.set_id ||
      requestedCard?.set_id ||
      (!hasRouteParamReads ? session.set_id : "");
    if (!targetDeckId) return { updates: [] };

    let deck = routeCardsRows.length
      ? routeCardsRows
      : allCards.filter((c) => c && c.set_id === targetDeckId);
    if (!deck.length) return { updates: [] };
    deck = canonSort(deck);

    const deckMeta = routeDeckRows[0] || allSets.find((s) => s && s.id === targetDeckId);
    const totalCount = Math.max(0, Math.min(1000, Math.floor(Number(deckMeta?.count || deck.length)) || 5));

    const uiLang = context.ssr ? null : extractSessionLang(session, context.locale || context.ui?.locale);
    const failureKey = `${targetDeckId}|${uiLang}`;
    const failedCurrent = cheapDraft?.status === "failed" && String(cheapDraft.topic || "").startsWith(`${targetDeckId} :: [TRANSLATE:${uiLang}] ::`);
    let failedTopic = session.set_id === targetDeckId ? (session.translation_failed_topic || "") : "";
    const cachedUi = uiLang && translationOf(targetDeckId, uiLang);
    const cacheReady = cachedUi && deck.every((c) => cachedUi.words[c.id]);
    if ((event.visit === true && !context.ssr) || cacheReady) failedTopic = "";
    else if (uiLang && failedCurrent) failedTopic = failureKey;
    const translation = (deckMeta?.locale && uiLang)
      ? buildLazyTranslationUpdates(deck, deckMeta, uiLang, cheapDraft, allSets, event.visit === true)
      : { translatedMap: {}, bgDraftUpdate: null };
    const translatedMap = translation.translatedMap;
    const bgDraftUpdate = failedTopic === failureKey ? null : translation.bgDraftUpdate;
    if (String(event.from ?? "").startsWith("translation-asks")) {
      return { updates: [], ...(bgDraftUpdate ? { then: { type: "ask-translation", delay: 1, with: { update: bgDraftUpdate } } } : {}) };
    }

    let targetIdx = 0;
    const reqSlugSource = requestedCard
      ? requestedCard.front
      : "";
    const routeKey = withLangTag(
      requestedCard ? `${targetDeckId}:${toSlug(reqSlugSource)}` : targetDeckId,
      uiLang
    );
    const sameDeck = session.set_id === targetDeckId;
    const selectedIndex = Math.max(0, Math.min(deck.length - 1, Math.floor(Number(session.card_index)) || 0));
    const routeAlreadySelected = !isDeckEntry && sameDeck && (!requestedCard || session.hint === routeKey || deck[selectedIndex]?.id === requestedCard.id);
    if (routeAlreadySelected) {
      // Translated labels can arrive separately from the session; position is stable.
      targetIdx = Math.max(0, Math.min(deck.length - 1, Math.floor(Number(session.card_index)) || 0));
    } else if (requestedCard) {
      const idx = deck.findIndex((c) => c.id === requestedCard.id);
      if (idx >= 0) targetIdx = idx;
    }

    const activeCard = deck[targetIdx] || deck[0];
    const activeFront = translatedMap[activeCard.id] ?? activeCard.front;
    const isSameCard =
      session.set_id === targetDeckId &&
      (session.front || "").toLowerCase() === (activeFront || "").toLowerCase() &&
      session.card_index === targetIdx && session.card_id === activeCard.id &&
      session.original_front === activeCard.front &&
      (session.translation_failed_topic || "") === failedTopic;
    if (!isDeckEntry && isSameCard && session.total === totalCount && session.hint === routeKey) {
      return { updates: [] };
    }

    const step = machine.execute({
      state: base,
      event: { kind: "select_deck", payload: { total: totalCount, card_index: Math.max(0, Math.min(1000, targetIdx)) } },
      context: { tier: "mecha" },
      viewers: []
    });

    const mutOut = [
      {
        op: "patch",
        entity: "play_session",
        id: "session",
        row: {
          set_id: targetDeckId,
          card_index: step.state.card_index,
          card_id: activeCard.id,
          original_front: activeCard.front,
          translation_failed_topic: failedTopic,
          flipped: routeAlreadySelected ? (session.flipped || "no") : step.state.flipped,
          mastered: routeAlreadySelected ? (session.mastered || 0) : step.state.mastered,
          total: step.state.total,
          finished: routeAlreadySelected ? session.finished : "",
          front: activeFront,
          back: "",
          hint: routeKey,
          emoji: (session.emoji === "🔑" || session.emoji === "🌐" || session.emoji === "🍎" || session.emoji === "👤") ? session.emoji : activeCard.emoji
        }
      },
      {
        op: "patch",
        entity: "print_config",
        id: "config",
        row: { set_id: targetDeckId }
      }
    ];
    if (routeAlreadySelected || isDeckEntry) {
      const sessionUpdate = mutOut.find((u) => u.entity === "play_session");
      for (const key of Object.keys(sessionUpdate.row)) {
        if (sessionUpdate.row[key] === session[key]) delete sessionUpdate.row[key];
      }
      if (Object.keys(sessionUpdate.row).length === 0) mutOut.splice(mutOut.indexOf(sessionUpdate), 1);
    }
    if (!routeAlreadySelected) mutOut.push({ op: "put", entity: "next_picture", id: "next", row: { id: "next", back: String(deck[targetIdx + 1]?.back || "").startsWith("data:") ? "" : String(deck[targetIdx + 1]?.back || "") } });
    return {
      updates: mutOut,
      ...(isDeckEntry ? { then: { type: "intent:navigate", with: { route: "card", params: { deck: targetDeckId, card: activeCard.front }, replace: true } } } : {})
    };
  }

  const fromMap = {
    "btn-hero-play": "69618be6-9206-f9c7-59eb-b5e4b072cf3d"
  };
  const rawId =
    event.id ??
    event.target?.dataset?.id ??
    event.target?.closest?.("[data-id]")?.dataset?.id ??
    (event.from ? fromMap[event.from] : undefined);
  if (!rawId) return { updates: [] };

  const directCard =
    allCards.find((c) => c.id === rawId) ??
    context.items?.find((c) => c.id === rawId && c.set_id);
  const setId = directCard ? directCard.set_id : rawId;
  const item =
    context.items?.find((i) => i.id === setId && !i.set_id) ??
    allSets.find((i) => i.id === setId);

  let deck = allCards.filter((c) => c && c.set_id === setId);
  if (!deck.length && context.items?.[0]?.set_id === setId) {
    deck = context.items;
  }
  deck = canonSort(deck);
  const hasCardsForDeck = deck.length > 0;
  const count = Math.max(0, Math.min(1000, Math.floor(Number(item?.count ? item.count : (deck.length || 5))) || 5));

  const clickUiLang = context.ssr ? null : extractSessionLang(currentSession, context.locale || context.ui?.locale);
  const { translatedMap: clickTranslatedMap, bgDraftUpdate: clickBgDraft } = (item?.locale && clickUiLang && deck.length)
    ? buildLazyTranslationUpdates(deck, item, clickUiLang, cheapDraft, allSets)
    : { translatedMap: {}, bgDraftUpdate: null };

  const cardName = event.name ?? event.target?.dataset?.name ?? event.target?.closest?.("[data-name]")?.dataset?.name;
  const cardId = directCard ? directCard.id : (event.card ?? event.target?.dataset?.card ?? event.target?.closest?.("[data-card]")?.dataset?.card);

  let targetIdx = 0;
  if (cardId) {
    const foundIdx = deck.findIndex((c) => c.id === cardId || cardMatchesSlug(c, cardId));
    if (foundIdx >= 0) targetIdx = foundIdx;
  } else if (cardName) {
    const foundIdx = deck.findIndex((c) => cardMatchesSlug(c, cardName));
    if (foundIdx >= 0) targetIdx = foundIdx;
  }
  const activeCard = deck[targetIdx] || deck[0] || { id: "card-default", front: cardName || "", emoji: item?.cover_emoji || "✨", hint: "", back: "" };
  const activeCardOrig = activeCard.front;
  const isSameDeck = Boolean(currentSession && currentSession.set_id === setId);
  const preserveTopicHint = isSameDeck && currentSession.hint && currentSession.hint !== setId && !String(currentSession.hint).includes(":");
  const clickHint = preserveTopicHint
    ? currentSession.hint
    : ((cardId || cardName) ? `${setId}:${toSlug(activeCardOrig)}` : (activeCard.hint && !String(activeCard.hint).startsWith("run-") && !String(activeCard.hint).startsWith("orig:") ? activeCard.hint : ""));

  const step = machine.execute({
    state: base,
    event: { kind: "select_deck", payload: { total: count, card_index: Math.max(0, Math.min(1000, Math.floor(Number(targetIdx)) || 0)) } },
    context: { tier: "mecha" },
    viewers: []
  });

  const sessionRow = {
    set_id: setId,
    card_index: step.state.card_index,
    flipped: step.state.flipped,
    mastered: isSameDeck ? (Number(currentSession.mastered) || 0) : step.state.mastered,
    total: step.state.total,
    finished: ""
  };
  if (hasCardsForDeck || cardName) {
    sessionRow.card_id = activeCard.id;
    sessionRow.original_front = activeCardOrig;
    sessionRow.front = clickTranslatedMap[activeCard.id] ?? activeCard.front;
    sessionRow.back = "";
    sessionRow.hint = clickHint;
    sessionRow.emoji = activeCard.emoji;
  } else {
    sessionRow.back = "";
  }

  const clickOut = [
    {
      op: "patch",
      entity: "play_session",
      id: "session",
      row: sessionRow
    }
  ];
  if (hasCardsForDeck) clickOut.push({ op: "put", entity: "next_picture", id: "next", row: { id: "next", back: String(deck[targetIdx + 1]?.back || "").startsWith("data:") ? "" : String(deck[targetIdx + 1]?.back || "") } });
  return { updates: clickOut, ...(clickBgDraft ? { then: { type: "ask-translation", delay: 1, with: { update: clickBgDraft } } } : {}) };
}
