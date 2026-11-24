# Snapcards

A flashcard and cultural publishing press for children learning new words.
Pick a topic, get illustrated cards with cultural context, review and play
in the browser, or layout cards for physical printing.

## Data

Card sets, illustrated cards, review sessions, print layouts and creation drafts
form the browser learning experience. Live print orders, verified payment events
and frozen artwork and PDFs are private records in the Cloudflare cluster database. Pages
keeps its simulated order experience local.

## Screens

- **Cards** — browse cultural card sets, filter by category and locale, search,
  see card counts, toggle favorites, and start a play or print session.
- **Generate** — create a new card set by topic, category, locale, and region,
  dealing illustrated cards with cultural context.
- **Play** — interactive flashcard reader. Flip cards to reveal word definitions,
  pronunciation hints, track mastered count, and celebrate completion.
- **Print Studio** — the printing press. Layout cards on A4 or Letter sheets
  in 2x2 or 3x3 grids with cutting guides for physical card printing.

## Behavior

Learning and print layout run in the reader's browser. Handler functions run in a
safe compartment and live queries keep learning views synchronized. Artwork capture
and checkout use an explicitly declared browser hatch; the live payment adapter
is a trusted edge hatch.

Print Studio has three vendors. Print at home is free: every layout option and the
reader's own printer. Print shop is free too: a downloaded A6 PDF, one face per page,
and the text to hand a print shop. Prodigi prints and posts one 6×4 in postcard per card, through
Stripe Checkout. The server quotes the delivery address, adds a configured margin and
freezes that price with the card artwork. A verified payment places one Prodigi
order and mails its record to `davi@davi.eng.br`. A payment redirect alone never
grants fulfillment; duplicate callbacks never place another order. A vendor failure
leaves the order paid, alerts the operator by mail and tells the reader not to pay
again.

Pages explicitly simulates checkout approval and decline, with no charge or email.
Cloudflare uses the live adapter and refuses missing provider configuration; test
Stripe keys remain visibly test-mode in Checkout. Live sales need configured pricing,
shipping destinations, Stripe secrets and a verified Cloudflare email sender/recipient.

The integration boundary and operator setup start at [[docs/index|the app docs]].

![[acceptance]]

## Out of scope

Subscriptions, marketplace payouts, automatic print-provider ordering and shipment tracking.
