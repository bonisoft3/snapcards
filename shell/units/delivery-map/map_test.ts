import { strict as assert } from "node:assert";
import { type Browser, type BrowserContext, chromium, type Frame, type Page } from "playwright";

const UNIT = import.meta.dirname!;
const TYPES: Record<string, string> = {
  html: "text/html",
  js: "text/javascript",
  css: "text/css",
};

// The seat's mount (plugins/omnishell/interpreter/hatch.js mountFrameUnit):
// same sandbox, same grant, and a listener that admits only this frame.
const PARENT = `<!doctype html><html><body style="margin:0;width:420px">
<div id="slot"></div>
<script>
const frame = document.createElement("iframe");
frame.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
frame.setAttribute("allow", "geolocation");
frame.setAttribute("src", "/unit/index.html");
frame.style.border = "0";
frame.style.width = "100%";
document.getElementById("slot").append(frame);
window.received = [];
let ready = false;
let latest = {};
addEventListener("message", (e) => {
  if (e.source !== frame.contentWindow || e.source == null || e.origin !== "null") return;
  const m = e.data;
  if (m.type === "pronto:ready") { ready = true; window.received.push({ kind: "ready" }); deliver(); return; }
  if (m.type !== "pronto:event") return;
  if (m.name === "height") {
    window.received.push({ kind: "height", height: m.height });
    if (m.height > 0) frame.style.height = Math.round(m.height) + "px";
    return;
  }
  window.received.push({ kind: "event", name: m.name, detail: m.detail });
});
const deliver = () => { if (ready) frame.contentWindow.postMessage({ type: "pronto:props", props: latest }, "*"); };
window.update = (props) => { latest = props; deliver(); };
</script></body></html>`;

const LABELS = {
  locate: "Use my location",
  locating: "Finding you…",
  denied: "Location is off for this site. Type the address instead.",
  unavailable: "We could not find your location. Type the address instead.",
  hint: "The pin is only a hint for the courier.",
  adjust: "Adjust pin",
  done: "Done",
};
const HOME = { latitude: -23.557, longitude: -46.661 };
const COORD = /^-?\d{1,3}\.\d{6}$/;

type Received =
  | { kind: "ready" }
  | { kind: "height"; height: number }
  | { kind: "event"; name: string; detail: Record<string, unknown> };

function serve() {
  return Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response(PARENT, { headers: { "content-type": "text/html" } });
    const match = /^\/unit\/((?:vendor\/)?[\w.-]+)$/.exec(path);
    if (!match) return new Response("not found", { status: 404 });
    const file = await Deno.readFile(`${UNIT}/${match[1]}`).catch((err) => {
      if (err instanceof Deno.errors.NotFound) return undefined;
      throw err;
    });
    if (file === undefined) return new Response("not found", { status: 404 });
    return new Response(file, { headers: { "content-type": TYPES[match[1].split(".").pop()!] ?? "application/octet-stream" } });
  });
}

const received = (page: Page) => page.evaluate(() => (globalThis as unknown as { received: Received[] }).received);
const events = async (page: Page) =>
  (await received(page)).filter((r): r is Extract<Received, { kind: "event" }> => r.kind === "event");

async function waitForEvents(page: Page, count: number) {
  await page.waitForFunction(
    (n) => (globalThis as unknown as { received: Received[] }).received.filter((r) => r.kind === "event").length >= n,
    count,
  );
  return events(page);
}

function assertPin(detail: Record<string, unknown>, source: string) {
  assert.deepEqual(Object.keys(detail).sort(), ["latitude", "longitude", "source"]);
  for (const v of Object.values(detail)) assert.equal(typeof v, "string");
  assert.match(detail.latitude as string, COORD);
  assert.match(detail.longitude as string, COORD);
  assert.equal(detail.source, source);
}

async function open(browser: Browser, origin: string, grant: boolean) {
  const context = await browser.newContext({ viewport: { width: 420, height: 600 } });
  // Permission delegation: a sandboxed frame's geolocation is the embedder's.
  if (grant) await context.grantPermissions(["geolocation"], { origin });
  await context.setGeolocation(HOME);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  await page.waitForFunction(() => (globalThis as unknown as { received: Received[] }).received.some((r) => r.kind === "ready"));
  const frame = page.frames().find((f) => f.url().endsWith("/unit/index.html"))!;
  return { context, page, frame, errors };
}

const update = (page: Page, props: Record<string, string>) =>
  page.evaluate((p) => (globalThis as unknown as { update(p: unknown): void }).update(p), props);

// No debug channel in the unit: the test reads the map through the frame's
// own global, which only a devtools-protocol client can reach.
async function inFrame(frame: Frame, expression: string) {
  const deadline = Date.now() + 30000;
  while (!(await frame.evaluate(expression))) {
    if (Date.now() > deadline) throw new Error(`frame never satisfied: ${expression}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// No debug channel in the unit: the test reads the map through the frame's
// own global, which only a devtools-protocol client can reach.
const mapIdle = (frame: Frame) => inFrame(frame, "typeof map !== 'undefined' && map.loaded() && map.areTilesLoaded()");

async function quiet(page: Page, before: number) {
  await page.waitForTimeout(800);
  assert.equal((await events(page)).length, before, "re-delivered props must post nothing");
}

Deno.test("delivery-map realm unit speaks the seat's wire", async (t) => {
  const server = serve();
  const origin = `http://127.0.0.1:${server.addr.port}/`;
  const browser = await chromium.launch({ headless: true });
  try {
    await t.step("locate: a toggle that posts a gps pin, reads as on while the position is kept on, and posts an empty pin to turn off", async () => {
      const { context, page, frame, errors } = await open(browser, origin, true);
      const props = { mode: "locate", latitude: "", longitude: "", near: "", ...LABELS };
      await update(page, props);
      const toggle = frame.getByRole("button", { name: LABELS.locate });
      await toggle.waitFor();
      await page.waitForFunction(() =>
        (globalThis as unknown as { received: Received[] }).received.some((r) => r.kind === "height" && r.height > 0)
      );
      await quiet(page, 0);
      assert.equal(await toggle.getAttribute("aria-pressed"), "false");
      await toggle.click();
      const [pin] = await waitForEvents(page, 1);
      assert.equal(pin.name, "pin");
      assertPin(pin.detail, "gps");
      assert.deepEqual(pin.detail, { latitude: "-23.557000", longitude: "-46.661000", source: "gps" });
      await update(page, { ...props });
      await quiet(page, 1);
      // Regression: a second press asked the browser again, and a refused
      // second fix stuck the reader on its message.
      await update(page, { ...props, near: "-23.557000,-46.661000" });
      await inFrame(frame, `document.getElementById("locate").getAttribute("aria-pressed") === "true"`);
      await toggle.click();
      const [, off] = await waitForEvents(page, 2);
      assert.deepEqual(off.detail, { latitude: "", longitude: "", source: "" });
      assert.deepEqual(errors, []);
      await context.close();
    });

    // The seat declares only `pin`: a refusal is the unit's to say, as the
    // toggle's name and colour, the only room an icon has.
    await t.step("locate: denied permission names the toggle with the message and posts nothing", async () => {
      const { context, page, frame, errors } = await open(browser, origin, false);
      await update(page, { mode: "locate", latitude: "", longitude: "", near: "", ...LABELS });
      await frame.getByRole("button", { name: LABELS.locate }).click();
      await frame.getByRole("button", { name: LABELS.denied }).waitFor();
      assert.equal(await frame.locator("#locate").getAttribute("data-failed"), "");
      await quiet(page, 0);
      assert.deepEqual(errors, []);
      await context.close();
    });

    await t.step("map: a still preview until adjusting; a dropped pin posts a map pin, the camera and its echo post nothing", async () => {
      const { context, page, frame, errors } = await open(browser, origin, true);
      await update(page, { mode: "map", latitude: "", longitude: "", ...LABELS });
      await page.waitForTimeout(300);
      assert.equal(await frame.locator("#map").isVisible(), false);
      const props = { mode: "map", latitude: "-23.557000", longitude: "-46.661000", ...LABELS };
      await update(page, props);
      await mapIdle(frame);
      await frame.getByText(/OpenFreeMap/).waitFor({ state: "attached" });
      await frame.getByText(/OpenStreetMap/).waitFor({ state: "attached" });
      const heights = async () => (await received(page)).filter((r) => r.kind === "height").map((r) => (r as { height: number }).height);
      const preview = (await heights()).pop()!;
      assert.ok(preview > 130 && preview < 200, `preview height ${preview}`);
      await update(page, { ...props });
      await quiet(page, 0);

      // The preview holds still: neither a wheel nor a drag moves its camera
      // or its pin, and it has no zoom buttons to press.
      const box = (await page.locator("iframe").boundingBox())!;
      const still = await frame.evaluate(`JSON.stringify([map.getCenter(), map.getZoom()])`);
      await page.mouse.move(box.x + box.width / 2, box.y + 40);
      await page.mouse.wheel(0, 400);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width / 2 + 8 * i, box.y + 40 + 4 * i);
      await page.mouse.up();
      await page.waitForTimeout(500);
      assert.equal(await frame.evaluate(`JSON.stringify([map.getCenter(), map.getZoom()])`), still);
      assert.equal(await frame.locator("#zoom-in").isVisible(), false);
      await quiet(page, 0);

      await frame.getByRole("button", { name: LABELS.adjust }).click();
      await page.waitForFunction(() =>
        (globalThis as unknown as { received: Received[] }).received.some((r) => r.kind === "height" && r.height > 300)
      );
      await mapIdle(frame);

      // Regression: the pin was the map's centre, so a zoom about the cursor or
      // a pan moved it. Looking around the map now moves no pin.
      const tall = (await page.locator("iframe").boundingBox())!;
      const x = tall.x + tall.width / 4;
      const y = tall.y + 60;
      await page.mouse.move(x, y);
      await page.mouse.wheel(0, 400);
      await mapIdle(frame);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(x + 8 * i, y + 4 * i);
      await page.mouse.up();
      await mapIdle(frame);
      await quiet(page, 0);
      assert.ok(await frame.evaluate(`Math.abs(marker.getLngLat().lat + 23.557) < 1e-6`), "looking around moved the pin");

      // Taken by its foot and dropped elsewhere, the pin is the reader's.
      const foot = (await frame.locator(".pin").boundingBox())!;
      await page.mouse.move(foot.x + foot.width / 2, foot.y + foot.height - 6);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(foot.x + foot.width / 2 - 6 * i, foot.y + foot.height - 6 - 3 * i);
      await page.mouse.up();
      const [pin] = await waitForEvents(page, 1);
      assert.equal(pin.name, "pin");
      assertPin(pin.detail, "map");
      assert.notEqual(pin.detail.longitude, props.longitude);
      assert.notEqual(pin.detail.latitude, props.latitude);

      // The seat may re-deliver the old place before it echoes the drop.
      await update(page, { ...props });
      await quiet(page, 1);
      assert.ok(await frame.evaluate(`Math.abs(marker.getLngLat().lat - (${pin.detail.latitude})) < 1e-5`), "a stale re-delivery undid the drop");

      const echoed = { ...props, latitude: pin.detail.latitude as string, longitude: pin.detail.longitude as string };
      await update(page, echoed);
      await quiet(page, 1);

      // A place the props move to is followed silently, into view.
      await update(page, { ...props, latitude: "-22.906800", longitude: "-43.172900" });
      await inFrame(frame, "Math.abs(marker.getLngLat().lat + 22.9068) < 1e-5 && map.getBounds().contains(marker.getLngLat())");
      await quiet(page, 1);

      // Done folds the map back to a preview framing the pin, and posts nothing.
      await frame.getByRole("button", { name: LABELS.done }).click();
      await inFrame(frame, `!document.getElementById("map").hasAttribute("data-editing") && Math.abs(map.getCenter().lat + 22.9068) < 1e-5`);
      await quiet(page, 1);
      assert.deepEqual(errors, []);
      await context.close();
    });
  } finally {
    await browser.close();
    await server.shutdown();
  }
});
