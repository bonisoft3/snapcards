/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// The release's own journeys for pronto's verify (tier 2), beside the screen sweep.
//
// A deck's link opens at its first card (play_select's canonical entry), so a
// deck screen visited bare lands on the card screen: the sweep, which expects
// the screen it navigated to, read that as a mismatch. And a sweep that only
// visits screens never generates a deck, so a release whose text, effects or
// blob plane were broken passed it: the generate journey makes one, waits for
// it to settle with pictures served from the blob plane, and deletes it.
type Page = {
  goto(url: string, opts?: unknown): Promise<unknown>;
  waitForFunction(fn: (arg: never) => unknown, arg?: unknown, opts?: { timeout: number }): Promise<unknown>;
  locator(selector: string): { first(): { getAttribute(name: string): Promise<string | null>; click(): Promise<void> }; fill(value: string): Promise<void>; click(): Promise<void> };
  selectOption(selector: string, value: string): Promise<unknown>;
  evaluate<T>(fn: (arg: never) => T, arg?: unknown): Promise<T>;
};
type Ctx = { targetUrl?: string; baseUrl?: string };

const screenIs = (page: Page, screen: string, timeout: number) =>
  page.waitForFunction((name: string) => {
    const shell = document.querySelector("#app .shell-screen:not([hidden])");
    if (!shell || shell.hasAttribute("data-served") || shell.hasAttribute("data-entering")) return false;
    const el = shell.querySelector(".screen");
    return el?.getAttribute("data-screen") === name && el.getAttribute("data-state") !== "loading" && !el.querySelector("[data-hydrating], [data-state='loading']");
  }, screen, { timeout });

// A read-only journey: nothing to undo.
const deckEntry = {
  spec: { screen: "deck", accepts: "accept-explore-deck", replaces: true },
  async run(page: Page, ctx?: Ctx) {
    const base = `${ctx?.baseUrl ?? ctx?.targetUrl ?? ""}/en`;
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector(".card-set-item a.cover-canvas") !== null, undefined, { timeout: 30000 });
    const deck = await page.locator(".card-set-item a.cover-canvas").first().getAttribute("href");
    if (!deck) throw new Error("The library shows no deck to open");
    await page.goto(new URL(deck, base).href, { waitUntil: "domcontentloaded" });
    await screenIs(page, "card", 30000);
  },
};

const TITLE = `Verify ${new Date().toISOString().slice(0, 16)}`;

const jobOf = (setId: string) => `.gen-job-row[data-set-id="${setId}"]`;

// The deck's row by its id or, when Create's id was never seen, by its title, which no
// reader's deck shares.
async function deleteDeck(page: Page, base: string, setId: string | null) {
  await page.goto(`${base}/generate`, { waitUntil: "domcontentloaded" });
  await screenIs(page, "generate", 30000);
  const id = setId ?? await page.evaluate(async (title: string) => {
    for (let i = 0; i < 100; i++) {
      const row = [...document.querySelectorAll(".gen-job-row")].find((r) => r.querySelector(".gen-job-name")?.textContent?.trim() === title);
      if (row) return row.getAttribute("data-set-id");
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }, TITLE);
  if (id === null) return;
  await page.waitForFunction((sel: string) => document.querySelector(`${sel} .btn-delete-job`) !== null, jobOf(id), { timeout: 30000 });
  await page.locator(`${jobOf(id)} .btn-delete-job`).first().click();
  await page.waitForFunction((sel: string) => document.querySelector(sel) === null, jobOf(id), { timeout: 30000 });
}

const generate = {
  spec: { screen: "generate", accepts: "accept-generate" },
  async run(page: Page, ctx?: Ctx) {
    const base = `${ctx?.baseUrl ?? ctx?.targetUrl ?? ""}/en`;
    let setId: string | null = null;
    let failure: unknown = null;
    try {
      await page.goto(`${base}/generate`, { waitUntil: "domcontentloaded" });
      await screenIs(page, "generate", 30000);
      await page.locator("#topic-input").fill(TITLE);
      // Two cards, typed into the count field: the release's text and picture
      // models run on more than one card at the smallest cost, and the deck's
      // rollback is the same.
      await page.locator("#card-count-input").fill("2");
      await page.locator("#btn-create").click();
      setId = await page.evaluate(async () => {
        for (let i = 0; i < 300; i++) {
          const id = document.querySelector("#preview-card-container")?.getAttribute("data-set-id") ?? "";
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) return id;
          await new Promise((r) => setTimeout(r, 100));
        }
        return null;
      });
      if (!setId) throw new Error("Creating a deck named no deck");
      const count = await page.evaluate(async (id: string) => {
        const held = localStorage.getItem("pronto-token");
        if (!held) throw new Error("The reader has no session");
        const res = await fetch(`/crud/card_set?select=count&id=eq.${id}`, { headers: { authorization: `Bearer ${JSON.parse(held).token}` } });
        if (!res.ok) throw new Error(`Deck ${id}: ${res.status}`);
        const [row] = await res.json() as { count: number }[];
        return row?.count;
      }, setId);
      if (count !== 2) throw new Error(`The deck was made with ${count} cards, not the two asked`);
      // Both levels on the release's own models, in the time a reader waits; a deck nothing
      // drew fails at once rather than at the bound.
      await page.waitForFunction(() => /^(done|partial|failed)$/.test(document.querySelector(".studio-container")?.getAttribute("data-status") ?? ""), undefined, { timeout: 180000 });
      const settled = await page.evaluate(() => document.querySelector(".studio-container")?.getAttribute("data-status"));
      if (settled === "failed") throw new Error("The release drew none of the deck's cards");
      // Any card's picture, served by the blob plane and decoded: a partial deck's shown card
      // may be one that failed.
      await page.waitForFunction(() =>
        [...document.querySelectorAll<HTMLImageElement>("#preview-front-box .card-illustration-img")]
          .some((img) => /^\/img\/insecure\/plain\/s3:\/\//.test(img.getAttribute("src") ?? "") && img.complete && img.naturalWidth > 0),
      undefined, { timeout: 30000 });
      // One of the two cards goes the way a reader deletes it: the card screen's
      // button, tapped once to arm and once within four seconds to confirm, and
      // the deck's count follows (create_set applies the confirmed row).
      await page.goto(`${base}/explore/${setId}`, { waitUntil: "domcontentloaded" });
      await screenIs(page, "card", 30000);
      await page.waitForFunction(() => document.querySelectorAll(".card-delete .btn-delete-card").length >= 2, undefined, { timeout: 30000 });
      await page.locator(".card-delete .btn-delete-card").first().click();
      await page.waitForFunction(() => document.querySelector(".card-delete")?.getAttribute("data-delete") === "armed", undefined, { timeout: 5000 });
      await page.locator(".card-delete .btn-delete-card").first().click();
      await page.waitForFunction(async (id: string) => {
        const held = localStorage.getItem("pronto-token");
        if (!held) return false;
        const res = await fetch(`/crud/card_set?select=count&id=eq.${id}`, { headers: { authorization: `Bearer ${JSON.parse(held).token}` } });
        const [row] = await res.json() as { count: number }[];
        return row?.count === 1 && document.querySelectorAll(".card-delete").length === 1;
      }, setId, { timeout: 30000 });
    } catch (e) {
      failure = e;
    } finally {
      // The deck goes whatever happened; a cleanup that fails is said beside the failure, never in its place.
      try {
        await deleteDeck(page, base, setId);
      } catch (cleanup) {
        throw failure === null ? cleanup : new AggregateError([failure, cleanup], `${(failure as Error).message}; and the deck was not deleted: ${(cleanup as Error).message}`);
      }
    }
    if (failure !== null) throw failure;
  },
};

// Ocean Animals: the seeded deck acceptance orders too, with cards enough for the review's fan of three.
const OCEAN_ANIMALS = "09440a66-ff6f-494a-39c9-60e67740a0a3";

const checkoutStatus = (page: Page) => page.evaluate(() => {
  const status = document.querySelector("#print-checkout-status");
  return `${status?.getAttribute("data-state")}: ${status?.textContent?.trim()}`;
});

// The reader's orders, as the session reads them: those the journey made are the ones
// that were not there when it started, whatever step it reached.
const orderIds = (page: Page) => page.evaluate(async () => {
  const held = localStorage.getItem("pronto-token");
  if (!held) return [] as string[];
  const res = await fetch("/crud/print_order?select=id", { headers: { authorization: `Bearer ${JSON.parse(held).token}` } });
  if (!res.ok) throw new Error(`Orders: ${res.status}`);
  return (await res.json() as { id: string }[]).map((row) => row.id);
});

// The order's machine keeps its row while an effect's outcome is owed (quoting, converting,
// opening); the delete waits for the step to settle as long as the journey itself waits for
// one, and an order still owed after that is said to remain rather than asked to go.
const deleteOrder = (page: Page, id: string) => page.evaluate(async (order: string) => {
  const held = localStorage.getItem("pronto-token");
  if (!held) throw new Error("The reader has no session");
  const headers = { authorization: `Bearer ${JSON.parse(held).token}` };
  const owed = ["quoting", "quoting_br", "converting", "opening", "checking", "placing", "placing_br", "recording", "vendor_checking", "vendor_checking_br", "alerting"];
  let status = "";
  for (let i = 0; i < 180; i++) {
    const read = await fetch(`/crud/print_order?select=status&id=eq.${order}`, { headers });
    const [row] = await read.json() as { status: string }[];
    if (!row) return;
    status = row.status;
    if (!owed.includes(status)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (owed.includes(status)) throw new Error(`Order ${order} still owes its ${status} step after 180 s and remains`);
  const res = await fetch(`/crud/print_order?id=eq.${order}`, { method: "DELETE", headers });
  if (!res.ok) throw new Error(`Deleting order ${order}: ${res.status} ${await res.text()}`);
}, id);

// The live print checkout up to Stripe's own form. The quote and the session are
// external effects (print-quote, print-fx, print-session) that only the deployed site
// runs against the vendors' test modes: the compose stack plays a simulator in Stripe's
// place, so a refusal by Stripe itself (ui_mode custom, 2026-11-14) passed acceptance.
// Nothing is paid: the form mounting on a test-mode client secret is the claim.
const printCheckout = {
  spec: { screen: "print", accepts: "accept-print-live-session" },
  async run(page: Page, ctx?: Ctx) {
    const base = `${ctx?.baseUrl ?? ctx?.targetUrl ?? ""}/en`;
    const statusIs = (state: string, timeout: number) =>
      page.waitForFunction((want: string) => document.querySelector("#print-checkout-status")?.getAttribute("data-state") === want, state, { timeout })
        .catch(async (error) => { throw new Error(`Checkout reads ${await checkoutStatus(page)}, not ${state}`, { cause: error }); });
    let failure: unknown = null;
    let before: string[] = [];
    try {
      await page.goto(`${base}/print`, { waitUntil: "domcontentloaded" });
      await screenIs(page, "print", 30000);
      before = await orderIds(page);
      // The screen learns its commerce mode from the server once mounted.
      await page.waitForFunction(() => document.querySelector('[data-screen="print"]')?.getAttribute("data-commerce-mode") === "live", undefined, { timeout: 15000 })
        .catch(async (error) => {
          const mode = await page.evaluate(() => document.querySelector('[data-screen="print"]')?.getAttribute("data-commerce-mode"));
          throw new Error(`The print screen's commerce mode is ${mode}, not live`, { cause: error });
        });
      await page.locator(`.deck-picker-card[data-id="${OCEAN_ANIMALS}"]`).first().click();
      await page.waitForFunction((id: string) => document.querySelector(".print-container")?.getAttribute("data-set-id") === id, OCEAN_ANIMALS, { timeout: 30000 });
      // The control cycles Print at home, Print shop, Prodigi.
      for (let i = 0; i < 3; i++) {
        const vendor = await page.evaluate(() => document.querySelector(".print-container")?.getAttribute("data-vendor"));
        if (vendor === "prodigi") break;
        if (i === 2) throw new Error(`The vendor control never reached Prodigi, last ${vendor}`);
        await page.locator("#btn-print-vendor").first().click();
        await page.waitForFunction((was: string | null | undefined) => document.querySelector(".print-container")?.getAttribute("data-vendor") !== was, vendor, { timeout: 15000 });
      }
      await page.locator("#btn-order-print").first().click();
      await page.waitForFunction(() => (document.querySelector("#print-checkout-panel") as HTMLDialogElement | null)?.open === true, undefined, { timeout: 30000 });
      // Missing mandatory fields keep naming what is missing on click instead of
      // claiming the address disagrees with the map.
      await page.locator("#delivery-text").fill("Casa azul atrás da escola, Vila Madalena");
      await statusIs("address_needed", 30000);
      await page.locator("#btn-checkout-pay").first().click();
      await statusIs("address_needed", 30000);
      await page.selectOption("#delivery-country", "BR");
      await page.locator("#delivery-recipient").fill("Marina Albuquerque");
      await page.locator("#delivery-cpf").fill("12345678909");
      await page.locator("#delivery-line1").fill("Rua Augusta, 1508");
      await page.locator("#delivery-line2").fill("Apto 42");
      await page.locator("#delivery-city").fill("São Paulo");
      await page.locator("#delivery-region").fill("SP");
      await page.locator("#delivery-postal").fill("01305-100");
      await statusIs("quoted", 90000);
      await page.locator("#btn-checkout-pay").first().click();
      // The session and the key it opens with are one mode: a deployment holding a
      // live secret beside a test publishable key fails here, not at a customer.
      await page.waitForFunction(() => {
        const url = document.querySelector<HTMLElement>("#print-checkout-payment")?.dataset.propUrl ?? "";
        const fields = new URLSearchParams(url.split("#")[1] ?? "");
        const session = /^cs_(test|live)_/.exec(fields.get("client_secret") ?? "")?.[1];
        return url.startsWith("https://js.stripe.com/clover/stripe.js#") && session !== undefined &&
          (fields.get("publishable_key") ?? "").startsWith(`pk_${session}_`);
      }, undefined, { timeout: 90000 })
        .catch(async (error) => { throw new Error(`Checkout did not open Stripe's form: ${await checkoutStatus(page)}`, { cause: error }); });
    } catch (e) {
      failure = e;
    } finally {
      // The order goes whatever happened; a cleanup that fails is said beside the failure, never in its place.
      try {
        for (const order of (await orderIds(page)).filter((id) => !before.includes(id))) await deleteOrder(page, order);
      } catch (cleanup) {
        throw failure === null ? cleanup : new AggregateError([failure, cleanup], `${(failure as Error).message}; and the order was not deleted: ${(cleanup as Error).message}`);
      }
    }
    if (failure !== null) throw failure;
  },
};

// Production signs in with Google's own button framed from the auth service;
// a deployment with OIDC_BROKER (staging, .say.cue) redirects its configured
// OIDC_PROVIDERS through the broker instead.
const googleSignIn = {
  spec: { screen: "cards", accepts: "accept-signin-google" },
  async run(page: Page, ctx?: Ctx) {
    const origin = new URL(ctx?.baseUrl ?? ctx?.targetUrl ?? "").origin;
    await page.goto(`${origin}/auth/oidc`, { waitUntil: "domcontentloaded" });
    const offered = JSON.parse(await page.evaluate(() => document.body?.textContent ?? "")) as { providers?: string[]; credential?: Record<string, string> };
    if (Deno.env.get("OIDC_BROKER")) {
      const expected = (Deno.env.get("OIDC_PROVIDERS") ?? "google").split(",").map((s) => s.trim()).filter((s) => s !== "");
      if (expected.length === 0) throw new Error("OIDC_BROKER is set with empty OIDC_PROVIDERS");
      for (const provider of expected) {
        if (!offered.providers?.includes(provider) || offered.credential?.[provider] !== undefined) {
          throw new Error(`the broker release misconfigured ${provider} sign-in: ${JSON.stringify(offered)}`);
        }
        await page.goto(`${origin}/auth/oidc/${provider}/start`, { waitUntil: "domcontentloaded" });
        const landed = await page.evaluate(() => ({ host: location.hostname, body: document.body?.textContent?.slice(0, 200) ?? "" }));
        if (landed.host === new URL(origin).hostname) throw new Error(`Sign in with ${provider} stayed on ${landed.host}: ${landed.body}`);
      }
      return;
    }
    const client = offered.credential?.google;
    if (!offered.providers?.includes("google") || typeof client !== "string" || !client.endsWith(".apps.googleusercontent.com")) {
      throw new Error(`the release offers no Google button of its own client: ${JSON.stringify(offered)}`);
    }
    await page.goto(`${origin}/auth/oidc/google/button`, { waitUntil: "domcontentloaded" });
    const drawn = await page.evaluate(() => ({
      client: document.documentElement.dataset.client ?? "",
      script: document.querySelector("script[type=module]")?.getAttribute("src") ?? "",
    }));
    if (drawn.client !== client || !drawn.script.endsWith("/auth/oidc/google/button.js")) {
      throw new Error(`the button page is not Google's for ${client}: ${JSON.stringify(drawn)}`);
    }
  },
};

export const journeys = [deckEntry, generate, printCheckout, googleSignIn];
