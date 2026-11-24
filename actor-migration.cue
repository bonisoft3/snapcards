@extern(embed)

package snapcards

import pronto "github.com/bonisoft3/pronto"

_actorLocks: _ @embed(file="migrations/20261028_deck_press_actor_locks.sql", type=text)
_mechaEngines: _ @embed(file="migrations/20261105_mecha_engines.sql", type=text)
// The engine since a rule takes XState's one argument; 20261105 keeps the bytes
// a database ran.
_ruleArgumentEngines: _ @embed(file="migrations/20261113_rule_argument_engines.sql", type=text)
// The engine over the XState bundle that also exports transition() and
// raise(); 20261113 keeps the bytes a database ran.
_transitionEngines: _ @embed(file="migrations/20261120_transition_engines.sql", type=text)
// The engine over the runtime that leaves XState's timers to its host;
// 20261120 keeps the bytes a database ran.
_afterEngines: _ @embed(file="migrations/20261121_after_engines.sql", type=text)

code: state: migrations: "20261028_deck_press_actor_locks": operations: [{sql: up: _actorLocks}]
code: state: migrations: "20261105_mecha_engines": operations: [{sql: up: _mechaEngines}]
code: state: migrations: "20261113_rule_argument_engines": operations: [{sql: up: _ruleArgumentEngines}]
code: state: migrations: "20261120_transition_engines": operations: [{sql: up: _transitionEngines}]
code: state: migrations: "20261121_after_engines": operations: [{sql: up: _afterEngines}]

loop: surface: checks: "actor-migration": {
	verb: "test"
	cmds: ["\(pronto.#Platforms.rule); deno test \(_platformFlags) --unstable-raw-imports --allow-read tests/actor-migration.test.ts"]
	note: "the actor upgrades preserve the applied baseline digest, instances, members and receipts and install the current engine"
}
