import { machineAttribute, screenMarkup } from "./screen-markup.js";
import assert from "node:assert/strict";
import { parseHTML } from "npm:linkedom@0.18.4";
import { withBrowser } from "@bonisoft3/omnishell/interpreter/smoke-browser.js";
import { FIXTURE_CARRIERS } from "@bonisoft3/omnishell/interpreter/fixture-types.js";

const shell = JSON.parse(await Deno.readTextFile(new URL("../shell/shell.json", import.meta.url)));
const markup = await screenMarkup("generate");
const chart = machineAttribute(markup.match(/id="generation-form"[^>]*data-machine='([^']+)'/)[1]);
const handlers = ["row-is", "tab-fill", "count-step", "generation-input", "legacy-generation-run"];
const sources = Object.fromEntries(await Promise.all(handlers.map(async (name) => [name, await Deno.readTextFile(new URL(`../shell/handlers/${name}.js`, import.meta.url))])));

for (const status of ["generating", "done", "partial", "failed"]) for (const scenario of ["completed", "deleted", "held", "cross-tab", "edit", "navigation"]) Deno.test({
  name: `a legacy ${status} device form reloads with ${scenario} deck`, sanitizeOps: false, sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { interpretScreen } = await import("@bonisoft3/omnishell/interpreter/screen.js");
    const old = { id: "draft", status, set_id: "old-deck", topic: "Retained" };
    await withBrowser({ storage: { "mecha:generation_form": { "s:draft": { versionKey: "v0", data: old } } } }, async (createStore) => {
      const store = createStore("", { carriers: FIXTURE_CARRIERS,
        local: { generation_form: "device", deck_progress: "tab", card_set: "tab", generation_ask: "tab" },
        optional: { generation_form: [{ name: "run", type: "text" }] },
      });
      assert.equal((await store.query("generation_form", null, {}))[0].run, "");
      if (scenario !== "deleted") {
        await store.write("card_set", [{ key: "old-deck", row: { id: "old-deck" } }]);
        await store.write("deck_progress", [{ key: "old-deck", row: { id: "old-deck", run: "run-4", status: "done" } }]);
      }
      let release, entered;
      const waiting = new Promise((resolve) => { entered = resolve; });
      const held = new Promise((resolve) => { release = resolve; });
      let block = ["held", "cross-tab", "edit", "navigation"].includes(scenario);
      let holdFormNotifications = false;
      const pendingFormNotifications = [];
      const base = { ...store, subscribe: (table, callback, opts) => store.subscribe(table, () => {
        if (table === "generation_form" && holdFormNotifications) pendingFormNotifications.push(callback);
        else callback();
      }, opts), query: async (table, order, opts) => {
        const rows = await store.query(table, order, opts);
        if (table === "deck_progress" && opts?.current && block) { block = false; entered(); await held; }
        return rows;
      } };
      const { document, Event } = parseHTML("<!doctype html><html><head></head><body><div id='shell'></div></body></html>");
      const oldDocument = globalThis.document;
      const oldFetch = globalThis.fetch;
      globalThis.document = document;
      const html = `<section class="screen" data-screen="generate"><button id="btn-create" data-live="generation_form" data-filter="id=eq.draft" data-reads="generation_form" data-machine='${JSON.stringify(chart)}'>Create</button></section>`;
      globalThis.fetch = (url) => {
        const path = String(url);
        if (path.endsWith("generate.html")) return Promise.resolve(new Response(html));
        if (path.endsWith("generate.css")) return Promise.resolve(new Response(""));
        const name = handlers.find((item) => path.endsWith(`${item}.js`));
        if (name) return Promise.resolve(new Response(sources[name]));
        throw new Error(`unexpected fetch ${path}`);
      };
      const route = { screen: "generate", files: { html: "generate.html", css: "generate.css", handlers: handlers.map((name) => `${name}.js`) }, states: ["populated"] };
      let screen;
      try {
        screen = await interpretScreen(document.getElementById("shell"), "http://localhost/", route, base, {}, { schema: shell.schema, actors: shell.actors });
        if (["held", "cross-tab", "edit", "navigation"].includes(scenario)) {
          await waiting;
          if (scenario === "cross-tab") holdFormNotifications = true;
          if (scenario === "held" || scenario === "cross-tab") {
            if (scenario === "held") {
              document.getElementById("btn-create").dispatchEvent(new Event("click"));
              for (let attempt = 0; attempt < 400 && (await store.query("generation_form", null, {}))[0].set_id; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
              assert.equal((await store.query("generation_form", null, {}))[0].set_id, "");
            }
            await store.write("card_set", [{ key: "new-deck", row: { id: "new-deck" } }]);
            await store.write("deck_progress", [{ key: "new-deck", row: { id: "new-deck", run: "run-5", status: "drafting" } }]);
            await store.write("generation_form", [{ key: "draft", row: { set_id: "new-deck", run: "run-5", status: "generating" } }]);
          }
          if (scenario === "edit") await store.write("generation_form", [{ key: "draft", row: { topic: "Edited" } }]);
          if (scenario === "navigation") screen.pause();
          release();
        }
        await screen.settle();
        holdFormNotifications = false;
        for (const callback of pendingFormNotifications) callback();
        const form = (await store.query("generation_form", null, {}))[0];
        if (scenario === "completed") assert.deepEqual([form.set_id, form.run, form.status], ["old-deck", "run-4", "done"]);
        if (scenario === "deleted") assert.deepEqual([form.set_id, form.run, form.status], ["", "", "idle"]);
        if (scenario === "held" || scenario === "cross-tab") assert.deepEqual([form.set_id, form.run, form.status], ["new-deck", "run-5", "generating"]);
        if (scenario === "edit") assert.deepEqual([form.topic, form.run, form.status], ["Edited", "run-4", "done"]);
        if (scenario === "navigation") {
          assert.equal(form.run, "");
          await screen.resume();
          await screen.settle();
          const resumed = (await store.query("generation_form", null, {}))[0];
          assert.deepEqual([resumed.run, resumed.status], ["run-4", "done"]);
        }
      } finally {
        release();
        screen?.stop();
        store.close();
        globalThis.document = oldDocument;
        globalThis.fetch = oldFetch;
      }
    });
  },
});
