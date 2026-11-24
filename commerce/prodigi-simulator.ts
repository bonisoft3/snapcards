// A local Prodigi for the compose stack, as Mailpit is its mail server
// (README.md#local-mode): the v4 calls this app makes, in the shapes the sandbox
// answered with; artwork fetched and measured the way a lab would; callbacks
// sent, unsigned, as v4 sends them. /_simulator/ stands in for the dashboard and
// for failure.
import { jpegSize, layoutProblem, postcard } from "./catalogue.ts";

type Json = Record<string, unknown>;
type Asset = { printArea: string; url: string };
type Item = { sku: string; copies: number; sizing?: string; assets: Asset[] };
export type SimOrder = {
	id: string;
	merchantReference: string | null;
	callbackUrl: string | null;
	idempotencyKey: string | null;
	shippingMethod: string | null;
	status: {
		stage: string;
		issues: { objectId: string; errorCode: string; description: string }[];
		details: Record<string, string>;
	};
	recipient: Json;
	items: Item[];
	shipments?: {
		carrier: { name: string; service: string };
		dispatchDate: string;
		tracking: { number: string; url: string };
	}[];
	created: string;
	// Not on the wire: what the lab measured and how often it was asked.
	fetched: { url: string; type: string; width: number; height: number }[];
	placements: number;
};
export interface ProdigiSimulatorOptions {
	apiKey: string;
	// Where the lab reaches what an order names: its URLs carry the origin the
	// reader's browser sees, which only the host resolves.
	door?: string;
	now?: () => number;
}
type Failure = "refuse" | "lost_answer" | "server_error" | "fulfilment_issue";

const known = Object.values(postcard.skus);
const failure = (
	code: string,
	failures: Record<string, { code: string; providedValue?: unknown }[]>,
	status = 400,
) =>
	Response.json({ outcome: code, failures, traceParent: crypto.randomUUID() }, {
		status,
	});
// Hundredths, the sandbox's answers for these SKUs to Brazil. BRL is refused as
// it is there.
const carriers = [
	{ method: "Budget", carrier: "P2P", service: "FedEx P2P UnTrak" },
	{
		method: "Standard",
		carrier: "Royal Mail",
		service: "Royal Mail International Tracked",
	},
];
const tariffs: Record<string, { card: number; methods: number[] }> = {
	USD: { card: 54, methods: [530, 1738] },
	GBP: { card: 40, methods: [395, 1295] },
};

function imageSize(bytes: Uint8Array) {
	if (bytes[0] === 0x89 && bytes[1] === 0x50) {
		const view = new DataView(bytes.buffer, bytes.byteOffset);
		return {
			type: "png",
			width: view.getUint32(16),
			height: view.getUint32(20),
		};
	}
	const size = jpegSize(bytes);
	return size && { type: "jpeg", ...size };
}
function itemFailures(items: unknown, withUrls: boolean) {
	const failures: Record<string, { code: string; providedValue?: unknown }[]> =
		{};
	if (!Array.isArray(items) || !items.length) {
		failures.items = [{ code: "MustNotBeEmpty" }];
		return failures;
	}
	items.forEach((raw: Json, index) => {
		const path = `items[${index}]`;
		if (!known.includes(raw.sku as string)) {
			failures[`${path}.sku`] = [{
				code: "ItemNotFound",
				providedValue: raw.sku,
			}];
		}
		if (!Number.isInteger(raw.copies) || (raw.copies as number) < 1) {
			failures[`${path}.copies`] = [{ code: "MustBeGreaterThanZero" }];
		}
		if (
			withUrls &&
			!["fillPrintArea", "fitPrintArea", "stretchToPrintArea"].includes(
				raw.sizing as string,
			)
		) failures[`${path}.sizing`] = [{ code: "MustBeAValidSizing" }];
		const assets = (raw.assets ?? []) as Json[];
		const unexpected = assets.filter((a) => a.printArea !== postcard.printArea);
		const codes = [];
		if (assets.length === unexpected.length) {
			codes.push({ code: "MissingRequiredAssets", providedValue: assets });
		}
		if (unexpected.length) {
			codes.push({ code: "UnexpectedAssets", providedValue: unexpected });
		}
		if (withUrls && assets.some((a) => !URL.canParse(String(a.url)))) {
			codes.push({ code: "MustBeAValidUrl" });
		}
		if (codes.length) failures[`${path}.assets`] = codes;
	});
	return failures;
}
function addressFailures(value: unknown) {
	const address = (value ?? {}) as Record<string, unknown>;
	const failures: Record<string, { code: string }[]> = {};
	for (
		const field of ["line1", "townOrCity", "postalOrZipCode", "countryCode"]
	) {
		if (typeof address[field] !== "string" || !address[field]) {
			failures[`recipient.address.${field}`] = [{ code: "MustNotBeEmpty" }];
		}
	}
	const country = address.countryCode;
	if (typeof country === "string" && !/^[A-Z]{2}$/.test(country)) {
		failures["recipient.address.countryCode"] = [{
			code: "InvalidCountryCode",
		}];
	}
	return failures;
}
const notStarted = () => ({
	downloadAssets: "NotStarted",
	printReadyAssetsPrepared: "NotStarted",
	allocateProductionLocation: "NotStarted",
	inProduction: "NotStarted",
	shipping: "NotStarted",
});

export function createProdigiSimulator(options: ProdigiSimulatorOptions) {
	// The lab measures files without decoding them, so it holds the layout they
	// were drawn to; the pixels themselves are checked in checkout-ui/test.ts and
	// acceptance.
	const layout = layoutProblem();
	if (layout) throw new Error(layout);
	const now = options.now ?? Date.now;
	const orders = new Map<string, SimOrder>();
	const claimed = new Map<string, string>();
	const queued: Failure[] = [];
	const sent = new Map<string, { url: string; payload: string }>();
	const deliveries: { id: string; type: string; status: number }[] = [];
	let labWork: Promise<unknown> = Promise.resolve();

	const reachable = (url: string) => {
		if (!options.door) return url;
		const { pathname, search } = new URL(url);
		return `${options.door}${pathname}${search}`;
	};
	const wire = (order: SimOrder) => {
		const { fetched: _fetched, placements: _placements, ...rest } = order;
		return rest;
	};
	async function deliver(id: string) {
		const { url, payload } = sent.get(id)!;
		const response = await fetch(reachable(url), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"User-Agent": "Prodigi-Fulfilment/1.0 (+https://www.prodigi.com)",
			},
			body: payload,
			signal: AbortSignal.timeout(15000),
		});
		await response.body?.cancel();
		deliveries.push({
			id,
			type: JSON.parse(payload).type,
			status: response.status,
		});
		return response.status;
	}
	function emit(order: SimOrder, path: string, value: string) {
		if (!order.callbackUrl) return Promise.resolve(0);
		const id = `evt_${crypto.randomUUID()}`;
		sent.set(id, {
			url: order.callbackUrl,
			payload: JSON.stringify({
				specversion: "1.0",
				type: `com.prodigi.order.status.${path}.changed#${value}`,
				source: "http://prodigi-simulator:8080/v4.0/Orders/",
				id,
				time: new Date(now()).toISOString(),
				datacontenttype: "application/json",
				data: { order: wire(order) },
				subject: order.id,
			}),
		});
		return deliver(id);
	}
	async function measure(order: SimOrder, asset: Asset) {
		let response: Response;
		try {
			response = await fetch(reachable(asset.url), { signal: AbortSignal.timeout(10000) });
		} catch (error) {
			return `Could not download ${asset.url}: ${error}`;
		}
		if (!response.ok) {
			await response.body?.cancel();
			return `Could not download ${asset.url}: ${response.status}`;
		}
		const contentType = response.headers.get("Content-Type") ?? "";
		const bytes = new Uint8Array(await response.arrayBuffer());
		const size = imageSize(bytes);
		if (!size || !contentType.startsWith(`image/${size.type}`)) {
			return `${asset.url} is not the image it says it is (${contentType})`;
		}
		order.fetched.push({ url: asset.url, ...size });
		if (size.width !== postcard.widthPx || size.height !== postcard.heightPx) {
			return `${asset.url} is ${size.width}×${size.height}, not ${postcard.widthPx}×${postcard.heightPx}`;
		}
		return null;
	}
	async function produce(order: SimOrder, fail?: Failure) {
		order.status.details.downloadAssets = "InProgress";
		const problems = [];
		for (const item of order.items) {
			for (const asset of item.assets) {
				const problem = await measure(order, asset);
				if (problem) problems.push(problem);
			}
		}
		if (fail === "fulfilment_issue") {
			problems.push("The simulator was told to refuse this order");
		}
		order.status.issues = problems.map((description) => ({
			objectId: order.id,
			errorCode: "order.items.assets.FailedToDownloaded",
			description,
		}));
		order.status.details.downloadAssets = problems.length
			? "Error"
			: "Complete";
		if (!problems.length) {
			order.status.details.printReadyAssetsPrepared = "Complete";
			order.status.details.allocateProductionLocation = "Complete";
			order.status.details.inProduction = "InProgress";
		}
		await emit(
			order,
			"details.downloadAssets",
			problems.length ? "Error" : "Complete",
		);
	}
	function quote(body: Json) {
		const failures = itemFailures(body.items, false);
		if (typeof body.destinationCountryCode !== "string") {
			failures.destinationCountryCode = [{ code: "MustNotBeEmpty" }];
		}
		const currency = String(body.currencyCode);
		const tariff = tariffs[currency];
		if (!tariff) {
			failures.currencyCode = [{
				code: "MustBeASupportedCurencyCode",
				providedValue: body.currencyCode,
			}];
		}
		if (Object.keys(failures).length) {
			return failure("ValidationFailed", failures);
		}
		const cards = (body.items as { copies: number }[])
			.reduce((sum, item) => sum + item.copies, 0);
		const items = cards * tariff.card;
		const money = (hundredths: number) => ({
			amount: (hundredths / 100).toFixed(2),
			currency,
		});
		return Response.json({
			outcome: "Created",
			issues: null,
			quotes: carriers.map(({ method, carrier, service }, index) => {
				const cost = tariff.methods[index];
				return {
					shipmentMethod: method,
					costSummary: {
						items: money(items),
						shipping: money(cost),
						branding: money(0),
						totalCost: money(items + cost),
						totalTax: money(0),
					},
					shipments: [{
						carrier: { name: carrier, service },
						fulfillmentLocation: { countryCode: "GB", labCode: "simulated" },
						cost: money(cost),
					}],
				};
			}),
		});
	}
	function place(body: Json) {
		const key = body.idempotencyKey as string | undefined;
		if (key && claimed.has(key)) {
			const existing = orders.get(claimed.get(key)!)!;
			existing.placements++;
			return Response.json({ outcome: "AlreadyExists", order: wire(existing) });
		}
		const fail = queued.shift();
		if (fail === "refuse") {
			return failure("ValidationFailed", {
				"items[0].sku": [{ code: "ItemNotFound" }],
			});
		}
		if (fail === "server_error") {
			return Response.json({ outcome: "InternalServerError" }, { status: 500 });
		}
		const recipient = (body.recipient ?? {}) as Json;
		const failures: Record<string, { code: string }[]> = {
			...itemFailures(body.items, true),
			...addressFailures(recipient.address),
		};
		if (!recipient.name) {
			failures["recipient.name"] = [{ code: "MustNotBeEmpty" }];
		}
		if (Object.keys(failures).length) {
			return failure("ValidationFailed", failures);
		}
		const order: SimOrder = {
			id: `ord_${crypto.randomUUID()}`,
			merchantReference: (body.merchantReference as string) ?? null,
			callbackUrl: (body.callbackUrl as string) ?? null,
			idempotencyKey: key ?? null,
			shippingMethod: (body.shippingMethod as string) ?? null,
			status: { stage: "InProgress", issues: [], details: notStarted() },
			recipient,
			items: body.items as Item[],
			created: new Date(now()).toISOString(),
			fetched: [],
			placements: 1,
		};
		orders.set(order.id, order);
		if (key) claimed.set(key, order.id);
		labWork = labWork.then(() => produce(order, fail));
		// The order exists; only its answer is lost.
		if (fail === "lost_answer") {
			return Response.json({ outcome: "InternalServerError" }, { status: 500 });
		}
		return Response.json({ outcome: "Created", order: wire(order) });
	}
	function product(sku: string) {
		if (!known.includes(sku)) {
			return Response.json({ outcome: "EntityNotFound" }, { status: 404 });
		}
		return Response.json({
			outcome: "Ok",
			product: {
				sku,
				productDimensions: { width: 15.2, height: 10.2, units: "cm" },
				printAreas: { [postcard.printArea]: { required: true } },
			},
		});
	}
	async function api(req: Request, path: string) {
		if (req.headers.get("X-API-Key") !== options.apiKey) {
			return Response.json({ statusText: "Unauthorised", statusCode: 401 }, {
				status: 401,
			});
		}
		const route = path.toLowerCase();
		if (req.method === "POST" && route === "/v4.0/quotes") {
			return quote(await req.json());
		}
		if (req.method === "POST" && route === "/v4.0/orders") {
			return place(await req.json());
		}
		const one = /^\/v4\.0\/orders\/(ord_[0-9a-f-]+)$/.exec(route);
		if (req.method === "GET" && one) {
			const order = orders.get(one[1]);
			if (!order) {
				return Response.json({ outcome: "EntityNotFound" }, { status: 404 });
			}
			return Response.json({ outcome: "Ok", order: wire(order) });
		}
		const sku = /^\/v4\.0\/products\/([^/]+)$/i.exec(path);
		if (req.method === "GET" && sku) return product(sku[1]);
		return Response.json({ outcome: "EndpointDoesNotExist" }, { status: 404 });
	}
	async function control(req: Request, url: URL) {
		const path = url.pathname;
		if (req.method === "GET" && path === "/_simulator/health") {
			return new Response("ok");
		}
		if (req.method === "GET" && path === "/_simulator/orders") {
			const reference = url.searchParams.get("merchantReference");
			return Response.json(
				[...orders.values()].filter((order) =>
					!reference || order.merchantReference === reference
				),
			);
		}
		if (req.method === "GET" && path === "/_simulator/events") {
			return Response.json(deliveries);
		}
		const failing = /^\/_simulator\/fail\/next\/([a-z_]+)$/.exec(path);
		if (req.method === "POST" && failing) {
			queued.push(failing[1] as Failure);
			return new Response(null, { status: 204 });
		}
		const moved =
			/^\/_simulator\/orders\/(ord_[0-9a-f-]+)\/(shipped|complete|cancelled)$/
				.exec(path);
		if (req.method === "POST" && moved) {
			const order = orders.get(moved[1]);
			if (!order) {
				return Response.json({ error: "no such order" }, { status: 404 });
			}
			if (moved[2] === "shipped") {
				order.status.details.shipping = "InProgress";
				const trackCode = `RM${order.id.replace(/[^a-z0-9]/gi, "").slice(3, 11).toUpperCase()}GB`;
				order.shipments = [{
					carrier: { name: "Royal Mail", service: "International Tracked" },
					dispatchDate: new Date(now()).toISOString(),
					tracking: {
						number: trackCode,
						url: `https://www.royalmail.com/track-your-item#/tracking-results/${trackCode}`,
					},
				}];
				return Response.json({
					status: await emit(order, "details.shipping", "InProgress"),
				});
			}
			order.status.stage = moved[2] === "complete" ? "Complete" : "Cancelled";
			return Response.json({
				status: await emit(order, "stage", order.status.stage),
			});
		}
		const resend = /^\/_simulator\/events\/(evt_[0-9a-f-]+)\/resend$/.exec(
			path,
		);
		if (req.method === "POST" && resend) {
			if (!sent.has(resend[1])) {
				return Response.json({ error: "no such event" }, { status: 404 });
			}
			return Response.json({ status: await deliver(resend[1]) });
		}
		return Response.json({ error: "not found" }, { status: 404 });
	}
	return {
		orders,
		settled: () => labWork.then(() => undefined),
		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url);
			if (url.pathname.startsWith("/_simulator/")) {
				return await control(req, url);
			}
			return await api(req, url.pathname);
		},
	};
}

if (import.meta.main) {
	const apiKey = Deno.env.get("PRODIGI_API_KEY");
	if (!apiKey) throw new Error("Missing simulator setting: PRODIGI_API_KEY");
	const sim = createProdigiSimulator({ apiKey, door: Deno.env.get("DOOR_URL") });
	Deno.serve(
		{
			hostname: Deno.env.get("SAYT_PLATFORM") === "host"
				? "127.0.0.1"
				: "0.0.0.0",
			port: Number(Deno.env.get("PORT") ?? "8080"),
		},
		sim.fetch,
	);
}
