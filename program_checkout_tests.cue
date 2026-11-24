package snapcards

build: checks: "checkout-ui": {
	browser: true
	srcs: ["checkout-ui/*.ts", "commerce/catalogue.ts", "commerce/money.ts", "commerce/address-formats.json", "shell/shared/address-formats.css", "checkout-ui/deno.json", "checkout-ui/deno.lock", "screens/print.html", "shell/shell.json", "shell/screens/print.css", "messages/en.json"]
	cmds: [
		"deno task --config checkout-ui/deno.json --frozen build",
		"deno check --config checkout-ui/deno.json --frozen checkout-ui/checkout.ts checkout-ui/artwork.ts checkout-ui/build.ts checkout-ui/test.ts",
		"deno lint --config checkout-ui/deno.json checkout-ui/checkout.ts checkout-ui/artwork.ts checkout-ui/build.ts checkout-ui/test.ts",
		"deno task --config checkout-ui/deno.json --frozen test",
	]
	note: "Frozen multilingual postcard artwork and explicit simulated checkout preserve the chosen collection without live payment or mail requests."
}
