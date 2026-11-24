// The browser twin of favorite-count.blobl throws: the shim contract is rows →
// one row upserted on `id`, and this pipeline emits a row per (reader, deck)
// pair, which that contract cannot state. The edge keeps the pair in
// refresh_deck_favorites (022_deck_favorites.sql).
export default () => {
  throw new Error("favorite-count: the browser tier is unsupported; the pair is the drain's (refresh_deck_favorites)");
};
