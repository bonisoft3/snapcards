import { machineAttribute, screenMarkup } from "./screen-markup.js";
import assert from "node:assert/strict";

const inputs = JSON.parse(await Deno.readTextFile(new URL("../.pronto/check-inputs.json", import.meta.url)));
const shell = JSON.parse(await Deno.readTextFile(new URL("../shell/shell.json", import.meta.url)));
const markup = await screenMarkup("generate");
const chart = machineAttribute(markup.match(/id="generation-form"[^>]*data-machine='([^']+)'/)![1]);

Deno.test("every deck progress outcome reaches the attached generation form", () => {
  const progress = shell.actors.generationProgress;
  assert.deepEqual(progress.match, { id: "set_id", run: "run" });
  assert.equal(chart.states.idle.invoke, undefined);
  for (const name of ["generating", "done", "partial", "failed"]) {
    const state = chart.states[name];
    const invoked = Array.isArray(state.invoke) ? state.invoke : [state.invoke];
    assert.ok(invoked.some((actor: { src: string }) => actor?.src === "generationProgress"), `${name} detached its generation`);
    assert.ok(invoked.some((actor: { src: string }) => actor?.src === "legacyGenerationRun"), `${name} cannot recover an old run`);
    assert.ok(invoked.some((actor: { src: string }) => actor?.src === "legacyGenerationDeck"), `${name} cannot detect a deleted old deck`);
    for (const phase of Object.keys(inputs.machines.DeckProgressMachine.states)) {
      const event = progress.event + phase;
      assert.ok(state.on?.[event] ?? chart.on?.[event], `${name} cannot observe ${phase}`);
    }
  }
});

Deno.test("deletion follows only an accepted deck and Create belongs to its tab", () => {
  assert.deepEqual(shell.actors.generationDeck.match, { id: "set_id" });
  assert.deepEqual(shell.actors.generationDeck.require, ["run"]);
  assert.equal(shell.actors.generationDeck.missing, "signal:deck.removed");
  assert.deepEqual(shell.actors.legacyGenerationRun.match, { id: "set_id" });
  assert.equal(shell.actors.legacyGenerationRun.field, "run");
  assert.equal(shell.actors.legacyGenerationRun.suffix, false);
  assert.equal(shell.actors.legacyGenerationDeck.missing, "signal:legacy.deck.removed");
  assert.equal(shell.local.generation_ask, "tab");
  assert.match(markup, /id="generation-asks"[^>]*data-live="generation_ask"/);
  assert.match(markup, /id="generation-asks"[^>]*data-on-mutation="create_set"/);
});

Deno.test("print attachment retains the commerce and layout controls", async () => {
  const print = await screenMarkup("print");
  assert.match(print, /data-screen="print" data-commerce-mode="mock"/);
  const settings = machineAttribute(print.match(/class="print-container"[^>]*data-cortex="printRows"[^>]*data-machine='([^']+)'/)![1]);
  assert.deepEqual(settings.map((machine: { field: string }) => machine.field), ["vendor", "stock", "paper", "orientation", "card_size", "layout", "cut_lines"]);
  assert.match(print, /id="btn-order-print"[^>]*data-host-dom="print-checkout"/);
  assert.match(print, /data-hatch="delivery-map"/);
});
