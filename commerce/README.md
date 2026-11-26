# Snapcards print commerce

Print Studio has three vendors. **Print at home** is free: every option, the reader's
own printer, no order. **Print shop** is free and writes nothing: one print dialog over
one A6 face per page, front then back, in deck order, 111×154 mm standing or 154×111 mm
lying as the reader's orientation says, with 3 mm
bleed and no marks, which the reader saves as a PDF and takes to a shop with short text
saying what to ask for. Art and word stay 5 mm inside the trim on white. One image that
fails fails the deck, with no dialog. In Brazil (`BR`), **Cloudprinter** prints and posts a
domestic A6 landscape Wire-O spiral flip-deck (`textbook_co_a6_l_fc`, shipped via
`Correios - SEDEX`); everywhere else (`AR`, `IL`, `US`, `GB`, `CN`, `IN`), **Prodigi** prints and
posts one 6×4 in postcard per card.

There is no server hatch ([[../../../plugins/pronto/docs/decisions/2026-11-05-commerce-through-the-airlock|the decision]]).
This directory holds what the compose stack plays the providers with, and the catalogue.

## The order

`print_order` is a row its owner, a guest included, writes a little of, and a machine
(`program_commerce.cue`) moves:

| State | What happens |
| --- | --- |
| `draft` → `quoting` / `quoting_br` | `print-quote` asks Prodigi (`country <> 'BR'`), or `print-quote-br` asks Cloudprinter (`country = 'BR'`, using `postal_code`) for its USD cost |
| `converting` → `quoted` | `print-fx` asks Stripe for an FX quote; `quoted` holds the item, shipping and total in the country's currency |
| `quoted` → `opening` | The browser has uploaded each card's file and sets delivery and artwork, frozen from here (`BR` also checks matching CEP and valid mod-11 CPF). `print-session` makes the Checkout session and stores the print PDF (plus 2-page cover PDF on `BR`) |
| `awaiting_payment` | Waits. A Stripe webhook, the reader's refresh, or every 10 minutes for 27 hours from the order (`_recheckMs` says why) moves it to `checking` |
| `checking` | `print-check` reads the session. Paid and matching moves to `placing_br` (`BR`) or `placing` (elsewhere); a session that ended unpaid is `unpaid`; anything else, a Pix still with the bank (`processing`) included, comes back with `payment_state` |
| `unpaid` | The session expired, or its Pix lapsed (`payment_state` says which): nothing more can pay it |
| `placing` / `placing_br` | `print-place` (Prodigi `idempotencyKey`) or `print-place-br` (Cloudprinter `reference: id`, reconciling `409 order_reference_not_unique` via `/orders/info`) |
| `recording` → `placed` / `placed_br` | The operator's record is mailed. A Prodigi callback moves `placed` to `vendor_checking`; a CloudSignal webhook moves `placed_br` to `vendor_checking_br` |
| `alerting` → `attention` | The printer refused, or an order has a blocking issue: the operator is alerted, the buyer told not to pay again |

Column grants (`schema.sql`, `20261118_br_spiral_flip_deck.sql`) leave a browser the title, stock,
cards, country, `postal_code`, delivery, artwork, `status` and `checks`, and nothing else, so it
cannot set a price, a currency, a print file or a rate or say it paid, and the machine's guard holds
every move of `status` while `print_order_frozen` freezes `postal_code` past `draft`.

Production ran `20261106_print_order`..`20261107_print_order_file`, whose applied JSON is kept in
`migrations/`, followed by the additive SQL migrations in `program_commerce.cue` through
`20261118_br_spiral_flip_deck`.

A webhook is believed for nothing, so neither provider's is signed-checked: it only makes
the order ask. A forgery costs one read and one ledger row.

## Price

Each country pays in its own currency (`_printCurrencies`): BR in BRL, AR in ARS, IL in ILS, US in
USD, GB in GBP, CN in CNY, IN in INR. `print-quote-br` (`BR`, Cloudprinter `Correios - SEDEX` by CEP) and
`print-quote` (elsewhere, Prodigi's cheapest method, one line per card) both quote in USD alone; an
answer in another is refused.

The Stripe account settles in BRL, so `print-fx` prices every order as BRL received. It asks
Stripe for an FX quote (`POST /v1/fx_quotes`, API version `2025-04-30.preview`, `to_currency=brl`,
from USD and the order's currency, `lock_duration=none`, since Checkout refuses a lock and Stripe
forbids locking ARS), and then:

- `brl = ⌈((cost_usd - shipping_usd) × (1 + markup) + shipping_usd) × usd.reference_rate⌉`, in
  centavos at the 80% `program_commerce.cue` names on Prodigi's non-shipping cost alone;
- a BRL order is charged `brl`;
- any other is charged `⌈brl ÷ rate.exchange_rate⌉` in its own minor units, where the exchange
  rate is what Stripe pays out per unit after its 2% FX fee, so the fee is in the price and every
  order receives at least the same BRL.

Shipping is Prodigi's shipping at the same rate without markup, so courier fees are passed through
at cost and the item line carries the cards and their margin alone. Every step is exact arithmetic
on the rates as Stripe wrote them, rounded up once.
The order keeps the quote's id, its rates and the BRL target (`fx_quote`, `fx_rates`, `fx_brl`).
For 7 gloss cards to São Paulo (`01305-100`), at the simulator's rates: Cloudprinter's $10.14 ($8.03
SEDEX + $2.11 flip-deck) is R$63.89; for 3 gloss cards to the US, Prodigi's $6.92 ($5.30 shipping)
is charged in USD so Stripe pays out the same 80% item margin plus pass-through shipping.

Checkout Sessions refuse an `fx_quote`, alone or under `payment_intent_data`, so the quote prices
the order and cannot hold Checkout to its rate: Stripe converts a non-BRL charge at its rate on the
day, which can drift from the quote's within the session's two hours. Prodigi prices by stock,
cards and country, so an edit elsewhere in the address keeps the price and asks nothing. Its price
can move before the reader pays; the markup takes that.

India's Prodigi shipping dwarfs the cards: its sandbox quoted 3 postcards (`GLOBAL-POST-GLOS-6X4`,
Standard) at $1.59 of items and $18.38 of shipping, $19.97, which `print-fx` charges as about ₹1,855
at the simulator's rates. India-issued cards often decline a foreign merchant: international use is
off by default and every charge needs 3-D Secure
([Stripe](https://docs.stripe.com/india-recurring-payments)), so a declined Indian card is the
reader's bank, not the order.

## Pix

A BRL order offers card and Pix (`allowed_payment_method_types`, which Stripe intersects with the
methods the account has enabled); any other, card alone. A Pix completes the session before the bank
settles it: `payment_status` is `unpaid` and the payment `requires_action`. `print-check` reads the
payment with the session and sends the order back to wait as `processing`, which the reader is told
is with their bank and not to pay again; a payment Stripe has given up on (`requires_payment_method`
or `canceled`) ends the order as `unpaid`, `failed`, as an expired session does with `expired`.

## Artwork

Prodigi fetches public URLs. Both SKUs have one print area of 3708×1263 px and refuse a `back`
asset, so each card is one JPEG drawn in the browser, 300 dpi in its JFIF header, both faces side by
side (`catalogue.ts`'s `panels`): the illustration contained on white, then the word, inside the
physical trim. Files go to the blob plane by a claim and a PUT, and Prodigi reads the raw
`/blobs/mecha-objects/<key>`, since `/img` re-encodes. A file is reachable by whoever holds its
unguessable key, Prodigi included; nothing deletes it yet.

A reader's browser caps a deck at 16 MiB of files, about 60 cards of the seeded art. Unpaid orders in
flight are capped at 500 across everyone (`schema.sql`), which one abuser can fill until theirs expire.

## Delivery evidence

`delivery` holds the free text, the pin and the postal fields as independent statements, kept as
stated: nothing geocodes them or makes them agree. Prodigi posts to the postal fields; the rest reach
the operator's record alone. The buyer's email from Checkout reaches Prodigi because couriers ask for
it. The print screen keeps a `delivery_draft` row on the device, so a draft survives the redirect. A
search asks Nominatim only on submit, the pin comes from the `delivery-map` unit, and each applied
suggestion is a `delivery_choice` row the order carries as `acceptedSuggestions`.

The postal fields take each country's shape from Google's Address Data Service, the data Chrome and
Android build address forms from (CC-BY 4.0, Google): `address-formats.json` holds, per delivery
country, its lines, required fields, postcode pattern and example, the name of each field, and its
states. `checkout-ui/build.ts` turns it into `shell/shared/address-formats.css`, which orders, pairs,
names and marks the fields by the draft's country, and the checkout's gate requires what the country's
post requires plus Prodigi's street, town and postcode. A bairro or district, which Prodigi has no field
for, rides on its second address line. Refresh the data when the countries change:
`deno run --allow-net --allow-write=commerce commerce/address-formats.ts BR AR IL US GB CN IN`.

## What a test order must confirm

Front on the left of the one-image card is a working assumption until a real sample shows it, and
the answer changes `panels` alone. One real deck must also settle packaging and thickness, and one
real Brazil flip-deck must confirm Wire-O coil punch clearance on the 105 mm short edge and the
2-page cover's front/back sequencing.

## Local mode

Every launch plays the providers: `targets: docker` points each sink at a simulator on the compose
stack, whose keys are fakes with a default.

| Simulator | Plays | Published |
| --- | --- | --- |
| `checkout-simulator` | Stripe's Checkout and FX Quote APIs at fixed rates, its hosted page with a Pix the bank settles through `/_simulator/`, and webhooks to `/signal/stripe` | 30826 |
| `prodigi-simulator` | Prodigi's API, artwork fetched through the door as a lab would, callbacks to `/signal/prodigi/<id>`; `/_simulator/` controls | 30827 |
| `cloudprinter-simulator` | Cloudprinter CloudCore v1.0 for Brazil's domestic Wire-O flip-deck, cover/book PDFs fetched and MD5-checked through the door, CloudSignal webhooks to `/signal/cloudprinter`; `/_simulator/` controls | 30828 |
| `mail-simulator` | Cloudflare's Email Sending API, handed to Mailpit | no |
| `mailpit` | The operator's inbox | 30825 |

`commerce/effects_test.ts` runs each handler against the simulators' own request handling.

## Going live

Sandbox or live is each deployment's, never the build's: one generated tree serves both, and a
deployment is live because its Workers hold live values. They are secrets of its `<name>-airlock`
Worker, which the publish carries from its environment or finds held and `sayt verify@cloudflare`
checks by name:

| Secret | Sandbox (staging) | Live (production) |
|---|---|---|
| `STRIPE_SECRET_KEY` | `rk_test_…` | `rk_live_…` |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_…` | `pk_live_…` |
| `PRODIGI_API_KEY` | sandbox key | live key |
| `PRODIGI_ORIGIN` | `https://api.sandbox.prodigi.com` | `https://api.prodigi.com` |
| `CLOUDPRINTER_API_KEY` | sandbox interface key (`https://api.cloudprinter.com`) | live interface key (`https://api.cloudprinter.com`) |
| `MAIL_API_TOKEN`, `MAIL_ACCOUNT_ID` | the deployment's own token | the deployment's own token |

`print-session` sends the publishable key with the session it opens, so the page pays in the mode of
the deployment's keys; an order's mails read test or live from its session id and are sent as
`snapcards@<the deployment's host>`, whose domain must be onboarded for Cloudflare's Email Sending.
Production's values live only in its Workers' secret store; staging's are `staging.secrets.enc.yaml`.
Prodigi is told its URL per order. Cloudprinter's CloudCore interface needs `textbook_co_a6_l_fc`
enabled, its CloudSignal webhook pointed at `https://<domain>/signal/cloudprinter` (which, like
Stripe's, only nudges an order to read `/orders/info`), and a funded wallet or auto-top-up on the
live interface before taking live Brazil orders. Stripe's dashboard needs, per deployment, one
webhook endpoint, `https://<domain>/signal/stripe`, listening for `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` and
`checkout.session.expired`; it only makes an order ask, so nothing else is needed of it. Pix must be
enabled among the account's payment methods for Checkout to offer it.
A local stack uses the simulators; taking a sink's `targets` entry off for a launch points it at the
real vendor with `secrets.enc.yaml`'s sandbox keys.
Pages has no cluster, so its screen simulates: approval shows paid demo status, and nothing is charged or sent.
