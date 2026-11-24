// The one place that names Prodigi's product, as the sandbox's
// `GET /products/{sku}` reads it; prodigi-sandbox.ts prints it again. What its
// answers do not settle is in README.md#what-a-test-order-must-confirm.
// CLASSIC-POST-GLOS-6X4 is not offered: its rear must carry the address, stamp
// and postage mark, so it cannot carry a word.
export type Stock = "gloss" | "mohawk";
export const postcard = {
	skus: {
		// 280 gsm, gloss laminated per its product page.
		gloss: "GLOBAL-POST-GLOS-6X4",
		// 324 gsm Mohawk Superfine, uncoated. Not the -BLA variant, which adds a
		// blank envelope a deck does not want.
		mohawk: "GLOBAL-POST-MOH-6X4",
	} as Record<Stock, string>,
	// Both SKUs have this one print area; a `back` asset is refused
	// (UnexpectedAssets).
	printArea: "default",
	// Required per item. It crops, so the service refuses any file not exactly
	// the area's size, and nothing is cropped.
	sizing: "fillPrintArea",
	// The area's size: both faces side by side, about 6.18×4.21 in each at 300
	// dpi including bleed. A Prodigi support article, seen only in a search result,
	// says both go in one file, and the product page sets no address or postage
	// rule; a sandbox order accepts other sizes too, since it crops, so it proved
	// nothing. Front on the left, back on the right is a working assumption until a
	// real sample shows it, and the answer changes `panels` alone.
	widthPx: 3708,
	heightPx: 1263,
	dpi: 300,
	panels: {
		front: { x: 0, width: 1854 },
		back: { x: 1854, width: 1854 },
	},
	// The physical 15.2×10.2 cm card at 300 dpi; what is outside it is cut away,
	// so nothing is drawn there.
	trim: { width: 1795, height: 1205 },
};

// Brazil orders print locally at Cloudprinter's domestic plant as an A6
// landscape Wire-O spiral flip-deck (Correios SEDEX), avoiding cross-border DHL
// and customs. CloudCore accepts 20 pages at quote/add, but textbook preflight
// requires at least 24 (multiples of 2), so smaller decks pad blank leaves.
export const flipDeck = {
	sku: "textbook_co_a6_l_fc",
	stocks: {
		gloss: {
			pageblock: "pageblock_150mcs",
			cover: "cover_250ecb",
			finish: "cover_finish_gloss",
			binding: "wire_o_binding",
		},
		mohawk: {
			pageblock: "pageblock_120off",
			cover: "cover_250ecb",
			finish: "cover_finish_matte",
			binding: "wire_o_binding",
		},
	} as Record<
		Stock,
		{ pageblock: string; cover: string; finish: string; binding: string }
	>,
	minPages: 24,
	totalPages: (cards: number) => Math.max(24, cards * 2),
	pagePt: { width: (154 * 72) / 25.4, height: (111 * 72) / 25.4 },
};

const BRAZIL_CEP_STATES: readonly (readonly [number, number, string])[] = [
	[1000000, 9999999, "BR-Sao Paulo Metropolitan Region and suburbs"],
	[11000000, 19999999, "BR-Sao Paulo"],
	[20000000, 28999999, "BR-Rio de Janeiro"],
	[29000000, 29999999, "BR-Espirito Santo"],
	[30000000, 39999999, "BR-Minas Gerais"],
	[40000000, 48999999, "BR-Bahia"],
	[49000000, 49999999, "BR-Sergipe"],
	[50000000, 56999999, "BR-Pernambuco"],
	[57000000, 57999999, "BR-Alagoas"],
	[58000000, 58999999, "BR-Paraiba"],
	[59000000, 59999999, "BR-Rio Grande do Norte"],
	[60000000, 63999999, "BR-Ceara"],
	[64000000, 64999999, "BR-Piaui"],
	[65000000, 65999999, "BR-Maranhao"],
	[66000000, 68899999, "BR-Para"],
	[68900000, 68999999, "BR-Amapa"],
	[69000000, 69299999, "BR-Amazonas 1"],
	[69300000, 69399999, "BR-Roraima"],
	[69400000, 69899999, "BR-Amazonas 2"],
	[69900000, 69999999, "BR-Acre"],
	[70000000, 72799999, "BR-Federal District 1"],
	[72800000, 72999999, "BR-Goias 1"],
	[73000000, 73699999, "BR-Federal District 2"],
	[73700000, 76799999, "BR-Goias 2"],
	[76800000, 76999999, "BR-Rondonia 1"],
	[77000000, 77999999, "BR-Tocantins"],
	[78000000, 78899999, "BR-Mato Grosso"],
	[78900000, 78999999, "BR-Rondonia 2"],
	[79000000, 79999999, "BR-Mato Grosso do Sul"],
	[80000000, 87999999, "BR-Parana"],
	[88000000, 89999999, "BR-Santa Catarina"],
	[90000000, 99999999, "BR-Rio Grande do Sul"],
];

export function brazilStateForCep(postalCode: string): string | null {
	const digits = postalCode.replace(/\D/g, "");
	if (digits.length !== 8) return null;
	const n = Number(digits);
	for (const [min, max, state] of BRAZIL_CEP_STATES) {
		if (n >= min && n <= max) return state;
	}
	return null;
}

export function validBrazilCpf(value: string): boolean {
	const d = value.replace(/\D/g, "");
	if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
	for (const len of [9, 10]) {
		let sum = 0;
		for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
		const check = ((sum * 10) % 11) % 10;
		if (check !== Number(d[len])) return false;
	}
	return true;
}

export function formatBrazilCpf(value: string): string | null {
	if (!validBrazilCpf(value)) return null;
	const d = value.replace(/\D/g, "");
	return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

const MD5_S = [
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
	5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
	4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
	6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = Array.from(
	{ length: 64 },
	(_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0,
);

export function md5Hex(bytes: Uint8Array): string {
	const bitLen = bytes.length * 8;
	const padLen = (((bytes.length + 8) >>> 6) + 1) << 6;
	const buf = new Uint8Array(padLen);
	buf.set(bytes);
	buf[bytes.length] = 0x80;
	const view = new DataView(buf.buffer);
	view.setUint32(padLen - 8, bitLen >>> 0, true);
	view.setUint32(padLen - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);
	let a0 = 0x67452301;
	let b0 = 0xefcdab89;
	let c0 = 0x98badcfe;
	let d0 = 0x10325476;
	for (let off = 0; off < padLen; off += 64) {
		let a = a0, b = b0, c = c0, d = d0;
		for (let i = 0; i < 64; i++) {
			let f = 0, g = 0;
			if (i < 16) {
				f = (b & c) | (~b & d);
				g = i;
			} else if (i < 32) {
				f = (d & b) | (~d & c);
				g = (5 * i + 1) % 16;
			} else if (i < 48) {
				f = b ^ c ^ d;
				g = (3 * i + 5) % 16;
			} else {
				f = c ^ (b | ~d);
				g = (7 * i) % 16;
			}
			const sum = (a + f + MD5_K[i] + view.getUint32(off + g * 4, true)) >>> 0;
			a = d;
			d = c;
			c = b;
			const rot = ((sum << MD5_S[i]) | (sum >>> (32 - MD5_S[i]))) >>> 0;
			b = (b + rot) >>> 0;
		}
		a0 = (a0 + a) >>> 0;
		b0 = (b0 + b) >>> 0;
		c0 = (c0 + c) >>> 0;
		d0 = (d0 + d) >>> 0;
	}
	const out = new Uint8Array(16);
	const outView = new DataView(out.buffer);
	outView.setUint32(0, a0, true);
	outView.setUint32(4, b0, true);
	outView.setUint32(8, c0, true);
	outView.setUint32(12, d0, true);
	return [...out].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export const MAX_CARDS = 100;
// A JPEG's last bytes: cheap evidence that the file is a whole one.
export function endsAsJpeg(bytes: Uint8Array): boolean {
	return bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
}
// The two faces fill the area exactly, front on the left.
export function layoutProblem({ panels, widthPx } = postcard): string | null {
	if (panels.front.x !== 0) return "The front is not the left panel";
	if (panels.back.x !== panels.front.width) {
		return "The back does not start where the front ends";
	}
	if (panels.back.x + panels.back.width !== widthPx) {
		return "The panels do not fill the print area";
	}
	return null;
}
// The frame markers of a baseline or progressive JPEG name its pixel size.
export function jpegSize(
	bytes: Uint8Array,
): { width: number; height: number } | null {
	if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	let at = 2;
	while (at + 9 < bytes.length) {
		if (bytes[at] !== 0xff) return null;
		const marker = bytes[at + 1];
		const length = (bytes[at + 2] << 8) | bytes[at + 3];
		const frame = marker >= 0xc0 && marker <= 0xcf &&
			![0xc4, 0xc8, 0xcc].includes(marker);
		if (frame) {
			return {
				height: (bytes[at + 5] << 8) | bytes[at + 6],
				width: (bytes[at + 7] << 8) | bytes[at + 8],
			};
		}
		at += 2 + length;
	}
	return null;
}
