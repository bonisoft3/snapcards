// Snapcards: cultural children's publishing & flashcard press in Pronto.
@extern(embed)

package snapcards

import (
	"encoding/json"
	"list"

	bayt "github.com/bonisoft3/bayt/core:bayt"
	pronto "github.com/bonisoft3/pronto"
	distribution "github.com/bonisoft3/pronto/distribution"
)

_designMd:             _ @embed(file="DESIGN.md", type=text)
_catalogues:           _ @embed(glob="messages/*.json")
_favoriteRecountBlobl: _ @embed(file="pipelines/favorite-recount.blobl", type=text)
_favoriteCountBlobl:   _ @embed(file="pipelines/favorite-count.blobl", type=text)
_deckCoverBlobl:       _ @embed(file="pipelines/deck-cover.blobl", type=text)
_deckCoverSql:         _ @embed(file="migrations/20261108_deck_cover.sql", type=text)
_cardCountBoundSql:    _ @embed(file="migrations/20261114_card_count_bound.sql", type=text)
_hindiLangSql:         _ @embed(file="migrations/20261125_translation_lang_hi.sql", type=text)

code: pronto.#App & {
	state: entities: {
		AppUser: {
			id:         "0x99e921962d8130b3"
			table:      "app_user"
			durability: "server"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true},
				{ordinal: 2, name: "handle", type: "string", unique: true, cel: "this.size() > 0"},
				{ordinal: 3, name: "created_at", type: "timestamp", default: "now()"},
			]
		}
		CardSet: {
			id:         "0x8c3e5a01f2a4b6c8"
			table:      "card_set"
			durability: "offline"
			// Everyone reads; only the owner writes (020_owner_writes.sql).
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true, cel: "this.size() > 0"},
				{ordinal: 2, name: "name", type: "string", cel: "this.size() > 0"},
				{ordinal: 3, name: "category", type: "string", cel: "this.size() > 0"},
				{ordinal: 4, name: "locale", type: "string", cel: "this.size() > 0"},
				{ordinal: 5, name: "region", type: "string", cel: "this.size() > 0"},
				{ordinal: 6, name: "count", type: "int32", cel: "this >= 0"},
				// Each reader's own now (Favorite), counted in DeckStats.
				{ordinal: 7, name: "favorite", type: "string", retired: true},
				{ordinal: 8, name: "cover_emoji", type: "string", cel: "this.size() > 0"},
				// What the reader asked of every card beyond the title.
				{ordinal: 9, name: "details", type: "string", default: "''", cel: "this.size() >= 0"},
				// The Device whose text slots generate the deck, also the suffix of its id;
				// empty for a curated deck.
				{ordinal: 10, name: "device", type: "string", default: "''", cel: "this.size() >= 0"},
				// Who generated the deck; null for a curated one, which nobody edits.
				{ordinal: 11, name: "owner", type: "uuid", ref: "app_user", required: false, default: "auth_uid()"},
				// Who the deck is for: a preset's message key, or empty with the
				// reader's own words in audience. Its pictures' style and its text
				// follow it (effects/illustrate-card.js, the text effects).
				{ordinal: 12, name: "audience_key", type: "string", default: "''", cel: "this in ['', 'diff_toddler', 'diff_kids', 'diff_teens']"},
				{ordinal: 13, name: "audience", type: "string", default: "''", cel: "this.size() >= 0"},
				// The deck's number among its owner's decks, for display; 023_deck_number.sql
				// assigns it on insert, and a deck with no owner has none.
				{ordinal: 14, name: "number", type: "int32", default: "0", cel: "this >= 0"},
			]
		}
		Flashcard: {
			id:         "0x9d4e5f01a2b3c4d5"
			table:      "flashcard"
			durability: "live"
			access: {scope: "public"}
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true, cel: "this.size() > 0"},
				{ordinal: 2, name: "set_id", type: "string", cel: "this.size() > 0"},
				{ordinal: 3, name: "front", type: "string", cel: "this.size() > 0"},
				{ordinal: 4, name: "back", type: "string", cel: "this.size() >= 0"},
				{ordinal: 5, name: "hint", type: "string", cel: "this.size() >= 0"},
				{ordinal: 6, name: "difficulty", type: "string", cel: "this in ['easy', 'medium', 'hard']"},
				{ordinal: 7, name: "emoji", type: "string", cel: "this.size() > 0"},
				{ordinal: 8, name: "color", type: "string", cel: "this.size() > 0"},
				// What the picture shows, in the deck's language.
				{ordinal: 9, name: "description", type: "string", default: "''", cel: "this.size() >= 0"},
				{ordinal: 10, name: "redraw", type: "string", default: "'settled'", cel: "this in ['settled', 'drawing']"},
				// Its deck's owner, so a card's write is checked without reading the deck.
				{ordinal: 11, name: "owner", type: "uuid", ref: "app_user", required: false, default: "auth_uid()"},
			]
		}
		// The reader's own row, whose visibility alone answers "is this mine": a
		// screen has no session binding, so a probe bound to it is empty exactly
		// when the owner it names is someone else (021_me_provision.sql).
		Me: {
			id:         "0xab19136dc12029d9"
			table:      "me"
			durability: "live"
			access: {scope: "private", owner: "id"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, ref: "app_user"},
			]
		}
		// One reader's favourite of one deck. Un-favouriting sets deleted_at, so a
		// retraction is a row the browser sees rather than an absence, and the pair
		// stays one row however often it toggles.
		Favorite: {
			id:         "0xc0befe1cc9759f25"
			table:      "favorite"
			durability: "offline"
			access: {scope: "private", owner: "user_id"}
			uniques: [{name: "uq_favorite_pair", cols: ["user_id", "deck_id"]}]
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
				{ordinal: 2, name: "user_id", type: "uuid", ref: "app_user", default: "auth_uid()"},
				{ordinal: 3, name: "deck_id", type: "string", ref: "card_set"},
				{ordinal: 4, name: "created_at", type: "timestamp", default: "now()"},
				{ordinal: 5, name: "deleted_at", type: "timestamp", required: false},
			]
			indexes: [{on: "deck_id"}]
		}
		// Whether the count a reader sees included them, stated by the read that
		// produced it (plugins/pronto/docs/access.md#a-count-the-reader-is-inside-of).
		FavoriteCount: {
			id:         "0xf237da033df93fb9"
			table:      "favorite_count"
			durability: "live"
			access: {scope: "private", owner: "user_id"}
			uniques: [{name: "uq_favorite_count_pair", cols: ["user_id", "deck_id"]}]
			fields: [
				// "<user>:<deck>", so a repeated read upserts the same row.
				{ordinal: 1, name: "id", type: "string", pk: true},
				{ordinal: 2, name: "user_id", type: "uuid", required: true},
				{ordinal: 3, name: "deck_id", type: "string", required: true},
				{ordinal: 4, name: "mine_counted", type: "int32", cel: "this >= 0 && this <= 1"},
				{ordinal: 5, name: "total_at_read", type: "int32", cel: "this >= 0"},
				{ordinal: 6, name: "as_of_txid", type: "int64", required: false},
			]
		}
		DeckStats: {
			id:         "0xe8771c4ea1cf7897"
			table:      "deck_stats"
			durability: "live"
			access: {scope: "public"}
			fields: [
				// No ref: a deleted deck's favourites cascade, and the recount's final
				// row names the dead deck, which a foreign key would refuse.
				{ordinal: 1, name: "deck_id", type: "string", pk: true},
				{ordinal: 2, name: "favorite_count", type: "int32", default: "0", cel: "this >= 0"},
				// The newest favorite.txid the count includes: the browser's
				// optimistic count adds only the reader's rows above it.
				{ordinal: 3, name: "counted_txid", type: "int64", default: "0", cel: "this >= 0"},
				// The deck's first card's art, so a library card reads its cover and
				// its count in one row. Production's database ran 005 without it, so
				// 005 keeps those bytes (rawMigrations) and 20261108_deck_cover adds it.
				{ordinal: 4, name: "cover", type: "string", default: "''", cel: "this.size() >= 0"},
			]
		}
		// A deck's title and category in one more language, shared by every
		// reader: whoever first reads the deck in that language pays for it.
		DeckTranslation: {
			id:         "0xd391a73037ff9e31"
			table:      "deck_translation"
			durability: "offline"
			access: {scope: "public", write: true}
			fields: [
				// "<deck>:<lang>"
				{ordinal: 1, name: "id", type: "string", pk: true, cel: "this.size() > 0"},
				{ordinal: 2, name: "set_id", type: "string", cel: "this.size() > 0"},
				{ordinal: 3, name: "lang", type: "string", cel: "this in ['pt', 'es', 'en', 'he', 'zh', 'hi']"},
				{ordinal: 4, name: "name", type: "string", cel: "this.size() > 0"},
				{ordinal: 5, name: "category", type: "string", cel: "this.size() >= 0"},
			]
		}
		// A card's word in one more language, beside its deck's DeckTranslation.
		CardTranslation: {
			id:         "0xf0a3308803dc8669"
			table:      "card_translation"
			durability: "live"
			access: {scope: "public", write: true}
			fields: [
				// "<card>:<lang>"
				{ordinal: 1, name: "id", type: "string", pk: true, cel: "this.size() > 0"},
				{ordinal: 2, name: "card_id", type: "string", cel: "this.size() > 0"},
				{ordinal: 3, name: "set_id", type: "string", cel: "this.size() > 0"},
				{ordinal: 4, name: "lang", type: "string", cel: "this in ['pt', 'es', 'en', 'he', 'zh', 'hi']"},
				{ordinal: 5, name: "word", type: "string", cel: "this.size() > 0"},
			]
			indexes: [{on: "set_id"}]
		}
		// A card's delete button: armed by one tap, confirmed by the next.
		// The next card's picture, which the card screen fetches ahead of the click. Its own row, as a
		// tab's session row from before it has no such column, and a binding on one throws.
		NextPicture: {
			id:         "0xd8d5b715123d4b19"
			table:      "next_picture"
			durability: "tab"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true, cel: "this == 'next'"},
				{ordinal: 2, name: "back", type: "string", cel: "this.size() >= 0"},
			]
		}
		// A Create the form's chart took and this tab has not answered. The form is every tab's,
		// so an intent on it was answered by every tab, and made a deck for each.
		GenerationAsk: {
			id:         "0xf8f18df6b897af0b"
			table:      "generation_ask"
			durability: "tab"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true, cel: "this.size() > 0"},
				{ordinal: 2, name: "set_id", type: "string", default: "''", cel: "this.size() >= 0"},
				{ordinal: 3, name: "run", type: "string", default: "''", cel: "this.size() >= 0"},
				{ordinal: 4, name: "input", type: "string", default: "''", cel: "this.size() >= 0"},
				{ordinal: 5, name: "created_at", type: "timestamp", default: "now()"},
			]
		}
		CardDelete: {
			id:         "0x8a719006cf76becc"
			table:      "card_delete"
			durability: "tab"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true, cel: "this.size() > 0"},
				{ordinal: 2, name: "state", type: "string", default: "'idle'", cel: "this in ['idle', 'armed', 'confirmed']"},
			]
		}
		LocalizedCard: {
			id:         "0xae702fa214382b33"
			table:      "localized_card"
			durability: "tab"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true},
				{ordinal: 2, name: "set_id", type: "string"},
				{ordinal: 3, name: "front", type: "string"},
				{ordinal: 4, name: "original_front", type: "string"},
				{ordinal: 5, name: "emoji", type: "string"},
			]
		}
		LocalizedDeck: {
			id:         "0xf41d06b85c125227"
			table:      "localized_deck"
			durability: "tab"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true},
				{ordinal: 2, name: "name", type: "string"},
				{ordinal: 3, name: "original_name", type: "string"},
				{ordinal: 4, name: "category", type: "string"},
				{ordinal: 5, name: "cover_emoji", type: "string"},
				{ordinal: 6, name: "count", type: "int32"},
				{ordinal: 7, name: "locale", type: "string"},
				{ordinal: 8, name: "region", type: "string"},
				{ordinal: 9, name: "favorite", type: "string", retired: true},
				{ordinal: 17, name: "owner", type: "string"},
				{ordinal: 18, name: "number", type: "int32"},
				// A generated deck's art per level, now deck_level's (card-art.cue).
				{ordinal: 10, name: "art", type: "string", retired: true},
				{ordinal: 11, name: "art1", type: "string", retired: true},
				{ordinal: 12, name: "art2", type: "string", retired: true},
				{ordinal: 13, name: "art3", type: "string", retired: true},
				{ordinal: 14, name: "art1_count", type: "int32", retired: true},
				{ordinal: 15, name: "art2_count", type: "int32", retired: true},
				{ordinal: 16, name: "art3_count", type: "int32", retired: true},
			]
		}
		PlaySession: {
			id:         "0xaf1b2c3d4e5f6071"
			table:      "play_session"
			durability: "tab"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true, cel: "this == 'session'"},
				{ordinal: 2, name: "set_id", type: "string", cel: "this.size() > 0"},
				{ordinal: 3, name: "card_index", type: "int32", cel: "this >= 0"},
				{ordinal: 4, name: "flipped", type: "string", cel: "this in ['no', 'yes']"},
				{ordinal: 5, name: "mastered", type: "int32", cel: "this >= 0"},
				{ordinal: 6, name: "total", type: "int32", cel: "this >= 0"},
				{ordinal: 7, name: "status", type: "string", cel: "this in ['playing', 'fullscreen', 'completed']"},
				{ordinal: 8, name: "front", type: "string", cel: "this.size() >= 0"},
				{ordinal: 9, name: "back", type: "string", cel: "this.size() >= 0"},
				{ordinal: 10, name: "hint", type: "string", cel: "this.size() >= 0"},
				{ordinal: 11, name: "emoji", type: "string", cel: "this.size() >= 0"},
				{ordinal: 12, name: "card_id", type: "string", cel: "this.size() >= 0"},
				{ordinal: 13, name: "original_front", type: "string"},
				{ordinal: 14, name: "translation_failed_topic", type: "string"},
				{ordinal: 15, name: "library_query", type: "string", default: ""},
				// The shelf is the address now ({param.shelf}), not a column.
				{ordinal: 16, name: "library_filter", type: "string", retired: true},
				// The last card was passed: what only the folds over the deck can see.
				{ordinal: 17, name: "finished", type: "string", default: "''", cel: "this in ['', 'yes']"},
			]
		}
		PrintConfig: {
			id:         "0xbf5e4d3c2b1a0987"
			table:      "print_config"
			durability: "tab"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true, cel: "this in ['config', 'press']"},
				{ordinal: 2, name: "set_id", type: "string", cel: "this.size() > 0"},
				{ordinal: 3, name: "paper", type: "string", cel: "this in ['a4', 'letter']"},
				{ordinal: 4, name: "card_size", type: "string", cel: "this in ['standard', 'mini', 'jumbo', 'poster']"},
				{ordinal: 5, name: "layout", type: "string", cel: "this in ['fold', 'duplex_h', 'duplex_v', '2x2', '3x3']"},
				{ordinal: 6, name: "cut_lines", type: "string", cel: "this in ['no', 'yes']"},
				{ordinal: 7, name: "orientation", type: "string", cel: "this in ['portrait', 'landscape']"},
				// Who prints: the reader's own printer, a print shop given a file, or
				// delivered mail-order print (Cloudprinter flip-deck in BR, Prodigi postcards elsewhere).
				{ordinal: 8, name: "vendor", type: "string", cel: "this in ['print_at_home', 'print_shop', 'prodigi']"},
				{ordinal: 9, name: "stock", type: "string", cel: "this in ['gloss', 'mohawk']"},
			]
		}
		// The reader's delivery statement for a print order, kept on the device
		// so it survives the Stripe redirect. The free text, the pin and the
		// postal fields are independent statements; nothing here makes them
		// agree, and the order freezes all three (commerce/README.md).
		DeliveryDraft: {
			id: "0xc0169c47cea14ea3"
			table:      "delivery_draft"
			durability: "device"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true, cel: "this == 'draft'"},
				{ordinal: 2, name: "step", type: "string", cel: "this in ['search', 'details', 'confirming']"},
				{ordinal: 3, name: "text", type: "string", cel: "this.size() <= 2000"},
				// The text as last submitted: the search question, asked only on
				// Enter or the button, never while the reader types.
				{ordinal: 16, name: "search_q", type: "string", cel: "this.size() <= 2000"},
				// The postal fields as last committed: the address question.
				{ordinal: 17, name: "address_q", type: "string", cel: "this.size() <= 2000"},
				{ordinal: 4, name: "pin_latitude", type: "string", cel: "this.size() <= 32"},
				{ordinal: 5, name: "pin_longitude", type: "string", cel: "this.size() <= 32"},
				{ordinal: 6, name: "pin_source", type: "string", cel: "this in ['', 'gps', 'search', 'map']"},
				// "lat,lon" while a pin exists, else empty: the reverse question, which
				// an empty key withdraws.
				{ordinal: 7, name: "pin_q", type: "string", cel: "this.size() <= 64"},
				// "lat,lon" of the reader's own position while they keep it on, else
				// empty: searches prefer places near it, wherever the pin goes. It,
				// phone and email are optional, filled into a draft stored before they
				// existed: a device row outlives the release that wrote it.
				{ordinal: 18, name: "near", type: "string", required: false, cel: "this.size() <= 64"},
				{ordinal: 8, name: "recipient", type: "string", cel: "this.size() <= 200"},
				// Optional ways to reach the recipient: the courier's, and Checkout's prefill.
				{ordinal: 19, name: "phone", type: "string", required: false, cel: "this.size() <= 40"},
				// The phone picker's country once the reader or an arriving code
				// chose one; empty, the picker follows the address (checkout-ui).
				{ordinal: 27, name: "phone_country", type: "string", required: false, cel: "this == '' || this.matches('^[A-Z]{2}$')"},
				{ordinal: 20, name: "email", type: "string", required: false, cel: "this.size() <= 254"},
				{ordinal: 9, name: "line1", type: "string", cel: "this.size() <= 200"},
				{ordinal: 10, name: "line2", type: "string", cel: "this.size() <= 200"},
				// The bairro or district a country's post writes under the street;
				// Prodigi has no field for it and takes it on the unit line.
				// Optional, as near is.
				{ordinal: 21, name: "district", type: "string", required: false, cel: "this.size() <= 200"},
				{ordinal: 11, name: "city", type: "string", cel: "this.size() <= 200"},
				{ordinal: 12, name: "region", type: "string", cel: "this.size() <= 200"},
				{ordinal: 13, name: "postal_code", type: "string", cel: "this.size() <= 40"},
				{ordinal: 14, name: "country", type: "string", cel: "this == '' || this.matches('^[A-Z]{2}$')"},
				{ordinal: 15, name: "instructions", type: "string", cel: "this.size() <= 1000"},
				{ordinal: 22, name: "pin_stale", type: "string", required: false, cel: "this in ['', 'true', 'false']"},
				{ordinal: 23, name: "line2_stale", type: "string", required: false, cel: "this in ['', 'true', 'false']"},
				{ordinal: 24, name: "line2_ghost", type: "string", required: false, cel: "this.size() <= 200"},
				{ordinal: 25, name: "search_stale", type: "string", required: false, cel: "this in ['', 'true', 'false']"},
				{ordinal: 26, name: "order_id", type: "string", required: false, cel: "this.size() <= 64"},
				{ordinal: 28, name: "tax_id", type: "string", required: false, cel: "this.size() <= 32"},
			]
		}
		// The offers the reader applied to the draft, oldest first: the order's
		// suggestion provenance, which is not verification. Kept to the tab, so
		// an order placed from it is the last to carry them.
		DeliveryChoice: {
			id: "0xadaae16743a33b19"
			table:      "delivery_choice"
			durability: "tab"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true, cel: "this in ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']"},
				{ordinal: 2, name: "source", type: "string", cel: "this in ['search', 'pin']"},
				{ordinal: 3, name: "label", type: "string", cel: "this.size() <= 300"},
			]
		}
		// The geocoder's memo: one answer per question, p0..p4 a place each (its
		// fields joined by tabs, so a handler splits rather than parses), "" past
		// the last.
		PlaceAnswer: {
			id: "0x82c0584d2d7ddc5d"
			table:      "place_answer"
			durability: "tab"
			uniques: [{name: "uq_place_answer_question", cols: ["kind", "q", "lang"]}]
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true},
				{ordinal: 2, name: "kind", type: "string", cel: "this in ['search', 'address', 'reverse']"},
				{ordinal: 3, name: "q", type: "string", cel: "this.size() <= 2000"},
				{ordinal: 4, name: "lang", type: "string", cel: "this.size() <= 8"},
				{ordinal: 5, name: "p0", type: "string", cel: "this.size() <= 2000"},
				{ordinal: 6, name: "p1", type: "string", cel: "this.size() <= 2000"},
				{ordinal: 7, name: "p2", type: "string", cel: "this.size() <= 2000"},
				{ordinal: 8, name: "p3", type: "string", cel: "this.size() <= 2000"},
				{ordinal: 9, name: "p4", type: "string", cel: "this.size() <= 2000"},
			]
		}
		// The current answer's places, one row per offer the screen draws:
		// s0..s4 for the search, `address` for the postal fields, `pin` for
		// the pin.
		PlaceSuggestion: {
			id: "0xa87b8e0f09ac85bd"
			table:      "place_suggestion"
			durability: "tab"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true, cel: "this in ['s0', 's1', 's2', 's3', 's4', 'address', 'pin']"},
				{ordinal: 2, name: "label", type: "string", cel: "this.size() <= 300"},
				{ordinal: 3, name: "line1", type: "string", cel: "this.size() <= 200"},
				{ordinal: 4, name: "city", type: "string", cel: "this.size() <= 200"},
				{ordinal: 5, name: "region", type: "string", cel: "this.size() <= 200"},
				{ordinal: 6, name: "postal_code", type: "string", cel: "this.size() <= 40"},
				{ordinal: 7, name: "country", type: "string", cel: "this == '' || this.matches('^[A-Z]{2}$')"},
				{ordinal: 8, name: "latitude", type: "string", cel: "this.size() <= 32"},
				{ordinal: 9, name: "longitude", type: "string", cel: "this.size() <= 32"},
				{ordinal: 11, name: "district", type: "string", required: false, cel: "this.size() <= 200"},
				// The search a list row answers; "" on the pin and address offers.
				{ordinal: 10, name: "q", type: "string", cel: "this.size() <= 2000"},
			]
		}
		// The /generate form as this browser holds it, never synced: no other
		// reader sees what was typed, no other writer moves it, and a reload finds
		// the deck it is generating. Its status and every edit are its chart's
		// (generate.html).
		GenerationForm: {
			id:         "0xc03dedddc2a33094"
			table:      "generation_form"
			durability: "device"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true, cel: "this == 'draft'"},
				{ordinal: 2, name: "topic", type: "string", cel: "this.size() >= 0"},
				{ordinal: 3, name: "category", type: "string", cel: "this.size() >= 0"},
				{ordinal: 4, name: "locale", type: "string", cel: "this.size() >= 0"},
				{ordinal: 5, name: "region", type: "string", cel: "this.size() >= 0"},
				{ordinal: 6, name: "card_count", type: "int32", cel: "this >= 0 && this <= 20"},
				{ordinal: 7, name: "status", type: "string", cel: "this in ['idle', 'generating', 'done', 'partial', 'failed']"},
				{ordinal: 8, name: "set_id", type: "string", cel: "this.size() >= 0"},
				{ordinal: 9, name: "details", type: "string", cel: "this.size() >= 0"},
				// Level 1, the words this browser writes: running until no card of
				// the deck waits for one (create_set).
				{ordinal: 10, name: "words", type: "string", default: "''", cel: "this in ['', 'running', 'complete']"},
				// The level the generation works toward that has no DeckLevel row
				// yet, its text being written: 2 from submit, 3 once level 2 has
				// rows, 0 once level 3 has (create_set). Its bar pulses.
				{ordinal: 11, name: "next", type: "int32", default: "0", cel: "this >= 0 && this <= 3"},
				// The age combo box: a preset's message key, which each reader sees
				// in their language, or empty with what the reader typed.
				{ordinal: 12, name: "audience_key", type: "string", default: "'diff_kids'", cel: "this in ['', 'diff_toddler', 'diff_kids', 'diff_teens']"},
				{ordinal: 13, name: "audience", type: "string", default: "''", cel: "this.size() >= 0"},
				{ordinal: 14, name: "asked", type: "string", retired: true},
				{ordinal: 15, name: "ended", type: "string", retired: true},
				{ordinal: 16, name: "run", type: "string", default: "''", cel: "this.size() >= 0"},
			]
		}
		// This browser's partition of the server's generation rows, minted once
		// from two of the terminal's draws. A partition key, not a secret: the
		// rows it names are public.
		Device: {
			id:         "0x81fb3b924095b255"
			table:      "device"
			durability: "device"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true, cel: "this == 'device'"},
				{ordinal: 2, name: "key", type: "string", cel: "this.matches('^[0-9a-f]{16}$')"},
				// The reader's theme, a device's choice: what the theme chart assigns.
				{ordinal: 3, name: "theme", type: "string", default: "'auto'", cel: "this in ['auto', 'light', 'dark']"},
			]
		}
		// A device's two text slots, "<device>:draft-cheap" and "<device>:draft-heavy":
		// its decks' text levels run on them (019_deck_advance.sql), and its
		// translations on the cheap one, so no device waits on or writes another's.
		GenerationDraft: {
			id:         "0xcf4d3c2b1a098765"
			table:      "generation_draft"
			durability: "live"
			access: {scope: "public", write: true}
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true, cel: "this.matches('^[0-9a-f]{16}:draft-(cheap|heavy)$')"},
				{ordinal: 2, name: "topic", type: "string", cel: "this.size() >= 0"},
				{ordinal: 3, name: "category", type: "string", cel: "this.size() >= 0"},
				{ordinal: 4, name: "locale", type: "string", cel: "this.size() >= 0"},
				{ordinal: 5, name: "region", type: "string", cel: "this.size() >= 0"},
				{ordinal: 6, name: "card_count", type: "int32", cel: "this >= 0 && this <= 20"},
				{ordinal: 7, name: "status", type: "string", cel: "this in ['idle', 'drafting', 'illustrating', 'done', 'failed']"},
				// The deck a text level writes: its outcome fans out to the
				// deck's cards (card-art.cue); empty for a translation.
				{ordinal: 8, name: "set_id", type: "string", cel: "this.size() >= 0"},
				{ordinal: 9, name: "details", type: "string", default: "''", cel: "this.size() >= 0"},
			]
		}
		DeckPressSeat: {
			id:         "0xd71f4bf5a741e3f4"
			table:      "deck_press_seat"
			durability: "live"
			access: {scope: "private", owner: "actor"}
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true, cel: "this.size() > 0 && this.size() <= 128"},
				{ordinal: 2, name: "instance_id", type: "uuid"},
				{ordinal: 3, name: "actor", type: "uuid"},
				{ordinal: 4, name: "seat", type: "string", cel: "this.size() > 0 && this.size() <= 64"},
				{ordinal: 5, name: "revision", type: "int64", cel: "this >= 0"},
				{ordinal: 6, name: "phase", type: "string", cel: "this in ['active', 'completed']"},
				{ordinal: 7, name: "view", type: "json", cel: "type(this) == map && size(this) == 2 && has(this.flipped) && type(this.flipped) == string && this.flipped in [\"no\", \"yes\"] && has(this.status) && type(this.status) == string && this.status in [\"playing\", \"fullscreen\", \"login\", \"completed\"]"},
			]
		}
		BrowserDraft: {
			id:         "0xb603ef324cd7ef35"
			table:      "browser_draft"
			durability: "tab"
			uniques: [{name: "uq_browser_draft_question", cols: ["topic", "locale", "status", "set_id", "run"]}]
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true, cel: "this.size() > 0 && this.size() <= 128"},
				{ordinal: 2, name: "topic", type: "string", cel: "this.size() > 0 && this.size() <= 128"},
				{ordinal: 3, name: "locale", type: "string", cel: "this.size() > 0 && this.size() <= 32"},
				{ordinal: 4, name: "status", type: "string", cel: "this.size() > 0 && this.size() <= 32"},
				{ordinal: 5, name: "w0", type: "string", cel: "this.size() > 0 && this.size() <= 128"},
				{ordinal: 6, name: "w1", type: "string", cel: "this.size() > 0 && this.size() <= 128"},
				{ordinal: 7, name: "w2", type: "string", cel: "this.size() > 0 && this.size() <= 128"},
				{ordinal: 8, name: "w3", type: "string", cel: "this.size() > 0 && this.size() <= 128"},
				{ordinal: 9, name: "w4", type: "string", cel: "this.size() > 0 && this.size() <= 128"},
				{ordinal: 10, name: "set_id", type: "string", default: "''", cel: "this.size() <= 128"},
				{ordinal: 11, name: "run", type: "string", default: "''", cel: "this.size() <= 128"},
			]
		}
	}

	// What production's database ran 005-010 with; a later entity arrives in a
	// migration of its own.
	state: baseline: {
		entities: ["CardArt", "DeckLevel", "DeckProgress", "AppUser", "CardSet", "Flashcard", "Me", "Favorite", "FavoriteCount", "DeckStats", "DeckTranslation", "CardTranslation", "GenerationDraft", "DeckPressSeat"]
		after: "20261106"
		// 20261106_print_order_payments, 20261107_print_order_file, 20261113_bounded_job_keys, 20261113_job_key_once, 20261115_session_mode, 20261118_br_spiral_flip_deck, 20261119_order_confirmation_thread, 20261119_order_tracking_and_ship_mail, 20261121_machine_clock and 20261125_print_country_in carry the order since its release.
		carried: "20261106_print_order": "2d3b737a1d0a79cfd30d13b9d08da46061d64f9da255e02096cd17db3325dee9"
	}

	state: rawMigrations: [
		{name: "003_rls.sql", src: "migrations/baseline/003_rls.sql"},
		// As production applied it, before deck_stats.cover (20261108_deck_cover).
		{name: "005_create_tables.sql", src: "migrations/baseline/005_create_tables.sql"},
		{name: "010_machines.sql", src: "migrations/baseline/010_machines.sql"},
		{name: "802_signals.sql", src: "migrations/baseline/802_signals.sql"},
		{name: "016_mecha_actors.sql", src: "migrations/baseline/016_mecha_actors.sql"},
		{name: "017_card_art_fan_out.sql", src: "migrations/baseline/017_card_art_fan_out.sql"},
		{name: "018_deck_level.sql", src: "migrations/baseline/018_deck_level.sql"},
		{name: "019_deck_advance.sql", src: "migrations/baseline/019_deck_advance.sql"},
		{name: "020_owner_writes.sql", src: "services/database/sql/020_owner_writes.sql"},
		{name: "021_me_provision.sql", src: "services/database/sql/021_me_provision.sql"},
		{name: "022_deck_favorites.sql", src: "services/database/sql/022_deck_favorites.sql"},
		{name: "023_deck_number.sql", src: "services/database/sql/023_deck_number.sql"},
	]

	state: drains: "deck-favorites": {on: ["favorite"], call: "refresh_deck_favorites", stream: false}
	state: drains: "deck-covers": {on: ["flashcard"], call: "refresh_deck_covers", stream: false}
	state: migrations: "20261108_deck_cover": {operations: [{sql: {up: _deckCoverSql, onComplete: true}}]}
	// The draft's upper bound on card_count, which 005 keeps without.
	state: migrations: "20261114_card_count_bound": {operations: [{sql: {up: _cardCountBoundSql, onComplete: true}}]}
	// Hindi among the translations' languages, which 005 keeps without.
	state: migrations: "20261125_translation_lang_hi": {operations: [{sql: {up: _hindiLangSql, onComplete: true}}]}

	state: pipelines: {
		// Absolute recounts of the event's own deck, never deltas; a foreign
		// message is dropped, since reasserting the sink would restamp every row.
		"favorite-recount": {
			from:  "Favorite"
			to:    "DeckStats"
			group: "snapcards-favorite-recount"
			key:   "deck_id"
			transform: {
				aggregate: "select=deck_id,txid,deleted_at"
				bloblang:  _favoriteRecountBlobl
			}
			fold: {
				projects:  "favorite_count"
				watermark: "counted_txid"
				dedupe: ["user_id", "deck_id"]
				retracted: "deleted_at"
				pair: {
					table:   "favorite_count"
					counted: "mine_counted"
					total:   "total_at_read"
					asOf:    "as_of_txid"
				}
			}
		}
		// The deck's first card's art; the edge's deck-covers drain keeps the same.
		"deck-cover": {
			from:  "Flashcard"
			to:    "DeckStats"
			group: "snapcards-deck-cover"
			key:   "deck_id"
			transform: {
				aggregate: "select=set_id,id,back"
				bloblang:  _deckCoverBlobl
			}
		}
		"favorite-count": {
			from:  "Favorite"
			to:    "FavoriteCount"
			group: "snapcards-favorite-count"
			key:   "id"
			transform: {
				aggregate: "select=user_id,deck_id,txid,deleted_at"
				bloblang:  _favoriteCountBlobl
			}
		}
	}

	state: effects: {
		"smollm3-draft": {
			key: ["id", "topic", "locale", "region"]
			input: {
				topic:      "NEW.topic"
				details:    "NEW.details"
				locale:     "NEW.locale"
				region:     "NEW.region"
				card_count: "NEW.card_count"
				audience_key: {raw: "COALESCE((SELECT s.audience_key FROM card_set s WHERE s.id = NEW.set_id), '')"}
				audience: {raw: "COALESCE((SELECT s.audience FROM card_set s WHERE s.id = NEW.set_id), '')"}
			}
			sink: {
				ai:         "text"
				tier:       "cheap"
				idempotent: true
			}
			note: "tsbifrost AI gateway text drafting is deterministic for a given (id, topic, locale, region) key; the id names the device's slot, so two devices never share a key"
		}
		"heavy-draft": {
			key: ["id", "topic", "locale", "region"]
			input: {
				topic:      "NEW.topic"
				details:    "NEW.details"
				locale:     "NEW.locale"
				region:     "NEW.region"
				card_count: "NEW.card_count"
				audience_key: {raw: "COALESCE((SELECT s.audience_key FROM card_set s WHERE s.id = NEW.set_id), '')"}
				audience: {raw: "COALESCE((SELECT s.audience FROM card_set s WHERE s.id = NEW.set_id), '')"}
			}
			sink: {
				ai:         "text"
				tier:       "heavy"
				idempotent: true
			}
			note: "tsbifrost AI gateway heavy text drafting is deterministic for a given (id, topic, locale, region) key; the id names the device's slot, so two devices never share a key"
		}
	}

	state: mecha: reducers: deck_press: {
		rules: "machines/deck_press_rules.js"
		machine: {
			config: {
				id:      "deck_press"
				initial: "active"
				states: {
					active: {
						on: {
							select_deck: {target: "active", actions: "selectDeck"}
							flip_card: {target: "active", actions: "flipCard"}
							next_card: {target: "active", actions: "nextCard"}
							prev_card: {target: "active", actions: "prevCard"}
							master_card: {target: "active", actions: "masterCard"}
							restart_session: {target: "active", actions: "restartSession"}
							configure_print: {target: "active", actions: "configurePrint"}
							finish_deck: {target: "completed"}
						}
					}
					completed: {
						type: "final"
					}
				}
			}
			setup: {
				version:    1
				initialize: "initial"
				types: {
					input: {type: "object", fields: {}}
					context: {
						type: "object"
						fields: {
							flipped: {type: "string", maxLength: 3, values: ["no", "yes"]}
							status: {type: "string", maxLength: 16, values: ["playing", "fullscreen", "login", "completed"]}
							card_index: {type: "integer", min: 0, max: 1000}
							mastered: {type: "integer", min: 0, max: 1000}
							total: {type: "integer", min: 1, max: 1000}
							paper: {type: "string", maxLength: 16, values: ["a4", "letter"]}
							card_size: {type: "string", maxLength: 16, values: ["standard", "mini", "jumbo", "poster"]}
							layout: {type: "string", maxLength: 16, values: ["fold", "duplex_h", "duplex_v", "2x2", "3x3"]}
							cut_lines: {type: "string", maxLength: 3, values: ["no", "yes"]}
							orientation: {type: "string", maxLength: 16, values: ["portrait", "landscape"]}
						}
					}
					view: {
						type: "object"
						fields: {
							status: {type: "string", maxLength: 16, values: ["playing", "fullscreen", "login", "completed"]}
							flipped: {type: "string", maxLength: 3, values: ["no", "yes"]}
						}
					}
					events: {
						select_deck: {tier: "mecha", payload: {type: "object", fields: {total: {type: "integer", min: 0, max: 1000}, card_index: {type: "integer", min: 0, max: 1000}}}}
						flip_card: {tier: "mecha", payload: {type: "object", fields: {flipped: {type: "string", maxLength: 3, values: ["no", "yes"]}}}}
						next_card: {tier: "mecha", payload: {type: "object", fields: {card_index: {type: "integer", min: 0, max: 1000}, total: {type: "integer", min: 0, max: 1000}}}}
						prev_card: {tier: "mecha", payload: {type: "object", fields: {card_index: {type: "integer", min: 0, max: 1000}, total: {type: "integer", min: 0, max: 1000}}}}
						master_card: {tier: "mecha", payload: {type: "object", fields: {card_index: {type: "integer", min: 0, max: 1000}, mastered: {type: "integer", min: 0, max: 1000}, total: {type: "integer", min: 0, max: 1000}}}}
						restart_session: {tier: "mecha", payload: {type: "object", fields: {total: {type: "integer", min: 0, max: 1000}, card_index: {type: "integer", min: 0, max: 1000}}}}
						configure_print: {tier: "mecha", payload: {type: "object", fields: {param: {type: "string", maxLength: 32, values: ["paper", "orientation", "size", "grid", "lines", "trigger", "window_print"]}}}}
						finish_deck: {tier: "mecha", payload: {type: "object", fields: {}}}
					}
				}
				actions: {
					selectDeck: {reads: ["total", "card_index"], writes: ["card_index", "flipped", "mastered", "total", "status"]}
					flipCard: {reads: ["flipped"], writes: ["flipped"]}
					nextCard: {reads: ["card_index", "total"], writes: ["card_index", "flipped", "status"]}
					prevCard: {reads: ["card_index", "total"], writes: ["card_index", "flipped", "status"]}
					masterCard: {reads: ["card_index", "mastered", "total"], writes: ["card_index", "flipped", "mastered", "status"]}
					restartSession: {reads: ["total", "card_index"], writes: ["card_index", "flipped", "mastered", "total", "status"]}
					configurePrint: {reads: ["param"], writes: ["paper", "card_size", "layout", "cut_lines", "orientation"]}
				}
			}
		}
	}

	state: cortex: (pronto.#CortexComposition & {
		root: _snapcardsRoot
		entities: {for _, observer in _snapcardsRoot.setup.actors if observer.via == "observe" if observer.machine != _|_ {
			let target = _snapcardsRoot.setup.actors[observer.machine]
			let entity = target.machine.config.meta.entity
			(entity): {table: code.state.entities[entity].table}
		}}
	}).out

	capabilities: {
		edgeImages: {
			sourceBucket: "trash-362115-snapcards-bytes"
			plan:         "paid"
		}
		seedBlobs: dir: "assets/seed"
		auth: {required: false, service: "/auth"}
		// A card's pictures live in the blob plane, served by /img like the
		// imported ones; the database holds their URLs (services/airlock/blobs.ts).
		blobs: true
		ai: {
			text: ["browser", "cheap", "heavy"]
			image: ["browser", "cheap", "heavy"]
			targets: local: {
				text: {
					cheap: "gemma3:1b"
					heavy: "gemma3:4b"
				}
				image: {
					cheap: {model: "sd-turbo-q8_0", size: "256x256", steps: 1}
					heavy: {model: "flux1-schnell-q4_k", size: "384x384", steps: 2}
				}
			}
			// Level 3 is each deployment's AI_IMAGE_HEAVY. `google` is Gemini, for
			// production: Phoenix drew a paca as an alpaca and a giant anteater as
			// a mongoose whatever the prompt said, and invented every coin but the
			// US quarter; Flash Lite drew them all as they are, at the lowest price
			// of Gemini's image models, keyed by the dispatcher's GEMINI_API_KEY.
			// `cloudflare` is level 2's free Workers AI model at twice its steps,
			// for staging, which holds no Gemini key.
			targets: cloudflare: image: heavy: {
				secret: "AI_IMAGE_HEAVY"
				routes: {
					google: {provider: "google", model: "gemini-3.1-flash-lite-image", params: generationConfig: imageConfig: aspectRatio: "1:1"}
					cloudflare: {provider: "cloudflare", model: "@cf/black-forest-labs/flux-1-schnell", size: "512x512", steps: 4}
				}
			}
		}
		hatches: {
			"window-print": {
				kind: "host-dom"
				src:  "shell/hatches/window-print.js"
				files: ["shell/hatches/window-print.js"]
				note: "calls window.print() when the user clicks #btn-window-print"
			}
		}
		// The delivery map is seated in a frame: MapLibre starts its tile worker
		// from a URL the terminal's Trusted Types policy would refuse, and the
		// reader's position is asked there, under the frame's delegated grant.
		vendored: "delivery-map": {
			isolation: "realm"
			grants: ["geolocation"]
			ports: {
				reads: ["DeliveryDraft"]
				raises: pin: {type: "object", fields: {
					latitude:  {type: "string", maxLength: 32}
					longitude: {type: "string", maxLength: 32}
					// Empty, with empty coordinates: the reader turned their position off.
					source: {type: "string", maxLength: 3, values: ["", "gps", "map"]}
				}}
			}
			src: "shell/units/delivery-map/index.html"
			files: [
				"shell/units/delivery-map/index.html",
				"shell/units/delivery-map/vendor/maplibre-gl.js",
				"shell/units/delivery-map/vendor/maplibre-gl.css",
			]
			note: "MapLibre 5.24.0 over OpenFreeMap tiles: a pin the reader moves only by taking it, and a toggle for their position"
		}
		// The geocoder worker runs under the app's policy, so its one origin is
		// the app's to declare.
		resources: nominatim: {
			kind:   "connect"
			source: "https://nominatim.openstreetmap.org"
			note:   "OpenStreetMap address search and reverse geocoding for print delivery (shell/units/geocoder)"
		}
		vendored: geocoder: {
			isolation: "agent"
			ports: {
				reads: ["DeliveryDraft"]
				raises: found: {}
			}
			memo: {entity: "PlaceAnswer", key: ["kind", "q", "lang"]}
			src: "shell/units/geocoder/unit.js"
			files: ["shell/units/geocoder/unit.js"]
			note: "OpenStreetMap Nominatim search and reverse geocoding, one memoised answer per question, asked at most once a second and never while the reader types"
		}
		vendored: {
			"ai-browser": {
				isolation: "agent"
				ports: {reads: ["GenerationForm"], raises: draft: {}}
				memo: {entity: "BrowserDraft", key: ["topic", "locale", "status", "set_id", "run"]}
				src: "shell/units/ai-browser/unit.js"
				files: ["shell/units/ai-browser/unit.js"]
				note: "Tier 0 non-blocking browser AI worker (SmolLM2-135M / Gemma-4-E2B with lexical and procedural SVG sketch fallback)"
			}
		}
	}

	surface: {
		screens: {
			cards: {
				files: shared: ["shell/shared/chrome-ready.css", "shell/shared/chrome.css", "shell/shared/nav.css"]
				title: "Cards"
				// One route, three addresses: the library and its shelves, each a
				// strip entry current at its own address.
				route: "/:shelf?"
				label: "nav_cards"
				entries: [
					{label: "My Cards", key: "nav_my_cards", params: {shelf: "mine"}},
					{label: "Gallery", key: "nav_gallery", params: {shelf: "gallery"}},
				]
				states: ["browse"]
				hatches: ["window-print"]
				paths: {
					fav: {states: ["browse", "browse"], accepts: ["accept-favorite"]}
					select: {states: ["browse", "browse"], accepts: ["accept-browse"]}
				}
			}
			generate: {
				files: shared: ["shell/shared/chrome-ready.css", "shell/shared/chrome.css", "shell/shared/nav.css"]
				title: "Generate"
				route: "/generate"
				label: "nav_generate"
				states: ["form"]
				hatches: ["window-print"]
				paths: {
					create: {states: ["form", "form"], accepts: ["accept-generate"]}
				}
			}
			explore: {
				files: shared: ["shell/shared/chrome-ready.css", "shell/shared/chrome.css", "shell/shared/nav.css", "shell/shared/translation-feedback.css", "shell/shared/card-art.css"]
				title: "Explore"
				route: "/explore"
				label: "nav_explore"
				states: ["playing", "completed"]
				hatches: ["window-print"]
				paths: {
					flip: {states: ["playing", "playing"], accepts: ["accept-play-flip"]}
					next: {states: ["playing", "completed"], accepts: ["accept-play-flip"]}
					prev: {states: ["playing", "playing"], accepts: ["accept-play-flip"]}
					master: {states: ["playing", "completed"], accepts: ["accept-play-complete"]}
					restart: {states: ["completed", "playing"], accepts: ["accept-play-complete"]}
					delete: {states: ["playing", "playing"], accepts: ["accept-delete-card"]}
					edit: {states: ["playing", "playing"], accepts: ["accept-edit-card"]}
				}
			}
			deck: {
                files: shared: ["shell/shared/chrome-ready.css", "shell/shared/chrome.css", "shell/shared/nav.css"]
				title:   "Explore Deck"
				route:   "/explore/:deck"
				// It only redirects, so a kept one showed its loading line on every reopen.
				keep:    0
				strip:   false
				states:  ["playing", "completed"]
				hatches: ["window-print"]
				paths: {
					flip: {states: ["playing", "playing"], accepts: ["accept-play-flip"]}
					next: {states: ["playing", "completed"], accepts: ["accept-play-flip"]}
					prev: {states: ["playing", "playing"], accepts: ["accept-play-flip"]}
					master: {states: ["playing", "completed"], accepts: ["accept-play-complete"]}
					restart: {states: ["completed", "playing"], accepts: ["accept-play-complete"]}
				}
			}
			card: {
				files: shared: ["shell/shared/chrome-ready.css", "shell/shared/chrome.css", "shell/shared/nav.css", "shell/shared/translation-feedback.css", "shell/shared/card-art.css"]
				title: "Explore Card"
				route: "/explore/:deck/:card"
				strip: false
				states: ["playing", "completed"]
				hatches: ["window-print"]
				paths: {
					flip: {states: ["playing", "playing"], accepts: ["accept-play-flip"]}
					next: {states: ["playing", "completed"], accepts: ["accept-play-flip"]}
					prev: {states: ["playing", "playing"], accepts: ["accept-play-flip"]}
					master: {states: ["playing", "completed"], accepts: ["accept-play-complete"]}
					restart: {states: ["completed", "playing"], accepts: ["accept-play-complete"]}
					delete: {states: ["playing", "playing"], accepts: ["accept-delete-card"]}
					edit: {states: ["playing", "playing"], accepts: ["accept-edit-card"]}
				}
			}
			print: {
                files: shared: ["shell/shared/chrome-ready.css", "shell/shared/chrome.css", "shell/shared/nav.css", "shell/shared/address-formats.css"]
				title:   "Print Studio"
				route:   "/print"
				label:   "nav_print"
				states:  ["ready"]
				hatches: ["window-print", "print-checkout"]
				paths: {
					layout: {states: ["ready", "ready"], accepts: ["accept-print-layout"]}
				}
			}
			about: {
				files: shared: ["shell/shared/chrome-ready.css", "shell/shared/chrome.css", "shell/shared/nav.css"]
				title:     "About"
				route:     "/about"
				label:     "nav_about"
				prerender: true
				states:    ["reading"]
				hatches:   ["window-print"]
			}
			// Landing pages for search ads, one per keyword theme: reached from an
			// ad, never from the strip.
			for name, title in {kids: "Picture Flashcards for Kids", teachers: "Classroom Flashcards", printed: "Printed Picture Cards"} {
				(name): {
					files: shared: ["shell/shared/chrome-ready.css", "shell/shared/chrome.css", "shell/shared/nav.css", "shell/shared/landing.css"]
					"title":   title
					route:     "/\(name)"
					strip:     false
					prerender: true
					states:    ["reading"]
				}
			}
		}
		handlers: {
			"generation-input": {ir: "handler-generation-input", of: "generate", src: "shell/handlers/generation-input.js", note: "freeze the form input for one Create request"}
			"value-is": {ir: "handler-value-is", of: "cards", src: "shell/handlers/value-is.js", note: "a chart's arrow for what a control holds, as typed"}
			"count-step": {ir: "handler-count-step", of: "generate", src: "shell/handlers/count-step.js", note: "the card count an arrow steps or the field takes typed, held to 1 to 20"}
			"legacy-generation-run": {ir: "handler-legacy-generation-run", of: "generate", src: "shell/handlers/legacy-generation-run.js", note: "adopt a confirmed run for a retained form"}
			"row-is": {ir: "handler-row-is", of: "generate", src: "shell/handlers/row-is.js", note: "a chart's always arrow for a column a fold wrote"}
			"tab-fill": {ir: "handler-tab-fill", of: "generate", src: "shell/handlers/tab-fill.js", note: "an unmodified Tab on an empty field takes its ghost value"}
			delivery_found: {of: "print", src: "shell/handlers/delivery_found.js", note: "a search answer still asked for becomes the list of places the screen offers"}
			delivery_pin: {of: "print", src: "shell/handlers/delivery_pin.js", note: "the map's or the reader's position becomes the draft's pin"}
			is_key: {of: "print", src: "shell/handlers/is_key.js", note: "a keydown guard: whether it carried the arrow's key"}
			delivery_address_q: {of: "print", src: "shell/handlers/delivery_address_q.js", note: "the postal fields as one question, taken when a field is committed"}
			delivery_submitted: {of: "print", src: "shell/handlers/delivery_submitted.js", note: "the free text, copied to the search question only when the reader submits it"}
			delivery_offers: {of: "print", src: "shell/handlers/delivery_offers.js", note: "the fold keeping the pin and street-address offers to where the draft's statements disagree"}
			delivery_accept: {of: "print", src: "shell/handlers/delivery_accept.js", note: "an offer the reader applies writes the pin or the postal fields it names, never the free text"}
			localize_content_cards: {ir: "handler-localize-content-cards", of: "cards", src: "shell/handlers/localize_content.js", note: "Derive tab-local labels from original content and the selected locale cache."}
			localize_content_generate: {ir: "handler-localize-content-generate", of: "generate", src: "shell/handlers/localize_content.js", note: "Derive tab-local labels from original content and the selected locale cache."}
			localize_content_explore: {ir: "handler-localize-content-explore", of: "explore", src: "shell/handlers/localize_content.js", note: "Derive tab-local labels from original content and the selected locale cache."}
			localize_content_deck: {ir: "handler-localize-content-deck", of: "deck", src: "shell/handlers/localize_content.js", note: "Derive tab-local labels from original content and the selected locale cache."}
			localize_content_card: {ir: "handler-localize-content-card", of: "card", src: "shell/handlers/localize_content.js", note: "Derive tab-local labels from original content and the selected locale cache."}
			localize_content_print: {ir: "handler-localize-content-print", of: "print", src: "shell/handlers/localize_content.js", note: "Derive tab-local labels from original content and the selected locale cache."}
		}
		design: (pronto.#DesignMd & {text: _designMd}).design
		flows: {}
	}

	meta: {
		name:        "snapcards"
		domain:      "snapcards.fun"
		ssrOrigin:   "https://\(domain)"
		description: "Cultural children's publishing & flashcard press."
		favicon: """
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
			  <title>Snapcards capybara</title>
			  <path d="M14 25C7 23 7 14 11 11C16 8 21 14 23 20M50 25C57 23 57 14 53 11C48 8 43 14 41 20" fill="#B97B3C" stroke="#66452D" stroke-width="3" stroke-linejoin="round"/>
			  <path d="M12 36C12 20 20 13 32 13S52 20 52 36L57 44C59 54 48 60 32 60S5 54 7 44Z" fill="#E5A744" stroke="#66452D" stroke-width="3" stroke-linejoin="round"/>
			  <path d="M17 22Q21 18 25 21M39 21Q43 18 47 22" stroke="#B67C35" stroke-width="2.5" stroke-linecap="round"/>
			  <ellipse cx="20" cy="30" rx="4" ry="6" fill="#FFE1A0"/>
			  <ellipse cx="44" cy="30" rx="4" ry="6" fill="#FFE1A0"/>
			  <ellipse cx="20.5" cy="30" rx="2.5" ry="4" fill="#2F2921"/>
			  <ellipse cx="43.5" cy="30" rx="2.5" ry="4" fill="#2F2921"/>
			  <circle cx="21" cy="28" r="1" fill="white"/>
			  <circle cx="44" cy="28" r="1" fill="white"/>
			  <path d="M21 41C21 34 25 32 32 32S43 34 43 41V47C43 54 21 54 21 47Z" fill="#D8B171"/>
			  <path d="M23 39C23 34 41 34 41 39L38 45H26Z" fill="#897044"/>
			  <ellipse cx="27" cy="40" rx="2" ry="3" transform="rotate(-25 27 40)" fill="#302B23"/>
			  <ellipse cx="37" cy="40" rx="2" ry="3" transform="rotate(25 37 40)" fill="#302B23"/>
			  <path d="M32 44V49M22 49Q27 54 32 49Q37 54 42 49" stroke="#503925" stroke-width="2.5" stroke-linecap="round"/>
			</svg>
			"""
		ir: {sha256: "8819c889b13ec2b9e9c46c93ac3c32d94dfec26a75f6eb1c09082c00e934f4af"}
		googleTag: {
			id:    "AW-11407991574"
			hosts: [domain, "www.\(domain)"]
			// Google Ads' "Sign-up (web)".
			conversions: signup: "BAXrCP28w78dEJbG4L8q"
		}
		// Brazil's readers are the press's own, and the LGPD asks their consent
		// for advertising cookies as Google's policy asks the EEA's.
		consent: policy: {url: "https://www.bonisoft3.com/privacy.html", version: "2026-11-22"}
		wellKnown: {
			"assetlinks.json": text: json.Marshal([
				{
					relation: [
						"delegate_permission/common.handle_all_urls",
						"delegate_permission/common.get_login_creds",
					]
					target: {
						namespace:    "android_app"
						package_name: "app.hosted.us_central1.flashcards__trash_362115.twa"
						sha256_cert_fingerprints: [
							"26:2F:A4:67:25:EA:40:FD:1E:31:13:37:E7:EE:5B:37:B9:7F:AF:1D:15:7D:C0:D8:56:DF:4E:A9:2A:76:35:AC",
						]
					}
				},
			])
			"apple-app-site-association": text: json.Marshal({
				applinks: {
					details: [
						{
							appIDs: ["fun.snapcards.app"]
							components: [
								{"/": "/*"},
							]
						},
					]
				}
				webcredentials: {
					apps: ["fun.snapcards.app"]
				}
			})
		}
		targets: ["cloudflare"]
		clocks: ["cloudflare"]
		i18n: {
			default: "pt"
			locales: {
				"pt": path: "pt"
				"es": path: "es"
				"en": path: "en"
				"he": path: "he"
				"zh": path: "zh"
				"hi": path: "hi"
			}
			catalogues: _catalogues
		}
		decisions: {
			"decision-delete-two-taps": {}
			"decision-card-redraw-sheet": {}
			"decision-card-description-locale": {}
			"decision-deck-title-details": {}
			"decision-generate-preview-binds-draft": {}
			"decision-generation-in-machines": {}
			"decision-draft-per-device": {}
			"decision-deck-owner": {}
			"decision-escape-hatches": {}
		}
		tests: {}
	}
}

// The faces chrome.css names (shell/shared/fonts/), served beside the sheet
// that reaches them by url().
_fontStatics: [for f in list.Concat([
	[for face in ["nunito", "dm-sans"] for subset in ["latin", "latin-ext"] for style in ["normal", "italic"] {"shell/shared/fonts/\(face)-\(subset)-wght-\(style).woff2"}],
	["shell/shared/fonts/noto-sans-devanagari-devanagari-wght-normal.woff2"],
]) {
	file:   f
	target: "/srv/\(f)"
	watch:  true
}]

cluster: (pronto.#DefaultCluster & {"code": code, statics: list.Concat([terminal.surface.statics, _fontStatics])}).out
terminal: (pronto.#DefaultTerminal & {"code": code}).out
loop: (pronto.#DefaultLoop & {"code": code, "cluster": cluster, "terminal": terminal}).out

cluster: surface: targets: {
	smollm3: bayt.healthcheck.http & {
		cmd: "builtin": null
		activate: ""
		"process-compose": activate: "mise x --"
		healthcheck: {
			port:         11434
			path:         "/api/tags"
			start_period: "30s"
		}
		expose: api: {port: 11434, env: "PORT"}
		entrypoint: {
			shell: "nu"
			do:    "if (($env.BAYT_LOCAL_MOCK_AI? | default '1') == '0') { if (which ollama | is-empty) { error make { msg: 'ollama not found on PATH' } }; with-env { OLLAMA_HOST: $'127.0.0.1:($env.PORT? | default \"11434\")' } { ^ollama serve } } else { let f = (($env.BAYT_LOCAL_WORK_DIR? | default $nu.temp-dir) | path join 'ollama-mock.ts'); open --raw .bayt/Dockerfile.smollm3 | lines | skip until {|l| $l =~ '^COPY <<.EOF. /srv/ollama.ts$' } | skip 1 | take until {|l| $l == 'EOF' } | str join (char nl) | save -f $f; with-env { HOST: '127.0.0.1' } { ^deno run --allow-net --allow-env $f } }"
			dockerfile: {shell: "sh", do: "deno run --allow-net --allow-env /srv/ollama.ts"}
		}
		dockerfile: {
			from: name: "denoland/deno:debian-2.9.7@sha256:fa335acdf6b72106eda2cb6a8cb5f4187e7630e357467489db4b2e7352d5e432"
			preamble: [
				"""
					COPY <<'EOF' /srv/ollama.ts
					type CardSpec = { word: string; emoji: string; subject_en: string; svg?: string };
					const CATALOG_CHEAP: Record<string, CardSpec[]> = {
					  danca: [
					    { word: "Balé", emoji: "🩰", subject_en: "A single pink satin ballet pointe shoe with ribbons on a plain white background" },
					    { word: "Forró", emoji: "🪗", subject_en: "A single traditional Brazilian accordion sanfona on a plain white background" },
					    { word: "Salsa", emoji: "💃", subject_en: "A single red ruffled salsa dance dress on a plain white background" },
					    { word: "Sapateado", emoji: "👞", subject_en: "A single glossy tap dance shoe with metal plates on a plain white background" },
					    { word: "Hip-Hop", emoji: "👟", subject_en: "A single colorful street dance high-top sneaker on a plain white background" },
					  ],
					  fazenda: [
					    { word: "Vaca", emoji: "🐄", subject_en: "A single friendly dairy cow on a plain white background" },
					    { word: "Cavalo", emoji: "🐎", subject_en: "A single brown farm horse on a plain white background" },
					    { word: "Porco", emoji: "🐖", subject_en: "A single pink farm pig on a plain white background" },
					    { word: "Galinha", emoji: "🐓", subject_en: "A single farm hen with red comb on a plain white background" },
					    { word: "Ovelha", emoji: "🐑", subject_en: "A single fluffy white farm sheep on a plain white background" },
					  ],
					  quadrinho: [
					    { word: "Gibi", emoji: "📕", subject_en: "A single colorful comic book on a plain white background" },
					    { word: "Tirinha", emoji: "📰", subject_en: "A single three-panel comic strip on a plain white background" },
					    { word: "Balão", emoji: "💬", subject_en: "A single comic speech bubble on a plain white background" },
					    { word: "Quadrinho", emoji: "🖼️", subject_en: "A single framed comic panel illustration on a plain white background" },
					    { word: "Herói", emoji: "🦸", subject_en: "A single friendly caped superhero character on a plain white background" },
					  ],
					  animais: [
					    { word: "Leão", emoji: "🦁", subject_en: "A single golden lion with mane on a plain white background" },
					    { word: "Elefante", emoji: "🐘", subject_en: "A single gray elephant with trunk on a plain white background" },
					    { word: "Girafa", emoji: "🦒", subject_en: "A single spotted giraffe with long neck on a plain white background" },
					    { word: "Zebra", emoji: "🦓", subject_en: "A single black and white striped zebra on a plain white background" },
					    { word: "Tigre", emoji: "🐅", subject_en: "A single orange striped tiger on a plain white background" },
					  ],
					  frutas: [
					    { word: "Manga", emoji: "🥭", subject_en: "A single ripe yellow and orange mango fruit on a plain white background" },
					    { word: "Abacaxi", emoji: "🍍", subject_en: "A single golden pineapple with green crown on a plain white background" },
					    { word: "Melancia", emoji: "🍉", subject_en: "A single red watermelon slice with green rind on a plain white background" },
					    { word: "Morango", emoji: "🍓", subject_en: "A single bright red strawberry with green leaves on a plain white background" },
					    { word: "Banana", emoji: "🍌", subject_en: "A single yellow banana fruit on a plain white background" },
					  ],
					  planeta: [
					    { word: "Sol", emoji: "☀️", subject_en: "A single glowing yellow sun sphere on a plain white background" },
					    { word: "Lua", emoji: "🌙", subject_en: "A single cratered silver moon sphere on a plain white background" },
					    { word: "Terra", emoji: "🌍", subject_en: "A single blue and green planet Earth globe on a plain white background" },
					    { word: "Marte", emoji: "🪐", subject_en: "A single rusty red planet Mars sphere on a plain white background" },
					    { word: "Estrela", emoji: "⭐", subject_en: "A single bright golden five-pointed star on a plain white background" },
					  ],
					  espacia: [
					    { word: "Foguete", emoji: "🚀", subject_en: "A single red and white space rocket ship on a plain white background" },
					    { word: "Satélite", emoji: "🛰️", subject_en: "A single orbital satellite with solar panels on a plain white background" },
					    { word: "Sonda", emoji: "🛸", subject_en: "A single robotic space probe with antenna dish on a plain white background" },
					    { word: "Módulo", emoji: "🌕", subject_en: "A single golden lunar lander module on a plain white background" },
					    { word: "Telescópio", emoji: "🔭", subject_en: "A single brass astronomical telescope on a tripod on a plain white background" },
					  ],
					  instrument: [
					    { word: "Violão", emoji: "🎸", subject_en: "A single wooden acoustic guitar on a plain white background" },
					    { word: "Piano", emoji: "🎹", subject_en: "A single black grand piano on a plain white background" },
					    { word: "Tambor", emoji: "🥁", subject_en: "A single wooden snare drum with drumsticks on a plain white background" },
					    { word: "Trompete", emoji: "🎺", subject_en: "A single shiny brass trumpet on a plain white background" },
					    { word: "Violino", emoji: "🎻", subject_en: "A single classic wooden violin with bow on a plain white background" },
					  ],
					  carro: [
					    { word: "Conversível", emoji: "🏎️", subject_en: "A single red convertible sports car on a plain white background" },
					    { word: "Cupê", emoji: "🚗", subject_en: "A single sleek silver coupe sports car on a plain white background" },
					    { word: "Limusine", emoji: "🚘", subject_en: "A single black luxury limousine car on a plain white background" },
					    { word: "Bólido", emoji: "🏁", subject_en: "A single aerodynamic formula racing car on a plain white background" },
					    { word: "Roadster", emoji: "🛞", subject_en: "A single vintage yellow roadster car on a plain white background" },
					  ],
					};
					const CATALOG_HEAVY: Record<string, CardSpec[]> = {
					  danca: [
					    { word: "Samba", emoji: "🥁", subject_en: "A single ornate Brazilian carnival samba tambourine pandeiro with colorful ribbons on a plain white background" },
					    { word: "Tango", emoji: "🌹", subject_en: "A single classic black felt tango fedora hat with a red rose on a plain white background" },
					    { word: "Flamenco", emoji: "🪭", subject_en: "A single red Spanish flamenco hand fan and wooden castanets on a plain white background" },
					    { word: "Frevo", emoji: "☂️", subject_en: "A single vibrant multicolored Brazilian frevo parasol umbrella on a plain white background" },
					    { word: "Capoeira", emoji: "🏹", subject_en: "A single traditional wooden berimbau musical bow with gourd resonator on a plain white background" },
					  ],
					  fazenda: [
					    { word: "Touro", emoji: "🐂", subject_en: "A single strong brown farm bull with horns on a plain white background" },
					    { word: "Égua", emoji: "🐴", subject_en: "A single chestnut mare horse on a plain white background" },
					    { word: "Cabra", emoji: "🐐", subject_en: "A single white mountain farm goat on a plain white background" },
					    { word: "Pato", emoji: "🦆", subject_en: "A single mallard farm duck with green head on a plain white background" },
					    { word: "Burro", emoji: "🫏", subject_en: "A single friendly gray farm donkey on a plain white background" },
					  ],
					  quadrinho: [
					    { word: "Mangá", emoji: "📖", subject_en: "A single illustrated Japanese manga book volume on a plain white background" },
					    { word: "Fanzine", emoji: "✂️", subject_en: "A single indie hand-stapled illustrated zine booklet on a plain white background" },
					    { word: "Onomatopeia", emoji: "💥", subject_en: "A single colorful comic burst star emblem on a plain white background" },
					    { word: "Nanquim", emoji: "🖋️", subject_en: "A single comic artist nib pen and black ink bottle on a plain white background" },
					    { word: "Almanaque", emoji: "📚", subject_en: "A single vintage illustrated comic almanac hardcover book on a plain white background" },
					  ],
					  animais: [
					    { word: "Onça-Pintada", emoji: "🐆", subject_en: "A single spotted jaguar big cat on a plain white background" },
					    { word: "Arara-Azul", emoji: "🦜", subject_en: "A single vibrant hyacinth macaw parrot on a plain white background" },
					    { word: "Tamanduá", emoji: "🐾", subject_en: "A single giant anteater mammal on a plain white background" },
					    { word: "Tucano", emoji: "🦤", subject_en: "A single colorful toucan bird with orange beak on a plain white background" },
					    { word: "Boto", emoji: "🐬", subject_en: "A single pink Amazon river dolphin on a plain white background" },
					  ],
					  frutas: [
					    { word: "Jabuticaba", emoji: "🍇", subject_en: "A single dark purple jabuticaba berry fruit on a plain white background" },
					    { word: "Caju", emoji: "🍎", subject_en: "A single yellow-orange tropical cashew fruit with nut on a plain white background" },
					    { word: "Pitanga", emoji: "🍒", subject_en: "A single ribbed red pitanga berry fruit on a plain white background" },
					    { word: "Açaí", emoji: "🫐", subject_en: "A single cluster of dark purple acai berries on a plain white background" },
					    { word: "Cupuaçu", emoji: "🥥", subject_en: "A single brown tropical cupuacu fruit pod on a plain white background" },
					  ],
					  planeta: [
					    { word: "Saturno", emoji: "🪐", subject_en: "A single golden ringed planet Saturn on a plain white background" },
					    { word: "Júpiter", emoji: "🟠", subject_en: "A single banded gas giant planet Jupiter on a plain white background" },
					    { word: "Netuno", emoji: "🔵", subject_en: "A single deep blue ice giant planet Neptune on a plain white background" },
					    { word: "Cometa", emoji: "☄️", subject_en: "A single glowing icy comet with tail on a plain white background" },
					    { word: "Galáxia", emoji: "🌌", subject_en: "A single spiral galaxy of stars on a plain white background" },
					  ],
					  espacia: [
					    { word: "Estação Espacial", emoji: "🛰️", subject_en: "A single modular orbital space station with solar wings on a plain white background" },
					    { word: "Rover", emoji: "🛞", subject_en: "A single six-wheeled Mars exploration rover vehicle on a plain white background" },
					    { word: "Cápsula", emoji: "🪂", subject_en: "A single conical crew reentry space capsule on a plain white background" },
					    { word: "Ônibus Espacial", emoji: "🚀", subject_en: "A single black and white winged space shuttle orbiter on a plain white background" },
					    { word: "Radiotelescópio", emoji: "📡", subject_en: "A single white parabolic radio telescope dish antenna on a plain white background" },
					  ],
					  instrument: [
					    { word: "Violoncelo", emoji: "🎻", subject_en: "A single carved wooden cello with bow on a plain white background" },
					    { word: "Harpa", emoji: "🎶", subject_en: "A single golden concert harp with strings on a plain white background" },
					    { word: "Saxofone", emoji: "🎷", subject_en: "A single curved brass saxophone on a plain white background" },
					    { word: "Pandeiro", emoji: "🥁", subject_en: "A single traditional Brazilian pandeiro tambourine on a plain white background" },
					    { word: "Sanfona", emoji: "🪗", subject_en: "A single red bellows accordion on a plain white background" },
					  ],
					  carro: [
					    { word: "Fórmula 1", emoji: "🏎️", subject_en: "A single open-wheel Formula 1 racing car on a plain white background" },
					    { word: "Off-Road", emoji: "🚙", subject_en: "A single rugged 4x4 off-road expedition vehicle on a plain white background" },
					    { word: "Calhambeque", emoji: "🚗", subject_en: "A single brass-era antique vintage automobile on a plain white background" },
					    { word: "Hipercarro", emoji: "🏁", subject_en: "A single futuristic carbon-fiber hypercar on a plain white background" },
					    { word: "Elétrico", emoji: "⚡", subject_en: "A single modern aerodynamic electric car on a plain white background" },
					  ],
					};
					const FACETS_CHEAP = ["Raiz", "Rito", "Arte", "Símbolo", "Festa"];
					const FACETS_HEAVY = ["Patrimônio", "Mestre", "Relíquia", "Emblema", "Obra-Prima"];
					const FACET_EMOJIS = ["🎭", "🌟", "🎨", "🏛️", "🌿"];
					function lookupCatalog(topic: string, count: number, isHeavy: boolean): CardSpec[] {
					  const t = topic.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
					  const cat = isHeavy ? CATALOG_HEAVY : CATALOG_CHEAP;
					  const facets = isHeavy ? FACETS_HEAVY : FACETS_CHEAP;
					  const base =
					    (t.includes("danca") || t.includes("dance") || t.includes("baile") || t.includes("ritmo") || t.includes("folclor")) ? cat.danca :
					    (t.includes("fazenda") || t.includes("farm") || t.includes("granja")) ? cat.fazenda :
					    (t.includes("quadrinho") || t.includes("revista")) ? cat.quadrinho :
					    t.includes("anima") ? cat.animais :
					    t.includes("fruta") ? cat.frutas :
					    t.includes("planeta") ? cat.planeta :
					    t.includes("espacia") ? cat.espacia :
					    (t.includes("instrument") || t.includes("orquestra") || t.includes("music")) ? cat.instrument :
					    t.includes("carro") ? cat.carro :
					    Array.from({ length: count }, (_, i) => ({
					      word: `${topic} · ${facets[i % facets.length]}`,
					      emoji: FACET_EMOJIS[i % FACET_EMOJIS.length],
					      subject_en: `A single ${topic} cultural emblem (${facets[i % facets.length]}) on a plain white background`,
					    }));
					  return Array.from({ length: count }, (_, i) => {
					    const item = base[i % base.length];
					    return { word: item.word.trim(), emoji: item.emoji, subject_en: item.subject_en, description: `Ilustração de ${item.word.trim()}.` };
					  });
					}
					Deno.serve({ hostname: Deno.env.get("HOST") ?? "0.0.0.0", port: Number(Deno.env.get("PORT") ?? "11434") }, async (req) => {
					  const url = new URL(req.url);
					  if (url.pathname === "/api/tags") {
					    return Response.json({ models: [{ name: "smollm3:latest" }] });
					  }
					  const raw = await req.text();
					  let text = raw;
					  let lastUserText = raw;
					  try {
					    const parsed = JSON.parse(raw);
					    if (Array.isArray(parsed?.messages)) {
					      const msgs = parsed.messages as { role?: string; content?: string }[];
					      text = msgs.map((m) => m?.content ?? "").join(" ");
					      const userMsgs = msgs.filter((m) => m?.role === "user");
					      lastUserText = String((userMsgs.at(-1) ?? msgs.at(-1))?.content ?? text);
					    }
					  } catch (_err) {
					    text = raw;
					    lastUserText = raw;
					  }
					  const isHeavy = text.includes("[TIER:HEAVY]");
					  // A deck titled "... lentos" keeps its text running for the acceptance driver's mid-generation cases.
					  if (/Topic: "[^"]*lentos"/i.test(lastUserText)) await new Promise((r) => setTimeout(r, 8000));
					  // illustrate-card's translation: the reader's own words come back as they went.
					  if (text.includes("Translate each value of this JSON object into English")) {
					    return Response.json({ message: { role: "assistant", content: lastUserText.trim() } });
					  }
					  await new Promise((r) => setTimeout(r, isHeavy ? 350 : 220));
					  const xlatPromptMatch = lastUserText.match(/Translate into\\s+[^(]*\\(([^)]+)\\):\\s*(.+)$/i);
					  if (xlatPromptMatch) {
					    const targetLoc = xlatPromptMatch[1].trim().toLowerCase();
					    const srcWords = xlatPromptMatch[2].split("|").map((w) => w.trim()).filter(Boolean);
					    const suffixMap: Record<string, string> = { pt: "PT", es: "ES", en: "EN", he: "HE", zh: "ZH" };
					    const tag = suffixMap[targetLoc] ?? targetLoc.toUpperCase();
					    const translated = srcWords.map((w) => w.replace(/\\s*\\([A-Z]{2}\\)$/i, "") + " (" + tag + ")");
					    return Response.json({ message: { role: "assistant", content: JSON.stringify({ cards: translated }) } });
					  }
					  const countMatch = lastUserText.match(/exactly\\s+(\\d+)\\s+/i) || text.match(/exactly\\s+(\\d+)\\s+/i);
					  const count = Math.max(1, Math.min(20, Number(countMatch?.[1] ?? 5)));
					  const topicMatch = lastUserText.match(/Topic:\\s*"([^"]+)"/i) || lastUserText.match(/topic:\\s*"?([^"\\n.]+)"?/i);
					  const topic = (topicMatch?.[1] ?? "Estudo").trim();
					  const cards = lookupCatalog(topic, count, isHeavy);
					  return Response.json({ message: { role: "assistant", content: JSON.stringify({ cards }) } });
					});
					EOF
					""",
			]
		}
		compose: networks: ["default", "airlock-egress"]
	}
	diffusion: bayt.healthcheck.http & {
		cmd: "builtin": null
		activate: ""
		"process-compose": activate: "mise x --"
		healthcheck: {
			port:         8000
			path:         "/v1/models"
			start_period: "60s"
		}
		expose: api: {port: 8000, env: "PORT"}
		entrypoint: {
			shell: "nu"
			do:    "if (($env.BAYT_LOCAL_MOCK_AI? | default '1') == '0') { if (which sd-server | is-empty) { error make { msg: 'sd-server not found on PATH' } }; ^sd-server --listen-ip 127.0.0.1 --listen-port ($env.PORT? | default '8000') -m models/sd-turbo-q8_0.gguf --cfg-scale 1.0 --steps 2 -W 256 -H 256 } else { let f = (($env.BAYT_LOCAL_WORK_DIR? | default $nu.temp-dir) | path join 'diffusion-mock.ts'); open --raw .bayt/Dockerfile.diffusion | lines | skip until {|l| $l =~ '^COPY <<.EOF. /srv/diffusion.ts$' } | skip 1 | take until {|l| $l == 'EOF' } | str join (char nl) | save -f $f; with-env { HOST: '127.0.0.1' } { ^deno run --allow-net --allow-env $f } }"
			dockerfile: {shell: "sh", do: "deno run --allow-net --allow-env /srv/diffusion.ts"}
		}
		dockerfile: {
			from: name: "denoland/deno:debian-2.9.7@sha256:fa335acdf6b72106eda2cb6a8cb5f4187e7630e357467489db4b2e7352d5e432"
			preamble: [
				"""
					COPY <<'EOF' /srv/diffusion.ts
					const CRC_TABLE = new Uint32Array(256);
					for (let n = 0; n < 256; n++) {
					  let c = n;
					  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
					  CRC_TABLE[n] = c >>> 0;
					}
					const crc32 = (buf: Uint8Array): number => {
					  let c = 0xffffffff;
					  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
					  return (c ^ 0xffffffff) >>> 0;
					};
					const u32be = (v: number): Uint8Array => new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
					const chunk = (type: string, data: Uint8Array): Uint8Array => {
					  const out = new Uint8Array(12 + data.length);
					  out.set(u32be(data.length), 0);
					  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
					  out.set(data, 8);
					  out.set(u32be(crc32(out.subarray(4, 8 + data.length))), 8 + data.length);
					  return out;
					};
					const renderSubjectPng = async (prompt: string): Promise<string> => {
					  const W = 96, H = 96;
					  const raw = new Uint8Array(H * (1 + W * 3));
					  let h = 2166136261 >>> 0;
					  for (let i = 0; i < prompt.length; i++) h = Math.imul(h ^ prompt.charCodeAt(i), 16777619) >>> 0;
					  const p = prompt.toLowerCase();
					  const pal: [number, number, number, number, number, number] =
					    p.includes("cow") || p.includes("vaca") ? [45, 55, 72, 226, 232, 240] :
					    p.includes("horse") || p.includes("cavalo") ? [146, 64, 14, 217, 119, 6] :
					    p.includes("pig") || p.includes("porco") ? [219, 39, 119, 244, 114, 182] :
					    p.includes("hen") || p.includes("chicken") || p.includes("galinha") ? [185, 28, 28, 245, 158, 11] :
					    p.includes("sheep") || p.includes("ovelha") ? [71, 85, 105, 203, 213, 225] :
					    p.includes("rocket") || p.includes("foguete") ? [220, 38, 38, 59, 130, 246] :
					    p.includes("satellite") || p.includes("satélite") ? [37, 99, 235, 147, 197, 253] :
					    p.includes("guitar") || p.includes("violão") || p.includes("violin") ? [180, 83, 9, 251, 191, 36] :
					    p.includes("piano") ? [30, 41, 59, 148, 163, 184] :
					    [40 + (h % 160), 50 + ((h >>> 8) % 150), 60 + ((h >>> 16) % 150), 120 + ((h >>> 4) % 110), 130 + ((h >>> 12) % 100), 140 + ((h >>> 20) % 100)];
					  const [r1, g1, b1, r2, g2, b2] = pal;
					  const mode = h % 4;
					  for (let y = 0; y < H; y++) {
					    const rowOff = y * (1 + W * 3);
					    raw[rowOff] = 0;
					    for (let x = 0; x < W; x++) {
					      const px = rowOff + 1 + x * 3;
					      const dx = (x - W / 2) / (W / 2);
					      const dy = (y - H / 2) / (H / 2);
					      const d2 = dx * dx + dy * dy;
					      let r = 255, g = 255, b = 255;
					      if (d2 < 0.72) {
					        const ring = Math.sin(Math.sqrt(d2) * (8 + (h % 5)) + (mode * 1.1));
					        const angle = Math.atan2(dy, dx);
					        const petal = Math.cos(angle * (3 + (h % 4))) * 0.25;
					        if (d2 < 0.28 + petal * 0.2) {
					          r = r1; g = g1; b = b1;
					        } else if (ring > 0) {
					          r = r2; g = g2; b = b2;
					        } else {
					          r = Math.round((r1 + 255 * 2) / 3);
					          g = Math.round((g1 + 255 * 2) / 3);
					          b = Math.round((b1 + 255 * 2) / 3);
					        }
					      }
					      raw[px] = r; raw[px + 1] = g; raw[px + 2] = b;
					    }
					  }
					  const cs = new CompressionStream("deflate");
					  const writer = cs.writable.getWriter();
					  writer.write(raw);
					  writer.close();
					  const idatData = new Uint8Array(await new Response(cs.readable).arrayBuffer());
					  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
					  const ihdr = new Uint8Array(13);
					  ihdr.set(u32be(W), 0);
					  ihdr.set(u32be(H), 4);
					  ihdr[8] = 8; ihdr[9] = 2;
					  const c1 = chunk("IHDR", ihdr);
					  const c2 = chunk("IDAT", idatData);
					  const c3 = chunk("IEND", new Uint8Array(0));
					  const png = new Uint8Array(sig.length + c1.length + c2.length + c3.length);
					  png.set(sig, 0);
					  png.set(c1, sig.length);
					  png.set(c2, sig.length + c1.length);
					  png.set(c3, sig.length + c1.length + c2.length);
					  let bin = "";
					  for (let i = 0; i < png.length; i++) bin += String.fromCharCode(png[i]);
					  return btoa(bin);
					};
					Deno.serve({ hostname: Deno.env.get("HOST") ?? "0.0.0.0", port: Number(Deno.env.get("PORT") ?? "8000") }, async (req) => {
					  const url = new URL(req.url);
					  if (url.pathname === "/v1/models" || url.pathname === "/health") {
					    return Response.json({ data: [{ id: "sd-turbo-q4_0" }, { id: "sd-turbo-q8_0" }] });
					  }
					  const raw = await req.text();
					  await new Promise((r) => setTimeout(r, 80));
					  if (raw.includes("NSFW")) {
					    return new Response("8007: Input prompt contains NSFW content.", { status: 400 });
					  }
					  const b64 = await renderSubjectPng(raw);
					  return Response.json({ data: [{ b64_json: b64 }] });
					});
					EOF
					""",
			]
		}
		compose: networks: ["default", "airlock-egress"]
	}
	tsbifrost: entrypoint: env: {
		AI_LOCAL_OLLAMA_HOST: {peer: "smollm3", port: "api", prefix: "http://"}
		AI_LOCAL_SDCPP_HOST:  {peer: "diffusion", port: "api", prefix: "http://"}
	}
	launch: compose: depends_on: {
		smollm3:   {condition: "service_healthy"}
		diffusion: {condition: "service_healthy"}
	}
}

loop: surface: sayYaml: say: launch: {
	platform: "compose"
	rulemap: {
		compose: {
			platform: "compose"
			priority: -1
			stop:     true
			cmds: [
				{do: "let san = (if ('.certs/localhost.pem' | path exists) { try { ^openssl x509 -in .certs/localhost.pem -noout -ext subjectAltName } catch { '' } } else { '' }); if (not ('.certs/localhost.pem' | path exists)) or (not ($san | str contains 'DNS:payments.localhost')) or (not ($san | str contains 'DNS:payments.caddy')) { mkdir .certs; mise exec -- mkcert -cert-file .certs/localhost.pem -key-file .certs/localhost-key.pem localhost payments.localhost caddy payments.caddy 127.0.0.1 ::1 }"},
				{use: "./tools.nu", do: distribution.#Project.launch},
			]
		}
		cloudflare: {
			platform: "cloudflare"
			priority: -1
			stop:     true
			cmds: [
				{do: "let san = (if ('.certs/localhost.pem' | path exists) { try { ^openssl x509 -in .certs/localhost.pem -noout -ext subjectAltName } catch { '' } } else { '' }); if (not ('.certs/localhost.pem' | path exists)) or (not ($san | str contains 'DNS:payments.localhost')) or (not ($san | str contains 'DNS:payments.caddy')) { mkdir .certs; mise exec -- mkcert -cert-file .certs/localhost.pem -key-file .certs/localhost-key.pem localhost payments.localhost caddy payments.caddy 127.0.0.1 ::1 }"},
				{use: "./tools.nu", do: "def --wrapped launch-edge [...args] { with-env { AI_PROVIDER: 'cloudflare' } { \(distribution.#Project.launch) ...$args } }; launch-edge"},
			]
		}
	}
}

loop: surface: checks: "unit": {
	verb: "test"
	cmds: ["\(pronto.#Platforms.rule); deno test \(_platformFlags) --allow-read tests/handlers.test.ts tests/delivery_handlers.test.ts tests/address_format.test.ts tests/acceptance-readiness.test.ts tests/localize_content.test.ts tests/smollm3-draft.test.ts tests/airlock-answers.test.ts tests/cortex.test.ts"]
	note: "each handler file is a value: evaluated, called with rows and an event, and its updates compared; the delivery handlers move only what an applied offer names"
}

build: (pronto.#DefaultBuild & {"code": code, "loop": loop, "cluster": cluster, "terminal": terminal}).out

build: checks: "acceptance": {
	browser: true
	srcs: ["tests/**", "messages/*.json"]
	cmds: [
		"SNAPCARDS_ACCEPTANCE_IN_CLUSTER=yes deno run --config tests/deno.json --no-lock --allow-all --unsafely-ignore-certificate-errors=caddy,localhost,mailpit,checkout-simulator,prodigi-simulator,cloudprinter-simulator tests/acceptance.ts .",
	]
	note: "walks the brief acceptance checklist against the running app via Playwright"
}

out: pronto.#emit & {"code": code, "cluster": cluster, "terminal": terminal, "loop": loop, "build": build}

_snapcardsRoot: {
	config: {
		id: "snapcards"
		meta: host: "omnishell"
		initial: "routing"
		on: {for screenName in ["cards", "generate", "explore", "deck", "card", "print", "about", "kids", "teachers", "printed"] {
			"route:\(screenName)": {target: ".\(screenName)", reenter: true}
		}}
		states: {
			routing: {}
			for screenName in ["cards", "generate", "explore", "deck", "card", "print", "about", "kids", "teachers", "printed"] {
				(screenName): {
					meta: screen: screenName
					if _rowActors[screenName+"Rows"] != _|_ {invoke: {src: screenName + "Rows"}}
					initial: "loading"
					states: {
						loading: {invoke: {src: "navigate", onDone: "ready", onError: "failed"}}
						ready: {}
						failed: {}
					}
				}
			}
		}
	}
	setup: actors: _rowActors & {
		for name, chart in _backendCharts {(name): {via: "mecha", lifetime: "row", machine: chart}}
		navigate: {via: "navigation"}
		create_set: {machine: "deck_press", via: "local", handler: "machines/create_set.js"}
		play_select: {machine: "deck_press", via: "local", handler: "machines/play_select.js"}
		play_next: {machine: "deck_press", via: "local", handler: "machines/play_next.js"}
		play_prev: {machine: "deck_press", via: "local", handler: "machines/play_prev.js"}
		play_master: {machine: "deck_press", via: "local", handler: "machines/play_master.js"}
		play_restart: {machine: "deck_press", via: "local", handler: "machines/play_restart.js"}
		print_select: {machine: "deck_press", via: "local", handler: "machines/print_select.js"}
	}
}
