# Acceptance

- [ ] Browsing the collection shows cultural flashcard sets with category, locale, and card count. {#accept-browse}
- [ ] Toggling a favorite marks or unmarks a card set immediately. {#accept-favorite}
- [ ] Submitting the generation form creates a new cultural flashcard set with illustrated cards, named by its title and refined by its optional details. {#accept-generate}
- [ ] Flipping a card during play reveals the back text and hint, advancing mastery and progress. {#accept-play-flip}
- [ ] Completing all cards in a set displays the completion summary with score and reset action. {#accept-play-complete}
- [ ] Selecting paper size or card size in Print Studio updates the printable sheet layout and cutting guides. {#accept-print-layout}
- [ ] A reader deletes one card of a deck they generated with two taps on its button; one tap alone reverts. {#accept-delete-card}
- [ ] A reader edits a card of a deck they generated: its description in the deck's language, redrawn on request, the new picture replacing the card's. {#accept-edit-card}

- [ ] Print checkout freezes every card into one file per card, preserves the selected deck and reports unavailable images. {#accept-print-pdf}
- [ ] Pages checkout is explicitly simulated: approval shows paid demo status, decline remains unpaid, and neither sends mail nor charges a card. {#accept-print-demo}
- [ ] Live Checkout charges the frozen quote and holds to shipping coverage; only Stripe's own read of a matching paid session advances the order, places it with the print vendor once, and emails its record once to the operator. {#accept-print-payment}
- [ ] Forged webhooks, mismatched amounts, duplicate callbacks and email failures cannot falsely fulfill an order or charge it again. {#accept-print-failure}

- [ ] Print Studio orders the selected collection through Checkout, which the compose stack's simulator plays: only Stripe's read of the session, which its webhook asks for, marks the order paid, its record is mailed once as a test, a resent event mails nothing, and no live payment or email service is called. {#accept-print-checkout}
- [ ] Print delivery keeps the reader's words, the pin and the postal fields as independent statements: a search is asked only on submit, an applied suggestion never rewrites the free text, the reader's position is asked only on a click, a disagreement is offered rather than resolved, and the order freezes all three. {#accept-print-delivery}
- [ ] Print Studio's first control is the vendor. Print at home keeps every option and offers no order; Prodigi locks the rest with their reasons, leaves stock the one choice and previews each card front and back at 6×4 in. Its checkout requires recipient, street, city, postal code and country, keeps payment disabled until they are complete and quoted, and freezes item, shipping and total, with the configured markup, so Stripe charges exactly that. Paying through the simulator places exactly one Prodigi order whose one file per card the Prodigi simulator measures at 3708×1263, a duplicate webhook places none, a callback on any but the order's own URL is refused, and a vendor refusal alerts the operator by mail and tells the buyer not to pay again. {#accept-print-vendor}
- [ ] Signing in starts at the nav's Sign in, which opens in place onto this device and Google; an empty device is offered setting it up or a phone beside it, and no screen draws a sign-in of its own. A guest who generated a collection is offered, beside it, saving it to this device. {#accept-signin}
- [ ] Sign in with Google on the deployed site is Google's own button, for the app's own client: the release offers it and the auth service's page draws it for that client. {#accept-signin-google}
- [ ] Live Checkout on the deployed site opens Stripe's own form for a quoted Prodigi order: the quote and the session run against the vendors' test modes, the payment unit mounts on a test-mode client secret, nothing is paid, and the order is deleted afterwards. {#accept-print-live-session}
- [ ] Print shop is free and server-less: the options it sets lock with their reasons while the orientation stays the reader's, no checkout appears, and the reader copies the order text and saves a PDF of the deck they selected from one print dialog, with 2N pages, one face each, front then back, 111×154 mm standing or 154×111 mm lying. The collection pill names that deck on every vendor, and so do a Prodigi receipt and record. {#accept-print-shop}
