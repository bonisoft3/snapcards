// The geocoder agent: OpenStreetMap's Nominatim search and reverse geocoding
// behind the hatch's agent seat (omnishell docs/terminal.md, "An agent is a
// question"). Props kind, q, lang; the one event, `found`, carries exactly
// kind, q, lang and p0..p4: a place each, or "" past the last. A place is its
// FIELDS joined by tabs, a row the handler splits without a parse that could
// fail, so every value the memo's columns admit is one it can read.
//
// Nominatim's usage policy (operations.osmfoundation.org/policies/nominatim)
// forbids search-as-you-type and allows at most one request a second, so a
// search or an address is asked only when the reader submits or commits it
// (the screen's search_q and address_q), a reverse one waits for the map to
// settle, and every
// request of this origin, across workers and tabs, holds one Web Lock for
// SPACING_MS. A worker started from a blob: sends no Referer, so the policy's other
// identification, an email address on each request, names the app.
//
// A classic worker script that is also a valid module (no imports, no
// top-level `this`), so Deno's module-only Worker can run it unchanged.
//
// Only the latest question is answered: a superseded one is never answered,
// which the memo allows, since its stamp is no longer the one standing.
// A failure is reported, not answered: an empty answer would be memoized as
// the truth about the question.

const API = "https://nominatim.openstreetmap.org/";
const EMAIL = "snapcards@snapcards.fun";
// A little over a second, so requests arrive at least a second apart.
const SPACING_MS = 1100;
const SETTLE_MS = { search: 0, address: 0, reverse: 500 };
const MIN_CHARS = 3;
// Half the side of the box a search near the reader prefers: about 11 km.
const NEAR_DEG = 0.1;
const MAX_RESULTS = 5;
const MAX_PLACE_CHARS = 2000;
const FIELDS = ["label", "line1", "city", "region", "postal_code", "country", "latitude", "longitude", "district"];
const LIMITS = { search: MAX_RESULTS, address: 1, reverse: 1 };

// Countries whose addresses put the number first ("1600 Pennsylvania Ave"),
// and those writing the street, a comma, then the number ("Rua Augusta, 1508").
// Everyone else writes "Hauptstraße 5".
const NUMBER_FIRST = new Set(["US", "CA", "GB", "IE", "AU", "NZ", "FR", "IN", "SG", "IL"]);
const STREET_COMMA_NUMBER = new Set(["BR", "PT", "ES", "IT", "AR", "CL", "CO", "UY", "PY", "MX"]);

let current = 0;
let stamp = "";
let timer;

const text = (o, field) => {
  const v = o[field];
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new Error(`geocoder: Nominatim field "${field}" is ${typeof v}, not a string`);
  return v;
};
const first = (o, fields) => fields.map((f) => text(o, f)).find((v) => v !== "") ?? "";

const coordinate = (raw, field) => {
  const v = Number(text(raw, field));
  if (text(raw, field) === "" || !Number.isFinite(v)) throw new Error(`geocoder: Nominatim result has no numeric "${field}"`);
  return v.toFixed(6);
};

function line1(street, number, country) {
  if (street === "" || number === "") return street;
  if (NUMBER_FIRST.has(country)) return `${number} ${street}`;
  if (STREET_COMMA_NUMBER.has(country)) return `${street}, ${number}`;
  return `${street} ${number}`;
}

// Each field clipped to what the row admits and the order accepts (commerce's
// postal limits, which are Prodigi's), so one long display_name cannot have the
// store refuse the whole list, or a quote refuse the address it fills in. The
// reader sees the clipped value in the field it filled.
const LIMIT = { label: 300, line1: 100, city: 50, region: 50, postal_code: 20, district: 100 };
const clip = (field, v) => (LIMIT[field] === undefined ? v : v.slice(0, LIMIT[field]));

// The house number the reader typed: Nominatim answers a number it holds no
// building for with the street alone, and a street with no number is no
// delivery. The number is the one written against the street's name: after its
// last word ("av lins de vasconcelos 1222", the type abbreviated) or, where the
// country writes the number first, before its first. A postcode further on is
// none, a number the name carries ("Rua 25 de Março") is part of it, and a
// place on a street the reader did not type gets none.
const HOUSE_NUMBER = /^\d{1,5}[a-z]?$/;
const tokens = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().split(/[\s,.]+/).filter((t) => t !== "");
function typedNumber(words, street, country) {
  const typed = tokens(words);
  const name = tokens(street);
  if (name.length === 0) return "";
  const first = NUMBER_FIRST.has(country);
  const at = first ? typed.indexOf(name[0]) : typed.lastIndexOf(name[name.length - 1]);
  if (at === -1) return "";
  const next = typed[first ? at - 1 : at + 1];
  return next !== undefined && HOUSE_NUMBER.test(next) ? next.toUpperCase() : "";
}

function place(raw, words) {
  if (raw === null || typeof raw !== "object") throw new Error("geocoder: Nominatim result is not an object");
  const address = raw.address ?? {};
  if (typeof address !== "object") throw new Error("geocoder: Nominatim address is not an object");
  const code = text(address, "country_code").toUpperCase();
  if (code !== "" && !/^[A-Z]{2}$/.test(code)) throw new Error(`geocoder: Nominatim country_code ${JSON.stringify(code)} is not ISO 3166-1 alpha-2`);
  // "BR-SP" names the state as the post writes it; a country without one
  // keeps the state's name.
  const subdivision = text(address, "ISO3166-2-lvl4");
  const street = first(address, ["road", "pedestrian", "footway", "square"]);
  const held = text(address, "house_number");
  return {
    label: text(raw, "display_name"),
    line1: line1(street, held !== "" || street === "" ? held : typedNumber(words, street, code), code),
    city: first(address, ["city", "town", "village", "municipality", "hamlet"]),
    region: subdivision.includes("-") ? subdivision.slice(subdivision.indexOf("-") + 1) : text(address, "state"),
    postal_code: text(address, "postcode"),
    country: code,
    latitude: coordinate(raw, "lat"),
    longitude: coordinate(raw, "lon"),
    // The bairro a Brazilian address writes under its street is OSM's suburb.
    district: first(address, ["suburb", "neighbourhood", "city_district", "quarter"]),
  };
}

// A tab or line break inside a value would read as a field or row boundary.
const cell = (v) => v.replace(/[\t\r\n]+/g, " ");
function row(place) {
  const text = FIELDS.map((f) => clip(f, cell(place[f]))).join("\t");
  if (text.length > MAX_PLACE_CHARS) throw new Error(`geocoder: a place is ${text.length} characters, over ${MAX_PLACE_CHARS}`);
  return text;
}
function answer(question, places) {
  const detail = { kind: question.kind, q: question.q, lang: question.lang };
  for (let i = 0; i < MAX_RESULTS; i++) detail[`p${i}`] = i < places.length ? row(places[i]) : "";
  postMessage({ type: "pronto:event", name: "found", detail });
}

function endpoint(question) {
  const params = new URLSearchParams({ format: "jsonv2", addressdetails: "1", "accept-language": question.lang, email: EMAIL });
  if (question.kind === "reverse") {
    const parts = question.q.split(",");
    const [lat, lon] = parts.map((s) => Number(s.trim()));
    if (parts.length !== 2 || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) {
      throw new Error(`geocoder: reverse q ${JSON.stringify(question.q)} is not "lat,lon"`);
    }
    params.set("lat", String(lat));
    params.set("lon", String(lon));
    params.set("zoom", "18");
    return `${API}reverse?${params}`;
  }
  // A search the reader asks with their position on carries it after a tab:
  // Nominatim then prefers places in a box around it, and still answers
  // places outside it (bounded=0).
  const [words, near] = question.q.split("\t");
  if (near !== undefined) {
    const parts = near.split(",");
    const [lat, lon] = parts.map((s) => Number(s.trim()));
    if (parts.length !== 2 || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) {
      throw new Error(`geocoder: search q ${JSON.stringify(question.q)} carries no "lat,lon" after its tab`);
    }
    params.set("viewbox", [lon - NEAR_DEG, lat + NEAR_DEG, lon + NEAR_DEG, lat - NEAR_DEG].map((n) => n.toFixed(6)).join(","));
    params.set("bounded", "0");
  }
  params.set("q", words.trim());
  params.set("limit", String(LIMITS[question.kind]));
  return `${API}search?${params}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function ask(question, id) {
  // Held for SPACING_MS from the request, so this origin asks at most once a
  // second however many workers or tabs ask with it.
  const body = await navigator.locks.request("nominatim", async () => {
    if (id !== current) return null;
    const started = Date.now();
    const response = await fetch(endpoint(question));
    if (!response.ok) throw new Error(`geocoder: Nominatim ${question.kind === "reverse" ? "reverse" : "search"} answered HTTP ${response.status}`);
    const parsed = await response.json();
    await sleep(SPACING_MS - (Date.now() - started));
    return parsed;
  });
  if (body === null || id !== current) return;
  // A reverse lookup over open water answers {error}: a place nobody named.
  const results = question.kind === "reverse" ? (body.error === undefined ? [body] : []) : body;
  if (!Array.isArray(results)) throw new Error("geocoder: Nominatim search did not answer a list");
  // A reverse question's words are coordinates, which name no house.
  const words = question.kind === "reverse" ? "" : question.q.split("\t")[0];
  answer(question, results.slice(0, LIMITS[question.kind]).map((raw) => place(raw, words)));
}

// The memo withdraws a question by emptying a key field; props are
// re-delivered, possibly identical, so a repeat of the standing question is
// silence.
function onProps(props) {
  const { kind = "", q = "", lang = "" } = props;
  const next = JSON.stringify([kind, q, lang]);
  if (next === stamp) return;
  stamp = next;
  const id = ++current;
  clearTimeout(timer);
  if (kind === "" || q === "" || lang === "") return;
  if (!Object.hasOwn(LIMITS, kind)) throw new Error(`geocoder: kind ${JSON.stringify(kind)} is not search, address or reverse`);
  const question = { kind, q, lang };
  // Too short to search is answered without asking anyone.
  if (kind !== "reverse" && q.split("\t")[0].trim().length < MIN_CHARS) {
    answer(question, []);
    return;
  }
  timer = setTimeout(() => ask(question, id).catch(reportError), SETTLE_MS[kind]);
}

addEventListener("message", (e) => {
  if (e.data?.type === "pronto:props") onProps(e.data.props);
});
postMessage({ type: "pronto:ready" });
