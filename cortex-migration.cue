@extern(embed)
package snapcards

_cortexUpgrade: _ @embed(file="migrations/20261105_cortex_generation.sql", type=text)

code: state: migrations: "20261105_cortex_generation": operations: [{sql: up: _cortexUpgrade}]

// The provisioning reducers since a write's event names its origin; the
// cutover keeps the bytes a database ran.
_originReducers: _ @embed(file="migrations/20261113_origin_reducers.sql", type=text)

code: state: migrations: "20261113_origin_reducers": operations: [{sql: up: _originReducers}]

// The same reducers since a write another trigger makes has no origin.
_triggerOriginReducers: _ @embed(file="migrations/20261113_trigger_origin_reducers.sql", type=text)

code: state: migrations: "20261113_trigger_origin_reducers": operations: [{sql: up: _triggerOriginReducers}]

code: capabilities: hatches: "retained-rls-baseline": {
	kind: "sql"
	files: ["migrations/baseline/003_rls.sql"]
	note: "the original bootstrap bytes remain fixed for existing installations"
}

// The Cortex machines since a seed restores its row in the state it names.
_seedRestoreMachines: _ @embed(file="migrations/20261121_seed_restore_machines.sql", type=text)

code: state: migrations: "20261121_seed_restore_machines": operations: [{sql: up: _seedRestoreMachines}]
