import { fileURLToPath } from "node:url";
// Production's database ran print_order's own migration as release v0.21.0
// (b485b2a5d4) generated it, and the payments migration as v0.22.0 did. An edge
// release refuses changed text, so both stay those bytes, and what the order
// gained since reaches it, and every fresh database, by migrations after them.
import assert from "node:assert/strict";
import { browserTier } from "@bonisoft3/mecha/packages/mecha-browser/fence.ts";
import { createDatabase } from "@bonisoft3/mecha/packages/mecha-browser/src/database.ts";
import { applyScripts, digest, pgrollScripts, recordScripts, type Script } from "@bonisoft3/mecha/packages/pglite-workerd/scripts.ts";
import { releaseFiles } from "@bonisoft3/pronto/bundle/edge-scripts.ts";

const app = fileURLToPath(new URL("..", import.meta.url));
const mecha = fileURLToPath(import.meta.resolve("@bonisoft3/mecha/"));
const read = (path: string) => Deno.readTextFile(new URL(`../${path}`, import.meta.url));
const pgroll: Record<string, { operations: Record<string, unknown>[] }> = {};
for await (const file of Deno.readDir(new URL("../services/database/pgroll", import.meta.url))) {
  pgroll[file.name.replace(/\.json$/, "")] = JSON.parse(await read(`services/database/pgroll/${file.name}`));
}

Deno.test("the order's own migration is the released bytes", async () => {
  const kept = JSON.parse(await read("migrations/20261106_print_order.json"));
  assert.equal(await digest(kept.operations[0].sql.up), "a73b68c2e4a134fa8be101b3c42aa1d4bd8e80bc00a42f7a93ee5db0c28079d6");
  assert.deepEqual(pgroll["20261106_print_order"], kept);
  // Computed from the machine, the payments migration moved with the next change
  // to it, which production would have refused.
  const payments = JSON.parse(await read("migrations/20261106_print_order_payments.json"));
  assert.equal(await digest(payments.operations[0].sql.up), "045bf5009a2dad7e6cf1e2cf52e204f69be25c73e5b9ce676d0a745678eb01c3");
  assert.deepEqual(pgroll["20261106_print_order_payments"], payments);
  const file = JSON.parse(await read("migrations/20261107_print_order_file.json"));
  assert.equal(await digest(file.operations[0].sql.up), "e8ef626bd0ad14f7e63944e544691414d35201e44490775b2e9d6ac141b979da");
  assert.deepEqual(pgroll["20261107_print_order_file"], file);
  // The signals the order's new states reach are restated by the payments
  // migration, since the release's 802_signals.sql may not change either.
  assert.equal(await digest(await read("migrations/baseline/802_signals.sql")), "591d0514da22592c3d52c3f4e2b07a3b73da2607b22fa57763cf0391cace3151");
});

Deno.test("an edge database that ran v0.21.0 takes the order's later migrations alone, and a fresh one builds the same", async () => {
  const files = await releaseFiles(app, mecha, JSON.parse(await read("shell/shell.json")).migrations);
  const scripts = pgrollScripts(pgroll);
  const later = ["20261106_print_order_payments", "20261107_print_order_file"];
  // Releases carry their migrations in turn: a directory takes the order's two
  // before anything named after them (deck_cover, v0.25.0), as production did —
  // one carry of all three would be refused, the payments sorting before an
  // applied deck_cover (scripts.ts OutOfOrderScript).
  const after = scripts.filter((s) => s.name > later[1]).map((s) => s.name);
  const upTo = (name: string) => [...files, ...scripts.filter((s) => s.name <= name)];
  const released = scripts.filter((s) => !later.includes(s.name) && !after.includes(s.name));
  // As pgdata.ts builds a release's directory.
  const build = async (owed: Script[]) => {
    const db = await createDatabase({});
    for (const { sql } of files) await db.exec(browserTier(sql));
    for (const { sql } of owed) await db.exec(browserTier(sql!));
    await recordScripts(db, [...files, ...owed]);
    return db;
  };
  const shape = async (db: Awaited<ReturnType<typeof build>>) => ({
    columns: (await db.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'print_order' ORDER BY ordinal_position")).rows,
    states: (await db.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'print_order_status_check'")).rows,
    timer: (await db.query(`SELECT obj_description(to_regprocedure('"trg_print_order_status_timer_arm"()'), 'pg_proc') AS signature`)).rows,
    // 20261113_bounded_job_keys: every job keyed by the ledger key's digest,
    // spelled by the emitter (the order, restated) or by the bounded enqueue
    // the raw trigger is wrapped in (the card art), carried or built fresh.
    enqueue: (await db.query(`SELECT proname, position('graphile_worker.add_job(' IN prosrc) = 0 OR position('job_key => ''' IN prosrc) = 0 AS bounded
                                FROM pg_proc WHERE proname IN ('trg_print_order_status_machine', 'trg_card_art_status_machine') ORDER BY proname`)).rows,
  });
  const live = await build(released);
  const fresh = await build(scripts);
  try {
    // Production held an order awaiting payment when the re-check timer arrived,
    // and the timer's adoption refuses a timed row that has no deadline.
    const waiting = "7c1f0a7e-1d5e-4b8e-9a43-2f6a0c9e5b11";
    await live.exec(`SET session_replication_role = replica;
      INSERT INTO app_user (id, handle) VALUES ('${waiting}', 'waiting-order');
      INSERT INTO print_order (id, owner_id, status, title, stock, cards, country) VALUES ('${waiting}', '${waiting}', 'awaiting_payment', 'Deck', 'gloss', 3, 'BR');
      SET session_replication_role = origin;`);
    const [payments, file] = later;
    assert.deepEqual(await applyScripts(live, upTo(payments), () => {}), [payments]);
    const due = (await live.query(`SELECT count(*)::int AS n FROM schedule WHERE emits_values->'row'->>'id' = '${waiting}' AND due_at <= now()`)).rows[0] as { n: number };
    assert.equal(due.n, 1, "the order already waiting is owed its re-check now");
    // The file migration gives an order no print file, so it waits until none can
    // still be paid; one past the re-check horizon never can.
    await assert.rejects(applyScripts(live, upTo(file), () => {}), /in flight/);
    await live.exec(`SET session_replication_role = replica;
      UPDATE print_order SET created_at = now() - interval '28 hours' WHERE id = '${waiting}';
      SET session_replication_role = origin;`);
    assert.deepEqual(await applyScripts(live, upTo(file), () => {}), [file]);
    const preMinPages = after.filter((name) => name < "20261123_br_textbook_min_pages");
    assert.deepEqual(await applyScripts(live, upTo(preMinPages.at(-1)!), () => {}), preMinPages);
    const brInFlight10 = "10101010-1010-4010-8010-101010101010";
    const brQuoted10 = "20202020-2020-4020-8020-202020202020";
    const brQuoted12 = "30303030-3030-4030-8030-303030303030";
    const usQuoted5 = "40404040-4040-4040-8040-404040404040";
    await live.exec(`SET session_replication_role = replica;
      INSERT INTO print_order (id, owner_id, status, title, stock, cards, country, cover_file, opened_at) VALUES
        ('${brInFlight10}', '${waiting}', 'awaiting_payment', 'Deck', 'gloss', 10, 'BR', 'effects/cover.pdf', now() - interval '28 hours'),
        ('${brQuoted10}', '${waiting}', 'quoted', 'Deck', 'gloss', 10, 'BR', NULL, NULL),
        ('${brQuoted12}', '${waiting}', 'quoted', 'Deck', 'gloss', 12, 'BR', NULL, NULL),
        ('${usQuoted5}', '${waiting}', 'quoted', 'Deck', 'gloss', 5, 'US', NULL, NULL);
      SET session_replication_role = origin;`);
    await assert.rejects(applyScripts(live, [...files, ...scripts], () => {}), /pre-24-page quote or book PDF/);
    await live.exec(`SET session_replication_role = replica;
      UPDATE print_order SET status = 'unpaid', payment_state = 'expired' WHERE id = '${brInFlight10}';
      SET session_replication_role = origin;`);
    assert.deepEqual(await applyScripts(live, [...files, ...scripts], () => {}), after.filter((name) => name >= "20261123_br_textbook_min_pages"));
    const surviving = (await live.query(
      `SELECT id FROM print_order WHERE id IN ('${brInFlight10}', '${brQuoted10}', '${brQuoted12}', '${usQuoted5}') ORDER BY id`,
    )).rows.map((r) => (r as { id: string }).id);
    assert.deepEqual(surviving, [brInFlight10, brQuoted12, usQuoted5]);
    const moved = await shape(live);
    assert.deepEqual(moved, await shape(fresh));
    assert.deepEqual(moved.columns.slice(-13).map((c) => (c as { column_name: string }).column_name), ["cost_shipping", "fx_quote", "fx_rates", "fx_brl", "opened_at", "print_file", "postal_code", "cover_file", "mail_message_id", "tracking_carrier", "tracking_number", "tracking_url", "shipped_at"]);
    for (const state of ["converting", "unpaid", "confirming", "quoting_br", "placing_br", "placed_br", "vendor_checking_br", "notifying_shipped"]) {
      assert.match((moved.states[0] as { def: string }).def, new RegExp(`'${state}'`));
    }
    const signal = (await live.query("SELECT prosrc FROM pg_proc WHERE proname = 'signal'")).rows[0] as { prosrc: string };
    assert.match(signal.prosrc, /'converting'/, "a signal during the FX quote is a check in flight");
    for (const needle of ["'confirming'", "'quoting_br'", "'placing_br'", "'vendor_checking_br'", "'notifying_shipped'", "'cloudprinter'"]) {
      assert.match(signal.prosrc, new RegExp(needle));
    }
    // The stamp timer-check compares against the program's: a carried machine
    // that drifts from the emitter's text fails here, not at the cluster's gate.
    const [, signature] = /trg_print_order_status_timer_arm.{0,60}?IS DISTINCT FROM '+([0-9a-f]{64})/.exec(await read("bayt.json")) ?? [];
    assert.equal((moved.timer[0] as { signature: string | null }).signature, signature, "the re-check timer is the program's interpreter");
    assert.deepEqual(moved.enqueue, [{ proname: "trg_card_art_status_machine", bounded: true }, { proname: "trg_print_order_status_machine", bounded: true }], "jobs are keyed by the ledger key's digest");

    // Prodigi ships to the delivery's country at the quoted country's price: a
    // reader who quoted one and opened with another bought cheap shipping.
    const quoted = "8d2e1b0f-3c4a-4f6e-9b7d-1a2c3e4f5a6b";
    const artwork = JSON.stringify([`${"a".repeat(64)}.jpg`]);
    await fresh.exec(`SET session_replication_role = replica;
      INSERT INTO app_user (id, handle) VALUES ('${quoted}', 'quoted-order');
      INSERT INTO print_order (id, owner_id, status, title, stock, cards, country, total, currency) VALUES ('${quoted}', '${quoted}', 'quoted', 'Deck', 'gloss', 1, 'US', 1000, 'usd');
      SET session_replication_role = origin;`);
    const open = (country: string) => fresh.query(`UPDATE print_order SET status = 'opening', artwork = $1::json,
      delivery = json_build_object('address', json_build_object('country', $2::text)) WHERE id = '${quoted}'`, [artwork, country]);
    await assert.rejects(open("CN"), /ships to the country it was quoted for/);
    // Prodigi's line carries line2 and the district; cut short after payment, a
    // long pair lost the unit or the district the parcel needed.
    await assert.rejects(fresh.query(`UPDATE print_order SET status = 'opening', artwork = $1::json,
      delivery = json_build_object('address', json_build_object('country', 'US', 'line2', $2::text, 'district', $3::text)) WHERE id = '${quoted}'`, [artwork, "a".repeat(60), "b".repeat(39)]), /run past the lab's address line/);
    await open("US");
    const opened = (await fresh.query(`SELECT status, opened_at IS NOT NULL AS stamped FROM print_order WHERE id = '${quoted}'`)).rows[0];
    assert.deepEqual(opened, { status: "opening", stamped: true }, "the session's lifetime counts from here");

    // Domestic Brazil SEDEX varies by CEP zone and Correios requires a valid CPF.
    const quotedBr = "9e3f2c1a-4d5b-4a7f-8c6e-2b3d4f5a6b7c";
    await fresh.exec(`SET session_replication_role = replica;
      INSERT INTO print_order (id, owner_id, status, title, stock, cards, country, postal_code, total, currency)
        VALUES ('${quotedBr}', '${quoted}', 'quoted', 'Deck', 'gloss', 1, 'BR', '01305-100', 6634, 'brl');
      SET session_replication_role = origin;`);
    const openBr = (postalCode: string, taxId: string) => fresh.query(`UPDATE print_order SET status = 'opening', artwork = $1::json,
      delivery = json_build_object('address', json_build_object('country', 'BR', 'postalCode', $2::text, 'taxId', $3::text)) WHERE id = '${quotedBr}'`, [artwork, postalCode, taxId]);
    await assert.rejects(openBr("80010-000", "123.456.789-09"), /ships to the CEP it was quoted for/);
    await assert.rejects(openBr("01305-100", "111.111.111-11"), /valid recipient CPF/);
    await openBr("01305100", "123.456.789-09");
    const openedBr = (await fresh.query(`SELECT status, opened_at IS NOT NULL AS stamped FROM print_order WHERE id = '${quotedBr}'`)).rows[0];
    assert.deepEqual(openedBr, { status: "opening", stamped: true });

    // Public order tracking exposes non-PII status + carrier fields across devices while passing RLS audit.
    assert.deepEqual((await fresh.query("SELECT * FROM mecha.rls_audit() WHERE table_name = 'public.print_order_tracking'")).rows, []);
    const trackedId = "af4e3d2b-5e6c-4b8a-9d7f-3c4e5f6a7b8d";
    await fresh.exec(`SET session_replication_role = replica;
      INSERT INTO print_order (
        id, owner_id, status, title, stock, cards, country, postal_code, total, currency,
        delivery, vendor_order_id, vendor_state, tracking_carrier, tracking_number, tracking_url, paid_at, shipped_at
      ) VALUES (
        '${trackedId}', '${quoted}', 'placed_br', 'Animals', 'gloss', 12, 'BR', '01305-100', 6634, 'brl',
        '{"address":{"recipient":"Marina Silva","taxId":"123.456.789-09","line1":"Rua Augusta, 1508","city":"São Paulo","region":"SP","postalCode":"01305-100","country":"BR"},"contact":{"email":"marina@example.test","phone":"+55 11 99999-9999"}}'::json,
        'cp_ord_1', 'shipped', 'Correios SEDEX', 'BR123456789BR', 'https://rastreamento.correios.com.br/app/index.php?objetos=BR123456789BR', now(), now()
      );
      SET session_replication_role = origin;
      UPDATE print_order SET vendor_checks = vendor_checks WHERE id = '${trackedId}';`);
    const trackedRow = (await fresh.query(`SELECT status, destination, vendor_order_id, vendor_state, tracking_carrier, tracking_number, tracking_url, scope_id FROM print_order_tracking WHERE id = '${trackedId}'`)).rows[0];
    assert.deepEqual(trackedRow, {
      status: "placed_br",
      destination: "São Paulo - SP · BR",
      vendor_order_id: "cp_ord_1",
      vendor_state: "shipped",
      tracking_carrier: "Correios SEDEX",
      tracking_number: "BR123456789BR",
      tracking_url: "https://rastreamento.correios.com.br/app/index.php?objetos=BR123456789BR",
      scope_id: "public:",
    });
    const trackingCols = (await fresh.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'print_order_tracking'")).rows.map((r) => (r as { column_name: string }).column_name);
    for (const pii of ["delivery", "customer_email", "checkout_url", "session_id", "payment_intent"]) {
      assert.ok(!trackingCols.includes(pii), `print_order_tracking must not expose ${pii}`);
    }
  } finally {
    await live.close();
    await fresh.close();
  }
});
