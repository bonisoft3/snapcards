({ context, event }) => {
  if (event && event.type !== "mutation") return { updates: [] };
  const locale = String(context.locale || "").toLowerCase().replace(/_/g, "-").split("-")[0];
  if (!locale) throw new Error("localize_content requires a locale");
  const rows = context.rows;
  // Cards are as many as the app has, so a screen hands over only the cards it shows, and one
  // that shows none declares no labels for them.
  const hasCards = rows?.localized_card !== undefined;
  for (const table of ["card_set", "deck_translation", "localized_deck", ...(hasCards ? ["flashcard", "card_translation", "localized_card"] : [])]) {
    if (!Array.isArray(rows?.[table])) throw new Error(`localize_content requires ${table}`);
  }
  // The deck in the reader's language, a cache whichever reader first read it filled.
  const translations = new Map(rows.deck_translation.filter(t => t.lang === locale).map(t => [t.set_id, t]));
  const words = new Map((rows.card_translation ?? []).filter(t => t.lang === locale).map(t => [t.card_id, t.word]));
  const cards = (rows.flashcard ?? []).slice().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const localizedCards = cards.map(card => ({
    id: card.id, set_id: card.set_id, front: words.get(card.id) ?? card.front, original_front: card.front, emoji: card.emoji
  }));
  const localizedDecks = rows.card_set.map(deck => {
    const translated = translations.get(deck.id);
    return {
      id: deck.id, name: translated?.name ?? deck.name, original_name: deck.name,
      category: translated ? translated.category : deck.category, cover_emoji: deck.cover_emoji,
      count: deck.count, locale: deck.locale, region: deck.region, owner: deck.owner ?? "", number: deck.number ?? 0
    };
  });
  const updates = [];
  // A deck that lives on and was not handed over is another screen's: a held screen comes back
  // to its labels.
  const handed = new Set(cards.map(card => card.set_id));
  const living = new Set(rows.card_set.map(deck => deck.id));
  const held = { localized_card: (rows.localized_card ?? []).filter(row => handed.has(row.set_id) || !living.has(row.set_id)), localized_deck: rows.localized_deck };
  for (const [entity, desired] of [["localized_card", localizedCards], ["localized_deck", localizedDecks]]) {
    const existing = new Map(held[entity].map(row => [row.id, row]));
    for (const value of desired) {
      const current = existing.get(value.id);
      existing.delete(value.id);
      if (current && Object.keys(value).every(key => current[key] === value[key])) continue;
      const { id, ...row } = value;
      updates.push({ op: "put", entity, id, row });
    }
    for (const id of existing.keys()) updates.push({ op: "delete", entity, id });
  }
  return { updates };
}
