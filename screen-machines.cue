@extern(embed)

package snapcards

import "strings"

// The reader's theme, on the device row every screen wraps: three buttons,
// one chart, the column CSS reads (shared/chrome.css).
_themeChart: {
	"field":   "theme"
	"initial": "auto"
	"states": {
		"auto": {"on": {"click@theme-light": "light", "click@theme-dark": "dark"}}
		"light": {"on": {"click@theme-auto": "auto", "click@theme-dark": "dark"}}
		"dark": {"on": {"click@theme-auto": "auto", "click@theme-light": "light"}}
	}
}

_rowActors: {
	// About holds no other machine; the theme chart is its one, over the device row.
	"aboutRows": {
		"via":      "rows"
		"screen":   "about"
		"lifetime": "attachment"
		"charts": {
			"theme": _themeChart
		}
	}
	"cardRows": {
		"via":      "rows"
		"screen":   "card"
		"lifetime": "attachment"
		"charts": {
			"theme": _themeChart
			"study": [
				{
					"field":   "status"
					"initial": "playing"
					"states": {
						"playing": {
							"on": {
								"click@btn-fullscreen-toggle": "fullscreen"
							}
							"always": [
								{
									"guard": {
										"type": "row-is"
										"params": {
											"finished": "yes"
										}
									}
									"target": "completed"
								},
							]
						}
						"fullscreen": {
							"on": {
								"click@btn-fullscreen-exit":   "playing"
								"click@btn-fullscreen-toggle": "playing"
							}
							"always": [
								{
									"guard": {
										"type": "row-is"
										"params": {
											"finished": "yes"
										}
									}
									"target": "completed"
								},
							]
						}
						"completed": {
							"always": [
								{
									"guard": {
										"type": "row-is"
										"params": {
											"finished": ""
										}
									}
									"target": "playing"
								},
							]
							"on": {
								"click@btn-restart": {
									"target": "playing"
									"assign": {
										"finished": ""
									}
								}
							}
						}
					}
				},
				{
					"field":   "flipped"
					"initial": "no"
					"states": {
						"no": {
							"on": {
								"click@card-flip-visual": "yes"
								"click@card-flip-prompt": "yes"
							}
						}
						"yes": {
							"on": {
								"click@card-flip-back":        "no"
								"click@card-flip-back-prompt": "no"
							}
						}
					}
				},
			]
			"deletion": {
				"field":   "state"
				"initial": "idle"
				"states": {
					"idle": {
						"on": {
							"click": "armed"
						}
					}
					"armed": {
						"after": {
							"4000": "idle"
						}
						"on": {
							"click": "confirmed"
						}
					}
					"confirmed": {}
				}
			}
		}
	}
	"cardsRows": {
		"via":      "rows"
		"screen":   "cards"
		"lifetime": "attachment"
		"charts": {
			"theme": _themeChart
			"library": {
				"field":   "status"
				"initial": "playing"
				"on": {
					"input@library-search": {
						"assign": {
							"library_query": {
								"type": "event"
								"params": {
									"field": "value"
								}
							}
						}
					}
					"change@library-search": {
						"assign": {
							"library_query": {
								"type": "event"
								"params": {
									"field": "value"
								}
							}
						}
					}
					"click@lbl-cat-all":     {"assign": {"library_query": ""}}
					"click@lbl-cat-animals": {"assign": {"library_query": ""}}
					"click@lbl-cat-fruits":  {"assign": {"library_query": ""}}
					"click@lbl-cat-words":   {"assign": {"library_query": ""}}
				}
				"states": {
					"playing": {
						"on": {}
						"always": [
							{
								"guard": {
									"type": "row-is"
									"params": {
										"finished": "yes"
									}
								}
								"target": "completed"
							},
						]
					}
					"completed": {
						"always": [
							{
								"guard": {
									"type": "row-is"
									"params": {
										"finished": ""
									}
								}
								"target": "playing"
							},
						]
						"on": {}
					}
				}
			}
		}
	}
	"exploreRows": {
		"via":      "rows"
		"screen":   "explore"
		"lifetime": "attachment"
		"charts": {
			"theme": _themeChart
			"study": [
				{
					"field":   "status"
					"initial": "playing"
					"states": {
						"playing": {
							"on": {
								"click@btn-fullscreen-toggle": "fullscreen"
							}
							"always": [
								{
									"guard": {
										"type": "row-is"
										"params": {
											"finished": "yes"
										}
									}
									"target": "completed"
								},
							]
						}
						"fullscreen": {
							"on": {
								"click@btn-fullscreen-exit":   "playing"
								"click@btn-fullscreen-toggle": "playing"
							}
							"always": [
								{
									"guard": {
										"type": "row-is"
										"params": {
											"finished": "yes"
										}
									}
									"target": "completed"
								},
							]
						}
						"completed": {
							"always": [
								{
									"guard": {
										"type": "row-is"
										"params": {
											"finished": ""
										}
									}
									"target": "playing"
								},
							]
							"on": {
								"click@btn-restart": {
									"target": "playing"
									"assign": {
										"finished": ""
									}
								}
							}
						}
					}
				},
				{
					"field":   "flipped"
					"initial": "no"
					"states": {
						"no": {
							"on": {
								"click@card-flip-visual": "yes"
								"click@card-flip-prompt": "yes"
							}
						}
						"yes": {
							"on": {
								"click@card-flip-back":        "no"
								"click@card-flip-back-prompt": "no"
							}
						}
					}
				},
			]
			"deletion": {
				"field":   "state"
				"initial": "idle"
				"states": {
					"idle": {
						"on": {
							"click": "armed"
						}
					}
					"armed": {
						"after": {
							"4000": "idle"
						}
						"on": {
							"click": "confirmed"
						}
					}
					"confirmed": {}
				}
			}
		}
	}
	"generateRows": {
		"via":      "rows"
		"screen":   "generate"
		"lifetime": "attachment"
		"charts": {
			"theme": _themeChart
			"account": {
				"field":   "status"
				"initial": "playing"
				"states": {
					"playing": {
						"on": {}
						"always": [
							{
								"guard": {
									"type": "row-is"
									"params": {
										"finished": "yes"
									}
								}
								"target": "completed"
							},
						]
					}
					"completed": {
						"always": [
							{
								"guard": {
									"type": "row-is"
									"params": {
										"finished": ""
									}
								}
								"target": "playing"
							},
						]
						"on": {}
					}
				}
			}
			"generation": {
				"field":   "status"
				"initial": "idle"
				"on": {
					"signal:legacy.run": {
						"guard": "legacy-generation-run"
						"assign": "run": {"type": "event", "params": "field": "value"}
					}
					"signal:legacy.deck.removed": {
						"guard": {"type": "row-is", "params": "run": ""}
						"target": "idle"
						"assign": {"set_id": "", "run": ""}
						"reenter": false
					}
					"input@topic-input": {
						"target": "idle"
						"assign": {
							"topic": {
								"type": "event"
								"params": {
									"field": "value"
								}
							}
							"category": ""
							"run":      ""
						}
					}
					"keydown@topic-input": {
						"target": "idle"
						"guard": {
							"type": "tab-fill"
							"params": {
								"key":   "Tab"
								"value": ""
							}
						}
						"assign": {
							"run": ""
						}
					}
					"input@details-input": {
						"assign": {
							"details": {
								"type": "event"
								"params": {
									"field": "value"
								}
							}
						}
						"raise": "edited"
					}
					"input@category-input": {
						"assign": {
							"category": {
								"type": "event"
								"params": {
									"field": "value"
								}
							}
						}
						"raise": "edited"
					}
					"input@locale-input": {
						"assign": {
							"locale": {
								"type": "event"
								"params": {
									"field": "value"
								}
							}
						}
						"raise": "edited"
					}
					"input@region-input": {
						"assign": {
							"region": {
								"type": "event"
								"params": {
									"field": "value"
								}
							}
						}
						"raise": "edited"
					}
					"input@difficulty-select": {
						"assign": {
							"audience": {
								"type": "event"
								"params": {
									"field": "value"
								}
							}
							"audience_key": ""
						}
						"raise": "edited"
					}
					"keydown@category-input": {
						"guard": {
							"type": "tab-fill"
							"params": {
								"key":   "Tab"
								"value": ""
							}
						}
						"raise": "edited"
					}
					"keydown@locale-input": {
						"guard": {
							"type": "tab-fill"
							"params": {
								"key":   "Tab"
								"value": ""
							}
						}
						"raise": "edited"
					}
					"keydown@region-input": {
						"guard": {
							"type": "tab-fill"
							"params": {
								"key":   "Tab"
								"value": ""
							}
						}
						"raise": "edited"
					}
					"keydown@difficulty-select": {
						"guard": {
							"type": "tab-fill"
							"params": {
								"key":   "Tab"
								"value": ""
							}
						}
						"raise": "edited"
					}
					"click@audience-toddler": {
						"assign": {
							"audience_key": "diff_toddler"
							"audience":     ""
						}
						"raise": "edited"
					}
					"click@audience-kids": {
						"assign": {
							"audience_key": "diff_kids"
							"audience":     ""
						}
						"raise": "edited"
					}
					"click@audience-teens": {
						"assign": {
							"audience_key": "diff_teens"
							"audience":     ""
						}
						"raise": "edited"
					}
					"click@locale-opt-pt": {
						"assign": {
							"locale": "Português"
						}
						"raise": "edited"
					}
					"click@locale-opt-es": {
						"assign": {
							"locale": "Español"
						}
						"raise": "edited"
					}
					"click@locale-opt-en": {
						"assign": {
							"locale": "English"
						}
						"raise": "edited"
					}
					"click@locale-opt-he": {
						"assign": {
							"locale": "עברית"
						}
						"raise": "edited"
					}
					"click@locale-opt-zh": {
						"assign": {
							"locale": "中文"
						}
						"raise": "edited"
					}
					"click@locale-opt-fr": {
						"assign": {
							"locale": "Français"
						}
						"raise": "edited"
					}
					"click@locale-opt-de": {
						"assign": {
							"locale": "Deutsch"
						}
						"raise": "edited"
					}
					"click@locale-opt-it": {
						"assign": {
							"locale": "Italiano"
						}
						"raise": "edited"
					}
					"click@locale-opt-ja": {
						"assign": {
							"locale": "日本語"
						}
						"raise": "edited"
					}
					"click@locale-opt-klingon": {
						"assign": {
							"locale": "Klingon"
						}
						"raise": "edited"
					}
					"click@count-pill-5": {
						"assign": {
							"card_count": 5
						}
						"raise": "edited"
					}
					"click@count-pill-10": {
						"assign": {
							"card_count": 10
						}
						"raise": "edited"
					}
					"click@count-pill-15": {
						"assign": {
							"card_count": 15
						}
						"raise": "edited"
					}
					"click@count-pill-20": {
						"assign": {
							"card_count": 20
						}
						"raise": "edited"
					}
					// The count an arrow steps or the field takes typed, held to 1 to 20 by
					// the handler; the presets above assign their literal. The field writes on
					// change, once a value is committed, not per keystroke: an edit lets a
					// running deck go, and a two-digit count is one edit.
					"click@count-minus": {
						"assign": {
							"card_count": {
								"type": "count-step"
								"params": {
									"delta": -1
								}
							}
						}
						"raise": "edited"
					}
					"click@count-plus": {
						"assign": {
							"card_count": {
								"type": "count-step"
								"params": {
									"delta": 1
								}
							}
						}
						"raise": "edited"
					}
					"change@card-count-input": {
						"assign": {
							"card_count": {
								"type": "count-step"
								"params": {
									"delta": 0
								}
							}
						}
						"raise": "edited"
					}
					"click@quick-animals": {
						"target": "idle"
						"assign": {
							"run": ""
						}
					}
					"click@quick-planets": {
						"target": "idle"
						"assign": {
							"run": ""
						}
					}
					"click@quick-fruits": {
						"target": "idle"
						"assign": {
							"run": ""
						}
					}
					"click@quick-home": {
						"target": "idle"
						"assign": {
							"run": ""
						}
					}
					"click@quick-letters": {
						"target": "idle"
						"assign": {
							"run": ""
						}
					}
					"click@draft-geo-city": {
						"target": "idle"
						"assign": {
							"run": ""
						}
					}
					"click@draft-loc-pt": {
						"target": "idle"
						"assign": {
							"run": ""
						}
					}
					"click@draft-loc-es": {
						"target": "idle"
						"assign": {
							"run": ""
						}
					}
					"click@draft-loc-en": {
						"target": "idle"
						"assign": {
							"run": ""
						}
					}
					"click@draft-loc-he": {
						"target": "idle"
						"assign": {
							"run": ""
						}
					}
					"click@draft-loc-zh": {
						"target": "idle"
						"assign": {
							"run": ""
						}
					}
					"click@draft-loc-fr": {
						"target": "idle"
						"assign": {
							"run": ""
						}
					}
					"click@draft-loc-de": {
						"target": "idle"
						"assign": {
							"run": ""
						}
					}
					"click@draft-loc-it": {
						"target": "idle"
						"assign": {
							"run": ""
						}
					}
					"click@draft-loc-ja": {
						"target": "idle"
						"assign": {
							"run": ""
						}
					}
				}
				"states": {
					"idle": {
						"on": {
							"click@btn-create": {
								"target": "generating"
								"assign": {
									"set_id": ""
									"run":    ""
								}
								"effect": {
									"op":     "create"
									"entity": "generation_ask"
									"values": {
										"set_id": ""
										"run":    ""
										"input": {
											"type": "generation-input"
										}
										"created_at": "{now}"
									}
								}
							}
							"signal:deck.removed": {
								"target": "idle"
								"assign": {
									"set_id": ""
									"run":    ""
								}
							}
						}
					}
					"generating": {
						"on": {
							"click@btn-create": {
								"target": "generating"
								"assign": {
									"set_id": ""
									"run":    ""
								}
								"effect": {
									"op":     "create"
									"entity": "generation_ask"
									"values": {
										"set_id": ""
										"run":    ""
										"input": {
											"type": "generation-input"
										}
										"created_at": "{now}"
									}
								}
							}
							"signal:deck.removed": {
								"target": "idle"
								"assign": {
									"set_id": ""
									"run":    ""
								}
								"reenter": false
							}
							"signal:deck_progress.drafting": {
								"target": "generating"
								"assign": {
									"next": 2
								}
								"reenter": false
							}
							"signal:deck_progress.drawing2": {
								"target": "generating"
								"assign": {
									"next":  3
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawing23": {
								"target": "generating"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawn2_complete": {
								"target": "generating"
								"assign": {
									"next":  3
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawn2_partial": {
								"target": "generating"
								"assign": {
									"next":  3
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawn2_failed": {
								"target": "generating"
								"assign": {
									"next":  3
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawing3_complete": {
								"target": "generating"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawing3_partial": {
								"target": "generating"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawing3_failed": {
								"target": "generating"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.done": {
								"target": "done"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.partial": {
								"target": "partial"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.failed": {
								"target": "failed"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
						}
						"invoke": [
							{"id": "legacy-run", "src": "legacyGenerationRun"},
							{"id": "legacy-deck", "src": "legacyGenerationDeck"},
							{
								"id":  "progress"
								"src": "generationProgress"
							},
							{
								"id":  "deck"
								"src": "generationDeck"
							},
						]
					}
					"done": {
						"on": {
							"click@btn-create": {
								"target": "generating"
								"assign": {
									"set_id": ""
									"run":    ""
								}
								"effect": {
									"op":     "create"
									"entity": "generation_ask"
									"values": {
										"set_id": ""
										"run":    ""
										"input": {
											"type": "generation-input"
										}
										"created_at": "{now}"
									}
								}
							}
							"edited": {
								"target": "idle"
								"assign": {
									"run": ""
								}
							}
							"signal:deck.removed": {
								"target": "idle"
								"assign": {
									"set_id": ""
									"run":    ""
								}
								"reenter": false
							}
							"signal:deck_progress.drafting": {
								"target": "generating"
								"assign": {
									"next": 2
								}
								"reenter": false
							}
							"signal:deck_progress.drawing2": {
								"target": "generating"
								"assign": {
									"next":  3
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawing23": {
								"target": "generating"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawn2_complete": {
								"target": "generating"
								"assign": {
									"next":  3
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawn2_partial": {
								"target": "generating"
								"assign": {
									"next":  3
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawn2_failed": {
								"target": "generating"
								"assign": {
									"next":  3
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawing3_complete": {
								"target": "generating"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawing3_partial": {
								"target": "generating"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawing3_failed": {
								"target": "generating"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.done": {
								"target": "done"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.partial": {
								"target": "partial"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.failed": {
								"target": "failed"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
						}
						"invoke": [
							{"id": "legacy-run", "src": "legacyGenerationRun"},
							{"id": "legacy-deck", "src": "legacyGenerationDeck"},
							{
								"id":  "progress"
								"src": "generationProgress"
							},
							{
								"id":  "deck"
								"src": "generationDeck"
							},
						]
					}
					"partial": {
						"on": {
							"click@btn-create": {
								"target": "generating"
								"assign": {
									"set_id": ""
									"run":    ""
								}
								"effect": {
									"op":     "create"
									"entity": "generation_ask"
									"values": {
										"set_id": ""
										"run":    ""
										"input": {
											"type": "generation-input"
										}
										"created_at": "{now}"
									}
								}
							}
							"edited": {
								"target": "idle"
								"assign": {
									"run": ""
								}
							}
							"signal:deck.removed": {
								"target": "idle"
								"assign": {
									"set_id": ""
									"run":    ""
								}
								"reenter": false
							}
							"signal:deck_progress.drafting": {
								"target": "generating"
								"assign": {
									"next": 2
								}
								"reenter": false
							}
							"signal:deck_progress.drawing2": {
								"target": "generating"
								"assign": {
									"next":  3
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawing23": {
								"target": "generating"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawn2_complete": {
								"target": "generating"
								"assign": {
									"next":  3
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawn2_partial": {
								"target": "generating"
								"assign": {
									"next":  3
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawn2_failed": {
								"target": "generating"
								"assign": {
									"next":  3
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawing3_complete": {
								"target": "generating"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawing3_partial": {
								"target": "generating"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawing3_failed": {
								"target": "generating"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.done": {
								"target": "done"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.partial": {
								"target": "partial"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.failed": {
								"target": "failed"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
						}
						"invoke": [
							{"id": "legacy-run", "src": "legacyGenerationRun"},
							{"id": "legacy-deck", "src": "legacyGenerationDeck"},
							{
								"id":  "progress"
								"src": "generationProgress"
							},
							{
								"id":  "deck"
								"src": "generationDeck"
							},
						]
					}
					"failed": {
						"on": {
							"click@btn-create": {
								"target": "generating"
								"assign": {
									"set_id": ""
									"run":    ""
								}
								"effect": {
									"op":     "create"
									"entity": "generation_ask"
									"values": {
										"set_id": ""
										"run":    ""
										"input": {
											"type": "generation-input"
										}
										"created_at": "{now}"
									}
								}
							}
							"edited": {
								"target": "idle"
								"assign": {
									"run": ""
								}
							}
							"signal:deck.removed": {
								"target": "idle"
								"assign": {
									"set_id": ""
									"run":    ""
								}
								"reenter": false
							}
							"signal:deck_progress.drafting": {
								"target": "generating"
								"assign": {
									"next": 2
								}
								"reenter": false
							}
							"signal:deck_progress.drawing2": {
								"target": "generating"
								"assign": {
									"next":  3
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawing23": {
								"target": "generating"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawn2_complete": {
								"target": "generating"
								"assign": {
									"next":  3
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawn2_partial": {
								"target": "generating"
								"assign": {
									"next":  3
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawn2_failed": {
								"target": "generating"
								"assign": {
									"next":  3
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawing3_complete": {
								"target": "generating"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawing3_partial": {
								"target": "generating"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.drawing3_failed": {
								"target": "generating"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.done": {
								"target": "done"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.partial": {
								"target": "partial"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
							"signal:deck_progress.failed": {
								"target": "failed"
								"assign": {
									"next":  0
									"words": "complete"
								}
								"reenter": false
							}
						}
						"invoke": [
							{"id": "legacy-run", "src": "legacyGenerationRun"},
							{"id": "legacy-deck", "src": "legacyGenerationDeck"},
							{
								"id":  "progress"
								"src": "generationProgress"
							},
							{
								"id":  "deck"
								"src": "generationDeck"
							},
						]
					}
				}
			}
			"collectionSelection": {
				"field":   "status"
				"initial": "playing"
				"on": {}
				"states": {
					"playing": {}
					"fullscreen": {}
					"completed": {}
				}
			}
			"preview": {
				"field":   "status"
				"initial": "idle"
				"on": {
					"click@btn-create-more": {
						"target": "idle"
						"assign": {
							"run": ""
						}
					}
				}
				"states": {
					"idle": {}
					"generating": {}
					"done": {}
					"partial": {}
					"failed": {}
				}
			}
		}
	}
	"printRows": {
		"via":      "rows"
		"screen":   "print"
		"lifetime": "attachment"
		"charts": {
			"theme": _themeChart
			"selection": {
				"field":   "status"
				"initial": "playing"
				"on": {
					"input@deck-search-input": {
						"assign": {
							"back": {
								"type": "event"
								"params": {
									"field": "value"
								}
							}
						}
					}
					"change@deck-search-input": {
						"assign": {
							"back": {
								"type": "event"
								"params": {
									"field": "value"
								}
							}
						}
					}
					"click@btn-window-print": {}
					"click@btn-print-trigger": {}
				}
				"states": {
					"playing": {
						"on": {}
						"always": [
							{
								"guard": {
									"type": "row-is"
									"params": {
										"finished": "yes"
									}
								}
								"target": "completed"
							},
						]
					}
					"completed": {
						"always": [
							{
								"guard": {
									"type": "row-is"
									"params": {
										"finished": ""
									}
								}
								"target": "playing"
							},
						]
						"on": {}
					}
				}
			}
			"settings": [
                {field: "vendor", initial: "print_at_home", states: {print_at_home: on: "click@btn-print-vendor": "print_shop", print_shop: on: "click@btn-print-vendor": "prodigi", prodigi: on: "click@btn-print-vendor": "print_at_home"}},
                {field: "stock", initial: "gloss", states: {gloss: on: "click@btn-print-stock": "mohawk", mohawk: on: "click@btn-print-stock": "gloss"}},
				{
					"field":   "paper"
					"initial": "a4"
					"states": {
						"a4": {
							"on": {
								"click@btn-print-paper": "letter"
							}
						}
						"letter": {
							"on": {
								"click@btn-print-paper": "a4"
							}
						}
					}
				},
				{
					"field":   "orientation"
					"initial": "portrait"
					"states": {
						"portrait": {
							"on": {
								"click@btn-print-orientation": "landscape"
							}
						}
						"landscape": {
							"on": {
								"click@btn-print-orientation": "portrait"
							}
						}
					}
				},
				{
					"field":   "card_size"
					"initial": "standard"
					"states": {
						"standard": {
							"on": {
								"click@btn-print-size": "jumbo"
							}
						}
						"jumbo": {
							"on": {
								"click@btn-print-size": "poster"
							}
						}
						"poster": {
							"on": {
								"click@btn-print-size": "mini"
							}
						}
						"mini": {
							"on": {
								"click@btn-print-size": "standard"
							}
						}
					}
				},
				{
					"field":   "layout"
					"initial": "fold"
					"states": {
						"fold": {
							"on": {
								"click@btn-print-grid": "duplex_h"
							}
						}
						"duplex_h": {
							"on": {
								"click@btn-print-grid": "duplex_v"
							}
						}
						"duplex_v": {
							"on": {
								"click@btn-print-grid": "2x2"
							}
						}
						"2x2": {
							"on": {
								"click@btn-print-grid": "3x3"
							}
						}
						"3x3": {
							"on": {
								"click@btn-print-grid": "fold"
							}
						}
					}
				},
				{
					"field":   "cut_lines"
					"initial": "yes"
					"states": {
						"yes": {
							"on": {
								"click@btn-print-lines": "no"
							}
						}
						"no": {
							"on": {
								"click@btn-print-lines": "yes"
							}
						}
					}
				},
			]
		}
	}
}

code: surface: screens: {
	card: files: html: "screens/card.html"
	cards: files: html: "screens/cards.html"
	explore: files: html: "screens/explore.html"
	generate: files: html: "screens/generate.html"
	print: files: html: "screens/print.html"
}

// The print screen's state lists and countries are written into its markup,
// which is served as it is; lint refuses markup that drifts from their sources.
_printMarkup: _ @embed(file="screens/print.html", type=text)
_addressFormats: _ @embed(file="commerce/address-formats.json", type=json)
_printStateLists: strings.Join([for c, f in _addressFormats.countries if len(f.states) > 0 {
	"<datalist id=\"delivery-states-\(c)\">" + strings.Join([for k, v in f.states {"<option value=\"\(k)\" label=\"\(strings.Replace(strings.Replace(v, "&", "&amp;", -1), "\"", "&quot;", -1))\"></option>"}], "") + "</datalist>"
}], "\n        ")
_printCountryOptions: strings.Join([for c in _printCountries {"<option value=\"\(c)\" data-text=\"{msg.country_\(c)}\"></option>"}], "\n                ")
_printMarkupHolds: true & strings.Contains(_printMarkup, _printStateLists) & strings.Contains(_printMarkup, _printCountryOptions)
