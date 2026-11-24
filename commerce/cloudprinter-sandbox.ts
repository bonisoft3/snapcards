// What Cloudprinter's CloudCore 1.0 API says about catalogue.ts's flipDeck. From apps/snapcards:
//   sops exec-env secrets.enc.yaml 'deno run --no-config --allow-env=CLOUDPRINTER_API_KEY,CLOUDPRINTER_API_URL --allow-net=api.cloudprinter.com commerce/cloudprinter-sandbox.ts'
// It reads and quotes; it never places an order, and never prints the key.
import { brazilStateForCep, flipDeck, type Stock } from "./catalogue.ts";

const required = (name: string) => {
	const value = Deno.env.get(name);
	if (!value) throw new Error(`${name} is not in the environment`);
	return value;
};
const key = required("CLOUDPRINTER_API_KEY");
const api = Deno.env.get("CLOUDPRINTER_API_URL") ??
	"https://api.cloudprinter.com/cloudcore/1.0";

async function post<T>(
	endpoint: string,
	payload: Record<string, unknown> = {},
): Promise<T> {
	const response = await fetch(`${api}${endpoint}`, {
		method: "POST",
		signal: AbortSignal.timeout(20000),
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ apikey: key, ...payload }),
	});
	const text = (await response.text()).replaceAll(key, "<redacted>");
	if (response.status !== 200) {
		throw new Error(`${endpoint}: ${response.status} ${text}`);
	}
	return JSON.parse(text) as T;
}

const info = await post<{
	reference: string;
	name: string;
	note: string;
	specs?: unknown[];
	options?: { reference: string; type: string; default: number }[];
}>("/products/info", { reference: flipDeck.sku });

const availableOptions = new Set((info.options ?? []).map((o) => o.reference));
for (const [stock, spec] of Object.entries(flipDeck.stocks)) {
	for (
		const ref of [spec.pageblock, spec.cover, spec.finish, spec.binding]
	) {
		if (!availableOptions.has(ref)) {
			throw new Error(`${flipDeck.sku} stock ${stock} option ${ref} is missing`);
		}
	}
}
console.log(JSON.stringify({
	sku: info.reference,
	name: info.name,
	note: info.note,
	specs: info.specs,
}, null, 2));

const pages = String(flipDeck.totalPages(7));
for (const cep of ["01310-100", "80010-000"]) {
	const state = brazilStateForCep(cep);
	if (!state) throw new Error(`No state for CEP ${cep}`);
	for (const stock of ["gloss", "mohawk"] as Stock[]) {
		const spec = flipDeck.stocks[stock];
		const quote = await post<{
			price: string;
			vat: string;
			currency: string;
			shipments: { quotes: { shipping_level: string; service: string; price: string }[] }[];
		}>("/orders/quote", {
			currency: "USD",
			country: "BR",
			state,
			items: [{
				reference: "deck-1",
				product: flipDeck.sku,
				count: "1",
				options: [
					{ type: "total_pages", count: pages },
					{ type: spec.pageblock, count: pages },
					{ type: spec.cover, count: "1" },
					{ type: spec.finish, count: "1" },
					{ type: spec.binding, count: "1" },
				],
			}],
		});
		console.log(JSON.stringify({
			cep,
			state,
			stock,
			currency: quote.currency,
			itemUsd: quote.price,
			quotes: quote.shipments[0]?.quotes ?? [],
		}, null, 2));
	}
}
