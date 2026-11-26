// A local Stripe Checkout for the compose stack, as Mailpit is its mail server
// (README.md#local-mode): the Checkout Session and FX Quote calls this app makes,
// the hosted page, and webhooks signed as Stripe signs them, for one test-mode
// account that settles in BRL. The page's actions and /_simulator/ stand in for
// a buyer, a bank and the dashboard.
import { simulator } from "./provider.ts";

type Json = Record<string, unknown>;
type Session = Json & {
	id: string;
	status: "open" | "complete" | "expired";
	payment_status: "unpaid" | "paid";
	expires_at: number;
	amount_total: number;
	currency: string;
	ui_mode: "hosted" | "embedded" | "elements";
	return_url: string | null;
	success_url: string | null;
	cancel_url: string | null;
	payment_intent: string | null;
	payment_method_types: string[];
	url: string | null;
};
// What print-check reads of a payment, expanded on its session.
type Intent = {
	id: string;
	object: "payment_intent";
	status: "requires_payment_method" | "requires_action" | "succeeded";
	amount: number;
	currency: string;
};
type Delivery = { at: number; status: number; error: string | null };
type Sent = {
	event: Json & { id: string; type: string };
	payload: string;
	session: string;
	deliveries: Delivery[];
};
export interface SimulatorOptions {
	secretKey: string;
	webhookSecret: string;
	webhookUrl: string;
	checkoutOrigin: string;
	now?: () => number;
}

const encoder = new TextEncoder();
const idempotencyWindow = 24 * 60 * 60;
const alphabet =
	"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const token = (prefix: string, length: number) =>
	prefix +
	Array.from(
		crypto.getRandomValues(new Uint8Array(length)),
		(b) => alphabet[b % alphabet.length],
	).join("");
const escape = (value: unknown) =>
	String(value).replace(
		/[&<>"']/g,
		(c) => `&#${c.charCodeAt(0)};`,
	);

class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly type: string,
		message: string,
		readonly extra: Json = {},
	) {
		super(message);
	}
}
const invalid = (message: string, extra: Json = {}) =>
	new ApiError(400, "invalid_request_error", message, extra);

// Stripe's form encoding: `a[b][0][c]=v`, with numeric keys as list indices.
export function decodeForm(body: string): Json {
	const root: Json = {};
	for (const [key, value] of new URLSearchParams(body)) {
		const head = /^([^[\]]+)((?:\[[^[\]]*\])*)$/.exec(key);
		if (!head) throw invalid(`Invalid parameter name: ${key}`);
		const path = [
			head[1],
			...[...head[2].matchAll(/\[([^[\]]*)\]/g)].map((m) => m[1]),
		];
		let node = root;
		path.forEach((part, index) => {
			if (index === path.length - 1) {
				if (part in node) throw invalid(`Duplicate parameter: ${key}`);
				node[part] = value;
				return;
			}
			const next = node[part] ??= {};
			if (typeof next !== "object") {
				throw invalid(`Invalid parameter: ${key}`);
			}
			node = next as Json;
		});
	}
	const lists = (value: unknown): unknown => {
		if (!value || typeof value !== "object") return value;
		const record = value as Json;
		const keys = Object.keys(record);
		const entries = keys.map((k) => [k, lists(record[k])] as const);
		if (keys.length && keys.every((k, i) => k === String(i))) {
			return entries.map(([, v]) => v);
		}
		return Object.fromEntries(entries);
	};
	return lists(root) as Json;
}

function strings(value: unknown, name: string): Record<string, string> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw invalid(`Invalid hash: ${name}`, { param: name });
	}
	return value as Record<string, string>;
}
function integer(value: unknown, name: string): number {
	const parsed = typeof value === "string" && /^\d+$/.test(value)
		? Number(value)
		: NaN;
	if (!Number.isSafeInteger(parsed)) {
		throw invalid(`Invalid integer: ${name}`, { param: name });
	}
	return parsed;
}
// The parameters this app sends; the simulator refuses what it does not model
// instead of pretending to honour it.
const accepted = [
	"mode",
	"ui_mode",
	"client_reference_id",
	"metadata",
	"payment_intent_data",
	"line_items",
	"billing_address_collection",
	"shipping_address_collection",
	"return_url",
	"success_url",
	"cancel_url",
	"customer_email",
	"expires_at",
	"allowed_payment_method_types",
];
// Pix is a BRL method; Stripe refuses it in any other currency.
const methods = [["card"], ["card", "pix"]];

// Rates as a BRL account's FX Quote states them, fixed so a price is the same on
// every run: the reference rate, and what a unit pays out after Stripe's 2% FX
// fee and the hour's lock premium. BRL per unit of each currency.
export const fxRates: Record<string, { reference: number; exchange: number }> =
	{
		usd: { reference: 5.4012, exchange: 5.287775 },
		gbp: { reference: 7.1035, exchange: 6.954327 },
		ils: { reference: 1.4521, exchange: 1.421606 },
		cny: { reference: 0.7586, exchange: 0.742669 },
		inr: { reference: 0.063126, exchange: 0.0618638 },
		ars: { reference: 0.005632, exchange: 0.005514 },
	};
const locks: Record<string, number> = {
	none: 0,
	five_minutes: 300,
	hour: 3600,
	day: 86400,
};

export function createSimulator(options: SimulatorOptions) {
	const { checkoutOrigin } = options;
	const now = () => Math.floor((options.now ?? Date.now)() / 1000);
	const sessions = new Map<string, Session>();
	const intents = new Map<string, Intent>();
	// What Stripe keeps beside a session: events carry the API version it was
	// created under, the version the app's pinned SDK speaks.
	const kept = new Map<
		string,
		{ version: string; lines: { name: string; amount: number }[] }
	>();
	const idempotency = new Map<
		string,
		{
			fingerprint: string;
			at: number;
			status: number;
			body: string;
			request: string;
		}
	>();
	const events = new Map<string, Sent>();
	const held: string[] = [];
	let holding = false;
	let chain: Promise<unknown> = Promise.resolve();

	async function sign(payload: string, at: number) {
		const key = await crypto.subtle.importKey(
			"raw",
			encoder.encode(options.webhookSecret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const mac = await crypto.subtle.sign(
			"HMAC",
			key,
			encoder.encode(`${at}.${payload}`),
		);
		return `t=${at},v1=${
			Array.from(
				new Uint8Array(mac),
				(b) => b.toString(16).padStart(2, "0"),
			).join("")
		}`;
	}
	// One endpoint, delivered in order. A failed delivery is recorded on the
	// event and waits for a resend; the simulator does not retry on its own.
	function deliver(id: string): Promise<Delivery> {
		const sent = events.get(id)!;
		const run = chain.then(async () => {
			const at = now();
			const delivery: Delivery = { at, status: 0, error: null };
			try {
				const response = await fetch(options.webhookUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json; charset=utf-8",
						"Stripe-Signature": await sign(sent.payload, at),
						"User-Agent": "Stripe/1.0 (+https://stripe.com/docs/webhooks)",
					},
					body: sent.payload,
					signal: AbortSignal.timeout(10000),
				});
				delivery.status = response.status;
				await response.body?.cancel();
			} catch (error) {
				delivery.error = error instanceof Error ? error.message : String(error);
			}
			sent.deliveries.push(delivery);
			return delivery;
		});
		chain = run;
		return run;
	}
	function emit(
		type: string,
		session: Session,
		request: { id: string | null; idempotency_key: string | null },
	) {
		const event = {
			id: token("evt_", 24),
			object: "event",
			api_version: kept.get(session.id)!.version,
			created: now(),
			data: { object: structuredClone(session) },
			livemode: false,
			pending_webhooks: 1,
			request,
			type,
		};
		events.set(event.id, {
			event,
			payload: JSON.stringify(event, null, 2),
			session: session.id,
			deliveries: [],
		});
		if (holding) held.push(event.id);
		else deliver(event.id);
	}
	function expire(session: Session, request: Parameters<typeof emit>[2]) {
		session.status = "expired";
		session.url = null;
		emit("checkout.session.expired", session, request);
	}
	function sweep() {
		for (const session of sessions.values()) {
			if (session.status === "open" && session.expires_at <= now()) {
				expire(session, { id: null, idempotency_key: null });
			}
		}
		for (const [key, entry] of idempotency) {
			if (entry.at + idempotencyWindow <= now()) idempotency.delete(key);
		}
	}
	function find(id: string) {
		const session = sessions.get(id);
		if (!session) {
			throw new ApiError(
				404,
				"invalid_request_error",
				`No such checkout.session: '${id}'`,
				{ code: "resource_missing", param: "session" },
			);
		}
		return session;
	}

	// A session's payment as Stripe keeps it beside the session.
	function charge(session: Session, status: Intent["status"]) {
		session.payment_intent ??= token("pi_", 24);
		intents.set(session.payment_intent, {
			id: session.payment_intent,
			object: "payment_intent",
			status,
			amount: session.amount_total,
			currency: session.currency,
		});
	}
	// A Pix: the buyer finishes Checkout with the code shown, unpaid, and the
	// bank settles or the code lapses later (/_simulator/).
	function completeUnpaid(session: Session, email: string) {
		session.status = "complete";
		charge(session, "requires_action");
		session.url = null;
		session.customer_details = {
			address: null,
			business_name: null,
			email,
			individual_name: null,
			name: null,
			phone: null,
			tax_exempt: "none",
			tax_ids: [],
		};
		session.collected_information = {
			business_name: null,
			individual_name: null,
			shipping_details: null,
		};
		emit("checkout.session.completed", session, {
			id: null,
			idempotency_key: null,
		});
	}
	// What a BRL account's FX Quote answers: each currency's rate into BRL.
	function quote(params: Json): Json {
		for (const key of Object.keys(params)) {
			if (!["to_currency", "from_currencies", "lock_duration"].includes(key)) {
				throw invalid(`The checkout simulator does not model: ${key}`, {
					param: key,
				});
			}
		}
		if (params.to_currency !== "brl") {
			throw invalid("The simulated account settles in brl", {
				param: "to_currency",
			});
		}
		const from = params.from_currencies;
		if (!Array.isArray(from) || !from.length) {
			throw invalid("from_currencies is required", {
				param: "from_currencies",
			});
		}
		const lock = locks[String(params.lock_duration)];
		if (lock === undefined) {
			throw invalid("Invalid lock_duration", { param: "lock_duration" });
		}
		if (from.includes("ars") && params.lock_duration !== "none") {
			throw invalid('Invalid lock_duration for currency. Supported lock durations for ars are: "none".', {
				param: "from_currencies",
			});
		}
		const created = now();
		return {
			id: token("fxq_", 24),
			object: "fx_quote",
			created,
			lock_duration: params.lock_duration,
			lock_expires_at: lock === 0 ? null : created + lock,
			lock_status: lock === 0 ? "none" : "active",
			rates: Object.fromEntries(from.map((currency) => {
				const rate = fxRates[String(currency)];
				if (!rate) {
					throw invalid(`Unsupported currency: ${currency}`, {
						param: "from_currencies",
					});
				}
				return [currency, {
					exchange_rate: rate.exchange,
					rate_details: {
						base_rate: rate.reference,
						duration_premium: 0.001,
						fx_fee_rate: 0.02,
						reference_rate: rate.reference,
						reference_rate_provider: "ecb",
					},
				}];
			})),
			to_currency: "brl",
			usage: {
				payment: { destination: null, on_behalf_of: null },
				transfer: null,
				type: "payment",
			},
		};
	}

	function create(params: Json, version: string): Session {
		for (const key of Object.keys(params)) {
			if (!accepted.includes(key)) {
				throw invalid(`The checkout simulator does not model: ${key}`, {
					param: key,
				});
			}
		}
		if (params.mode !== "payment") {
			throw invalid("The checkout simulator models mode=payment only", {
				param: "mode",
			});
		}
		const items = params.line_items;
		if (!Array.isArray(items) || !items.length) {
			throw invalid("line_items is required in payment mode", {
				param: "line_items",
			});
		}
		let total = 0;
		const currencies = new Set<string>();
		const lines = items.map((raw, index) => {
			const item = raw as Json;
			const price = item.price_data as Json | undefined;
			const product = price?.product_data as Json | undefined;
			if (!price || typeof product?.name !== "string") {
				throw invalid("line_items need price_data with product_data.name", {
					param: `line_items[${index}]`,
				});
			}
			const quantity = integer(item.quantity, `line_items[${index}][quantity]`);
			const unit = integer(
				price.unit_amount,
				`line_items[${index}][price_data][unit_amount]`,
			);
			if (!/^[a-z]{3}$/.test(String(price.currency))) {
				throw invalid("Invalid currency", {
					param: `line_items[${index}][price_data][currency]`,
				});
			}
			currencies.add(String(price.currency));
			total += quantity * unit;
			return { name: product.name, quantity, amount: quantity * unit };
		});
		if (currencies.size !== 1) {
			throw invalid("All line items must share one currency");
		}
		const uiMode = (params.ui_mode ?? "hosted") as string;
		if (uiMode !== "hosted" && uiMode !== "embedded" && uiMode !== "elements") {
			throw invalid("The checkout simulator models ui_mode=hosted, embedded or elements", {
				param: "ui_mode",
			});
		}
		if (uiMode !== "hosted") {
			if (typeof params.return_url !== "string" || !URL.canParse(params.return_url)) {
				throw invalid("Not a valid URL: return_url", { param: "return_url" });
			}
			for (const url of ["success_url", "cancel_url"]) {
				if (params[url] !== undefined) {
					throw invalid(`${url} is not used when ui_mode=${uiMode}`, {
						param: url,
					});
				}
			}
		} else {
			if (params.return_url !== undefined) {
				throw invalid("return_url is not used when ui_mode=hosted", {
					param: "return_url",
				});
			}
			for (const url of ["success_url", "cancel_url"]) {
				if (params[url] === undefined && url === "cancel_url") continue;
				if (typeof params[url] !== "string" || !URL.canParse(params[url])) {
					throw invalid(`Not a valid URL: ${url}`, { param: url });
				}
			}
		}
		const created = now();
		const expires = params.expires_at === undefined
			? created + 24 * 60 * 60
			: integer(params.expires_at, "expires_at");
		if (expires < created + 30 * 60 || expires > created + 24 * 60 * 60) {
			throw invalid("expires_at must be 30 minutes to 24 hours away", {
				param: "expires_at",
			});
		}
		const types = params.allowed_payment_method_types ?? ["card"];
		if (!methods.some((m) => JSON.stringify(m) === JSON.stringify(types))) {
			throw invalid("The checkout simulator models card, or card and pix", {
				param: "allowed_payment_method_types",
			});
		}
		if ((types as string[]).includes("pix") && !currencies.has("brl")) {
			throw invalid("pix is only available for brl", {
				param: "allowed_payment_method_types",
			});
		}
		if (
			params.customer_email !== undefined &&
			!/^[^\s@]+@[^\s@]+$/.test(String(params.customer_email))
		) {
			throw invalid("Invalid email address", { param: "customer_email" });
		}
		const shipping = params.shipping_address_collection as Json | undefined;
		if (
			shipping &&
			(!Array.isArray(shipping.allowed_countries) ||
				!shipping.allowed_countries.length)
		) {
			throw invalid("allowed_countries is required", {
				param: "shipping_address_collection[allowed_countries]",
			});
		}
		const id = token("cs_test_", 58);
		const currency = [...currencies][0];
		const session: Session = {
			id,
			object: "checkout.session",
			adaptive_pricing: { enabled: false },
			after_expiration: null,
			allow_promotion_codes: null,
			amount_subtotal: total,
			amount_total: total,
			automatic_tax: {
				enabled: false,
				liability: null,
				provider: null,
				status: null,
			},
			billing_address_collection: params.billing_address_collection ?? null,
			cancel_url: (params.cancel_url as string | undefined) ?? null,
			client_reference_id: params.client_reference_id ?? null,
			client_secret: uiMode !== "hosted"
				? `${id}_secret_${token("", 24)}`
				: null,
			collected_information: null,
			consent: null,
			consent_collection: null,
			created,
			currency,
			currency_conversion: null,
			custom_fields: [],
			custom_text: {
				after_submit: null,
				shipping_address: null,
				submit: null,
				terms_of_service_acceptance: null,
			},
			customer: null,
			customer_account: null,
			customer_creation: "if_required",
			customer_details: null,
			customer_email: params.customer_email ?? null,
			discounts: [],
			expires_at: expires,
			integration_identifier: null,
			invoice: null,
			invoice_creation: null,
			livemode: false,
			locale: null,
			managed_payments: null,
			metadata: strings(params.metadata, "metadata"),
			mode: "payment",
			origin_context: null,
			payment_intent: null,
			payment_link: null,
			payment_method_collection: "if_required",
			payment_method_configuration_details: null,
			payment_method_options: {},
			payment_method_types: types as string[],
			allowed_payment_method_types: params.allowed_payment_method_types ?? null,
			payment_status: "unpaid",
			permissions: null,
			recovered_from: null,
			return_url: (params.return_url as string | undefined) ?? null,
			saved_payment_method_options: null,
			setup_intent: null,
			shipping_address_collection: shipping
				? { allowed_countries: shipping.allowed_countries }
				: null,
			shipping_cost: null,
			shipping_options: [],
			status: "open",
			submit_type: null,
			subscription: null,
			success_url: (params.success_url as string | undefined) ?? null,
			simulator_origin: checkoutOrigin,
			total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
			ui_mode: uiMode,
			url: uiMode === "hosted" ? `${checkoutOrigin}/c/pay/${id}` : null,
			wallet_options: null,
		};
		sessions.set(id, session);
		kept.set(id, { version, lines });
		return session;
	}

	function authorize(req: Request) {
		const header = req.headers.get("Authorization") ?? "";
		if (!header) {
			throw new ApiError(
				401,
				"invalid_request_error",
				"You did not provide an API key.",
			);
		}
		if (header !== `Bearer ${options.secretKey}`) {
			throw new ApiError(
				401,
				"invalid_request_error",
				"Invalid API Key provided.",
			);
		}
	}
	async function api(req: Request, path: string): Promise<Response> {
		authorize(req);
		const request = token("req_", 14);
		const key = req.method === "POST"
			? req.headers.get("Idempotency-Key")
			: null;
		const reply = (status: number, body: string, replayed?: string) =>
			new Response(body, {
				status,
				headers: {
					"Content-Type": "application/json",
					"Request-Id": replayed ?? request,
					"Stripe-Version": req.headers.get("Stripe-Version") ?? "",
					...(key ? { "Idempotency-Key": key } : {}),
					...(replayed ? { "Idempotent-Replayed": "true" } : {}),
				},
			});
		const run = async (key: string | null): Promise<[number, Json]> => {
			const version = req.headers.get("Stripe-Version");
			if (!version) throw invalid("The simulator requires Stripe-Version");
			if (req.method === "POST" && path === "/v1/checkout/sessions") {
				const params = decodeForm(await req.text());
				return [200, create(params, version)];
			}
			if (req.method === "POST" && path === "/v1/fx_quotes") {
				if (version !== "2025-04-30.preview") {
					throw invalid("FX Quotes need Stripe-Version 2025-04-30.preview");
				}
				return [200, quote(decodeForm(await req.text()))];
			}
			const one = /^\/v1\/checkout\/sessions\/([A-Za-z0-9_]+)$/.exec(path);
			if (req.method === "GET" && one) {
				const session = find(one[1]);
				const expand = new URL(req.url).searchParams.getAll("expand[]");
				if (expand.some((field) => field !== "payment_intent")) {
					throw invalid("The checkout simulator expands payment_intent alone", {
						param: "expand",
					});
				}
				if (!expand.length) return [200, session];
				return [200, {
					...session,
					payment_intent: session.payment_intent &&
						intents.get(session.payment_intent),
				}];
			}
			const end = /^\/v1\/checkout\/sessions\/([A-Za-z0-9_]+)\/expire$/
				.exec(path);
			if (req.method === "POST" && end) {
				const session = find(end[1]);
				if (session.status !== "open") {
					throw invalid(
						'Only Checkout Sessions with a status in ["open"] can be expired.',
					);
				}
				expire(session, { id: request, idempotency_key: key });
				return [200, session];
			}
			throw new ApiError(
				404,
				"invalid_request_error",
				`Unrecognized request URL (${req.method}: ${path}).`,
			);
		};
		if (!key) {
			const [status, body] = await run(null);
			return reply(status, JSON.stringify(body));
		}
		const body = await req.clone().text();
		const fingerprint = `${req.method} ${path} ${body}`;
		const prior = idempotency.get(key);
		if (prior) {
			if (prior.fingerprint !== fingerprint) {
				throw new ApiError(
					400,
					"idempotency_error",
					`Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${key}' if you meant to execute a different request.`,
				);
			}
			return reply(prior.status, prior.body, prior.request);
		}
		let status: number;
		let result: string;
		try {
			const [code, value] = await run(key);
			status = code;
			result = JSON.stringify(value);
		} catch (error) {
			// Stripe saves a 400 under its key; it does not save 401 or 5xx.
			if (!(error instanceof ApiError) || error.status !== 400) throw error;
			status = 400;
			result = JSON.stringify({
				error: { type: error.type, message: error.message, ...error.extra },
			});
		}
		idempotency.set(key, {
			fingerprint,
			at: now(),
			status,
			body: result,
			request,
		});
		return reply(status, result);
	}

	const money = (session: Session, amount: number) => {
		const currency = session.currency.toUpperCase();
		const digits = new Intl.NumberFormat("en", { style: "currency", currency })
			.resolvedOptions().maximumFractionDigits ?? 2;
		return new Intl.NumberFormat("en", { style: "currency", currency })
			.format(amount / 10 ** digits);
	};
	function page(session: Session, outcome: string | null = null) {
		const lines = kept.get(session.id)!.lines
			.map((line) =>
				`<li><span>${escape(line.name)}</span><span>${
					escape(money(session, line.amount))
				}</span></li>`
			).join("");
		const targets = [session.success_url, session.cancel_url, session.return_url]
			.filter((u): u is string => !!u).map((u) => new URL(u).origin);
		const embedded = session.ui_mode !== "hosted";
		const notify = embedded && (outcome === "completed" || outcome === "cancelled")
			? `<script>parent.postMessage({ type: "stripe-simulator:checkout", outcome: "${
				escape(outcome)
			}", session: "${escape(session.id)}" }, "*");</script>`
			: "";
		const resize = embedded
			? `<script>(function(){var m=document.querySelector("main"),s=function(){parent.postMessage({type:"stripe-simulator:resize",height:Math.ceil(m.getBoundingClientRect().height)},"*")};s();if(typeof ResizeObserver!=="undefined")new ResizeObserver(s).observe(m);addEventListener("load",s)})();</script>`
			: "";
		const allowed = session.shipping_address_collection as
			| { allowed_countries: string[] }
			| null;
		const message = outcome === "declined"
			? '<p class="note error" role="alert">Your card was declined.</p>'
			: "";
		const body = session.status !== "open"
			? `<p class="note">This Checkout Session is ${escape(session.status)}${
				session.status === "complete"
					? ` and ${escape(session.payment_status)}`
					: ""
			}. Nothing more can be paid here.</p>`
			: `<form method="post">
	${embedded ? '<input type="hidden" name="embedded" value="1">' : ""}
	${message}
	<label>Email <input name="email" type="email" required value="${
				escape(session.customer_email ?? "")
			}" autocomplete="email"></label>
	${
				allowed
					? `<label>Shipping country <select name="country">${
						allowed.allowed_countries.map((c) =>
							`<option>${escape(c)}</option>`
						).join("")
					}</select></label>`
					: ""
			}
	<button name="action" value="pay" class="pay">Pay ${
				escape(money(session, session.amount_total))
			}</button>
	${
				session.payment_method_types.includes("pix")
					? '<button name="action" value="pix">Pay with Pix (the bank settles later)</button>'
					: ""
			}
	<button name="action" value="decline" formnovalidate>Pay with a declined card</button>
	${
				session.cancel_url
					? `<a href="${escape(session.cancel_url)}">Cancel and return</a>`
					: embedded
					? '<button name="action" value="cancel" formnovalidate class="quiet">Cancel and return</button>'
					: ""
			}
	<button name="action" value="expire" formnovalidate class="quiet">Expire this session</button>
</form>`;
		const style = embedded
			? `:root { color-scheme: light; --ink: #24211e; --muted: #5d5142; --line: #cfc3b1; --paper: #faf7f2; --field: #fffdf9; --accent: #28231e; --accent-hover: #4a3728; --link: #7e451e; --error: #793c33; --error-bg: #f6e9e5; --error-line: #a84739; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; overflow: hidden; font: 15px/1.45 system-ui, -apple-system, sans-serif; color: var(--ink); background: transparent; }
main { display: grid; gap: 12px; padding: 2px 0 4px; }
.banner { margin: 0; font: 700 10px/1.4 system-ui, sans-serif; text-transform: uppercase; letter-spacing: .12em; color: #796850; border: 1px dashed #d7b58d; background: #f1eadf; padding: 7px 10px; border-radius: 3px; }
form { display: grid; gap: 10px; }
label { display: grid; gap: 4px; font-size: 12.5px; font-weight: 600; color: var(--muted); }
input, select { font: 600 15px/1.35 system-ui, sans-serif; height: 40px; padding: 0 12px; border: 1px solid var(--line); border-radius: 3px; background: var(--field); color: var(--ink); }
input:focus-visible, select:focus-visible { outline: 2px solid #7e451e; outline-offset: 1px; border-color: #7e451e; }
button { font: 600 14px/1.25 system-ui, sans-serif; min-height: 40px; padding: 9px 14px; border-radius: 3px; border: 1px solid var(--line); background: var(--field); color: var(--ink); cursor: pointer; transition: background-color .14s ease, border-color .14s ease; }
button:hover { background: #f1eadf; border-color: #8b7965; }
button.pay { min-height: 46px; background: var(--accent); border-color: var(--accent); color: #fffaf2; font-size: 15px; font-weight: 700; }
button.pay:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
button.quiet { min-height: 34px; padding: 6px 10px; border: 0; background: transparent; color: var(--link); font-weight: 600; text-decoration: underline; text-underline-offset: 3px; }
button.quiet:hover { background: transparent; color: var(--ink); }
a { color: var(--link); text-align: center; font-weight: 600; }
.note { margin: 0; padding: 10px 12px; border-radius: 3px; border: 1px solid #ded6ca; border-left: 2px solid #c39855; background: #f1eadf; color: var(--muted); font-size: 13px; }
.error { color: var(--error); background: var(--error-bg); border-color: #e6cfc8; border-left: 2px solid var(--error-line); }`
			: `:root { color-scheme: light dark; --ink: #1a1f36; --muted: #697386; --line: #e3e8ee; --paper: #fff; --accent: #635bff; --error: #df1b41; }
@media (prefers-color-scheme: dark) { :root { --ink: #e8eaf0; --muted: #a3acb9; --line: #3c4257; --paper: #1a1f36; } }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, sans-serif; color: var(--ink); background: var(--paper); }
main { max-width: 26rem; margin: 0 auto; padding: 2rem 1rem; }
.banner { font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); border: 1px dashed var(--line); padding: .5rem .75rem; border-radius: .5rem; }
ul { list-style: none; padding: 0; margin: 1.5rem 0; border-block: 1px solid var(--line); }
li { display: flex; justify-content: space-between; padding: .75rem 0; }
form { display: grid; gap: .75rem; }
label { display: grid; gap: .25rem; font-size: .9rem; color: var(--muted); }
input, select { font: inherit; padding: .6rem .75rem; border: 1px solid var(--line); border-radius: .4rem; background: var(--paper); color: var(--ink); }
button { font: inherit; padding: .7rem; border-radius: .4rem; border: 1px solid var(--line); background: var(--paper); color: var(--ink); cursor: pointer; }
button.pay { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
button.quiet { border-style: dashed; color: var(--muted); }
a { color: var(--accent); text-align: center; }
.note { margin: 0; padding: .75rem; border-radius: .4rem; border: 1px solid var(--line); }
.error { color: var(--error); border-color: var(--error); }`;
		return new Response(
			`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Checkout simulator</title>
<link rel="icon" href="data:,">
<style>
${style}
</style>
</head>
<body>
<main data-session="${escape(session.id)}" data-status="${
				escape(session.status)
			}" data-payment-status="${escape(session.payment_status)}"${
				outcome ? ` data-outcome="${escape(outcome)}"` : ""
			}>
<p class="banner">Local Checkout simulator · test mode · no money moves</p>
${embedded ? "" : `<ul>${lines}</ul>`}
${body}
${resize}${notify}
</main>
</body>
</html>`,
			{
				status: 200,
				headers: {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
					"Content-Security-Policy":
						`default-src 'none'; style-src 'unsafe-inline';${
							embedded || notify ? " script-src 'unsafe-inline';" : ""
						} img-src data:; form-action 'self' ${
							targets.join(" ")
						}; frame-ancestors ${
							embedded ? "'self' https: http:" : "'none'"
						}; base-uri 'none'`,
				},
			},
		);
	}
	async function hosted(req: Request, id: string): Promise<Response> {
		const session = sessions.get(id);
		if (!session) {
			return new Response("No such Checkout Session", { status: 404 });
		}
		if (req.method === "GET") return page(session);
		const form = new URLSearchParams(await req.text());
		const action = form.get("action");
		const embedded = form.get("embedded") === "1";
		const returnTarget = (session.success_url ?? session.return_url ?? "").replaceAll(
			"{CHECKOUT_SESSION_ID}",
			session.id,
		);
		if (session.status !== "open") return page(session);
		const quiet = { id: null, idempotency_key: null };
		if (action === "pay") {
			const email = form.get("email") ?? "";
			if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
				return new Response("An email is required", { status: 400 });
			}
			const allowed = (session.shipping_address_collection as
				| { allowed_countries: string[] }
				| null)?.allowed_countries;
			const country = form.get("country");
			if (allowed && !allowed.includes(country ?? "")) {
				return new Response("A shipping country is required", {
					status: 400,
				});
			}
			session.status = "complete";
			session.payment_status = "paid";
			charge(session, "succeeded");
			session.url = null;
			session.customer_details = {
				address: null,
				business_name: null,
				email,
				individual_name: null,
				name: null,
				phone: null,
				tax_exempt: "none",
				tax_ids: [],
			};
			session.collected_information = {
				business_name: null,
				individual_name: null,
				shipping_details: allowed
					? {
						name: email,
						address: {
							city: null,
							country,
							line1: null,
							line2: null,
							postal_code: null,
							state: null,
						},
					}
					: null,
			};
			emit("checkout.session.completed", session, quiet);
			if (embedded) return page(session, "completed");
			return Response.redirect(returnTarget, 303);
		}
		// A declined card leaves the session open and unpaid behind an attempted
		// PaymentIntent; no checkout.session event is sent.
		if (action === "decline") {
			charge(session, "requires_payment_method");
			return page(session, "declined");
		}
		if (action === "pix" && session.payment_method_types.includes("pix")) {
			const email = form.get("email") ?? "";
			if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
				return new Response("An email is required", { status: 400 });
			}
			completeUnpaid(session, email);
			if (embedded) return page(session, "completed");
			return Response.redirect(returnTarget, 303);
		}
		if (action === "cancel") {
			return page(session, "cancelled");
		}
		if (action === "expire") {
			expire(session, quiet);
			return page(session);
		}
		return new Response("Unknown action", { status: 400 });
	}
	async function control(req: Request, path: string): Promise<Response> {
		if (req.method === "GET" && path === "/_simulator/health") {
			return new Response("ok");
		}
		if (req.method === "GET" && path === "/_simulator/events") {
			const session = new URL(req.url).searchParams.get("session");
			return Response.json(
				[...events.values()]
					.filter((sent) => !session || sent.session === session)
					.map((sent) => ({
						id: sent.event.id,
						type: sent.event.type,
						session: sent.session,
						held: held.includes(sent.event.id),
						deliveries: sent.deliveries,
					})),
			);
		}
		if (req.method === "POST" && path === "/_simulator/webhooks/hold") {
			holding = true;
			return new Response(null, { status: 204 });
		}
		if (req.method === "POST" && path === "/_simulator/webhooks/release") {
			holding = false;
			const released = held.splice(0);
			const deliveries = await Promise.all(released.map(deliver));
			return Response.json(
				released.map((id, i) => ({
					id,
					type: events.get(id)!.event.type,
					...deliveries[i],
				})),
			);
		}
		const resend = /^\/_simulator\/events\/(evt_[A-Za-z0-9]+)\/resend$/
			.exec(path);
		if (req.method === "POST" && resend) {
			if (!events.has(resend[1])) {
				return Response.json({ error: "no such event" }, { status: 404 });
			}
			return Response.json(await deliver(resend[1]));
		}
		// An asynchronous payment method: the buyer completes without paying,
		// and the payment succeeds or fails later.
		const step =
			/^\/_simulator\/checkout\/sessions\/([A-Za-z0-9_]+)\/(complete_unpaid|async_payment_succeeded|async_payment_failed)$/
				.exec(path);
		if (req.method === "POST" && step) {
			const session = sessions.get(step[1]);
			if (!session) {
				return Response.json({ error: "no such session" }, { status: 404 });
			}
			const quiet = { id: null, idempotency_key: null };
			if (step[2] === "complete_unpaid") {
				if (session.status !== "open") {
					return Response.json({ error: "session is not open" }, {
						status: 409,
					});
				}
				completeUnpaid(session, "buyer@example.test");
			} else {
				if (
					session.status !== "complete" || session.payment_status !== "unpaid"
				) {
					return Response.json({ error: "no payment is pending" }, {
						status: 409,
					});
				}
				if (step[2] === "async_payment_succeeded") {
					session.payment_status = "paid";
					charge(session, "succeeded");
				} else charge(session, "requires_payment_method");
				emit(`checkout.session.${step[2]}`, session, quiet);
			}
			return Response.json(session);
		}
		return Response.json({ error: "not found" }, { status: 404 });
	}

	function sdkScript(): Response {
		const origin = JSON.stringify(checkoutOrigin);
		return new Response(
			`"use strict";
globalThis.Stripe = function Stripe(publishableKey) {
	if (typeof publishableKey !== "string" || !(publishableKey.startsWith("pk_") || publishableKey === "simulator")) {
		throw new Error("Invalid Stripe publishable key");
	}
	function initCheckout(options) {
		const secret = String(options && options.clientSecret || "");
		const match = /^(cs_test_[A-Za-z0-9]+)_secret_[A-Za-z0-9]+$/.exec(secret);
		if (!match) return Promise.reject(new Error("Invalid Checkout Session clientSecret"));
		const sessionId = match[1];
		const mount = (target) => {
			const host = typeof target === "string" ? document.querySelector(target) : target;
			if (!host) throw new Error("Stripe mount target not found");
			const frame = document.createElement("iframe");
			frame.id = "checkout-frame";
			frame.setAttribute("allow", "payment");
			frame.setAttribute("scrolling", "no");
			frame.src = ${origin} + "/c/pay/" + encodeURIComponent(sessionId);
			host.replaceChildren(frame);
			return frame;
		};
		return Promise.resolve({
			mount,
			createPaymentElement() {
				return { mount };
			},
		});
	}
	return {
		initCheckout,
		initCheckoutElementsSdk: initCheckout,
		initCustomCheckout: initCheckout,
		initEmbeddedCheckout: initCheckout,
	};
};
`,
			{
				status: 200,
				headers: {
					"Content-Type": "text/javascript; charset=utf-8",
					"Cache-Control": "no-store",
					"Access-Control-Allow-Origin": "*",
				},
			},
		);
	}

	return {
		sweep,
		// Every delivery queued so far has finished.
		settled: () => chain.then(() => undefined),
		async fetch(req: Request): Promise<Response> {
			sweep();
			const path = new URL(req.url).pathname;
			// Stripe.js as the Clover release is addressed, the one the payment unit calls.
			if (req.method === "GET" && path === "/clover/stripe.js") {
				return sdkScript();
			}
			if (path.startsWith("/v1/")) {
				try {
					return await api(req, path);
				} catch (error) {
					if (!(error instanceof ApiError)) throw error;
					return Response.json({
						error: { type: error.type, message: error.message, ...error.extra },
					}, { status: error.status });
				}
			}
			const hostedPath = /^\/c\/pay\/([A-Za-z0-9_]+)$/.exec(path);
			if (hostedPath) return await hosted(req, hostedPath[1]);
			if (path.startsWith("/_simulator/")) return await control(req, path);
			return new Response("Not found", { status: 404 });
		},
	};
}

if (import.meta.main) {
	const required = (name: string) => {
		const value = Deno.env.get(name);
		if (!value) throw new Error(`Missing simulator setting: ${name}`);
		return value;
	};
	const isHost = Deno.env.get("SAYT_PLATFORM") === "host";
	const listenPort = Number(Deno.env.get("PORT") ?? "8080");
	const sim = createSimulator({
		secretKey: required("STRIPE_SECRET_KEY"),
		webhookSecret: required("STRIPE_WEBHOOK_SECRET"),
		webhookUrl: required("WEBHOOK_URL"),
		checkoutOrigin: isHost
			? `http://localhost:${listenPort}`
			: simulator.checkout,
	});
	setInterval(sim.sweep, 30000);
	Deno.serve(
		{
			hostname: isHost ? "127.0.0.1" : "0.0.0.0",
			port: listenPort,
		},
		sim.fetch,
	);
}
