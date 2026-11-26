# Snapcards

[[../journal.html|Delivery journal]] records the studio, generation, translation, and print verification. User-created decks and migration backups are operational data, stored outside this repository.

The library's shelf is its address: `/`, `/mine` and `/gallery` are the cards route's `:shelf?` segment, listed on the strip as `nav.entries`, and `data-author-filter` reads `{param.shelf}`; `play_session.library_filter` is retired. Desktop (`>=1100px`) shows the full left sidebar and tablet (`768px..1099px`) an 88px icon+label rail; phones (`<768px`) keep the top bar to the three primary actions (`Home`, `Create`, `Print`) plus the active screen's `#btn-top-login` avatar button in the fourth slot, whose bottom sheet carries `My Cards`, `Gallery`, `About` and account sign-in/sign-out alongside the library's inline shelf tabs. The tab-local `library_query` belongs to the library. Study selection and generation update the card fields (`set_id`, `hint`, `back`, and position) without changing that browsing state; browser Back preserves the address and the query.

Search ads land on `/kids`, `/teachers` and `/printed` (and their `/<locale>/` twins): prerendered like About, off the strip, in the sitemap, styled by `shell/shared/landing.css`. The printed page's countries are `_printCountries` in `program_commerce.cue`; the two must name the same set.

- [[../brief|Product brief]] and [[../acceptance|acceptance]] define the learning and print-order experience.
- [[../commerce/README|Print commerce]] describes the trusted Stripe/Cloudflare adapter, private order/PDF persistence, configuration and recovery.
- [[../../../plugins/omnishell/docs/native-hosts|Omnishell native hosts]] and [[archive/2026-11-18-divkit-native-port|DivKit native port]] cover the Android (`Div2View` + QuickJS) and iOS (`DivView` + `JSContext`) packaging (`./saytw build@android`, `./saytw build@ios`), SQLite offline UGC, Keychain/Keystore refreshable auth + PKCE OIDC + account deletion, Ed25519-verified SWR updates, and the two `div-custom` blocks (`flip_card_3d`, `print_realm`).
- [[../../../plugins/pronto/docs/decisions/2026-10-28-integrations|Integration design]] explains the shared-host direction and Snapcards' explicit interim edge hatch.
- [[../../../plugins/pronto/docs/edge-hatches|Edge hatch routes]] defines the Worker packaging and authority boundary.

## Generation

A deck is created from a title, its name, optional details that refine every card and are
never shown, and an audience: a preset of the age combo box, stored as its message key so
each reader sees it in their language, or the reader's own words. A deck's text is one effect
per level that sees the whole deck: `smollm3-draft` the cheap words, `heavy-draft` the final
ones, for the deck's audience. The text levels write the cards' words and nothing else. Each
runs on a text slot of the device that generates the deck,
a GenerationMachine row, whose transition fans the outcome out
(`services/database/sql/017_card_art_fan_out.sql`): every card of the deck takes the level's
word and one `card_art` row. Each row is CardArtMachine, `waiting → pending → drawn | failed |
unknown`; `pending` invokes `illustrate-card` keyed by the row and its run, so the airlock
retries or refuses one card alone. Level 2 starts at once, a card's level 3 when its own
level 2 settles. `illustrate-card` answers the picture's bytes, which the airlock stores in
the blob plane, and `flashcard.back` holds the URL `/img` serves it at, beside the imported
decks' pictures on the same route: inline data URLs filled the edge's in-memory database
until its object could no longer boot. A card no level drew shows the
no-art frame.

`illustrate-card` draws from the reader's words alone: the card's word and the deck's title,
details and custom audience (and a redraw's description). The prompt is
`Subject: a single <word>. Context: <title>; <details>.`, the audience's style line (a flat
icon for early childhood, a picture-book illustration for children, a photograph for youth and
adults, the reader's own range as `Target age range: …`) and a white-background line. No
description a model wrote reaches the image model: the text levels once wrote one, and the
picture followed it to a coin that never existed. Level 3 draws on Gemini 3.1 Flash Lite Image
from the words as written, since Gemini reads the reader's language; Phoenix drew a paca as an
alpaca and a giant anteater as a mongoose whatever the prompt said. Level 2 draws on Workers
AI's free allocation, whose model reads English alone: the cheap text tier translates the
words, and the subject keeps the reader's word beside its translation (`Cashew apple (Caju)`),
since a translator once turned a paca into an agouti
([[archive/2026-10-31-image-prompt|the trials]]).

`illustrate-card` retries Workers AI's `3040` capacity refusal, a 429, any other 5xx and a call
that never answered, up to the declaration's five attempts with the airlock's backoff. Any other
refusal fails the card with the provider's answer in `detail`, `8007` (NSFW) included. tsbifrost
reports every Workers AI error as a 503, so the code is read from the error's text.

The `deck-level` drain (`018_deck_level.sql`) keeps one `deck_level` row per deck and level
from `card_art` over the cards that still exist: `total`, `drawn`, `failed`, `unknown`,
`pending` and the run they belong to. A level whose rows all settled moves to `complete`,
`partial` or `failed`; once no level runs and level 3 has rows of the run, `create_set` settles
the form `done` (every card drawn at every level), `failed` (none) or `partial`. The job
list on `/generate`, its badge, and the indicator on `/explore` read that row alone; the
`/generate` preview shows the deck the form names.

The form is the browser's own `generation_form` row, durability `device`: never synced, so no other reader sees what was
typed and no other writer moves it. The server's rows are partitioned by device instead.
`create_set` mints a device key once, 64 bits from two of the terminal's draws, into `device`
(durability `device`), with that device's two idle text slots `<key>:draft-cheap` and
`<key>:draft-heavy`. Every Create is a new deck: its id is a UUID from four of the terminal's
draws, its cards `card-<id>-<n>`, and `card_set.device` names the key. A title keys nothing, so
two decks may share one, and `card_art` and `deck_level` need no scoping of their own, since they
are keyed by the deck. `card_set.number` is the next number among its owner's decks, assigned by the database, for
display alone (`023_deck_number.sql`). Translations run on the reader's
device's cheap slot and land in the shared cache below.

The levels start server-side (`019_deck_advance.sql`): a deck's cheap text once its cards all
reached the server, its heavy text once the cheap one settled, each on its device's text slot
when the slot is free, newest deck first. A device whose slots the database lost gets them back
idle before its deck is started, and on a page's wake, since a translation runs on a slot it finds. The drain and either slot's settlement call it, so a deck finishes with
no tab open. A slot's own settlement cannot hand the slot on inside its own trigger; the next
drain call does.

A reader may delete one card of a deck they own with two taps on its rail button (a
`card_delete` chart arms it and reverts it after four seconds; `create_set` applies the confirmed
row); the deck's count and the session's position follow, and the card's settled art rows go
with the next drain call. They may also redraw a card from the edit sheet: CardRedrawMachine
restarts the card's settled level-3 row with their description, which starts empty, and one
more `redraws`, a new key and seed for `illustrate-card`, which draws the word with it; drawn, it replaces the card's art, and either outcome settles the card. Why it is shaped this way: [[archive/2026-10-29-per-card-art|per-card art]].

A release's `verify` runs `tests/verify.ts` beside its screen sweep: it opens a deck from the
library and lands on its first card, as a deck link does, and it generates a deck on the
release's own models, waits for it to settle with a picture the blob plane serves, and deletes
it.

## Ownership, favourites and translations

A deck and its cards carry `owner`, the signed-in reader who generated them (a guest is one: the
edge mints the person), stamped by `auth_uid()`. Anyone reads them; only the owner writes them,
by the policies in `020_owner_writes.sql`, since `#Access` has no "everyone reads, the owner
writes" mode. A curated deck has no owner and takes no reader's write. The browser asks the same
question of `me`, the reader's own row (`021_me_provision.sql`): a probe bound to `me` by a
deck's owner is non-empty exactly when the deck is theirs, which shows the ✏️ and delete
controls, fills My Cards and the `/generate` job list, in any tab and after any reload.
Promoting a guest keeps the person's id, so their decks stay theirs.

A favourite is the reader's own private `favorite` row; un-favouriting sets `deleted_at`. The
count is everyone's, `deck_stats`, kept by the `favorite-recount` pipeline in a container and by
the `deck-favorites` drain (`022_deck_favorites.sql`) on the edge, with the `favorite_count`
pair that lets the browser show the reader's own toggle at once without counting it twice —
realworld's model for an article.

A deck read in another language is translated once, by whichever reader first reads it so: the
title and category land in `deck_translation`, each card's word in `card_translation`, a cache
any reader writes and nobody owns, so no reader writes another's deck. A text level that rewrites
a card's word drops the deck's translations (`017_card_art_fan_out.sql`).
