// delivery_submitted — the free text, as the question the reader submits.
// Nominatim's policy forbids asking while they type, so the search question
// is this copy, taken only on Enter or the search button. With the reader's
// position on, the question carries it after a tab, and shell/units/geocoder
// ranks the places near it first.
({ context }) => {
  const draft = context.items[0];
  return draft.near === "" ? draft.text : `${draft.text}\t${draft.near}`;
};
