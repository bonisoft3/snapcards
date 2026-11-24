// mecha's Pdf endowment, which the session's handler declares, as the cage grants it
// (libraries/mecha/services/airlock/pdf.ts): the tests run with the app's files alone.
// A module, so the tests that import it share one global.
import { PDFDocument } from "@pdfme/pdf-lib";

type Page = { jpeg: Uint8Array; x: number; y: number; width: number; height: number };
Object.defineProperty(globalThis, "Pdf", {
	value: Object.freeze({
		async fromJpegs({ size, title, pages }: { size: { width: number; height: number }; title?: string; pages: Page[] }) {
			const doc = await PDFDocument.create({ updateMetadata: false });
			if (title !== undefined) doc.setTitle(title);
			for (const { jpeg, ...at } of pages) doc.addPage([size.width, size.height]).drawImage(await doc.embedJpg(jpeg), at);
			return await doc.save({ objectsPerTick: Infinity });
		},
	}),
});
