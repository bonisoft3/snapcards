import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

Deno.test("immutable cutover matches current compiled Cortex machine and source SQL", async () => {
  const { compileCortexSql } = await import("@bonisoft3/pronto/cortex-machine.ts");
  const { compileCortexSources } = await import("@bonisoft3/pronto/cortex-sources.ts");
  const app = fileURLToPath(new URL("../", import.meta.url));
  const pronto = fileURLToPath(import.meta.resolve("@bonisoft3/pronto/"));
  const cue = async (cwd: string, expression: string) => {
    const result = await new Deno.Command("cue", { args: ["export", ".", "-e", expression, "--out", "json"], cwd, stdout: "piped", stderr: "piped" }).output();
    assert.ok(result.success, new TextDecoder().decode(result.stderr));
    return JSON.parse(new TextDecoder().decode(result.stdout));
  };
  const input = JSON.parse(await Deno.readTextFile(new URL("../.pronto/check-inputs.json", import.meta.url)));
  const effects = await cue(app, "code.state.effects");
  const cutover = await Deno.readTextFile(new URL("../migrations/20261105_cortex_generation.sql", import.meta.url));
  // The provisioning reducers are restated since, with the origin of a write
  // on its event (20261113_origin_reducers, then 20261113_trigger_origin_reducers);
  // each earlier migration keeps what it ran.
  const snapshot = cutover + "\n" + await Deno.readTextFile(new URL("../migrations/20261113_trigger_origin_reducers.sql", import.meta.url));
  // The machines are restated since with a seed's restore, as the emitter
  // spells them now (20261121_seed_restore_machines).
  const restated = await Deno.readTextFile(new URL("../migrations/20261121_seed_restore_machines.sql", import.meta.url));
  // An entity added after the cutover ships its machine in the migration that
  // adds the entity, compiled from the program itself (20261106_print_order).
  const after = new Set(["PrintOrder"]);
  // The cutover's triggers take the job key's digest through the bounded
  // enqueue they are wrapped in (20261028, 20261105's tail, 20261113), where the
  // emitter now spells it in the call itself (mecha's airlock.job_key).
  const asCutover = (sql: string) => sql.replace(/job_key => airlock\.job_key\((.*?)\), max_attempts/g, "job_key => $1, max_attempts");
  for (const machine of Object.values(input.machines) as { entity: string }[]) {
    const entity = input.entities[machine.entity];
    if (!entity?.server || after.has(machine.entity)) continue;
    const expression = `(#mechaMachineSql & {machine: ${JSON.stringify(machine)}, entities: ${JSON.stringify(input.entities)}, effects: ${JSON.stringify(effects)}, runtime: false}).out`;
    const compiled = compileCortexSql(await cue(pronto, expression)).trim();
    assert.ok(restated.includes(compiled) || snapshot.includes(asCutover(compiled)), `cutover lacks the compiled ${machine.entity} machine`);
  }
  const sources = await cue(app, `{entities: code.state.entities, charts: [for _, c in code.state.cortex if c.config.meta != _|_ if c.config.meta.host != _|_ if c.config.meta.host == "mecha" if c.config.meta.migration == "019_deck_advance.sql" {config: c.config, setup: {actors: c.setup.actors, guards: c.setup.guards, actions: c.setup.actions}}]}`);
  assert.ok(snapshot.includes(compileCortexSources(sources.charts, sources.entities).trim()), "cutover lacks the compiled Cortex sources");
});
