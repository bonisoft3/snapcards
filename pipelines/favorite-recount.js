// favorite-recount in the browser: the count favorite-recount.blobl keeps, as a
// fold the reader resumes. The accumulator is the deck_stats row, so the sink
// reads back as a partial fold. counted_txid is the read watermark and covers
// retracted rows too: otherwise a just-retracted row sits above it and reads as
// a change the sink has not seen.

// counted_txid is an int64 carrier, a canonical decimal string compared as an
// integer; the winner is re-spelled through BigInt, since String(1e21) is
// "1e+21" and "007" stays "007".
const later = (a, b) => String(BigInt(a ?? "0") >= BigInt(b ?? "0") ? BigInt(a ?? "0") : BigInt(b));

export const empty = (deck_id) => harden({ deck_id, favorite_count: 0, counted_txid: "0" });

export const step = (acc, row) =>
  harden({
    ...acc,
    favorite_count: acc.favorite_count + (row.deleted_at == null ? 1 : 0),
    counted_txid: later(acc.counted_txid, row.txid),
  });

export const combine = (a, b) =>
  harden({
    ...a,
    favorite_count: a.favorite_count + b.favorite_count,
    counted_txid: later(a.counted_txid, b.counted_txid),
  });

export const result = (acc) => acc;
