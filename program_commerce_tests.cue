package snapcards

build: checks: commerce: {
	srcs: ["commerce/*.ts", "commerce/deno.json", "commerce/deno.lock", "effects/print-*.js"]
	cmds: [
		"deno check --config commerce/deno.json commerce/*.ts",
		"deno lint --config commerce/deno.json commerce/*.ts",
		"deno task --config commerce/deno.json test",
	]
	note: "Each print effect's handler against the simulators' own request handling, with no network."
}
