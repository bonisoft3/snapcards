({ context, event }, { machine }) => {
  if (event.type !== "click") return { updates: [] };
  const row = context.items?.[0];
  if (!row) return { updates: [] };

  const canonSort = (arr) => (arr ?? []).slice().sort((a, b) => {
    const ida = String(a?.id ?? "");
    const idb = String(b?.id ?? "");
    if (ida !== idb) return ida < idb ? -1 : 1;
    const ja = JSON.stringify(a ?? null);
    const jb = JSON.stringify(b ?? null);
    return ja < jb ? -1 : ja > jb ? 1 : 0;
  });

  const setId = row.set_id || "69618be6-9206-f9c7-59eb-b5e4b072cf3d";
  const routeCards = canonSort((context.rows?.route_cards ?? []).filter((c) => c && c.set_id === setId));
  let deck = routeCards.length
    ? routeCards
    : canonSort((context.rows?.flashcard ?? context.reads?.flashcard ?? []).filter((c) => c && c.set_id === setId));
  const hasExplicitDeck = deck.length > 0;
  const first = deck[0] || { id: "card-default", front: row.front || "Card", emoji: row.emoji || "✨", hint: "", back: "" };
  const total = Math.max(0, Math.min(1000, Math.floor(Number(hasExplicitDeck ? deck.length : (row.total || deck.length || 5))) || 5));

  const base = machine.execute({ initialize: true, payload: {}, context: { tier: "mecha" }, viewers: [] }).state;
  const step = machine.execute({
    state: base,
    event: { kind: "restart_session", payload: { total, card_index: 0 } },
    context: { tier: "mecha" },
    viewers: []
  });

  const localized = (context.rows?.localized_card ?? context.reads?.localized_card ?? []).find((c) => c.id === first.id);

  return {
    updates: [{
      op: "patch",
      id: row.id,
      row: {
        card_index: step.state.card_index,
        flipped: step.state.flipped,
        mastered: step.state.mastered,
        card_id: first.id,
        original_front: localized?.original_front || first.front,
        front: localized?.front || first.front,
        back: String(first.back || "").startsWith("data:") ? "" : first.back,
        hint: row.hint || first.hint || "",
        emoji: first.emoji
      }
    }, { op: "put", entity: "next_picture", id: "next", row: { id: "next", back: String(deck[0 + 1]?.back || "").startsWith("data:") ? "" : String(deck[0 + 1]?.back || "") } }]
  };
}
