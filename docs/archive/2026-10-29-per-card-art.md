# Per-card art: one effect per card, a deck that reacts to their outcomes

Status: built 2026-10-29; its contract is [[../index#generation|Generation]]. It
replaced the per-card `nart:` markers in `flashcard.hint` and the deck-wide image
effects.

A deck's text is one effect that sees the whole deck. Its images become one airlock
effect per card per level, each with its own outcome. The deck learns that every card
has settled from a summary the database keeps, and its progress reads that summary.

## Why

`sdcpp-illustrate` makes every card's image call inside one effect. Three defects follow
from that shape, and each was seen on production on 2026-10-29:

- **A retry is deck-wide.** A transient refusal answers `{retry}` and the airlock re-runs
  every card's image, not the one that failed.
- **Outcomes are packed into strings.** Which card has no art, and why, travels as
  `FAILED:` parts of `image_url` and `nart:` parts of a card's hint. The reduce in
  `create_set.js` unpacks them, so every reader of a hint has to know the encoding.
- **The deck's draft rows are shared singletons.** `draft-cheap` and `draft-heavy` hold
  one run at a time, so a lazy translation on `/explore` took over `draft-cheap` in the
  middle of an image run.

## Shape

**Text is one deck-level effect.** It has to see the deck to choose distinct words and
size each subject against the others (`frame_percent`). Its settlement is the
deck machine's transition into illustrating.

**Fan-out is rows.** That transition inserts one `card_art` row per card and level, keyed
`(card_id, level)`, as a relational effect committed with the transition. Each row is a
machine:

```
pending ──invoke illustrate-card──▶ drawn
                                   ▶ failed   (a refusal: the provider's status and detail)
                                   ▶ unknown  (attempts ran out)
```

`illustrate-card` is keyed per row, so the airlock claims one ledger row and one job per
card per level. It retries each one on `{retry}` up to the declaration's `attempts`
(pronto's default, 5) with the platform's backoff. How many run at once is the airlock
worker's concurrency, not the app's. A card's level 3 begins when its own level 2
settles; nothing waits for the slowest card.

**The join is a summary the database keeps.** A `deck_level` row per `(set_id, level)`
holds `total`, `drawn`, `failed`, `unknown` and `pending`. It is maintained from
`card_art` by a [[../../../../plugins/pronto/docs/pipelines-and-schedules#drains|drain]],
idempotent by construction since the read is absolute.

When `pending` reaches 0, the row's state signals the deck machine:
`deck_level.settled` moves the deck to `done` when every card is drawn, and otherwise to
`partial` or `failed`. The same row drives:

- the generation progress on `/generate`;
- a loading indicator on `/explore`, which has none today.

## Alternatives

- **A deck-wide effect with internal retries and a concurrency limit.** Rejected: it
  reinvents backoff, jitter and fan-out that the airlock and its queue already own.
- **A live aggregate over `card_art` with no summary row.** Enough for display, but the
  deck machine must react when every card settles, and a machine moves on a row's state,
  not on a query.
- **Feldera.** Its strength is incremental views over large, continuous changes. This is
  a group-by over about twenty rows per deck. Snapcards ships to the browser tab,
  Cloudflare and Pages, none of which runs a Feldera service, and pronto's DuckStream tier
  is not built. The summary row is the shape a DuckStream pipeline would maintain, so a
  later move changes the maintainer, not the model.

## Settled while building

- **A drain, not a CDC pipeline.** At `cloudflare` and `pages` no stream runs: the
  cluster calls a drain from a trigger on its `on` tables, and a CDC pipeline does not
  run at all. A streamed drain is the one maintainer every target runs; in the
  container it costs the CDC stack (Conduit, Redis, the bus) the cluster did not carry
  before.
- **The fan-out is a SQL hatch.** A relational effect writes one row; the text's
  outcome becomes one row per card through `snapcards_fan_out_art`, which also writes
  the cards' words, so a tab closed mid-generation no longer leaves a deck without them.
- **`unknown` shows as `failed`**: no art, the reason kept in `detail`.
- **Retiring `generation_draft`'s `draft-cheap` and `draft-heavy` rows** is still open:
  each holds one deck's text at a time, and a tab still starts the heavy text.
