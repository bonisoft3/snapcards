import { postcard } from "../commerce/catalogue.ts";

export interface FrozenPrint {
	title: string;
	cards: number;
	// One image per card: both faces, side by side, as catalogue.ts lays them.
	artwork: Uint8Array[];
	artworkBytes: number;
}
const QUALITY = 0.85;

async function dataUrl(url: string, signal?: AbortSignal): Promise<string> {
	// An inlined illustration already is what gets drawn; fetching it would be a
	// connection the page's policy refuses (connect-src has no data:).
	if (url.startsWith("data:image/")) return url;
	const response = await fetch(url, { signal });
	if (!response.ok) {
		throw new Error(`Illustration unavailable (${response.status})`);
	}
	const blob = await response.blob();
	if (!blob.type.startsWith("image/")) {
		throw new Error("Illustration is not an image");
	}
	return await new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error("Illustration could not be read"));
		reader.onload = () => resolve(String(reader.result));
		reader.readAsDataURL(blob);
	});
}
function illustrationIn(card: HTMLElement): string | null {
	const illustration = card.querySelector<HTMLElement>(
		".print-card-illustration",
	);
	if (!illustration) return null;
	const image = illustration.querySelector<HTMLImageElement>("img");
	const attr = image?.getAttribute("src") ?? "";
	if (image && attr && !attr.startsWith("{") && getComputedStyle(image).display !== "none") {
		return image.src;
	}
	const match = /^url\(["']?(.*?)["']?\)$/.exec(
		getComputedStyle(illustration).backgroundImage,
	);
	return match && new URL(match[1], location.href).href;
}
export function illustrationOf(card: HTMLElement): string {
	const url = illustrationIn(card);
	if (!url) throw new Error("A card has no printable illustration");
	return url;
}
const ILLUSTRATION_WAIT_MS = 10_000;
// Selecting a deck updates print_config before localized_card and each card's own
// flashcard read paint its DOM, so ordering at once waits for the chosen deck's
// title, card count, and illustrations.
export async function illustrationsArrived(
	screen: HTMLElement,
	signal?: AbortSignal,
): Promise<void> {
	const settled = () => {
		const setId = screen.querySelector<HTMLElement>(".print-container")?.dataset.setId ?? "";
		const boundSetId = setId && !setId.startsWith("{") ? setId : "";
		const picked = boundSetId
			? screen.querySelector<HTMLElement>(`.deck-picker-card[data-id="${CSS.escape(boundSetId)}"]`)
			: null;
		const rawWantTitle = picked?.querySelector(".picker-card-name")?.textContent?.trim() || "";
		const wantTitle = rawWantTitle.startsWith("{") ? "" : rawWantTitle;
		const rawActiveTitle = screen.querySelector(".active-deck-name")?.textContent?.trim() || "";
		const activeTitle = rawActiveTitle.startsWith("{") ? "" : rawActiveTitle;
		if (!activeTitle || (wantTitle && activeTitle !== wantTitle)) return false;
		const rawCount =
			picked?.querySelector(".meta-tag b")?.textContent?.trim() ||
			screen.querySelector(".postcard-shown b")?.textContent?.trim() ||
			"";
		const wantCount = rawCount && !rawCount.startsWith("{") ? Number(rawCount) : NaN;
		const cards = [
			...screen.querySelectorAll<HTMLElement>(".sheet-paper-primary .print-card"),
		];
		if (!cards.length) return false;
		if (boundSetId && cards.some((c) => c.hasAttribute("data-set-id") && c.dataset.setId !== boundSetId)) {
			return false;
		}
		if (Number.isInteger(wantCount) && wantCount > 0 && cards.length !== wantCount) return false;
		return cards.every(illustrationIn);
	};
	const initialSetId = screen.querySelector<HTMLElement>(".print-container")?.dataset.setId ?? "";
	const rawInitialTitle = screen.querySelector(".active-deck-name")?.textContent?.trim() || "";
	const initialTitle = rawInitialTitle.startsWith("{") ? "" : rawInitialTitle;
	if ((!initialSetId || initialSetId.startsWith("{")) && !initialTitle) {
		throw new Error("Select a card collection first");
	}
	if (settled()) return;
	await new Promise<void>((resolve, reject) => {
		const finish = (done: () => void) => {
			observer.disconnect();
			clearTimeout(deadline);
			signal?.removeEventListener("abort", aborted);
			done();
		};
		const aborted = () => finish(() => reject(signal!.reason));
		const observer = new MutationObserver(() => {
			if (settled()) finish(resolve);
		});
		const deadline = setTimeout(
			() =>
				finish(() => {
					const rawTitle = screen.querySelector(".active-deck-name")?.textContent?.trim() || "";
					const setId = screen.querySelector<HTMLElement>(".print-container")?.dataset.setId ?? "";
					const boundSetId = setId && !setId.startsWith("{") ? setId : "";
					const cards = [
						...screen.querySelectorAll<HTMLElement>(".sheet-paper-primary .print-card"),
					];
					const matchingCards = boundSetId
						? cards.filter((c) => !c.hasAttribute("data-set-id") || c.dataset.setId === boundSetId)
						: cards;
					if (!rawTitle || rawTitle.startsWith("{")) {
						reject(new Error("Select a card collection first"));
					} else if (!matchingCards.length) {
						reject(new Error("A print order requires 1–100 cards"));
					} else {
						reject(new Error("A card has no printable illustration"));
					}
				}),
			ILLUSTRATION_WAIT_MS,
		);
		signal?.addEventListener("abort", aborted);
		observer.observe(screen, {
			childList: true,
			subtree: true,
			characterData: true,
			attributes: true,
			attributeFilter: ["src", "style", "data-set-id"],
		});
	});
}
function canvasOf(width: number, height: number) {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d")!;
	context.fillStyle = "#ffffff";
	context.fillRect(0, 0, width, height);
	return { canvas, context };
}
// toBlob runs as an idle task, and on a page with no idle time it waits a second
// each: minutes for a deck. toDataURL blocks only for its encoding, and the yield
// lets the status it was asked to show paint between files.
async function jpeg(canvas: HTMLCanvasElement, quality: number) {
	await new Promise((resolve) => setTimeout(resolve));
	const [, base64] = canvas.toDataURL("image/jpeg", quality).split(",");
	return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
// A canvas JPEG states no resolution; the JFIF header's density makes the file
// say what its pixels are for.
export function withDensity(bytes: Uint8Array, dpi: number) {
	if (new TextDecoder().decode(bytes.subarray(6, 10)) !== "JFIF") {
		throw new Error("The browser's JPEG has no JFIF header");
	}
	const out = new Uint8Array(bytes);
	out[13] = 1;
	out[14] = out[16] = dpi >> 8;
	out[15] = out[17] = dpi & 0xff;
	return out;
}
type Box = { x: number; y: number; width: number; height: number };
// Art contained in a box on white; never cropped.
function drawArt(
	canvas: CanvasRenderingContext2D,
	image: HTMLImageElement,
	box: Box,
) {
	const scale = Math.min(
		box.width / image.naturalWidth,
		box.height / image.naturalHeight,
	);
	const width = image.naturalWidth * scale;
	const height = image.naturalHeight * scale;
	canvas.drawImage(
		image,
		box.x + (box.width - width) / 2,
		box.y + (box.height - height) / 2,
		width,
		height,
	);
}
function linesOf(
	context: CanvasRenderingContext2D,
	word: string,
	width: number,
) {
	const lines: string[] = [];
	for (const token of word.trim().split(/\s+/)) {
		const last = lines.at(-1);
		if (last && context.measureText(`${last} ${token}`).width <= width) {
			lines[lines.length - 1] = `${last} ${token}`;
		} else lines.push(token);
	}
	return lines;
}
function drawWord(
	context: CanvasRenderingContext2D,
	word: string,
	family: string,
	box: Box,
	start: number,
) {
	context.fillStyle = "#1C1B1C";
	context.textAlign = "center";
	context.textBaseline = "middle";
	context.direction = /[\u0590-\u08FF]/.test(word) ? "rtl" : "ltr";
	for (let size = Math.round(start); size >= 24; size -= 6) {
		context.font = `800 ${size}px ${family}`;
		const lines = linesOf(context, word, box.width);
		const leading = size * 1.12;
		if (
			lines.length * leading <= box.height &&
			lines.every((line) => context.measureText(line).width <= box.width)
		) {
			lines.forEach((line, index) => {
				context.fillText(
					line,
					box.x + box.width / 2,
					box.y + box.height / 2 +
						(index - (lines.length - 1) / 2) * leading,
				);
			});
			return;
		}
	}
	throw new Error(`The word does not fit its card: ${word}`);
}
// The word as every preview shows it: `text-transform: capitalize`.
const capitalized = (word: string) =>
	word.replace(/(^|\s)(\p{L})/gu, (_, gap, letter) => gap + letter.toUpperCase());
// A panel's box: centred on it, a fraction of the trim.
function trimmed(panel: { x: number; width: number }, w: number, h: number) {
	const { heightPx, trim } = postcard;
	const width = trim.width * w;
	const height = trim.height * h;
	return {
		x: panel.x + (panel.width - width) / 2,
		y: (heightPx - height) / 2,
		width,
		height,
	};
}
async function deckOf(screen: HTMLElement, signal?: AbortSignal) {
	await illustrationsArrived(screen, signal);
	const title = screen.querySelector(".active-deck-name")?.textContent?.trim();
	if (!title) throw new Error("Select a card collection first");
	const cards = [
		...screen.querySelectorAll<HTMLElement>(".sheet-paper-primary .print-card"),
	];
	if (!cards.length || cards.length > 100) {
		throw new Error("A print order requires 1–100 cards");
	}
	const wordNode = cards[0].querySelector<HTMLElement>(".print-card-word");
	if (!wordNode) throw new Error("A card has no word");
	const family = getComputedStyle(wordNode).fontFamily;
	await document.fonts.load(`800 100px ${family}`);
	await document.fonts.ready;
	const cache = new Map<string, Promise<HTMLImageElement>>();
	const load = (url: string) => {
		let pending = cache.get(url);
		if (!pending) {
			pending = dataUrl(url, signal).then(async (inline) => {
				const image = new Image();
				image.src = inline;
				await image.decode();
				return image;
			});
			cache.set(url, pending);
		}
		return pending;
	};
	return { title, cards, family, load };
}

// The file a print shop imposes itself: one A6 face per page, front then back,
// with bleed and no marks, standing or lying as the reader's orientation says.
export const shopCard = {
	trimMm: { short: 105, long: 148 },
	bleedMm: 3,
	safeMm: 5,
	dpi: 300,
};
function shopPageOf(screen: HTMLElement) {
	const { trimMm: { short, long }, bleedMm } = shopCard;
	const landscape = screen.querySelector<HTMLElement>(".print-container")!.dataset.orientation === "landscape";
	return {
		width: (landscape ? long : short) + 2 * bleedMm,
		height: (landscape ? short : long) + 2 * bleedMm,
	};
}
export async function shopFaces(
	screen: HTMLElement,
	signal?: AbortSignal,
): Promise<{ title: string; faces: string[] }> {
	const { title, cards, family, load } = await deckOf(screen, signal);
	const { trimMm, bleedMm, safeMm, dpi } = shopCard;
	const shopPage = shopPageOf(screen);
	const px = (mm: number) => Math.round(mm * dpi / 25.4);
	const inset = px(bleedMm + safeMm);
	const box = {
		x: inset,
		y: inset,
		width: px(shopPage.width) - 2 * inset,
		height: px(shopPage.height) - 2 * inset,
	};
	// Every image is resolved first: one that fails leaves no partial deck.
	const images = await Promise.all(cards.map((card) => load(illustrationOf(card))));
	const faces: string[] = [];
	const addFace = async (draw: (context: CanvasRenderingContext2D) => void) => {
		const { canvas, context } = canvasOf(px(shopPage.width), px(shopPage.height));
		draw(context);
		await new Promise((resolve) => setTimeout(resolve));
		faces.push(canvas.toDataURL("image/jpeg", QUALITY));
	};
	for (const [index, card] of cards.entries()) {
		if (signal?.aborted) throw signal.reason;
		const word = card.dataset.front ??
			card.querySelector(".print-card-word")?.textContent;
		if (!word?.trim()) throw new Error("A card has no word");
		await addFace((context) => drawArt(context, images[index], box));
		await addFace((context) =>
			drawWord(context, capitalized(word), family, box, px(trimMm.short) * 0.11)
		);
	}
	return { title, faces };
}
// One dialog for the whole deck, where the reader saves a PDF: the screen's own
// print rules step aside for one sheet per face at the page's exact size, which
// gives up the Trim and Bleed boxes, harmless with the art inside the trim.
export async function printShopDeck(
	screen: HTMLElement,
	signal?: AbortSignal,
): Promise<void> {
	const { title, faces } = await shopFaces(screen, signal);
	const shopPage = shopPageOf(screen);
	const sheet = document.createElement("div");
	sheet.id = "print-shop-sheet";
	sheet.hidden = true;
	const images = faces.map((src) => {
		const image = document.createElement("img");
		image.src = src;
		image.alt = "";
		return image;
	});
	sheet.append(...images);
	document.body.append(sheet);
	const style = document.createElement("style");
	style.textContent = `@media print {
  @page { size: ${shopPage.width}mm ${shopPage.height}mm; margin: 0; }
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  body > :not(#print-shop-sheet) { display: none !important; }
  #print-shop-sheet { display: block !important; }
  #print-shop-sheet img { display: block; width: ${shopPage.width}mm; height: ${shopPage.height}mm; break-after: page; }
  #print-shop-sheet img:last-child { break-after: auto; }
}`;
	document.head.append(style);
	const documentTitle = document.title;
	document.title = `snapcards-${title.replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase()}-a6`;
	try {
		await Promise.all(images.map((image) => image.decode()));
		// A print finished blocks here in Chrome and Firefox; Safari returns at once
		// and reads the page late, so what it prints waits for afterprint.
		const printed = new Promise<void>((resolve) =>
			addEventListener("afterprint", () => resolve(), { once: true })
		);
		globalThis.print();
		await printed;
	} finally {
		document.title = documentTitle;
		style.remove();
		sheet.remove();
	}
}

export async function freezePrint(
	screen: HTMLElement,
	signal?: AbortSignal,
): Promise<FrozenPrint> {
	const { title, cards, family, load } = await deckOf(screen, signal);
	const words = cards.map((card) => {
		const word = card.dataset.front ??
			card.querySelector(".print-card-word")?.textContent;
		if (!word?.trim()) throw new Error("A card has no word");
		return word;
	});
	const images = await Promise.all(
		cards.map((card) => load(illustrationOf(card))),
	);
	const artwork: Uint8Array[] = [];
	let artworkBytes = 0;
	for (let i = 0; i < cards.length; i++) {
		if (signal?.aborted) throw signal.reason;
		const { canvas, context } = canvasOf(postcard.widthPx, postcard.heightPx);
		const { panels, trim } = postcard;
		drawArt(
			context,
			images[i],
			trimmed(panels.front, 0.88, 0.88),
		);
		drawWord(
			context,
			capitalized(words[i]),
			family,
			trimmed(panels.back, 0.84, 0.8),
			trim.width * 0.11,
		);
		const file = withDensity(await jpeg(canvas, QUALITY), postcard.dpi);
		artworkBytes += file.length;
		artwork.push(file);
	}
	return { title, cards: cards.length, artwork, artworkBytes };
}
