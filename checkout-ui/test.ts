import { strict as assert } from "node:assert";
import { chromium } from "playwright";
import { PDFDocument } from "@pdfme/pdf-lib";
import { jpegSize } from "../commerce/catalogue.ts";

const shell = JSON.parse(await Deno.readTextFile(new URL("../shell/shell.json", import.meta.url)));
const printPath = new URL(`../${shell.routes.find((route: { screen: string }) => route.screen === "print").files.html}`, import.meta.url);

// The static screen has no chart to bind these; the interpreter's are in acceptance.
const asProdigi = `{
  const container = document.querySelector(".print-container");
  container.dataset.vendor = "prodigi";
  container.dataset.stock = "gloss";
  document.querySelector(".checkout-delivery").dataset.country = "";
}`;
// deno-lint-ignore no-explicit-any
const fillAddress = async (page: any) => {
  await page.fill("#delivery-recipient", "Marina");
  await page.fill("#delivery-line1", "Rua Augusta, 1508");
  await page.fill("#delivery-line2", "Apto 42");
  await page.fill("#delivery-city", "São Paulo");
  // Brazil's post requires the state (commerce/address-formats.json), and domestic courier shipping requires CPF.
  await page.fill("#delivery-region", "SP");
  await page.fill("#delivery-postal", "01305-100");
  await page.selectOption("#delivery-country", "BR");
  await page.fill("#delivery-cpf", "12345678909");
};

Deno.test("Print checkout freezes one 3708×1263 file per card, in every script, and simulates without live calls", async () => {
  const html = await Deno.readTextFile(printPath);
  // The screen's @import of the country shapes has no server here: inlined.
  const css = await Deno.readTextFile("../shell/shared/address-formats.css") + await Deno.readTextFile("../shell/screens/print.css");
  const messages = JSON.parse(await Deno.readTextFile("../messages/en.json"));
  const bundle = await Deno.readTextFile("../shell/hatches/print-checkout.js");
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/checkout.js") {
        return new Response(bundle, {
          headers: { "content-type": "text/javascript" },
        });
      }
      if (path !== "/") {
        return new Response("Unexpected request", {
          status: 404,
        });
      }
      return new Response(
        // The app's connect-src: an inlined illustration must reach the artwork
        // without a fetch the policy refuses.
        `<html lang="en"><head><meta http-equiv="Content-Security-Policy" content="connect-src 'self'"><style>:root{--surface:#fff;--primary:#222;--border:#ccc;--sp-md:16px;--sp-sm:8px;--sp-lg:24px;--r-md:8px;--border-size-1:1px;--font-serif:serif} .btn{padding:8px} ${css}</style></head><body>${html}</body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1100, height: 900 },
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.addr.port}`);
    await page.evaluate(async (catalogue) => {
      for (
        const node of document.querySelectorAll<HTMLElement>("[data-text]")
      ) {
        const match = /^\{msg\.([^}]+)\}$/.exec(node.dataset.text!);
        if (match) node.textContent = catalogue[match[1]];
      }
      document.querySelector(".active-press-pill")!.innerHTML =
        '<strong class="active-deck-name">Words · שלום · 你好</strong>';
      const preview = document.querySelector<HTMLElement>(
        ".print-sheet-preview",
      )!;
      Object.assign(preview.dataset, {
        paper: "a4",
        orientation: "portrait",
        cardSize: "standard",
        layout: "duplex_h",
        lines: "yes",
      });
      const svg = "data:image/svg+xml;charset=utf-8," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#ed8c28"/><circle cx="100" cy="100" r="65" fill="#246e53"/></svg>',
        );
      const front = document.querySelector<HTMLElement>(
        ".sheet-paper-primary .sheet-grid",
      )!;
      const back = document.querySelector<HTMLElement>(
        ".sheet-paper-duplex-back .sheet-grid",
      )!;
      front.replaceChildren();
      back.replaceChildren();
      for (let index = 0; index < 17; index++) {
        const word = ["Olá", "שלום", "你好"][index % 3] + " " + index;
        front.insertAdjacentHTML(
          "beforeend",
          `<div class="print-card-cell"><div class="print-card" data-front="${word}"><div class="print-card-front-half"><div class="print-card-illustration"><img class="card-illustration-img" src="${svg}"/></div></div><div class="print-card-back-half"><div class="print-card-word">${word}</div></div></div></div>`,
        );
        back.insertAdjacentHTML(
          "beforeend",
          `<div class="print-card-cell duplex-back-cell"><div class="print-card duplex-back-card"><div class="print-card-back-half"><div class="print-card-word">${word}</div></div></div></div>`,
        );
      }
      const illustration = front.querySelector<HTMLElement>(
        ".print-card-illustration",
      )!;
      illustration.style.backgroundImage = `url("${svg}")`;
      // A card without image artwork carries an empty src, which the print
      // sheet hides; its artwork is the background the review must use.
      illustration.querySelector<HTMLImageElement>("img")!.setAttribute("src", "");
      const module = await import("./checkout.js");
      module.default(document.querySelector('[data-screen="print"]'), {
        signal: new AbortController().signal,
        store: { http: fetch, upload: () => Promise.reject(new Error("no upload here")) },
      });
    }, messages);
    await page.evaluate(asProdigi);
    const pdf = await page.evaluate(async () => {
      const { freezePrint } = await import("./checkout.js");
      const frozen = await freezePrint(
        document.querySelector('[data-screen="print"]'),
      );
      return {
        cards: frozen.cards,
        artworkBytes: frozen.artworkBytes,
        files: frozen.artwork.map((file: Uint8Array) => Array.from(file)),
      };
    });
    assert.equal(pdf.cards, 17);
    assert.equal(pdf.files.length, 17);
    for (const bytes of pdf.files) {
      const file = Uint8Array.from(bytes as number[]);
      assert.deepEqual(jpegSize(file), { width: 3708, height: 1263 });
      // JFIF density: 300 dots per inch.
      assert.deepEqual([...file.subarray(13, 18)], [1, 1, 44, 1, 44]);
    }
    assert.ok(pdf.artworkBytes > 17 * 1000);
    // The working layout, on the pixels: the coloured art on the left, the black
    // word on the right.
    const color = await page.evaluate(async (bytes: number[]) => {
      const image = new Image();
      image.src = URL.createObjectURL(
        new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }),
      );
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const saturated = (x: number, width: number) => {
        const { data } = context.getImageData(x, 0, width, canvas.height);
        let count = 0;
        for (let at = 0; at < data.length; at += 4) {
          const channels = [data[at], data[at + 1], data[at + 2]];
          if (Math.max(...channels) - Math.min(...channels) > 60) count++;
        }
        return count;
      };
      const ink = (x: number, width: number) => {
        const { data } = context.getImageData(x, 0, width, canvas.height);
        let count = 0;
        for (let at = 0; at < data.length; at += 4) if (data[at] < 80) count++;
        return count;
      };
      return {
        left: saturated(0, 1854),
        right: saturated(1854, 1854),
        rightInk: ink(1854, 1854),
      };
    }, pdf.files[0] as number[]);
    assert.ok(color.left > 10000, "the illustration is on the left");
    assert.equal(color.right, 0, "nothing but the word is on the right");
    assert.ok(color.rightInk > 1000, "the word is on the right");
    await page.getByRole("button", { name: "Order printed cards" }).click();
    assert.equal(
      await page.locator("#print-checkout-panel").evaluate((
        node: HTMLDialogElement,
      ) => node.open),
      true,
    );
    assert.equal(await page.locator(".checkout-fan img").count(), 3);
    assert.equal(
      await page.locator(".checkout-fan img").first().evaluate(
        async (image: HTMLImageElement) => {
          await image.decode();
          return image.naturalWidth;
        },
      ),
      200,
    );
    assert.match(
      await page.locator("#print-checkout-layout").innerText(),
      /17 postcards · 6 × 4 in · Two-sided · Gloss laminated 280 gsm · Printed by Prodigi/,
    );
    await page.keyboard.press("Escape");
    assert.equal(
      await page.locator("#print-checkout-panel").isVisible(),
      false,
    );
    assert.equal(
      await page.locator("#btn-order-print").evaluate((node) =>
        node === document.activeElement
      ),
      true,
    );
    await page.locator("#btn-order-print").click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.locator("#print-checkout-panel").evaluate((node) =>
        node.getBoundingClientRect().width <= 390
      ),
    );
    await page.locator("#print-checkout-panel").screenshot({
      path: "/tmp/snapcards-checkout-mobile.png",
    });
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.locator("#print-checkout-panel").screenshot({
      path: "/tmp/snapcards-checkout-before.png",
    });
    // Initial state of the map is shadowed and covered by the reload button.
    assert.equal(await page.locator(".delivery-map-stage").getAttribute("data-stale"), "true");
    assert.equal(await page.locator("#btn-delivery-map-reload").isVisible(), true);
    // Missing mandatory fields keep the status naming what is missing (never
    // misreporting that the address disagrees with the map), pulse those fields,
    // and focus the first missing input on click.
    await page.fill("#delivery-text", "Santa Claus house");
    assert.equal(await page.locator("#btn-checkout-pay").isDisabled(), false);
    assert.match(
      await page.locator("#print-checkout-status").innerText(),
      /Recipient, Country, Street and number, City,? and Postal code/,
    );
    assert.equal(await page.locator(".delivery-need:visible").count(), 5);
    await page.locator("#btn-checkout-pay").click();
    assert.equal(await page.locator("#print-checkout-status").getAttribute("data-state"), "address_needed");
    assert.equal(await page.locator("#btn-checkout-pay").getAttribute("data-confirming"), null);
    assert.equal(await page.locator(".delivery-field:has(#delivery-recipient)").getAttribute("data-pulse"), "true");
    // Filling mandatory structured fields clears confirmation and automatically updates the map pin.
    await fillAddress(page);
    assert.equal(await page.locator(".delivery-need:visible").count(), 0);
    assert.equal(await page.locator(".delivery-map-stage").getAttribute("data-stale"), "false");
    assert.equal(await page.locator("#btn-delivery-map-reload").isVisible(), false);
    // Hovering structured fields (and apartamento) hints editability with zero vertical repainting.
    const beforeTop = await page.locator("#delivery-city"). evaluate((el) => el.getBoundingClientRect().top);
    await page.locator("#delivery-line1").hover();
    const afterHoverTop = await page.locator("#delivery-city").evaluate((el) => el.getBoundingClientRect().top);
    assert.equal(afterHoverTop, beforeTop, "hovering structured field must not cause vertical repainting");
    await page.locator("#delivery-line2").hover();
    assert.equal(
      await page.locator("#delivery-city").evaluate((el) => el.getBoundingClientRect().top),
      beforeTop,
      "hovering apartamento must not cause vertical repainting",
    );
    // Each country's form is its post's (commerce/address-formats.json): Brazil
    // writes a neighbourhood under the street and a state beside the city;
    // Britain has no state and calls its town the post town.
    const delivery = page.locator(".checkout-delivery");
    assert.equal(await page.locator(".f-D").isVisible(), true);
    assert.equal(await page.locator(".f-cpf").isVisible(), true);
    assert.equal(await page.locator("#delivery-cpf").inputValue(), "123.456.789-09");
    assert.match(
      await page.locator("#print-checkout-layout").innerText(),
      /17 cards \(spiral flip-deck\) · A6 · Wire-O spiral · 150 gsm silk, gloss laminated 250 gsm cover · Printed in Brazil · Correios SEDEX/,
    );
    assert.equal(await page.locator('label[for="delivery-district"]').innerText(), "Neighbourhood (optional)");
    await delivery.evaluate((node: HTMLElement) => node.dataset.country = "GB");
    assert.equal(await page.locator(".f-S").isVisible(), false);
    assert.equal(await page.locator(".f-D").isVisible(), false);
    assert.equal(await page.locator(".f-cpf").isVisible(), false);
    assert.equal(await page.locator('label[for="delivery-city"]').innerText(), "Post town");
    await delivery.evaluate((node: HTMLElement) => node.dataset.country = "BR");
    // Regression: missing or invalid CPF must name CPF in address_needed, pulse .f-cpf,
    // and focus #delivery-cpf on click instead of claiming the address looks wrong.
    await page.fill("#delivery-cpf", "");
    await page.locator("#btn-checkout-pay").click();
    assert.equal(await page.locator("#print-checkout-status").getAttribute("data-state"), "address_needed");
    assert.match(await page.locator("#print-checkout-status").innerText(), /\bCPF\b/);
    assert.equal(await page.locator(".f-cpf").getAttribute("data-pulse"), "true");
    assert.equal(await page.locator("#delivery-cpf").evaluate((el) => el === document.activeElement), true);
    await page.fill("#delivery-cpf", "111.111.111-11");
    await page.waitForFunction(() => document.querySelector("#print-checkout-status")!.textContent!.includes("(000.000.000-00)"));
    await page.locator("#btn-checkout-pay").click();
    assert.equal(await page.locator("#print-checkout-status").getAttribute("data-state"), "address_needed");
    assert.match(await page.locator("#print-checkout-status").innerText(), /CPF \(000\.000\.000-00\)/);
    await page.fill("#delivery-cpf", "12345678909");
    assert.equal(await page.locator("#delivery-cpf").inputValue(), "123.456.789-09");
    // A postcode that is not the country's is named with the post's example and keeps address_needed on click.
    await page.fill("#delivery-postal", "0130");
    await page.waitForFunction(() => document.querySelector("#print-checkout-status")!.textContent!.includes("(40301-110)"));
    assert.equal(await page.locator("#btn-checkout-pay").isDisabled(), false);
    await page.locator("#btn-checkout-pay").click();
    assert.equal(await page.locator("#print-checkout-status").getAttribute("data-state"), "address_needed");
    await page.fill("#delivery-postal", "01305-100");
    await page.getByRole("button", { name: "Continue to payment" }).click();
    await page.getByRole("button", { name: "Simulate payment approved" })
      .waitFor({ timeout: 30000 }).catch(async (error) => {
        throw new Error(
          await page.locator("#print-checkout-status").innerText(),
          { cause: error },
        );
      });
    await page.getByRole("button", { name: "Simulate payment approved" })
      .click();
    assert.match(
      await page.locator("#print-checkout-status").innerText(),
      /Nothing was charged or sent/,
    );
    assert.equal(await page.locator(".print-sheet-preview").count(), 1);
    await page.locator("#print-checkout-panel").screenshot({
      path: "/tmp/snapcards-checkout-after.png",
    });
    const missingImage = await page.evaluate(async () => {
      const { freezePrint } = await import("./checkout.js");
      const image = document.querySelectorAll<HTMLImageElement>(
        ".sheet-paper-primary img",
      )[1];
      image.src = "/card_images/missing-fixture.png";
      try {
        await freezePrint(document.querySelector('[data-screen="print"]'));
        return "unexpected success";
      } catch (error) {
        return String(error);
      }
    });
    assert.match(missingImage, /Illustration unavailable/);
    assert.equal(await page.locator(".print-sheet-preview").count(), 1);
    // Regression: a card's art is read after the card paints, and ordering in
    // that gap refused the deck with "no printable illustration".
    const lateArt = await page.evaluate(async () => {
      const { freezePrint } = await import("./checkout.js");
      const screen = document.querySelector<HTMLElement>('[data-screen="print"]')!;
      const images = screen.querySelectorAll<HTMLImageElement>(
        ".sheet-paper-primary img",
      );
      const image = images[1];
      image.src = images[images.length - 1].src;
      const holder = image.parentElement!;
      image.remove();
      setTimeout(() => holder.append(image), 200);
      const { cards } = await freezePrint(screen);
      image.remove();
      try {
        await freezePrint(screen);
        return { cards, never: "unexpected success" };
      } catch (error) {
        return { cards, never: String(error) };
      }
    });
    assert.ok(lateArt.cards > 1);
    assert.match(lateArt.never, /no printable illustration/);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: "/tmp/snapcards-checkout-panel.png" });
  } finally {
    await browser.close();
    await server.shutdown();
  }
});

Deno.test("Stripe charge units preserve zero-decimal currencies and ISK compatibility", async () => {
  const { currencyScale } = await import("./checkout.ts");
  for (
    const [currency, scale] of [["BRL", 100], ["JPY", 1], ["ISK", 100], [
      "UGX",
      100,
    ], ["KWD", 1000]] as const
  ) {
    if (currencyScale(currency) !== scale) {
      throw new Error(`Wrong display scale for ${currency}`);
    }
  }
});

// The order's machine as a browser meets it: a table it writes to and reads, whose
// invoking states settle by the next read.
function fakeCluster(bundle: string, page: string) {
  const rows = new Map<string, Record<string, unknown>>();
  const trackingRows = new Map<string, Record<string, unknown>>();
  const uploads: string[] = [];
  const asked = { quotes: [] as Record<string, unknown>[] };
  let payment = "open";
  let failOpen = false;
  let refusedCountry: string | null = null;
  let failCardsConstraint = false;
  const step = (row: Record<string, unknown>) => {
    if (row.status === "quoting" || row.status === "quoting_br") {
      Object.assign(row, { status: "quoted", item: 10300, shipping: 450, total: 10750, currency: "usd" });
    } else if (row.status === "opening") {
      if (failOpen) Object.assign(row, { status: "open_failed", failure: "failed: stripe refused" });
      else Object.assign(row, { status: "awaiting_payment", checkout_url: `https://checkout.example.test/c/pay/${row.id}` });
    } else if (row.status === "checking") {
      const ended = ["expired", "failed"].includes(payment);
      Object.assign(row, { status: ended ? "unpaid" : "awaiting_payment", payment_state: payment });
    }
  };
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/checkout.js") {
      return new Response(bundle, { headers: { "content-type": "text/javascript" } });
    }
    if (url.pathname === "/crud/print_order") {
      const id = url.searchParams.get("id")?.replace("eq.", "");
      if (request.method === "POST") {
        const body = await request.json();
        if (failCardsConstraint || typeof body.cards !== "number" || body.cards < 1 || body.cards > 100) {
          return Response.json({ error: 'new row for relation "print_order" violates check constraint "print_order_cards_check"' }, { status: 500 });
        }
        if (body.country === refusedCountry || !["BR", "AR", "IL", "US", "GB", "CN", "IN"].includes(body.country)) {
          return Response.json({ error: 'new row for relation "print_order" violates check constraint "print_order_country_check"' }, { status: 500 });
        }
        const row = { id: crypto.randomUUID(), status: "draft", checks: 0, delivery: null, artwork: null, item: null, shipping: null, total: null, currency: null, checkout_url: null, payment_state: null, vendor_state: null, failure: null, ...body };
        rows.set(row.id, row);
        asked.quotes.push(row);
        return Response.json([row], { status: 201 });
      }
      if (request.method === "PATCH") {
        const row = rows.get(id!)!;
        if (row.status === "open_failed") {
          return Response.json({ error: "cannot transition from final state open_failed on print_order" }, { status: 500 });
        }
        Object.assign(row, await request.json());
        return Response.json([row]);
      }
      if (!id) return Response.json([]);
      const row = rows.get(id);
      if (row) step(row);
      return Response.json(row ? [row] : []);
    }
    if (url.pathname === "/crud/print_order_tracking") {
      const id = url.searchParams.get("id")?.replace("eq.", "");
      const row = id ? trackingRows.get(id) : undefined;
      return Response.json(row ? [row] : []);
    }
    return new Response(page, { headers: { "content-type": "text/html" } });
  });
  return {
    server,
    rows,
    trackingRows,
    uploads,
    asked,
    origin: `http://127.0.0.1:${server.addr.port}`,
    pay: (state: string) => payment = state,
    refuseOpening: (refuse: boolean) => failOpen = refuse,
    refuseCountry: (country: string | null) => refusedCountry = country,
    refuseCardsConstraint: (refuse: boolean) => failCardsConstraint = refuse,
  };
}
const screenPage = async () => {
  const html = await Deno.readTextFile(printPath);
  // The screen's @import of the country shapes has no server here: inlined.
  const css = await Deno.readTextFile("../shell/shared/address-formats.css") + await Deno.readTextFile("../shell/screens/print.css");
  return `<html lang="en"><head><style>:root{--surface:#fff;--primary:#222;--border:#ccc;--sp-md:16px;--sp-sm:8px;--sp-lg:24px;--r-md:8px;--border-size-1:1px;--font-serif:serif} ${css}</style></head><body>${html}</body></html>`;
};
// deno-lint-ignore no-explicit-any
const mountLive = async (page: any, messages: unknown, origin: string, path: string, title: string) => {
  await page.goto(origin + path);
  await page.evaluate(async ({ catalogue, title }: { catalogue: Record<string, string>; title: string }) => {
    for (const node of document.querySelectorAll<HTMLElement>("[data-text]")) {
      const match = /^\{msg\.([^}]+)\}$/.exec(node.dataset.text!);
      if (match) node.textContent = catalogue[match[1]];
    }
    const uploads: string[] = [];
    Object.assign(globalThis, { uploads });
    const store = {
      http: (url: string, init: RequestInit) => fetch(url, init),
      upload: (key: string) => {
        uploads.push(key);
        return Promise.resolve(new Response(null));
      },
    };
    const screen = document.querySelector<HTMLElement>('[data-screen="print"]')!;
    document.querySelector(".active-press-pill")!.innerHTML = `<strong class="active-deck-name">${title}</strong>`;
    document.querySelector(".sheet-paper-primary .sheet-grid")!.innerHTML =
      '<div class="print-card-cell"><div class="print-card" data-id="c1" data-front="Hello"><div class="print-card-illustration"><img src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2710%27 height=%2710%27%3E%3C/svg%3E"></div><div class="print-card-word">Hello</div></div></div>';
    document.querySelector(".sheet-paper-duplex-back .sheet-grid")!.replaceChildren();
    const container = document.querySelector<HTMLElement>(".print-container")!;
    container.dataset.vendor = "prodigi";
    container.dataset.stock = "gloss";
    document.querySelector<HTMLElement>(".checkout-delivery")!.dataset.country = "";
    const module = await import("./checkout.js");
    module.default(screen, { signal: new AbortController().signal, store });
  }, { catalogue: messages, title });
  await page.locator('[data-screen="print"][data-commerce-mode="live"]').waitFor({ state: "attached" });
};

Deno.test("an order runs on its row: the price is quoted once a country is known, a cancelled session resumes, an expired one starts anew", async () => {
  const messages = JSON.parse(await Deno.readTextFile("../messages/en.json"));
  const cluster = fakeCluster(await Deno.readTextFile("../shell/hatches/print-checkout.js"), await screenPage());
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const external: string[] = [];
    await page.route("https://checkout.example.test/**", async (route) => {
      external.push(route.request().url());
      await route.fulfill({ contentType: "text/html", body: "<h1>Intercepted fixture checkout</h1>" });
    });
    await mountLive(page, messages, cluster.origin, "/", "Original deck");
    const carouselStyle = await page.locator(".deck-picker-carousel").evaluate((el: HTMLElement) => {
      const cs = getComputedStyle(el);
      return { overflowY: cs.overflowY, scrollbarWidth: cs.scrollbarWidth };
    });
    assert.deepEqual(carouselStyle, { overflowY: "hidden", scrollbarWidth: "none" });
    assert.equal(await page.locator(".deck-picker-nav-prev").count(), 1);
    assert.equal(await page.locator(".deck-picker-nav-next").count(), 1);
    await page.locator("#btn-order-print").click();
    await page.fill("#delivery-text", "Casa azul atrás da escola");
    assert.equal(await page.locator("#btn-checkout-pay").isDisabled(), false);
    assert.equal(cluster.asked.quotes.length, 0);
    await fillAddress(page);
    await page.locator('#print-checkout-status[data-state="quoted"]').waitFor();
    assert.match(await page.locator('[data-quote="total"]').innerText(), /\$107\.50/);
    const firstQuotedId = await page.locator(".checkout-delivery").getAttribute("data-order-id");
    assert.ok(firstQuotedId, "quoted order id is bound on .checkout-delivery for device persistence");
    // Trigger 1: once both frozen artwork and the quoted order id are ready, artwork
    // is pre-uploaded in the background and attached to the quoted print_order row
    // before the reader clicks Continue to Payment.
    await page.waitForFunction(() => (globalThis as unknown as { uploads: string[] }).uploads?.length === 1);
    assert.equal((cluster.rows.get(firstQuotedId!)!.artwork as string[])?.length, 1);
    // Across a page reload where delivery_draft restores the address and data-order-id,
    // opening checkout reuses the existing quoted print_order row and its pre-uploaded
    // artwork without minting a second print_order row or re-uploading blobs.
    await mountLive(page, messages, cluster.origin, "/", "Original deck");
    await page.locator(".checkout-delivery").evaluate((node: HTMLElement, id: string) => {
      node.dataset.orderId = id;
    }, firstQuotedId!);
    await page.locator("#btn-order-print").click();
    await fillAddress(page);
    await page.locator('#print-checkout-status[data-state="quoted"]').waitFor();
    assert.equal(cluster.asked.quotes.length, 1, "reloaded page reuses the persisted print_order instead of creating a new one");
    assert.equal(await page.locator(".checkout-delivery").getAttribute("data-order-id"), firstQuotedId);
    assert.equal(await page.evaluate(() => (globalThis as unknown as { uploads: string[] }).uploads.length), 0, "reloaded page reuses pre-uploaded artwork on the print_order row");
    // An edit in the same country costs Prodigi nothing.
    await page.fill("#delivery-line2", "Apto 2");
    await page.waitForTimeout(600);
    assert.equal(cluster.asked.quotes.length, 1);
    // Editing after GPS makes the pin stale until reload is clicked; missing street
    // numbers in search suggestions offer one-click inline editing, and focusing out
    // picks the first suggestion automatically.
    await page.evaluate(() => {
      const sec = document.querySelector<HTMLElement>(".checkout-delivery")!;
      sec.dataset.pinSource = "gps";
      sec.dataset.pinLatitude = "-23.5612";
      sec.dataset.pinLongitude = "-46.6558";
      const txt = document.querySelector<HTMLInputElement>("#delivery-text")!;
      txt.value = "Rua Augusta, São Paulo";
      txt.setAttribute("data-value", "Rua Augusta, São Paulo");
      const list = document.querySelector<HTMLElement>("#delivery-suggestions")!;
      sec.dataset.step = "search";
      list.innerHTML = `<button type="button" class="delivery-suggestion" data-id="s0"><span class="delivery-suggestion-line">Rua Augusta</span><span class="delivery-suggestion-place">Consolação, São Paulo</span><span class="delivery-suggestion-use">Use</span></button>`;
    });
    await page.locator(".delivery-suggestion-add-number").waitFor({ state: "visible" });
    await page.locator(".delivery-suggestion-add-number").click();
    await page.locator(".delivery-suggestion-number-input").fill("1508");
    await page.locator(".delivery-suggestion-number-input").press("Enter");
    assert.equal(await page.locator("#delivery-line1").inputValue(), "Rua Augusta, 1508");
    assert.equal(await page.locator("#delivery-text").inputValue(), "Rua Augusta, 1508");
    assert.equal(await page.locator(".checkout-delivery").getAttribute("data-step"), "details");
    assert.equal(await page.locator(".delivery-suggestions").isVisible(), false);
    assert.equal(await page.locator(".delivery-map-stage").getAttribute("data-stale"), "false");
    // Accepting a suggestion completes the search box minimally to line1 plus the
    // prefix needed to disambiguate it from sibling suggestions, covering typed numbers.
    await page.evaluate(() => {
      const sec = document.querySelector<HTMLElement>(".checkout-delivery")!;
      const txt = document.querySelector<HTMLInputElement>("#delivery-text")!;
      txt.value = "rua augusta 1508";
      sec.dataset.step = "search";
      const list = document.querySelector<HTMLElement>("#delivery-suggestions")!;
      list.innerHTML = [
        `<button type="button" class="delivery-suggestion" data-id="s0" data-line1="Rua Augusta" data-district="Consolação" data-city="São Paulo" data-postal="" data-country="BR" data-label="Rua Augusta, Consolação, São Paulo"><span class="delivery-suggestion-line">Rua Augusta</span><span class="delivery-suggestion-place">Rua Augusta, Consolação, São Paulo</span><span class="delivery-suggestion-use">Use</span></button>`,
        `<button type="button" class="delivery-suggestion" data-id="s1" data-line1="Rua Augusta, 1508" data-district="Centro" data-city="Curitiba" data-postal="" data-country="BR" data-label="Rua Augusta, Centro, Curitiba"><span class="delivery-suggestion-line">Rua Augusta, 1508</span><span class="delivery-suggestion-place">Rua Augusta, Centro, Curitiba</span><span class="delivery-suggestion-use">Use</span></button>`,
      ].join("");
    });
    await page.locator('.delivery-suggestion[data-id="s0"]').click();
    assert.equal(await page.locator("#delivery-line1").inputValue(), "Rua Augusta, 1508");
    assert.equal(await page.locator("#delivery-text").inputValue(), "Rua Augusta, 1508, Consolação");
    assert.equal(await page.locator("#delivery-postal").inputValue(), "01305-100");
    assert.equal(await page.locator("#delivery-district").inputValue(), "Consolação");
    assert.equal(await page.locator(".checkout-delivery").getAttribute("data-step"), "details");
    assert.equal(await page.locator(".delivery-suggestions").isVisible(), false);
    await page.fill("#delivery-line2", "Apto 22");
    assert.equal(await page.locator(".delivery-search").getAttribute("data-stale"), null);
    assert.equal(await page.locator(".delivery-map-stage").getAttribute("data-stale"), "true");
    assert.equal(await page.locator("#btn-delivery-map-reload").isVisible(), true);
    await page.locator("#btn-delivery-map-reload").click();
    assert.equal(await page.locator(".delivery-map-stage").getAttribute("data-stale"), "false");
    // Changing a derived field grays out the search box; changing the street address
    // erases apartamento into a gray ghost available for completion, pulses the stale
    // field without shifting the pay button vertically, and can be dismissed.
    await page.fill("#delivery-line1", "Rua Haddock Lobo, 595");
    assert.equal(await page.locator(".delivery-search").getAttribute("data-stale"), "true");
    assert.equal(await page.locator("#delivery-line2").inputValue(), "");
    assert.equal(await page.locator("#delivery-line2").getAttribute("data-ghost"), "Apto 22");
    assert.equal(await page.locator(".f-line2").getAttribute("data-stale"), "true");
    const payOffsetTopBefore = await page.locator("#btn-checkout-pay").evaluate((el: HTMLElement) => el.offsetTop);
    await page.locator("#btn-checkout-pay").click();
    assert.equal(await page.locator("#print-checkout-status").getAttribute("data-state"), "confirm_address");
    assert.equal(await page.locator("#btn-checkout-pay").evaluate((el: HTMLElement) => el.offsetTop), payOffsetTopBefore);
    assert.equal(await page.locator(".f-line2").getAttribute("data-pulse"), "true");
    await page.locator("#btn-checkout-status-dismiss").click();
    assert.equal(await page.locator(".checkout-status-slot").getAttribute("data-dismissed"), "true");
    await page.fill("#delivery-line1", "Rua Augusta, 1508");
    await page.locator("#delivery-line2").focus();
    await page.locator("#delivery-line2").press("Tab");
    assert.equal(await page.locator("#delivery-line2").inputValue(), "Apto 22");
    assert.equal(await page.locator("#delivery-text").inputValue(), "Rua Augusta, 1508, Consolação");
    assert.equal(await page.locator(".f-line2").getAttribute("data-stale"), null);
    // Regression: reloading the map pin waits for the matching address_q answer instead
    // of falling back to a stale cached address answer or fabricating a default country pin.
    await page.evaluate(() => {
      const sec = document.querySelector<HTMLElement>(".checkout-delivery")!;
      sec.dataset.pinLatitude = "";
      sec.dataset.pinLongitude = "";
      const answers = sec.querySelector<HTMLElement>('[data-live="place_answer"]')!;
      answers.innerHTML = `<span data-kind="address" data-q="Old Street 100" data-p0="Old\tOld Street 100\tSão Paulo\tSP\t01000-000\tBR\t-10.0000\t-20.0000\tCentro"></span>`;
    });
    await page.locator("#btn-delivery-map-reload").click();
    assert.equal(await page.locator(".delivery-map-stage").getAttribute("data-stale"), "false");
    assert.equal(await page.locator(".checkout-delivery").getAttribute("data-pin-latitude"), "");
    await page.evaluate(() => {
      const sec = document.querySelector<HTMLElement>(".checkout-delivery")!;
      const answers = sec.querySelector<HTMLElement>('[data-live="place_answer"]')!;
      answers.insertAdjacentHTML(
        "beforeend",
        `<span data-kind="address" data-q="Rua Augusta, 1508 Consolação 01305-100 São Paulo SP BR" data-p0="Rua Augusta, 1508\tRua Augusta, 1508\tSão Paulo\tSP\t01305-100\tBR\t-23.5566\t-46.6587\tConsolação"></span>`,
      );
    });
    assert.equal(await page.locator(".checkout-delivery").getAttribute("data-pin-latitude"), "-23.5566");
    // Country picker opens a styled editorial menu instead of only the OS popup.
    await page.locator("#delivery-country").dispatchEvent("mousedown");
    await page.locator(".delivery-country-menu").waitFor({ state: "visible" });
    await page.locator('.delivery-country-option[data-country-value="BR"]').click();
    assert.equal(await page.locator(".delivery-country-menu").isVisible(), false);
    // Toggling GPS off erases non-edited GPS search text into a gray ghost placeholder,
    // and cursor completion (Tab/Arrow) completes it and triggers search results.
    await page.evaluate(() => {
      const sec = document.querySelector<HTMLElement>(".checkout-delivery")!;
      sec.dataset.pinSource = "gps";
    });
    await page.evaluate(() => {
      const sec = document.querySelector<HTMLElement>(".checkout-delivery")!;
      sec.dataset.pinSource = "";
      sec.dataset.pinLatitude = "";
      sec.dataset.pinLongitude = "";
    });
    assert.equal(await page.locator("#delivery-text").inputValue(), "");
    assert.equal(await page.locator("#delivery-text").getAttribute("data-ghost"), "Rua Augusta, 1508, Consolação");
    await page.locator("#delivery-text").focus();
    await page.locator("#delivery-text").press("Tab");
    assert.equal(await page.locator("#delivery-text").inputValue(), "Rua Augusta, 1508, Consolação");
    assert.equal(await page.locator("#btn-delivery-search").getAttribute("data-state"), "loading");
    await page.waitForFunction(() => document.querySelector(".checkout-delivery")?.getAttribute("data-step") === "search");
    await page.locator(".delivery-suggestions-close").click();
    assert.equal(await page.locator(".checkout-delivery").getAttribute("data-step"), "details");
    assert.equal(await page.locator(".delivery-suggestions").isVisible(), false);
    // Option A: when GPS reverse-geocoding succeeds, it populates structured fields immediately
    // even if the forward search returns 0 results.
    await page.evaluate(() => {
      const sec = document.querySelector<HTMLElement>(".checkout-delivery")!;
      const txt = document.querySelector<HTMLInputElement>("#delivery-text")!;
      txt.value = "";
      sec.dataset.searchText = "";
      sec.dataset.near = "-23.5612,-46.6558";
      sec.dataset.pinSource = "gps";
      sec.dataset.pinLatitude = "-23.5612";
      sec.dataset.pinLongitude = "-46.6558";
      const answers = sec.querySelector<HTMLElement>('[data-live="place_answer"]')!;
      answers.innerHTML = [
        `<span data-kind="reverse" data-q="-23.5612,-46.6558" data-p0="Av. Paulista, 1578, São Paulo\tAvenida Paulista, 1578\tSão Paulo\tSP\t01310-200\tBR\t-23.5612\t-46.6558\tBela Vista"></span>`,
        `<span data-kind="search" data-q="Avenida Paulista, 1578, São Paulo\t-23.5612,-46.6558" data-p0=""></span>`,
      ].join("");
    });
    assert.equal(await page.locator("#delivery-line1").inputValue(), "Avenida Paulista, 1578");
    assert.equal(await page.locator("#delivery-district").inputValue(), "Bela Vista");
    assert.equal(await page.locator("#delivery-postal").inputValue(), "01310-200");
    assert.equal(await page.locator(".checkout-delivery").getAttribute("data-step"), "details");
    await page.fill("#delivery-line2", "Apto 22");
    await page.locator("#btn-delivery-map-reload").click();
    // Regression: a refused session leaves open_failed (a final state), so clicking
    // pay again must mint a fresh order instead of PATCHing the open_failed row.
    cluster.refuseOpening(true);
    await page.locator("#btn-checkout-pay").click();
    await page.getByRole("alert").waitFor();
    assert.match(await page.locator("#print-checkout-status").innerText(), /stripe refused/);
    cluster.refuseOpening(false);
    await page.locator("#btn-checkout-pay").click();
    await page.waitForFunction(() => document.querySelector<HTMLElement>("#print-checkout-status")?.dataset.state === "redirecting");
    await page.locator("#print-checkout-payment iframe").waitFor({ state: "visible" });
    assert.equal(external.length, 1);
    const id = new URL(external[0]).pathname.split("/").at(-1)!;
    const row = cluster.rows.get(id)!;
    assert.equal((row.artwork as string[]).length, 1);
    assert.equal((row.delivery as { address: { recipient: string } }).address.recipient, "Marina");
    // Nothing of the price or the payment is the browser's to write.
    assert.equal(row.total, 10750);

    // Regression: returning with Browser Back from embedded Stripe,
    // picking an address in another city (which clears line2 to a stale ghost),
    // and clicking Continue to Payment must keep the pin fresh, ask for address
    // confirmation, and never hide .checkout-delivery as a stale receipt.
    await page.goBack();
    assert.equal(await page.locator("#print-checkout-payment").isVisible(), false);
    assert.equal(await page.locator(".checkout-delivery").isVisible(), true);
    assert.equal(await page.locator("#delivery-line1").isVisible(), true);
    await page.fill("#delivery-text", "Av. Atlântica 1702 Rio");
    await page.evaluate(() => {
      const box = document.querySelector<HTMLElement>("#delivery-suggestions")!;
      box.innerHTML = `<button type="button" class="delivery-suggestion" data-id="s0" data-line1="Avenida Atlântica, 1702" data-district="Copacabana" data-city="Rio de Janeiro" data-region="RJ" data-postal="22021-001" data-country="BR" data-latitude="-22.9711" data-longitude="-43.1822" data-label="Copacabana, Rio de Janeiro, RJ, 22021-001, Brasil" data-q="av atlantica 1702 rio"><span class="delivery-suggestion-line">Avenida Atlântica, 1702</span><span class="delivery-suggestion-place">Copacabana, Rio de Janeiro, RJ, 22021-001, Brasil</span></button>`;
    });
    await page.locator('.delivery-suggestion[data-id="s0"]').click();
    assert.equal(await page.locator("#delivery-line1").inputValue(), "Avenida Atlântica, 1702");
    assert.equal(await page.locator("#delivery-city").inputValue(), "Rio de Janeiro");
    assert.equal(await page.locator("#delivery-line2").inputValue(), "");
    assert.equal(await page.locator("#delivery-line2").getAttribute("data-ghost"), "Apto 22");
    assert.equal(await page.locator(".f-line2").getAttribute("data-stale"), "true");
    assert.equal(await page.locator(".delivery-map-stage").getAttribute("data-stale"), "false");
    assert.equal(await page.locator(".checkout-delivery").getAttribute("data-pin-stale"), "false");

    await page.locator("#btn-checkout-pay").click();
    assert.equal(await page.locator(".checkout-delivery").getAttribute("data-step"), "confirming");
    assert.equal(await page.locator("#print-checkout-status").getAttribute("data-state"), "confirm_address");
    assert.equal(await page.locator(".f-line2").getAttribute("data-pulse"), "true");
    assert.equal(await page.locator(".checkout-delivery").isVisible(), true);

    await page.locator("#btn-checkout-pay").click();
    await page.locator('#print-checkout-payment iframe[src*="checkout.example.test/c/pay/"]').waitFor({ state: "visible" });
    assert.equal(external.length, 2);
    const secondId = new URL(external[1]).pathname.split("/").at(-1)!;
    assert.notEqual(secondId, id);
    assert.equal((cluster.rows.get(secondId)!.delivery as { address: { city: string } }).address.city, "Rio de Janeiro");

    await mountLive(page, messages, cluster.origin, `/?order=${id}&checkout=cancelled`, "Edited deck");
    await page.locator("#print-checkout-panel").waitFor({ state: "visible" });
    assert.equal(await page.locator("#print-checkout-collection").innerText(), "Original deck");
    assert.equal(await page.locator("#btn-checkout-new").isVisible(), true);
    await page.getByRole("button", { name: "Resume checkout", exact: true }).click();
    await page.locator(`#print-checkout-payment iframe[src="https://checkout.example.test/c/pay/${id}"]`).waitFor({ state: "visible" });
    assert.equal(external.length, 3);
    // The resume asked Stripe once; each read is a new ledger key.
    assert.equal(cluster.rows.get(id)!.checks, 1);
    await page.goBack();
    assert.equal(await page.locator("#print-checkout-payment").isVisible(), false);
    assert.equal(await page.locator("#print-checkout-delivery-summary").isVisible(), false);
    assert.equal(await page.locator("#btn-checkout-refresh").isVisible(), false);
    assert.equal(await page.locator("#btn-checkout-new").isVisible(), false);
    assert.equal(await page.locator(".checkout-delivery").isVisible(), true);
    assert.equal(await page.locator("#delivery-line1").isVisible(), true);
    await page.goForward();
    await page.locator(`#print-checkout-payment iframe[src="https://checkout.example.test/c/pay/${id}"]`).waitFor({ state: "visible" });
    assert.equal(external.length, 4);
    await page.locator("#btn-checkout-close").click();
    await page.waitForFunction(() => location.hash === "#print-checkout-panel");
    assert.equal(await page.evaluate(() => new URL(location.href).searchParams.get("order")), null);
    await page.goto("about:blank");
    // Regression: returning to ?order=...&checkout=cancelled with a typo in the
    // locked Stripe session's email lets the buyer start a new order in place,
    // prefilling the prior delivery fields so the email can be edited immediately.
    (cluster.rows.get(id)!.delivery as { contact: { email: string } }).contact.email = "typo@example.test";
    await mountLive(page, messages, cluster.origin, `/?order=${id}&checkout=cancelled#print-checkout-panel`, "Edited deck");
    await page.locator("#print-checkout-panel").waitFor({ state: "visible" });
    await page.locator("#btn-checkout-new").click();
    await page.locator(".checkout-delivery").waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => new URL(location.href).searchParams.get("order")), null);
    assert.equal(await page.evaluate(() => new URL(location.href).searchParams.get("checkout")), null);
    assert.equal(await page.locator("#delivery-email").inputValue(), "typo@example.test");
    await page.fill("#delivery-email", "fixed@example.test");
    await page.locator('#print-checkout-status[data-state="quoted"]').waitFor();
    await page.locator("#btn-checkout-pay").click();
    await page.locator('#print-checkout-payment iframe[src*="checkout.example.test/c/pay/"]').waitFor({ state: "visible" });
    const correctedId = new URL(external.at(-1)!).pathname.split("/").at(-1)!;
    assert.notEqual(correctedId, id);
    assert.equal((cluster.rows.get(correctedId)!.delivery as { contact: { email: string } }).contact.email, "fixed@example.test");
    await page.goto("about:blank");
    await mountLive(page, messages, cluster.origin, `/?order=${id}#print-checkout-payment`, "Original deck");
    await page.locator(`#print-checkout-payment iframe[src="https://checkout.example.test/c/pay/${id}"]`).waitFor({ state: "visible" });
    assert.equal(external.length, 6);

    // Returning to ?order=... (without checkout=cancelled) checks reactively
    // without exposing a manual Refresh button or Resume checkout CTA.
    cluster.pay("processing");
    await mountLive(page, messages, cluster.origin, `/?order=${id}`, "Original deck");
    await page.locator("#print-checkout-panel").waitFor({ state: "visible" });
    assert.equal(await page.locator("#btn-checkout-refresh").isVisible(), false);
    await page.locator('#print-checkout-status[data-state="processing"]').waitFor();
    assert.equal(await page.locator("#btn-checkout-pay").isVisible(), false);

    cluster.pay("expired");
    await mountLive(page, messages, cluster.origin, `/?order=${id}`, "Replacement deck");
    await page.locator("#print-checkout-panel").waitFor({ state: "visible" });
    assert.equal(await page.locator("#btn-checkout-refresh").isVisible(), false);
    await page.locator('#print-checkout-status[data-state="expired"]').waitFor();
    await page.getByRole("button", { name: "Start a new print order", exact: true }).click();
    await page.locator('#print-checkout-status[data-state="address_needed"], #print-checkout-status[data-state="quoted"]').waitFor();
    await fillAddress(page);
    await page.locator('#print-checkout-status[data-state="quoted"]').waitFor();
    assert.equal(cluster.asked.quotes.at(-1)!.title, "Replacement deck");
    assert.notEqual(cluster.asked.quotes.at(-1)!.id, id);
  } finally {
    await browser.close();
    await cluster.server.shutdown();
  }
});

Deno.test("a changed deck or stock is a new order with its own price", async () => {
  const messages = JSON.parse(await Deno.readTextFile("../messages/en.json"));
  const cluster = fakeCluster(await Deno.readTextFile("../shell/hatches/print-checkout.js"), await screenPage());
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await mountLive(page, messages, cluster.origin, "/", "Ocean");
    await page.locator("#btn-order-print").click();
    await fillAddress(page);
    await page.locator('#print-checkout-status[data-state="quoted"]').waitFor();
    await page.locator("#btn-checkout-close").click();
    await page.evaluate(() => {
      document.querySelector(".active-deck-name")!.textContent = "Space";
      const card = document.querySelector<HTMLElement>(".sheet-paper-primary .print-card")!;
      const second = card.closest(".print-card-cell")!.cloneNode(true) as HTMLElement;
      card.closest(".sheet-grid")!.append(second);
    });
    await page.locator("#btn-order-print").click();
    assert.equal(await page.locator("#print-checkout-collection").innerText(), "Space");
    await page.fill("#delivery-line2", "Apto 2");
    await page.locator('#print-checkout-status[data-state="quoted"]').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-quote="item-label"]')?.textContent?.startsWith("2 "));
    assert.equal(cluster.asked.quotes.at(-1)!.title, "Space");
    assert.equal(cluster.asked.quotes.at(-1)!.cards, 2);
    await page.locator("#btn-checkout-close").click();
    const before = cluster.asked.quotes.length;
    await page.locator(".print-container").evaluate((node: HTMLElement) => {
      node.dataset.stock = "mohawk";
    });
    await page.locator("#btn-order-print").click();
    await page.fill("#delivery-line2", "Apto 3");
    await page.waitForFunction(() => document.querySelector("#print-checkout-status")?.getAttribute("data-state") === "quoted");
    assert.ok(cluster.asked.quotes.length > before);
    assert.equal(cluster.asked.quotes.at(-1)!.stock, "mohawk");

    // Regression: clicking Order immediately after picking a deck whose cards have
    // not yet rendered — whether the sheet was empty (0 cards after deleting a deck)
    // or still held another deck's same-count cards — waits for the picked deck's
    // data-set-id cards and art instead of opening with stale/zero cards.
    await page.locator("#btn-checkout-close").click();
    await page.evaluate(() => {
      const container = document.querySelector<HTMLElement>(".print-container")!;
      container.dataset.setId = "09440a66-ff6f-494a-39c9-60e67740a0a3";
      document.querySelector(".deck-picker-carousel")!.innerHTML =
        `<button type="button" class="deck-picker-card" data-id="09440a66-ff6f-494a-39c9-60e67740a0a3"><span class="picker-card-name">Ocean Animals</span><span class="meta-tag"><b>3</b></span></button>`;
      document.querySelector(".active-deck-name")!.textContent = "Ocean Animals";
      const grid = document.querySelector<HTMLElement>(".sheet-paper-primary .sheet-grid")!;
      const svg = "data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2710%27 height=%2710%27%3E%3C/svg%3E";
      // Stale 3-card deck still in DOM when Order is clicked, replaced 150ms later by Ocean Animals' 3 cards.
      grid.innerHTML = ["Mango", "Guava", "Papaya"].map((w, i) =>
        `<div class="print-card-cell"><div class="print-card" data-id="fr-${i}" data-set-id="stale-fruit-deck" data-front="${w}"><div class="print-card-illustration"><img class="card-illustration-img" src="${svg}"></div><div class="print-card-word">${w}</div></div></div>`
      ).join("");
      setTimeout(() => {
        grid.innerHTML = ["Whale", "Octopus", "Turtle"].map((w, i) =>
          `<div class="print-card-cell"><div class="print-card" data-id="oa-${i}" data-set-id="09440a66-ff6f-494a-39c9-60e67740a0a3" data-front="${w}"><div class="print-card-illustration"><img class="card-illustration-img" src="${svg}"></div><div class="print-card-word">${w}</div></div></div>`
        ).join("");
      }, 150);
    });
    await page.locator("#btn-order-print").click();
    await page.locator("#print-checkout-panel").waitFor({ state: "visible" });
    assert.equal(await page.locator("#print-checkout-collection").innerText(), "Ocean Animals");
    assert.equal(await page.locator(".checkout-fan img").count(), 3);
    await page.waitForFunction(() => document.querySelector("#print-checkout-status")?.getAttribute("data-state") === "quoted");
    assert.equal(cluster.asked.quotes.at(-1)!.title, "Ocean Animals");
    assert.equal(cluster.asked.quotes.at(-1)!.cards, 3);
    await page.waitForFunction(() => (globalThis as unknown as { uploads: string[] }).uploads?.length >= 3);
    assert.equal((cluster.rows.get(cluster.asked.quotes.at(-1)!.id as string)!.artwork as string[]).length, 3);

    // Also verify starting from 0 cards in .sheet-grid (e.g. after deleting a generated deck).
    await page.locator("#btn-checkout-close").click();
    await page.evaluate(() => {
      const container = document.querySelector<HTMLElement>(".print-container")!;
      container.dataset.setId = "11111111-2222-4333-8444-555555555555";
      document.querySelector(".deck-picker-carousel")!.innerHTML =
        `<button type="button" class="deck-picker-card" data-id="11111111-2222-4333-8444-555555555555"><span class="picker-card-name">Rainforest</span><span class="meta-tag"><b>2</b></span></button>`;
      document.querySelector(".active-deck-name")!.textContent = "Rainforest";
      const grid = document.querySelector<HTMLElement>(".sheet-paper-primary .sheet-grid")!;
      grid.replaceChildren();
      const svg = "data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2710%27 height=%2710%27%3E%3C/svg%3E";
      setTimeout(() => {
        grid.innerHTML = ["Toucan", "Sloth"].map((w, i) =>
          `<div class="print-card-cell"><div class="print-card" data-id="rf-${i}" data-set-id="11111111-2222-4333-8444-555555555555" data-front="${w}"><div class="print-card-illustration"><img class="card-illustration-img" src="${svg}"></div><div class="print-card-word">${w}</div></div></div>`
        ).join("");
      }, 150);
    });
    await page.locator("#btn-order-print").click();
    await page.locator("#print-checkout-panel").waitFor({ state: "visible" });
    assert.equal(await page.locator("#print-checkout-collection").innerText(), "Rainforest");
    assert.equal(await page.locator(".checkout-fan img").count(), 2);
    await page.waitForFunction(() => document.querySelector("#print-checkout-status")?.getAttribute("data-state") === "quoted");
    assert.equal(cluster.asked.quotes.at(-1)!.title, "Rainforest");
    assert.equal(cluster.asked.quotes.at(-1)!.cards, 2);

    // Only print_order_country_check maps to quote_country; other check constraints map to quote_failed.
    cluster.refuseCountry("GB");
    await page.fill("#delivery-postal", "SW1A 1AA");
    await page.selectOption("#delivery-country", "GB");
    await page.waitForFunction(() => document.querySelector("#print-checkout-status")?.getAttribute("data-state") === "quote_country");
    cluster.refuseCountry(null);
    cluster.refuseCardsConstraint(true);
    await page.selectOption("#delivery-country", "US");
    await page.fill("#delivery-region", "DC");
    await page.fill("#delivery-postal", "20500");
    await page.waitForFunction(() => document.querySelector("#print-checkout-status")?.getAttribute("data-state") === "quote_failed");
    cluster.refuseCardsConstraint(false);

    // Failed renderReview in open() clears stale review DOM and keeps #btn-checkout-pay disabled.
    await page.locator("#btn-checkout-close").click();
    await page.evaluate(() => {
      const container = document.querySelector<HTMLElement>(".print-container")!;
      container.dataset.setId = "22222222-3333-4444-8555-666666666666";
      document.querySelector(".deck-picker-carousel")!.innerHTML =
        `<button type="button" class="deck-picker-card" data-id="22222222-3333-4444-8555-666666666666"><span class="picker-card-name">Oversized</span><span class="meta-tag"><b>101</b></span></button>`;
      document.querySelector(".active-deck-name")!.textContent = "Oversized";
      const grid = document.querySelector<HTMLElement>(".sheet-paper-primary .sheet-grid")!;
      const svg = "data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2710%27 height=%2710%27%3E%3C/svg%3E";
      grid.innerHTML = Array.from({ length: 101 }, (_, i) =>
        `<div class="print-card-cell"><div class="print-card" data-id="ov-${i}" data-set-id="22222222-3333-4444-8555-666666666666" data-front="W${i}"><div class="print-card-illustration"><img class="card-illustration-img" src="${svg}"></div><div class="print-card-word">W${i}</div></div></div>`
      ).join("");
    });
    await page.locator("#btn-order-print").click();
    await page.locator("#print-checkout-panel").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#print-checkout-status")?.getAttribute("data-state") === "error");
    assert.match(await page.locator("#print-checkout-status").innerText(), /1–100 cards/);
    assert.equal(await page.locator("#print-checkout-collection").innerText(), "");
    assert.equal(await page.locator(".checkout-fan img").count(), 0);
    assert.equal(await page.locator("#btn-checkout-pay").isDisabled(), true);
  } finally {
    await browser.close();
    await cluster.server.shutdown();
  }
});

Deno.test("the phone picker owns the calling code; the box keeps the national number however it arrives", async () => {
  const messages = JSON.parse(await Deno.readTextFile("../messages/en.json"));
  const cluster = fakeCluster(await Deno.readTextFile("../shell/hatches/print-checkout.js"), await screenPage());
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await mountLive(page, messages, cluster.origin, "/", "Ocean");
    await page.locator("#btn-order-print").click();
    await fillAddress(page);
    const picker = page.locator(".delivery-phone-country-btn");
    const box = page.locator("#delivery-phone");
    // Each choice is the row's: the picker is the machine's bound control
    // (#delivery-phone-country), and its change carries the country.
    await page.evaluate(() => {
      const picks: string[] = [];
      Object.assign(globalThis, { picks });
      document.querySelector(".checkout-delivery")!.addEventListener("change", (e) => {
        const el = e.target as HTMLSelectElement;
        if (el.id === "delivery-phone-country") picks.push(el.value);
      });
    });
    const serialized = () =>
      page.evaluate(async () => {
        const { deliveryOf } = await import("./checkout.js");
        return deliveryOf(document.querySelector('[data-screen="print"]')!).contact.phone;
      });
    // The destination's code by default; a national number formats as typed
    // (libphonenumber-js AsYouType); any country can be picked, and
    // deliveryOf() serializes the picked code.
    assert.equal(await picker.getAttribute("data-phone-country"), "BR");
    await box.fill("11987654321");
    assert.equal(await box.inputValue(), "(11) 98765-4321");
    await picker.click();
    await page.locator(".delivery-phone-country-menu").waitFor({ state: "visible" });
    await page.locator(".delivery-phone-country-search").fill("+33");
    await page.locator('.delivery-phone-country-option[data-phone-country-value="FR"]').click();
    assert.equal(await picker.getAttribute("data-phone-country"), "FR");
    assert.equal(await page.locator("#delivery-phone-country").inputValue(), "FR");
    await box.fill("0612345678");
    assert.equal(await box.inputValue(), "06 12 34 56 78");
    assert.equal(await serialized(), "+33 6 12 34 56 78");
    await picker.click();
    await page.locator('.delivery-phone-country-option[data-phone-country-value="BR"]').first().click();
    assert.equal(await picker.getAttribute("data-phone-country"), "BR");
    // Regression: browser autofill writes the whole number, code included, in one
    // input event. The code went to the picker and stayed in the box too (+55 twice),
    // and the national digits ran out of room. The picker takes the code; the box
    // keeps the national number; serialization is unchanged.
    const autofill = (value: string) =>
      box.evaluate((el: HTMLInputElement, v: string) => {
        el.value = v;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: v }));
      }, value);
    await autofill("+351 912 345 678");
    assert.equal(await picker.getAttribute("data-phone-country"), "PT");
    assert.equal(await box.inputValue(), "912 345 678");
    await autofill("+55 11 98765-4321");
    assert.equal(await picker.getAttribute("data-phone-country"), "BR");
    assert.equal(await box.inputValue(), "(11) 98765-4321");
    // Some profiles store the code without its plus.
    await autofill("5511987654321");
    assert.equal(await box.inputValue(), "(11) 98765-4321");
    assert.equal(await serialized(), "+55 11 98765 4321");
    // The whole number fits the box: a hidden tail read as digits lost.
    assert.equal(await box.evaluate((el: HTMLInputElement) => el.scrollWidth <= el.clientWidth), true);
    // A code no country owns names none: the text stands, and is sent as typed.
    await autofill("+800 1234 5678");
    assert.equal(await box.inputValue(), "+800 1234 5678");
    assert.equal(await picker.getAttribute("data-phone-country"), "BR");
    assert.equal(await serialized(), "+800 1234 5678");
    // An IDD prefix reads as international with a code libphonenumber misreads
    // (+1): without a "+" and a named country the picker does not move.
    await autofill("0055 11 98765-4321");
    assert.equal(await picker.getAttribute("data-phone-country"), "BR");
    // Typing a code moves it to the picker as well; a Santa Maria number (area
    // code 55) stays national.
    await box.fill("");
    await box.pressSequentially("+1");
    assert.equal(await picker.getAttribute("data-phone-country"), "US");
    assert.equal(await box.inputValue(), "");
    await picker.click();
    await page.locator('.delivery-phone-country-option[data-phone-country-value="BR"]').first().click();
    await box.pressSequentially("55991234567");
    assert.equal(await box.inputValue(), "(55) 99123-4567");
    assert.equal(await picker.getAttribute("data-phone-country"), "BR");
    // The row binds a value with no event (a reload; a draft written while the
    // box carried the code): the picker takes the code from it too.
    await box.blur();
    await page.evaluate(() => {
      document.querySelector<HTMLInputElement>("#delivery-phone")!.value = "+351 912 345 678";
      document.querySelector<HTMLElement>(".checkout-delivery")!.dataset.phone = "+351 912 345 678";
    });
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>("#delivery-phone")!.value === "912 345 678");
    assert.equal(await picker.getAttribute("data-phone-country"), "PT");
    assert.equal(await serialized(), "+351 912 345 678");
    assert.deepEqual(await page.evaluate(() => (globalThis as unknown as { picks: string[] }).picks), ["FR", "BR", "PT", "BR", "US", "BR", "PT"]);
    // The row's phone_country binds as phone does (a reload, another tab):
    // the picker is the row's over the address's, until the row lets go.
    await page.evaluate(() => {
      const section = document.querySelector<HTMLElement>(".checkout-delivery")!;
      document.querySelector<HTMLInputElement>("#delivery-phone")!.value = "";
      section.dataset.phone = "";
      section.dataset.phoneCountry = "IL";
    });
    await page.waitForFunction(() => document.querySelector<HTMLElement>(".delivery-phone-country-btn")!.dataset.phoneCountry === "IL");
    await page.evaluate(() => {
      document.querySelector<HTMLElement>(".checkout-delivery")!.dataset.phoneCountry = "";
    });
    await page.waitForFunction(() => document.querySelector<HTMLElement>(".delivery-phone-country-btn")!.dataset.phoneCountry === "BR");
  } finally {
    await browser.close();
    await cluster.server.shutdown();
  }
});

Deno.test("Print shop opens one print dialog for one A6 face per page, and never a partial deck", async () => {
  const messages = JSON.parse(await Deno.readTextFile("../messages/en.json"));
  const cluster = fakeCluster(await Deno.readTextFile("../shell/hatches/print-checkout.js"), await screenPage());
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(cluster.origin);
    const words = ["Olá mundo", "שלום", "你好"];
    await page.evaluate(async ({ catalogue, words }) => {
      for (const node of document.querySelectorAll<HTMLElement>("[data-text]")) {
        const match = /^\{msg\.([^}]+)\}$/.exec(node.dataset.text!);
        if (match) node.textContent = catalogue[match[1]];
      }
      document.querySelector(".active-press-pill")!.innerHTML = '<strong class="active-deck-name">Ocean Animals</strong>';
      document.querySelector<HTMLElement>(".print-container")!.dataset.vendor = "print_shop";
      const svg = "data:image/svg+xml;charset=utf-8," +
        encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#ed8c28"/></svg>');
      document.querySelector(".sheet-paper-primary .sheet-grid")!.innerHTML = words.map((word) =>
        `<div class="print-card-cell"><div class="print-card" data-front="${word}"><div class="print-card-illustration"><img class="card-illustration-img" src="${svg}"/></div><div class="print-card-word">${word}</div></div></div>`
      ).join("");
      // Regression: toBlob waits for idle time, about a second a file on a busy
      // page, which timed out a deck under a loaded integrate.
      HTMLCanvasElement.prototype.toBlob = () => {
        throw new Error("toBlob starves on a page with no idle time");
      };
      // The dialog is the browser's; what it would print is taken as a PDF below.
      const win = globalThis as unknown as { prints: string[]; print: () => void; printed: () => void };
      win.prints = [];
      win.print = () => {
        win.prints.push(document.title);
        win.printed = () => dispatchEvent(new Event("afterprint"));
      };
      const module = await import("./checkout.js");
      module.default(document.querySelector('[data-screen="print"]'), { signal: new AbortController().signal });
    }, { catalogue: messages, words });
    for (const hidden of ["#btn-order-print", "#btn-print-trigger", "#btn-print-paper"]) {
      assert.equal(await page.locator(hidden).isVisible(), false, hidden);
    }
    assert.match(await page.locator("#shop-order-text").innerText(), /matte BOPP lamination/);
    await page.locator("#btn-shop-download").click();
    await page.waitForFunction(() => (globalThis as unknown as { prints: string[] }).prints?.length === 1);
    assert.deepEqual(await page.evaluate(() => (globalThis as unknown as { prints: string[] }).prints), ["snapcards-ocean-animals-a6"]);
    const bytes = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    const pdf = await PDFDocument.load(bytes);
    assert.equal(pdf.getPageCount(), words.length * 2);
    const mm = (value: number) => value * 72 / 25.4;
    for (const sheet of pdf.getPages()) {
      assert.ok(Math.abs(sheet.getWidth() - mm(111)) < 1, `width ${sheet.getWidth()}`);
      assert.ok(Math.abs(sheet.getHeight() - mm(154)) < 1, `height ${sheet.getHeight()}`);
    }
    // Front, back, front, back: colour only on the fronts, and nothing at all
    // within 5 mm of the trim, so the shop's cut cannot touch art or word.
    const measured = await page.evaluate(async () => {
      const out = [];
      for (const image of document.querySelectorAll<HTMLImageElement>("#print-shop-sheet img")) {
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
        // Less one JPEG block, whose ringing reaches past the art's own edge.
        const inset = Math.round(8 * 300 / 25.4) - 8;
        let saturated = 0;
        let outside = 0;
        for (let at = 0; at < data.length; at += 4) {
          const channels = [data[at], data[at + 1], data[at + 2]];
          if (Math.max(...channels) - Math.min(...channels) > 60) saturated++;
          const x = (at / 4) % width;
          const y = Math.floor(at / 4 / width);
          if ((x < inset || y < inset || x >= width - inset || y >= height - inset) && Math.min(...channels) < 245) outside++;
        }
        out.push({ saturated, outside, width, height });
      }
      return out;
    });
    measured.forEach(({ saturated, outside, width, height }, index) => {
      assert.deepEqual([width, height], [1311, 1819]);
      assert.equal(outside, 0, `page ${index + 1} has ink outside its safe area`);
      if (index % 2) assert.equal(saturated, 0, `page ${index + 1} is a back`);
      else assert.ok(saturated > 1000, `page ${index + 1} is a front`);
    });
    await page.evaluate(() => (globalThis as unknown as { printed: () => void }).printed());
    await page.locator('#print-shop-status[data-state="ready"]').waitFor();
    assert.equal(await page.locator("#print-shop-sheet").count(), 0, "the sheet leaves with the dialog");
    // Lying down, every face and page turns: the reader's orientation is the file's.
    await page.evaluate(() => document.querySelector<HTMLElement>(".print-container")!.dataset.orientation = "landscape");
    await page.locator("#btn-shop-download").click();
    await page.waitForFunction(() => (globalThis as unknown as { prints: string[] }).prints.length === 2);
    assert.deepEqual(
      await page.locator("#print-shop-sheet img").evaluateAll(async (images: HTMLImageElement[]) => {
        await Promise.all(images.map((image) => image.decode()));
        return [...new Set(images.map((image) => `${image.naturalWidth}x${image.naturalHeight}`))];
      }),
      ["1819x1311"],
    );
    const lying = await PDFDocument.load(await page.pdf({ preferCSSPageSize: true, printBackground: true }));
    assert.equal(lying.getPageCount(), words.length * 2);
    for (const sheet of lying.getPages()) {
      assert.ok(Math.abs(sheet.getWidth() - mm(154)) < 1, `landscape width ${sheet.getWidth()}`);
      assert.ok(Math.abs(sheet.getHeight() - mm(111)) < 1, `landscape height ${sheet.getHeight()}`);
    }
    await page.evaluate(() => (globalThis as unknown as { printed: () => void }).printed());
    await page.locator("#print-shop-sheet").waitFor({ state: "detached" });
    // One card's art failing fails the deck: an alert, and no dialog.
    await page.locator(".sheet-paper-primary img").nth(1).evaluate((image: HTMLImageElement) => image.src = "/card_images/missing.png");
    await page.locator("#btn-shop-download").click();
    await page.locator('#print-shop-status[data-state="error"]').waitFor();
    assert.match(await page.locator("#print-shop-status").innerText(), /nothing was printed.*Illustration/);
    assert.equal(await page.locator("#print-shop-status").getAttribute("role"), "alert");
    assert.equal(await page.evaluate(() => (globalThis as unknown as { prints: string[] }).prints.length), 2);
  } finally {
    await browser.close();
    await cluster.server.shutdown();
  }
});

Deno.test("Order tracking page loads across devices from print_order_tracking and updates reactively through shipment and delivery", async () => {
  const messages = JSON.parse(await Deno.readTextFile("../messages/en.json"));
  const cluster = fakeCluster(await Deno.readTextFile("../shell/hatches/print-checkout.js"), await screenPage());
  const browser = await chromium.launch({ headless: true });
  try {
    const orderId = "00f28b49-aeee-427f-8863-a32e36eb460f";
    cluster.trackingRows.set(orderId, {
      id: orderId,
      status: "placed_br",
      created_at: "2026-11-19T08:00:00Z",
      paid_at: "2026-11-19T08:02:00Z",
      shipped_at: null,
      title: "Animais do Brasil",
      stock: "gloss",
      cards: 12,
      country: "BR",
      destination: "São Paulo - SP · BR",
      item: 4200,
      shipping: 2434,
      total: 6634,
      currency: "brl",
      checks: 1,
      payment_state: "paid",
      vendor_order_id: "cp_br_9911",
      vendor_state: "in_progress",
      tracking_carrier: null,
      tracking_number: null,
      tracking_url: null,
    });
    const page = await browser.newPage();
    await mountLive(page, messages, cluster.origin, `/?order=${orderId}`, "Other deck");
    await page.locator('#print-order-tracking[data-stage="production"]').waitFor();
    assert.equal(await page.locator("#print-checkout-title").innerText(), "Order tracking");
    assert.equal(await page.locator("#print-checkout-collection").innerText(), "Animais do Brasil");
    assert.equal(await page.locator("#print-checkout-delivery-summary").innerText(), "São Paulo - SP · BR");
    assert.equal(await page.locator("#print-tracking-order-id").innerText(), "#00f28b49");
    assert.equal(await page.locator("#print-tracking-vendor-id").innerText(), "cp_br_9911");
    assert.deepEqual(
      await page.locator(".order-tracking-step").evaluateAll((els: HTMLElement[]) => els.map((e) => `${e.dataset.step}:${e.dataset.stepState}`)),
      ["paid:done", "production:active", "shipped:upcoming", "delivered:upcoming"],
    );

    // Cloudprinter hands the parcel to Correios SEDEX: the open page updates reactively without reload.
    Object.assign(cluster.trackingRows.get(orderId)!, {
      vendor_state: "shipped",
      shipped_at: "2026-11-20T14:00:00Z",
      tracking_carrier: "Correios SEDEX",
      tracking_number: "BR987654321BR",
      tracking_url: "https://rastreamento.correios.com.br/app/index.php?objetos=BR987654321BR",
    });
    await page.locator('#print-order-tracking[data-stage="shipped"]').waitFor({ timeout: 10000 });
    assert.equal(await page.locator("#print-tracking-carrier").innerText(), "Correios SEDEX");
    assert.equal(await page.locator("#print-tracking-code").innerText(), "BR987654321BR");
    assert.equal(
      await page.locator("#btn-tracking-url").getAttribute("href"),
      "https://rastreamento.correios.com.br/app/index.php?objetos=BR987654321BR",
    );
    assert.deepEqual(
      await page.locator(".order-tracking-step").evaluateAll((els: HTMLElement[]) => els.map((e) => `${e.dataset.step}:${e.dataset.stepState}`)),
      ["paid:done", "production:done", "shipped:active", "delivered:upcoming"],
    );

    // Delivery completes the 4-step stepper.
    Object.assign(cluster.trackingRows.get(orderId)!, { vendor_state: "completed" });
    await page.locator('#print-order-tracking[data-stage="delivered"]').waitFor({ timeout: 10000 });
    assert.deepEqual(
      await page.locator(".order-tracking-step").evaluateAll((els: HTMLElement[]) => els.map((e) => `${e.dataset.step}:${e.dataset.stepState}`)),
      ["paid:done", "production:done", "shipped:done", "delivered:done"],
    );
  } finally {
    await browser.close();
    await cluster.server.shutdown();
  }
});
