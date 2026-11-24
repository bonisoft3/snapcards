// The browser twin of deck-cover.blobl throws: in this tier deck_stats is the
// favorite recount's fold accumulator, which a second writer would overwrite.
// The edge keeps the cover in refresh_deck_covers (migrations/20261108_deck_cover.sql).
export default () => {
  throw new Error("deck-cover: the browser tier is unsupported; the cover is the drain's (refresh_deck_covers)");
};
