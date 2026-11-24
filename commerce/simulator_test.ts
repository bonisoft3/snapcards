// The Stripe simulator against Stripe's own SDK and webhook verifier: what the
// print-session and print-check handlers ask it is answered as the service
// would answer. Every request stays on 127.0.0.1.
import { strict as assert } from "node:assert";
import Stripe from "stripe";
import * as sessionEffect from "../effects/print-session.js";
import { createSimulator } from "./simulator.ts";
import "./pdf-endowment.ts";

// The session's lifetime, which the handler states, and the latest age at which
// one can still be asked for, since Stripe refuses one expiring within 30 minutes.
const CHECKOUT_LIFETIME_MS = 2 * 60 * 60 * 1000;
const CHECKOUT_CREATABLE_MS = CHECKOUT_LIFETIME_MS - 35 * 60 * 1000;
const ORIGIN = "https://localhost:30343";
const secretKey = "sk_test_local_fixture";
const webhookSecret = "whsec_local_fixture";
type Made = { id: string; amount: number; currency: string; createdAt: string };
const order = (id = crypto.randomUUID(), createdAt = new Date().toISOString()): Made => ({ id, amount: 100, currency: "brl", createdAt });

// The print-session handler, as the airlock runs it: a sink over HTTP with the
// account's key, the ledger key as Idempotency-Key and the door's origin.
// deno-lint-ignore no-explicit-any
const session = sessionEffect.issue as (input: unknown, sink: unknown, secrets: Record<string, string>) => Promise<any>;
function provider(sdk: Stripe, base: string, key: string) {
	return {
		async createCheckout(made: Made): Promise<Stripe.Checkout.Session> {
			const ledger = `print-session:${made.id}`;
			const answer = await session(
				// A deck with no cards: its print file is effects_test.ts's to read.
				{ id: made.id, total: made.amount, currency: made.currency, title: "Deck", artwork: [], opened_epoch: Math.floor(Date.parse(made.createdAt) / 1000) },
				{
					key: ledger,
					origin: ORIGIN,
					blob: (k: string) => Promise.reject(new Error(`no blob ${k}`)),
					async fetch(path: string, init: { method: string; body: string; headers?: Record<string, string> }) {
						const res = await fetch(`${base}${path}`, {
							method: init.method,
							headers: { ...init.headers, Authorization: `Bearer ${key}`, "Idempotency-Key": ledger, "Content-Type": "application/x-www-form-urlencoded" },
							body: init.body,
						});
						return { status: res.status, body: await res.json() };
					},
				},
				{ STRIPE_PUBLISHABLE_KEY: "pk_test_simulator" },
			);
			if (answer.failed) throw Object.assign(new Error(JSON.stringify(answer.failed)), { answer: answer.failed });
			return await sdk.checkout.sessions.retrieve(answer.done.id);
		},
		retrieveCheckout: (id: string) => sdk.checkout.sessions.retrieve(id),
	};
}

function stack(clock?: { now: number }) {
	const received: { raw: string; signature: string }[] = [];
	let answer = 200;
	const hook = Deno.serve(
		{ hostname: "127.0.0.1", port: 0, onListen() {} },
		async (req) => {
			received.push({
				raw: await req.text(),
				signature: req.headers.get("Stripe-Signature")!,
			});
			return new Response(null, { status: answer });
		},
	);
	const server = Deno.serve(
		{ hostname: "127.0.0.1", port: 0, onListen() {} },
		(req) => sim.fetch(req),
	);
	const origin = `http://127.0.0.1:${server.addr.port}`;
	const sim = createSimulator({
		secretKey,
		webhookSecret,
		webhookUrl: `http://127.0.0.1:${hook.addr.port}/commerce/stripe`,
		checkoutOrigin: origin,
		...(clock ? { now: () => clock.now } : {}),
	});
	const sdk = new Stripe(secretKey, {
		httpClient: Stripe.createFetchHttpClient(),
		maxNetworkRetries: 0,
		host: "127.0.0.1",
		port: server.addr.port,
		protocol: "http",
	});
	const events = async (session: string) =>
		await (await fetch(`${origin}/_simulator/events?session=${session}`))
			.json() as {
				id: string;
				type: string;
				held: boolean;
				deliveries: { status: number }[];
			}[];
	const act = (session: string, action: string, email = "buyer@example.test") =>
		fetch(`${origin}/c/pay/${session}`, {
			method: "POST",
			redirect: "manual",
			body: new URLSearchParams({ action, email }),
		});
	return {
		sim,
		origin,
		provider: provider(sdk, origin, secretKey),
		sdk,
		received,
		events,
		act,
		answer(status: number) {
			answer = status;
		},
		verify: (raw: string, signature: string) =>
			Stripe.webhooks.constructEventAsync(
				raw,
				signature,
				webhookSecret,
				300,
				Stripe.createSubtleCryptoProvider(),
			),
		async [Symbol.asyncDispose]() {
			await sim.settled();
			await server.shutdown();
			await hook.shutdown();
		},
	};
}

Deno.test("the app's provider creates and reads a session the service would accept", async () => {
	await using s = stack();
	const made = order();
	const session = await s.provider.createCheckout(made);
	assert.match(session.id, /^cs_test_[A-Za-z0-9]{58}$/);
	assert.equal(session.url, null);
	assert.deepEqual(
		{
			mode: session.mode,
			status: session.status,
			payment_status: session.payment_status,
			livemode: session.livemode,
			amount_total: session.amount_total,
			currency: session.currency,
			client_reference_id: session.client_reference_id,
			payment_intent: session.payment_intent,
		},
		{
			mode: "payment",
			status: "open",
			payment_status: "unpaid",
			livemode: false,
			amount_total: 100,
			currency: "brl",
			client_reference_id: made.id,
			payment_intent: null,
		},
	);
	assert.deepEqual(session.metadata, { order_id: made.id });
	assert.deepEqual(await s.provider.retrieveCheckout(session.id), session);
	const raw = await s.sdk.checkout.sessions.retrieve(session.id);
	assert.equal(raw.object, "checkout.session");
	assert.equal(raw.ui_mode, "elements");
	assert.match(String(raw.client_secret), /^cs_test_[A-Za-z0-9]{58}_secret_[A-Za-z0-9]{24}$/);
	const sdkRes = await fetch(`${s.origin}/clover/stripe.js`);
	assert.equal(sdkRes.status, 200);
	assert.match(await sdkRes.text(), /initCheckout/);
	assert.ok(Math.abs(raw.expires_at - raw.created - 2 * 60 * 60) < 5);
	// A BRL order may pay by Pix; any other is card only.
	assert.deepEqual(raw.payment_method_types, ["card", "pix"]);
	const usd = await s.provider.createCheckout({ ...order(), currency: "usd" });
	assert.deepEqual(usd.payment_method_types, ["card"]);
});

// Stripe refuses Pix outside BRL, so the simulator must, or a USD order offering
// it would pass here and fail at Stripe.
Deno.test("pix is refused outside brl", async () => {
	await using s = stack();
	await assert.rejects(
		s.sdk.checkout.sessions.create({
			mode: "payment",
			line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 100, product_data: { name: "x" } } }],
			success_url: "https://localhost:30343/print",
			allowed_payment_method_types: ["card", "pix"],
		}),
		(error: unknown) =>
			error instanceof Stripe.errors.StripeInvalidRequestError &&
			error.param === "allowed_payment_method_types",
	);
});

Deno.test("a Pix completes the session unpaid from the page, and its payment says whether the bank settled it", async () => {
	await using s = stack();
	const read = async (id: string) =>
		await (await fetch(`${s.origin}/v1/checkout/sessions/${id}?expand%5B%5D=payment_intent`, {
			headers: { Authorization: `Bearer ${secretKey}`, "Stripe-Version": "2026-09-30.endive" },
		})).json();
	const step = async (id: string, name: string) =>
		await (await fetch(`${s.origin}/_simulator/checkout/sessions/${id}/${name}`, { method: "POST" })).body?.cancel();
	const made = await s.provider.createCheckout(order());
	assert.equal((await read(made.id)).payment_intent, null);
	const back = await s.act(made.id, "pix");
	assert.equal(back.status, 303);
	await back.body?.cancel();
	const waiting = await read(made.id);
	assert.deepEqual([waiting.status, waiting.payment_status, waiting.payment_intent.status], ["complete", "unpaid", "requires_action"]);
	await step(made.id, "async_payment_succeeded");
	const settled = await read(made.id);
	assert.deepEqual([settled.payment_status, settled.payment_intent.status], ["paid", "succeeded"]);

	const lapsed = await s.provider.createCheckout(order());
	await (await s.act(lapsed.id, "pix")).body?.cancel();
	await step(lapsed.id, "async_payment_failed");
	assert.equal((await read(lapsed.id)).payment_intent.status, "requires_payment_method");
	const card = await s.provider.createCheckout({ ...order(), currency: "usd" });
	const refused = await s.act(card.id, "pix");
	await refused.body?.cancel();
	assert.equal(refused.status, 400, "a card-only session has no Pix");
});

Deno.test("Stripe refuses a session expiring within 30 minutes, which the order's guard stays clear of", async () => {
	await using s = stack();
	const aged = (ms: number) => {
		const made = order();
		return { ...made, createdAt: new Date(Date.now() - ms).toISOString() };
	};
	const made = await s.provider.createCheckout(aged(CHECKOUT_CREATABLE_MS - 60 * 1000));
	assert.equal(made.status, "open");
	await assert.rejects(
		() => s.provider.createCheckout(aged(CHECKOUT_LIFETIME_MS - 25 * 60 * 1000)),
		/30 minutes to 24 hours/,
	);
});

Deno.test("an idempotency key replays its first answer and refuses other parameters", async () => {
	await using s = stack();
	const made = order();
	const first = await s.provider.createCheckout(made);
	const again = await s.provider.createCheckout(made);
	assert.equal(again.id, first.id);
	const replay = await s.sdk.checkout.sessions.create({
		mode: "payment",
		line_items: [{
			quantity: 1,
			price_data: {
				currency: "brl",
				unit_amount: 100,
				product_data: { name: "x" },
			},
		}],
		success_url: "https://localhost:30343/print",
	}, { idempotencyKey: "fixture-key" });
	const replayed = await s.sdk.checkout.sessions.create({
		mode: "payment",
		line_items: [{
			quantity: 1,
			price_data: {
				currency: "brl",
				unit_amount: 100,
				product_data: { name: "x" },
			},
		}],
		success_url: "https://localhost:30343/print",
	}, { idempotencyKey: "fixture-key" });
	assert.equal(replayed.id, replay.id);
	assert.equal(replayed.lastResponse.requestId, replay.lastResponse.requestId);
	await assert.rejects(
		s.sdk.checkout.sessions.create({
			mode: "payment",
			line_items: [{
				quantity: 2,
				price_data: {
					currency: "brl",
					unit_amount: 100,
					product_data: { name: "x" },
				},
			}],
			success_url: "https://localhost:30343/print",
		}, { idempotencyKey: "fixture-key" }),
		(error: unknown) => error instanceof Stripe.errors.StripeIdempotencyError,
	);
});

Deno.test("only the account's key is accepted, and unmodelled parameters are refused", async () => {
	await using s = stack();
	const stranger = provider(s.sdk, s.origin, "sk_test_someone_else");
	await assert.rejects(
		stranger.createCheckout(order()),
		(error: { answer?: { status: number } }) => error.answer?.status === 401,
	);
	await assert.rejects(
		s.sdk.checkout.sessions.create({
			mode: "payment",
			line_items: [{
				quantity: 1,
				price_data: {
					currency: "brl",
					unit_amount: 100,
					product_data: { name: "x" },
				},
			}],
			success_url: "https://localhost:30343/print",
			allow_promotion_codes: true,
		}),
		(error: unknown) =>
			error instanceof Stripe.errors.StripeInvalidRequestError &&
			error.param === "allow_promotion_codes",
	);
	await assert.rejects(
		s.sdk.checkout.sessions.retrieve("cs_test_missing"),
		(error: unknown) =>
			error instanceof Stripe.errors.StripeInvalidRequestError &&
			error.code === "resource_missing",
	);
	// Stripe renamed ui_mode custom to elements and refuses custom at the
	// pinned version (2026-11-14); the simulator refuses it the same way, so
	// the compose stack cannot pass what the live API rejects.
	await assert.rejects(
		s.sdk.checkout.sessions.create({
			mode: "payment",
			line_items: [{
				quantity: 1,
				price_data: {
					currency: "brl",
					unit_amount: 100,
					product_data: { name: "x" },
				},
			}],
			ui_mode: "custom" as never,
			return_url: "https://localhost:30343/print",
		}),
		(error: unknown) =>
			error instanceof Stripe.errors.StripeInvalidRequestError &&
			error.param === "ui_mode",
	);
});

Deno.test("paying completes the session, redirects, and sends a completed event Stripe's verifier accepts", async () => {
	await using s = stack();
	const made = order();
	const session = await s.provider.createCheckout(made);
	const page = await fetch(`${s.origin}/c/pay/${session.id}`);
	assert.match(await page.text(), /Pay R\$1\.00/);
	const paid = await s.act(session.id, "pay");
	assert.equal(paid.status, 303);
	assert.equal(
		paid.headers.get("Location"),
		`https://localhost:30343/print?order=${made.id}`,
	);
	await s.sim.settled();
	assert.equal(s.received.length, 1);
	const event = await s.verify(s.received[0].raw, s.received[0].signature);
	assert.equal(event.type, "checkout.session.completed");
	assert.equal(event.livemode, false);
	assert.equal(event.api_version, Stripe.API_VERSION);
	const object = event.data.object as Stripe.Checkout.Session;
	assert.equal(object.id, session.id);
	assert.equal(object.status, "complete");
	assert.equal(object.payment_status, "paid");
	assert.equal(object.url, null);
	assert.equal(object.customer_details?.email, "buyer@example.test");
	assert.match(String(object.payment_intent), /^pi_/);
	const read = await s.provider.retrieveCheckout(session.id);
	assert.equal(read.payment_intent, object.payment_intent);
	// A byte changed after signing is refused, as by Stripe's own library.
	await assert.rejects(
		s.verify(
			s.received[0].raw.replace('"paid"', '"unpaid"'),
			s.received[0].signature,
		),
	);
	// A completed session is not paid twice.
	assert.equal((await s.act(session.id, "pay")).status, 200);
	await s.sim.settled();
	assert.equal(s.received.length, 1);
});

Deno.test("a declined card leaves the session open and unpaid with no event", async () => {
	await using s = stack();
	const session = await s.provider.createCheckout(order());
	const declined = await s.act(session.id, "decline");
	assert.match(await declined.text(), /data-outcome="declined"/);
	const read = await s.provider.retrieveCheckout(session.id);
	assert.equal(read.status, "open");
	assert.equal(read.payment_status, "unpaid");
	assert.match(String(read.payment_intent), /^pi_/);
	assert.equal(read.url, null);
	assert.notEqual(read.client_secret, null);
	await s.sim.settled();
	assert.deepEqual(await s.events(session.id), []);
});

Deno.test("expiry by the API, the page or the clock sends one expired event; an expired session cannot expire again", async () => {
	const clock = { now: Date.parse("2026-11-02T12:00:00Z") };
	await using s = stack(clock);
		const at = new Date(clock.now).toISOString();
	const held = () => order(crypto.randomUUID(), at);
	const byApi = await s.provider.createCheckout(held());
	const expired = await s.sdk.checkout.sessions.expire(byApi.id);
	assert.equal(expired.status, "expired");
	assert.equal(expired.url, null);
	await assert.rejects(
		s.sdk.checkout.sessions.expire(byApi.id),
		(error: unknown) =>
			error instanceof Stripe.errors.StripeInvalidRequestError,
	);
	const byPage = await s.provider.createCheckout(held());
	await s.act(byPage.id, "expire");
	const byClock = await s.provider.createCheckout(held());
	clock.now += 24 * 60 * 60 * 1000;
	s.sim.sweep();
	await s.sim.settled();
	for (const id of [byApi.id, byPage.id, byClock.id]) {
		assert.deepEqual(
			(await s.events(id)).map((e) => e.type),
			["checkout.session.expired"],
		);
		assert.equal((await s.provider.retrieveCheckout(id)).status, "expired");
	}
	// The clock moved a day, past the verifier's tolerance for real time.
	assert.deepEqual(
		s.received.map(({ raw }) => JSON.parse(raw).data.object.status),
		[
			"expired",
			"expired",
			"expired",
		],
	);
});

Deno.test("an asynchronous payment completes unpaid, then succeeds or fails by event", async () => {
	await using s = stack();
		const control = (id: string, step: string) =>
		fetch(`${s.origin}/_simulator/checkout/sessions/${id}/${step}`, {
			method: "POST",
		});
	const wins = await s.provider.createCheckout(order());
	assert.equal((await control(wins.id, "async_payment_succeeded")).status, 409);
	assert.equal((await control(wins.id, "complete_unpaid")).status, 200);
	const waiting = await s.provider.retrieveCheckout(wins.id);
	assert.deepEqual([waiting.status, waiting.payment_status], [
		"complete",
		"unpaid",
	]);
	assert.equal((await control(wins.id, "async_payment_succeeded")).status, 200);
	assert.equal(
		(await s.provider.retrieveCheckout(wins.id)).payment_status,
		"paid",
	);
	const loses = await s.provider.createCheckout(order());
	await control(loses.id, "complete_unpaid");
	assert.equal((await control(loses.id, "async_payment_failed")).status, 200);
	assert.equal(
		(await s.provider.retrieveCheckout(loses.id)).payment_status,
		"unpaid",
	);
	await s.sim.settled();
	assert.deepEqual((await s.events(wins.id)).map((e) => e.type), [
		"checkout.session.completed",
		"checkout.session.async_payment_succeeded",
	]);
	assert.deepEqual((await s.events(loses.id)).map((e) => e.type), [
		"checkout.session.completed",
		"checkout.session.async_payment_failed",
	]);
});

Deno.test("held events wait for release; a resend repeats the same event with a fresh signature", async () => {
	await using s = stack();
	const session = await s.provider.createCheckout(order());
	await fetch(`${s.origin}/_simulator/webhooks/hold`, { method: "POST" });
	await s.act(session.id, "pay");
	await s.sim.settled();
	assert.equal(s.received.length, 0);
	const [queued] = await s.events(session.id);
	assert.equal(queued.held, true);
	assert.equal(
		(await s.provider.retrieveCheckout(session.id)).payment_status,
		"paid",
	);
	const released =
		await (await fetch(`${s.origin}/_simulator/webhooks/release`, {
			method: "POST",
		})).json();
	assert.deepEqual(
		released.map((r: { id: string; status: number }) => [r.id, r.status]),
		[[queued.id, 200]],
	);
	s.answer(500);
	const resent = await (await fetch(
		`${s.origin}/_simulator/events/${queued.id}/resend`,
		{ method: "POST" },
	)).json();
	assert.equal(resent.status, 500);
	assert.equal(s.received.length, 2);
	assert.equal(s.received[1].raw, s.received[0].raw);
	const again = await s.verify(s.received[1].raw, s.received[1].signature);
	assert.equal(again.id, queued.id);
	assert.deepEqual(
		(await s.events(session.id))[0].deliveries.map((d) => d.status),
		[200, 500],
	);
});
