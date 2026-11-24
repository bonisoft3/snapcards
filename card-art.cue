package snapcards

import pronto "github.com/bonisoft3/pronto"

// Each card's picture at each level is a CardArt row whose machine invokes
// illustrate-card, so a refusal or a retry touches that card alone
// (docs/index.md#generation). The text effects fan the rows out
// (services/database/sql/017_card_art_fan_out.sql); the deck-level drain
// keeps DeckLevel's counts, which Cortex connects to progress and the form.
code: state: entities: {
	CardArt: {
		id: "0xe86b9564aeac909a"
		table:      "card_art"
		durability: "live"
		access: {scope: "public"}
		fields: [
			{ordinal: 1, name: "id", type: "string", pk: true, cel: "this.size() > 0"},
			{ordinal: 2, name: "card_id", type: "string", cel: "this.size() > 0"},
			{ordinal: 3, name: "set_id", type: "string", cel: "this.size() > 0"},
			// run-<n>: a deck generated again takes new ledger keys.
			{ordinal: 4, name: "run", type: "string", cel: "this.size() > 0"},
			{ordinal: 5, name: "level", type: "int32", cel: "this in [2, 3]"},
			{ordinal: 6, name: "position", type: "int32", cel: "this >= 1"},
			// The text level's English description and framing: the picture is now
			// drawn from the card's word and the reader's own text alone.
			{ordinal: 7, name: "subject", type: "string", retired: true},
			{ordinal: 8, name: "frame_percent", type: "int32", retired: true},
			{ordinal: 9, name: "status", type: "string", cel: "this in ['waiting', 'pending', 'drawn', 'failed', 'unknown']"},
			// Why a failed or unknown card has no art: the provider's refusal.
			{ordinal: 10, name: "detail", type: "string", cel: "this.size() >= 0"},
			// A reader's redraw: their description, in the deck's language,
			// which illustrate-card translates before drawing; empty draws the word alone.
			{ordinal: 11, name: "description", type: "string", default: "''", cel: "this.size() >= 0"},
			// How many redraws the row took: a redraw is a new key and a new seed.
			{ordinal: 12, name: "redraws", type: "int32", default: "0", cel: "this >= 0"},
		]
	}
	DeckLevel: {
		id: "0xf98ced57ed9a218d"
		table:      "deck_level"
		durability: "live"
		access: {scope: "public"}
		fields: [
			{ordinal: 1, name: "id", type: "string", pk: true, cel: "this.size() > 0"},
			{ordinal: 2, name: "set_id", type: "string", cel: "this.size() > 0"},
			{ordinal: 3, name: "level", type: "int32", cel: "this in [2, 3]"},
			// The newest run among the level's rows: a tab tells this run's
			// settled text from a deck generated before.
			{ordinal: 4, name: "run", type: "string", cel: "this.size() > 0"},
			{ordinal: 5, name: "total", type: "int32", cel: "this >= 0"},
			{ordinal: 6, name: "drawn", type: "int32", cel: "this >= 0"},
			{ordinal: 7, name: "failed", type: "int32", cel: "this >= 0"},
			{ordinal: 8, name: "unknown", type: "int32", cel: "this >= 0"},
			// Waiting for its level-2 sibling or for its image.
			{ordinal: 9, name: "pending", type: "int32", cel: "this >= 0"},
			{ordinal: 10, name: "status", type: "string", cel: "this in ['running', 'complete', 'partial', 'failed']"},
		]
	}
	// One progress row survives screen detachment; DeckProgressMachine joins
	// the levels and exposes its current phase to attached forms.
	DeckProgress: {
		id: "0x94c353ea699a649e"
		table:      "deck_progress"
		durability: "live"
		access: {scope: "public"}
		fields: [
			{ordinal: 1, name: "id", type: "string", pk: true, cel: "this.size() > 0"},
			// The newest run the progress is of: a deck generated again starts over.
			{ordinal: 2, name: "run", type: "string", cel: "this.size() > 0"},
			{ordinal: 3, name: "status", type: "string", cel: "this in ['drafting', 'drawing2', 'drawing23', 'drawn2_complete', 'drawn2_partial', 'drawn2_failed', 'drawing3_complete', 'drawing3_partial', 'drawing3_failed', 'done', 'partial', 'failed']"},
		]
	}
}

// The no-art frame a card shows once no level drew it and none still might.
_noArt: {
	op:    "update"
	table: "flashcard"
	values: back: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20256%20256%22%20width%3D%22256%22%20height%3D%22256%22%20data-tier%3D%22tier-none%22%3E%3Crect%20width%3D%22256%22%20height%3D%22256%22%20fill%3D%22%23FFFFFF%22%2F%3E%3Crect%20x%3D%2288%22%20y%3D%2280%22%20width%3D%2280%22%20height%3D%2264%22%20rx%3D%228%22%20fill%3D%22none%22%20stroke%3D%22%23A8A29E%22%20stroke-width%3D%223%22%2F%3E%3Ccircle%20cx%3D%22111%22%20cy%3D%22102%22%20r%3D%226%22%20fill%3D%22%23A8A29E%22%2F%3E%3Cpath%20d%3D%22M89%20135l24-22%2016%2014%2013-12%2025%2022%22%20fill%3D%22none%22%20stroke%3D%22%23A8A29E%22%20stroke-width%3D%223%22%2F%3E%3Cpath%20d%3D%22M80%20160L176%2064%22%20stroke%3D%22%23DC2626%22%20stroke-width%3D%224%22%20stroke-linecap%3D%22round%22%2F%3E%3C%2Fsvg%3E"
	rawWhere: """
		id = NEW.card_id
		  AND NOT EXISTS (SELECT 1 FROM card_art s WHERE s.card_id = NEW.card_id AND s.id <> NEW.id AND s.status IN ('waiting', 'pending', 'drawn'))
		  AND (NEW.level = 3 OR EXISTS (SELECT 1 FROM card_art s WHERE s.card_id = NEW.card_id AND s.level = 3))
		"""
}


code: state: effects: "illustrate-card": {
	key: ["id", "run", "redraws"]
	// The card's word and the deck's title, details and audience as the reader wrote them:
	// nothing a model wrote reaches the image model but the card's word itself.
	input: {
		level:        "NEW.level"
		position:     "NEW.position"
		description:  "NEW.description"
		redraws:      "NEW.redraws"
		word:         {raw: "(SELECT f.front FROM flashcard f WHERE f.id = NEW.card_id)"}
		title:        {raw: "(SELECT s.name FROM card_set s WHERE s.id = NEW.set_id)"}
		details:      {raw: "(SELECT s.details FROM card_set s WHERE s.id = NEW.set_id)"}
		audience_key: {raw: "(SELECT s.audience_key FROM card_set s WHERE s.id = NEW.set_id)"}
		audience:     {raw: "(SELECT s.audience FROM card_set s WHERE s.id = NEW.set_id)"}
	}
	sink: {
		ai:         "image"
		tier:       "heavy"
		idempotent: true
	}
	note: "tsbifrost AI gateway image synthesis is deterministic per (id, run, redraws) key: the level picks the tier, the position and the redraw the seed, and the reader's words are translated by the cheap text tier first"
}

code: state: drains: "deck-level": {
	// A deleted card leaves the counts, and its art rows go once settled.
	on: ["card_art", "flashcard"]
	call: "snapcards_count_art"
}

_fanOut: {name: "card-art-fan-out", call: "snapcards_fan_out_art"}
_advance: {name: "deck-advance", call: "snapcards_advance_decks"}

code: capabilities: hatches: "card-art-fan-out": {
	kind:  "sql"
	files: ["services/database/sql/017_card_art_fan_out.sql"]
	note:  "a text level's outcome becomes one CardArt row per card, and its words the cards' words; a relational effect writes one row"
}

code: capabilities: hatches: "deck-advance": {
	kind:  "sql"
	files: ["migrations/20261105_cortex_generation.sql"]
	note:  "the chart source adapter observes relational facts and dispatches events"
}

// --no-check: mecha-edge/src/dispatch.ts references Cloudflare Workers globals from mecha-edge's deno.json.
loop: surface: checks: "card-art": {
	verb: "test"
	cmds: ["\(pronto.#Platforms.rule); deno test \(_platformFlags) --no-check --allow-read --allow-env --allow-sys=homedir --allow-run=cue tests/card-art.test.ts tests/illustrate-card.test.ts"]
	note: "per-card art fans out, retries and refuses one card alone, and the deck settles from its levels' counts"
}
