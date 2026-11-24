import assert from "node:assert/strict";
import { withBrowser } from "@bonisoft3/omnishell/interpreter/smoke-browser.js";
import { FIXTURE_CARRIERS } from "@bonisoft3/omnishell/interpreter/fixture-types.js";

// The assertions below state a leaf's world and its event side by side; the
// leaf itself takes them as XState's one argument.
const positional = (leaf) => (state, event, ...rest) => leaf({ context: state, event }, ...rest);
// A composed handler's module is handed its machines as the second argument.
const composed = (leaf) => (state, event, machine, machines) => leaf({ context: state, event }, { machine, machines });

Deno.test({ name: "a restored accepted Create finishes the same deck without resetting progressed cards", sanitizeOps: false, sanitizeResources: false, async fn() {
  const create = composed((0, eval)(await Deno.readTextFile(new URL("../machines/create_set.js", import.meta.url))));
  await withBrowser({}, async (createStore) => {
    const serverTables = ["card_set", "flashcard"];
    const tabTables = ["generation_ask", "generation_form", "generation_draft", "device", "play_session", "print_config", "browser_draft", "me"];
    const config = (tables) => ({ local: Object.fromEntries(tables.map((name) => [name, "tab"])), carriers: FIXTURE_CARRIERS });
    const server = createStore("", config(serverTables));
    let tab = createStore("", config(tabTables));
    const seat = { type: "mutation", from: "generation-asks" };
    const device = "0123456789abcdef";
    const deck = "00000001-0000-4002-8000-000300000004";
    const write = async (u) => {
      const store = serverTables.includes(u.entity) ? server : tab;
      if (u.op === "delete") return store.drop(u.entity, [u.id]);
      if (u.op === "patch") return store.patch(u.entity, [{ key: u.id, changes: u.row }]);
      return store.write(u.entity, [{ key: u.id, row: u.row, absent: u.absent }]);
    };
    // The screens hand create_set this device's two slots, each read by its id.
    const slot = async (name) => tab.query("generation_draft", null, { filter: `id=eq.${device}:draft-${name}` });
    const world = async () => ({ locale: "en", rows: {
      ...Object.fromEntries(await Promise.all([...tabTables, ...serverTables].map(async (name) => [name, await (serverTables.includes(name) ? server : tab).query(name, null, {})]))),
      draft_cheap: await slot("cheap"),
      draft_heavy: await slot("heavy"),
    } });
    for (const [entity, row] of [
      ["generation_ask", { id: "ask", set_id: "", run: "", input: "" }],
      ["generation_form", { id: "draft", topic: "Original topic", card_count: 2, status: "generating", locale: "en-US", details: "Frozen details" }],
      ["device", { id: "device", key: device }],
      ["play_session", { id: "session", mastered: 0 }],
      ["print_config", { id: "config", set_id: "" }],
      ["generation_draft", { id: `${device}:draft-cheap`, region: "run-6", status: "idle" }],
    ]) await write({ op: "put", entity, id: row.id, row });
    const mint = create(await world(), seat);
    assert.equal(mint.then.type, "mint-deck");
    const accepted = create(await world(), { type: "mint-deck", uuid: deck, with: mint.then.with });
    assert.deepEqual(accepted.updates.map((u) => u.entity), ["generation_ask"]);
    await write(accepted.updates[0]);
    const claim = (await tab.query("generation_ask", null, {}))[0];
    assert.equal(claim.run, "run-7");
    assert.deepEqual(create({ ...await world(), ssr: true }, seat), { updates: [] });
    const mintReplay = create(await world(), { type: "mint-deck", uuid: "another-uuid", with: mint.then.with });
    assert.equal(mintReplay.updates.find((u) => u.entity === "card_set").id, deck);
    assert.equal(mintReplay.then.with.form.row.run, claim.run);
    const plan = create(await world(), accepted.then);
    assert.equal(plan.then.type, "complete-create");
    const firstCard = plan.updates.findIndex((u) => u.entity === "flashcard");
    for (const u of plan.updates.slice(0, firstCard + 1)) await write(u);
    const id = plan.updates[firstCard].id;
    await server.write("flashcard", [{ key: id, row: { front: "Finished words", back: "finished-art", emoji: "🎨", hint: "run-7" } }]);
    for (const checkpoint of ["partial", "completed-before-consumption"]) {
      const saved = await tab.tabSnapshot();
      tab.close();
      tab = createStore("", config(tabTables));
      tab.restoreTabs(saved);
      await tab.write("generation_form", [{ key: "draft", row: { topic: "Edited after recovery", card_count: 5 } }]);
      const resumed = create(await world(), seat);
      assert.equal(resumed.then.type, "complete-create", `${checkpoint} must not mint again`);
      for (const u of resumed.updates.filter((u) => u.entity !== "generation_ask")) await write(u);
      assert.equal((await server.query("card_set", null, {})).length, 1);
      const cards = await server.query("flashcard", "id.asc", {});
      assert.equal(cards.length, 2);
      assert.equal(cards[0].back, "finished-art");
      assert.equal(cards[0].front, "Finished words");
      assert.ok(cards.every((c) => c.hint === "run-7"));
      assert.equal((await server.query("card_set", null, {}))[0].name, "Original topic");
      assert.equal(resumed.then.with.form.row.run, "run-7");
    }
    const completion = create(await world(), seat);
    const capture = positional((0, eval)(await Deno.readTextFile(new URL("../shell/handlers/generation-input.js", import.meta.url))));
    const queued = [
      { id: "z-second-request", name: "Second request", created_at: "2026-11-03T12:00:01Z", deck: "second-deck" },
      { id: "a-third-request", name: "Third request", created_at: "2026-11-03T12:00:02Z", deck: "third-deck" },
    ];
    for (const request of queued) await tab.add("generation_ask", [{ id: request.id, created_at: request.created_at, set_id: "", run: "", input: capture({ items: [{ id: "draft", topic: request.name, card_count: 1, locale: "en-US" }] }) }]);
    const firstFinished = create(await world(), completion.then);
    assert.deepEqual(firstFinished.updates.map((u) => u.entity), ["generation_ask"], "an older completion cannot restore the form over a queued Create");
    for (const u of firstFinished.updates) await write(u);
    assert.deepEqual((await tab.query("generation_ask", null, {})).map((row) => row.id).sort(), queued.map((row) => row.id).sort());
    assert.deepEqual(create(await world(), { type: "mint-deck", uuid: deck, with: mint.then.with }).updates, [], "a late mint cannot claim the next request");
    for (const request of queued) {
      const nextMint = create(await world(), seat);
      assert.equal(nextMint.then.with.request, request.id, "queued Creates follow acceptance time, not UUID order");
      const nextClaim = create(await world(), { type: "mint-deck", uuid: request.deck, with: nextMint.then.with });
      assert.equal(nextClaim.updates[0].row.created_at, request.created_at);
      for (const u of nextClaim.updates) await write(u);
      const nextPlan = create(await world(), nextClaim.then);
      for (const u of nextPlan.updates) await write(u);
      for (const u of create(await world(), nextPlan.then).updates) await write(u);
    }
    assert.equal((await tab.query("generation_form", null, {}))[0].topic, "Third request");
    const decks = await server.query("card_set", "id.asc", {});
    assert.equal(decks.length, 3);
    assert.equal(decks.find((row) => row.id === "second-deck").name, "Second request");
    assert.equal(decks.find((row) => row.id === "second-deck").count, 1);
    assert.equal((await server.query("flashcard", null, { filter: `id=eq.${id}` }))[0].back, "finished-art");
    assert.deepEqual(create(await world(), seat).updates, []);
    await tab.add("generation_ask", [{ id: "fresh-request", set_id: "", run: "", input: "" }]);
    assert.equal(create(await world(), seat).then.type, "mint-deck", "a fresh ask ignores the previous form identity");
    tab.close();
    server.close();
  });
} });

Deno.test("a retained form only adopts a real run while it still lacks one", async () => {
  const guard = positional((0, eval)(await Deno.readTextFile(new URL("../shell/handlers/legacy-generation-run.js", import.meta.url))));
  const event = (value) => ({ type: "signal:legacy.run", value });
  assert.equal(guard({ items: [{ run: "" }] }, event("run-4")), true);
  assert.equal(guard({ items: [{ run: "" }] }, event("run-0")), false);
  assert.equal(guard({ items: [{ run: "" }] }, event("invalid")), false);
  assert.equal(guard({ items: [{ run: "run-5" }] }, event("run-4")), false);
});
