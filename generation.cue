package snapcards

_generationMeta: {
	host:      "mecha"
	migration: "019_deck_advance.sql"
	function:  "snapcards_advance_decks"
	watch: ["CardSet", "Flashcard", "GenerationDraft", "CardArt", "DeckLevel", "CardTranslation", "DeckTranslation"]
}

// Accepted decks and device slots own the rows their durable charts address.
code: state: mecha: rows: {

	GenerationProvision: {
		name:   "GenerationProvision"
		entity: "GenerationDraft"
		on: insert: actions: [for tier in ["cheap", "heavy"] {
			effect: {
				op: "ensure", table: "generation_draft"
				values: {id: {raw: "split_part(NEW.id, ':', 1) || ':draft-\(tier)'"}, topic: "", category: "", locale: {raw: "NEW.locale"}, region: "", card_count: 0, status: "idle", set_id: "", details: ""}
			}
		}]
	}
	ProgressProvision: {
		name:   "ProgressProvision"
		entity: "CardSet"
		on: insert: actions: [
			{effect: {op: "ensure", table: "deck_progress", values: {id: {raw: "NEW.id"}, run: "run-0", status: "drafting"}}},
			{hatch: {name: "generation-slot-bootstrap", call: "snapcards_bootstrap_generation", args: [{raw: "NEW.device"}, {raw: "NEW.locale"}]}},
		]
	}
}

_candidateCondition: {
	cheap: "candidate->>'cover' = '🎨' AND (candidate->>'cards')::integer > 0 AND candidate->>'cards' = candidate->>'expected'"
	heavy: "(candidate->>'cards')::integer > 0"
}
_candidateChoice: {for tier, condition in _candidateCondition {
	(tier): """
		(SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
		 WHERE (\(condition)) AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
		   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
		   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
		 ORDER BY ordinal LIMIT 1)
		"""
}}

_backendCharts: GenerationMachine: {
	config: {
		id:      "generation"
		initial: "idle"
		meta: _generationMeta & {entity: "GenerationDraft", field: "status"}
		invoke: {src: "candidates"}
		states: {
			for state in ["idle", "done", "failed"] {
				(state): on: {
					"facts.text": [
						{target: "drafting", guard: "cheapReady", actions: "claimCheap"},
						{target: "illustrating", guard: "heavyReady", actions: "claimHeavy"},
					]
					start_draft:      "drafting"
					start_illustrate: "illustrating"
					if state == "idle" {finish_fast: "done", fail: "failed"}
					if state == "done" {reset: "idle", fail: "failed"}
					if state == "failed" {reset: "idle", complete: "done"}
				}
			}
			drafting: invoke: {src: "smollm3-draft", onDone: {target: "done", actions: "cheapDone"}, onError: {target: "failed", actions: "cheapFailed"}}
			illustrating: invoke: {src: "heavy-draft", onDone: {target: "done", actions: "heavyDone"}, onError: {target: "failed", actions: "heavyFailed"}}
		}
	}
	setup: {
		actors: candidates: {via: "query", event: "facts.text", select: """
			SELECT s.device || ':draft-' || tier.name AS key, 'facts.text' AS event,
			       jsonb_build_object('tier', tier.name, 'candidates', jsonb_agg(
			         jsonb_build_object('id', s.id, 'name', s.name, 'details', s.details, 'locale', s.locale,
			           'cover', s.cover_emoji, 'expected', s.count, 'cards', facts.cards, 'run', facts.run,
			           'region', CASE WHEN s.region = '' THEN 'run-' || facts.run ELSE s.region || ' :: run-' || facts.run END,
			           'has_art', EXISTS (SELECT 1 FROM card_art a WHERE a.set_id = s.id AND a.level = tier.level AND a.run = 'run-' || facts.run))
			         ORDER BY s.category DESC, s.id)) AS payload
			FROM card_set s CROSS JOIN (VALUES ('cheap', 2), ('heavy', 3)) AS tier(name, level)
			CROSS JOIN LATERAL (
			  SELECT count(*)::integer AS cards,
			         CASE WHEN tier.name = 'cheap' THEN max((regexp_match(f.hint, '(?:^|\\|)run-([0-9]+)(?:\\||$)'))[1]::integer)
			              ELSE (SELECT max(substring(a.run FROM 5)::integer) FROM card_art a WHERE a.set_id = s.id AND a.level = 2) END AS run
			  FROM flashcard f WHERE f.set_id = s.id
			) facts
			WHERE s.device <> ''
			GROUP BY s.device, tier.name, tier.level
			"""}
		guards: {
			cheapReady: sql: "cortex_payload->>'tier' = 'cheap' AND \(_candidateChoice.cheap) IS NOT NULL"
			heavyReady: sql: "cortex_payload->>'tier' = 'heavy' AND \(_candidateChoice.heavy) IS NOT NULL"
		}
		actions: {
			for tier, action in {cheap: "claimCheap", heavy: "claimHeavy"} {
				(action): [{assign: {
					topic: {raw: "(\(_candidateChoice[tier]))->>'name'"}, details: {raw: "(\(_candidateChoice[tier]))->>'details'"}, locale: {raw: "(\(_candidateChoice[tier]))->>'locale'"}
					region: {raw: "(\(_candidateChoice[tier]))->>'region'"}, card_count: {raw: "((\(_candidateChoice[tier]))->>'cards')::integer"}, set_id: {raw: "(\(_candidateChoice[tier]))->>'id'"}, category: ""
				}}]
			}
			for tier, level in {cheap: 2, heavy: 3} {
				"\(tier)Done": [{assign: category: {raw: "COALESCE(outcome->'data'->>'cards_json', NEW.category)"}}, {hatch: [_fanOut & {args: [{raw: "NEW.set_id"}, {raw: "NEW.region"}, level, {raw: "outcome"}]}, _advance]}]
				"\(tier)Failed": [{assign: category: {raw: "COALESCE(outcome->>'data', outcome->>'kind')"}}, {hatch: [_fanOut & {args: [{raw: "NEW.set_id"}, {raw: "NEW.region"}, level, {raw: "outcome"}]}, _advance]}]
			}
		}
	}
}

_backendCharts: CardArtMachine: {
	config: {
		id:      "card_art"
		initial: "waiting"
		meta: _generationMeta & {entity: "CardArt", field: "status"}
		invoke: {src: "artFacts"}
		states: {
			waiting: on: {
				"facts.art": [{target: "failed", guard: "missingWord", actions: "noArt"}, {target: "pending", guard: "canStart"}]
				start: "pending"
				refuse: {target: "failed", actions: "noArt"}
			}
			pending: invoke: {src: "illustrate-card", onDone: {target: "drawn", actions: "drawn"}, onError: [{target: "unknown", guard: "unknown", actions: "failed"}, {target: "failed", actions: "failed"}]}
			for state in ["drawn", "failed", "unknown"] {(state): on: restart: "waiting"}
		}
	}
	setup: {
		actors: artFacts: {via: "query", event: "facts.art", select: """
			SELECT a.id AS key, 'facts.art' AS event,
			  jsonb_build_object('detail', a.detail, 'previous_pending', EXISTS (
			    SELECT 1 FROM card_art previous WHERE previous.card_id = a.card_id AND previous.level = a.level - 1
			      AND previous.status IN ('waiting', 'pending'))) AS payload
			FROM card_art a
			"""}
		guards: {
			missingWord: sql: "cortex_payload->>'detail' <> ''"
			unknown: sql:     "outcome->>'kind' = 'unknown'"
			canStart: sql:    "cortex_payload->>'detail' = '' AND NOT (cortex_payload->>'previous_pending')::boolean"
		}
		actions: {
			noArt: [{effect: _noArt}]
			drawn: [{assign: detail: ""}, {effect: [{op: "update", table: "flashcard", values: back: {raw: "outcome->'data'->>'image'"}, rawWhere: "id = NEW.card_id"}]}]
			failed: [{assign: {detail: {raw: "COALESCE(outcome->>'data', outcome->>'kind')"}}}, {effect: _noArt}]
		}
	}
}

_backendCharts: CardRedrawMachine: {
	config: {
		id: "card_redraw", initial: "settled"
		meta: _generationMeta & {entity: "Flashcard", field: "redraw"}
		invoke: {src: "artFacts"}
		states: {
			settled: on: draw: {target: "drawing", guard: "canDraw", actions: "draw"}
			drawing: on: {settle: "settled", "facts.redraw": {target: "settled", guard: "settled"}}
		}
	}
	setup: {
		actors: artFacts: {via: "query", event: "facts.redraw", select: "SELECT a.card_id AS key, 'facts.redraw' AS event, jsonb_build_object('status', a.status) AS payload FROM card_art a WHERE a.level = 3"}
		guards: {
			canDraw: sql: "EXISTS (SELECT 1 FROM card_art a WHERE a.id = NEW.id || ':3' AND a.status IN ('drawn', 'failed', 'unknown'))"
			settled: sql: "cortex_payload->>'status' IN ('drawn', 'failed', 'unknown')"
		}
		actions: draw: [{effect: [{op: "update", table: "card_art", values: {status: "waiting", detail: "", description: {raw: "NEW.description"}, redraws: {raw: "redraws + 1"}}, rawWhere: "id = NEW.id || ':3' AND status IN ('drawn', 'failed', 'unknown')"}]}]
	}
}

_backendCharts: DeckLevelMachine: {
	config: {
		id: "deck_level", initial: "running"
		meta: _generationMeta & {entity: "DeckLevel", field: "status"}
		invoke: {src: "counts"}
		states: {
			running: on: {
				complete: "complete", short: "partial", fail: "failed"
				"facts.level": [{target: "complete", guard: "complete"}, {target: "failed", guard: "failed"}, {target: "partial", guard: "partial"}]
			}
			for state in ["complete", "partial", "failed"] {(state): on: {restart: "running", "facts.level": {target: "running", guard: "reopen"}}}
		}
	}
	setup: {
		actors: counts: {via: "query", event: "facts.level", select: "SELECT id AS key, 'facts.level' AS event, jsonb_build_object('pending', pending, 'drawn', drawn, 'total', total) AS payload FROM deck_level"}
		guards: {
			complete: sql: "(cortex_payload->>'pending')::integer = 0 AND (cortex_payload->>'drawn')::integer = (cortex_payload->>'total')::integer"
			failed: sql:   "(cortex_payload->>'pending')::integer = 0 AND (cortex_payload->>'drawn')::integer = 0"
			partial: sql:  "(cortex_payload->>'pending')::integer = 0 AND (cortex_payload->>'drawn')::integer > 0 AND (cortex_payload->>'drawn')::integer < (cortex_payload->>'total')::integer"
			reopen: sql: """
				(cortex_payload->>'pending')::integer > 0 OR (NEW.status = 'complete' AND (cortex_payload->>'drawn')::integer < (cortex_payload->>'total')::integer)
				OR (NEW.status = 'failed' AND (cortex_payload->>'drawn')::integer > 0)
				OR (NEW.status = 'partial' AND ((cortex_payload->>'drawn')::integer = 0 OR (cortex_payload->>'drawn')::integer = (cortex_payload->>'total')::integer))
				"""
		}
		actions: {}
	}
}

_progressArrows: {
	drafting: ["drawing2", "drawing23", "drawn2_complete", "drawn2_partial", "drawn2_failed", "drawing3_complete", "drawing3_partial", "drawing3_failed", "done", "partial", "failed"]
	drawing2: ["drawing23", "drawn2_complete", "drawn2_partial", "drawn2_failed", "drawing3_complete", "drawing3_partial", "drawing3_failed", "done", "partial", "failed"]
	drawing23: ["drawing2", "drawn2_complete", "drawn2_partial", "drawn2_failed", "drawing3_complete", "drawing3_partial", "drawing3_failed", "done", "partial", "failed"]
	drawn2_complete: ["drawing3_complete", "done", "partial"]
	drawn2_partial: ["drawing3_partial", "partial"]
	drawn2_failed: ["drawing3_failed", "partial", "failed"]
	drawing3_complete: ["done", "partial", "drawn2_complete"]
	drawing3_partial: ["partial", "drawn2_partial"]
	drawing3_failed: ["partial", "failed", "drawn2_failed"]
	done: ["drawing3_complete", "partial"]
	partial: ["drawing3_complete", "drawing3_partial", "drawing3_failed", "done", "failed"]
	failed: ["drawing3_failed", "partial"]
}
_progressConditions: {
	drawing2:  "cortex_payload->>'level2' = 'running' AND cortex_payload->>'level3' IS NULL"
	drawing23: "cortex_payload->>'level2' = 'running' AND cortex_payload->>'level3' IS NOT NULL"
	done:      "cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' = 'complete'"
	failed:    "cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' = 'failed'"
	partial:   "cortex_payload->>'level2' IN ('complete', 'partial', 'failed') AND cortex_payload->>'level3' IN ('complete', 'partial', 'failed') AND NOT (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' = 'complete') AND NOT (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' = 'failed')"
	for outcome in ["complete", "partial", "failed"] {
		"drawn2_\(outcome)":   "cortex_payload->>'level2' = '\(outcome)' AND cortex_payload->>'level3' IS NULL"
		"drawing3_\(outcome)": "cortex_payload->>'level2' = '\(outcome)' AND cortex_payload->>'level3' = 'running'"
	}
}


code: capabilities: hatches: "generation-slot-bootstrap": {
	kind: "sql"
	files: ["services/database/sql/017_card_art_fan_out.sql"]
	note: "generated decks without device slots admit the first slot; its lifecycle ensures its sibling"
}
