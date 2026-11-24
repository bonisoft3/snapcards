// count-step — the card count the stepper's arrow or the typed number asks
// for, held to the deck sizes the form makes (create_set.js floors at 1 and
// caps at 20). An arrow steps the row's count by its delta; a typed value
// stands on its own, and one that is no number keeps the count.
({ context, event }, params) => {
  const held = Number(context.items[0]?.card_count ?? 5);
  const typed = String(event.value ?? "").trim();
  const asked = params.delta === 0 ? (typed === "" ? NaN : Number(typed)) : held + params.delta;
  return Number.isFinite(asked) ? Math.min(20, Math.max(1, Math.round(asked))) : held;
};
