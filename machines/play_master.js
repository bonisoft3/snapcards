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
  let deck = canonSort((context.rows?.route_cards ?? []).filter((c) => c && (!c.set_id || c.set_id === setId)));
  if (!deck.length) {
    deck = canonSort((context.rows?.flashcard ?? context.reads?.flashcard ?? []).filter((c) => c && c.set_id === setId));
  }
  const hasExplicitDeck = deck.length > 0;

  const currentIdx = Math.max(0, Math.min(1000, Math.floor(Number(row.card_index ?? 0)) || 0));
  const currentMastered = Math.max(0, Math.min(1000, Math.floor(Number(row.mastered ?? 0)) || 0));
  const total = Math.max(0, Math.min(1000, Math.floor(Number(hasExplicitDeck ? deck.length : (row.total || deck.length || 5))) || 5));

  const base = machine.execute({ initialize: true, payload: {}, context: { tier: "mecha" }, viewers: [] }).state;
  const step = machine.execute({
    state: { ...base, card_index: currentIdx, mastered: currentMastered, total },
    event: { kind: "master_card", payload: { card_index: currentIdx, mastered: currentMastered, total } },
    context: { tier: "mecha" },
    viewers: []
  });

  const card = deck[step.state.card_index] || deck[currentIdx] || deck[0] || { id: "card-default", front: row.front || "Card", emoji: row.emoji || "✨", hint: "", back: "" };

  const localized = (context.rows?.localized_card ?? context.reads?.localized_card ?? []).find((c) => c.id === card.id);

  return {
    updates: [{
      op: "patch",
      id: row.id,
      row: {
        card_index: step.state.card_index,
        mastered: step.state.mastered,
        flipped: step.state.flipped,
        finished: step.state.status === "completed" ? "yes" : "",
        card_id: card.id,
        original_front: localized?.original_front || card.front,
        front: localized?.front || card.front,
        back: String(card.back || "").startsWith("data:") ? "" : card.back,
        hint: row.hint || card.hint || "",
        emoji: card.emoji
      }
    }, { op: "put", entity: "next_picture", id: "next", row: { id: "next", back: String(deck[step.state.card_index + 1]?.back || "").startsWith("data:") ? "" : String(deck[step.state.card_index + 1]?.back || "") } }]
  };
}
