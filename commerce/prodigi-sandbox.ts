// What the Prodigi sandbox says about catalogue.ts. From apps/snapcards:
//   sops exec-env secrets.enc.yaml 'PRODIGI_API_URL=https://api.sandbox.prodigi.com/v4.0 deno run --no-config --allow-env=PRODIGI_API_KEY,PRODIGI_API_URL --allow-net=api.sandbox.prodigi.com commerce/prodigi-sandbox.ts'
// It reads and quotes; it never places an order, and never prints the key.
import { postcard } from "./catalogue.ts";

const required = (name: string) => {
	const value = Deno.env.get(name);
	if (!value) throw new Error(`${name} is not in the environment`);
	return value;
};
const key = required("PRODIGI_API_KEY");
const api = required("PRODIGI_API_URL");
async function call(path: string, init: RequestInit = {}) {
	const response = await fetch(`${api}${path}`, {
		...init,
		signal: AbortSignal.timeout(15000),
		headers: { "X-API-Key": key, "Content-Type": "application/json" },
	});
	const body = (await response.text()).replaceAll(key, "<redacted>");
	return { status: response.status, body };
}
const quote = (currencyCode: string) =>
	call("/quotes", {
		method: "POST",
		body: JSON.stringify({
			destinationCountryCode: "BR",
			currencyCode,
			items: [{
				sku: postcard.skus.gloss,
				copies: 1,
				attributes: {},
				assets: [{ printArea: postcard.printArea }],
			}],
		}),
	});
for (const [stock, sku] of Object.entries(postcard.skus)) {
	const { status, body } = await call(`/products/${sku}`);
	if (status !== 200) throw new Error(`${sku}: ${status} ${body}`);
	const { product } = JSON.parse(body);
	console.log(JSON.stringify({
		stock,
		sku: product.sku,
		description: product.description,
		dimensions: product.productDimensions,
		attributes: product.attributes,
		printAreas: product.printAreas,
		sizes: product.variants?.[0]?.printAreaSizes,
		shipsToBrazil: product.variants?.some((v: { shipsTo?: string[] }) =>
			v.shipsTo?.includes("BR")
		),
	}, null, 2));
}
const usd = await quote("USD");
if (usd.status !== 200) throw new Error(`USD quote: ${usd.status} ${usd.body}`);
console.log(JSON.stringify({
	brazilInUsd: JSON.parse(usd.body).quotes.map((
		q: { shipmentMethod: string; costSummary: unknown },
	) => ({ method: q.shipmentMethod, cost: q.costSummary })),
}, null, 2));
const brl = await quote("BRL");
console.log(JSON.stringify({ brazilInBrl: brl.status, answer: brl.body }));
