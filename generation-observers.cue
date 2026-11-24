package snapcards

_backendCharts: DeckProgressMachine: {
	config: {
		id: "deck_progress", initial: "drafting"
		meta: _generationMeta & {entity: "DeckProgress", field: "status"}
		invoke: {src: "levels"}
		states: {for state, phases in _progressArrows {
			(state): on: {
				drafting: "drafting"
				for phase in phases {(phase): phase}
				"facts.progress": [
					{target: "drafting", guard: "newRun", actions: "rememberRun"},
					for phase in phases {{target: phase, guard: phase}},
				]
			}
		}}
	}
	setup: {
		actors: levels: {via: "query", event: "facts.progress", select: """
			SELECT n.set_id AS key, 'facts.progress' AS event, jsonb_build_object('run', n.run, 'level2', l2.status, 'level3', l3.status) AS payload
			FROM snapcards_newest_runs() n
			LEFT JOIN deck_level l2 ON l2.set_id = n.set_id AND l2.level = 2 AND l2.run = n.run
			LEFT JOIN deck_level l3 ON l3.set_id = n.set_id AND l3.level = 3 AND l3.run = n.run
			"""}
		guards: {
			newRun: sql: "NEW.run IS DISTINCT FROM cortex_payload->>'run'"
			for phase, condition in _progressConditions {(phase): sql: "NEW.run = cortex_payload->>'run' AND (\(condition))"}
		}
		actions: rememberRun: [{assign: run: {raw: "cortex_payload->>'run'"}}]
	}
}


_snapcardsRoot: setup: actors: {
	generationProgress: {
		via:     "observe"
		lifetime: "attachment"
		machine: "DeckProgressMachine"
		match: {id: "set_id", run: "run"}
		event: "signal:deck_progress."
	}
	legacyGenerationRun: {
		via: "observe"
		lifetime: "attachment"
		table: "deck_progress"
		field: "run"
		match: id: "set_id"
		event: "signal:legacy.run"
		suffix: false
	}
	legacyGenerationDeck: {
		via: "observe"
		lifetime: "attachment"
		table: "card_set"
		match: id: "set_id"
		missing: "signal:legacy.deck.removed"
	}
	generationDeck: {
		via:   "observe"
		lifetime: "attachment"
		table: "card_set"
		match: id: "set_id"
		require: ["run"]
		missing: "signal:deck.removed"
	}
}
