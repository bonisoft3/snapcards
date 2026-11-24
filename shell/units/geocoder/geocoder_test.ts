// The geocoder unit, run unchanged in a real worker against a local fake of
// Nominatim. The unit names the real host; a test-only module worker reroutes
// that host at fetch before importing it, so the unit carries no seam.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.13";

const UNIT = new URL("./unit.js", import.meta.url).href;

// Shapes from Nominatim's format=jsonv2&addressdetails=1: coordinates as
// strings, the address keyed by OSM's own tags, country_code lowercase.
const AUGUSTA = {
  place_id: 11498362, licence: "Data © OpenStreetMap contributors, ODbL 1.0. http://osm.org/copyright", osm_type: "way", osm_id: 159366582,
  lat: "-23.5585014", lon: "-46.6567921", category: "building", type: "yes", place_rank: 30, importance: 0.00007, addresstype: "building",
  name: "Edifício Augusta",
  display_name: "Edifício Augusta, 1508, Rua Augusta, Consolação, São Paulo, Região Imediata de São Paulo, Região Metropolitana de São Paulo, Região Geográfica Intermediária de São Paulo, São Paulo, Região Sudeste, 01304-001, Brasil",
  address: {
    building: "Edifício Augusta", house_number: "1508", road: "Rua Augusta", suburb: "Consolação", city: "São Paulo",
    municipality: "Região Imediata de São Paulo", state: "São Paulo", "ISO3166-2-lvl4": "BR-SP", region: "Região Sudeste",
    postcode: "01304-001", country: "Brasil", country_code: "br",
  },
  boundingbox: ["-23.5586", "-23.5584", "-46.6569", "-46.6566"],
};
const WHITE_HOUSE = {
  lat: "38.897699700000004", lon: "-77.03655315", display_name: "White House, 1600, Pennsylvania Avenue Northwest, Washington, District of Columbia, 20500, United States",
  address: { tourism: "White House", house_number: "1600", road: "Pennsylvania Avenue Northwest", city: "Washington", state: "District of Columbia", "ISO3166-2-lvl4": "US-DC", postcode: "20500", country: "United States", country_code: "us" },
};
const BERLIN = {
  lat: "52.5163", lon: "13.3801", display_name: "77, Unter den Linden, Mitte, Berlin, 10117, Deutschland",
  address: { house_number: "77", road: "Unter den Linden", suburb: "Mitte", city: "Berlin", state: "Berlin", "ISO3166-2-lvl4": "DE-BE", postcode: "10117", country: "Deutschland", country_code: "de" },
};
const TOWN_ONLY = {
  lat: "-22.4121", lon: "-42.9664", display_name: "Teresópolis, Rio de Janeiro, Brasil",
  address: { town: "Teresópolis", state: "Rio de Janeiro", "ISO3166-2-lvl4": "BR-RJ", country: "Brasil", country_code: "br" },
};

type Fake = { requests: { url: URL; at: number }[]; status: number; body: unknown; close: () => Promise<void>; port: number };

function nominatim(): Fake {
  const fake: Fake = { requests: [], status: 200, body: [], close: async () => {}, port: 0 };
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    fake.requests.push({ url: new URL(req.url), at: Date.now() });
    return Response.json(fake.body, { status: fake.status });
  });
  fake.port = server.addr.port;
  fake.close = () => server.shutdown();
  return fake;
}

type Message = { type: string; name?: string; detail?: Record<string, string> };

function unit(fake: Fake) {
  const wrapper = `
    const real = globalThis.fetch;
    globalThis.fetch = (url, init) => real(String(url).replace("https://nominatim.openstreetmap.org/", "http://127.0.0.1:${fake.port}/"), init);
    await import(${JSON.stringify(UNIT)});`;
  const worker = new Worker(URL.createObjectURL(new Blob([wrapper], { type: "application/javascript" })), { type: "module" });
  const messages: Message[] = [];
  const errors: string[] = [];
  let wake = () => {};
  worker.onmessage = (e) => {
    messages.push(e.data);
    wake();
  };
  worker.onerror = (e) => {
    e.preventDefault();
    errors.push(e.message);
    wake();
  };
  const until = (done: () => boolean, ms = 5000) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out; messages ${JSON.stringify(messages)} errors ${JSON.stringify(errors)}`)), ms);
      const check = () => {
        if (done()) {
          clearTimeout(t);
          resolve();
        }
      };
      wake = check;
      check();
    });
  const found = () => messages.filter((m) => m.type === "pronto:event");
  return {
    errors,
    found,
    until,
    ready: () => until(() => messages.some((m) => m.type === "pronto:ready")),
    ask: (props: Record<string, string>) => worker.postMessage({ type: "pronto:props", props }),
    close: () => worker.terminate(),
  };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withUnit(fn: (u: ReturnType<typeof unit>, fake: Fake) => Promise<void>) {
  const fake = nominatim();
  const u = unit(fake);
  try {
    await u.ready();
    await fn(u, fake);
  } finally {
    u.close();
    await fake.close();
  }
}

const FIELDS = ["label", "line1", "city", "region", "postal_code", "country", "latitude", "longitude", "district"];
// The answer's p0..p4, each a tab-joined place, read back as records.
const places = (detail: Record<string, string>) =>
  [0, 1, 2, 3, 4].map((i) => detail[`p${i}`]).filter((p) => p !== "").map((p) => Object.fromEntries(p.split("\t").map((v, k) => [FIELDS[k], v])));

Deno.test("a query under three characters answers with no place at once and asks nobody", () =>
  withUnit(async (u, fake) => {
    u.ask({ kind: "search", q: " ab ", lang: "pt" });
    await u.until(() => u.found().length === 1);
    assertEquals(u.found()[0], { type: "pronto:event", name: "found", detail: { kind: "search", q: " ab ", lang: "pt", p0: "", p1: "", p2: "", p3: "", p4: "" } });
    await settle(300);
    assertEquals(fake.requests.length, 0);
  }));

Deno.test("a submitted search maps Nominatim's places in the locale's street order, accents and CEP intact", () =>
  withUnit(async (u, fake) => {
    fake.body = [AUGUSTA, WHITE_HOUSE, BERLIN, TOWN_ONLY, AUGUSTA, AUGUSTA];
    u.ask({ kind: "search", q: " rua augusta 1508 ", lang: "pt" });
    await u.until(() => u.found().length === 1);
    const { url } = fake.requests[0];
    assertEquals(url.pathname, "/search");
    assertEquals(Object.fromEntries(url.searchParams), { format: "jsonv2", addressdetails: "1", "accept-language": "pt", email: "snapcards@snapcards.fun", q: "rua augusta 1508", limit: "5" });
    const detail = u.found()[0].detail!;
    assertEquals(Object.keys(detail).sort(), ["kind", "lang", "p0", "p1", "p2", "p3", "p4", "q"]);
    const got = places(detail);
    assertEquals(got.length, 5);
    assertEquals(got[0], {
      label: AUGUSTA.display_name, line1: "Rua Augusta, 1508", city: "São Paulo", region: "SP",
      postal_code: "01304-001", country: "BR", latitude: "-23.558501", longitude: "-46.656792", district: "Consolação",
    });
    assertEquals([got[1].line1, got[1].region, got[1].latitude, got[1].district], ["1600 Pennsylvania Avenue Northwest", "DC", "38.897700", ""]);
    assertEquals([got[2].line1, got[2].region, got[2].district], ["Unter den Linden 77", "BE", "Mitte"]);
    assertEquals([got[3].line1, got[3].city, got[3].postal_code], ["", "Teresópolis", ""]);
  }));

Deno.test("only the latest question is answered, and this origin asks Nominatim at most once a second", () =>
  withUnit(async (u, fake) => {
    fake.body = [AUGUSTA];
    u.ask({ kind: "search", q: "rua augusta", lang: "pt" });
    await u.until(() => u.found().length === 1);
    u.ask({ kind: "search", q: "rua augusta 1", lang: "pt" });
    u.ask({ kind: "search", q: "rua augusta 1508", lang: "pt" });
    await u.until(() => u.found().length === 2);
    await settle(1200);
    assertEquals(u.found().map((m) => m.detail!.q), ["rua augusta", "rua augusta 1508"]);
    assertEquals(fake.requests.map((r) => r.url.searchParams.get("q")), ["rua augusta", "rua augusta 1508"]);
    assert(fake.requests[1].at - fake.requests[0].at >= 1000, `spaced by ${fake.requests[1].at - fake.requests[0].at} ms`);
  }));

Deno.test("a committed address asks for one place", () =>
  withUnit(async (u, fake) => {
    fake.body = [AUGUSTA];
    u.ask({ kind: "address", q: "Rua Augusta, 1508 01304-001 São Paulo SP BR", lang: "pt" });
    await u.until(() => u.found().length === 1);
    assertEquals(fake.requests[0].url.searchParams.get("limit"), "1");
    assertEquals(places(u.found()[0].detail!)[0].line1, "Rua Augusta, 1508");
  }));

// Seen live: Nominatim answers "avenida lins de vasconcelos 1222" with the
// avenue alone, and the reader had no way to keep their number but to retype it.
Deno.test("a street answered without the number the reader typed carries it, in the locale's order", () =>
  withUnit(async (u, fake) => {
    const street = (road: string, code: string, extra = {}) => ({
      lat: "-23.58", lon: "-46.63", display_name: road,
      address: { road, city: "São Paulo", "ISO3166-2-lvl4": "BR-SP", postcode: "01526-000", country_code: code, ...extra },
    });
    fake.body = [street("Avenida Lins de Vasconcelos", "br"), street("Rua 25 de Março", "br"), street("Rua Augusta", "br", { house_number: "1508" })];
    u.ask({ kind: "search", q: "av lins de vasconcelos 1222, 01526-000\t-23.5,-46.6", lang: "pt" });
    await u.until(() => u.found().length === 1);
    assertEquals(places(u.found()[0].detail!).map((p) => p.line1), [
      // The street's type abbreviated, its number after its name.
      "Avenida Lins de Vasconcelos, 1222",
      // Another street, which the reader did not type, gets no number of theirs.
      "Rua 25 de Março",
      // A number Nominatim holds is the building's, and stays.
      "Rua Augusta, 1508",
    ]);
    const asked = async (q: string, road: string, code: string) => {
      fake.body = [street(road, code)];
      const before = u.found().length;
      u.ask({ kind: "search", q, lang: "pt" });
      await u.until(() => u.found().length === before + 1);
      return places(u.found()[before].detail!)[0].line1;
    };
    // A number the street's own name carries is no house number.
    assertEquals(await asked("rua 25 de março", "Rua 25 de Março", "br"), "Rua 25 de Março");
    assertEquals(await asked("rua 25 de março 300", "Rua 25 de Março", "br"), "Rua 25 de Março, 300");
    // Regression: the last number typed was taken, which a postcode after the
    // house number is (Germany, Spain: five digits).
    assertEquals(await asked("Hauptstraße 5, 10115 Berlin", "Hauptstraße", "de"), "Hauptstraße 5");
    // Where the number comes first, it is the one before the street's name.
    assertEquals(await asked("1600 pennsylvania ave nw 20500", "Pennsylvania Avenue Northwest", "us"), "1600 Pennsylvania Avenue Northwest");
  }));

Deno.test("a search near the reader prefers a box around them, still answering places outside it", () =>
  withUnit(async (u, fake) => {
    fake.body = [AUGUSTA];
    const q = "Rua Augusta, São Paulo\t-23.558501,-46.656792";
    u.ask({ kind: "search", q, lang: "pt" });
    await u.until(() => u.found().length === 1);
    const asked = fake.requests[0].url.searchParams;
    assertEquals(asked.get("q"), "Rua Augusta, São Paulo");
    assertEquals(asked.get("viewbox"), "-46.756792,-23.458501,-46.556792,-23.658501");
    assertEquals(asked.get("bounded"), "0");
    // The answer names the question as asked, position included, which the draft holds.
    assertEquals(u.found()[0].detail!.q, q);
  }));

Deno.test("reverse looks the pin up, and open water is a place nobody named", () =>
  withUnit(async (u, fake) => {
    fake.body = AUGUSTA;
    u.ask({ kind: "reverse", q: "-23.558501,-46.656792", lang: "pt" });
    await u.until(() => u.found().length === 1);
    assertEquals(Object.fromEntries(fake.requests[0].url.searchParams), { format: "jsonv2", addressdetails: "1", "accept-language": "pt", email: "snapcards@snapcards.fun", lat: "-23.558501", lon: "-46.656792", zoom: "18" });
    assertEquals(places(u.found()[0].detail!)[0].postal_code, "01304-001");
    fake.body = { error: "Unable to geocode" };
    u.ask({ kind: "reverse", q: "-30,-30", lang: "pt" });
    await u.until(() => u.found().length === 2);
    assertEquals(places(u.found()[1].detail!), []);
  }));

// Each failure in a worker of its own: Deno ends a worker at its first
// uncaught error, where a browser's keeps running.
Deno.test("a refusal is the worker's error, never an empty answer", () =>
  withUnit(async (u, fake) => {
    fake.status = 429;
    u.ask({ kind: "search", q: "rua augusta", lang: "pt" });
    await u.until(() => u.errors.length === 1);
    assertStringIncludes(u.errors[0], "HTTP 429");
    assertEquals(u.found(), []);
  }));

Deno.test("a search answered with anything but a list is the worker's error", () =>
  withUnit(async (u, fake) => {
    fake.body = { not: "a list" };
    u.ask({ kind: "search", q: "rua augusta", lang: "pt" });
    await u.until(() => u.errors.length === 1);
    assertStringIncludes(u.errors[0], "did not answer a list");
    assertEquals(u.found(), []);
  }));

// Regression: a display_name past the place_suggestion row's 300 characters
// had the store refuse the whole list it rode in.
Deno.test("each field is clipped to what the suggestion row admits", () =>
  withUnit(async (u, fake) => {
    fake.body = [{ ...AUGUSTA, display_name: "x".repeat(400), address: { ...AUGUSTA.address, postcode: "9".repeat(60) } }];
    u.ask({ kind: "search", q: "rua augusta", lang: "pt" });
    await u.until(() => u.found().length === 1);
    const [got] = places(u.found()[0].detail!);
    assertEquals([got.label.length, got.postal_code.length], [300, 20]);
  }));

Deno.test("a place fits what the order accepts, and every request identifies the app", () =>
  withUnit(async (u, fake) => {
    fake.body = [{
      ...AUGUSTA,
      address: {
        ...AUGUSTA.address,
        road: "r".repeat(150),
        city: "c".repeat(80),
        postcode: "9".repeat(30),
        "ISO3166-2-lvl4": undefined,
        state: "s".repeat(80),
      },
    }];
    u.ask({ kind: "search", q: "long place", lang: "pt" });
    await u.until(() => u.found().length === 1);
    const [got] = places(u.found()[0].detail!);
    assertEquals([got.line1.length, got.city.length, got.region.length, got.postal_code.length], [100, 50, 50, 20]);
    assertEquals(fake.requests[0].url.searchParams.get("email"), "snapcards@snapcards.fun");
  }));
