// Each print effect's handler against the simulators' own request handling, as
// the airlock would call it: a path, a body, and the headers the host adds.
import { strict as assert } from "node:assert";
import * as alertEffect from "../effects/print-alert.js";
import * as checkEffect from "../effects/print-check.js";
import * as confirmEffect from "../effects/print-confirm.js";
import * as fxEffect from "../effects/print-fx.js";
import * as placeBrEffect from "../effects/print-place-br.js";
import * as placeEffect from "../effects/print-place.js";
import * as quoteBrEffect from "../effects/print-quote-br.js";
import * as quoteEffect from "../effects/print-quote.js";
import * as recordEffect from "../effects/print-record.js";
import * as sessionEffect from "../effects/print-session.js";
import * as shippedEffect from "../effects/print-shipped.js";
import * as statusBrEffect from "../effects/print-status-br.js";
import * as statusEffect from "../effects/print-status.js";
import { flipDeck, md5Hex, postcard } from "./catalogue.ts";
import { createCloudprinterSimulator } from "./cloudprinter-simulator.ts";
import { createMailSimulator } from "./mail-simulator.ts";
import { createProdigiSimulator } from "./prodigi-simulator.ts";
import { createSimulator, fxRates } from "./simulator.ts";
import { currencyScale } from "./money.ts";
import { PDFDocument } from "@pdfme/pdf-lib";

import "./pdf-endowment.ts";
// The host's JSON body: bytes as base64 (mecha's reentry.ts encodedBody).
const json = (body: unknown) =>
	JSON.stringify(body, (_, v) => v instanceof Uint8Array ? btoa(String.fromCharCode(...v)) : v);

// deno-lint-ignore no-explicit-any
const handler = (module: { issue: unknown }) => module.issue as (...args: any[]) => Promise<any>;
const [alert, check, confirm, fx, placeBr, place, quoteBr, quote, record, session, shipped, statusBr, status] = [
	alertEffect,
	checkEffect,
	confirmEffect,
	fxEffect,
	placeBrEffect,
	placeEffect,
	quoteBrEffect,
	quoteEffect,
	recordEffect,
	sessionEffect,
	shippedEffect,
	statusBrEffect,
	statusEffect,
].map(handler);

type Fetcher = (req: Request) => Promise<Response> | Response;
const ORIGIN = "https://app.example";
// The deployment's publishable key, which the session carries to the page.
const KEYS = { STRIPE_PUBLISHABLE_KEY: "pk_test_deployment" };
function sinkOf(fetcher: Fetcher, headers: Record<string, string>, key: string, contentType = "application/json", blobs = new Map<string, Uint8Array>()) {
	return {
		key,
		origin: ORIGIN,
		blob: (k: string) => Promise.resolve(blobs.get(k) ?? Promise.reject(new Error(`no blob ${k}`))),
		async fetch(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
			const res = await fetcher(new Request(`http://sink${path}`, {
				method: init.method ?? "GET",
				headers: { ...init.headers, ...headers, "Idempotency-Key": key, ...(init.body === undefined ? {} : { "Content-Type": contentType }) },
				...(init.body === undefined ? {} : { body: typeof init.body === "string" ? init.body : json(init.body) }),
			}));
			const text = await res.text();
			return { status: res.status, body: (res.headers.get("content-type") ?? "").includes("json") ? JSON.parse(text) : text };
		},
	};
}
const ID = "11111111-1111-4111-8111-111111111111";

Deno.test("a quote is Prodigi's cheapest total and shipping, in USD alone", async () => {
	const prodigi = createProdigiSimulator({ apiKey: "k" });
	const answer = await quote(
		{ stock: "gloss", cards: 3, country: "BR", currency: "usd" },
		sinkOf(prodigi.fetch, { "X-API-Key": "k" }, "print-quote:1"),
	);
	assert.deepEqual(answer.done, { sku: postcard.skus.gloss, shipping_method: answer.done.shipping_method, shipping: 530, cost: 3 * 54 + 530 });
	const refused = await quote(
		{ stock: "gloss", cards: 3, country: "BR", currency: "brl" },
		sinkOf(prodigi.fetch, { "X-API-Key": "k" }, "print-quote:2"),
	);
	assert.ok(refused.failed, "Prodigi refuses BRL, and it is not converted");
});

// A handler imports nothing, so its scales are its own; one drifted from
// Stripe's would charge a hundred times too much or too little.
Deno.test("the price's scales are money.ts's for every currency an order is charged in", async () => {
	const source = await Deno.readTextFile(new URL("../effects/print-fx.js", import.meta.url));
	const table = Object.fromEntries([...source.matchAll(/(\w{3}): (\d+)n/g)].map((m) => [m[1], Number(m[2])]));
	for (const currency of ["brl", "ars", "ils", "usd", "gbp", "cny"]) assert.equal(table[currency], currencyScale(currency), currency);
});

Deno.test("a price marks up Prodigi's non-shipping cost at the reference rate in BRL, passes shipping through at cost, and charges elsewhere what Stripe pays out as that BRL", async () => {
	const stripe = createSimulator({ secretKey: "simulator", webhookSecret: "w", webhookUrl: "http://127.0.0.1:1/", checkoutOrigin: "http://checkout" });
	const sink = (key: string) => sinkOf(stripe.fetch, { Authorization: "Bearer simulator" }, key, "application/x-www-form-urlencoded");
	// 3 gloss cards to Brazil: Prodigi's $6.92 ($1.62 items + $5.30 shipping).
	const brl = await fx({ cost: 692, shipping: 530, currency: "brl", markup_percent: 80 }, sink("print-fx:1"));
	// (162 × 1.8 + 530) × 5.4012 = 4437.63 centavos; shipping 530 × 5.4012 = 2862.64.
	assert.deepEqual([brl.done.brl, brl.done.total, brl.done.shipping, brl.done.item], [4438, 4438, 2863, 1575]);
	assert.match(brl.done.quote, /^fxq_/);
	assert.deepEqual(Object.keys(brl.done.rates), ["usd"]);
	// High courier shipping ($118 DHL on $11 cards) never leaks shipping markup into the item line.
	const dhl = await fx({ cost: 12900, shipping: 11800, currency: "brl", markup_percent: 80 }, sink("print-fx:dhl"));
	assert.deepEqual([dhl.done.total, dhl.done.shipping, dhl.done.item], [74429, 63735, 10694]);
	const gbp = await fx({ cost: 692, shipping: 530, currency: "gbp", markup_percent: 80 }, sink("print-fx:2"));
	// 4438 / 6.954327 = 638.16 pence, which Stripe pays out as at least 4438 centavos.
	assert.deepEqual([gbp.done.brl, gbp.done.total, gbp.done.shipping, gbp.done.item], [4438, 639, 412, 227]);
	assert.ok(gbp.done.total * fxRates.gbp.exchange >= gbp.done.brl);
	assert.deepEqual(Object.keys(gbp.done.rates).sort(), ["gbp", "usd"]);
	const again = await fx({ cost: 692, shipping: 530, currency: "gbp", markup_percent: 80 }, sink("print-fx:2"));
	assert.equal(again.done.quote, gbp.done.quote, "a repeat of the key is the same quote");
	// ARS forbids lock_duration != "none" on Stripe; print-fx quotes with lock_duration=none.
	const ars = await fx({ cost: 2377, shipping: 1847, currency: "ars", markup_percent: 80 }, sink("print-fx:ars"));
	assert.ok(ars.done, JSON.stringify(ars));
	assert.ok(ars.done.total * fxRates.ars.exchange >= ars.done.brl);
});

Deno.test("a session is paid only by a read that matches the order, and a webhook names the row", async () => {
	const posted: { client_reference_id?: string }[] = [];
	const hook = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
		posted.push((await req.json()).data.object);
		return new Response("{}");
	});
	const stripe = createSimulator({
		secretKey: "simulator",
		webhookSecret: "whsec_simulator",
		webhookUrl: `http://127.0.0.1:${hook.addr.port}/signal/stripe`,
		checkoutOrigin: "http://checkout",
	});
	try {
		const card = await artwork();
		const sink = (key: string, type?: string) => sinkOf(stripe.fetch, { Authorization: "Bearer simulator" }, key, type, new Map([[card.key, card.bytes]]));
		const form = "application/x-www-form-urlencoded";
		const order = { id: ID, total: 6728, currency: "brl", title: "Deck", artwork: [card.key], opened_epoch: Math.floor(Date.now() / 1000) };
		const first = await session(order, sink(`print-session:${ID}`, form), KEYS);
		assert.ok(first.done, JSON.stringify(first));
		const made = first.done;
		assert.ok(made.url.startsWith("http://checkout/"));
		assert.equal(new URLSearchParams(new URL(made.url).hash.slice(1)).get("publishable_key"), "pk_test_deployment");
		// The print file goes with the session, so no order is paid that cannot be printed.
		assert.equal(made.file.$blob.type, "application/pdf");
		const pdf = await PDFDocument.load(made.file.$blob.bytes, { updateMetadata: false });
		assert.equal(pdf.getPageCount(), 2, "a page per face");
		assert.equal(Math.round(pdf.getPage(0).getWidth()), Math.round(postcard.panels.front.width * 72 / postcard.dpi));
		// An unreadable card opens no session.
		await assert.rejects(() => session({ ...order, id: crypto.randomUUID(), artwork: [`${"0".repeat(64)}.jpg`] }, sink("print-session:unreadable", form), KEYS), /no blob/);
		const again = await session(order, sink(`print-session:${ID}`, form), KEYS);
		assert.equal(again.done.id, made.id, "a repeat of the key is the same session");
		// The recipient's email, when the delivery states one, prefills Checkout.
		const stated = crypto.randomUUID();
		const prefilled = (await session({ ...order, id: stated, email: "recipient@example.test" }, sink(`print-session:${stated}`, form), KEYS)).done;
		const sessionOf = async (id: string) => (await sink("read").fetch(`/v1/checkout/sessions/${id}`, { headers: { "Stripe-Version": "2026-09-30.endive" } })).body;
		assert.equal((await sessionOf(prefilled.id)).customer_email, "recipient@example.test");
		assert.equal((await sessionOf(made.id)).customer_email, null);

		let reads = 0;
		const read = (over = {}) => check({ id: ID, session_id: made.id, total: 6728, currency: "brl", ...over }, sink(`print-check:${++reads}`));
		assert.deepEqual(await read(), { failed: { state: "open" } });
		const mismatch = await read({ total: 1 });
		assert.equal(mismatch.failed.state, "failed");
		assert.equal(mismatch.failed.reason, "mismatch");

		const paid = await stripe.fetch(new Request(`http://checkout/c/pay/${made.id}`, {
			method: "POST",
			headers: { "content-type": form },
			body: "email=buyer%40example.test&action=pay",
		}));
		await paid.body?.cancel();
		const answer = await read();
		assert.equal(answer.done.email, "buyer@example.test");
		assert.match(answer.done.payment_intent, /^pi_/);
		await stripe.settled();
		assert.equal(posted[0]?.client_reference_id, ID);

		// A Pix completes unpaid: the order waits, then pays once the bank settles,
		// or ends once the code lapses, since that session can never be paid.
		for (const [step, settles] of [["async_payment_succeeded", true], ["async_payment_failed", false]] as const) {
			const id = crypto.randomUUID();
			const pix = (await session({ ...order, id }, sink(`print-session:${id}`, form), KEYS)).done;
			const pixRead = () => check({ id, session_id: pix.id, total: 6728, currency: "brl" }, sink(`print-check:${++reads}`));
			const back = await stripe.fetch(new Request(`http://checkout/c/pay/${pix.id}`, {
				method: "POST",
				headers: { "content-type": form },
				body: "email=buyer%40example.test&action=pix",
			}));
			await back.body?.cancel();
			assert.deepEqual(await pixRead(), { failed: { state: "processing" } });
			await (await stripe.fetch(new Request(`http://checkout/_simulator/checkout/sessions/${pix.id}/${step}`, { method: "POST" }))).body?.cancel();
			const after = await pixRead();
			if (settles) assert.equal(after.done.email, "buyer@example.test");
			else assert.deepEqual(after, { failed: { state: "failed" } });
		}
	} finally {
		await hook.shutdown();
	}
});

// The frame header is all the lab reads of a file.
function jpeg(width: number, height: number) {
	return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);
}

Deno.test("placing is keyed by the ledger, and a callback's read says where it went", async () => {
	const door = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, () => new Response(jpeg(postcard.widthPx, postcard.heightPx), { headers: { "content-type": "image/jpeg" } }));
	const prodigi = createProdigiSimulator({ apiKey: "k", door: `http://127.0.0.1:${door.addr.port}` });
	try {
		const sink = (key: string) => sinkOf(prodigi.fetch, { "X-API-Key": "k" }, key);
		const input = {
			id: ID,
			artwork: ["a.jpg"],
			sku: postcard.skus.gloss,
			shipping_method: "Budget",
			email: null,
			delivery: { address: { recipient: "Buyer", line1: "Rua 1", line2: "", city: "São Paulo", region: "SP", postalCode: "01000-000", country: "BR" } },
		};
		const first = await place(input, sink(`print-place:${ID}`));
		const repeat = await place(input, sink(`print-place:${ID}`));
		assert.equal(repeat.done.id, first.done.id);
		// The recipient's phone and email reach the label; with none, the payer's email.
		const recipientOf = async (reference: string) =>
			(await (await prodigi.fetch(new Request(`http://prodigi/_simulator/orders?merchantReference=${reference}`))).json())[0].recipient;
		const none = await recipientOf(ID);
		assert.deepEqual([none.email, none.phoneNumber], [undefined, undefined]);
		const payer = crypto.randomUUID();
		await place({ ...input, id: payer, email: "payer@example.test", delivery: { ...input.delivery, contact: { phone: "", email: "" } } }, sink(`print-place:${payer}`));
		assert.deepEqual([(await recipientOf(payer)).email, (await recipientOf(payer)).phoneNumber], ["payer@example.test", undefined]);
		const stated = crypto.randomUUID();
		await place({ ...input, id: stated, email: "payer@example.test", delivery: { ...input.delivery, contact: { phone: "+55 11 99999-0000", email: "recipient@example.test" } } }, sink(`print-place:${stated}`));
		assert.deepEqual([(await recipientOf(stated)).email, (await recipientOf(stated)).phoneNumber], ["recipient@example.test", "+55 11 99999-0000"]);
		// A district rides on line2, which Prodigi has; an empty one adds nothing.
		const lineOf = async (line2: string, district: string) => {
			const id = crypto.randomUUID();
			await place({ ...input, id, delivery: { address: { ...input.delivery.address, line2, district } } }, sink(`print-place:${id}`));
			return (await recipientOf(id)).address.line2;
		};
		assert.equal(await lineOf("apto 12", "Consolação"), "apto 12, Consolação");
		assert.equal(await lineOf("", "Consolação"), "Consolação");
		assert.equal(await lineOf("apto 12", ""), "apto 12");
		assert.equal(await lineOf("", ""), undefined);
		const read = await status({ id: ID, vendor_order_id: first.done.id }, sink("print-status:1"));
		assert.ok(read.done.state);
		await (await prodigi.fetch(new Request(`http://prodigi/_simulator/orders/${first.done.id}/shipped`, { method: "POST" }))).body?.cancel();
		const shippedRead = await status({ id: ID, vendor_order_id: first.done.id }, sink("print-status:shipped"));
		assert.equal(shippedRead.done.state, "shipped");
		assert.equal(shippedRead.done.carrier, "Royal Mail · International Tracked");
		assert.match(shippedRead.done.tracking_number, /^RM[A-Z0-9]+GB$/);
		assert.match(shippedRead.done.tracking_url, /^https:\/\/www\.royalmail\.com\//);
		const stranger = await status({ id: "another", vendor_order_id: first.done.id }, sink("print-status:2"));
		assert.equal(stranger.failed.state, "mismatch");
	} finally {
		await prodigi.settled();
		await door.shutdown();
	}
});

// A whole JPEG of the print area's size, as the checkout stores each card.
async function artwork() {
	const canvas = new Uint8Array([
		0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, postcard.heightPx >> 8, postcard.heightPx & 255, postcard.widthPx >> 8, postcard.widthPx & 255, 3,
		1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9,
	]);
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", canvas));
	return { bytes: canvas, key: `${[...hash].map((b) => b.toString(16).padStart(2, "0")).join("")}.jpg` };
}

Deno.test("the record reaches Mailpit in Cloudflare's shape, marked as a test, linking and attaching the stored print file, and an alert goes without it", async () => {
	const sent: { Subject: string; From: { Email: string }; Text: string; Attachments: { Content: string; Filename: string; ContentType: string }[] }[] = [];
	const mail = createMailSimulator({
		mailpit: "http://mailpit",
		fetch: (_url, init) => {
			sent.push(JSON.parse(init!.body as string));
			return Promise.resolve(Response.json({ ID: "m1" }));
		},
	});
	// The mail rebuilt the file from every card, so a repeat could attach other
	// bytes than the order was paid with; it attaches the one print-session stored.
	const pdf = new TextEncoder().encode("%PDF-1.7 stored");
	const file = `effects/${[...new Uint8Array(await crypto.subtle.digest("SHA-256", pdf))].map((b) => b.toString(16).padStart(2, "0")).join("")}.pdf`;
	const input = { id: ID, session_id: "cs_test_1", to: "o@example.test", title: "Deck", stock: "gloss", sku: "x", cards: 1, total: 1, currency: "usd", cost: 1, fx_quote: "fxq_1", fx_brl: 6, vendor_order_id: "ord", email: null, delivery: {}, print_file: file };
	const answer = await record(input, sinkOf(mail, { Authorization: "Bearer t" }, "print-record:1", "application/json", new Map([[file, pdf]])), { MAIL_ACCOUNT_ID: "acct" });
	assert.deepEqual(answer, { done: { sent: true } });
	assert.equal(sent[0].Subject, `[TEST] Snapcards order ${ID}`);
	// The sender is the deployment's own host.
	assert.equal(sent[0].From.Email, "snapcards@app.example");
	assert.ok(sent[0].Text.includes(`Print file: ${ORIGIN}/blobs/mecha-objects/${file}`));
	assert.deepEqual(sent[0].Attachments, [{ Content: btoa(String.fromCharCode(...pdf)), Filename: `snapcards-${ID}.pdf`, ContentType: "application/pdf" }]);
	// An alert that waited on its attachment left a paid order unseen: a file the
	// plane cannot give back goes out as the link alone, saying why.
	assert.deepEqual(await alert({ ...input, failure: "prodigi: 400" }, sinkOf(mail, { Authorization: "Bearer t" }, "print-alert:1"), { MAIL_ACCOUNT_ID: "acct" }), { done: { sent: true } });
	assert.deepEqual(sent[1].Attachments, []);
	assert.ok(sent[1].Text.includes(`Print file: ${ORIGIN}/blobs/mecha-objects/${file}`));
	assert.match(sent[1].Text, /The print file is not attached: no blob/);
	// Test or live is the order's session's own, so one release serves both modes.
	await record({ ...input, session_id: "cs_live_1" }, sinkOf(mail, { Authorization: "Bearer t" }, "print-record:2", "application/json", new Map([[file, pdf]])), { MAIL_ACCOUNT_ID: "acct" });
	assert.equal(sent[2].Subject, `Snapcards order ${ID}`);
	assert.ok(!sent[2].Text.includes("test-mode"));
	// A refused alert settled the order as alerted; thrown, the airlock tries it again.
	const refusing = sinkOf(() => Response.json({ errors: [{ message: "Authentication error" }] }, { status: 403 }), { Authorization: "Bearer t" }, "print-alert:2");
	await assert.rejects(() => alert({ ...input, failure: "prodigi: 400" }, refusing, { MAIL_ACCOUNT_ID: "acct" }), /mail answered 403/);
	// Brazil spiral flip-deck mails name Cloudprinter and link both print and cover files.
	await record(
		{ ...input, country: "BR", sku: flipDeck.sku, cover_file: "effects/cover.pdf" },
		sinkOf(mail, { Authorization: "Bearer t" }, "print-record:br", "application/json", new Map([[file, pdf]])),
		{ MAIL_ACCOUNT_ID: "acct" },
	);
	assert.match(sent.at(-1)!.Text, /Cloudprinter prints and posts this order/);
	assert.match(sent.at(-1)!.Text, /spiral flip-deck/);
	assert.ok(sent.at(-1)!.Text.includes(`Cover file: ${ORIGIN}/blobs/mecha-objects/effects/cover.pdf`));

	// Immediate buyer confirmation sends Email #1 with order details before printer
	// confirmation, and print-record replies with Email #2 in the exact same thread.
	const buyerConfirmed = await confirm(
		{ ...input, country: "BR", sku: flipDeck.sku, total: 9650, currency: "brl", cover_file: "effects/cover.pdf", email: "buyer@example.test", delivery: { address: { recipient: "Marina", line1: "Rua Augusta, 1508", city: "São Paulo", region: "SP", postalCode: "01305-100", country: "BR" }, contact: { email: "buyer@example.test" } } },
		sinkOf(mail, { Authorization: "Bearer t" }, "print-confirm:br"),
		{ MAIL_ACCOUNT_ID: "acct" },
	);
	assert.equal(buyerConfirmed.done.sent, true);
	assert.match(buyerConfirmed.done.message_id, /^<.+@app\.example>$/);
	const email1 = sent.at(-1)! as unknown as { Subject: string; To: { Email: string }[]; Text: string };
	assert.equal(email1.To[0].Email, "buyer@example.test");
	assert.match(email1.Subject, /^\[TEST\] Pedido Snapcards #/);
	assert.match(email1.Text, /Pagamento confirmado/);

	await record(
		{ ...input, country: "BR", sku: flipDeck.sku, total: 9650, currency: "brl", cover_file: "effects/cover.pdf", email: "buyer@example.test", mail_message_id: buyerConfirmed.done.message_id },
		sinkOf(mail, { Authorization: "Bearer t" }, "print-record:br-thread", "application/json", new Map([[file, pdf]])),
		{ MAIL_ACCOUNT_ID: "acct" },
	);
	const email2 = sent.at(-2)! as unknown as { Subject: string; To: { Email: string }[]; Headers: Record<string, string>; Text: string };
	assert.equal(email2.To[0].Email, "buyer@example.test");
	assert.equal(email2.Subject, `Re: ${email1.Subject}`);
	assert.deepEqual(email2.Headers, { "In-Reply-To": buyerConfirmed.done.message_id, References: buyerConfirmed.done.message_id });
	assert.match(email2.Text, /confirmou o recebimento/);
	assert.ok(email2.Text.includes(`${ORIGIN}/print?order=${ID}`));

	await shipped(
		{
			...input,
			country: "BR",
			sku: flipDeck.sku,
			cover_file: "effects/cover.pdf",
			email: "buyer@example.test",
			mail_message_id: buyerConfirmed.done.message_id,
			tracking_carrier: "Correios SEDEX",
			tracking_number: "BR7C1F0A7EBR",
			tracking_url: "https://rastreamento.correios.com.br/app/index.php",
		},
		sinkOf(mail, { Authorization: "Bearer t" }, "print-shipped:br-thread"),
		{ MAIL_ACCOUNT_ID: "acct" },
	);
	const email3 = sent.at(-1)! as unknown as { Subject: string; To: { Email: string }[]; Headers: Record<string, string>; Text: string };
	assert.equal(email3.To[0].Email, "buyer@example.test");
	assert.equal(email3.Subject, `Re: ${email1.Subject}`);
	assert.deepEqual(email3.Headers, { "In-Reply-To": buyerConfirmed.done.message_id, References: buyerConfirmed.done.message_id });
	assert.ok(email3.Text.includes("BR7C1F0A7EBR"));
	assert.ok(email3.Text.includes("https://rastreamento.correios.com.br/app/index.php"));
	assert.ok(email3.Text.includes(`${ORIGIN}/print?order=${ID}`));
});

Deno.test("Brazil quotes, builds 2-page cover + >=24-page book PDFs, places idempotently at Cloudprinter, and reads CloudSignal status", async () => {
	const cpSecrets = { CLOUDPRINTER_API_KEY: "cp_sim" };
	const files = new Map<string, Uint8Array>();
	const hooks: { type: string; order: string; order_reference: string }[] = [];
	const door = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
		const url = new URL(req.url);
		if (url.pathname === "/signal/cloudprinter") {
			hooks.push(await req.json());
			return new Response("{}");
		}
		const key = url.pathname.replace(/^\/blobs\/mecha-objects\//, "");
		const bytes = files.get(key);
		if (!bytes) return new Response("not found", { status: 404 });
		return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": "application/pdf" } });
	});
	const doorOrigin = `http://127.0.0.1:${door.addr.port}`;
	const cp = createCloudprinterSimulator({ apiKey: "cp_sim", door: doorOrigin, webhookUrl: `${doorOrigin}/signal/cloudprinter` });
	const stripe = createSimulator({ secretKey: "simulator", webhookSecret: "w", webhookUrl: "http://127.0.0.1:1/", checkoutOrigin: "http://checkout" });
	try {
		const cpSink = (key: string, blobs = files) => sinkOf(cp.fetch, {}, key, "application/json", blobs);
		const sp = await quoteBr({ stock: "gloss", cards: 7, postal_code: "01305-100", currency: "USD" }, cpSink("quote-br:sp"), cpSecrets);
		assert.deepEqual(sp.done, { sku: flipDeck.sku, shipping_method: "cp_saver", shipping: 803, cost: 211 + 803 });
		const pr = await quoteBr({ stock: "mohawk", cards: 7, postal_code: "80010-000", currency: "USD" }, cpSink("quote-br:pr"), cpSecrets);
		assert.deepEqual(pr.done, { sku: flipDeck.sku, shipping_method: "cp_saver", shipping: 1914, cost: 211 + 1914 });
		// Regression: CloudCore accepts 20 pages at quote/add, but textbook preflight parks < 24 pages;
		// 1..12 cards pad to 24 pages, while 13+ cards price at 2N pages without padding.
		for (const [cards, itemCents] of [[1, 211], [10, 211], [12, 211], [13, 219], [14, 227]] as const) {
			const q = await quoteBr({ stock: "gloss", cards, postal_code: "01305-100", currency: "USD" }, cpSink(`quote-br:${cards}`), cpSecrets);
			assert.equal(q.done.cost, itemCents + 803, `cards=${cards}`);
		}
		for (const [totalPages, pageblockPages] of [["18", "18"], ["25", "25"], ["24", "20"]] as const) {
			const badOpts = [
				{ type: "total_pages", count: totalPages },
				{ type: flipDeck.stocks.gloss.pageblock, count: pageblockPages },
				{ type: flipDeck.stocks.gloss.cover, count: "1" },
				{ type: flipDeck.stocks.gloss.finish, count: "1" },
				{ type: flipDeck.stocks.gloss.binding, count: "1" },
			];
			const qBad = await cp.fetch(new Request("http://cp/cloudcore/1.0/orders/quote", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					apikey: "cp_sim",
					currency: "USD",
					country: "BR",
					state: "BR-Sao Paulo Metropolitan Region and suburbs",
					items: [{ reference: "deck-1", product: flipDeck.sku, count: "1", options: badOpts }],
				}),
			}));
			assert.equal(qBad.status, 400);
		}
		assert.deepEqual(await quoteBr({ stock: "gloss", cards: 7, postal_code: "10500-000", currency: "USD" }, cpSink("quote-br:bad"), cpSecrets), {
			failed: { status: "invalid_postal_code" },
		});

		const card = await artwork();
		const stripeSink = (key: string) =>
			sinkOf(stripe.fetch, { Authorization: "Bearer simulator" }, key, "application/x-www-form-urlencoded", new Map([[card.key, card.bytes]]));
		const sess = (await session({
			id: ID,
			total: 6389,
			currency: "brl",
			country: "BR",
			title: "Animais",
			artwork: Array(10).fill(card.key),
			opened_epoch: Math.floor(Date.now() / 1000),
		}, stripeSink(`session-br:${ID}`), KEYS)).done;
		assert.ok(sess.cover?.$blob, "BR session emits cover PDF alongside book PDF");
		const bookPdf = await PDFDocument.load(sess.file.$blob.bytes, { updateMetadata: false });
		const coverPdf = await PDFDocument.load(sess.cover.$blob.bytes, { updateMetadata: false });
		assert.equal(bookPdf.getPageCount(), 24, "10-card deck (20 faces) pads to Cloudprinter's 24-page textbook floor");
		assert.equal(coverPdf.getPageCount(), 2, "Coil cover is 2 pages (front + back)");
		assert.ok(Math.abs(bookPdf.getPage(0).getWidth() - flipDeck.pagePt.width) < 0.1);
		assert.ok(Math.abs(bookPdf.getPage(0).getHeight() - flipDeck.pagePt.height) < 0.1);
		for (const [cards, wantPages] of [[1, 24], [12, 24], [13, 26]] as const) {
			const s = (await session({
				id: crypto.randomUUID(),
				total: 6389,
				currency: "brl",
				country: "BR",
				title: "Animais",
				artwork: Array(cards).fill(card.key),
				opened_epoch: Math.floor(Date.now() / 1000),
			}, stripeSink(`session-br:${cards}`), KEYS)).done;
			assert.equal((await PDFDocument.load(s.file.$blob.bytes, { updateMetadata: false })).getPageCount(), wantPages, `cards=${cards}`);
			if (cards === 13) files.set("effects/book-26.pdf", s.file.$blob.bytes);
		}
		files.set("effects/book.pdf", sess.file.$blob.bytes);
		files.set("effects/cover.pdf", sess.cover.$blob.bytes);

		const placeInput = {
			id: ID,
			title: "Animais",
			stock: "gloss",
			cards: 10,
			sku: flipDeck.sku,
			shipping_method: "cp_saver",
			email: "buyer@example.test",
			print_file: "effects/book.pdf",
			cover_file: "effects/cover.pdf",
			delivery: {
				address: {
					recipient: "Marina Albuquerque",
					taxId: "12345678909",
					line1: "Rua Augusta, 1508",
					line2: "Apto 42",
					district: "Consolação",
					city: "São Paulo",
					region: "SP",
					postalCode: "01305100",
					country: "BR",
				},
			},
		};
		const quoteBrSrc = await Deno.readTextFile(new URL("../effects/print-quote-br.js", import.meta.url));
		const placeBrSrc = await Deno.readTextFile(new URL("../effects/print-place-br.js", import.meta.url));
		const sessionSrc = await Deno.readTextFile(new URL("../effects/print-session.js", import.meta.url));
		assert.ok(sessionSrc.includes(`const COIL_MIN_PAGES = ${flipDeck.minPages};`));
		for (const src of [quoteBrSrc, placeBrSrc]) {
			assert.ok(src.includes(`Math.max(${flipDeck.minPages}, input.cards * 2)`));
			assert.ok(src.includes(flipDeck.stocks.gloss.pageblock) && src.includes(flipDeck.stocks.mohawk.pageblock));
			assert.ok(src.includes("BR-Sao Paulo Metropolitan Region and suburbs") && src.includes("BR-Rio Grande do Sul"));
		}
		assert.deepEqual(
			await placeBr({ ...placeInput, delivery: { address: { ...placeInput.delivery.address, taxId: "111.111.111-11" } } }, cpSink("place-br:badcpf"), cpSecrets),
			{ failed: { status: "invalid_cpf" } },
		);
		await assert.rejects(() => statusBr({ id: "00000000-0000-4000-8000-000000000000", vendor_order_id: "cp_missing" }, cpSink("status-br:204"), cpSecrets), /Cloudprinter answered 204/);
		const expectedCpId = `cp_${ID.replaceAll("-", "").slice(0, 12)}`;
		const placed = await placeBr(placeInput, cpSink(`place-br:${ID}`), cpSecrets);
		assert.deepEqual(placed, { done: { id: expectedCpId, stage: "in_progress" } });
		const repeated = await placeBr(placeInput, cpSink(`place-br:${ID}`), cpSecrets);
		assert.deepEqual(repeated, { done: { id: expectedCpId, stage: "in_progress" } });
		const dup400Sink = sinkOf(
			async (req: Request) => {
				if (new URL(req.url).pathname.endsWith("/orders/add")) {
					return Response.json({ error: { type: "order_reference_not_unique" } }, { status: 400 });
				}
				return await cp.fetch(req);
			},
			{},
			"place-br:400",
			"application/json",
			files,
		);
		assert.deepEqual(await placeBr(placeInput, dup400Sink, cpSecrets), { done: { id: expectedCpId, stage: "in_progress" } });
		await cp.settled();
		assert.equal(hooks[0]?.type, "CloudprinterOrderValidated");
		assert.equal(hooks[0]?.order_reference, ID);
		assert.equal(hooks[0]?.order, expectedCpId);
		assert.deepEqual(await statusBr({ id: ID, vendor_order_id: expectedCpId }, cpSink("status-br:1"), cpSecrets), {
			done: { state: "in_progress", carrier: "Correios SEDEX", tracking_number: null, tracking_url: null },
		});
		await (await cp.fetch(new Request(`http://cp/_simulator/orders/${ID}/shipped`, { method: "POST" }))).body?.cancel();
		const expectedTrack = `BR${ID.slice(0, 8).toUpperCase()}BR`;
		assert.deepEqual(await statusBr({ id: ID, vendor_order_id: expectedCpId }, cpSink("status-br:2"), cpSecrets), {
			done: { state: "shipped", carrier: "Correios SEDEX", tracking_number: expectedTrack, tracking_url: "https://rastreamento.correios.com.br/app/index.php" },
		});
		await (await cp.fetch(new Request(`http://cp/_simulator/orders/${ID}/complete`, { method: "POST" }))).body?.cancel();
		assert.deepEqual(await statusBr({ id: ID, vendor_order_id: expectedCpId }, cpSink("status-br:3"), cpSecrets), {
			done: { state: "completed", carrier: "Correios SEDEX", tracking_number: expectedTrack, tracking_url: "https://rastreamento.correios.com.br/app/index.php" },
		});
		await (await cp.fetch(new Request(`http://cp/_simulator/orders/${ID}/cancelled`, { method: "POST" }))).body?.cancel();
		assert.deepEqual(await statusBr({ id: ID, vendor_order_id: expectedCpId }, cpSink("status-br:4"), cpSecrets), { failed: { state: "cancelled" } });
		assert.deepEqual(await placeBr(placeInput, cpSink("place-br:after-cancel"), cpSecrets), { failed: { status: 409, detail: "cancelled" } });
		const laggingSink = sinkOf(
			async (req: Request) => {
				if (new URL(req.url).pathname.endsWith("/orders/info")) {
					return new Response(null, { status: 204 });
				}
				return await cp.fetch(req);
			},
			{},
			"place-br:lag",
			"application/json",
			files,
		);
		await assert.rejects(() => placeBr(placeInput, laggingSink, cpSecrets), /Cloudprinter info answered 204/);

		// 13-card deck (26 faces) places and validates at 26 pages without clamping to 24.
		const id13 = "22222222-2222-4222-8222-222222222222";
		const placed13 = await placeBr({ ...placeInput, id: id13, cards: 13, print_file: "effects/book-26.pdf" }, cpSink(`place-br:${id13}`), cpSecrets);
		assert.equal(placed13.done.stage, "in_progress");
		await cp.settled();
		assert.equal(hooks.at(-1)?.type, "CloudprinterOrderValidated");
		assert.equal(hooks.at(-1)?.order_reference, id13);

		// /orders/add rejects odd page counts synchronously, while 20-page blocks register (201)
		// at CloudCore and fail asynchronously in textbook preflight (ItemProduceError -> alerting).
		const doc20 = await PDFDocument.create({ updateMetadata: false });
		for (let i = 0; i < 20; i++) doc20.addPage([flipDeck.pagePt.width, flipDeck.pagePt.height]);
		const bytes20 = await doc20.save({ objectsPerTick: Infinity });
		files.set("effects/book-20.pdf", bytes20);
		const addPayload = (reference: string, pages: string, bookKey: string, bookBytes: Uint8Array) => ({
			apikey: "cp_sim",
			reference,
			email: "davi@davi.eng.br",
			addresses: [{
				type: "delivery",
				firstname: "Marina",
				lastname: "Albuquerque",
				street1: "Rua Augusta, 1508",
				zip: "01305-100",
				city: "São Paulo",
				state: "BR-Sao Paulo Metropolitan Region and suburbs",
				country: "BR",
				email: "buyer@example.test",
				phone: "+55 11 00000-0000",
				customer_identification: "123.456.789-09",
			}],
			items: [{
				reference: "deck-1",
				product: flipDeck.sku,
				shipping_level: "cp_saver",
				title: "Animais",
				count: "1",
				files: [
					{ type: "cover", url: `${ORIGIN}/blobs/mecha-objects/effects/cover.pdf`, md5sum: cp.orders.get(ID)!.items[0].files[0].md5sum },
					{ type: "book", url: `${ORIGIN}/blobs/mecha-objects/${bookKey}`, md5sum: md5Hex(bookBytes) },
				],
				options: [
					{ type: "total_pages", count: pages },
					{ type: flipDeck.stocks.gloss.pageblock, count: pages },
					{ type: flipDeck.stocks.gloss.cover, count: "1" },
					{ type: flipDeck.stocks.gloss.finish, count: "1" },
					{ type: flipDeck.stocks.gloss.binding, count: "1" },
				],
			}],
		});
		const oddAdd = addPayload("odd-25", "25", "effects/book.pdf", sess.file.$blob.bytes);
		assert.equal((await cp.fetch(new Request("http://cp/cloudcore/1.0/orders/add", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(oddAdd),
		}))).status, 400);

		const parkedRef = "00f28b49-aeee-427f-8863-a32e36eb460f";
		const reg20 = await cp.fetch(new Request("http://cp/cloudcore/1.0/orders/add", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(addPayload(parkedRef, "20", "effects/book-20.pdf", bytes20)),
		}));
		assert.equal(reg20.status, 201);
		await cp.settled();
		assert.equal(hooks.at(-1)?.type, "CloudprinterItemError");
		assert.equal(hooks.at(-1)?.order_reference, parkedRef);
		assert.deepEqual(await statusBr({ id: parkedRef, vendor_order_id: `cp_${parkedRef.replaceAll("-", "").slice(0, 12)}` }, cpSink("status-br:parked"), cpSecrets), {
			failed: { state: "ItemProduceError" },
		});

		const issueRef = "33333333-3333-4333-8333-333333333333";
		await (await cp.fetch(new Request("http://cp/_simulator/fail/next/fulfilment_issue", { method: "POST" }))).body?.cancel();
		const placedIssue = await placeBr({ ...placeInput, id: issueRef }, cpSink(`place-br:${issueRef}`), cpSecrets);
		assert.equal(placedIssue.done.stage, "in_progress");
		await cp.settled();
		assert.equal(hooks.at(-1)?.type, "CloudprinterItemError");
		assert.deepEqual(await statusBr({ id: issueRef, vendor_order_id: placedIssue.done.id }, cpSink("status-br:issue"), cpSecrets), {
			failed: { state: "ItemProduceError" },
		});
	} finally {
		await cp.settled();
		await door.shutdown();
	}
});
