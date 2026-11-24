/// <reference lib="dom" />
// Snapcards Acceptance Driver (Playwright / Deno)
// Walks the brief acceptance checklist against the running app in the browser.

import { chromium, type Browser, type Page } from "npm:playwright@1.61.1";
import { PDFDocument } from "npm:@pdfme/pdf-lib@6.2.8";
import { prontoReady } from "./acceptance-readiness.ts";

const APP = Deno.args[0] ?? ".";

async function baseUrl(appDir: string): Promise<string> {
  const fromEnv = Deno.env.get("APP_URL");
  if (fromEnv) return fromEnv;
  try {
    const baytJson = JSON.parse(await Deno.readTextFile(`${appDir}/bayt.json`));
    const project = baytJson.name || "snapcards";
    const out = await new Deno.Command("docker", {
      args: ["compose", "port", `${project}-caddy`, "8443"],
      cwd: appDir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout).trim();
    const port = text.split("\n")[0]?.split(":").pop();
    if (out.success && port) {
      return `https://localhost:${port}`;
    }
  } catch {
    // Fall back to default local dev port
  }
  return "https://localhost:20879";
}

type TestCase = {
  id: string;
  accepts: string[];
  run: (page: Page, base: string) => Promise<void>;
};

// A job's badge reads deck_level alone: generating until level 3 has rows and no
// level runs, then ready only when every level drew every card, else incomplete.
// A ready badge over a running level once misled a reader for a whole deck.
async function badgesHonest(page: Page): Promise<void> {
  const rows = await page.$$eval("#generation-jobs-list .gen-job-row", (els) => els.map((row) => {
    const states = [...row.querySelectorAll(".deck-level-state")].map((s) => [s.getAttribute("data-level"), s.getAttribute("data-state")]);
    const shown = (sel: string) => getComputedStyle(row.querySelector(sel)!).display !== "none";
    return { name: row.querySelector(".gen-job-name")?.textContent, states, ready: shown(".gen-job-badge-ready"), ai: shown(".gen-job-badge-ai"), incomplete: shown(".gen-job-badge-incomplete") };
  }));
  for (const row of rows) {
    const settled = row.states.some(([l]) => l === "3") && !row.states.some(([, s]) => s === "running");
    const short = row.states.some(([, s]) => s === "partial" || s === "failed");
    const expected = { ready: settled && !short, ai: !settled, incomplete: settled && short };
    if (row.ready !== expected.ready || row.ai !== expected.ai || row.incomplete !== expected.incomplete) {
      throw new Error(`Job "${row.name}" shows ${JSON.stringify({ ready: row.ready, ai: row.ai, incomplete: row.incomplete })} over deck_level ${JSON.stringify(row.states)}`);
    }
  }
}

async function waitForPronto(page: Page): Promise<void> {
  try {
    await page.waitForFunction(
    prontoReady,
    null,
    { timeout: 30000 }
    );
  } catch (error) {
    const state = await page.evaluate(() => ({
      url: location.href,
      busy: typeof (globalThis as any).__prontoBusy === "function" ? (globalThis as any).__prontoBusy() : null,
      served: document.querySelectorAll("[data-served]").length,
      pending: Array.from(document.querySelectorAll("[data-pending='true']"), (el) => ({
        tag: el.tagName, id: el.id, class: el.className,
        live: el.closest("[data-live]")?.getAttribute("data-live"),
        screen: el.closest("[data-screen]")?.getAttribute("data-screen"),
        hiddenScreen: Boolean(el.closest(".shell-screen[hidden]")),
      })).slice(0, 20),
      banner: document.querySelector("#app > pre")?.textContent?.slice(0, 1000) ?? null,
      cards: document.querySelectorAll(".card-set-item").length,
    }));
    throw new Error(`Pronto did not settle: ${JSON.stringify(state)}`, { cause: error });
  }
}

// A deck this reader's tab generates, settled: only a tab's own decks offer delete and edit.
async function generateDeck(page: Page, base: string, title: string, details = ""): Promise<string> {
  await page.goto(`${base}/generate`, { waitUntil: "domcontentloaded" });
  await waitForPronto(page);
  await page.locator("#topic-input").fill(title);
  await page.locator("#details-input").fill(details);
  await page.locator("#draft-loc-pt").click();
  await waitForPronto(page);
  await page.locator("#btn-create").click();
  const setId = await deckOf(page, title);
  await settled(page, setId);
  await waitForPronto(page);
  return setId;
}

// The deck a click on #btn-create made: the UUID it minted, whose job row carries the title.
async function deckOf(page: Page, title: string): Promise<string> {
  const handle = await page.waitForFunction((title) => {
    const id = document.querySelector("#preview-card-container")?.getAttribute("data-set-id") ?? "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) return false;
    const name = document.querySelector(`.gen-job-row[data-set-id="${id}"] .gen-job-name`)?.textContent?.trim();
    return name === title ? id : false;
  }, title, { timeout: 15000 });
  return await handle.jsonValue() as string;
}

async function settled(page: Page, setId: string): Promise<void> {
  await page.waitForFunction((id) => {
    const row = document.querySelector(`#generation-jobs-list .gen-job-row[data-set-id="${id}"]`);
    return Boolean(row?.querySelector('.deck-level-state[data-level="3"]') && !row.querySelector('.deck-level-state[data-state="running"]'));
  }, setId, { timeout: 120000 });
}

// Inside integrate's acceptance container there is no host: the driver reaches
// the stack's services by name, and its browser reaches the two addresses the app
// tells a reader, the origin and the Checkout page, by mapping them onto their
// services, so the same links and the same Origin header work in both places.
const IN_CLUSTER = Deno.env.get("SNAPCARDS_ACCEPTANCE_IN_CLUSTER") === "yes" && (Deno.env.get("APP_URL") ?? "").includes("://caddy:");
const CHECKOUT_PAGE = "localhost:30826";
function clusterOrigin(): string {
  const origin = Deno.env.get("ORIGIN");
  if (!origin) throw new Error("ORIGIN is required in the cluster");
  return origin;
}
const browserArgs = () => {
  if (!IN_CLUSTER) return [];
  const host = new URL(clusterOrigin()).host;
  return [`--host-resolver-rules=MAP ${host} caddy:8443,MAP payments.${host} caddy:8443,MAP ${CHECKOUT_PAGE} checkout-simulator:8080,MAP localhost:28443 identity:28443`];
};
// The origin a reader of the print screen is on: its Origin header must match.
const readerOrigin = (appUrl: string) => IN_CLUSTER ? clusterOrigin() : appUrl;

const HOST_SERVICE_PORT: Record<string, string> = {
  "snapcards-mailpit": "MAILPIT_INBOX_PORT",
  "snapcards-checkout-simulator": "CHECKOUT_SIMULATOR_HTTP_PORT",
  "snapcards-prodigi-simulator": "PRODIGI_SIMULATOR_HTTP_PORT",
  "snapcards-cloudprinter-simulator": "CLOUDPRINTER_SIMULATOR_HTTP_PORT",
};

// Where the driver reaches one of the stack's services: by name inside the
// cluster, on the port compose published from the host.
async function published(service: string, port: number): Promise<string> {
  if (IN_CLUSTER) return `http://${service.replace(/^snapcards-/, "")}:${port}`;
  const hostEnv = HOST_SERVICE_PORT[service];
  if (hostEnv && Deno.env.get(hostEnv)) {
    return `http://127.0.0.1:${Deno.env.get(hostEnv)}`;
  }
  const out = await new Deno.Command("docker", {
    args: ["compose", "port", service, String(port)],
    cwd: APP,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const address = new TextDecoder().decode(out.stdout).trim().split("\n")[0];
  if (!out.success || !address) {
    throw new Error(`${service} publishes no port ${port}: ${new TextDecoder().decode(out.stderr)}`);
  }
  return `http://${address.replace(/^0\.0\.0\.0:/, "127.0.0.1:")}`;
}

async function until<T>(what: string, probe: () => Promise<T | false>, timeout = 30000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

type MailSummary = { ID: string; Subject: string };
type ProdigiOrder = {
  id: string;
  status: { stage: string; issues: { description: string }[]; details: Record<string, string> };
  shippingMethod: string;
  idempotencyKey: string;
  recipient: { name: string; address: Record<string, string> };
  items: { sku: string; copies: number; assets: { printArea: string; url: string }[] }[];
  fetched: { type: string; width: number; height: number }[];
  placements: number;
};
type CloudprinterOrder = {
  reference: string;
  state: number;
  state_code: string;
  addresses: Record<string, string>[];
  items: { product: string; shipping_level: string; files: { type: string; url: string; md5sum: string }[]; options: { type: string; count: string }[]; tracking?: string }[];
  fetched: { type: string; url: string; pages: number; width: number; height: number; md5sum: string }[];
  issues: string[];
  placements: number;
};
type SimEvent = { id: string; type: string; held: boolean; deliveries: { status: number; error: string | null }[] };

// The print checkout against the stack's own services: the Checkout simulator
// in Stripe's place and Mailpit in the mail provider's (commerce/README.md#local-mode).
// The browser may not reach Stripe; a request to it fails the case.
async function liveCheckout(page: Page, base: string, api: string) {
  page.on("response", (response) => {
    if (response.url().includes("print_order")) orderTraffic.push(`${response.request().method()} ${response.status()}`);
  });
  page.on("pageerror", (error) => orderTraffic.push(`page error: ${error.message}`));
  const stripeAsked: string[] = [];
  await page.context().route(/^https?:\/\/([^/]*\.)?stripe\.com(:\d+)?\//, (route) => {
    stripeAsked.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  // Where the stack's Stripe serves its page, which the browser maps (commerce/provider.ts).
  // On the host the simulator serves its page on its own port, which each run allocates.
  const hostPage = !IN_CLUSTER && Deno.env.get("CHECKOUT_SIMULATOR_HTTP_PORT");
  const simulator = `http://${hostPage ? `localhost:${hostPage}` : CHECKOUT_PAGE}`;
  const mailpit = await published("snapcards-mailpit", 8025);
  const checkoutControl = await published("snapcards-checkout-simulator", 8080);
  const prodigi = await published("snapcards-prodigi-simulator", 8080);
  const cloudprinter = await published("snapcards-cloudprinter-simulator", 8080);
  const rowsAt = async (query: string, token: string) => {
    const response = await page.request.get(`${api}/crud/print_order?${query}`, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok()) throw new Error(`Orders ${query}: ${response.status()}`);
    return await response.json() as Record<string, unknown>[];
  };
  const post = (origin: string) => async (path: string) => {
    const response = await fetch(`${origin}${path}`, { method: "POST" });
    if (!response.ok) throw new Error(`Simulator ${path}: ${response.status} ${await response.text()}`);
    return response.status === 204 ? null : await response.json();
  };
  const control = post(checkoutControl);
  const frame = page.frameLocator("#print-checkout-payment iframe").frameLocator("#checkout-frame");
  return {
    api,
    frame,
    stripeAsked,
    control,
    prodigiControl: post(prodigi),
    cloudprinterControl: post(cloudprinter),
    async prodigiOrders(order: string): Promise<ProdigiOrder[]> {
      const response = await fetch(`${prodigi}/_simulator/orders?merchantReference=${order}`);
      if (!response.ok) throw new Error(`Prodigi simulator: ${response.status}`);
      return await response.json();
    },
    async prodigiEvents(): Promise<{ id: string; type: string; status: number }[]> {
      return await (await fetch(`${prodigi}/_simulator/events`)).json();
    },
    async cloudprinterOrders(order: string): Promise<CloudprinterOrder[]> {
      const response = await fetch(`${cloudprinter}/_simulator/orders?reference=${order}`);
      if (!response.ok) throw new Error(`Cloudprinter simulator: ${response.status}`);
      return await response.json();
    },
    async cloudprinterEvents(): Promise<{ id: string; type: string; status: number }[]> {
      return await (await fetch(`${cloudprinter}/_simulator/events`)).json();
    },
    // Pays from the open checkout panel; resolves on the embedded simulator frame.
    async pay() {
      const held = await page.evaluate(() => localStorage.getItem("pronto-token"));
      if (!held) throw new Error("The reader has no session");
      const token: string = JSON.parse(held).token;
      await page.locator("#btn-checkout-pay").click();
      await frame.locator("main[data-session]").waitFor({ state: "visible", timeout: 60000 }).catch(async (error) => {
        throw new Error(`Checkout did not open the simulator: ${await page.locator("#print-checkout-status").innerText()}`, { cause: error });
      });
      const session = await frame.locator("main[data-session]").getAttribute("data-session");
      if (!session) throw new Error("The simulator frame names no session");
      const [row] = await rowsAt(`session_id=eq.${session}`, token);
      if (!row) throw new Error("The order was not created");
      return { order: row.id as string, token, session };
    },
    // The order as its receipt reads it: where the machine is, and what it holds.
    async order(id: string, token: string): Promise<{ status: string; paymentStatus: string; fulfillmentStatus: string; vendorStatus: string | null; amount: number; delivery: unknown }> {
      const [row] = await rowsAt(`id=eq.${id}`, token);
      if (!row) throw new Error(`Order ${id} is not there`);
      const status = row.status as string;
      return {
        status,
        paymentStatus: row.paid_at ? "paid" : row.payment_state === "expired" ? "expired" : "pending",
        fulfillmentStatus: ["placed", "placed_br", "vendor_checking", "vendor_checking_br"].includes(status) ? "sent" : status === "attention" ? "failed" : "pending",
        vendorStatus: row.vendor_state as string | null,
        amount: row.total as number,
        delivery: row.delivery,
      };
    },
    async events(session: string): Promise<SimEvent[]> {
      return await (await fetch(`${checkoutControl}/_simulator/events?session=${session}`)).json();
    },
    async mails(order: string): Promise<MailSummary[]> {
      const response = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`subject:${order}`)}`);
      if (!response.ok) throw new Error(`Mailpit search: ${response.status}`);
      return (await response.json()).messages;
    },
    async allMails(query: string): Promise<MailSummary[]> {
      const response = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(query)}`);
      if (!response.ok) throw new Error(`Mailpit search: ${response.status}`);
      return (await response.json()).messages;
    },
    async mailHeaders(mail: string): Promise<Record<string, string[]>> {
      return await (await fetch(`${mailpit}/api/v1/message/${mail}/headers`)).json();
    },
    async mailText(mail: string): Promise<string> {
      return (await (await fetch(`${mailpit}/api/v1/message/${mail}`)).json()).Text;
    },
    // The order's print file, stored in the blob plane before the order could be
    // paid: the mail links it through the door and attaches the same bytes. Its
    // page count and page size.
    async mailPdf(mail: string): Promise<{ pages: number; size: { width: number; height: number } }> {
      const { Text, Attachments } = await (await fetch(`${mailpit}/api/v1/message/${mail}`)).json();
      const link = /^Print file: (\S+)$/m.exec(Text)?.[1];
      if (!link) throw new Error(`The mail links no print file: ${Text}`);
      const file = await fetch(`${api}${new URL(link).pathname}`);
      if (!file.ok) throw new Error(`The print file at ${link}: ${file.status}`);
      const linked = new Uint8Array(await file.arrayBuffer());
      const pdfs = (Attachments as { PartID: string; ContentType: string }[]).filter((a) => a.ContentType === "application/pdf");
      if (pdfs.length !== 1) throw new Error(`The mail attaches ${JSON.stringify(Attachments)}`);
      const attached = new Uint8Array(await (await fetch(`${mailpit}/api/v1/message/${mail}/part/${pdfs[0].PartID}`)).arrayBuffer());
      if (attached.length !== linked.length || attached.some((b, i) => b !== linked[i])) throw new Error("The mail attaches other bytes than it links");
      const doc = await PDFDocument.load(linked);
      return { pages: doc.getPageCount(), size: doc.getPage(0).getSize() };
    },
  };
}

// The control cycles Print at home, Print shop, Prodigi.
async function chooseVendor(page: Page, vendor: string) {
  for (let step = 0; step < 3; step++) {
    if (await page.locator(".print-container").getAttribute("data-vendor") === vendor) return;
    const before = await page.locator(".print-container").getAttribute("data-vendor");
    await page.locator("#btn-print-vendor").click();
    await page.waitForFunction((was) => document.querySelector(".print-container")?.getAttribute("data-vendor") !== was, before);
  }
  throw new Error(`The vendor control never reached ${vendor}`);
}
const chooseProdigi = (page: Page) => chooseVendor(page, "prodigi");
// The screen names and prints the deck the reader picked, not the session's.
async function selectedDeckIsNamed(page: Page, deck: string): Promise<string> {
  const name = (await page.locator(`.deck-picker-card[data-id="${deck}"] .picker-card-name`).innerText()).trim();
  await page.waitForFunction((want) => document.querySelector(".active-deck-name")?.textContent?.trim() === want, name, { timeout: 15000 })
    .catch(async () => { throw new Error(`The pill reads ${await page.locator(".active-deck-name").textContent()}, not the selected ${name}`); });
  return name;
}
async function fillPostal(page: Page) {
  await page.selectOption("#delivery-country", "BR");
  await page.fill("#delivery-recipient", "Marina Albuquerque");
  await page.fill("#delivery-cpf", "12345678909");
  await page.fill("#delivery-line1", "Rua Augusta, 1508");
  await page.fill("#delivery-line2", "Apto 42");
  await page.fill("#delivery-city", "São Paulo");
  await page.fill("#delivery-region", "SP");
  await page.fill("#delivery-postal", "01305-100");
}
// What a stuck checkout asked of its order, for the failure to name.
const orderTraffic: string[] = [];
const statusIs = (page: Page, state: string, timeout = 30000) =>
  page.waitForFunction((want) => document.querySelector("#print-checkout-status")?.getAttribute("data-state") === want, state, { timeout })
    .catch(async (error) => {
      throw new Error(`Checkout reads ${await page.locator("#print-checkout-status").getAttribute("data-state")}, not ${state}: ${await page.locator("#print-checkout-status").innerText()}; orders: ${orderTraffic.slice(-8).join(", ")}`, { cause: error });
    });

const CASES: TestCase[] = [
  {
    id: "initial-chrome-waits-for-screen",
    accepts: ["accept-browse"],
    run: async (page, base) => {
      const response = await page.request.get(`${base}/shell/shared/chrome-ready.css`);
      if (!response.ok()) throw new Error(`Chrome stylesheet returned ${response.status()}`);
      const css = await response.text();
      await page.setContent(`<style>${css}</style><nav>Navigation</nav><main id="app"></main>`);
      if (await page.locator("nav").isVisible()) throw new Error("Unstyled navigation appeared before a screen mounted");
      await page.locator("#app").evaluate((app) => { app.innerHTML = '<div class="shell-screen"><section class="screen" data-screen="deck"></section></div>'; });
      if (await page.locator("nav").isVisible()) throw new Error("Navigation appeared while the deck entry resolver was loading");
      await page.locator(".screen").evaluate((screen) => { screen.setAttribute("data-screen", "card"); });
      if (!await page.locator("nav").isVisible()) throw new Error("Navigation remained hidden after the study screen mounted");
    },
  },
  {
    id: "strip-one-selection",
    accepts: ["accept-browse"],
    // Regression: the shelves were a gesture the strip queued for the library's
    // machine and a radio it flipped on arrival; the gesture lost, both My
    // Cards and Gallery painted. A shelf is an address now, and the strip's
    // current link is the one whose address is the page's — one, by construction.
    run: async (page, base) => {
      await page.goto(`${base}/en`, { waitUntil: "domcontentloaded" });
      await waitForPronto(page);
      const current = () => [...document.querySelectorAll('body > nav > a[aria-current="page"]')].map((a) => a.getAttribute('href'));
      const shelf = () => document.querySelector('.shell-screen:not([hidden]) .library-shell')?.getAttribute('data-author-filter');
      await page.locator('body > nav > a[data-param-shelf="gallery"]').click();
      await page.waitForURL(`${base}/en/gallery`);
      await page.waitForFunction(() => document.querySelector('.shell-screen:not([hidden]) .library-shell')?.getAttribute('data-author-filter') === 'gallery');
      await page.locator('body > nav > a[data-route="about"]').click();
      await page.waitForFunction(() => document.querySelector('.shell-screen:not([hidden]) .screen')?.getAttribute('data-screen') === 'about');
      await waitForPronto(page);
      await page.locator('body > nav > a[data-param-shelf="mine"]').click();
      await page.waitForURL(`${base}/en/mine`);
      await page.waitForFunction(() => document.querySelector('.shell-screen:not([hidden]) .library-shell')?.getAttribute('data-author-filter') === 'mine');
      await waitForPronto(page);
      if (await page.evaluate(shelf) !== 'mine') throw new Error('My Cards did not take the library when it was reached from About');
      const marked = await page.evaluate(current);
      if (marked.length !== 1 || !marked[0]?.endsWith('/en/mine')) throw new Error(`The strip marks ${JSON.stringify(marked)} where only /en/mine is current`);
      // The strip paints its current link alone, the shelves included: once
      // the tiles' background transition settles, one wears the current tile
      // and no other is on its way to or from it.
      await page.waitForFunction(() => {
        const links = [...document.querySelectorAll('body > nav > a')].map((a) => ({ href: a.getAttribute('href') ?? '', bg: getComputedStyle(a).backgroundColor }));
        const lit = links.filter((l) => l.bg === 'rgb(245, 158, 11)');
        const moving = links.filter((l) => l.bg.startsWith('rgba(245, 158, 11'));
        return lit.length === 1 && moving.length === 0 && lit[0].href.endsWith('/en/mine');
      }, null, { timeout: 5000 }).catch(async () => {
        throw new Error(`The strip paints ${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('body > nav > a')].map((a) => [a.getAttribute('href'), getComputedStyle(a).backgroundColor])))} where only My Cards is current`);
      });
      await page.locator('body > nav > a[data-route="cards"]:not([data-param-shelf])').click();
      await page.waitForURL(`${base}/en`);
      await page.waitForFunction(() => document.querySelector('.shell-screen:not([hidden]) .library-shell')?.getAttribute('data-author-filter') === '');
      if ((await page.evaluate(current)).length !== 1) throw new Error('Home is not the one current link at /en');
    },
  },
  {
    id: "responsive-navigation",
    accepts: ["accept-browse"],
    // Regression: cramming all 6 strip entries into the phone top bar squeezed
    // labels and hid the account affordance. Phones keep the 3 primary CTAs, the
    // ⋯ sheet (My Cards, Gallery and About) and the account chip, while
    // tablets use an 88px rail and desktops the 240px sidebar.
    run: async (page, appUrl) => {
      const base = readerOrigin(appUrl);
      const initialViewport = page.viewportSize() ?? { width: 1280, height: 720 };
      try {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${base}/en`, { waitUntil: "domcontentloaded" });
        await waitForPronto(page);

        if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) {
          throw new Error("Phone library overflowed horizontally");
        }

        const visibleStripRoutes = await page.evaluate(() =>
          [...document.querySelectorAll("body > nav > a")]
            .filter((a) => (a as HTMLElement).checkVisibility())
            .map((a) => a.getAttribute("data-param-shelf") ?? a.getAttribute("data-route")),
        );
        if (JSON.stringify(visibleStripRoutes) !== JSON.stringify(["cards", "generate", "print"])) {
          throw new Error(`Expected phone top bar to show only cards/generate/print, got ${JSON.stringify(visibleStripRoutes)}`);
        }

        // The account is the nav's chip, in the phone's top-right slot.
        const chip = page.locator("body > nav :is(.shell-signin, .shell-person)");
        const panel = page.locator("body > nav .shell-signin-panel");
        if (!await chip.isVisible()) throw new Error("Expected the account chip to be visible on phone");
        const box = await chip.boundingBox();
        if (!box || box.y > 20 || box.x < 300 || box.width < 44 || box.height < 44) {
          throw new Error(`Expected the account chip in the top-right 44px+ slot on phone, got ${JSON.stringify(box)}`);
        }

        const cdp = await page.context().newCDPSession(page);
        await cdp.send("WebAuthn.enable");
        await cdp.send("WebAuthn.addVirtualAuthenticator", {
          options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
        });
        await chip.click();
        await panel.waitFor({ state: "visible", timeout: 5000 });
        await panel.locator(".shell-passkey").click();
        await page.locator("body > nav .shell-passkey-form input").fill("Ada");
        await page.locator("body > nav .shell-passkey-go").click();
        await page.waitForSelector('body > nav .shell-me[data-auth="user"] > .shell-person', { timeout: 15000 });
        await waitForPronto(page);
        if (!await chip.isVisible()) throw new Error("Expected the account chip to remain visible for a signed-in person on phone");
        await chip.click();
        await page.locator("body > nav .shell-signout").click();
        await page.waitForSelector("body > nav .shell-signin", { timeout: 15000 });
        await waitForPronto(page);
        if (await panel.isVisible()) throw new Error("Expected the panel to close after signing out on phone");

        // The routes the bar drops are the ⋯ sheet's, which closes once one is chosen.
        const viaMore = async (link: string, url: string) => {
          await page.locator(".shell-screen:not([hidden]) .btn-more").click();
          const sheet = page.locator(".shell-screen:not([hidden]) .more-sheet");
          await sheet.waitFor({ state: "visible", timeout: 5000 });
          await sheet.locator(link).click();
          await page.waitForURL(url);
          await waitForPronto(page);
          if (await page.locator(".more-sheet:popover-open").count() > 0) throw new Error(`Expected the ⋯ sheet to close after choosing ${link}`);
        };
        await viaMore('.more-link[data-param-shelf="mine"]', `${base}/en/mine`);
        await page.waitForFunction(() => document.querySelector('.shell-screen:not([hidden]) .library-shell')?.getAttribute('data-author-filter') === 'mine');
        await viaMore('.more-link[data-route="about"]', `${base}/en/about`);
        await page.waitForFunction(() => document.querySelector('.shell-screen:not([hidden]) .screen')?.getAttribute('data-screen') === 'about');
        await viaMore('.more-link[data-param-shelf="gallery"]', `${base}/en/gallery`);
        await page.waitForFunction(() => document.querySelector('.shell-screen:not([hidden]) .library-shell')?.getAttribute('data-author-filter') === 'gallery');

        // Fullscreen study on phone hides the nav, and with it the chip.
        await page.locator('.shell-screen:not([hidden]) .card-set-title a:visible').first().click();
        await page.waitForURL(/\/en\/explore\/[^/]+\/[^/]+$/);
        await waitForPronto(page);
        await chip.click();
        await panel.waitFor({ state: "visible", timeout: 5000 });
        await panel.locator(".shell-signin-close").click();
        await panel.waitFor({ state: "hidden", timeout: 5000 });
        await page.locator('.shell-screen:not([hidden]) #btn-fullscreen-toggle').click();
        await page.waitForFunction(() => document.querySelector('.shell-screen:not([hidden]) .play-container')?.getAttribute('data-status') === 'fullscreen');
        if (await page.locator('body > nav').isVisible()) throw new Error("Expected fullscreen study on phone to hide body > nav");
        await page.locator('.shell-screen:not([hidden]) #btn-fullscreen-exit').click();
        await page.waitForFunction(() => document.querySelector('.shell-screen:not([hidden]) .play-container')?.getAttribute('data-status') === 'playing');
        if (!await chip.isVisible()) throw new Error("Expected the account chip to return after exiting fullscreen");

        await page.setViewportSize({ width: 820, height: 1180 });
        await page.locator('body > nav > a[data-route="cards"]:not([data-param-shelf])').click();
        await page.waitForURL(`${base}/en`);
        await waitForPronto(page);
        await page.waitForFunction(() => Math.round(document.querySelector("body > nav")!.getBoundingClientRect().width) === 88);
        const tabletNav = await page.evaluate(() => {
          const nav = document.querySelector("body > nav") as HTMLElement;
          const visible = [...nav.querySelectorAll(":scope > a")].filter((a) => (a as HTMLElement).checkVisibility()).length;
          const cards = [...document.querySelectorAll(".shell-screen:not([hidden]) .deck-grid .card-set-item")]
            .filter((el) => (el as HTMLElement).checkVisibility())
            .slice(0, 2)
            .map((el) => el.getBoundingClientRect());
          const twoCol = cards.length === 2 && Math.abs(cards[0].top - cards[1].top) < 8 && cards[1].left > cards[0].left;
          const overflow = document.documentElement.scrollWidth > window.innerWidth;
          return { width: Math.round(nav.getBoundingClientRect().width), visible, twoCol, overflow };
        });
        if (tabletNav.width !== 88 || tabletNav.visible !== 6 || !tabletNav.twoCol || tabletNav.overflow) {
          throw new Error(`Expected 88px tablet rail with 6 links and 2-column non-overflowing grid, got ${JSON.stringify(tabletNav)}`);
        }

        await page.setViewportSize({ width: 1280, height: 720 });
        await page.waitForFunction(() => Math.round(document.querySelector("body > nav")!.getBoundingClientRect().width) === 240);
        const desktopNav = await page.evaluate(() => {
          const nav = document.querySelector("body > nav") as HTMLElement;
          const visible = [...nav.querySelectorAll(":scope > a")].filter((a) => (a as HTMLElement).checkVisibility()).length;
          return { width: Math.round(nav.getBoundingClientRect().width), visible };
        });
        if (desktopNav.width !== 240 || desktopNav.visible !== 6) {
          throw new Error(`Expected 240px desktop sidebar with 6 visible links, got ${JSON.stringify(desktopNav)}`);
        }
      } finally {
        await page.setViewportSize(initialViewport);
      }
    },
  },
  {
    id: "library-filters-persist",
    accepts: ["accept-browse"],
    run: async (page, base) => {
      await page.goto(`${base}/en`, { waitUntil: "domcontentloaded" });
      await waitForPronto(page);
      const library = page.locator('.shell-screen:not([hidden]) .library-shell');
      await page.locator('body > nav > a[data-param-shelf="gallery"]').click();
      await page.waitForFunction(() => document.querySelector('.shell-screen:not([hidden]) .library-shell')?.getAttribute('data-author-filter') === 'gallery');
      await waitForPronto(page);
      await page.waitForTimeout(300);
      if (await library.getAttribute('data-author-filter') !== 'gallery') throw new Error('Gallery filter did not persist');
      if (await library.locator('.featured-hero').isVisible()) throw new Error('Gallery should hide the featured hero');
      const search = library.locator('#library-search');
      await search.fill('solar');
      await page.waitForFunction(() => Array.from(document.querySelectorAll('.shell-screen:not([hidden]) .card-set-title')).some((el) => el.textContent?.toLowerCase().includes('solar')));
      await waitForPronto(page);
      await page.waitForTimeout(300);
      if (await search.inputValue() !== 'solar') throw new Error('Library search text did not persist');
      if (await library.getAttribute('data-author-filter') !== 'gallery') throw new Error('Searching cleared the Gallery filter');
      if (await library.locator('.featured-hero').isVisible()) throw new Error('Searching Gallery showed the featured hero');
      const titles = (await library.locator('.card-set-title:visible').allTextContents()).map((s) => s.trim().toLowerCase());
      if (!titles.some((s) => s.includes('solar')) || titles.some((s) => !s.includes('solar'))) throw new Error(`Library search results did not persist: ${JSON.stringify(titles)}`);
      const solarLink = library.locator('.card-set-title a:visible').filter({ hasText: /solar/i }).first();
      await solarLink.click();
      await page.waitForURL(/\/explore\/[^/]+\/[^/]+$/);
      await waitForPronto(page);
      await page.goBack();
      await page.waitForURL(`${base}/en/gallery`);
      await waitForPronto(page);
      if (await search.inputValue() !== 'solar' || await library.getAttribute('data-author-filter') !== 'gallery' || await library.locator('.featured-hero').isVisible()) throw new Error('Returning from a deck did not preserve the Gallery search');
      await page.locator('body > nav a[data-route="explore"]').evaluate((link: HTMLAnchorElement) => link.click());
      await page.waitForURL(/\/en\/explore$/);
      await waitForPronto(page);
      const study = page.locator('.shell-screen:not([hidden]) [data-screen="explore"]');
      const pendingRegion = study.locator('[data-live="generation_draft"][data-filter*="topic=like.{set_id}"]');
      if (await study.locator('.translation-error').count() !== 1 || await pendingRegion.count() !== 1) throw new Error('Study screen is missing its set-scoped translation feedback');
      const markupResponse = await page.request.get(`${base}/screens/explore.html`);
      if (!markupResponse.ok() || !(await markupResponse.text()).includes('class="translation-pending"')) throw new Error('Study screen is missing pending translation markup');
      await page.goBack();
      await page.waitForURL(`${base}/en/gallery`);
      await waitForPronto(page);
      if (await search.inputValue() !== 'solar' || await library.getAttribute('data-author-filter') !== 'gallery' || await library.locator('.featured-hero').isVisible()) throw new Error('Returning from study did not preserve the Gallery search');
      await page.locator('body > nav > a[data-param-shelf="mine"]').click();
      await page.waitForFunction(() => document.querySelector('.shell-screen:not([hidden]) .library-shell')?.getAttribute('data-author-filter') === 'mine');
      await waitForPronto(page);
      await page.waitForTimeout(300);
      if (await library.getAttribute('data-author-filter') !== 'mine') throw new Error('My Cards filter did not persist');
      await search.fill('animal');
      await page.waitForFunction(() => (document.querySelector('.shell-screen:not([hidden]) #library-search') as HTMLInputElement | null)?.value === 'animal');
      await waitForPronto(page);
      await page.waitForTimeout(300);
      if (await search.inputValue() !== 'animal' || await library.getAttribute('data-author-filter') !== 'mine') throw new Error('Searching cleared the My Cards filter');
    },
  },
  {
    id: "language-feedback-styles",
    accepts: ["accept-play-flip"],
    run: async (page, base) => {
      for (const screen of ['card', 'explore']) {
        const response = await page.request.get(`${base}/shell/screens/${screen}.css`);
        if (!response.ok()) throw new Error(`${screen} stylesheet returned ${response.status()}`);
        const css = await response.text();
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.setContent(`<base href="${base}/shell/"><style>${css}</style><section class="screen" data-screen="${screen}" data-locale="es"><div class="play-container" data-translation-failed=""><div class="play-header-actions"><div class="lang-switch"><a id="lang-es" class="lang-link" data-locale="es" aria-current="page">ES</a></div><span class="translation-error">Unavailable</span></div></div></section>`);
        const link = page.locator('#lang-es');
        const idleShadow = await link.evaluate((el) => getComputedStyle(el).boxShadow);
        await page.locator('.play-header-actions').evaluate((el) => el.insertAdjacentHTML('beforeend', '<span class="translation-pending" data-topic="deck :: [TRANSLATE:es] :: {}" data-target="es">Translating</span>'));
        const pulse = await link.evaluate((el) => {
          const animation = el.getAnimations().find((a) => (a as CSSAnimation).animationName === 'translation-pulse');
          if (!animation) return null;
          animation.pause();
          animation.currentTime = 0;
          const start = getComputedStyle(el).boxShadow;
          animation.currentTime = Number(animation.effect!.getComputedTiming().duration) / 2;
          return { start, peak: getComputedStyle(el).boxShadow };
        });
        if (!pulse || pulse.start === idleShadow || pulse.start === pulse.peak) throw new Error(`${screen} pending language shadow is not visible immediately or does not pulse: ${JSON.stringify({ idleShadow, pulse })}`);
        await page.locator('.translation-pending').evaluate((el) => el.remove());
        const normalColor = await link.evaluate((el) => getComputedStyle(el).color);
        await page.locator('.play-container').evaluate((el) => el.setAttribute('data-translation-failed', 'deck|es'));
        await page.waitForFunction((color) => getComputedStyle(document.querySelector('#lang-es')!).color !== color, normalColor);
        const failedColor = await link.evaluate((el) => getComputedStyle(el).color);
        if (failedColor === normalColor) throw new Error(`${screen} selected language does not show the failure color`);
        await page.locator('.play-header-actions').evaluate((el) => el.insertAdjacentHTML('beforeend', '<span class="translation-pending" data-topic="deck :: [TRANSLATE:es] :: {}" data-target="es">Translating</span>'));
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const reduced = await link.evaluate((el) => ({ animation: getComputedStyle(el).animationName, outline: getComputedStyle(el).outlineStyle, width: getComputedStyle(el).outlineWidth }));
        if (reduced.animation !== 'none' || reduced.outline === 'none' || reduced.width === '0px') throw new Error(`${screen} reduced-motion indicator missing: ${JSON.stringify(reduced)}`);
      }
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    },
  },
  {
    id: "mobile-featured-hero-link",
    accepts: ["accept-browse", "accept-play-flip"],
    run: async (page, base) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(`${base}/en`, { waitUntil: "domcontentloaded" });
      await waitForPronto(page);
      const hero = page.locator('.shell-screen:not([hidden]) #btn-hero-play');
      if (await hero.evaluate((el) => el.tagName) !== 'A') throw new Error('Featured hero must be a native link');
      const labelId = await hero.getAttribute('aria-labelledby');
      const title = await hero.locator('.hero-title').innerText();
      if (labelId !== await hero.locator('.hero-title').getAttribute('id') || !title.trim() || title.includes('{msg.')) throw new Error(`Featured hero lacks a descriptive, localized accessible name: ${JSON.stringify({ labelId, title })}`);
      // The English catalogue once kept the Portuguese title, a mixed-language hero.
      if (title.trim() !== 'Brazilian Animals') throw new Error(`Featured hero title is not English on /en: ${JSON.stringify(title)}`);
      if (await page.getByRole('link', { name: title.trim(), exact: true }).count() !== 1) throw new Error('Featured hero accessible name does not resolve to its visible title');
      if (await hero.locator('a, button, [role="button"]').count() !== 0) throw new Error('Featured hero contains nested links or action buttons');
      const box = await hero.boundingBox();
      if (!box) throw new Error('Featured hero is not visible on mobile');
      // A phone keeps the photo clear: only the badge and the title sit over it.
      for (const selector of ['.hero-pill-category', '.hero-subtitle', '.hero-meta']) {
        if (await hero.locator(selector).isVisible()) throw new Error(`Featured hero covers its photo with ${selector} on mobile`);
      }
      for (const selector of ['.hero-header-line', '.hero-title']) {
        const content = await hero.locator(selector).boundingBox();
        if (!content || content.x < box.x - 1 || content.y < box.y - 1 || content.x + content.width > box.x + box.width + 1 || content.y + content.height > box.y + box.height + 1) throw new Error(`Featured hero clips ${selector} on mobile: ${JSON.stringify({ hero: box, content })}`);
      }
      await hero.click({ position: { x: box.width / 2, y: box.height / 2 } });
      await page.waitForURL(/\/en\/explore\/69618be6-9206-f9c7-59eb-b5e4b072cf3d\/[^/]+$/);
      await waitForPronto(page);
      const first = await page.locator('.shell-screen:not([hidden]) .card-rail-pill').first().getAttribute('href');
      if (!first || page.url() !== new URL(first, base).href) throw new Error('Hero center did not open the first featured card');
      await page.goBack();
      await page.waitForURL(`${base}/en`);
      await waitForPronto(page);
      await hero.focus();
      await hero.press('Enter');
      await page.waitForURL(new URL(first, base).href);
      await waitForPronto(page);
    },
  },
  {
    id: "mobile-header-controls-fit",
    accepts: ["accept-browse", "accept-play-flip"],
    run: async (page, base) => {
      // Header action rows were non-wrapping flex rows wider than a phone, clipping the language switch and sign-in at both edges.
      await page.setViewportSize({ width: 375, height: 812 });
      for (const path of ["/en", "/he", "/en/explore/69618be6-9206-f9c7-59eb-b5e4b072cf3d"]) {
        await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
        await waitForPronto(page);
        const width = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, viewport: innerWidth }));
        if (width.doc > width.viewport) throw new Error(`${path} scrolls horizontally on a phone: ${JSON.stringify(width)}`);
      }
    },
  },
  {
    id: "deck-entry-history-fallback",
    accepts: ["accept-play-flip"],
    run: async (page, base) => {
      await page.addInitScript(() => { Reflect.deleteProperty(window, 'navigation'); });
      await page.goto(`${base}/en`, { waitUntil: 'domcontentloaded' });
      await waitForPronto(page);
      await page.goto(`${base}/en/explore/69618be6-9206-f9c7-59eb-b5e4b072cf3d`, { waitUntil: 'domcontentloaded' });
      await page.waitForURL(/\/en\/explore\/69618be6-9206-f9c7-59eb-b5e4b072cf3d\/[^/]+$/);
      await waitForPronto(page);
      await page.goBack();
      await page.waitForURL(`${base}/en`);
    },
  },
  {
    id: "served-title-stays",
    accepts: ["accept-play-flip"],
    run: async (page, base) => {
      // The labels are a tab's own table, filled after the mount, and adopting it empty wiped the
      // title the server drew: it blinked out for up to a second and a half on every served card.
      await page.addInitScript(() => {
        const watch = () => {
          const title = document.querySelector(".desk-title-list");
          const state = globalThis as unknown as { titleSeen?: boolean; titleLost?: boolean };
          if (title?.querySelector(".desk-deck-title")) state.titleSeen = true;
          else if (state.titleSeen && title) state.titleLost = true;
          requestAnimationFrame(watch);
        };
        requestAnimationFrame(watch);
      });
      await page.goto(`${base}/en/explore/69618be6-9206-f9c7-59eb-b5e4b072cf3d/capybara`, { waitUntil: "domcontentloaded" });
      await waitForPronto(page);
      const { seen, lost } = await page.evaluate(() => {
        const state = globalThis as unknown as { titleSeen?: boolean; titleLost?: boolean };
        return { seen: state.titleSeen, lost: state.titleLost };
      });
      if (!seen) throw new Error("The served card never drew its deck's title");
      if (lost) throw new Error("The deck's title vanished while the page was taken over");
    },
  },
  {
    id: "reopening-a-deck-asks-little",
    accepts: ["accept-play-flip"],
    run: async (page, base) => {
      // A first read answered early let go of its view, so each fold's wake rebuilt it and asked
      // again: reopening a deck took some two hundred requests and four seconds.
      const deck = "69618be6-9206-f9c7-59eb-b5e4b072cf3d";
      await page.goto(`${base}/en`, { waitUntil: "domcontentloaded" });
      await waitForPronto(page);
      const open = () => page.evaluate((href) => { const link = document.createElement("a"); link.href = href; document.body.append(link); link.click(); link.remove(); }, `/en/explore/${deck}`);
      await open();
      await page.waitForURL(new RegExp(`/explore/${deck}/[^/]+$`));
      await waitForPronto(page);
      await page.locator('.shell-screen:not([hidden]) a.nav-back-link').click();
      await page.waitForURL(`${base}/en`);
      await waitForPronto(page);
      // And a fold's named read with nothing holding its view read the same address on every wake,
      // and the home screen's covers each sent a read of their own.
      const asked = new Map<string, number>();
      const count = (request: { url(): string }) => {
        const url = request.url();
        if (url.includes("/crud/flashcard")) asked.set(url, (asked.get(url) ?? 0) + 1);
      };
      page.on("request", count);
      await open();
      await page.waitForURL(new RegExp(`/explore/${deck}/[^/]+$`));
      await waitForPronto(page);
      page.off("request", count);
      const reads = [...asked.values()].reduce((sum, n) => sum + n, 0);
      const repeated = Math.max(0, ...asked.values());
      const covers = [...asked.keys()].filter((url) => url.includes("limit=1")).length;
      if (reads > 12 || repeated > 3 || covers > 0) throw new Error(`Reopening a deck made ${reads} card reads, one address ${repeated} times, ${covers} per-deck cover reads`);
    },
  },
  {
    id: "card-navigation-address",
    accepts: ["accept-play-flip"],
    run: async (page, base) => {
      await page.goto(`${base}/en`, { waitUntil: "domcontentloaded" });
      await waitForPronto(page);
      await page.goto(`${base}/en/explore/69618be6-9206-f9c7-59eb-b5e4b072cf3d`, { waitUntil: "domcontentloaded" });
      await page.waitForURL(/\/en\/explore\/69618be6-9206-f9c7-59eb-b5e4b072cf3d\/[^/]+$/);
      await waitForPronto(page);
      const links = page.locator('.shell-screen:not([hidden]) .card-rail-pill');
      const first = await links.nth(0).getAttribute('href');
      const second = await links.nth(1).getAttribute('href');
      const firstLabel = await links.nth(0).locator('.pill-label').innerText();
      const secondLabel = await links.nth(1).locator('.pill-label').innerText();
      if (!first || !second) throw new Error('Deck needs two addressed cards');
      if (page.url() !== new URL(first, base).href) throw new Error('Deck entry did not resolve to the first rail card');
      await page.goBack();
      await page.waitForURL(`${base}/en`);
      await page.goForward();
      await page.waitForURL(new URL(first, base).href);
      await waitForPronto(page);
      const screen = page.locator('.shell-screen:not([hidden]) [data-screen="card"]');
      if (!await screen.locator('#btn-prev').isDisabled()) throw new Error('Previous must be disabled on the first card');
      await screen.evaluate((el) => { (globalThis as any).__navigationScreen = el; });
      await screen.locator('#btn-next').click();
      await page.waitForURL(new URL(second, base).href);
      await waitForPronto(page);
      if (!await page.evaluate(() => document.querySelector('.shell-screen:not([hidden]) [data-screen="card"]') === (globalThis as any).__navigationScreen)) throw new Error('Next replaced the card screen');
      const afterNext = await screen.locator('.card-front').getAttribute('data-front');
      if (afterNext?.toLowerCase() !== secondLabel.toLowerCase()) throw new Error(`Next selected ${afterNext}, expected ${secondLabel}`);
      await page.goBack();
      await page.waitForURL(new URL(first, base).href);
      await waitForPronto(page);
      if (!await page.evaluate(() => document.querySelector('.shell-screen:not([hidden]) [data-screen="card"]') === (globalThis as any).__navigationScreen)) throw new Error('Back replaced the card screen');
      const afterBack = await screen.locator('.card-front').getAttribute('data-front');
      if (afterBack?.toLowerCase() !== firstLabel.toLowerCase()) throw new Error(`Back selected ${afterBack}, expected ${firstLabel}`);
      await page.goForward();
      await page.waitForURL(new URL(second, base).href);
      await waitForPronto(page);
      if (!await page.evaluate(() => document.querySelector('.shell-screen:not([hidden]) [data-screen="card"]') === (globalThis as any).__navigationScreen)) throw new Error('Forward replaced the card screen');
      const afterForward = await screen.locator('.card-front').getAttribute('data-front');
      if (afterForward?.toLowerCase() !== secondLabel.toLowerCase()) throw new Error(`Forward selected ${afterForward}, expected ${secondLabel}`);
      await screen.locator('.card-rail-pill').first().click();
      await page.waitForURL(new URL(first, base).href);
      await waitForPronto(page);
      if (!await page.evaluate(() => document.querySelector('.shell-screen:not([hidden]) [data-screen="card"]') === (globalThis as any).__navigationScreen)) throw new Error('Rail navigation replaced the card screen');
      const emptyUrl = `${base}/en/explore/00000000-0000-0000-0000-000000000000`;
      await page.evaluate((href) => { const link = document.createElement('a'); link.href = href; document.body.append(link); link.click(); link.remove(); }, emptyUrl);
      await page.waitForURL(emptyUrl);
      await waitForPronto(page);
      await page.locator('[data-screen="deck"] .empty').waitFor({ state: 'visible' });
      if (page.url() !== emptyUrl) throw new Error('An empty deck must remain on its entry address');
      await page.goto(`${base}/explore/69618be6-9206-f9c7-59eb-b5e4b072cf3d?lang=pt`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => location.pathname.startsWith('/explore/69618be6-9206-f9c7-59eb-b5e4b072cf3d/') && new URLSearchParams(location.search).get('lang') === 'pt');
      await waitForPronto(page);
    },
  },
  {
    id: "browse-collections",
    accepts: ["accept-browse", "accept-signin"],
    run: async (page, appUrl) => {
      const base = readerOrigin(appUrl);
      await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
      await waitForPronto(page);
      await page.waitForSelector(".card-set-item:visible", { timeout: 15000 });

      const count = await page.$$eval(".card-set-item", (els) => els.length);
      if (count === 0) throw new Error("No card sets found in library grid");

      const firstDeck = page.locator(".card-set-item:visible").first();
      await firstDeck.waitFor({ state: "visible" });

      const name = await firstDeck.locator(".card-set-title, .set-name").first().innerText();
      if (!name) throw new Error("Deck title is missing");

      const meta = await firstDeck.locator(".card-set-meta, .set-meta").first().innerText();
      const hasCards = meta.includes("cards") || meta.includes("fichas");
      const hasLocale = meta.includes("pt-BR") || meta.includes("en");
      if (!hasCards && !hasLocale) {
        throw new Error(`Deck meta does not include cards count or locale: ${meta}`);
      }

      // Verify NO language filtering on deck list pages: all 210+ decks are visible and have real cover photography from flashcard.back
      const coverAudit = await page.$$eval(".card-set-item", (els) => {
        const missing: string[] = [];
        for (const el of els) {
          const id = el.getAttribute("data-id") || "unknown";
          const img = el.querySelector(".cover-illustration-img") as HTMLImageElement | null;
          const circle = el.querySelector(".cover-circle");
          const src = img?.getAttribute("src") || "";
          const circleDisplay = circle ? getComputedStyle(circle).display : "none";
          if (!src || circleDisplay !== "none" || getComputedStyle(el).display === "none") {
            missing.push(`${id} (srcLen=${src.length}, circle=${circleDisplay})`);
          }
        }
        return { total: els.length, missing };
      });
      if (coverAudit.missing.length > 0) {
        throw new Error(
          `${coverAudit.missing.length}/${coverAudit.total} decks missing cover artwork or hidden: ${coverAudit.missing.slice(0, 5).join(", ")}`
        );
      }

      // Sign-in is the nav's alone: Sign in opens its panel in place, never over the page,
      // onto this device's way in; no screen draws a sign-in of its own. A local stack
      // turns on no provider (verify.ts signs in with Google against a release).
      const signIn = page.locator("body > nav .shell-signin");
      const ways = page.locator("body > nav .shell-signin-panel");
      if (await ways.isVisible()) throw new Error("The nav's panel showed before Sign in was pressed");
      if (await page.locator('main [role="dialog"][aria-modal="true"], main [data-auth-action="passkey-signin"]').count() > 0) {
        throw new Error("A screen draws a sign-in of its own");
      }
      await signIn.click();
      await ways.waitFor({ state: "visible", timeout: 10000 });
      if (!(await ways.locator('.shell-passkey[data-auth-action="accounts"]').isVisible())) throw new Error("The nav's Sign in does not offer this device");
      if (await ways.locator(".shell-provider").count() > 0) throw new Error("A local stack offers a provider it does not turn on");

      // A device with nothing saved makes the account there through its way in; once made, the
      // same way in signs in. Each ends in a person's session.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
      });
      const signedInAsPerson = async (how: string) => {
        await page.waitForSelector('body > nav .shell-me[data-auth="user"] > .shell-person', { timeout: 15000 });
        await waitForPronto(page);
        if (await page.evaluate(() => { const u = JSON.parse(localStorage.getItem("pronto-token") ?? "{}").user; return !u?.id || Boolean(u.guest); })) {
          throw new Error(`Expected ${how} to sign in to a non-guest account`);
        }
        await page.locator("body > nav .shell-person").click();
        await page.locator("body > nav .shell-signout").click();
        await page.waitForSelector("body > nav .shell-signin", { timeout: 15000 });
        await waitForPronto(page);
      };
      // Nothing saved: a name makes the account; once made, its face signs in.
      await ways.locator(".shell-passkey").click();
      await page.locator("body > nav .shell-passkey-form input").fill("Ada");
      await page.locator("body > nav .shell-passkey-go").click();
      await signedInAsPerson("A passkey, with nothing saved");
      await signIn.click();
      // Chromium's virtual authenticator answers the field's passkey autofill
      // by itself, signing in under the face's click; the face is tested
      // alone here, and the autofill by the shell's smokes.
      await page.evaluate(() => { PublicKeyCredential.isConditionalMediationAvailable = async () => false; });
      await ways.locator(".shell-passkey").click();
      await page.locator("body > nav .shell-face-pick").first().click();
      await signedInAsPerson("This device's face");
      await page.waitForSelector(".card-set-item:visible", { timeout: 15000 });

      // Verify clicking on a deck cover image center navigates to /explore/:deck
      const firstDeckId = await firstDeck.getAttribute("data-id");
      const coverLink = firstDeck.locator("a.cover-canvas");
      await coverLink.click();
      await page.waitForSelector(".flashcard-deck", { timeout: 15000 });
      if (!page.url().includes(`/explore/${firstDeckId}`)) {
        throw new Error(`Clicking deck cover center did not navigate to /explore/${firstDeckId} (got ${page.url()})`);
      }

      // Verify switching to Spanish (/es) shows all UGC decks (NO filtering on deck list pages),
      // and when an English deck ("Action Noun Clues") is visualized on /es/explore/:deck,
      // the user initially sees the available language and over time it progressively translates to Spanish!
      await page.goto(`${base}/es`, { waitUntil: "domcontentloaded" });
      await waitForPronto(page);
      await page.waitForSelector(".card-set-item:visible", { timeout: 15000 });
      const visibleOnEs = await page.$$eval(".card-set-item", (els) =>
        els.filter((el) => getComputedStyle(el).display !== "none").length
      );
      if (visibleOnEs < 6) {
        throw new Error(`Expected all UGC decks to remain visible on /es (no filtering), got ${visibleOnEs}`);
      }

      // Visualize English deck "Action Noun Clues" (8c406e8f-abb7-181c-7904-3551846fe884) in Spanish (/es)
      await page.goto(`${base}/es/explore/8c406e8f-abb7-181c-7904-3551846fe884`, { waitUntil: "domcontentloaded" });
      await waitForPronto(page);
      await page.waitForSelector(".play-card-rail .card-rail-pill", { timeout: 15000 });

      const railLabels = await page.$$eval(".play-card-rail .card-rail-pill .pill-label", (els) =>
        els.map((e) => (e.textContent || "").trim().toLowerCase()).filter(Boolean)
      );
      if (railLabels.length < 5 || (!railLabels.includes("merienda") && !railLabels.includes("snack"))) {
        throw new Error(`Expected Action Noun Clues cards to render on /es/explore/:deck, got: ${JSON.stringify(railLabels)}`);
      }
      const screen = page.locator('.shell-screen:not([hidden]) [data-screen="card"]');
      const selectedId = await screen.locator('.play-container').getAttribute('data-index');
      const imageSrc = await screen.locator('.card-front .card-illustration-img').getAttribute('src');
      await screen.locator('#lang-en').click();
      await page.waitForURL(/\/en\/explore\/8c406e8f-abb7-181c-7904-3551846fe884\//);
      await waitForPronto(page);
      await page.waitForFunction(() => {
        const labels = Array.from(document.querySelectorAll('.shell-screen:not([hidden]) .card-rail-pill .pill-label'), el => el.textContent?.trim().toLowerCase());
        return labels.join('|') === 'snack|shoe|chair|cup|soap|crayon|ball|bed|headphones|book';
      }, null, { timeout: 30000 });
      await page.waitForTimeout(2000);
      const active = page.locator('.shell-screen:not([hidden]) [data-screen="card"]');
      const english = await active.locator('.card-rail-pill .pill-label').allTextContents();
      if (english.map(x => x.trim().toLowerCase()).join('|') !== 'snack|shoe|chair|cup|soap|crayon|ball|bed|headphones|book') throw new Error(`English rail reverted: ${JSON.stringify(english)}`);
      if (await active.locator('.card-front .card-illustration-img').getAttribute('src') !== imageSrc) throw new Error('Language switch changed the selected card image');
      if (await active.locator('.play-container').getAttribute('data-index') !== selectedId) throw new Error('Language switch changed the selected card');
    },
  },
  // One shared field once favourited a deck for every visitor: a favourite is now each
  // reader's own, and the count everyone's.
  {
    id: "toggle-favorite",
    accepts: ["accept-favorite"],
    run: async (a, base) => {
      const b = await (await a.context().browser()!.newContext({ locale: "pt-BR", viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true })).newPage();
      try {
        const deck = "09440a66-ff6f-494a-39c9-60e67740a0a3";
        const item = (page: Page) => page.locator(`.card-set-item[data-id="${deck}"]`);
        const open = async (page: Page) => {
          await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
          await waitForPronto(page);
          await item(page).waitFor({ state: "visible", timeout: 15000 });
        };
        // The arm on show, and the count it shows.
        const shown = (page: Page) => item(page).evaluate((el) => {
          const arm = [...el.querySelectorAll(".fav-arm")].find((f) => getComputedStyle(f).display !== "none");
          return arm ? `${arm.classList.contains("when-set") ? "set" : "unset"}:${arm.querySelector(".fav-count")?.textContent?.trim()}` : "none";
        });
        const until = async (page: Page, want: string) => {
          const wall = Date.now() + 15000;
          let got = "";
          while (Date.now() < wall) {
            got = await shown(page);
            if (got === want) return;
            await page.waitForTimeout(200);
          }
          throw new Error(`favourite shows ${got}, wanted ${want}`);
        };
        await open(a);
        await open(b);
        await until(a, "unset:0");
        await item(a).locator(".when-unset .btn-fav").click();
        await until(a, "set:1");
        // Another reader sees the count and not the favourite.
        await until(b, "unset:1");
        await item(b).locator(".when-unset .btn-fav").click();
        await until(b, "set:2");
        await until(a, "set:2");
        // A reload keeps the reader's own favourite.
        await open(a);
        await until(a, "set:2");
        await item(a).locator(".when-set .btn-fav").click();
        await until(a, "unset:1");
        await until(b, "set:1");
      } finally {
        await b.context().close();
      }
    },
  },
  {
    id: "generate-set",
    accepts: ["accept-generate", "accept-delete-card"],
    run: async (page, base) => {
      await page.goto(`${base}/generate`, { waitUntil: "domcontentloaded" });
      await waitForPronto(page);
      await page.waitForSelector("#btn-create", { timeout: 15000 });

      // 0. Verify #pronto-assets importmap has NO stale pdf-press hatch and matches current shell/ file hashes
      const importMapRaw = await page.$eval("script#pronto-assets", (el) => el.textContent || "{}");
      if (importMapRaw.includes("pdf-press") || !importMapRaw.includes("/shell/hatches/window-print.js") || !importMapRaw.includes("/shell/units/ai-browser/unit.js")) {
        throw new Error(`Unexpected hatch/unit state in live #pronto-assets importmap: ${importMapRaw}`);
      }
      const imports: Record<string, string> = JSON.parse(importMapRaw).imports || {};
      for (const rel of ["screens/generate.html", "screens/print.html", "shell/handlers/create_set.js", "shell/hatches/window-print.js", "shell/units/ai-browser/unit.js"]) {
        const mapped = imports[`/${rel}`] || "";
        if (!/_immutable-[0-9a-f]{64}-/.test(mapped)) {
          throw new Error(`Missing content-addressed asset mapping for /${rel}: got ${mapped}`);
        }
        try {
          // Served as written: the print screen learns its commerce mode from the server at runtime.
          const bytes = await Deno.readFile(`${APP}/${rel}`);
          const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          if (!mapped.includes(`_immutable-${digest}-`)) {
            throw new Error(`Stale content-addressed asset for /${rel}: expected hash ${digest}, got ${mapped}`);
          }
        } catch (err) {
          if (!(err instanceof Deno.errors.NotFound)) throw err;
        }
      }

      // English starts with its translated audience and keeps an edited value through live draft rebinding.
      await page.goto(`${base}/en/generate`, { waitUntil: "domcontentloaded" });
      await waitForPronto(page);
      const audience = page.locator("#difficulty-select");
      const englishAudienceDefault = await audience.inputValue();
      if (englishAudienceDefault !== "Kids (6–10)") {
        throw new Error(`Expected the English audience default to be "Kids (6–10)", got "${englishAudienceDefault}"`);
      }
      // The chevron is the only way to a menu, so a screen reader must be told what it opens.
      if (!await page.locator("#difficulty-combo-toggle").getAttribute("aria-label")) throw new Error("Expected the audience chevron to name itself");
      await page.locator("#difficulty-combo-toggle").click();
      await page.locator("#difficulty-combo-menu .quick-pick-option").filter({ hasText: "Youth & Adults" }).click();
      // A choice closes its menu and writes the row, which is what the input shows.
      if (await page.locator("#difficulty-combo-menu").isVisible()) throw new Error("Expected choosing an option to close its menu");
      await page.locator("#locale-combo-toggle").click();
      await page.locator("#locale-opt-fr").click();
      await page.waitForFunction(() => (document.querySelector("#locale-input") as HTMLInputElement | null)?.value === "Français", null, { timeout: 5000 });
      await page.locator("#locale-combo-toggle").click();
      await page.locator("#locale-opt-en").click();
      await page.waitForFunction(() => (document.querySelector("#locale-input") as HTMLInputElement | null)?.value === "English", null, { timeout: 5000 });
      const selectedAudience = await audience.inputValue();
      if (selectedAudience !== "Youth & Adults") {
        throw new Error(`Expected choosing the English "Youth & Adults" audience option, got "${selectedAudience}"`);
      }
      await page.locator("#topic-input").fill("English audience rebinding check");
      await waitForPronto(page);
      const reboundAudience = await audience.inputValue();
      if (reboundAudience !== "Youth & Adults") {
        throw new Error(`Expected the edited English audience to survive draft rebinding, got "${reboundAudience}"`);
      }

      await page.goto(`${base}/generate`, { waitUntil: "domcontentloaded" });
      await waitForPronto(page);
      // The form keeps the preset's key, not its English label: each reader sees it in their language.
      const portugueseAudience = await page.locator("#difficulty-select").inputValue();
      if (portugueseAudience !== "Jovens & Adultos") throw new Error(`Expected the chosen audience in Portuguese, got "${portugueseAudience}"`);

      await page.locator("#topic-input").fill("presidentes do brasil");
      await waitForPronto(page);
      await page.locator("#draft-loc-pt").click();
      await waitForPronto(page);
      await page.locator("#category-input").fill("");
      await waitForPronto(page);
      await page.waitForTimeout(250);

      // 1. Verify typing in #topic-input cleans #preview-card-container in idle state
      const idleSpecimenVisibility = await page.$eval("#preview-specimen-name", (el) => getComputedStyle(el).visibility);
      if (idleSpecimenVisibility !== "hidden") {
        throw new Error(`Expected #preview-specimen-name to be cleaned (visibility: hidden) while typing in idle state, got "${idleSpecimenVisibility}"`);
      }

      // 2. While generation_draft is "idle", no generation-only visual treatment leaks into the preview
      const visibleJobsIdle = await page.locator("#generation-jobs-list .gen-job-card:visible").count();
      const bannerBefore = await page.locator("#generated-deck-banner").isVisible();
      if (visibleJobsIdle === 0 && bannerBefore) {
        throw new Error("Expected #generated-deck-banner to be hidden before any collection is generated");
      }
      if (visibleJobsIdle > 0 && !bannerBefore) {
        throw new Error("Expected #generated-deck-banner to remain visible when generated collections exist in the log");
      }
      const idleProofStyle = await page.$eval("#preview-card-container", (el) => {
        const s = getComputedStyle(el);
        const placeholder = getComputedStyle(el.querySelector(".specimen-back-word-box")!, "::after");
        return { filter: s.filter, borderStyle: s.borderStyle, placeholder: placeholder.content, animation: placeholder.animationName };
      });
      if (idleProofStyle.filter !== "none" || idleProofStyle.borderStyle !== "dashed" || idleProofStyle.placeholder !== '"—"' || idleProofStyle.animation !== "none") {
        throw new Error(`Expected idle preview to have no filter, a dashed cut border, and a static em dash placeholder, got ${JSON.stringify(idleProofStyle)}`);
      }

      // 3. Pick Israel/Hebrew from the #draft-loc-more popover and verify draft locale updates to human-friendly "עברית" & region to "Tel Aviv, Israel" in idle state
      await page.locator("#draft-loc-more").click();
      await page.locator("#draft-loc-he").click();
      if (await page.locator("#draft-loc-menu").evaluate((el) => el.matches(":popover-open"))) throw new Error("#draft-loc-menu must close after a country is picked");
      await waitForPronto(page);
      await page.waitForTimeout(200);
      const ugcLoc = await page.locator(".studio-container").getAttribute("data-ugc-locale");
      if (ugcLoc !== "עברית" && ugcLoc !== "he-IL") {
        throw new Error(`Expected #draft-loc-more to update data-ugc-locale to "עברית", got "${ugcLoc}"`);
      }
      // The popover lost the select's shown value; the trigger now names the pick.
      const moreLabel = (await page.locator("#draft-loc-more").innerText()).trim();
      if (!moreLabel.includes("עברית")) throw new Error(`Expected #draft-loc-more to name the picked country, got "${moreLabel}"`);

      // 3b. Verify arbitrary audience ("lonely elders") in #difficulty-select and Tab auto-completion of grayed default in #category-input
      await page.locator("#difficulty-select").fill("lonely elders");
      const customAudienceVal = await page.locator("#difficulty-select").inputValue();
      if (customAudienceVal !== "lonely elders") {
        throw new Error(`Expected #difficulty-select combobox to accept arbitrary input "lonely elders", got "${customAudienceVal}"`);
      }

      // 4. Switch back to Brasil (Português), type "veículos espaciais" (which erases Categoria and updates the browser-model grayed default), press Tab on #category-input to auto-complete it, and generate 1st collection -> #01 in log
      await page.locator("#draft-loc-pt").click();
      await waitForPronto(page);
      await page.locator("#topic-input").fill("veículos espaciais");
      await waitForPronto(page);
      await page.waitForTimeout(200);
      const catBeforeTab = await page.locator("#category-input").inputValue();
      if (catBeforeTab !== "") {
        throw new Error(`Expected typing in #topic-input to erase #category-input, got "${catBeforeTab}"`);
      }
      await page.locator("#category-input").focus();
      await page.keyboard.press("Tab");
      await waitForPronto(page);
      await page.waitForTimeout(150);
      const catAfterTab = (await page.locator("#category-input").inputValue()).trim();
      if (!catAfterTab) {
        throw new Error("Expected pressing Tab in empty #category-input to auto-complete the browser-model grayed default");
      }

      await page.locator("#btn-create").click();
      // Generation progress treatment belongs to the generating state; idle preview stays unfiltered.
      await page.waitForFunction(() => {
        const sc = document.querySelector(".studio-container");
        const el = document.querySelector("#preview-card-container");
        const back = el?.querySelector(".specimen-back-word-box");
        if (!sc || !el || !back) return false;
        if (sc.getAttribute("data-status") === "done") return true;
        if (sc.getAttribute("data-status") !== "generating") return false;
        const progress = getComputedStyle(back, "::after");
        return progress.content.includes("…") && progress.animationName.includes("aiProgressPulse");
      }, null, { timeout: 15000 });
      await page.waitForFunction(() => {
        const el = document.querySelector("#preview-card-container");
        const img = [...document.querySelectorAll<HTMLImageElement>("#preview-front-box .card-illustration-img")].find((i) => getComputedStyle(i).display !== "none");
        if (!el || !img) return false;
        const s = getComputedStyle(el);
        const src = img.getAttribute("src") || "";
        // The blob plane's URL, and imgproxy answered it: the picture decoded.
        return s.filter === "none" && s.borderStyle === "solid" && src.startsWith("/img/insecure/plain/s3://mecha-objects/effects/") &&
          img.complete && img.naturalWidth > 0;
      }, null, { timeout: 90000 });
      await waitForPronto(page);

      await badgesHonest(page);
      const bannerVisible = await page.locator("#generated-deck-banner").isVisible();
      if (!bannerVisible) {
        throw new Error("Clicking #btn-create did not reveal #generated-deck-banner");
      }
      // The guest's first collection is the moment worth keeping: beside it, a passkey that keeps it.
      await page.locator('body[data-auth="guest"] #generated-deck-banner .keep-decks-offer [data-auth-action="passkey-register"]')
        .waitFor({ state: "visible", timeout: 15000 });
      const bannerTitleText = ((await page.locator("#gen-banner-title").innerText()) || "").trim();
      if (!bannerTitleText.toLowerCase().includes("coleções geradas")) {
        throw new Error(`Expected #gen-banner-title to say "Coleções Geradas", got "${bannerTitleText}"`);
      }
      const visibleJobsAfterFirst = await page.locator("#generation-jobs-list .gen-job-card:visible").count();
      if (visibleJobsAfterFirst < 1) {
        throw new Error(`Expected at least 1 visible job row (#01) in #generation-jobs-list after 1st collection, got ${visibleJobsAfterFirst}`);
      }

      // Verify 5 cards rendered in #preview-deck-strip and real AI PNG image rendered in #preview-front-box
      const stripChips = page.locator("#preview-deck-strip .preview-strip-chip:visible");
      const chipCount = await stripChips.count();
      const selectedCardCount = Number(await page.locator("#card-count-input").inputValue());
      if (chipCount !== selectedCardCount) {
        throw new Error(`Expected #preview-deck-strip to show the selected ${selectedCardCount} cards after generation, got ${chipCount}`);
      }
      // The pill's message binds the card's position and the deck's size; an
      // unbound argument reaches the screen as its own "{position}".
      const pillText = ((await page.locator("#preview-status-pill").innerText()) || "").trim();
      if (!/^\S+ \d+ \S+ \d+$/.test(pillText)) {
        throw new Error(`Expected #preview-status-pill to read "Ficha <n> de <m>", got "${pillText}"`);
      }
      const previewImgSrc = (await page.locator("#preview-front-box .card-illustration-img:visible").getAttribute("src")) || "";
      if (!previewImgSrc.startsWith("/img/insecure/plain/s3://mecha-objects/effects/")) {
        throw new Error(`Expected #preview-front-box .card-illustration-img to show illustrate-card's picture from the blob plane, got "${previewImgSrc.slice(0, 60)}"`);
      }
      const rawObject = await page.request.get(new URL(previewImgSrc.replace("/img/insecure/plain/s3://mecha-objects/", "/blobs/mecha-objects/"), page.url()).href);
      if (rawObject.status() !== 200 || rawObject.headers()["content-security-policy"] !== "sandbox") {
        throw new Error(`Expected a raw object to be sandboxed, got ${rawObject.status()} "${rawObject.headers()["content-security-policy"]}"`);
      }

      // 4b. Regression: the owner's own preview must keep showing art once the session
      // moves off card 0. generate.css once hid every .card-illustration-img but the
      // first with :not(:first-of-type) !important, which always beat the nth-child
      // selection rule as soon as a later card was picked (or generation's own
      // in-progress session advanced past card 0), leaving #preview-front-box blank.
      const laterChip = page.locator("#preview-deck-strip .preview-strip-chip:visible").nth(2);
      await laterChip.click();
      await waitForPronto(page);
      await page.waitForFunction(() => {
        const sel = document.querySelector(".preview-selection [data-index]");
        return sel?.getAttribute("data-index") === "2";
      }, null, { timeout: 10000 });
      const laterPreviewImgSrc = (await page.locator("#preview-front-box .card-illustration-img:visible").getAttribute("src")) || "";
      if (!laterPreviewImgSrc.startsWith("/img/insecure/plain/s3://mecha-objects/effects/")) {
        throw new Error(`Expected #preview-front-box to still show a blob plane picture after selecting deck position 2, got "${laterPreviewImgSrc.slice(0, 60)}"`);
      }
      if (laterPreviewImgSrc === previewImgSrc) {
        throw new Error("Expected selecting a different deck-strip card to change #preview-front-box's rendered image");
      }

      // 5. Start typing 2nd topic ("revistas em quadrinhos"): verify "Coleções Geradas" stays visible as a log while "Prévia da Ficha" cleans immediately
      await page.locator("#topic-input").fill("revistas em quadrinhos");
      await waitForPronto(page);
      await page.waitForTimeout(200);

      const bannerStillVisibleOnType = await page.locator("#generated-deck-banner").isVisible();
      if (!bannerStillVisibleOnType) {
        throw new Error("Expected #generated-deck-banner (Coleções Geradas log) to remain visible when typing a new topic in #topic-input");
      }
      const cleanedImgVisible = await page.locator("#preview-front-box .card-illustration-img:visible").isVisible();
      const cleanedChipsCount = await page.locator("#preview-deck-strip .preview-strip-chip:visible").count();
      if (cleanedImgVisible || cleanedChipsCount !== 0) {
        throw new Error(`Expected typing in #topic-input to immediately clean Prévia da Ficha (imgVisible=${cleanedImgVisible}, chips=${cleanedChipsCount})`);
      }

      // 6. Click #btn-create for 2nd topic ("revistas em quadrinhos"): appends #02 to "Coleções Geradas" log with distinct content
      await page.locator("#btn-create").click();
      const secondDeck = await deckOf(page, "revistas em quadrinhos");
      await page.waitForFunction(() => {
        const el = document.querySelector("#preview-card-container");
        const rows = document.querySelectorAll("#generation-jobs-list .gen-job-card");
        if (!el || rows.length < 2) return false;
        const s = getComputedStyle(el);
        return s.filter === "none" && s.borderStyle === "solid";
      }, null, { timeout: 90000 });
      await waitForPronto(page);

      await badgesHonest(page);
      // Both decks settle; the badge then names what each drew.
      await page.waitForFunction(() => [...document.querySelectorAll("#generation-jobs-list .gen-job-row")].every((row) =>
        row.querySelector('.deck-level-state[data-level="3"]') && !row.querySelector('.deck-level-state[data-state="running"]')), null, { timeout: 90000 });
      await badgesHonest(page);
      // The database numbers a deck, and the number reaches its row.
      await page.waitForFunction((deck) => /^[1-9][0-9]*$/.test(document.querySelector(`.gen-job-row[data-set-id="${deck}"] .gen-job-num`)?.textContent?.trim() ?? ""), secondDeck, { timeout: 15000 });
      const visibleJobsAfterSecond = await page.locator("#generation-jobs-list .gen-job-card:visible").count();
      if (visibleJobsAfterSecond < 2) {
        throw new Error(`Expected at least 2 distinct job entries (#01 and #02) in #generation-jobs-list after 2nd generation, got ${visibleJobsAfterSecond}`);
      }
      // Another browser's decks of the same titles are other decks, listed hidden.
      const jobTopics = (await page.locator("#generation-jobs-list .gen-job-name:visible").allInnerTexts()).map((t) => t.trim().toLowerCase());
      const uniqueJobTopics = new Set(jobTopics);
      if (uniqueJobTopics.size !== jobTopics.length) {
        throw new Error(`Expected every row in #generation-jobs-list to have a distinct topic (no duplicate #01/#02 rows), got ${JSON.stringify(jobTopics)}`);
      }

      const bannerText = (await page.locator("#generated-deck-banner").innerText()).toLowerCase();
      if (!bannerText.includes("veículos espaciais") || !bannerText.includes("revistas em quadrinhos")) {
        throw new Error(`Expected #generated-deck-banner log to contain both "veículos espaciais" and "revistas em quadrinhos", got "${bannerText}"`);
      }
      if (bannerText.includes("/explore/")) {
        throw new Error(`Expected #generated-deck-banner to omit nerdy /explore/ URL text, got "${bannerText}"`);
      }

      // "Ver Minhas Fichas" lands on the My Cards library, never the unfiltered home with its featured hero.
      // The link once sat outside every region, so its data-on-click was never bound and it navigated unfiltered.
      await page.locator(".shell-screen:not([hidden]) #link-library-mine").click();
      await page.waitForFunction(() => document.querySelector(".shell-screen:not([hidden]) .library-shell")?.getAttribute("data-author-filter") === "mine", null, { timeout: 10000 });
      if (await page.locator(".shell-screen:not([hidden]) .featured-hero").isVisible()) {
        throw new Error("Expected the featured hero hidden on the My Cards library reached from #link-library-mine");
      }
      const mineSets = await page.locator('.shell-screen:not([hidden]) .card-set-item[data-cover-emoji="🎨"]:visible').count();
      if (mineSets < 2) {
        throw new Error(`Expected both generated collections listed under My Cards, got ${mineSets}`);
      }
      // A cover offers its picture at each width for the browser to choose. The original alone
      // would cost a home screen of decks hundreds of megabytes.
      await page.waitForFunction(() => {
        const img = document.querySelector('.shell-screen:not([hidden]) .card-set-item[data-cover-emoji="🎨"] .cover-illustration-img') as HTMLImageElement | null;
        return Boolean(img && img.currentSrc.includes("/img/insecure/rs:fit:") && img.getAttribute("srcset")?.includes("/img/insecure/rs:fit:320:320/plain/s3://mecha-objects/effects/") && img.complete && img.naturalWidth > 0);
      }, null, { timeout: 15000 });
      await page.goBack();
      await page.waitForURL(/\/generate$/);
      await waitForPronto(page);

      // Verify that CTA to /explore/:deck opens the deck's permalink WITH the real generated front illustration
      await page.locator("#btn-open-explore").click();
      await waitForPronto(page);
      await page.waitForSelector(".flashcard-deck", { timeout: 15000 });
      if (!page.url().includes(`/explore/${secondDeck}`)) {
        throw new Error(`Expected permalink navigation to /explore/${secondDeck}, got ${page.url()}`);
      }
      const exploreTitle = ((await page.locator(".desk-deck-title").first().innerText()) || "").trim().toLowerCase();
      if (!exploreTitle.includes("revistas em quadrinhos")) {
        throw new Error(`Expected /explore collection title to be "revistas em quadrinhos", got "${exploreTitle}"`);
      }
      const exploreImgSrc = (await page.locator(".card-front .card-illustration-img").first().getAttribute("src")) || "";
      if (!exploreImgSrc.startsWith("/img/insecure/plain/s3://mecha-objects/effects/")) {
        throw new Error(`Expected generated collection on /explore to render illustrate-card's picture from the blob plane, got "${exploreImgSrc.slice(0, 60)}"`);
      }

      // A reader deletes one card of the deck they generated with two taps on its button: the
      // rail, the deck's count and the session's total all lose that card, and the rail's
      // numbering is its order, so the cards left run 01..n with no gap. One tap alone reverts.
      const rail = page.locator(".shell-screen:not([hidden]) .play-card-rail .card-rail-item");
      const before = await rail.count();
      const doomed = ((await rail.nth(1).locator(".pill-label").innerText()) || "").trim();
      const button = rail.nth(1).locator(".btn-delete-card");
      await button.click();
      await page.waitForFunction((el) => el?.closest(".card-delete")?.getAttribute("data-delete") === "armed", await button.elementHandle(), { timeout: 5000 });
      const armed = await button.evaluate((el) => ({
        state: el.closest(".card-delete")?.getAttribute("data-delete"),
        text: (el as HTMLElement).innerText.trim(),
        background: getComputedStyle(el).backgroundColor,
      }));
      if (armed.state !== "armed" || armed.text !== "Apagar?" || armed.background !== "rgb(220, 38, 38)") throw new Error(`Expected one tap to arm the button as "Apagar?", got ${JSON.stringify(armed)}`);
      await page.waitForFunction((el) => el?.closest(".card-delete")?.getAttribute("data-delete") === "idle", await button.elementHandle(), { timeout: 8000 });
      if ((await rail.count()) !== before) throw new Error("One tap alone deleted a card");
      await button.click();
      await button.click();
      await page.waitForFunction((n) => document.querySelectorAll(".shell-screen:not([hidden]) .play-card-rail .card-rail-item").length === n, before - 1, { timeout: 15000 });
      await waitForPronto(page);
      const labels = (await rail.locator(".pill-label").allInnerTexts()).map((t) => t.trim());
      if (labels.includes(doomed)) throw new Error(`Expected "${doomed}" gone from the rail, got ${JSON.stringify(labels)}`);
      if (labels.length !== before - 1 || labels.some((l) => !l)) throw new Error(`Expected ${before - 1} named cards in the rail, got ${JSON.stringify(labels)}`);
      const deckCount = ((await page.locator(".shell-screen:not([hidden]) .desk-locale-pill b").first().innerText()) || "").trim();
      const sessionTotal = ((await page.locator(".shell-screen:not([hidden]) .contact-count-pill b").first().innerText()) || "").trim();
      if (deckCount !== String(before - 1) || sessionTotal !== String(before - 1)) {
        throw new Error(`Expected the deck and the session to count ${before - 1} cards after one delete, got deck ${deckCount} and session ${sessionTotal}`);
      }

      // 5. Navigate to capybara deck, then return to /generate and verify Coleções Geradas + preview + Explorar Fichas link stay synced to "revistas em quadrinhos" (never capybara)
      // Within the tab, as a reader moves: the form is the tab's, and a reload starts a fresh one.
      await page.evaluate((href) => { const link = document.createElement("a"); link.href = href; document.body.append(link); link.click(); link.remove(); }, `${base}/explore/69618be6-9206-f9c7-59eb-b5e4b072cf3d/capybara`);
      await page.waitForURL(/\/explore\/69618be6-9206-f9c7-59eb-b5e4b072cf3d\/capybara$/);
      await waitForPronto(page);
      await page.locator('a[data-route="generate"]:visible').first().click();
      await page.waitForURL(/\/generate$/);
      await waitForPronto(page);
      await page.waitForFunction((deck) => {
        const a = document.querySelector("#btn-open-explore");
        return Boolean(a && (a.getAttribute("href") || "").includes(deck));
      }, secondDeck, { timeout: 10000 });
      const syncedSpecimen = ((await page.locator("#preview-specimen-name").innerText()) || "").trim().toLowerCase();
      if (syncedSpecimen === "capybara") {
        throw new Error("Expected #preview-specimen-name on /generate to match generated topic instead of capybara");
      }

      // 6. A deck deleted from its list takes its cards and translations with it. The list reads none
      // of them, so a delete of the rows at hand left every one behind, unseen, with nothing on screen to say so.
      await page.evaluate(async (deck) => {
        const held = JSON.parse(localStorage.getItem("pronto-token") ?? "{}");
        const headers = { authorization: `Bearer ${held.access_token ?? held.token}`, "content-type": "application/json" };
        const put = async (table: string, row: Record<string, unknown>) => {
          const res = await fetch(`/crud/${table}`, { method: "POST", headers, body: JSON.stringify(row) });
          if (!res.ok) throw new Error(`Writing ${table} answered ${res.status}: ${await res.text()}`);
        };
        await put("deck_translation", { id: `${deck}:he`, set_id: deck, lang: "he", name: "x", category: "" });
        await put("card_translation", { id: `${deck}-card:he`, card_id: `${deck}-card`, set_id: deck, lang: "he", word: "x" });
      }, secondDeck);
      await page.locator(`.gen-job-row[data-set-id="${secondDeck}"] .btn-delete-job`).click();
      await page.waitForFunction((deck) => !document.querySelector(`.gen-job-row[data-set-id="${deck}"]`), secondDeck, { timeout: 15000 });
      const cardsLeft = () => page.evaluate(async (deck) => {
        const held = JSON.parse(localStorage.getItem("pronto-token") ?? "{}");
        const left = await Promise.all(["flashcard", "deck_translation", "card_translation"].map(async (table) => {
          const res = await fetch(`/crud/${table}?select=id&set_id=eq.${deck}`, { headers: { authorization: `Bearer ${held.access_token ?? held.token}` }, cache: "no-store" });
          return (await res.json()).length;
        }));
        return left.reduce((a, b) => a + b, 0);
      }, secondDeck);
      for (let waited = 0; (await cardsLeft()) > 0; waited += 250) {
        if (waited > 15000) throw new Error(`Deleting a deck left ${await cardsLeft()} of its rows behind`);
        await page.waitForTimeout(250);
      }
    },
  },
  {
    id: "deck-title-and-details",
    accepts: ["accept-generate"],
    run: async (page, base) => {
      // The whole prompt was the deck's title, so a reader's instructions became its name.
      const details = "somente aves aquáticas, desenhadas de perfil";
      const setId = await generateDeck(page, base, "Aves do Pantanal", details);
      const name = (await page.locator(`#generation-jobs-list .gen-job-row[data-set-id="${setId}"] .gen-job-name`).innerText()).trim();
      if (name !== "Aves do Pantanal") throw new Error(`Expected the job to be named by its title, got "${name}"`);
      if ((await page.locator("#generated-deck-banner").innerText()).includes(details)) throw new Error("The details reached the screen as a title");
      await page.goto(`${base}/explore/${setId}`, { waitUntil: "domcontentloaded" });
      await waitForPronto(page);
      const title = ((await page.locator(".shell-screen:not([hidden]) .desk-deck-title").first().innerText()) || "").trim();
      if (title !== "Aves do Pantanal") throw new Error(`Expected the deck titled "Aves do Pantanal", got "${title}"`);
    },
  },
  {
    id: "generate-preview-follows-generation",
    accepts: ["accept-generate"],
    run: async (page, base) => {
      // The preview bound the session, which a generation would not move, so after exploring
      // deck A it went on showing A while deck B generated.
      // The reader moves within the tab, so its session and its queued writes stay.
      const create = page.locator('a[data-route="generate"]:visible').first();
      const first = await generateDeck(page, base, "Bichos da Caatinga");
      await page.locator("#btn-open-explore").click();
      await page.waitForURL(new RegExp(`/explore/${first}/[^/]+$`));
      await waitForPronto(page);
      await create.click();
      await page.waitForURL(/\/generate$/);
      await waitForPronto(page);
      await page.locator("#topic-input").fill("Peixes lentos");
      await page.locator("#draft-loc-pt").click();
      await waitForPronto(page);
      await page.locator("#btn-create").click();
      await page.waitForFunction(() => document.querySelector(".studio-container")?.getAttribute("data-status") === "generating", null, { timeout: 10000 });
      // A form idled here would never settle, and would hide the preview.
      await page.locator("#locale-combo-toggle").click();
      await page.locator("#locale-opt-es").click();
      await page.waitForFunction(() => (document.querySelector("#locale-input") as HTMLInputElement | null)?.value === "Español", null, { timeout: 5000 });
      await page.locator("#details-input").fill("só os de água doce");
      await page.locator("#difficulty-combo-toggle").click();
      await page.locator("#audience-teens").click();
      await waitForPronto(page);
      const whileGenerating = await page.locator(".studio-container").getAttribute("data-status");
      if (whileGenerating !== "generating") throw new Error(`Expected editing the form to leave it generating, got "${whileGenerating}"`);
      // Back to deck A: the session follows it.
      await page.goBack();
      await page.waitForURL(new RegExp(`/explore/${first}/[^/]+$`));
      await waitForPronto(page);
      await create.click();
      await page.waitForURL(/\/generate$/);
      await waitForPronto(page);
      const seen = await page.evaluate(() => ({
        status: document.querySelector(".studio-container")?.getAttribute("data-status"),
        deck: document.querySelector("#preview-card-container")?.getAttribute("data-set-id"),
        chips: [...document.querySelectorAll("#preview-deck-strip .preview-strip-chip")].map((c) => c.getAttribute("data-id")),
      }));
      if (seen.status !== "generating") throw new Error(`Expected to return while "Peixes lentos" still generates, got ${JSON.stringify(seen)}`);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(seen.deck ?? "")) throw new Error(`Expected the preview to show the deck being generated, got ${JSON.stringify(seen)}`);
      await page.waitForFunction((deck) => {
        const chips = [...document.querySelectorAll("#preview-deck-strip .preview-strip-chip")].map((c) => c.getAttribute("data-id") ?? "");
        return chips.length > 0 && chips.every((id) => id.startsWith(`card-${deck}-`));
      }, seen.deck, { timeout: 15000 });
    },
  },
  {
    // Every visitor shared one form row: a fresh browser showed another reader's title and
    // details, and a second writer reverted a reader's card count to its own. The form was then
    // the tab's, and a reload mid-generation forgot the deck the server went on drawing.
    id: "draft-per-device",
    accepts: ["accept-generate"],
    run: async (a, base) => {
      const b = await (await a.context().browser()!.newContext({ locale: "pt-BR", viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true })).newPage();
      const errors: string[] = [];
      b.on("pageerror", (err) => errors.push(err.message));
      try {
        const open = async (page: Page) => {
          await page.goto(`${base}/generate`, { waitUntil: "domcontentloaded" });
          await waitForPronto(page);
        };
        const form = (page: Page) => page.evaluate(() => {
          const panel = document.querySelector(".studio-container");
          return {
            topic: (document.querySelector("#topic-input") as HTMLInputElement).value,
            details: (document.querySelector("#details-input") as HTMLTextAreaElement).value,
            dataTopic: panel?.getAttribute("data-topic"),
            count: panel?.getAttribute("data-count"),
            text: (document.querySelector(".shell-screen:not([hidden]) .screen[data-screen='generate']") as HTMLElement | null)?.innerText ?? "",
          };
        });
        await open(a);
        await a.locator("#topic-input").fill("Moedas antigas");
        await a.locator("#details-input").fill("somente moedas de prata do Império");
        await a.locator("#draft-loc-pt").click();
        await a.locator("#count-pill-15").click();
        await waitForPronto(a);
        await open(b);
        const fresh = await form(b);
        for (const leaked of ["Moedas antigas", "somente moedas de prata do Império"]) {
          if ([fresh.topic, fresh.details, fresh.dataTopic].includes(leaked) || fresh.text.includes(leaked)) throw new Error(`A fresh browser shows another reader's form: ${JSON.stringify(fresh)}`);
        }
        await b.locator("#topic-input").fill("Selos raros");
        await b.locator("#draft-loc-pt").click();
        await b.locator("#count-pill-10").click();
        await waitForPronto(b);
        await a.waitForTimeout(1500);
        const kept = await form(a);
        if (kept.count !== "15" || kept.topic !== "Moedas antigas") throw new Error(`Another browser's form edits moved this one: ${JSON.stringify(kept)}`);
        if ((await form(b)).count !== "10") throw new Error("The second browser's card count did not hold");
        await Promise.all([a.locator("#btn-create").click(), b.locator("#btn-create").click()]);
        const [deckA, deckB] = await Promise.all([deckOf(a, "Moedas antigas"), deckOf(b, "Selos raros")]);
        if (deckA.slice(-16) === deckB.slice(-16)) throw new Error(`Two browsers share a device key: ${deckA} ${deckB}`);
        // Reloaded once the server is drawing the deck: the page holds nothing it still owes.
        await a.locator(`#generation-jobs-list .gen-job-row[data-set-id="${deckA}"] .deck-level-state`).first().waitFor({ state: "attached", timeout: 60000 });
        await open(a);
        if ((await form(a)).topic !== "Moedas antigas") throw new Error(`A reload lost the form: ${JSON.stringify(await form(a))}`);
        await a.locator(`#generation-jobs-list .gen-job-row[data-set-id="${deckA}"] .ai-tier-pipeline`).first().waitFor({ state: "visible", timeout: 15000 });
        await a.locator(`.shell-screen:not([hidden]) #preview-card-container[data-set-id="${deckA}"]`).waitFor({ state: "attached", timeout: 15000 });
        await Promise.all([settled(a, deckA), settled(b, deckB)]);
        const counts = await Promise.all([a, b].map((page, i) => page.locator(`#generation-jobs-list .gen-job-row[data-set-id="${[deckA, deckB][i]}"] .gen-job-count`).first().innerText()));
        if (!counts[0].includes("(15 ") || !counts[1].includes("(10 ")) throw new Error(`Each deck keeps its own card count, got ${JSON.stringify(counts)}`);
        if ((await form(b)).text.includes("Moedas antigas")) throw new Error("The second browser's /generate shows the first one's title");
        if (errors.length) throw new Error(`Second browser errors: ${errors.join(" | ")}`);
      } finally {
        await b.context().close();
      }
    },
  },
  {
    id: "edit-card-sheet",
    accepts: ["accept-edit-card"],
    run: async (page, base) => {
      await page.setViewportSize({ width: 375, height: 812 });
      const setId = await generateDeck(page, base, "Insetos do Jardim");
      // The title and details form and a generated job row once overflowed nothing; keep it so at a phone's width.
      const generateWidth = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, viewport: innerWidth }));
      if (generateWidth.doc > generateWidth.viewport) throw new Error(`/generate scrolls horizontally on a phone: ${JSON.stringify(generateWidth)}`);
      await page.locator("#btn-open-explore").click();
      await page.waitForURL(new RegExp(`/explore/${setId}/[^/]+$`));
      await waitForPronto(page);
      // The deck is the reader's after a reload, and nobody else's: ownership was a tab-only
      // list, and reloading a card's page hid its ✏️ from its own author.
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForPronto(page);
      await page.locator(".shell-screen:not([hidden]) .btn-edit-card").waitFor({ state: "visible", timeout: 15000 });
      const stranger = await (await page.context().browser()!.newContext({ ignoreHTTPSErrors: true })).newPage();
      await stranger.goto(page.url(), { waitUntil: "domcontentloaded" });
      await waitForPronto(stranger);
      await stranger.waitForTimeout(3000);
      if (await stranger.locator(".shell-screen:not([hidden]) .btn-edit-card").isVisible()) throw new Error("Another reader sees ✏️ on a deck they do not own");
      await stranger.context().close();
      const screen = page.locator(".shell-screen:not([hidden])");
      // The delete control sits absolutely over each rail card; at a phone's width it must stay inside its card.
      const deleteBoxes = await page.evaluate(() => [...document.querySelectorAll(".shell-screen:not([hidden]) .card-rail-item")].flatMap((item) => {
        const control = item.querySelector(".card-delete");
        if (!control || getComputedStyle(control).display === "none") return [];
        const c = control.getBoundingClientRect(); const i = item.getBoundingClientRect();
        return c.left < i.left - 1 || c.right > i.right + 1 || c.top < i.top - 1 || c.bottom > i.bottom + 1 ? [{ item: [i.left, i.right, i.top, i.bottom], control: [c.left, c.right, c.top, c.bottom] }] : [];
      }));
      if (deleteBoxes.length) throw new Error(`The delete control leaves its rail card at 375px: ${JSON.stringify(deleteBoxes)}`);
      const edit = screen.locator(".btn-edit-card");
      await edit.click();
      const sheet = screen.locator("#card-edit-sheet");
      if (!await sheet.evaluate((el) => el.matches(":popover-open"))) throw new Error("✏️ did not open the edit sheet");
      const details = sheet.locator("#card-edit-details");
      // The box is the reader's own: a model's description prefilled it once, and a redraw
      // then sent that invented picture to the image model.
      const written = (await details.inputValue()).trim();
      if (written !== "") throw new Error(`Expected an empty description for the reader to write, got "${written}"`);
      const fit = await page.evaluate(() => {
        const box = document.querySelector(".shell-screen:not([hidden]) #card-edit-sheet")!.getBoundingClientRect();
        return { doc: document.documentElement.scrollWidth, viewport: innerWidth, left: box.left, right: box.right };
      });
      if (fit.doc > fit.viewport || fit.left < 0 || fit.right > fit.viewport) throw new Error(`The edit sheet overflows a phone: ${JSON.stringify(fit)}`);
      // The sheet's form re-renders as its card's row changes, so each wait reads the live DOM.
      const img = sheet.locator(".card-edit-img");
      const before = await img.getAttribute("src");
      const art = (state: string) => page.waitForFunction((want) => {
        const form = document.querySelector(".shell-screen:not([hidden]) #card-edit-sheet .card-edit-form");
        return form?.getAttribute("data-redraw") === "settled" && form.querySelector(".card-edit-progress")?.getAttribute("data-art") === want;
      }, state, { timeout: 60000 });
      await details.fill("Uma joaninha vermelha sobre uma folha");
      await sheet.locator(".btn-regenerate").click();
      await page.waitForFunction((src) => document.querySelector(".shell-screen:not([hidden]) #card-edit-sheet .card-edit-img")?.getAttribute("src") !== src, before, { timeout: 60000 });
      await art("drawn");
      if ((await details.inputValue()).trim() !== "Uma joaninha vermelha sobre uma folha") throw new Error("The sheet lost the reader's description");
      // A refused drawing shows the no-art frame in the sheet; the card keeps its art.
      const drawnSrc = await img.getAttribute("src");
      // The rail thumbnail, at its own size, and the main card view read the same
      // flashcard.back live, with no reload: a production report saw the sheet's own progress
      // move but only the sheet (and only after a reload) ever showed the art.
      const editedFront = await screen.locator(".card-face.card-front").getAttribute("data-front");
      const railThumb = screen.locator(`.card-rail-pill[data-front="${editedFront}"] .card-illustration-img`);
      const mainImg = screen.locator(".card-face.card-front .plate-solo-visual .card-illustration-img");
      const railSrc = await railThumb.getAttribute("src");
      if (railSrc !== drawnSrc?.replace("/img/insecure/plain/", "/img/insecure/rs:fit:640:640/plain/")) throw new Error(`Expected the rail thumbnail to swap to the redrawn art with no reload, got "${railSrc?.slice(0, 40)}"`);
      const mainSrc = await mainImg.getAttribute("src");
      if (mainSrc !== drawnSrc) throw new Error(`Expected the main card view to swap to the redrawn art with no reload, got "${mainSrc?.slice(0, 40)}"`);
      await details.fill("NSFW joaninha");
      await sheet.locator(".btn-regenerate").click();
      await art("failed");
      const broken = await sheet.locator(".card-edit-art").evaluate((el) => ({ bg: getComputedStyle(el).backgroundImage, img: getComputedStyle(el.querySelector("img")!).visibility }));
      if (!broken.bg.includes("svg") || broken.img !== "hidden") throw new Error(`Expected the no-art frame for a refused drawing, got ${JSON.stringify(broken)}`);
      if ((await img.getAttribute("src")) !== drawnSrc) throw new Error("A refused drawing replaced the card's art");
      await sheet.locator(".btn-edit-done").click();
      if (await sheet.evaluate((el) => el.matches(":popover-open"))) throw new Error("Pronto did not close the sheet");
      // Regression: a production report said the ✏️ and 🗑 controls were gone
      // from the rail and card view after one edit — the press lease's
      // owned-deck gate must still be met once the sheet closes.
      if (!(await edit.isVisible())) throw new Error("✏️ is gone from the card view after an edit settled");
      const deleteVisibleAfter = await screen.locator(".card-delete").first().evaluate((el) => getComputedStyle(el).display !== "none");
      if (!deleteVisibleAfter) throw new Error("🗑 is gone from the rail after an edit settled");
    },
  },
  {
    id: "play-flip-card",
    accepts: ["accept-play-flip"],
    run: async (page, base) => {
      // 1. Verify clicking "puma" in the contact sheet on /explore/:deck never flips twice to "titan arum" (index 0)
      await page.goto(`${base}/explore/69618be6-9206-f9c7-59eb-b5e4b072cf3d`, { waitUntil: "domcontentloaded" });
      await page.waitForURL(/\/explore\/69618be6-9206-f9c7-59eb-b5e4b072cf3d\/[^/]+$/);
      await waitForPronto(page);
      const initialIndex = await page.locator('.shell-screen:not([hidden]) .play-container').getAttribute('data-index');
      const pumaIndex = await page.locator('.shell-screen:not([hidden]) .card-rail-pill').evaluateAll((els) => els.findIndex((el) => el.getAttribute('data-name') === 'puma'));
      await page.evaluate(() => {
        (window as any).__indexHistory = [];
        const pc = document.querySelector(".play-container");
        if (pc) {
          new MutationObserver(() => {
            (window as any).__indexHistory.push({ index: pc.getAttribute("data-index"), front: pc.querySelector('.card-front')?.getAttribute('data-front'), url: location.href });
          }).observe(pc, { attributes: true, attributeFilter: ["data-index"] });
        }
      });
      await page.locator('.card-rail-pill[data-name="puma"]').click();
      await waitForPronto(page);
      const indexHistory: { index: string; front: string; url: string }[] = await page.evaluate(() => (window as any).__indexHistory || []);
      let reachedPuma = false;
      const bounced = indexHistory.some((entry) => {
        if (entry.index === String(pumaIndex)) reachedPuma = true;
        return (entry.index !== initialIndex && entry.index !== String(pumaIndex)) || (reachedPuma && entry.index === initialIndex);
      });
      if (bounced) {
        throw new Error(`Clicking "puma" bounced through index 0 ("titan arum"): history=${JSON.stringify(indexHistory)}`);
      }

      // 2. Verify deep link /explore/:deck/:card settles on the requested card ("puma") and its illustration without flashing another card
      await page.goto(`${base}/explore/69618be6-9206-f9c7-59eb-b5e4b072cf3d/puma`, { waitUntil: "domcontentloaded" });
      await waitForPronto(page);
      await page.waitForSelector(".card-front[data-front]", { timeout: 15000 });
      await waitForPronto(page);

      const actualFront = (await page.locator(".card-front").first().getAttribute("data-front")) || "";
      if (actualFront.toLowerCase() !== "puma") {
        throw new Error(`Deep link /explore/69618be6-9206-f9c7-59eb-b5e4b072cf3d/puma did not settle on "puma" after waitForPronto (got "${actualFront}")`);
      }

      const pumaImgSrc = (await page.locator(".card-front .card-illustration-img").first().getAttribute("src")) || "";
      if (!pumaImgSrc.startsWith("/img/insecure/")) {
        throw new Error(`Expected "puma" card to render database illustration in .card-illustration-img, got "${pumaImgSrc.slice(0, 60)}"`);
      }

      const cardFlipTarget = page.locator("#card-flip, .card-inner").first();
      await cardFlipTarget.waitFor({ state: "visible" });

      // Click to flip card (retrying briefly if SSR page is still hydrating event listeners)
      const frame = page.locator(".flashcard-frame");
      let flipped = "no";
      const flipWall = Date.now() + 8000;
      while (Date.now() < flipWall) {
        await cardFlipTarget.click();
        await page.waitForTimeout(350);
        flipped = (await frame.getAttribute("data-flipped")) || "no";
        if (flipped === "yes" || flipped === "back" || flipped === "true") {
          break;
        }
      }
      if (flipped !== "yes" && flipped !== "back" && flipped !== "true") {
        throw new Error(`Card did not flip (data-flipped=${flipped})`);
      }

      // Wait for back face transition so innerText/textContent is readable
      const backWord = ((await page.locator(".card-back-title").first().textContent()) || "").trim().toLowerCase();
      if (backWord !== "puma") {
        throw new Error(`Expected back of card to show only target word "puma", got "${backWord}"`);
      }
      const hasBackDescOrEmoji = await page.evaluate(() => {
        return Boolean(document.querySelector(".back-emoji-seal, .card-back-desc-card, .front-word-label"));
      });
      if (hasBackDescOrEmoji) {
        throw new Error("Found forbidden .back-emoji-seal, .card-back-desc-card, or .front-word-label on card face");
      }

      // 2. Verify #btn-next ("Próxima Ficha") and #btn-prev ("Ficha Anterior") work on /explore/:deck/:card
      await page.locator("#btn-next").first().click();
      await page.waitForTimeout(500);
      const afterNextFront = (await page.locator(".card-front").first().getAttribute("data-front"))?.toLowerCase();
      if (!afterNextFront || afterNextFront === "puma") {
        throw new Error(`Expected #btn-next to advance away from "puma", got "${afterNextFront}"`);
      }

      await page.locator("#btn-prev").first().click();
      await page.waitForTimeout(500);
      const afterPrevFront = (await page.locator(".card-front").first().getAttribute("data-front"))?.toLowerCase();
      if (afterPrevFront !== "puma") {
        throw new Error(`Expected #btn-prev to return to "puma", got "${afterPrevFront}"`);
      }

      // 3. Verify Full Screen toggle (#btn-fullscreen-toggle) transitions [data-machine] to data-status="fullscreen", card never overlaps #btn-next / #btn-prev, and #btn-fullscreen-exit returns to "playing"
      await page.locator("#btn-fullscreen-toggle").first().click();
      await waitForPronto(page);
      await page.waitForTimeout(250);
      const fsStatus = await page.locator(".play-container").first().getAttribute("data-status");
      if (fsStatus !== "fullscreen") {
        throw new Error(`Expected .play-container[data-machine] to transition to data-status="fullscreen", got "${fsStatus}"`);
      }
      const fsTopbarVisible = await page.locator(".fullscreen-topbar").first().isVisible();
      if (!fsTopbarVisible) {
        throw new Error("Expected .fullscreen-topbar to become visible in Full Screen mode");
      }
      const fsGeometry = await page.evaluate(() => {
        const frame = document.querySelector(".flashcard-frame") as HTMLElement | null;
        const stack = document.querySelector(".flashcard-stack-wrap") as HTMLElement | null;
        const nextBtn = document.querySelector("#btn-next") as HTMLElement | null;
        const prevBtn = document.querySelector("#btn-prev") as HTMLElement | null;
        if (!frame || !stack || !nextBtn || !prevBtn) return null;
        const frameRect = frame.getBoundingClientRect();
        const stackRect = stack.getBoundingClientRect();
        const nextRect = nextBtn.getBoundingClientRect();
        const prevRect = prevBtn.getBoundingClientRect();
        const topEdgeHit = document.elementFromPoint(nextRect.left + nextRect.width / 2, nextRect.top + 2);
        const topEdgeOccluded = Boolean(topEdgeHit && !nextBtn.contains(topEdgeHit) && !topEdgeHit.contains(nextBtn));
        return {
          frameBottom: Math.round(frameRect.bottom),
          stackBottom: Math.round(stackRect.bottom),
          nextTop: Math.round(nextRect.top),
          prevTop: Math.round(prevRect.top),
          topEdgeOccluded,
          blockerClass: (topEdgeHit as HTMLElement | null)?.className || "",
        };
      });
      if (!fsGeometry || fsGeometry.frameBottom > fsGeometry.nextTop - 6 || fsGeometry.stackBottom > fsGeometry.nextTop || fsGeometry.topEdgeOccluded) {
        throw new Error(`Full Screen card overlaps #btn-next / #btn-prev: ${JSON.stringify(fsGeometry)}`);
      }
      await page.locator("#btn-fullscreen-exit").first().click();
      await page.waitForTimeout(250);
    },
  },
  {
    id: "play-complete-and-progress",
    accepts: ["accept-play-complete"],
    run: async (page, base) => {
      await page.goto(`${base}/explore`, { waitUntil: "domcontentloaded" });
      await waitForPronto(page);
      await page.waitForSelector("#btn-next", { timeout: 15000 });

      const masterVisible = await page.locator("#btn-master").first().isVisible();
      if (masterVisible) throw new Error("#btn-master should be hidden (Mark Reviewed dropped)");

      const prevIdx = Number(await page.locator(".play-container").first().getAttribute("data-index") || "0");
      const nextBtn = page.locator("#btn-next").first();
      await nextBtn.waitFor({ state: "visible" });
      await nextBtn.click();
      await waitForPronto(page);
      await page.waitForTimeout(300);

      const nextIdx = Number(await page.locator(".play-container").first().getAttribute("data-index") || "0");
      if (nextIdx === prevIdx) throw new Error(`Expected play-container data-index to advance from ${prevIdx} after clicking #btn-next, got ${nextIdx}`);

      // Auto / Light / Dark: the theme is the device row's column, assigned by
      // the theme chart and worn by the device region every screen wraps.
      for (const mode of ["dark", "light", "auto"]) {
        await page.locator(`.shell-screen:not([hidden]) .theme-btn[data-theme-val="${mode}"]`).first().click();
        await page.waitForFunction((want) => document.querySelector('.shell-screen:not([hidden]) .device-scope')?.getAttribute('data-theme') === want, mode, { timeout: 10000 });
      }
    },
  },
  {
    id: "print-checkout-demo",
    accepts: ["accept-print-checkout"],
    run: async (page, appUrl) => {
      const base = readerOrigin(appUrl);
      const live = await liveCheckout(page, base, appUrl);
      await page.goto(`${base}/print`, { waitUntil: "domcontentloaded" });
      await waitForPronto(page);
      // Ocean Animals: a seeded deck other than the session's default, with enough cards for the review's fan of three.
      const deck = "09440a66-ff6f-494a-39c9-60e67740a0a3";
      await page.locator(`.deck-picker-card[data-id="${deck}"]`).click();
      await page.waitForFunction((id) => document.querySelector('.print-container')?.getAttribute('data-set-id') === id, deck);
      await page.waitForFunction(() => document.querySelectorAll('.sheet-paper-primary .print-card').length >= 3);
      await chooseProdigi(page);
      const selectedTitle = await selectedDeckIsNamed(page, deck);
      if (!selectedTitle) throw new Error("Selected print collection has no title");
      await page.locator('[data-screen="print"][data-commerce-mode="live"]').waitFor({ state: "attached", timeout: 15000 });
      await page.locator("#btn-order-print").click();
      await page.locator("#print-checkout-panel").waitFor({state:"visible"});
      if (!await page.locator("#print-checkout-panel").evaluate((dialog: HTMLDialogElement) => dialog.open)) throw new Error("Checkout must open as a modal dialog");
      if ((await page.locator("#print-checkout-collection").innerText()).trim() !== selectedTitle) throw new Error("Checkout must review the selected collection");
      const evidence = `${APP}/docs/evidence/checkout`;
      await Deno.mkdir(evidence,{recursive:true});
      await page.locator(".checkout-fan img").evaluateAll(async (images) => {
        if (images.length !== 3) throw new Error("The order review must preview three selected cards");
        for (const image of images as HTMLImageElement[]) {
          await image.decode();
          if (image.naturalWidth <= 1) throw new Error("The order review copied a placeholder instead of card artwork");
        }
      });
      await page.locator("#print-checkout-panel").screenshot({path:`${evidence}/app-before-payment.png`});
      await page.setViewportSize({width:390,height:844});
      if (await page.locator("#print-checkout-panel").evaluate(element => element.scrollWidth > element.clientWidth)) throw new Error("Mobile checkout must not overflow horizontally");
      await page.locator("#print-checkout-panel").screenshot({path:`${evidence}/app-mobile.png`});
      await page.keyboard.press("Escape");
      if (!await page.locator("#btn-order-print").evaluate(element => element === document.activeElement)) throw new Error("Closing checkout must restore focus to its opener");
      await page.setViewportSize({width:1280,height:900});
      await page.locator("#btn-order-print").click();
      // Missing mandatory fields keep naming what is missing when Continue to
      // payment is clicked, rather than claiming the address disagrees with the map.
      await page.fill("#delivery-text", "Casa azul atrás da escola, Vila Madalena");
      await statusIs(page, "address_needed");
      await page.locator("#btn-checkout-pay").click();
      await statusIs(page, "address_needed");
      await fillPostal(page);
      await statusIs(page, "quoted");
      if (!/\d/.test(await page.locator('[data-quote="total"]').innerText())) throw new Error("Checkout lacks the quoted total");
      await page.locator("#print-checkout-panel").screenshot({path:`${evidence}/app-quoted.png`});
      const { order, token, session } = await live.pay();
      await page.screenshot({ path: `${evidence}/simulator-checkout.png` });
      // The webhook is held: the buyer is back with a complete, paid session
      // and the order still waits, since only a signal or a refresh asks Stripe.
      await live.control("/_simulator/webhooks/hold");
      let released: { type: string; status: number }[];
      try {
        await live.frame.locator('input[name="email"]').fill("buyer@example.test");
        await live.frame.locator('button[value="pay"]').click();
        await page.waitForFunction(() => document.querySelector("#print-checkout-status")?.getAttribute("data-state") === "pending", null, { timeout: 30000 })
          .catch(() => { throw new Error("The returning buyer's order is not pending before its webhook"); });
        const before = await live.order(order, token);
        if (before.paymentStatus !== "pending") throw new Error(`The order is ${before.paymentStatus} before its webhook`);
        if ((await live.mails(order)).length) throw new Error("Mail was sent before the webhook");
      } finally {
        released = await live.control("/_simulator/webhooks/release");
      }
      if (released.length !== 1 || released[0].type !== "checkout.session.completed" || released[0].status !== 200) {
        throw new Error(`The completed webhook was not accepted: ${JSON.stringify(released)}`);
      }
      await until("the paid order's fulfilment", async () => {
        const now = await live.order(order, token);
        return now.paymentStatus === "paid" && now.fulfillmentStatus === "sent" ? now : false;
      });
      await page.waitForFunction(() => document.querySelector("#print-checkout-status")?.getAttribute("data-state") === "paid_sent", null, { timeout: 15000 });
      await page.locator("#print-checkout-panel").screenshot({path:`${evidence}/app-after-payment.png`});
      const [mail, ...extra] = await until("the fulfilment mail", async () => (await live.mails(order)).length ? await live.mails(order) : false);
      if (extra.length) throw new Error(`The order sent ${extra.length + 1} mails`);
      if (mail.Subject !== `[TEST] Snapcards order ${order}`) throw new Error(`Fulfilment mail is not marked as a test: ${mail.Subject}`);
      if (!(await live.mailText(mail.ID)).includes(`Deck: ${selectedTitle}`)) throw new Error("The record names another deck");
      // Stripe delivers at least once: the same event again is acknowledged and mails nothing.
      const [completed] = await live.events(session);
      const resent = await live.control(`/_simulator/events/${completed.id}/resend`);
      if (resent.status !== 200) throw new Error(`A resent event was refused: ${JSON.stringify(resent)}`);
      await page.waitForTimeout(2000);
      if ((await live.mails(order)).length !== 1) throw new Error("A resent event sent a second mail");
      if (live.stripeAsked.length) throw new Error(`The browser asked Stripe: ${live.stripeAsked.join(", ")}`);
      if (await page.locator('.print-sheet-preview').count() !== 1) throw new Error("Temporary PDF capture surface leaked into the app");
    },
  },
  {
    id: "print-delivery",
    accepts: ["accept-print-delivery"],
    run: async (page, appUrl) => {
      const base = readerOrigin(appUrl);
      const live = await liveCheckout(page, base, appUrl);
      // Nominatim and the tile style answered here: an acceptance run asks no
      // public service, and the reader's three statements are what is under test.
      const place = (road: string, number: string, lat: string, lon: string, city = "São Paulo", state = "São Paulo", iso = "BR-SP", postcode = "01305-100") => ({
        lat, lon, display_name: `${number}, ${road}, ${city}, ${postcode}, Brasil`,
        address: { house_number: number, road, city, state, "ISO3166-2-lvl4": iso, postcode, country: "Brasil", country_code: "br" },
      });
      const asked: string[] = [];
      await page.context().route("https://nominatim.openstreetmap.org/**", (route) => {
        const url = new URL(route.request().url());
        asked.push(url.pathname);
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const body = url.pathname === "/reverse"
          ? place("Rua Haddock Lobo", "595", url.searchParams.get("lat")!, url.searchParams.get("lon")!)
          : q.includes("atlantica") || q.includes("atlântica")
          ? [place("Avenida Atlântica", "1702", "-22.971100", "-43.182200", "Rio de Janeiro", "Rio de Janeiro", "BR-RJ", "22021-001")]
          : [place("Rua Augusta", "1508", "-23.556633", "-46.658741")];
        return route.fulfill({ json: body });
      });
      await page.context().route("https://tiles.openfreemap.org/**", (route) =>
        route.fulfill({ json: { version: 8, sources: {}, layers: [{ id: "paper", type: "background", paint: { "background-color": "#efe8dd" } }] } }));
      await page.context().grantPermissions(["geolocation"]);
      await page.context().setGeolocation({ latitude: -23.5612, longitude: -46.6558 });
      await page.goto(`${base}/print`, { waitUntil: "domcontentloaded" });
      await waitForPronto(page);
      const deck = "09440a66-ff6f-494a-39c9-60e67740a0a3";
      await page.locator(`.deck-picker-card[data-id="${deck}"]`).click();
      await page.waitForFunction((id) => document.querySelector('.print-container')?.getAttribute('data-set-id') === id, deck);
      await chooseProdigi(page);
      await page.locator("#btn-order-print").click();
      await page.locator("#print-checkout-panel").waitFor({ state: "visible" });
      const delivery = page.locator(".checkout-delivery");
      const typed = "rua augusta 1508 sp";
      await page.fill("#delivery-text", typed);
      await page.waitForTimeout(1500);
      if (asked.length) throw new Error(`Nominatim was asked while the reader typed: ${asked.join(", ")}`);
      await page.press("#delivery-text", "Enter");
      await page.locator(".delivery-suggestion").first().waitFor({ state: "visible", timeout: 15000 });
      await page.locator(".delivery-suggestion").first().click();
      await page.waitForFunction(() => (document.querySelector("#delivery-line1") as HTMLInputElement)?.value === "Rua Augusta, 1508");
      if (await page.locator("#delivery-text").inputValue() !== "Rua Augusta, 1508") throw new Error("Applying a suggestion did not complete the search box minimally");
      if (await delivery.getAttribute("data-pin-source") !== "search") throw new Error("Applying a suggestion did not place the pin");
      if (await page.locator(".delivery-suggestion").first().isVisible()) throw new Error("The applied suggestion list stayed open");
      // Regression: the list was deleted on apply, and the search button on the
      // same words, which asks nobody again, showed nothing.
      await page.locator("#btn-delivery-search").click();
      await page.locator(".delivery-suggestion").first().waitFor({ state: "visible", timeout: 5000 });
      // The position toggle fills the search bar with the reverse-geocoded
      // address, triggers a search near the reader, and shows the autocomplete
      // options; focusing out picks the first option.
      const searches = asked.filter((path) => path === "/search").length;
      await page.frameLocator(".delivery-locate iframe").locator("#locate").click();
      await page.waitForFunction(() => document.querySelector(".checkout-delivery")?.getAttribute("data-pin-source") === "gps", null, { timeout: 15000 });
      await page.waitForFunction(() => (document.querySelector("#delivery-text") as HTMLInputElement)?.value === "Rua Haddock Lobo, 595, São Paulo", null, { timeout: 15000 });
      await until("the search near the reader", async () => asked.filter((path) => path === "/search").length > searches);
      await page.locator(".delivery-suggestion").first().waitFor({ state: "visible", timeout: 15000 });
      if (await page.frameLocator(".delivery-locate iframe").locator("#locate").getAttribute("aria-pressed") !== "true") throw new Error("The position toggle does not read as on");
      const pinOffer = page.locator('.delivery-offer[data-offer="pin"]');
      await pinOffer.waitFor({ state: "attached", timeout: 15000 });
      if (await pinOffer.isVisible()) throw new Error("The pin offer must stay hidden until confirmation is triggered");
      if (await page.locator("#delivery-line1").inputValue() !== "Rua Augusta, 1508") throw new Error("The reader's position rewrote the postal fields");
      await page.fill("#delivery-recipient", "Marina Albuquerque");
      await page.fill("#delivery-cpf", "12345678909");
      await page.fill("#delivery-line2", "Apto 42");
      await statusIs(page, "quoted");
      const heldToken = JSON.parse((await page.evaluate(() => localStorage.getItem("pronto-token"))) ?? "{}").token as string;
      const quotedIdBeforeReload = await delivery.getAttribute("data-order-id");
      if (!quotedIdBeforeReload) throw new Error("Quoted order id was not written to delivery_draft");
      await until("pre-uploaded artwork on quoted print_order", async () => {
        const res = await page.request.get(`${appUrl}/crud/print_order?id=eq.${quotedIdBeforeReload}`, { headers: { authorization: `Bearer ${heldToken}` } });
        if (!res.ok()) return false;
        const [row] = await res.json() as { artwork?: string[] | null }[];
        return Array.isArray(row?.artwork) && row.artwork.length >= 3 ? true : false;
      });
      const evidence = `${APP}/docs/evidence/delivery`;
      await Deno.mkdir(evidence, { recursive: true });
      await page.locator("#print-checkout-panel").screenshot({ path: `${evidence}/app-delivery.png` });
      // Reloading the page preserves delivery_draft (including order_id) and reuses
      // the existing quoted print_order row and its pre-uploaded artwork.
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForPronto(page);
      await page.locator(`.deck-picker-card[data-id="${deck}"]`).click();
      await page.waitForFunction((id) => document.querySelector('.print-container')?.getAttribute('data-set-id') === id, deck);
      await chooseProdigi(page);
      await page.locator("#btn-order-print").click();
      await page.locator("#print-checkout-panel").waitFor({ state: "visible" });
      await statusIs(page, "quoted");
      if (await delivery.getAttribute("data-order-id") !== quotedIdBeforeReload) {
        throw new Error(`Expected print_order ${quotedIdBeforeReload} to survive reload, got ${await delivery.getAttribute("data-order-id")}`);
      }
      // The reader's position still disagrees with the address after the reload,
      // so the first click asks to confirm, once the pin offer has loaded, and
      // shows that offer; paying before it renders raced the confirmation away.
      await pinOffer.waitFor({ state: "attached", timeout: 15000 });
      await page.locator("#btn-checkout-pay").click();
      await statusIs(page, "confirm_address");
      await pinOffer.waitFor({ state: "visible", timeout: 15000 });
      await page.waitForFunction(() => document.querySelector(".checkout-delivery")?.getAttribute("data-step") === "confirming", null, { timeout: 15000 });
      const firstPaid = await live.pay();
      if (firstPaid.order !== quotedIdBeforeReload) {
        throw new Error(`Expected Continue to Payment after reload to reuse print_order ${quotedIdBeforeReload}, got ${firstPaid.order}`);
      }
      // Regression: going to Checkout, pressing Browser Back, searching an address
      // in another city (which grays out the old apartment as ghost and places a
      // fresh pin), and clicking Continue to Payment must ask for confirmation and
      // keep .checkout-delivery visible.
      await page.goBack();
      await waitForPronto(page);
      if (!await page.locator("#print-checkout-panel").isVisible()) {
        await chooseProdigi(page);
        await page.locator("#btn-order-print").click();
        await page.locator("#print-checkout-panel").waitFor({ state: "visible" });
      }
      if (!await delivery.isVisible() || await page.locator("#print-checkout-payment").isVisible()) throw new Error("Returning with Browser Back hid .checkout-delivery");
      await page.fill("#delivery-text", "avenida atlantica 1702 rio");
      await page.press("#delivery-text", "Enter");
      await page.locator('.delivery-suggestion[data-line1="Avenida Atlântica, 1702"]').waitFor({ state: "visible", timeout: 15000 });
      await page.locator('.delivery-suggestion[data-line1="Avenida Atlântica, 1702"]').click();
      await page.waitForFunction(() => (document.querySelector("#delivery-line1") as HTMLInputElement)?.value === "Avenida Atlântica, 1702");
      if (await page.locator("#delivery-line2").inputValue() !== "") throw new Error("Changing street across cities did not clear line2");
      if (await page.locator("#delivery-line2").getAttribute("data-ghost") !== "Apto 42") throw new Error("Cleared line2 did not keep ghost");
      if (await page.locator(".f-line2").getAttribute("data-stale") !== "true") throw new Error("Cleared line2 did not mark .f-line2 stale");
      if (await page.locator(".delivery-map-stage").getAttribute("data-stale") !== "false") throw new Error("Accepted suggestion left the map pin stale");
      await statusIs(page, "quoted");
      await page.locator("#btn-checkout-pay").click();
      await statusIs(page, "confirm_address");
      if (await delivery.getAttribute("data-step") !== "confirming") throw new Error("Confirmation did not move delivery_draft.step to confirming");
      if (!await delivery.isVisible()) throw new Error("Clicking pay after Back hid .checkout-delivery");
      const { order, token, session } = await live.pay();
      // A declined card keeps the session open and unpaid, as Checkout does:
      // no checkout.session event, so the order waits and nothing is mailed.
      await live.frame.locator('button[value="decline"]').click();
      await live.frame.locator('main[data-outcome="declined"][data-status="open"]').waitFor({ timeout: 15000 });
      await page.screenshot({ path: `${evidence}/simulator-declined.png` });
      if ((await live.order(order, token)).paymentStatus !== "pending") throw new Error("A declined card moved the order");
      if ((await live.events(session)).length) throw new Error("A declined card sent a checkout.session event");
      await live.frame.locator("text=Cancel and return").click();
      await page.waitForFunction(() => document.querySelector("#print-checkout-status")?.getAttribute("data-state") === "pending", null, { timeout: 30000 });
      const summary = (await page.locator("#print-checkout-delivery-summary").innerText()).trim();
      if (!summary.startsWith("Avenida Atlântica, 1702")) throw new Error(`The receipt did not freeze the delivery: ${summary}`);
      if (await delivery.isVisible()) throw new Error("The draft stayed editable beside the receipt that froze it");
      // The resumed session expires unpaid: its event asks Stripe, the order
      // reads expired, and nothing is mailed.
      await page.locator("#btn-checkout-pay").click();
      await live.frame.locator(`main[data-session="${session}"]`).waitFor({ state: "visible", timeout: 30000 });
      await live.frame.locator('button[value="expire"]').click();
      await live.frame.locator('main[data-status="expired"]').waitFor({ timeout: 15000 });
      const [expired] = await until("the expired event's delivery", async () => {
        const events = await live.events(session);
        return events.length && events[0].deliveries.length ? events : false;
      });
      if (expired.type !== "checkout.session.expired" || expired.deliveries[0].status !== 200) {
        throw new Error(`The expired webhook was not accepted: ${JSON.stringify(expired)}`);
      }
      await page.goto(`${base}/print?order=${order}`, { waitUntil: "domcontentloaded" });
      await waitForPronto(page);
      await page.waitForFunction(() => document.querySelector("#print-checkout-status")?.getAttribute("data-state") === "expired", null, { timeout: 30000 })
        .catch(() => { throw new Error("The receipt does not show the expired order"); });
      await page.locator("#print-checkout-panel").screenshot({ path: `${evidence}/app-expired.png` });
      if ((await live.order(order, token)).paymentStatus !== "expired") throw new Error("The order did not expire");
      if ((await live.mails(order)).length) throw new Error("An unpaid order sent mail");
      if (live.stripeAsked.length) throw new Error(`The browser asked Stripe: ${live.stripeAsked.join(", ")}`);
    },
  },
  {
    id: "print-shop",
    accepts: ["accept-print-shop"],
    run: async (page, appUrl) => {
      const base = readerOrigin(appUrl);
      const evidence = `${APP}/docs/evidence/print-shop`;
      await Deno.mkdir(evidence, { recursive: true });
      await page.setViewportSize({ width: 1280, height: 900 });
      const asked: string[] = [];
      page.on("request", (request) => { if (new URL(request.url()).pathname.includes("print_order") && request.method() !== "GET") asked.push(request.url()); });
      await page.goto(`${base}/print`, { waitUntil: "domcontentloaded" });
      await waitForPronto(page);
      const lang = await page.evaluate(() => document.documentElement.lang);
      const msg: Record<string, string> = JSON.parse(await Deno.readTextFile(`${APP}/messages/${lang}.json`));
      const deck = "09440a66-ff6f-494a-39c9-60e67740a0a3";
      await page.locator(`.deck-picker-card[data-id="${deck}"]`).click();
      await page.waitForFunction((id) => document.querySelector('.print-container')?.getAttribute('data-set-id') === id, deck);
      await page.waitForFunction(() => document.querySelectorAll('.sheet-paper-primary .print-card').length >= 3);
      const title = await selectedDeckIsNamed(page, deck);
      const orient = async (want: string) => {
        if (await page.locator(".print-container").getAttribute("data-orientation") === want) return;
        await page.locator("#btn-print-orientation").click();
        await page.waitForFunction((want) => document.querySelector(".print-container")?.getAttribute("data-orientation") === want, want);
      };
      await orient("portrait");
      const cards = await page.locator(".sheet-paper-primary .print-card").count();
      // Regression: the pill sat in a region a vendor change re-rendered, and a
      // checkout opened in that gap had no deck to name.
      await page.evaluate(() => {
        const win = window as unknown as { pillGaps: number };
        win.pillGaps = 0;
        new MutationObserver(() => {
          if (!document.querySelector(".active-deck-name")) win.pillGaps++;
        }).observe(document.querySelector(".active-press-pill")!, { childList: true, subtree: true });
      });
      await chooseVendor(page, "prodigi");
      await chooseVendor(page, "print_shop");
      if (await page.evaluate(() => (window as unknown as { pillGaps: number }).pillGaps)) throw new Error("A vendor change emptied the deck pill");
      for (const gone of ["#btn-order-print", "#btn-print-trigger", "#btn-window-print", "#btn-print-paper", "#btn-print-size", "#btn-print-grid", "#btn-print-lines", ".price-line"]) {
        if (await page.locator(gone).isVisible()) throw new Error(`Print shop shows ${gone}`);
      }
      const locked = await page.locator('.control-btn[aria-disabled="true"]:visible').evaluateAll((nodes) => nodes.map((node) => node.textContent!.replace(/\s+/g, " ").trim()));
      const expected = [
        [msg.shop_size, msg.postcard_size_a6],
        [msg.shop_mode, msg.shop_mode_reason],
        [msg.no, msg.shop_lines_reason],
      ].map((pair) => pair.join(" "));
      if (JSON.stringify(locked) !== JSON.stringify(expected)) throw new Error(`Locks read ${JSON.stringify(locked)}`);
      if ((await page.locator("#shop-order-text").innerText()).trim() !== msg.shop_order_text) throw new Error("The order text is not on screen");
      if (!await page.locator(".shop-order-hint").isVisible()) throw new Error("The lamination hint is not on screen");
      const shape = await page.locator(".postcard-trim").first().boundingBox();
      if (!shape || Math.abs(shape.width / shape.height - 105 / 148) > 0.02) throw new Error(`The preview is not A6: ${JSON.stringify(shape)}`);
      await page.screenshot({ path: `${evidence}/print-shop.png`, fullPage: true });
      asked.length = 0;
      // The dialog is the browser's; what it would print is taken as a PDF. One deck, one dialog.
      await page.evaluate(() => {
        const win = window as unknown as { prints: string[]; print: () => void };
        win.prints = [];
        win.print = () => { win.prints.push(document.title); };
      });
      await page.locator("#btn-shop-download").click();
      await page.waitForFunction(() => (window as unknown as { prints: string[] }).prints.length === 1, null, { timeout: 60000 });
      const prints: string[] = await page.evaluate(() => (window as unknown as { prints: string[] }).prints);
      if (!prints[0].startsWith("snapcards-")) throw new Error(`The saved file would be named ${prints[0]}`);
      const bytes = await page.pdf({ preferCSSPageSize: true, printBackground: true });
      await page.evaluate(() => dispatchEvent(new Event("afterprint")));
      await page.locator('#print-shop-status[data-state="ready"]').waitFor({ timeout: 15000 });
      if (await page.evaluate(() => (window as unknown as { prints: string[] }).prints.length) !== 1) throw new Error("Print shop opened more than one dialog");
      if (await page.locator("#print-checkout-panel").isVisible()) throw new Error("Print shop opened a checkout");
      if (asked.length) throw new Error(`Print shop wrote to the backend: ${asked.join(", ")}`);
      await Deno.writeFile(`${evidence}/print-shop.pdf`, bytes);
      const pdf = await PDFDocument.load(bytes);
      if (pdf.getPageCount() !== cards * 2) throw new Error(`The PDF has ${pdf.getPageCount()} pages for ${cards} cards`);
      const mm = (value: number) => value * 72 / 25.4;
      const close = (a: number, b: number) => Math.abs(a - b) < 1;
      for (const sheet of pdf.getPages()) {
        if (!close(sheet.getWidth(), mm(111)) || !close(sheet.getHeight(), mm(154))) throw new Error(`A page is ${sheet.getWidth()}×${sheet.getHeight()} pt`);
      }
      // Lying down, the preview and every page of the file turn with the reader's orientation.
      await orient("landscape");
      const lying = await page.locator(".postcard-trim").first().boundingBox();
      if (!lying || Math.abs(lying.width / lying.height - 148 / 105) > 0.02) throw new Error(`The landscape preview is not A6: ${JSON.stringify(lying)}`);
      await page.screenshot({ path: `${evidence}/print-shop-landscape.png`, fullPage: true });
      await page.evaluate(() => { (window as unknown as { prints: string[] }).prints = []; });
      await page.locator("#btn-shop-download").click();
      await page.waitForFunction(() => (window as unknown as { prints: string[] }).prints.length === 1, null, { timeout: 60000 });
      const lyingBytes = await page.pdf({ preferCSSPageSize: true, printBackground: true });
      await page.evaluate(() => dispatchEvent(new Event("afterprint")));
      await page.locator('#print-shop-status[data-state="ready"]').waitFor({ timeout: 15000 });
      await Deno.writeFile(`${evidence}/print-shop-landscape.pdf`, lyingBytes);
      const lyingPdf = await PDFDocument.load(lyingBytes);
      if (lyingPdf.getPageCount() !== cards * 2) throw new Error(`The landscape PDF has ${lyingPdf.getPageCount()} pages for ${cards} cards`);
      for (const sheet of lyingPdf.getPages()) {
        if (!close(sheet.getWidth(), mm(154)) || !close(sheet.getHeight(), mm(111))) throw new Error(`A landscape page is ${sheet.getWidth()}×${sheet.getHeight()} pt`);
      }
      await orient("portrait");
      await chooseVendor(page, "print_at_home");
    },
  },
  {
    id: "print-vendor",
    accepts: ["accept-print-vendor"],
    run: async (page, appUrl) => {
      const base = readerOrigin(appUrl);
      const live = await liveCheckout(page, base, appUrl);
      const evidence = `${APP}/docs/evidence/print-vendor`;
      // The driver's browser reads the app's default locale.
      const msg: Record<string, string> = JSON.parse(await Deno.readTextFile(`${APP}/messages/${await page.evaluate(() => document.documentElement.lang) || "pt"}.json`).catch(() => Deno.readTextFile(`${APP}/messages/pt.json`)));
      const digits = (text: string) => text.replace(/\D/g, "");
      await Deno.mkdir(evidence, { recursive: true });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${base}/print`, { waitUntil: "domcontentloaded" });
      await waitForPronto(page);
      const deck = "09440a66-ff6f-494a-39c9-60e67740a0a3";
      await page.locator(`.deck-picker-card[data-id="${deck}"]`).click();
      await page.waitForFunction((id) => document.querySelector('.print-container')?.getAttribute('data-set-id') === id, deck);
      await page.waitForFunction(() => document.querySelectorAll('.sheet-paper-primary .print-card').length >= 3);
      const cards = await page.locator(".sheet-paper-primary .print-card").count();
      const title = await selectedDeckIsNamed(page, deck);

      // Print at home: every option live, and nothing to order.
      if (await page.locator(".print-container").getAttribute("data-vendor") !== "print_at_home") throw new Error("Print at home is not the first vendor");
      if ((await page.locator(".control-box").first().locator(".control-label").textContent()) !== msg.vendor_label) throw new Error("Vendor is not the first control");
      if (await page.locator("#btn-order-print").isVisible()) throw new Error("Print at home offers an order");
      if (!await page.locator("#btn-print-trigger").isVisible()) throw new Error("Print at home lost its print button");
      await page.locator("#btn-print-paper").click();
      await page.waitForFunction(() => document.querySelector(".print-sheet-preview")?.getAttribute("data-paper") === "letter");
      await page.locator("#btn-print-paper").click();
      await page.waitForFunction(() => document.querySelector(".print-sheet-preview")?.getAttribute("data-paper") === "a4");
      await page.screenshot({ path: `${evidence}/print-at-home.png`, fullPage: true });

      // Prodigi: the others locked with their reason, stock the one choice.
      await chooseProdigi(page);
      if (await page.locator("#btn-print-trigger").isVisible()) throw new Error("Prodigi kept the print button");
      if (!await page.locator("#btn-order-print").isVisible()) throw new Error("Prodigi has no order button");
      if (await page.locator(".print-sheet-preview").isVisible()) throw new Error("Prodigi still previews sheets");
      const locked = await page.locator('.control-btn[aria-disabled="true"]:visible').evaluateAll((nodes) => nodes.map((node) => node.textContent!.replace(/\s+/g, " ").trim()));
      const expected = [
        [msg.locked_paper, msg.locked_set_by_prodigi],
        [msg.locked_orientation, msg.locked_fits_card],
        [msg.postcard_size, msg.postcard_size_metric],
        [msg.postcard_sides, msg.locked_set_by_prodigi],
        [msg.no, msg.locked_trimmed_by_prodigi],
      ].map((pair) => pair.join(" "));
      if (JSON.stringify(locked) !== JSON.stringify(expected)) throw new Error(`Locks read ${JSON.stringify(locked)}`);
      const row = () => page.locator(".print-sheet-preview").evaluate((node: HTMLElement) => JSON.stringify(node.dataset));
      const before = await row();
      for (const button of await page.locator('.control-btn[aria-disabled="true"]:visible').all()) await button.click({ force: true });
      if (await row() !== before) throw new Error("A locked control moved the configuration");
      if (await page.locator(".postcard-pair:visible").count() !== Math.min(cards, 6)) throw new Error("The preview is not per card");
      const shape = await page.locator(".postcard-trim").first().boundingBox();
      if (!shape || Math.abs(shape.width / shape.height - 152 / 102) > 0.02) throw new Error(`A postcard preview is not 152:102: ${JSON.stringify(shape)}`);
      await page.locator("#btn-print-stock").click();
      await page.waitForFunction(() => document.querySelector(".print-container")?.getAttribute("data-stock") === "mohawk");
      await page.locator("#btn-print-stock").click();
      await page.waitForFunction(() => document.querySelector(".print-container")?.getAttribute("data-stock") === "gloss");
      if (/\{msg[.[]/.test(await page.locator('[data-screen="print"]').innerText())) throw new Error("An unresolved message is on screen");
      await page.screenshot({ path: `${evidence}/prodigi.png`, fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: `${evidence}/prodigi-390.png`, fullPage: true });
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("The Prodigi screen overflows at 390 px");
      await page.setViewportSize({ width: 1280, height: 900 });

      // The address fields show attention hints; payment stays unblocked and asks
      // for confirmation on the first click when fields are incomplete.
      await page.locator("#btn-order-print").click();
      await page.locator("#print-checkout-panel").waitFor({ state: "visible" });
      await statusIs(page, "address_needed");
      if (await page.locator(".delivery-need:visible").count() !== 5) throw new Error("The five required fields are not all marked");
      const pay = page.locator("#btn-checkout-pay");
      if (await pay.isDisabled()) throw new Error("Payment was blocked with no address");
      if (await page.locator('[data-quote="total"]').innerText() !== "—") throw new Error("A total appeared before a quote");
      await page.fill("#delivery-recipient", "Marina Albuquerque");
      await page.fill("#delivery-line1", "Rua Augusta, 1508");
      await page.fill("#delivery-text", "the blue gate");
      await page.locator("#print-checkout-panel").evaluate((node) => { node.scrollTop = node.scrollHeight; });
      await page.locator("#print-checkout-panel").screenshot({ path: `${evidence}/checkout-incomplete.png` });
      if (await page.locator(".delivery-need:visible").count() !== 3) throw new Error("A completed field is still marked");
      await pay.click();
      await statusIs(page, "address_needed");

      // Brazil prints locally via Cloudprinter's A6 Wire-O spiral flip-deck and
      // Correios SEDEX: pricing varies by CEP zone and requires a valid CPF.
      const bookPages = Math.max(24, cards * 2);
      const itemUsdCents = Math.ceil((21064 + Math.max(0, bookPages - 24) * 400) / 100);
      const prTotal = Math.ceil((itemUsdCents * 180 + 1914 * 100) * 54012 / 1000000);
      const total = Math.ceil((itemUsdCents * 180 + 803 * 100) * 54012 / 1000000);
      await page.selectOption("#delivery-country", "BR");
      if (!await page.locator("#delivery-cpf").isVisible()) throw new Error("Brazil hides the CPF field");
      await page.fill("#delivery-cpf", "11111111111");
      await page.fill("#delivery-city", "Curitiba");
      await page.fill("#delivery-region", "PR");
      await page.fill("#delivery-postal", "80010-000");
      await page.waitForFunction(() => document.querySelector(".checkout-delivery")?.getAttribute("data-postal") === "80010-000");
      await pay.click();
      await statusIs(page, "address_needed");
      if (!(await page.locator("#print-checkout-status").innerText()).includes("CPF")) {
        throw new Error("Clicking pay with an invalid CPF did not name CPF as missing/invalid");
      }
      await page.fill("#delivery-cpf", "12345678909");
      await statusIs(page, "quoted");
      if (digits(await page.locator('[data-quote="total"]').innerText()) !== String(prTotal)) {
        throw new Error(`Paraná SEDEX quote did not match ${prTotal}`);
      }

      await fillPostal(page);
      if (await page.inputValue("#delivery-cpf") !== "123.456.789-09") throw new Error("CPF was not progressively formatted");
      await page.waitForFunction((want) => (document.querySelector('[data-quote="total"]') as HTMLElement | null)?.innerText.replace(/\D/g, "") === want, String(total), { timeout: 30000 });
      await statusIs(page, "quoted");
      const shown = await page.locator('[data-quote="total"]').innerText();
      if (digits(shown) !== String(total)) throw new Error(`The total reads ${shown}, not ${total}`);
      if (digits(await page.locator('[data-quote="shipping"]').innerText()) !== String(Math.ceil(803 * 54012 / 10000))) throw new Error("Shipping is not Cloudprinter's Correios SEDEX charge");
      if (await pay.isDisabled()) throw new Error("Payment stayed closed with a quote");
      await page.locator("#print-checkout-panel").screenshot({ path: `${evidence}/checkout-quoted.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator("#print-checkout-panel").screenshot({ path: `${evidence}/checkout-quoted-390.png` });
      await page.setViewportSize({ width: 1280, height: 900 });
      // Brazil prices by CEP, so an edit elsewhere keeps the price and asks nothing.
      await page.fill("#delivery-city", "Campinas");
      await page.fill("#delivery-city", "São Paulo");
      await statusIs(page, "quoted");

      // Pay through the Stripe simulator: the frozen total, then one Cloudprinter flip-deck order.
      const { order, token, session } = await live.pay();
      if (!(await live.frame.locator("main").innerText()).includes((total / 100).toFixed(2))) throw new Error("Stripe was not asked for the quoted total");
      await live.frame.locator('input[name="email"]').fill("buyer@example.test");
      await live.frame.locator('button[value="pay"]').click();
      await page.waitForFunction(() => !document.querySelector<HTMLElement>("#print-checkout-payment")?.offsetParent, null, { timeout: 30000 });
      const paid = await until("the paid order's Cloudprinter placement", async () => {
        const now = await live.order(order, token);
        return now.paymentStatus === "paid" && now.fulfillmentStatus === "sent" ? now : false;
      });
      if (paid.amount !== total) throw new Error(`The order froze ${paid.amount}, not ${total}`);
      const [placedBr, ...moreBr] = await until("the Cloudprinter order", async () => (await live.cloudprinterOrders(order)).length ? await live.cloudprinterOrders(order) : false);
      if (moreBr.length) throw new Error("Payment placed more than one Cloudprinter order");
      const madeBr = await until("Cloudprinter's file validation", async () => {
        const [current] = await live.cloudprinterOrders(order);
        return current.state_code !== "OrderRegistered" ? current : false;
      });
      if (madeBr.issues.length || madeBr.state_code !== "OrderValidated") throw new Error(`Cloudprinter refused the order: ${JSON.stringify(madeBr)}`);
      if (madeBr.items.length !== 1 || madeBr.items[0].product !== "textbook_co_a6_l_fc" || madeBr.items[0].shipping_level !== "cp_saver") {
        throw new Error(`The flip-deck item is wrong: ${JSON.stringify(madeBr.items)}`);
      }
      const coverFetched = madeBr.fetched.find((f) => f.type === "cover");
      const bookFetched = madeBr.fetched.find((f) => f.type === "book");
      if (!coverFetched || coverFetched.pages !== 2 || !bookFetched || bookFetched.pages !== bookPages) {
        throw new Error(`The flip-deck PDFs are wrong: ${JSON.stringify(madeBr.fetched)}`);
      }
      const addrBr = madeBr.addresses[0];
      if (addrBr.customer_identification !== "123.456.789-09" || addrBr.zip !== "01305-100" || addrBr.country !== "BR" || addrBr.state !== "BR-Sao Paulo Metropolitan Region and suburbs") {
        throw new Error(`The BR label is wrong: ${JSON.stringify(addrBr)}`);
      }
      await statusIs(page, "paid_sent");
      await page.locator("#print-checkout-panel").screenshot({ path: `${evidence}/receipt.png` });

      // A resent Stripe event orders nothing and mails nothing; the record names Cloudprinter and links both PDFs.
      const [completed] = await live.events(session);
      const resent = await live.control(`/_simulator/events/${completed.id}/resend`);
      if (resent.status !== 200) throw new Error(`A resent event was refused: ${JSON.stringify(resent)}`);
      await page.waitForTimeout(1500);
      const stillOneBr = await live.cloudprinterOrders(order);
      if (stillOneBr.length !== 1 || stillOneBr[0].placements !== 1) throw new Error("A resent webhook asked Cloudprinter again");
      const [record, ...extraMail] = await until("the order record", async () => (await live.mails(order)).length ? await live.mails(order) : false);
      if (extraMail.length) throw new Error("The order sent more than one mail");
      if (record.Subject !== `[TEST] Snapcards order ${order}`) throw new Error(`The record reads ${record.Subject}`);
      const recordText = await live.mailText(record.ID);
      if (!recordText.includes(`Deck: ${title}`) || !recordText.includes("Cloudprinter") || !recordText.includes("Cover file:")) {
        throw new Error(`The BR record is missing expected details: ${recordText}`);
      }
      const linked = await live.mailPdf(record.ID);
      if (linked.pages !== bookPages || Math.round(linked.size.width) !== 437 || Math.round(linked.size.height) !== 315) {
        throw new Error(`The BR record links ${JSON.stringify(linked)}`);
      }
      const buyerMails = await live.allMails(`to:buyer@example.test ${order}`);
      if (buyerMails.length !== 2) throw new Error(`Expected 2 buyer emails for ${order}, got ${buyerMails.length}`);
      const confirmMail = buyerMails.find((m) => !m.Subject.startsWith("Re: "));
      const replyMail = buyerMails.find((m) => m.Subject.startsWith("Re: "));
      if (!confirmMail || !replyMail) throw new Error(`Expected initial + Re: buyer emails, got ${JSON.stringify(buyerMails.map((m) => m.Subject))}`);
      const replyHeaders = await live.mailHeaders(replyMail.ID);
      if (!replyHeaders["In-Reply-To"]?.[0] || replyHeaders["In-Reply-To"][0] !== replyHeaders["References"]?.[0]) {
        throw new Error(`Buyer Re: email lacks same-thread headers: ${JSON.stringify(replyHeaders)}`);
      }
      if ((await page.locator("#print-checkout-collection").innerText()).trim() !== title) throw new Error("The receipt names another deck");

      // CloudSignal webhooks only make the order ask Cloudprinter; a forged signal cannot fake shipment.
      const forgedBr = await page.request.post(`${live.api}/signal/cloudprinter`, { data: { type: "CloudprinterItemShipped", order_reference: order } });
      if (!forgedBr.ok()) throw new Error(`A CloudSignal got ${forgedBr.status()}`);
      await until("the forged CloudSignal's read", async () => (await live.order(order, token)).status === "placed_br");
      if ((await live.order(order, token)).vendorStatus === "shipped") throw new Error("A forged CloudSignal moved the order");
      await live.cloudprinterControl(`/_simulator/orders/${placedBr.reference}/shipped`);
      await until("the BR shipped status", async () => (await live.order(order, token)).vendorStatus === "shipped");
      await statusIs(page, "paid_shipped");
      await page.locator('#print-order-tracking[data-stage="shipped"]').waitFor({ state: "visible" });
      if (!(await page.locator("#print-tracking-code").innerText()).trim()) throw new Error("Missing tracking code on BR receipt");
      if (!(await page.locator("#btn-tracking-url").getAttribute("href"))?.startsWith("https://")) throw new Error("Missing tracking URL on BR receipt");
      const shippedMails = await until("the 3rd threaded shipment mail", async () => {
        const all = await live.allMails(`to:buyer@example.test ${order}`);
        return all.length === 3 ? all : false;
      });
      const replies = shippedMails.filter((m) => m.Subject.startsWith("Re: "));
      if (replies.length !== 2) throw new Error(`Expected 2 Re: replies in buyer thread, got ${JSON.stringify(shippedMails.map((m) => m.Subject))}`);
      for (const reply of replies) {
        const hdrs = await live.mailHeaders(reply.ID);
        if (!hdrs["In-Reply-To"]?.[0] || hdrs["In-Reply-To"][0] !== replyHeaders["In-Reply-To"][0]) {
          throw new Error(`Shipment mail broke thread headers: ${JSON.stringify(hdrs)}`);
        }
      }
      const lastBrEvent = (await live.cloudprinterEvents()).at(-1)!;
      await live.cloudprinterControl(`/_simulator/events/${lastBrEvent.id}/resend`);
      await page.waitForTimeout(1000);
      if ((await live.mails(order)).length !== 1) throw new Error("A status update sent operator mail");
      if ((await live.allMails(`to:buyer@example.test ${order}`)).length !== 3) throw new Error("A resent CloudSignal sent duplicate shipment mail");

      // Cross-device tracking link works in a clean session without exposing PII.
      const guestCtx = await page.context().browser()!.newContext();
      try {
        const guestPage = await guestCtx.newPage();
        await guestPage.goto(`${base}/print?order=${order}`, { waitUntil: "domcontentloaded" });
        await waitForPronto(guestPage);
        await guestPage.locator('#print-order-tracking[data-stage="shipped"]').waitFor({ state: "visible", timeout: 20000 });
        const guestPanelText = await guestPage.locator("#print-checkout-panel").innerText();
        if (guestPanelText.includes("123.456.789-09") || guestPanelText.includes("Rua Augusta")) {
          throw new Error(`Public tracking leaked PII: ${guestPanelText}`);
        }
      } finally {
        await guestCtx.close();
      }

      // A paid BR order (>12 cards = 40 pages) prices the >24-page surcharge, builds a 40-page
      // book PDF, and when Cloudprinter refuses it, alerts the operator and tells the buyer not to pay again.
      const largeDeck = "69618be6-9206-f9c7-59eb-b5e4b072cf3d";
      await page.goto(`${base}/print`, { waitUntil: "domcontentloaded" });
      await waitForPronto(page);
      await page.locator(`.deck-picker-card[data-id="${largeDeck}"]`).click();
      await page.waitForFunction((id) => document.querySelector('.print-container')?.getAttribute('data-set-id') === id, largeDeck);
      const largeCards = 20;
      const largeItemUsdCents = Math.ceil((21064 + (largeCards * 2 - 24) * 400) / 100);
      const largeTotal = Math.ceil((largeItemUsdCents * 180 + 803 * 100) * 54012 / 1000000);
      await chooseProdigi(page);
      await page.locator("#btn-order-print").click();
      await page.locator("#print-checkout-panel").waitFor({ state: "visible" });
      await fillPostal(page);
      await statusIs(page, "quoted");
      if (digits(await page.locator('[data-quote="total"]').innerText()) !== String(largeTotal)) {
        throw new Error(`20-card BR quote did not match ${largeTotal}`);
      }
      await live.cloudprinterControl("/_simulator/fail/next/refuse");
      const failed = await live.pay();
      if (failed.order === order) throw new Error("The second order reused the first");
      await live.frame.locator('input[name="email"]').fill("buyer@example.test");
      await live.frame.locator('button[value="pay"]').click();
      await page.waitForFunction(() => !document.querySelector<HTMLElement>("#print-checkout-payment")?.offsetParent, null, { timeout: 30000 });
      await until("the refused order", async () => (await live.order(failed.order, failed.token)).fulfillmentStatus === "failed");
      if ((await live.cloudprinterOrders(failed.order)).length) throw new Error("A refused order exists at Cloudprinter");
      await statusIs(page, "paid_attention");
      if ((await page.locator("#print-checkout-status").innerText()).trim() !== msg.checkout_paid_attention_br) throw new Error("The buyer was not told not to pay again");
      await page.locator("#print-checkout-panel").screenshot({ path: `${evidence}/receipt-attention.png` });
      const [alert, ...alerts] = await until("the failure alert", async () => (await live.mails(failed.order)).length ? await live.mails(failed.order) : false);
      if (alerts.length) throw new Error("The failure sent more than one alert");
      if (alert.Subject !== `[TEST] [ALERT] Snapcards order ${failed.order}`) throw new Error(`The alert reads ${alert.Subject}`);
      if (!(await live.mailText(alert.ID)).includes("Cloudprinter")) throw new Error("The BR alert did not name Cloudprinter");
      if ((await live.mailPdf(alert.ID)).pages !== largeCards * 2) throw new Error("The alert PDF did not carry all 40 faces");

      // Outside Brazil, orders stay on Prodigi postcards with no CPF field.
      await page.goto(`${base}/print`, { waitUntil: "domcontentloaded" });
      await waitForPronto(page);
      await page.locator(`.deck-picker-card[data-id="${deck}"]`).click();
      await page.waitForFunction((id) => document.querySelector('.print-container')?.getAttribute('data-set-id') === id, deck);
      await chooseProdigi(page);
      await page.locator("#btn-order-print").click();
      await page.locator("#print-checkout-panel").waitFor({ state: "visible" });
      await page.selectOption("#delivery-country", "US");
      if (await page.locator("#delivery-cpf").isVisible()) throw new Error("Non-BR checkout shows the CPF field");
      await page.fill("#delivery-recipient", "Alex Rivera");
      await page.fill("#delivery-line1", "1600 Pennsylvania Ave NW");
      await page.fill("#delivery-line2", "Suite 100");
      await page.fill("#delivery-city", "Washington");
      await page.fill("#delivery-region", "DC");
      await page.fill("#delivery-postal", "20500");
      await statusIs(page, "quoted");
      const usPaid = await live.pay();
      await live.frame.locator('input[name="email"]').fill("us-buyer@example.test");
      await live.frame.locator('button[value="pay"]').click();
      await page.waitForFunction(() => !document.querySelector<HTMLElement>("#print-checkout-payment")?.offsetParent, null, { timeout: 30000 });
      await until("the paid US order's Prodigi placement", async () => {
        const now = await live.order(usPaid.order, usPaid.token);
        return now.paymentStatus === "paid" && now.fulfillmentStatus === "sent" ? now : false;
      });
      const [placedUs] = await until("the Prodigi order", async () => (await live.prodigiOrders(usPaid.order)).length ? await live.prodigiOrders(usPaid.order) : false);
      const madeUs = await until("Prodigi's lab measurement", async () => {
        const [current] = await live.prodigiOrders(usPaid.order);
        return ["Complete", "Error"].includes(current.status.details.downloadAssets) ? current : false;
      });
      if (madeUs.status.issues.length) throw new Error(`Prodigi's lab refused the order: ${JSON.stringify(madeUs.status.issues)}`);
      if (madeUs.items.length !== cards || madeUs.items.some((item) => item.sku !== "GLOBAL-POST-GLOS-6X4" || item.copies !== 1 || item.assets.length !== 1 || item.assets[0].printArea !== "default")) {
        throw new Error(`The Prodigi lines are wrong: ${JSON.stringify(madeUs.items.slice(0, 1))}`);
      }
      if (madeUs.fetched.length !== cards || madeUs.fetched.some((file) => file.type !== "jpeg" || file.width !== 3708 || file.height !== 1263)) {
        throw new Error(`The Prodigi files are wrong: ${JSON.stringify(madeUs.fetched)}`);
      }
      const url = new URL(madeUs.items[0].assets[0].url);
      const guessed = await page.request.get(`${live.api}/blobs/mecha-objects/${crypto.randomUUID()}.jpg`);
      if (guessed.status() !== 404) throw new Error(`A guessed artwork URL got ${guessed.status()}`);
      const real = await page.request.get(`${live.api}${url.pathname}`);
      if (!real.ok()) throw new Error(`The artwork URL got ${real.status()}`);
      const sides = await page.evaluate(async (base64) => {
        const image = new Image();
        image.src = `data:image/jpeg;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const saturated = (x: number) => {
          const { data } = context.getImageData(x, 0, canvas.width / 2, canvas.height);
          let count = 0;
          for (let at = 0; at < data.length; at += 4) if (Math.max(data[at], data[at + 1], data[at + 2]) - Math.min(data[at], data[at + 1], data[at + 2]) > 60) count++;
          return count;
        };
        return { left: saturated(0), right: saturated(canvas.width / 2) };
      }, btoa(String.fromCharCode(...new Uint8Array(await real.body()))));
      if (sides.left < 1000 || sides.right !== 0) throw new Error(`The file is not art left, word right: ${JSON.stringify(sides)}`);
      const forgedUs = await page.request.post(`${live.api}/signal/prodigi/${usPaid.order}`, { data: { id: "evt_forged", subject: placedUs.id, status: "shipped" } });
      if (!forgedUs.ok()) throw new Error(`A Prodigi signal got ${forgedUs.status()}`);
      await until("the forged Prodigi signal's read", async () => (await live.order(usPaid.order, usPaid.token)).status === "placed");
      if ((await live.order(usPaid.order, usPaid.token)).vendorStatus === "shipped") throw new Error("A forged Prodigi callback moved the order");
      await live.prodigiControl(`/_simulator/orders/${placedUs.id}/shipped`);
      await until("the US shipped status", async () => (await live.order(usPaid.order, usPaid.token)).vendorStatus === "shipped");
      await until("the 3 US buyer mails", async () => (await live.allMails(`to:us-buyer@example.test ${usPaid.order}`)).length === 3);
      if (live.stripeAsked.length) throw new Error(`The browser asked Stripe: ${live.stripeAsked.join(", ")}`);
    },
  },
  {
    id: "print-studio-layout",
    accepts: ["accept-print-layout"],
    run: async (page, base) => {
      await page.goto(`${base}/print`, { waitUntil: "domcontentloaded" });
      await waitForPronto(page);
      await page.waitForSelector(".print-sheet-preview[data-is-fold]", { timeout: 15000 });
      await page.waitForSelector(".sheet-paper-primary .print-card", { timeout: 15000 });

      const cardsCount = await page.$$eval(".sheet-paper-primary .print-card", (els) => els.length);
      if (cardsCount === 0) throw new Error("Print Studio did not render printable cards");

      // Print at home is free: the sheet and its print button, and nothing to order.
      await page.locator("#btn-print-trigger").waitFor({ state: "visible" });
      if (await page.locator("#btn-order-print").isVisible()) throw new Error("Print at home offers an order");
      if (await page.locator("a[href*='prodigi.com']").count()) {
        throw new Error("Print Studio still routes orders to the Prodigi catalogue");
      }

      // 2. Verify live deck search control filters collections
      const totalDecksBefore = await page.$$eval(".deck-picker-card:not([hidden])", (els) => els.length);
      const searchTitle = (await page.locator(".picker-card-name").first().innerText()).trim();
      if (!searchTitle) throw new Error("Print deck picker has an empty title");
      await page.fill("#deck-search-input", searchTitle);
      await waitForPronto(page);
      await page.waitForFunction(() => document.querySelectorAll(".deck-picker-card:not([hidden])").length === 1);
      const filteredDecks = await page.$$eval(".deck-picker-card:not([hidden])", (els) => els.length);
      if (filteredDecks === 0 || filteredDecks >= totalDecksBefore) {
        throw new Error(`Expected #deck-search-input to filter decks (before=${totalDecksBefore}, after=${filteredDecks})`);
      }
      await page.fill("#deck-search-input", "");
      await waitForPronto(page);
      await page.waitForTimeout(200);

      // 3. Verify Paper, Orientation, and Print Mode, whose cycle once never reached the grids the brief promises
      const paperBtn = page.locator("#btn-print-paper");
      await paperBtn.click();
      await page.waitForTimeout(400);

      const orientBtn = page.locator("#btn-print-orientation");
      await orientBtn.click();
      await page.waitForTimeout(400);
      const orientAttr = await page.locator(".print-sheet-preview").getAttribute("data-orientation");
      if (orientAttr !== "landscape") {
        throw new Error(`Expected orientation to toggle to landscape, got ${orientAttr}`);
      }

      // Toggle Print Mode from Fold -> Two-Sided Horizontal (duplex_h)
      const modeBtn = page.locator("#btn-print-grid");
      await modeBtn.click();
      await page.waitForTimeout(500);
      const layoutAttr = await page.locator(".print-sheet-preview").getAttribute("data-layout");
      if (layoutAttr !== "duplex_h") {
        throw new Error(`Expected layout to toggle from fold to duplex_h, got ${layoutAttr}`);
      }

      // Verify Mirrored Back Sheet is visible in Two-Sided mode
      const backSheetVisible = await page.locator(".sheet-paper-duplex-back").isVisible();
      if (!backSheetVisible) {
        throw new Error("Expected .sheet-paper-duplex-back mirrored word sheet to be visible in duplex_h mode");
      }

      for (const [layout, columns] of [["duplex_v", 0], ["2x2", 2], ["3x3", 3], ["fold", 0], ["duplex_h", 0]] as const) {
        await modeBtn.click();
        await page.waitForFunction((want) => document.querySelector(".print-sheet-preview")?.getAttribute("data-layout") === want, layout, { timeout: 5000 });
        if (columns === 0) continue;
        const drawn = await page.locator(".sheet-paper-primary .sheet-grid").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
        if (drawn !== columns) throw new Error(`Expected ${layout} to draw ${columns} columns, got ${drawn}`);
      }

      // 4. Verify print trigger button invokes window.print() via the hostDom hatch
      await page.evaluate(() => {
        (globalThis as any).__printCalls = 0;
        globalThis.print = () => {
          (globalThis as any).__printCalls++;
        };
      });
      await page.locator("#btn-print-trigger").click();
      await page.waitForTimeout(200);
      const printCalls = await page.evaluate(() => (globalThis as any).__printCalls ?? 0);
      if (printCalls !== 1) {
        throw new Error(`Expected #btn-print-trigger to invoke window.print() once, got ${printCalls}`);
      }

      // 5. Verify ink-saving white card backgrounds even when Dark Mode is active
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForTimeout(200);
      const cardColors = await page.evaluate(() => {
        const sheet = document.querySelector(".sheet-paper") as HTMLElement | null;
        const card = document.querySelector(".print-card") as HTMLElement | null;
        const illus = document.querySelector(".print-card-illustration") as HTMLElement | null;
        return {
          sheetBg: sheet ? getComputedStyle(sheet).backgroundColor : "",
          cardBg: card ? getComputedStyle(card).backgroundColor : "",
          illusBg: illus ? getComputedStyle(illus).backgroundColor : "",
        };
      });
      if (
        cardColors.sheetBg !== "rgb(255, 255, 255)" ||
        cardColors.cardBg !== "rgb(255, 255, 255)" ||
        cardColors.illusBg !== "rgb(255, 255, 255)"
      ) {
        throw new Error(`Printable sheet/cards must stay pure white rgb(255, 255, 255) in dark mode, got ${JSON.stringify(cardColors)}`);
      }
      await page.emulateMedia({ colorScheme: "light" });
    },
  },
];

async function main(): Promise<number> {
  const filter = Deno.env.get("CASE_FILTER");
  const cases = filter ? CASES.filter(c => c.id === filter) : CASES;
  if (cases.length === 0) throw new Error(`Unknown acceptance CASE_FILTER: ${filter}`);
  const base = await baseUrl(APP);
  console.log(`Starting Snapcards Playwright Acceptance Suite against ${base}...`);

  Deno.env.set("PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS", "1");
  const browser: Browser = await chromium.launch({
    args: ["--ignore-certificate-errors", "--no-sandbox", "--disable-setuid-sandbox", ...browserArgs()],
  });

  const errors: string[] = [];
  const readerFor = async () => {
    const context = await browser.newContext({
      locale: "pt-BR",
      viewport: { width: 1280, height: 900 },
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error" && !m.text().includes("ERR_INTERNET_DISCONNECTED")) {
        errors.push(m.text());
      }
    });
    page.on("pageerror", (err) => {
      errors.push(err.message);
    });
    return page;
  };

  let failed = 0;
  try {
    for (const c of cases) {
      const page = await readerFor();
      try {
        errors.length = 0;
        await c.run(page, base);
        if (errors.length > 0) {
          throw new Error(`Console/page errors occurred during ${c.id}: ${errors.join(" | ")}`);
        }
        console.log(`PASS  ${c.id}  [${c.accepts.join(" ")}]`);
      } catch (err) {
        failed++;
        console.log(`FAIL  ${c.id}  [${c.accepts.join(" ")}]\n      ${err instanceof Error ? err.message : err}${errors.length > 0 ? `\n      Browser errors:\n      ${errors.join("\n      ")}` : ""}`);
      } finally {
        await page.context().close();
      }
    }
  } finally {
    await browser.close();
  }

  console.log(failed === 0 ? `\nacceptance: ${cases.length}/${cases.length} PASS` : `\nacceptance: ${failed} failing`);
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) {
  Deno.exit(await main());
}
