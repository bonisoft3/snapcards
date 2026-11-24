import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { css } from "./address-format.ts";
const root = new URL("./", import.meta.url);
await esbuild.build({
	entryPoints: [fileURLToPath(new URL("checkout.ts", root))],
	outfile: fileURLToPath(new URL("../shell/hatches/print-checkout.js", root)),
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2022",
	minify: true,
	legalComments: "eof",
});
esbuild.stop();
// The delivery form's shape for each country, read by the print screen's stylesheet.
await Deno.writeTextFile(new URL("../shell/shared/address-formats.css", root), css());
