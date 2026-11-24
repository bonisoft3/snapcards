package snapcards

import pronto "github.com/bonisoft3/pronto"

code: state: migrations: "20261028_bounded_effect_jobs": operations: [{sql: up: """
	CREATE FUNCTION airlock.snapcards_enqueue_job(identifier text, payload json, job_key text, max_attempts integer)
	RETURNS void LANGUAGE sql AS $fn$
	  SELECT graphile_worker.add_job(identifier, payload,
	    job_key => encode(sha256(convert_to(job_key, 'UTF8')), 'hex'),
	    max_attempts => max_attempts);
	$fn$;
	REVOKE ALL ON FUNCTION airlock.snapcards_enqueue_job(text, json, text, integer) FROM PUBLIC;
	DO $migration$
	DECLARE source text;
	BEGIN
	  source := pg_get_functiondef('public.trg_generation_draft_status_machine()'::regprocedure);
	  IF position('graphile_worker.add_job(' in source) = 0 THEN
	    RAISE EXCEPTION 'generation trigger has no effect enqueue call';
	  END IF;
	  EXECUTE replace(source, 'graphile_worker.add_job(', 'airlock.snapcards_enqueue_job(');
	END
	$migration$;
	"""}]

// Extends pronto.#Platforms.flags with mecha-edge's external imports (pglite-icu-full,
// graphile-worker) for tests that exercise the edge cluster or PGlite migrations.
_platformFlags: {
	let _url = "str replace --all '\\' '/' | str trim --left --char '/' | str replace --all ' ' '%20' | prepend 'file:///' | append"
	let _ext = "path join | open | get imports | transpose k v | where {|r| $r.v !~ '^\\.' } | transpose --header-row --as-record"
	out: "--no-config --import-map ([([$pronto deno.json] | \(_ext)) ([$mecha services compute deno.json] | \(_ext)) ([$mecha packages mecha-edge deno.json] | \(_ext)) ([$mecha packages mecha-browser cluster.deno.json] | \(_ext)) {'@bonisoft3/pronto/': ($pronto | \(_url) '/' | str join) '@bonisoft3/omnishell/': ($omnishell | \(_url) '/' | str join) '@bonisoft3/mecha/': ($mecha | \(_url) '/' | str join) '@mecha/compute/': ($mecha | \(_url) '/services/compute/' | str join) '@mecha/client/types': ($mecha | \(_url) '/services/compute/portable-contract.ts' | str join) '@mecha/incremental-views': ($mecha | \(_url) '/packages/incremental-views/runtime.ts' | str join) '@mecha/postgrest-js': ($mecha | \(_url) '/packages/postgrest-js/src/index.ts' | str join)}] | into record | {imports: $in} | to json --raw | url encode | prepend 'data:application/json,' | str join) --lock tests/deno.lock --frozen"
}.out

loop: surface: checks: "effect-queue": {
	verb: "test"
	cmds: [
		"\(pronto.#Platforms.rule); deno test \(_platformFlags) --allow-read --allow-env --allow-sys=homedir --allow-run=cue tests/effect-queue.test.ts tests/generation-lifecycle.test.ts tests/generation-recovery.test.js tests/cortex-upgrade.test.ts tests/cortex-snapshot-parity.test.ts tests/legacy-generation.test.js",
	]
	note: "generation provisions durable rows; translation starts and bounded effect keys retain committed revisions"
}
