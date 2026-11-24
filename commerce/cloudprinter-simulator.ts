// A local Cloudprinter for the compose stack (README.md#local-mode): CloudCore
// v1.0 quote, add, info and cancel in the shapes the sandbox answered with for
// Brazil's domestic A6 Wire-O flip-deck; cover and book PDFs fetched through
// the door, MD5-checked and measured; unsigned CloudSignal v2.1 webhooks posted
// to the door. /_simulator/ stands in for the dashboard and for failure.
import {
	brazilStateForCep,
	flipDeck,
	formatBrazilCpf,
	md5Hex,
} from "./catalogue.ts";

type Json = Record<string, unknown>;
type OrderFile = { type: string; url: string; md5sum: string };
type OrderOption = { type: string; count: string };
type OrderItem = {
	reference: string;
	product: string;
	shipping_level: string;
	title?: string;
	count: string;
	files: OrderFile[];
	options: OrderOption[];
	tracking?: string;
	track_url?: string;
};
export type SimCloudOrder = {
	order: string;
	reference: string;
	create_date: string;
	state: number;
	state_code: string;
	addresses: Json[];
	items: OrderItem[];
	fetched: {
		type: string;
		url: string;
		pages: number;
		width: number;
		height: number;
		md5sum: string;
	}[];
	issues: string[];
	placements: number;
};

export interface CloudprinterSimulatorOptions {
	apiKey: string;
	door?: string;
	webhookUrl?: string;
	now?: () => number;
}
type Failure = "refuse" | "lost_answer" | "server_error" | "fulfilment_issue";

const KNOWN_STOCKS = Object.values(flipDeck.stocks);
const SP_STATES = new Set([
	"BR-Sao Paulo Metropolitan Region and suburbs",
	"BR-Sao Paulo",
]);

const cloudError = (type: string, info: string, status = 400) =>
	Response.json({ error: { type, info } }, { status });

async function inspectPdf(
	bytes: Uint8Array,
): Promise<{ pages: number; width: number; height: number } | null> {
	if (
		bytes.length < 8 || bytes[0] !== 0x25 || bytes[1] !== 0x50 ||
		bytes[2] !== 0x44 || bytes[3] !== 0x46 || bytes[4] !== 0x2d
	) {
		return null;
	}
	const raw = new TextDecoder("latin1").decode(bytes);
	let full = raw;
	for (
		const match of raw.matchAll(
			/\/Type\s*\/ObjStm[\s\S]*?\/Length\s+(\d+)[\s\S]*?stream\r?\n/g,
		)
	) {
		const start = match.index! + match[0].length;
		const len = Number(match[1]);
		const ds = new DecompressionStream("deflate");
		const writer = ds.writable.getWriter();
		writer.write(bytes.slice(start, start + len));
		writer.close();
		const dec = new Uint8Array(await new Response(ds.readable).arrayBuffer());
		full += "\n" + new TextDecoder("latin1").decode(dec);
	}
	const pages = full.match(/\/Type\s*\/Page\b(?!s)/g)?.length ?? 0;
	const boxes = [
		...full.matchAll(
			/\/MediaBox\s*\[\s*0(?:\.0+)?\s+0(?:\.0+)?\s+([\d.]+)\s+([\d.]+)\s*\]/g,
		),
	].map((m) => ({ width: Number(m[1]), height: Number(m[2]) }));
	if (pages === 0 || boxes.length === 0) return null;
	return { pages, width: boxes[0].width, height: boxes[0].height };
}

function validateItemOptions(options: unknown): { pages: number } | string {
	if (!Array.isArray(options)) {
		return "foreach() argument must be of type array|object, null given";
	}
	const map = new Map<string, string>();
	for (const opt of options as Json[]) {
		if (typeof opt?.type === "string") {
			map.set(opt.type, String(opt.count ?? ""));
		}
	}
	// CloudCore accepts even page counts >= 20 at quote/add; textbook preflight
	// enforces >= flipDeck.minPages (24) asynchronously in produce().
	const pages = Number(map.get("total_pages") ?? "0");
	if (!Number.isInteger(pages) || pages < 20 || pages % 2 !== 0) {
		return `Invalid total_pages ${map.get("total_pages")}`;
	}
	const matched = KNOWN_STOCKS.some((s) =>
		map.get(s.pageblock) === String(pages) &&
		map.get(s.cover) === "1" &&
		map.get(s.finish) === "1" &&
		map.get(s.binding) === "1"
	);
	if (!matched) return "Unsupported stock options";
	return { pages };
}

export function createCloudprinterSimulator(
	options: CloudprinterSimulatorOptions,
) {
	const now = options.now ?? Date.now;
	const orders = new Map<string, SimCloudOrder>();
	const queued: Failure[] = [];
	const sent = new Map<string, { url: string; payload: string }>();
	const deliveries: { id: string; type: string; status: number }[] = [];
	let labWork: Promise<unknown> = Promise.resolve();

	const webhookTarget = options.webhookUrl ??
		(options.door ? `${options.door}/signal/cloudprinter` : "");

	const reachable = (url: string) => {
		if (!options.door) return url;
		const { pathname, search } = new URL(url);
		return `${options.door}${pathname}${search}`;
	};
	const wire = (order: SimCloudOrder) => {
		const {
			fetched: _fetched,
			issues: _issues,
			placements: _placements,
			...rest
		} = order;
		return rest;
	};
	async function deliver(id: string) {
		const { url, payload } = sent.get(id)!;
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"User-Agent": "CloudSignal/2.1 (+https://www.cloudprinter.com)",
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
	function emit(order: SimCloudOrder, type: string) {
		if (!webhookTarget) return Promise.resolve(0);
		const id = `csig_${crypto.randomUUID()}`;
		sent.set(id, {
			url: webhookTarget,
			payload: JSON.stringify({
				apikey: options.apiKey,
				type,
				order: order.order,
				order_reference: order.reference,
				datetime: new Date(now()).toISOString(),
			}),
		});
		return deliver(id);
	}
	async function measureFile(
		order: SimCloudOrder,
		file: OrderFile,
		expectedPages: number,
	): Promise<string | null> {
		let response: Response;
		try {
			response = await fetch(reachable(file.url), {
				signal: AbortSignal.timeout(10000),
			});
		} catch (error) {
			return `Could not download ${file.url}: ${error}`;
		}
		if (!response.ok) {
			await response.body?.cancel();
			return `Could not download ${file.url}: ${response.status}`;
		}
		const contentType = response.headers.get("Content-Type") ?? "";
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (!contentType.startsWith("application/pdf")) {
			return `${file.url} is ${contentType}, not application/pdf`;
		}
		const actualMd5 = md5Hex(bytes);
		if (actualMd5 !== String(file.md5sum ?? "").toLowerCase()) {
			return `${file.url} md5 ${actualMd5} != ${file.md5sum}`;
		}
		const info = await inspectPdf(bytes);
		if (!info) return `${file.url} is not a readable PDF`;
		order.fetched.push({
			type: file.type,
			url: file.url,
			md5sum: actualMd5,
			...info,
		});
		if (
			file.type === "book" &&
			(info.pages < flipDeck.minPages || info.pages % 2 !== 0)
		) {
			return `book PDF has ${info.pages} pages, textbook requires >= ${flipDeck.minPages} even pages`;
		}
		if (info.pages !== expectedPages) {
			return `${file.type} PDF has ${info.pages} pages, expected ${expectedPages}`;
		}
		if (
			Math.abs(info.width - flipDeck.pagePt.width) > 0.2 ||
			Math.abs(info.height - flipDeck.pagePt.height) > 0.2
		) {
			return `${file.type} PDF is ${info.width}×${info.height} pt, expected ${flipDeck.pagePt.width}×${flipDeck.pagePt.height} pt`;
		}
		return null;
	}
	async function produce(
		order: SimCloudOrder,
		pages: number,
		fail?: Failure,
	) {
		const problems: string[] = [];
		for (const item of order.items) {
			const cover = item.files.find((f) => f.type === "cover");
			const book = item.files.find((f) => f.type === "book");
			if (!cover || !book) {
				problems.push("Order item requires both cover and book files");
				continue;
			}
			for (const [file, want] of [[cover, 2], [book, pages]] as const) {
				const problem = await measureFile(order, file, want);
				if (problem) problems.push(problem);
			}
		}
		if (fail === "fulfilment_issue") {
			problems.push("The simulator was told to refuse this order");
		}
		order.issues = problems;
		if (problems.length) {
			order.state = 31;
			order.state_code = "ItemProduceError";
			await emit(order, "CloudprinterItemError");
			return;
		}
		order.state = 20;
		order.state_code = "OrderValidated";
		await emit(order, "CloudprinterOrderValidated");
	}
	function quote(body: Json) {
		if (body.currency !== "USD") {
			return cloudError("currency_not_supported", "Unsupported currency");
		}
		if (body.country !== "BR") {
			return cloudError("country_not_supported", "Only BR is configured here");
		}
		const state = String(body.state ?? "");
		if (!state.startsWith("BR-")) {
			return cloudError("state_invalid", "Missing BR state reference");
		}
		const items = body.items;
		if (!Array.isArray(items) || items.length !== 1) {
			return cloudError("items_invalid", "Expected one item");
		}
		const item = items[0] as Json;
		if (item.product !== flipDeck.sku) {
			return cloudError("product_not_found", `Unknown product ${item.product}`);
		}
		const optResult = validateItemOptions(item.options);
		if (typeof optResult === "string") {
			return cloudError("options_invalid", optResult);
		}
		const itemMicro = 19464 + Math.max(0, optResult.pages - 20) * 400;
		const shipStr = SP_STATES.has(state) ? "8.0266" : "19.1394";
		const itemStr = (itemMicro / 10000).toFixed(4);
		return Response.json({
			price: itemStr,
			vat: "0.0000",
			currency: "USD",
			subtotals: { items: itemStr, fee: "0.0000", app: "0.0000" },
			shipments: [{
				total_weight: "0.092",
				items: [{ reference: String(item.reference ?? "deck-1") }],
				quotes: [{
					shipping_level: "cp_saver",
					shipping_option: "brazil_correios_sedex",
					service: "Correios - SEDEX",
					price: shipStr,
					vat: "0.0000",
					currency: "USD",
				}],
			}],
		});
	}
	function add(body: Json) {
		const reference = String(body.reference ?? "");
		if (!reference) {
			return cloudError("reference_missing", "Order reference is required");
		}
		if (orders.has(reference)) {
			orders.get(reference)!.placements++;
			return cloudError(
				"order_reference_not_unique",
				"The order reference is not unique",
				409,
			);
		}
		const fail = queued.shift();
		if (fail === "refuse") {
			return cloudError("product_not_found", "Simulator refused order", 400);
		}
		if (fail === "server_error") {
			return cloudError("internal_error", "Internal error", 500);
		}
		const addresses = body.addresses;
		if (!Array.isArray(addresses) || addresses.length !== 1) {
			return cloudError("addresses_invalid", "Expected one delivery address");
		}
		const addr = addresses[0] as Json;
		const expectedState = brazilStateForCep(String(addr.zip ?? ""));
		const formattedCpf = formatBrazilCpf(
			String(addr.customer_identification ?? ""),
		);
		if (
			addr.type !== "delivery" || addr.country !== "BR" || !expectedState ||
			addr.state !== expectedState || !/^\d{5}-\d{3}$/.test(String(addr.zip ?? ""))
		) {
			return cloudError("address_state_invalid", "Invalid BR postal state");
		}
		if (!formattedCpf || addr.customer_identification !== formattedCpf) {
			return cloudError(
				"customer_identification_invalid",
				"Brazil orders require formatted CPF",
			);
		}
		for (
			const field of ["firstname", "lastname", "street1", "city", "email", "phone"]
		) {
			if (typeof addr[field] !== "string" || !addr[field]) {
				return cloudError("address_field_missing", `Missing ${field}`);
			}
		}
		const items = body.items;
		if (!Array.isArray(items) || items.length !== 1) {
			return cloudError("items_invalid", "Expected one item");
		}
		const item = items[0] as OrderItem;
		if (item.product !== flipDeck.sku) {
			return cloudError("product_not_found", `Unknown product ${item.product}`);
		}
		const optResult = validateItemOptions(item.options);
		if (typeof optResult === "string") {
			return cloudError("options_invalid", optResult);
		}
		if (!Array.isArray(item.files) || item.files.length !== 2) {
			return cloudError("files_invalid", "Expected cover and book files");
		}
		for (const f of item.files) {
			if (
				!URL.canParse(String(f?.url ?? "")) ||
				!/^[0-9a-f]{32}$/i.test(String(f?.md5sum ?? ""))
			) {
				return cloudError("file_invalid", "Invalid file url or md5sum");
			}
		}
		const order: SimCloudOrder = {
			order: `cp_${reference.replaceAll("-", "").slice(0, 12)}`,
			reference,
			create_date: new Date(now()).toISOString(),
			state: 1,
			state_code: "OrderRegistered",
			addresses: addresses as Json[],
			items: items as OrderItem[],
			fetched: [],
			issues: [],
			placements: 1,
		};
		orders.set(reference, order);
		labWork = labWork.then(() => produce(order, optResult.pages, fail));
		if (fail === "lost_answer") {
			return cloudError("internal_error", "Lost response after registration", 500);
		}
		return Response.json({ order: order.order }, { status: 201 });
	}
	function info(body: Json) {
		const order = orders.get(String(body.reference ?? ""));
		if (!order) {
			return new Response(null, { status: 204 });
		}
		return Response.json(wire(order));
	}
	function cancel(body: Json) {
		const order = orders.get(String(body.reference ?? ""));
		if (!order) {
			return new Response(null, { status: 204 });
		}
		order.state = 500;
		order.state_code = "OrderCanceled";
		return Response.json({ status: "200" });
	}
	async function api(req: Request, path: string) {
		if (req.method !== "POST") {
			return cloudError("method_not_allowed", "POST required", 405);
		}
		const body = await req.json().catch(() => ({})) as Json;
		if (body.apikey !== options.apiKey) {
			return cloudError("authentication_failed", "Invalid API key", 401);
		}
		if (path === "/cloudcore/1.0/orders/quote") return quote(body);
		if (path === "/cloudcore/1.0/orders/add") return add(body);
		if (path === "/cloudcore/1.0/orders/info") return info(body);
		if (path === "/cloudcore/1.0/orders/cancel") return cancel(body);
		return cloudError("endpoint_not_found", `No endpoint ${path}`, 404);
	}
	async function control(req: Request, url: URL) {
		const path = url.pathname;
		if (req.method === "GET" && path === "/_simulator/health") {
			return new Response("ok");
		}
		if (req.method === "GET" && path === "/_simulator/orders") {
			const reference = url.searchParams.get("reference");
			return Response.json(
				[...orders.values()].filter((order) =>
					!reference || order.reference === reference
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
			/^\/_simulator\/orders\/([^/]+)\/(shipped|complete|cancelled)$/.exec(
				path,
			);
		if (req.method === "POST" && moved) {
			const order = orders.get(decodeURIComponent(moved[1]));
			if (!order) {
				return Response.json({ error: "no such order" }, { status: 404 });
			}
			if (moved[2] === "shipped") {
				order.state = 501;
				order.state_code = "ItemShipped";
				order.items[0].tracking = `BR${order.reference.slice(0, 8).toUpperCase()}BR`;
				order.items[0].track_url = "https://rastreamento.correios.com.br/app/index.php";
				return Response.json({
					status: await emit(order, "CloudprinterItemShipped"),
				});
			}
			if (moved[2] === "complete") {
				order.state = 100;
				order.state_code = "OrderCompleted";
				return Response.json({
					status: await emit(order, "CloudprinterOrderCompleted"),
				});
			}
			order.state = 500;
			order.state_code = "OrderCanceled";
			return Response.json({
				status: await emit(order, "CloudprinterOrderCanceled"),
			});
		}
		const resend = /^\/_simulator\/events\/(csig_[0-9a-f-]+)\/resend$/.exec(
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
	const apiKey = Deno.env.get("CLOUDPRINTER_API_KEY");
	if (!apiKey) {
		throw new Error("Missing simulator setting: CLOUDPRINTER_API_KEY");
	}
	const sim = createCloudprinterSimulator({
		apiKey,
		door: Deno.env.get("DOOR_URL"),
		webhookUrl: Deno.env.get("WEBHOOK_URL"),
	});
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
