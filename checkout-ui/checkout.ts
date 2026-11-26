export { currencyScale } from "../commerce/money.ts";
import { currencyScale } from "../commerce/money.ts";
import { brazilStateForCep, formatBrazilCpf, validBrazilCpf } from "../commerce/catalogue.ts";

import { AsYouType, type CountryCode, getCountries, getCountryCallingCode } from "libphonenumber-js";
import phoneMetadata from "libphonenumber-js/min/metadata";
import { known, postalProblem, required, rows, type Token } from "./address-format.ts";
import {
  freezePrint,
  type FrozenPrint,
  illustrationOf,
  illustrationsArrived,
  printShopDeck,
} from "./artwork.ts";

export interface DeliveryAddress {
  version: 1;
  text: string;
  pin:
    | { latitude: number; longitude: number; source: "gps" | "search" | "map" }
    | null;
  address: {
    recipient: string;
    taxId?: string;
    line1: string;
    line2: string;
    // The bairro or district, where the country's post writes one.
    district: string;
    city: string;
    region: string;
    postalCode: string;
    country: string;
  };
  // Either may be "": Prodigi's courier calls the phone, and Checkout prefills the e-mail.
  contact: { phone: string; email: string };
  instructions: string;
  acceptedSuggestions: {
    source: "search" | "pin" | "autofill";
    label: string;
  }[];
}
// 16 MiB across a deck, about 60 cards of the seeded art; each file is a claim and
// a PUT, so the bound protects a reader's upload and the plane's storage.
const MAX_ARTWORK_BYTES = 16 * 1024 * 1024;
// The machine answers a browser through the row: long enough for a slow provider
// and its retries.
const SETTLE_MS = 60_000;
type Mode = "live" | "mock";
type Review = {
  title: string;
  layout: string;
  images: string[];
  cards: number;
  stock: string;
};
type Quote = {
  id?: string;
  item: number;
  shipping: number;
  total: number;
  currency: string;
};
type Row = {
  id: string;
  status: string;
  title: string;
  stock: string;
  cards: number;
  country?: string;
  postal_code?: string;
  artwork?: string[] | null;
  delivery: DeliveryAddress | null;
  item: number | null;
  shipping: number | null;
  total: number | null;
  currency: string | null;
  checkout_url: string | null;
  checks: number;
  payment_state: string | null;
  vendor_order_id?: string | null;
  vendor_state: string | null;
  tracking_carrier?: string | null;
  tracking_number?: string | null;
  tracking_url?: string | null;
  paid_at?: string | null;
  shipped_at?: string | null;
  destination?: string | null;
  failure: string | null;
};
type Receipt = {
  id: string;
  country?: string;
  destination?: string | null;
  delivery?: DeliveryAddress;
  checkoutUrl?: string;
  paymentStatus?: string;
  fulfillmentStatus?: string;
  vendorOrderId?: string | null;
  vendorStatus?: string | null;
  trackingCarrier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  paidAt?: string | null;
  shippedAt?: string | null;
  checks?: number;
  quote?: Quote;
  review?: Review;
};
// The terminal's authorized fetch, which makes a guest's session on first use,
// handed to the hatch as it mounts (omnishell's host-dom.js).
type Store = {
  http(url: string, init?: RequestInit): Promise<Response>;
  upload(key: string, file: Blob): Promise<Response>;
};
let store: Store;
async function crud(path: string, init: RequestInit = {}) {
  const { http } = store;
  const response = await http(`/crud/${path}`, {
    cache: "no-store",
    ...init,
    headers: { "content-type": "application/json", Prefer: "return=representation", ...init.headers },
  });
  // A refusal (an order admitted no more, a move the machine's guard refused)
  // is its reason, never a row the caller reads as one.
  if (!response.ok) {
    const text = await response.text();
    let reason = text;
    try { reason = JSON.parse(text)?.message ?? JSON.parse(text)?.error ?? text; } catch { /* the body is its own reason */ }
    throw new Error(`${path.split("?")[0]} answered ${response.status}: ${reason}`);
  }
  return await response.json();
}
const rowOf = async (id: string): Promise<Row> => {
  const [row] = await crud(`print_order?id=eq.${encodeURIComponent(id)}`);
  if (row) return row;
  try {
    const [tracked] = await crud(`print_order_tracking?id=eq.${encodeURIComponent(id)}`);
    if (tracked) {
      return {
        ...tracked,
        delivery: null,
        checkout_url: null,
        failure: null,
      } as Row;
    }
  } catch {
    // Fall through to order_not_found when tracking table is unavailable in fixtures.
  }
  throw new Error("order_not_found");
};
const moved = async (id: string, change: Partial<Row>): Promise<Row> => {
  const [row] = await crud(`print_order?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(change) });
  return row;
};
async function settled(id: string, waiting: string[], signal: AbortSignal): Promise<Row> {
  const deadline = Date.now() + SETTLE_MS;
  while (true) {
    const row = await rowOf(id);
    if (!waiting.includes(row.status)) return row;
    if (Date.now() > deadline) throw new Error(`order still ${row.status}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    signal.throwIfAborted();
  }
}
// What the reader is told, from where the order's machine is.
function receiptOf(row: Row, review?: Review, delivery?: DeliveryAddress): Receipt {
  const paid = ["confirming", "placing", "placing_br", "recording", "placed", "placed_br", "vendor_checking", "vendor_checking_br", "notifying_shipped", "alerting", "attention"].includes(row.status);
  return {
    id: row.id,
    country: row.country,
    destination: row.destination ?? null,
    delivery: row.delivery ?? delivery,
    checkoutUrl: row.checkout_url ?? undefined,
    checks: row.checks,
    review,
    // An ended session says why; a Pix the bank has yet to settle is paid and
    // waiting, which the reader is told so they do not pay twice.
    paymentStatus: paid
      ? "paid"
      : row.status === "unpaid"
      ? row.payment_state!
      : row.payment_state === "processing"
      ? "processing"
      : "pending",
    fulfillmentStatus: ["placed", "placed_br", "vendor_checking", "vendor_checking_br", "notifying_shipped", "recording"].includes(row.status)
      ? "sent"
      : ["alerting", "attention"].includes(row.status)
      ? "failed"
      : "pending",
    vendorOrderId: row.vendor_order_id ?? null,
    vendorStatus: row.vendor_state,
    trackingCarrier: row.tracking_carrier ?? null,
    trackingNumber: row.tracking_number ?? null,
    trackingUrl: row.tracking_url ?? null,
    paidAt: row.paid_at ?? null,
    shippedAt: row.shipped_at ?? null,
    quote: row.total === null ? undefined : { item: row.item!, shipping: row.shipping!, total: row.total, currency: row.currency! },
  };
}
// A static release has no cluster: its print screen simulates the providers. The
// cluster's door answers the reader's table with JSON.
async function modeOf(): Promise<Mode> {
  const { http } = store;
  const response = await http("/crud/print_order?select=id&limit=0");
  await response.body?.cancel();
  return (response.headers.get("content-type") ?? "").includes("json") ? "live" : "mock";
}
const receiptKey = "snapcards.print.review";
// The delivery draft as the screen binds it: the inputs hold the reader's
// words, the section's data-* the pin, and the choices region the offers they
// applied.
const ALL_PHONE_COUNTRIES: CountryCode[] = getCountries();
const validPhoneCountry = (c: string): c is CountryCode =>
  ALL_PHONE_COUNTRIES.includes(c as CountryCode);
// The country a calling code names before its digits can tell (+1 is the US
// until an area code says Canada): the metadata lists it first. A code no
// country owns (+800) names none.
const primaryPhoneCountry = (callingCode: string): CountryCode | undefined =>
  (phoneMetadata.country_calling_codes as Record<string, CountryCode[] | undefined>)[callingCode]?.[0];
function serializePhone(rawPhone: string, phoneCountry: string, addressCountry: string): string {
  const trimmed = rawPhone.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("+")) return trimmed;
  const cc = validPhoneCountry(phoneCountry)
    ? phoneCountry
    : validPhoneCountry(addressCountry)
    ? addressCountry
    : null;
  if (!cc) return trimmed;
  const ayt = new AsYouType(cc);
  ayt.input(trimmed);
  const parsed = ayt.getNumber();
  if (parsed) return parsed.formatInternational();
  return `+${getCountryCallingCode(cc)} ${trimmed}`;
}
function validCoord(v: string | undefined): boolean {
  return Boolean(v && v.trim() !== "" && !v.startsWith("{") && Number.isFinite(Number(v)));
}
export function deliveryOf(screen: HTMLElement): DeliveryAddress {
  const section = screen.querySelector<HTMLElement>(".checkout-delivery")!;
  const field = (id: string) =>
    screen.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`#${id}`)!.value.trim();
  const { pinLatitude, pinLongitude, pinSource, country } = section.dataset;
  const phoneCountry = screen.querySelector<HTMLElement>(".delivery-phone-country-btn")?.dataset.phoneCountry ?? "";
  const pin = validCoord(pinLatitude) && validCoord(pinLongitude)
    ? {
      latitude: Number(pinLatitude),
      longitude: Number(pinLongitude),
      source: pinSource as "gps" | "search" | "map",
    }
    : null;
  const rawCpf = screen.querySelector<HTMLInputElement>("#delivery-cpf")?.value.trim() ?? "";
  const taxId = (country ?? "") === "BR" ? (formatBrazilCpf(rawCpf) ?? rawCpf) : "";
  return {
    version: 1,
    text: field("delivery-text"),
    pin,
    address: {
      recipient: field("delivery-recipient"),
      ...(taxId ? { taxId } : {}),
      line1: field("delivery-line1"),
      line2: field("delivery-line2"),
      district: field("delivery-district"),
      city: field("delivery-city"),
      region: field("delivery-region"),
      postalCode: field("delivery-postal"),
      // The row's, which an applied offer may set to a country the select
      // does not list; the server holds it to the shipping countries.
      country: country ?? "",
    },
    contact: {
      phone: serializePhone(field("delivery-phone"), phoneCountry, country ?? ""),
      email: field("delivery-email"),
    },
    instructions: field("delivery-instructions"),
    acceptedSuggestions: [
      ...section.querySelectorAll<HTMLElement>(".delivery-choices [data-source]"),
    ].map((choice) => ({
      source: choice.dataset.source as "search" | "pin",
      label: choice.dataset.label!,
    })),
  };
}
function deliveryLine(delivery: DeliveryAddress, pinned: string) {
  const { line1, line2, city } = delivery.address;
  const street = [line1, line2, city].filter(Boolean).join(", ") ||
    delivery.text;
  return [street, delivery.pin ? pinned : ""].filter(Boolean).join(" · ");
}
export function isMissingStreetNumber(line1: string): boolean {
  const trimmed = line1.trim();
  if (!trimmed) return false;
  if (/\bs\/n\b/i.test(trimmed)) return false;
  if (/^\d+[a-zA-Z]?\s+\S/.test(trimmed)) return false;
  if (/(?:,\s*|\s+)\d+[a-zA-Z0-9/-]*$/.test(trimmed)) return false;
  return true;
}
const NUMBER_FIRST_COUNTRIES = new Set(["US", "CA", "GB", "IE", "AU", "NZ", "FR", "IN", "SG", "IL"]);
const STREET_COMMA_NUMBER_COUNTRIES = new Set(["BR", "PT", "ES", "IT", "AR", "CL", "CO", "UY", "PY", "MX"]);
export function formatStreetWithNumber(line1: string, num: string, country: string): string {
  const street = line1.trim().replace(/,\s*$/, "");
  const cleanNum = num.trim();
  if (!cleanNum) return street;
  if (NUMBER_FIRST_COUNTRIES.has(country)) return `${cleanNum} ${street}`;
  if (STREET_COMMA_NUMBER_COUNTRIES.has(country)) return `${street}, ${cleanNum}`;
  return `${street} ${cleanNum}`;
}
export function extractTypedNumber(searchText: string, street: string): string {
  const query = searchText.trim();
  const base = street.trim();
  if (!query || !base || !isMissingStreetNumber(base)) return "";
  const streetNums = new Set(base.match(/\d+[a-zA-Z0-9/-]*/g) ?? []);
  const matches = [...query.matchAll(/\b(\d{1,6}[a-zA-Z]?)\b/g)]
    .map((m) => m[1])
    .filter((n) => !streetNums.has(n) && n.replace(/\D/g, "").length < 5);
  return matches[matches.length - 1] ?? "";
}
export type SuggestionParts = {
  id: string;
  line1: string;
  district: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  label: string;
};
function normPart(s: string): string {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}
function partsForSuggestion(s: SuggestionParts, effectiveLine1?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (v: string) => {
    const clean = (v || "").trim();
    const k = normPart(clean);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(clean);
  };
  push(effectiveLine1 ?? s.line1);
  push(s.district);
  push(s.city);
  push(s.region);
  push(s.postalCode);
  push(s.country);
  for (const seg of (s.label || "").split(",")) push(seg);
  return out;
}
export function disambiguatedSearchText(
  chosen: SuggestionParts,
  effectiveLine1: string,
  allSuggestions: SuggestionParts[],
): string {
  const chosenParts = partsForSuggestion(chosen, effectiveLine1);
  if (chosenParts.length === 0) return (effectiveLine1 || chosen.label || "").trim();
  const others = allSuggestions
    .filter((s) => s.id !== chosen.id)
    .map((s) => partsForSuggestion(s));
  if (others.length === 0) return chosenParts[0];
  for (let k = 1; k <= chosenParts.length; k++) {
    const prefix = chosenParts.slice(0, k).map(normPart).join(" | ");
    const collision = others.some((op) => op.slice(0, k).map(normPart).join(" | ") === prefix);
    if (!collision) return chosenParts.slice(0, k).join(", ");
  }
  return chosenParts.join(", ");
}
const cleanAttr = (v: string | undefined): string =>
  v !== undefined && !v.startsWith("{") ? v.trim() : "";
const DEFAULT_COUNTRY_PIN: Record<string, readonly [ string, string ]> = {
  BR: ["-23.550520", "-46.633308"],
  AR: ["-34.603684", "-58.381559"],
  IL: ["32.085300", "34.781769"],
  US: ["37.334606", "-122.009102"],
  GB: ["51.507222", "-0.127500"],
  CN: ["39.904200", "116.407396"],
  IN: ["28.613939", "77.209021"],
};
function effectiveCountry(current: DeliveryAddress): string {
  if (known(current.address.country)) return current.address.country;
  const lang = (document.documentElement.lang || "").toLowerCase();
  if (lang.startsWith("pt")) return "BR";
  if (lang.startsWith("es")) return "AR";
  if (lang.startsWith("he")) return "IL";
  if (lang.startsWith("zh")) return "CN";
  if (lang.startsWith("hi")) return "IN";
  return "US";
}
function cepOrPostalProblem(country: string, postalCode: string): string | null {
  const problem = postalProblem(country, postalCode);
  if (problem !== null) return problem;
  if (country === "BR" && postalCode.trim() !== "" && brazilStateForCep(postalCode) === null) {
    return "40301-110";
  }
  return null;
}
function mandatoryAddressComplete(current: DeliveryAddress): boolean {
  const { address } = current;
  if (!known(address.country)) return false;
  if (address.country === "BR" && !validBrazilCpf(address.taxId ?? "")) return false;
  const must = required(address.country);
  for (const token of rows(address.country).flat()) {
    if (must.has(token) && !address[BY_TOKEN[token][0]]) return false;
  }
  return cepOrPostalProblem(address.country, address.postalCode) === null;
}
// What the country's post, and the printer, need before an order can be quoted:
// each a field and its input, and a malformed postcode or CPF with its example.
const BY_TOKEN: Record<Token, readonly [keyof DeliveryAddress["address"], string]> = {
  A: ["line1", "delivery-line1"],
  D: ["district", "delivery-district"],
  C: ["city", "delivery-city"],
  S: ["region", "delivery-region"],
  Z: ["postalCode", "delivery-postal"],
};
type Missing = { id: string; example?: string };
function missingFields(delivery: DeliveryAddress): Missing[] {
  const { address } = delivery;
  if (!known(address.country)) return [{ id: "delivery-country" }];
  // Named in the order the form shows them.
  const must = required(address.country);
  const empty: Missing[] = [];
  if (!address.recipient) empty.push({ id: "delivery-recipient" });
  if (address.country === "BR") {
    if (!address.taxId) empty.push({ id: "delivery-cpf" });
    else if (!validBrazilCpf(address.taxId)) empty.push({ id: "delivery-cpf", example: "000.000.000-00" });
  }
  if (!address.country) empty.push({ id: "delivery-country" });
  for (const token of rows(address.country).flat().filter((t) => must.has(t))) {
    const [field, id] = BY_TOKEN[token];
    if (!address[field]) empty.push({ id });
  }
  const example = cepOrPostalProblem(address.country, address.postalCode);
  return example === null ? empty : [...empty, { id: "delivery-postal", example }];
}
export default function mount(
  screen: HTMLElement,
  { signal, store: given }: { signal: AbortSignal; store: Store },
) {
  store = given;
  const panel = screen.querySelector<HTMLDialogElement>(
    "#print-checkout-panel",
  )!;
  const status = screen.querySelector<HTMLElement>("#print-checkout-status")!;
  let statusSlot = status.closest<HTMLElement>(".checkout-status-slot");
  let statusDismiss = screen.querySelector<HTMLButtonElement>("#btn-checkout-status-dismiss");
  if (!statusSlot) {
    statusSlot = document.createElement("div");
    statusSlot.className = "checkout-status-slot";
    const statusBox = document.createElement("div");
    statusBox.className = "checkout-status-box";
    statusDismiss = document.createElement("button");
    statusDismiss.type = "button";
    statusDismiss.id = "btn-checkout-status-dismiss";
    statusDismiss.className = "checkout-status-dismiss";
    statusDismiss.setAttribute(
      "aria-label",
      screen.querySelector("#btn-checkout-close")?.textContent?.trim() || "×",
    );
    statusDismiss.textContent = "×";
    status.before(statusSlot);
    statusBox.append(status, statusDismiss);
    statusSlot.append(statusBox);
  }
  let lastStatusState = "";
  const setStatusState = (nextState: string) => {
    if (nextState !== lastStatusState) {
      lastStatusState = nextState;
      if (statusSlot) delete statusSlot.dataset.dismissed;
    }
    status.dataset.state = nextState;
  };
  statusDismiss?.addEventListener("click", () => {
    if (statusSlot) statusSlot.dataset.dismissed = "true";
    section.dataset.offerDismissed = "true";
  }, { signal });
  const summary = screen.querySelector<HTMLElement>("#print-checkout-summary")!;
  const pay = screen.querySelector<HTMLButtonElement>("#btn-checkout-pay")!;
  const refresh = screen.querySelector<HTMLButtonElement>(
    "#btn-checkout-refresh",
  )!;
  const newOrderBtn = screen.querySelector<HTMLButtonElement>(
    "#btn-checkout-new",
  );
  const demo = screen.querySelector<HTMLElement>("#print-checkout-demo")!;
  const text = (key: string) => {
    const node = screen.querySelector<HTMLElement>(
      `[data-checkout-message="${key}"]`,
    );
    if (!node?.textContent?.trim()) {
      throw new Error(`Missing checkout message ${key}`);
    }
    return node.textContent.trim();
  };
  let mode: Mode = screen.dataset.commerceMode === "live" ? "live" : "mock";
  const initialPayLabel = pay.textContent;
  const titleEl = screen.querySelector<HTMLElement>("#print-checkout-title");
  const initialTitle = titleEl?.textContent ?? "";
  const detailsEl = screen.querySelector<HTMLElement>(".checkout-details");
  let trackingEl = screen.querySelector<HTMLElement>("#print-order-tracking");
  if (!trackingEl && detailsEl?.parentElement) {
    trackingEl = document.createElement("section");
    trackingEl.id = "print-order-tracking";
    trackingEl.className = "order-tracking";
    trackingEl.hidden = true;
    detailsEl.before(trackingEl);
  }
  const quoteList = screen.querySelector<HTMLElement>("#print-checkout-quote")!;
  const section = screen.querySelector<HTMLElement>(".checkout-delivery")!;
  let quote: Quote | null = null;
  let quoteKey: string | null = null;
  let quoteTimer: ReturnType<typeof setTimeout> | undefined;
  let quoteAsked: AbortController | null = null;
  let quotePromise: Promise<void> | null = null;
  let quoteProblem: string | null = null;
  let stepFailed = false;
  let frozen: FrozenPrint | null = null;
  let frozenPromise: Promise<FrozenPrint> | null = null;
  let frozenSelection: string | null = null;
  let receipt: Receipt | null = null;
  let review: Review | null = null;
  let delivery: DeliveryAddress | null = null;
  let quotedOrder: string | null = null;
  let uploadedOrder: string | null = null;
  let uploadedKeys: string[] | null = null;
  let uploadingOrder: string | null = null;
  let uploadPromise: Promise<string[]> | null = null;
  let busy = false;
  let redirecting = false;
  let payingOrder: string | null = null;
  let returnCancelled = false;
  let receiptWatch: AbortController | null = null;
  let disposed = false;
  let usedGps = false;
  let awaitingGpsFill = false;
  let pendingMapReload = false;
  let reloadingPin = false;
  let lastGpsSearchedText = "";
  let typingSearchTimer: ReturnType<typeof setTimeout> | undefined;
  let ghostAddress = "";
  let textEditedByUser = false;
  const paymentEl = screen.querySelector<HTMLElement>("#print-checkout-payment");
  const mapStage = screen.querySelector<HTMLElement>(".delivery-map-stage");
  const mapEl = screen.querySelector<HTMLElement>(".delivery-map");
  const reloadBtn = screen.querySelector<HTMLButtonElement>("#btn-delivery-map-reload");
  const searchBtn = screen.querySelector<HTMLButtonElement>("#btn-delivery-search")!;
  const textInput = screen.querySelector<HTMLInputElement>("#delivery-text")!;
  const defaultPlaceholder = textInput.getAttribute("placeholder") ?? "";
  const searchBox = screen.querySelector<HTMLElement>(".delivery-search")!;
  const locateBox = screen.querySelector<HTMLElement>(".delivery-locate");
  const geocoderSearchEl = section.querySelector<HTMLElement>('[data-hatch="geocoder"][data-prop-kind="search"]');
  const geocoderReverseEl = section.querySelector<HTMLElement>('[data-hatch="geocoder"][data-prop-kind="reverse"]');
  const line1InputEl = screen.querySelector<HTMLInputElement>("#delivery-line1");
  const line2Input = screen.querySelector<HTMLInputElement>("#delivery-line2");
  const line2Field = screen.querySelector<HTMLElement>(".f-line2");
  let ghostLine2 = "";
  let lastKnownLine1 = line1InputEl?.value.trim() ?? "";
  let lastNonEmptyLine2 = line2Input?.value.trim() ?? "";
  let searchCooldownTimer: ReturnType<typeof setTimeout> | undefined;
  let searchTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let searchShakeTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingSearchKind: "search" | "reverse" | null = null;
  let pendingSearchQ = "";
  let pendingSearchFromGps = false;
  let lastAppliedReverseKey = "";
  let lastHandledSearchKey = "";
  let pointerInSearch = false;
  let pointerInLocate = false;
  const PLACE_FIELDS = ["label", "line1", "city", "region", "postal_code", "country", "latitude", "longitude", "district"] as const;
  function parsePlaceColumn(col: string): Record<(typeof PLACE_FIELDS)[number], string> {
    const cells = col.split("\t");
    return Object.fromEntries(
      PLACE_FIELDS.map((f, i) => [f, (cells[i] ?? "").trim()]),
    ) as Record<(typeof PLACE_FIELDS)[number], string>;
  }
  function clearSearchTimers() {
    clearTimeout(searchCooldownTimer);
    clearTimeout(searchTimeoutTimer);
    clearTimeout(searchShakeTimer);
    searchCooldownTimer = undefined;
    searchTimeoutTimer = undefined;
    searchShakeTimer = undefined;
  }
  function setSearchButtonIdle() {
    clearSearchTimers();
    pendingSearchKind = null;
    pendingSearchQ = "";
    delete searchBtn.dataset.state;
  }
  function showSearchFailure(state: "failed" | "empty") {
    clearSearchTimers();
    pendingSearchKind = null;
    pendingSearchQ = "";
    searchBtn.dataset.state = state;
    searchShakeTimer = setTimeout(() => {
      if (searchBtn.dataset.state === state) delete searchBtn.dataset.state;
    }, 520);
  }
  function startSearchWait(kind: "search" | "reverse", q: string, fromGps: boolean) {
    if (kind !== "reverse" && q.split("\t")[0].trim().length < 3) {
      if (!fromGps) showSearchFailure("empty");
      return;
    }
    const existing = [...section.querySelectorAll<HTMLElement>(`[data-live="place_answer"] [data-kind="${kind}"]`)]
      .find((s) => cleanAttr(s.dataset.q) === q && s.hasAttribute("data-p0") && !s.getAttribute("data-p0")!.startsWith("{"));
    if (existing) {
      pendingSearchKind = kind;
      pendingSearchQ = q;
      pendingSearchFromGps = fromGps;
      checkPlaceAnswers();
      return;
    }
    clearSearchTimers();
    pendingSearchKind = kind;
    pendingSearchQ = q;
    pendingSearchFromGps = fromGps;
    searchBtn.dataset.state = "loading";
    searchCooldownTimer = setTimeout(() => {
      if (pendingSearchKind === kind && pendingSearchQ === q) {
        searchBtn.dataset.state = "cooldown";
      }
    }, 1100);
    searchTimeoutTimer = setTimeout(() => {
      if (pendingSearchKind === kind && pendingSearchQ === q) {
        awaitingGpsFill = false;
        if (fromGps && kind === "search") {
          setSearchButtonIdle();
          setStep("details");
        } else {
          showSearchFailure("failed");
          if (fromGps) setStep("details");
        }
      }
    }, 3500);
  }
  function isConfirming(): boolean {
    return cleanAttr(section.dataset.step) === "confirming";
  }
  function setStep(next: "search" | "details" | "confirming") {
    const prev = cleanAttr(section.dataset.step);
    section.dataset.step = next;
    if (next === "confirming") {
      section.dataset.confirming = "true";
    } else {
      delete section.dataset.confirming;
    }
    if (prev !== next) {
      section.dispatchEvent(new CustomEvent(next === "confirming" ? "confirm" : next));
    }
  }
  function setOrderId(id: string) {
    const prev = cleanAttr(section.dataset.orderId);
    section.dataset.orderId = id;
    if (prev !== id) {
      (section as HTMLElement & { value?: string }).value = id;
      section.dispatchEvent(new CustomEvent("order"));
    }
  }
  function setPinStale(stale: boolean) {
    const v = stale ? "true" : "false";
    section.dataset.pinStale = v;
    if (mapStage) mapStage.dataset.stale = v;
  }
  function setSearchStale(stale: boolean) {
    if (stale) {
      section.dataset.searchStale = "true";
      searchBox.dataset.stale = "true";
    } else {
      section.dataset.searchStale = "";
      delete searchBox.dataset.stale;
    }
  }
  function setLine2Stale(stale: boolean) {
    if (stale) {
      section.dataset.line2Stale = "true";
      if (line2Field) line2Field.dataset.stale = "true";
    } else {
      section.dataset.line2Stale = "";
      if (line2Field) delete line2Field.dataset.stale;
    }
  }
  function syncSectionStaleness() {
    const pinStale = cleanAttr(section.dataset.pinStale);
    if (pinStale === "true" || pinStale === "false") {
      if (mapStage) mapStage.dataset.stale = pinStale;
    }
    const searchStale = cleanAttr(section.dataset.searchStale);
    if (searchStale === "true") {
      searchBox.dataset.stale = "true";
    } else if (section.hasAttribute("data-search-stale") && !section.getAttribute("data-search-stale")!.startsWith("{")) {
      delete searchBox.dataset.stale;
    }
    const boundGhost = cleanAttr(section.dataset.line2Ghost);
    if (boundGhost !== "") {
      ghostLine2 = boundGhost;
    }
    const line2Stale = cleanAttr(section.dataset.line2Stale);
    if (line2Stale === "true") {
      if (line2Field) line2Field.dataset.stale = "true";
      if (line2Input && cleanAttr(section.dataset.line2) === "" && line2Input.value !== "") {
        line2Input.value = "";
        line2Input.dataset.value = "";
        lastNonEmptyLine2 = "";
      }
    } else if (section.hasAttribute("data-line2-stale") && !section.getAttribute("data-line2-stale")!.startsWith("{")) {
      if (line2Field) delete line2Field.dataset.stale;
    }
    syncLine2GhostPlaceholder();
  }
  function syncGhostPlaceholder() {
    if (textInput.value.trim() === "" && ghostAddress !== "") {
      textInput.placeholder = ghostAddress;
      textInput.dataset.ghost = ghostAddress;
    } else {
      textInput.placeholder = defaultPlaceholder;
      delete textInput.dataset.ghost;
    }
  }
  function syncLine2GhostPlaceholder() {
    if (!line2Input) return;
    if (line2Input.value.trim() === "" && ghostLine2 !== "") {
      line2Input.placeholder = ghostLine2;
      line2Input.dataset.ghost = ghostLine2;
    } else {
      line2Input.placeholder = " ";
      delete line2Input.dataset.ghost;
    }
  }
  const baseStreetName = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/^\d{1,5}[a-z]?\s+/i, "")
      .replace(/(?:,\s*|\s+)(?:s\/n|\d{1,5}[a-z0-9/-]*)$/i, "")
      .replace(/,\s*$/, "")
      .trim();
  const sameStreetName = (a: string, b: string) => {
    const ba = baseStreetName(a);
    const bb = baseStreetName(b);
    if (!ba || !bb) return false;
    return ba === bb || (Math.min(ba.length, bb.length) >= 4 && (ba.startsWith(bb) || bb.startsWith(ba)));
  };
  function checkLine1ChangedForLine2(nextLine1: string) {
    const trimmed = nextLine1.trim();
    if (!trimmed) return;
    if (lastKnownLine1 !== "" && !sameStreetName(lastKnownLine1, trimmed)) {
      const prevApt = line2Input?.value.trim() || lastNonEmptyLine2;
      if (prevApt !== "") {
        ghostLine2 = prevApt;
        section.dataset.line2Ghost = prevApt;
        lastNonEmptyLine2 = "";
        if (line2Input && line2Input.value !== "") {
          line2Input.value = "";
          line2Input.dataset.value = "";
        }
        section.dataset.line2 = "";
        setLine2Stale(true);
        syncLine2GhostPlaceholder();
      }
    }
    lastKnownLine1 = trimmed;
  }
  let lastNear = section.dataset.near && !section.dataset.near.startsWith("{")
    ? section.dataset.near
    : "";
  let lastPinLat = validCoord(section.dataset.pinLatitude) ? section.dataset.pinLatitude! : "";
  let lastPinLon = validCoord(section.dataset.pinLongitude) ? section.dataset.pinLongitude! : "";
  let lastPinSource = section.dataset.pinSource && !section.dataset.pinSource.startsWith("{")
    ? section.dataset.pinSource
    : "";
  if (lastPinLat && lastPinLon) {
    setPinStale(false);
  } else {
    setPinStale(true);
  }
  function clearSuspectPulses() {
    for (const el of section.querySelectorAll<HTMLElement>('[data-pulse="true"]')) {
      delete el.dataset.pulse;
    }
  }
  function pulseSuspectFields(current: DeliveryAddress) {
    clearSuspectPulses();
    const missing = missingFields(current);
    if (missing.length > 0) {
      for (const { id } of missing) {
        const field = screen.querySelector<HTMLElement>(`#${id}`)?.closest<HTMLElement>(".delivery-field");
        if (field) field.dataset.pulse = "true";
      }
      return;
    }
    if (!current.address.line2.trim() || line2Field?.dataset.stale === "true") {
      if (line2Field) line2Field.dataset.pulse = "true";
    }
    if (isMissingStreetNumber(current.address.line1)) {
      const streetField = screen.querySelector<HTMLElement>(".f-A");
      if (streetField) streetField.dataset.pulse = "true";
    }
    if (
      cleanAttr(section.dataset.pinSource) !== "search" &&
      screen.querySelector('.delivery-offer[data-offer="pin"]') !== null
    ) {
      const streetField = screen.querySelector<HTMLElement>(".f-A");
      if (streetField) streetField.dataset.pulse = "true";
      if (mapStage) mapStage.dataset.pulse = "true";
    }
    if (
      (mapStage?.dataset.stale === "true" &&
        screen.querySelector('.delivery-offer[data-offer="address"]') !== null) ||
      (cleanAttr(section.dataset.pinSource) === "gps" && mapStage?.dataset.stale === "true")
    ) {
      if (mapStage) mapStage.dataset.pulse = "true";
    }
  }
  function resetConfirm() {
    clearSuspectPulses();
    delete section.dataset.confirming;
    delete section.dataset.offerDismissed;
    if (isConfirming()) {
      setStep("details");
    }
    delete pay.dataset.confirming;
    pay.textContent = initialPayLabel;
  }
  function addressNeedsConfirmation(current: DeliveryAddress): boolean {
    if (missingFields(current).length > 0) return false;
    if (!current.address.line2.trim()) return true;
    if (isMissingStreetNumber(current.address.line1)) return true;
    if (line2Field?.dataset.stale === "true") return true;
    if (
      cleanAttr(section.dataset.pinSource) !== "search" &&
      screen.querySelector('.delivery-offer[data-offer="pin"]') !== null
    ) {
      return true;
    }
    if (
      mapStage?.dataset.stale === "true" &&
      screen.querySelector('.delivery-offer[data-offer="address"]') !== null
    ) {
      return true;
    }
    if (cleanAttr(section.dataset.pinSource) === "gps" && mapStage?.dataset.stale === "true") return true;
    return false;
  }
  function flashButton(btn: HTMLElement | null, ms = 260) {
    if (!btn) return;
    btn.dataset.clicking = "true";
    setTimeout(() => {
      delete btn.dataset.clicking;
    }, ms);
  }
  function applyReverseGeocodeBaseline(p0: string) {
    const place = parsePlaceColumn(p0);
    if (!place.line1 && !place.city && !place.country) return;
    const prevReloading = reloadingPin;
    reloadingPin = true;
    try {
      const setFieldIfChanged = (id: string, dataKey: string, val: string) => {
        if (!val) return;
        const el = screen.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`);
        if (el && el.value !== val) {
          el.value = val;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          if (el.tagName === "SELECT") {
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
        section.dataset[dataKey] = val;
      };
      if (place.line1) {
        checkLine1ChangedForLine2(place.line1);
        setFieldIfChanged("delivery-line1", "line1", place.line1);
      }
      setFieldIfChanged("delivery-district", "district", place.district);
      setFieldIfChanged("delivery-city", "city", place.city);
      setFieldIfChanged("delivery-region", "region", place.region);
      setFieldIfChanged("delivery-postal", "postal", place.postal_code);
      if (place.country && known(place.country)) {
        setFieldIfChanged("delivery-country", "country", place.country);
      }
      if (textInput.value.trim() === "") {
        const gpsText = [place.line1, place.city].filter(Boolean).join(", ");
        if (gpsText) {
          textInput.value = gpsText;
          textInput.dataset.value = gpsText;
          section.dataset.searchText = gpsText;
          ghostAddress = gpsText;
          lastGpsSearchedText = gpsText;
          textEditedByUser = false;
          syncGhostPlaceholder();
        }
      }
      setPinStale(false);
    } finally {
      reloadingPin = prevReloading;
    }
    scheduleQuote();
  }
  let internalSearchBtnClick = false;
  function checkPlaceAnswers() {
    const nearQ = cleanAttr(section.dataset.near) ||
      (validCoord(section.dataset.pinLatitude) && validCoord(section.dataset.pinLongitude)
        ? `${section.dataset.pinLatitude},${section.dataset.pinLongitude}`
        : "");
    let currentRevP0 = "";
    if (nearQ && (usedGps || pendingSearchKind === "reverse")) {
      const revSpan = [...section.querySelectorAll<HTMLElement>('[data-live="place_answer"] [data-kind="reverse"]')]
        .find((s) => cleanAttr(s.dataset.q) === nearQ && s.hasAttribute("data-p0") && !s.getAttribute("data-p0")!.startsWith("{"));
      if (revSpan) {
        const p0 = cleanAttr(revSpan.dataset.p0);
        currentRevP0 = p0;
        const revKey = `${nearQ}|${p0}`;
        if (revKey !== lastAppliedReverseKey || (pendingSearchKind === "reverse" && pendingSearchQ === nearQ)) {
          lastAppliedReverseKey = revKey;
          if (p0 !== "") {
            const place = parsePlaceColumn(p0);
            const gpsText = [place.line1, place.city].filter(Boolean).join(", ");
            if (textInput.value.trim() === "" && gpsText) {
              const prevReloading = reloadingPin;
              reloadingPin = true;
              try {
                textInput.value = gpsText;
                textInput.dataset.value = gpsText;
                section.dataset.searchText = gpsText;
                ghostAddress = gpsText;
                lastGpsSearchedText = gpsText;
                textEditedByUser = false;
                syncGhostPlaceholder();
              } finally {
                reloadingPin = prevReloading;
              }
            }
            const existingLine1 = screen.querySelector<HTMLInputElement>("#delivery-line1")?.value.trim() ?? "";
            if (!existingLine1) {
              applyReverseGeocodeBaseline(p0);
            }
            if (pendingSearchKind === "reverse" && pendingSearchQ === nearQ) {
              const forwardQ = gpsText ? `${gpsText}\t${nearQ}` : "";
              if (forwardQ) startSearchWait("search", forwardQ, true);
              else {
                setSearchButtonIdle();
                setStep("details");
              }
            }
          } else {
            awaitingGpsFill = false;
            showSearchFailure("empty");
            setStep("details");
          }
        }
      }
    }
    const targetSearchQ = pendingSearchKind === "search" ? pendingSearchQ : cleanAttr(section.dataset.searchQ);
    if (targetSearchQ) {
      const searchSpan = [...section.querySelectorAll<HTMLElement>('[data-live="place_answer"] [data-kind="search"]')]
        .find((s) => cleanAttr(s.dataset.q) === targetSearchQ && s.hasAttribute("data-p0") && !s.getAttribute("data-p0")!.startsWith("{"));
      if (searchSpan) {
        const p0 = cleanAttr(searchSpan.dataset.p0);
        const searchKey = `${targetSearchQ}|${p0}`;
        if ((pendingSearchKind === "search" && pendingSearchQ === targetSearchQ) || searchKey !== lastHandledSearchKey) {
          lastHandledSearchKey = searchKey;
          const wasFromGps = pendingSearchFromGps || (Boolean(nearQ) && targetSearchQ.endsWith(`\t${nearQ}`));
          if (p0 !== "") {
            setSearchButtonIdle();
            flashButton(searchBtn, 260);
            setStep("search");
            pointerInLocate = false;
            if (document.activeElement instanceof HTMLIFrameElement) {
              document.activeElement.blur();
              globalThis.focus();
              textInput.focus({ preventScroll: true });
            }
          } else if (wasFromGps) {
            if (currentRevP0 !== "") {
              applyReverseGeocodeBaseline(currentRevP0);
            }
            setSearchButtonIdle();
            setStep("details");
          } else {
            showSearchFailure("empty");
          }
        }
      }
    }
  }
  function submitManualSearch(fromGps = false) {
    clearTimeout(typingSearchTimer);
    typingSearchTimer = undefined;
    setSearchStale(false);
    const trimmed = textInput.value.trim();
    if (!fromGps) setStep("search");
    if (trimmed.length < 3) {
      if (!fromGps) showSearchFailure("empty");
      return;
    }
    const near = cleanAttr(section.dataset.near);
    const expectedQ = near ? `${trimmed}\t${near}` : trimmed;
    const existingAnswer = [...section.querySelectorAll<HTMLElement>('[data-live="place_answer"] [data-kind="search"]')]
      .find((s) => cleanAttr(s.dataset.q) === expectedQ && s.hasAttribute("data-p0") && !s.getAttribute("data-p0")!.startsWith("{"));
    if (!existingAnswer || cleanAttr(existingAnswer.dataset.p0) === "") {
      if (existingAnswer && cleanAttr(existingAnswer.dataset.p0) === "") {
        existingAnswer.remove();
        lastHandledSearchKey = "";
      }
      if (geocoderSearchEl && cleanAttr(geocoderSearchEl.dataset.propQ) === expectedQ) {
        geocoderSearchEl.dataset.propQ = "";
        setTimeout(() => {
          if (geocoderSearchEl) geocoderSearchEl.dataset.propQ = expectedQ;
        }, 25);
      }
    }
    startSearchWait("search", expectedQ, fromGps);
  }
  function triggerSearchClick(fromGps = false) {
    clearTimeout(typingSearchTimer);
    typingSearchTimer = undefined;
    setSearchStale(false);
    const trimmed = textInput.value.trim();
    if (trimmed !== "") {
      if (cleanAttr(section.dataset.searchText) !== trimmed) {
        const prev = reloadingPin;
        reloadingPin = true;
        try {
          textInput.dispatchEvent(new Event("input", { bubbles: true }));
        } finally {
          reloadingPin = prev;
        }
      }
    }
    if (!fromGps) setStep("search");
    submitManualSearch(fromGps);
    setTimeout(() => {
      if (!fromGps) setStep("search");
      pointerInLocate = false;
      if (document.activeElement instanceof HTMLIFrameElement) {
        document.activeElement.blur();
        globalThis.focus();
      }
      textInput.focus({ preventScroll: true });
      internalSearchBtnClick = true;
      try {
        searchBtn.click();
      } finally {
        internalSearchBtnClick = false;
      }
    }, 0);
  }
  function derivedAddressQ(): string {
    const current = deliveryOf(screen);
    return [
      current.address.line1,
      current.address.district,
      current.address.postalCode,
      current.address.city,
      current.address.region,
      current.address.country,
    ]
      .map((v) => v.trim())
      .filter((v) => v !== "")
      .join(" ");
  }
  function applyAddressPinFromAnswers(): boolean {
    const targetQ = derivedAddressQ() || cleanAttr(section.dataset.addressQ);
    if (!targetQ) return false;
    const addressOfferBtn = screen.querySelector<HTMLButtonElement>('.delivery-offer[data-offer="address"] button');
    if (addressOfferBtn && cleanAttr(section.dataset.addressQ) === targetQ) {
      pendingMapReload = false;
      addressOfferBtn.click();
      return true;
    }
    const spans = [...section.querySelectorAll<HTMLElement>('[data-live="place_answer"] [data-kind="address"]')];
    const match = spans.find((s) => cleanAttr(s.dataset.q) === targetQ && cleanAttr(s.dataset.p0) !== "");
    if (match) {
      const cells = (match.dataset.p0 ?? "").split("\t");
      const lat = cells[6]?.trim() ?? "";
      const lon = cells[7]?.trim() ?? "";
      if (validCoord(lat) && validCoord(lon)) {
        pendingMapReload = false;
        section.dataset.pinLatitude = lat;
        section.dataset.pinLongitude = lon;
        section.dataset.pinSource = "search";
        lastPinLat = lat;
        lastPinLon = lon;
        lastPinSource = "search";
        if (mapEl) {
          mapEl.dataset.propLatitude = lat;
          mapEl.dataset.propLongitude = lon;
        }
        return true;
      }
    }
    return false;
  }
  let internalReloadClick = false;
  function reloadMapPin(fromClick = false) {
    if (reloadingPin) return;
    reloadingPin = true;
    try {
      flashButton(reloadBtn, 240);
      setPinStale(false);
      pendingMapReload = true;
      if (!fromClick && reloadBtn) {
        internalReloadClick = true;
        try {
          reloadBtn.click();
        } finally {
          internalReloadClick = false;
        }
      }
      if (applyAddressPinFromAnswers()) return;
      if (!validCoord(section.dataset.pinLatitude) || !validCoord(section.dataset.pinLongitude)) {
        const current = deliveryOf(screen);
        const c = effectiveCountry(current);
        const [lat, lon] = DEFAULT_COUNTRY_PIN[c] ?? DEFAULT_COUNTRY_PIN.US;
        if (mapEl) {
          mapEl.dataset.propLatitude = lat;
          mapEl.dataset.propLongitude = lon;
        }
      }
    } finally {
      reloadingPin = false;
    }
  }
  function show(key: string, error = false, country = "") {
    const msgKey = country === "BR" && screen.querySelector(`[data-checkout-message="${key}_br"]`)
      ? `${key}_br`
      : key;
    status.textContent = text(msgKey);
    setStatusState(key);
    status.dataset.error = String(error);
    status.setAttribute("role", error ? "alert" : "status");
  }
  const stockOf = () =>
    screen.querySelector<HTMLElement>(".print-container")!.dataset.stock!;
  function layoutFor(cardsCount: number, stock: string, country: string): string {
    if (country === "BR") {
      return [
        `${cardsCount} ${text("cards_br")}`,
        text("size_br"),
        text("sides_br"),
        text(`stock_${stock}_br`),
        text("printed_by_br"),
      ].join(" · ");
    }
    return [
      `${cardsCount} ${text("cards")}`,
      text("size"),
      text("sides"),
      text(`stock_${stock}`),
      text("printed_by"),
    ].join(" · ");
  }
  function quoteKeyOf(address: DeliveryAddress["address"]): string {
    return address.country === "BR"
      ? JSON.stringify([stockOf(), review?.cards, "BR", address.postalCode.replace(/\D/g, "")])
      : JSON.stringify([stockOf(), review?.cards, address.country]);
  }
  function money(amount: number, currency: string) {
    return new Intl.NumberFormat(document.documentElement.lang || "en", {
      style: "currency",
      currency,
      minimumFractionDigits: ["isk", "ugx"].includes(currency.toLowerCase())
        ? 0
        : undefined,
    }).format(amount / currencyScale(currency));
  }
  function renderQuote(shown: Quote | null, country: string) {
    const set = (key: string, value: string) => {
      quoteList.querySelector(`[data-quote="${key}"]`)!.textContent = value;
    };
    const stock = review?.stock ?? stockOf();
    const br = country === "BR";
    set(
      "item-label",
      `${review?.cards ?? 0} ${text(br ? "cards_br" : "cards")}`,
    );
    set("item-note", text(br ? `stock_${stock}_br` : `stock_${stock}`));
    set("shipping-note", text(br ? "posted_br" : `posted_${stock}`));
    const place = screen.querySelector<HTMLOptionElement>(
      `#delivery-country option[value="${country}"]`,
    )?.textContent?.trim();
    set(
      "shipping-label",
      shown && place ? `${text("shipping_to")} ${place}` : text("shipping"),
    );
    quoteList.classList.toggle("empty", !shown);
    set("item", shown ? money(shown.item, shown.currency) : "—");
    set("shipping", shown ? money(shown.shipping, shown.currency) : "—");
    set("total", shown ? money(shown.total, shown.currency) : "—");
  }
  // Payment waits for a complete address and, live, its quote; a receipt has
  // its own actions.
  function syncDraft() {
    if (receipt || !panel.open) return;
    const current = deliveryOf(screen);
    const missing = missingFields(current);
    const chosenCountry = current.address.country;
    if (review) {
      review.layout = layoutFor(review.cards, review.stock, chosenCountry);
      screen.querySelector("#print-checkout-layout")!.textContent = review.layout;
    }
    if (mode === "live") renderQuote(quote, chosenCountry || effectiveCountry(current));
    else renderQuote(null, chosenCountry);
    pay.disabled = busy || redirecting || (!receipt && !review);
    // A failed step's message stays until the reader changes something.
    if (busy || redirecting || stepFailed || !review) return;
    if (missing.length) {
      delete pay.dataset.confirming;
      delete section.dataset.confirming;
      pay.textContent = initialPayLabel;
      status.textContent = `${text(chosenCountry === "BR" ? "address_needed_br" : "address_needed")} ${
        new Intl.ListFormat(document.documentElement.lang || "en", {
          type: "conjunction",
        }).format(
          // innerText: a label holds every country's name for its field, and
          // shows only this one's. The suggestions' close label also names the
          // street field, and is not its name.
          missing.map(({ id, example }) => {
            const label = screen.querySelector<HTMLElement>(`label[for="${id}"]:not(.delivery-suggestions-close)`)!.innerText.trim();
            return example === undefined ? label : `${label} (${example})`;
          }),
        )
      }.`;
      setStatusState("address_needed");
      status.dataset.error = "false";
      status.setAttribute("role", "status");
      return;
    }
    if (isConfirming()) {
      status.textContent = text("confirm_address");
      setStatusState("confirm_address");
      status.dataset.error = "false";
      status.setAttribute("role", "status");
      pay.dataset.confirming = "true";
      section.dataset.confirming = "true";
      pay.textContent = text("confirm_pay");
      return;
    }
    delete pay.dataset.confirming;
    delete section.dataset.confirming;
    pay.textContent = initialPayLabel;
    if (mode === "mock") show("demo_notice");
    else if (quoteProblem) show(quoteProblem, true, chosenCountry);
    else show(quote ? "quoted" : "quoting", false, chosenCountry);
  }
  // Prodigi's price depends on the stock, the cards and the country; Brazil's
  // domestic SEDEX also depends on the CEP, so only a change to those withdraws
  // the price until the new one is here.
  function scheduleQuote() {
    if (receipt || !panel.open || !review) return;
    if (mode === "live") {
      const full = deliveryOf(screen);
      const { address } = full;
      const key = quoteKeyOf(address);
      const complete = !missingFields(full).length;
      if (key !== quoteKey) {
        quoteKey = key;
        stepFailed = false;
        quote = null;
        quoteProblem = null;
        quotedOrder = null;
        quoteAsked?.abort();
        quoteAsked = null;
        quotePromise = null;
        clearTimeout(quoteTimer);
        quoteTimer = undefined;
      }
      // A live region rewrites these attributes as it pleases, so a timer already
      // set stands rather than restart with every write.
      if (!complete) {
        clearTimeout(quoteTimer);
        quoteTimer = undefined;
      } else if (!quote && !quoteProblem && !quoteAsked && quoteTimer === undefined) {
        quoteTimer = setTimeout(() => {
          quoteTimer = undefined;
          askQuote(key, address.country, address.postalCode);
        }, 400);
      }
    }
    syncDraft();
  }
  function askQuote(key: string, country: string, postalCode = ""): Promise<void> {
    quoteAsked?.abort();
    const asked = quoteAsked = new AbortController();
    quoteProblem = null;
    signal.addEventListener("abort", () => asked.abort(), { once: true });
    const quoteTarget = country === "BR" ? "quoting_br" : "quoting";
    const cepDigits = postalCode.replace(/\D/g, "");
    const runQuote = (async () => {
      try {
        let reused: Row | null = null;
        const candidateId = quotedOrder || cleanAttr(section.dataset.orderId);
        if (candidateId) {
          try {
            const existing = await rowOf(candidateId);
            if (
              existing &&
              ["draft", "quoting", "quoting_br", "converting", "quoted"].includes(existing.status) &&
              existing.stock === stockOf() &&
              existing.cards === review!.cards &&
              (!existing.country || existing.country === country) &&
              (country !== "BR" || (existing.postal_code ?? "").replace(/\D/g, "") === cepDigits) &&
              (!existing.title || existing.title === review!.title)
            ) {
              reused = existing;
            }
          } catch {
            reused = null;
          }
        }
        let answer: Row;
        if (reused) {
          setOrderId(reused.id);
          if (reused.status === "draft") {
            await moved(reused.id, {
              status: quoteTarget,
              ...(country === "BR" ? { postal_code: postalCode } : {}),
            });
          }
          answer = reused.status === "quoted"
            ? reused
            : await settled(reused.id, ["quoting", "quoting_br", "converting"], asked.signal);
        } else {
          const [row] = await crud("print_order", {
            method: "POST",
            signal: asked.signal,
            body: JSON.stringify({
              title: review!.title,
              stock: stockOf(),
              cards: review!.cards,
              country,
              ...(country === "BR" ? { postal_code: postalCode } : {}),
            }),
          });
          setOrderId(row.id);
          await moved(row.id, { status: quoteTarget });
          answer = await settled(row.id, ["quoting", "quoting_br", "converting"], asked.signal);
        }
        if (key !== quoteKey) return;
        if (answer.status !== "quoted") throw new Error(answer.failure ?? answer.status);
        quote = {
          id: answer.id,
          item: answer.item!,
          shipping: answer.shipping!,
          total: answer.total!,
          currency: answer.currency!,
        };
        quotedOrder = answer.id;
        setOrderId(answer.id);
        if (Array.isArray(answer.artwork) && answer.artwork.length === review!.cards) {
          uploadedOrder = answer.id;
          uploadedKeys = answer.artwork;
        } else {
          startPreupload();
        }
      } catch (error) {
        if (asked.signal.aborted || key !== quoteKey) return;
        quotedOrder = null;
        setOrderId("");
        quoteProblem = error instanceof Error && /print_order_country_check/.test(error.message)
          ? "quote_country"
          : "quote_failed";
      } finally {
        if (quoteAsked === asked) {
          quoteAsked = null;
          quotePromise = null;
        }
      }
      syncDraft();
    })();
    quotePromise = runQuote;
    return runQuote;
  }
  function renderTracking(current: Receipt, country: string) {
    if (!trackingEl) return;
    if (mode !== "live" || (current.paymentStatus !== "paid" && current.paymentStatus !== "processing")) {
      trackingEl.hidden = true;
      trackingEl.replaceChildren();
      if (titleEl && initialTitle) titleEl.textContent = initialTitle;
      return;
    }
    if (titleEl) titleEl.textContent = text("tracking_title");
    trackingEl.hidden = false;
    const isCompleted = current.vendorStatus === "completed";
    const isShipped = isCompleted || ["shipped", "partially_shipped"].includes(current.vendorStatus ?? "");
    const isInProduction = isShipped || current.fulfillmentStatus === "sent";
    const isPaid = current.paymentStatus === "paid";
    const stage = isCompleted
      ? "delivered"
      : isShipped
      ? "shipped"
      : isInProduction
      ? "production"
      : isPaid
      ? "paid"
      : "processing";
    trackingEl.dataset.stage = stage;

    const labelEl = document.createElement("span");
    labelEl.className = "checkout-label";
    labelEl.textContent = text("tracking_label");

    const refsEl = document.createElement("div");
    refsEl.className = "order-tracking-refs";
    const makeRef = (label: string, codeText: string, idAttr?: string) => {
      const wrap = document.createElement("span");
      wrap.className = "order-tracking-ref";
      const lbl = document.createElement("span");
      lbl.textContent = `${label}:`;
      const code = document.createElement("code");
      if (idAttr) code.id = idAttr;
      code.textContent = codeText;
      wrap.append(lbl, code);
      return wrap;
    };
    refsEl.append(makeRef(text("tracking_order_id"), `#${current.id.slice(0, 8)}`, "print-tracking-order-id"));
    if (current.vendorOrderId) {
      refsEl.append(makeRef(text("tracking_printer_ref"), current.vendorOrderId, "print-tracking-vendor-id"));
    }

    const stepsEl = document.createElement("ol");
    stepsEl.className = "order-tracking-steps";
    const stepDefs: [string, string, "done" | "active" | "upcoming"][] = [
      [
        "paid",
        text("tracking_step_paid"),
        isInProduction ? "done" : "active",
      ],
      [
        "production",
        text("tracking_step_production"),
        isShipped ? "done" : isInProduction ? "active" : "upcoming",
      ],
      [
        "shipped",
        text("tracking_step_shipped"),
        isCompleted ? "done" : isShipped ? "active" : "upcoming",
      ],
      [
        "delivered",
        text("tracking_step_delivered"),
        isCompleted ? "done" : "upcoming",
      ],
    ];
    for (const [stepKey, stepLabel, stepState] of stepDefs) {
      const li = document.createElement("li");
      li.className = "order-tracking-step";
      li.dataset.step = stepKey;
      li.dataset.stepState = stepState;
      const dot = document.createElement("span");
      dot.className = "order-tracking-step-dot";
      dot.setAttribute("aria-hidden", "true");
      const span = document.createElement("span");
      span.textContent = stepLabel;
      li.append(dot, span);
      stepsEl.append(li);
    }

    const nodes: HTMLElement[] = [labelEl, refsEl, stepsEl];
    const effectiveCarrier = current.trackingCarrier || (country === "BR" && isPaid ? "Correios SEDEX" : "");
    const safeUrl = current.trackingUrl && /^https?:\/\//i.test(current.trackingUrl) ? current.trackingUrl : "";
    if (effectiveCarrier || current.trackingNumber || safeUrl) {
      const shipBox = document.createElement("div");
      shipBox.id = "print-tracking-shipment";
      shipBox.className = "order-tracking-shipment";
      const meta = document.createElement("div");
      meta.className = "order-tracking-shipment-meta";
      if (effectiveCarrier) {
        const line = document.createElement("div");
        const strong = document.createElement("strong");
        strong.textContent = `${text("tracking_carrier")}: `;
        const val = document.createElement("span");
        val.id = "print-tracking-carrier";
        val.textContent = effectiveCarrier;
        line.append(strong, val);
        meta.append(line);
      }
      if (current.trackingNumber) {
        const line = document.createElement("div");
        const strong = document.createElement("strong");
        strong.textContent = `${text("tracking_code")}: `;
        const code = document.createElement("code");
        code.id = "print-tracking-code";
        code.textContent = current.trackingNumber;
        line.append(strong, code);
        meta.append(line);
      }
      shipBox.append(meta);
      if (safeUrl) {
        const link = document.createElement("a");
        link.id = "btn-tracking-url";
        link.className = "order-tracking-link";
        link.href = safeUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = text("tracking_open");
        shipBox.append(link);
      }
      nodes.push(shipBox);
    }
    trackingEl.replaceChildren(...nodes);
  }
  function renderReceipt() {
    if (!receipt) return;
    const frozenDelivery = screen.querySelector<HTMLElement>(
      "#print-checkout-delivery-summary",
    )!;
    const deliverySummaryText = receipt.delivery
      ? deliveryLine(receipt.delivery, text("pinned"))
      : (receipt.destination ?? "");
    frozenDelivery.hidden = !deliverySummaryText;
    // The order holds its own delivery now; the draft below it would read as
    // still being sent.
    delete section.dataset.paying;
    if (paymentEl) paymentEl.hidden = true;
    screen.querySelector<HTMLElement>(".checkout-delivery")!.hidden = true;
    frozenDelivery.textContent = deliverySummaryText;
    refresh.hidden = true;
    if (newOrderBtn) newOrderBtn.hidden = true;
    pay.hidden = true;
    if (mode === "live") {
      if (receipt.paymentStatus === "pending" && receipt.checkoutUrl && returnCancelled) {
        pay.hidden = false;
        pay.textContent = text("resume");
        if (newOrderBtn) newOrderBtn.hidden = false;
      } else if (
        receipt.paymentStatus === "failed" ||
        receipt.paymentStatus === "expired"
      ) {
        pay.hidden = false;
        pay.textContent = text("new_order");
      }
    }
    if (mode === "mock") {
      renderTracking(receipt, "");
      show(
        receipt.paymentStatus === "paid" ? "demo_paid" : "demo_failed",
        receipt.paymentStatus !== "paid",
      );
      return;
    }
    const receiptCountry = receipt.delivery?.address.country || receipt.country || "";
    renderTracking(receipt, receiptCountry);
    if (receipt.quote) {
      renderQuote(receipt.quote, receiptCountry);
    }
    if (receipt.paymentStatus === "paid") {
      show(
        receipt.fulfillmentStatus === "sent"
          ? ["shipped", "partially_shipped", "completed"].includes(
              receipt.vendorStatus ?? "",
            )
            ? "paid_shipped"
            : "paid_sent"
          : receipt.fulfillmentStatus === "failed" ||
              receipt.fulfillmentStatus === "uncertain"
          ? "paid_attention"
          : "paid",
        false,
        receiptCountry,
      );
    } else {show(
        receipt.paymentStatus === "failed"
          ? "failed"
          : receipt.paymentStatus === "expired"
          ? "expired"
          : receipt.paymentStatus === "refunded"
          ? "refunded"
          : receipt.paymentStatus === "processing"
          ? "processing"
          : "pending",
        receipt.paymentStatus === "failed",
        receiptCountry,
      );}
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    stepFailed = false;
    pay.disabled = true;
    refresh.disabled = true;
    if (newOrderBtn) newOrderBtn.disabled = true;
    try {
      await action();
    } catch (error) {
      if (!disposed) {
        stepFailed = true;
        show("error", true);
        status.append(
          ` ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      busy = false;
      pay.disabled = redirecting || (!receipt && !review);
      refresh.disabled = false;
      if (newOrderBtn) newOrderBtn.disabled = false;
      syncDraft();
    }
  }
  function clearReviewDom() {
    review = null;
    screen.querySelector<HTMLElement>(".checkout-collection")!.hidden = true;
    screen.querySelector("#print-checkout-collection")!.textContent = "";
    screen.querySelector("#print-checkout-layout")!.textContent = "";
    screen.querySelector(".checkout-fan")!.replaceChildren();
  }
  async function renderReview() {
    while (true) {
      if (!receipt && !frozen) {
        clearReviewDom();
        await illustrationsArrived(screen, signal);
      }
      const snap = !receipt && !frozen ? selection() : null;
      const collection = screen.querySelector(".active-deck-name")?.textContent
        ?.trim();
      if ((!collection || collection.startsWith("{")) && !receipt && !frozen) {
        throw new Error("Select a card collection first");
      }
      const cards = [
        ...screen.querySelectorAll<HTMLElement>(
          ".sheet-paper-primary .print-card",
        ),
      ];
      if (!receipt && !frozen && (!cards.length || cards.length > 100)) {
        throw new Error("A print order requires 1–100 cards");
      }
      const stock = stockOf();
      const countryNow = cleanAttr(section.dataset.country);
      const nextReview = receipt ? receipt.review ?? null : frozen ? review : {
        title: collection!,
        cards: cards.length,
        stock,
        layout: layoutFor(cards.length, stock, countryNow),
        images: cards.slice(0, 3).map(illustrationOf),
      };
      const fan = screen.querySelector(".checkout-fan")!;
      const images = (nextReview?.images ?? []).map((src) => {
        const image = document.createElement("img");
        image.src = src;
        image.alt = "";
        return image;
      });
      await Promise.all(images.map((image) => image.decode()));
      if (snap !== null && selection() !== snap) continue;
      review = nextReview;
      screen.querySelector<HTMLElement>(".checkout-collection")!.hidden = !review;
      screen.querySelector("#print-checkout-collection")!.textContent =
        review?.title ?? "";
      screen.querySelector("#print-checkout-layout")!.textContent =
        review?.layout ?? "";
      fan.replaceChildren(...images);
      return;
    }
  }
  // What this order would print: a failed submission keeps its frozen files and
  // request key only while this is unchanged, or it would pay for the old deck.
  function selection() {
    return JSON.stringify([
      cleanAttr(screen.querySelector<HTMLElement>(".print-container")?.dataset.setId),
      screen.querySelector(".active-deck-name")?.textContent?.trim(),
      stockOf(),
      [...screen.querySelectorAll<HTMLElement>(
        ".sheet-paper-primary .print-card",
      )].map((card) => [
        card.dataset.id,
        card.dataset.setId,
        card.dataset.front,
        card.querySelector<HTMLImageElement>("img")?.getAttribute("src"),
        card.querySelector<HTMLElement>(".print-card-word")?.textContent,
      ]),
    ]);
  }
  function startPreupload(): Promise<string[]> | null {
    if (mode !== "live" || receipt || disposed || !quotedOrder || !frozen) return null;
    if (frozenSelection !== selection() || frozen.artworkBytes > MAX_ARTWORK_BYTES) return null;
    const id = quotedOrder;
    if (uploadedOrder === id && uploadedKeys && uploadedKeys.length === frozen.cards) {
      return Promise.resolve(uploadedKeys);
    }
    if (uploadPromise && uploadingOrder === id) {
      return uploadPromise;
    }
    const files = frozen.artwork;
    uploadingOrder = id;
    const pending = (async () => {
      try {
        const keys: string[] = [];
        for (const file of files) {
          if (signal.aborted || disposed) throw new Error("aborted");
          const bytes = new Uint8Array(file);
          const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
          const key = `${[...hash].map((b) => b.toString(16).padStart(2, "0")).join("")}-${id.replaceAll("-", "")}.jpg`;
          await store.upload(key, new Blob([bytes], { type: "image/jpeg" }));
          keys.push(key);
        }
        if (!disposed && quotedOrder === id) {
          await moved(id, { artwork: keys });
          uploadedOrder = id;
          uploadedKeys = keys;
        }
        return keys;
      } finally {
        if (uploadingOrder === id) {
          uploadPromise = null;
          uploadingOrder = null;
        }
      }
    })();
    pending.catch(() => {});
    uploadPromise = pending;
    return pending;
  }
  function startPrefreeze() {
    if (receipt || disposed || frozen) return;
    const selected = selection();
    if (frozenPromise && frozenSelection === selected) return;
    frozenSelection = selected;
    const pending = freezePrint(screen, signal).then((built) => {
      if (!disposed && frozenSelection === selected) {
        frozen = built;
        startPreupload();
      }
      return built;
    });
    // Handled when prepare() awaits frozenPromise; suppress unhandled rejection if never submitted.
    pending.catch(() => {});
    frozenPromise = pending;
  }
  // The signed-in reader's email, when their provider vouched for one, starts the
  // delivery form; the reader may still change it.
  function sessionEmail(): string {
    try {
      const held = localStorage.getItem("pronto-token");
      const email = held ? (JSON.parse(held) as { user?: { email?: unknown } }).user?.email : undefined;
      return typeof email === "string" ? email : "";
    } catch {
      return "";
    }
  }
  async function open() {
    if (!panel.open) {
      if (!receipt && (frozenSelection !== null || review !== null) && frozenSelection !== selection()) {
        frozen = null;
        frozenPromise = null;
        frozenSelection = null;
        clearReviewDom();
        quote = null;
        quoteKey = null;
        quoteProblem = null;
        quotedOrder = null;
        uploadedOrder = null;
        uploadedKeys = null;
        uploadingOrder = null;
        uploadPromise = null;
        setOrderId("");
        delivery = null;
        demo.hidden = true;
        pay.hidden = false;
      }
      try {
        await renderReview();
      } catch (error) {
        if (!disposed && !signal.aborted) {
          screen.querySelector<HTMLElement>("#print-checkout-mode")!.hidden =
            mode !== "mock";
          summary.textContent = mode === "mock" ? text("demo_notice") : "";
          panel.hidden = false;
          if (!panel.open) panel.showModal();
        }
        throw error;
      }
      if (disposed || signal.aborted) return;
      panel.hidden = false;
      if (!panel.open) panel.showModal();
      const emEl = screen.querySelector<HTMLInputElement>("#delivery-email");
      const known = sessionEmail();
      if (emEl && known && !emEl.value.trim()) {
        emEl.value = known;
        emEl.dispatchEvent(new Event("input", { bubbles: true }));
      }
      startPrefreeze();
      screen.querySelector<HTMLElement>("#print-checkout-mode")!.hidden =
        mode !== "mock";
    } else {
      panel.hidden = false;
    }
    summary.textContent = mode === "mock" ? text("demo_notice") : "";
    if (!receipt) scheduleQuote();
    else renderReceipt();
  }
  async function prepare() {
    const raw = deliveryOf(screen);
    if (missingFields(raw).length > 0) {
      throw new Error(text("address_needed"));
    }
    const country = effectiveCountry(raw);
    const current: DeliveryAddress = {
      ...raw,
      address: {
        ...raw.address,
        country,
      },
    };
    show("preparing");
    const selected = selection();
    const hasPreuploadedForSelection =
      mode === "live" &&
      Boolean(quotedOrder) &&
      uploadedOrder === quotedOrder &&
      Boolean(uploadedKeys) &&
      Boolean(review) &&
      uploadedKeys!.length === review!.cards &&
      (frozenSelection === null || frozenSelection === selected);
    if (!hasPreuploadedForSelection) {
      if (!frozen || frozenSelection !== selected) {
        frozen = frozenPromise && frozenSelection === selected
          ? await frozenPromise
          : await freezePrint(screen, signal);
        frozenSelection = selected;
      }
      if (frozen.artworkBytes > MAX_ARTWORK_BYTES) {
        throw new Error(text("too_large"));
      }
    }
    delivery = current;
    if (mode === "mock") {
      demo.hidden = false;
      pay.hidden = true;
      show("demo_checkout");
      return;
    }
    if (!quote || !quotedOrder) {
      clearTimeout(quoteTimer);
      quoteTimer = undefined;
      const key = quoteKeyOf(current.address);
      if (quoteAsked && quotePromise && quoteKey === key) {
        await quotePromise;
      }
      if (!quote || !quotedOrder) {
        quoteKey = key;
        await askQuote(key, country, current.address.postalCode);
      }
      if (!quote || !quotedOrder) {
        throw new Error(text(quoteProblem ?? "quote_failed"));
      }
    }
    // Each file is stored under the SHA-256 of its bytes, which the airlock checks
    // when the session's handler reads it to make the print file (libraries/mecha/
    // docs/decisions/2026-11-05-content-addressed-blobs.md), and the order's id, so another
    // order of the same deck, another session's claim, holds a key of its own.
    // Only a session that pays makes Prodigi fetch them.
    const id = quotedOrder!;
    let keys: string[];
    if (uploadedOrder === id && uploadedKeys && uploadedKeys.length === (frozen?.cards ?? review!.cards)) {
      keys = uploadedKeys;
    } else {
      const pre = startPreupload();
      if (pre) {
        keys = await pre;
      } else {
        keys = [];
        for (const file of frozen!.artwork) {
          const bytes = new Uint8Array(file);
          const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
          const key = `${[...hash].map((b) => b.toString(16).padStart(2, "0")).join("")}-${id.replaceAll("-", "")}.jpg`;
          await store.upload(key, new Blob([bytes], { type: "image/jpeg" }));
          keys.push(key);
        }
      }
    }
    // Once an order is moved out of quoted into opening, it cannot enter opening
    // again; a failed attempt mints a fresh order on retry.
    quotedOrder = null;
    uploadedOrder = null;
    uploadedKeys = null;
    setOrderId("");
    await moved(id, { delivery, artwork: keys, status: "opening" } as unknown as Partial<Row>);
    const row = await settled(id, ["opening"], signal);
    if (row.status !== "awaiting_payment" || !row.checkout_url) {
      throw new Error(row.failure ?? row.status);
    }
    sessionStorage.setItem(`${receiptKey}:${id}`, JSON.stringify(review));
    openPayment(id, row.checkout_url);
  }
  function updatePaymentUnit(url: string, order: string) {
    if (!paymentEl) return;
    // The deployment's key, sent with the session it opened (print-session).
    const publishableKey = url ? new URLSearchParams(new URL(url).hash.slice(1)).get("publishable_key") ?? "" : "";
    const email = delivery?.contact.email ?? receipt?.delivery?.contact.email ?? "";
    const lang = cleanAttr(screen.querySelector<HTMLElement>("[data-prop-lang]")?.dataset.propLang) ||
      document.documentElement.lang || "en";
    const dir = cleanAttr(screen.querySelector<HTMLElement>("[data-prop-dir]")?.dataset.propDir) ||
      document.documentElement.dir || "ltr";
    const emailLabel = screen.querySelector<HTMLElement>('label[for="delivery-email"] > span')?.textContent?.trim() || "Email";
    const emailNeeded = screen.querySelector<HTMLElement>(".delivery-need")?.textContent?.trim() || "An email address is required.";
    const payLabel = initialPayLabel?.trim() || "Pay";
    const cancelLabel = screen.querySelector<HTMLElement>("#btn-checkout-close")?.getAttribute("aria-label")?.trim() || "Cancel and return";
    const errorLabel = text("error");
    paymentEl.dataset.propUrl = url;
    paymentEl.dataset.propOrder = order;
    paymentEl.dataset.propPublishableKey = publishableKey;
    paymentEl.dataset.propEmail = email;
    const hatch = (paymentEl as unknown as { _prontoHatch?: { update: (p: Record<string, unknown>) => void } })._prontoHatch;
    if (hatch) {
      hatch.update({
        url,
        order,
        publishableKey,
        email,
        lang,
        dir,
        emailLabel,
        emailNeeded,
        payLabel,
        cancelLabel,
        errorLabel,
      });
    } else if (url) {
      const frame = document.createElement("iframe");
      frame.id = "checkout-frame";
      frame.allow = "payment";
      frame.src = url;
      paymentEl.replaceChildren(frame);
    } else {
      paymentEl.replaceChildren();
    }
  }
  function hideFrozenDelivery() {
    const frozenDelivery = screen.querySelector<HTMLElement>(
      "#print-checkout-delivery-summary",
    );
    if (frozenDelivery) {
      frozenDelivery.hidden = true;
      frozenDelivery.textContent = "";
    }
    if (trackingEl) {
      trackingEl.hidden = true;
      trackingEl.replaceChildren();
    }
    if (titleEl && initialTitle) {
      titleEl.textContent = initialTitle;
    }
  }
  function openPayment(id: string, checkoutUrl: string) {
    if (
      (paymentEl as unknown as { _prontoHatch?: unknown })?._prontoHatch &&
      !checkoutUrl.includes("#client_secret=")
    ) {
      redirecting = true;
      show("redirecting");
      location.assign(checkoutUrl);
      return;
    }
    payingOrder = id;
    redirecting = true;
    show("redirecting");
    hideFrozenDelivery();
    section.hidden = false;
    section.dataset.paying = "true";
    pay.hidden = true;
    refresh.hidden = true;
    if (newOrderBtn) newOrderBtn.hidden = true;
    if (paymentEl) {
      paymentEl.hidden = false;
      updatePaymentUnit(checkoutUrl, id);
    }
    panel.scrollTop = 0;
    if (location.hash !== "#print-checkout-payment") {
      if (!location.hash) {
        const base = new URL(location.href);
        base.hash = "#print-checkout-panel";
        history.replaceState(history.state, "", base.href);
      }
      const next = new URL(location.href);
      next.searchParams.set("order", id);
      next.searchParams.delete("checkout");
      next.hash = "#print-checkout-payment";
      history.pushState({ checkoutPayment: id }, "", next.href);
    }
  }
  function stopReceiptWatch() {
    receiptWatch?.abort();
    receiptWatch = null;
  }
  function startReceiptWatch(id: string, options: { nudgeAfterMs?: number } = {}) {
    stopReceiptWatch();
    if (mode !== "live" || disposed) return;
    const watch = receiptWatch = new AbortController();
    const started = Date.now();
    let nudged = false;
    (async () => {
      while (!watch.signal.aborted && !signal.aborted && !disposed && receipt?.id === id) {
        try {
          let row = await rowOf(id);
          if (watch.signal.aborted || receipt?.id !== id) return;
          if (
            !nudged &&
            options.nudgeAfterMs !== undefined &&
            row.status === "awaiting_payment" &&
            Date.now() - started >= options.nudgeAfterMs
          ) {
            nudged = true;
            try {
              row = await moved(id, { status: "checking", checks: row.checks + 1 });
            } catch {
              row = await rowOf(id);
            }
          }
          if (watch.signal.aborted || receipt?.id !== id) return;
          receipt = receiptOf(row, receipt.review, receipt.delivery);
          renderReceipt();
          if (["unpaid", "attention"].includes(row.status)) return;
          if (["placed", "placed_br"].includes(row.status) && !panel.open) return;
          const settled = ["placed", "placed_br"].includes(row.status);
          await new Promise((resolve) => setTimeout(resolve, settled ? 1200 : 500));
        } catch {
          if (watch.signal.aborted || signal.aborted || disposed) return;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    })();
  }
  function closePayment(restoreDraft: boolean) {
    payingOrder = null;
    redirecting = false;
    delete section.dataset.paying;
    if (paymentEl) {
      paymentEl.hidden = true;
      updatePaymentUnit("", "");
    }
    if (restoreDraft) {
      stopReceiptWatch();
      returnCancelled = false;
      receipt = null;
      hideFrozenDelivery();
      section.hidden = false;
      refresh.hidden = true;
      if (newOrderBtn) newOrderBtn.hidden = true;
      pay.hidden = false;
      pay.disabled = false;
      pay.textContent = initialPayLabel;
      stepFailed = false;
      const clean = new URL(location.href);
      const changed = clean.searchParams.has("order") ||
        clean.searchParams.has("checkout") ||
        clean.hash === "#print-checkout-payment";
      if (changed) {
        clean.searchParams.delete("order");
        clean.searchParams.delete("checkout");
        if (clean.hash === "#print-checkout-payment") {
          clean.hash = "#print-checkout-panel";
        }
        history.replaceState(history.state, "", clean.href);
      }
      if (!quotedOrder) {
        quote = null;
        quoteKey = null;
      }
      syncDraft();
      scheduleQuote();
    }
  }
  function handleCheckoutOutcome(outcome?: string) {
    const id = payingOrder;
    if (!id || (outcome !== "completed" && outcome !== "cancelled")) return;
    returnCancelled = outcome === "cancelled";
    closePayment(false);
    const clean = new URL(location.href);
    clean.searchParams.set("order", id);
    if (outcome === "cancelled") clean.searchParams.set("checkout", "cancelled");
    else clean.searchParams.delete("checkout");
    if (clean.hash === "#print-checkout-payment") {
      clean.hash = "#print-checkout-panel";
    }
    history.replaceState(history.state, "", clean.href);
    void run(async () => {
      const row = await rowOf(id);
      receipt = receiptOf(row, review ?? undefined, delivery ?? undefined);
      renderReceipt();
      if (!returnCancelled) {
        startReceiptWatch(id, { nudgeAfterMs: 3500 });
      }
    });
  }
  paymentEl?.addEventListener("checkout", ((event: CustomEvent<{ outcome?: string }>) => {
    handleCheckoutOutcome(event.detail?.outcome);
  }) as EventListener, { signal });
  globalThis.addEventListener("message", (event) => {
    if (!paymentEl || (paymentEl as unknown as { _prontoHatch?: unknown })._prontoHatch) return;
    const frame = paymentEl.querySelector<HTMLIFrameElement>("#checkout-frame");
    if (!frame || event.source !== frame.contentWindow) return;
    const data = event.data as { type?: string; outcome?: string } | null;
    if (data?.type === "stripe-simulator:checkout") {
      handleCheckoutOutcome(data.outcome);
    }
  }, { signal });
  globalThis.addEventListener("popstate", (event) => {
    if (payingOrder && location.hash !== "#print-checkout-payment") {
      closePayment(true);
      return;
    }
    if (!payingOrder && location.hash === "#print-checkout-payment" && mode === "live") {
      const id = (event.state as { checkoutPayment?: string } | null)?.checkoutPayment ??
        new URL(location.href).searchParams.get("order");
      if (!id) return;
      void run(async () => {
        const row = await rowOf(id);
        const r = receiptOf(row, review ?? undefined, delivery ?? undefined);
        receipt = r;
        await open();
        if (r.paymentStatus === "pending" && r.checkoutUrl) {
          openPayment(id, r.checkoutUrl);
        } else {
          renderReceipt();
        }
      });
    }
  }, { signal });
  globalThis.addEventListener("pageshow", () => {
    if (new URL(location.href).searchParams.get("order")) return;
    if (payingOrder) {
      closePayment(true);
      return;
    }
    if (receipt) {
      receipt = null;
      hideFrozenDelivery();
      section.hidden = false;
      refresh.hidden = true;
      if (newOrderBtn) newOrderBtn.hidden = true;
      pay.hidden = false;
      pay.textContent = initialPayLabel;
    }
    redirecting = false;
    busy = false;
    pay.disabled = false;
    stepFailed = false;
    if (!quotedOrder) {
      quote = null;
      quoteKey = null;
    }
    syncDraft();
    scheduleQuote();
  }, { signal });
  // Asks the provider again: its webhook may be late, or lost.
  async function update() {
    if (!receipt) throw new Error(text("missing_receipt"));
    let row = await rowOf(receipt.id);
    if (row.status === "awaiting_payment") {
      row = await moved(receipt.id, { status: "checking", checks: row.checks + 1 });
    }
    row = await settled(receipt.id, ["checking", "confirming", "placing", "placing_br", "recording", "vendor_checking", "vendor_checking_br", "notifying_shipped", "alerting"], signal);
    receipt = receiptOf(row, receipt.review, receipt.delivery);
    renderReceipt();
  }
  function restoreDeliveryInputs(prev?: DeliveryAddress) {
    if (!prev) return;
    const fill = (selector: string, value: string | undefined, eventName: "input" | "change" = "input") => {
      const el = screen.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(selector);
      if (!el || el.value.trim() || !value?.trim()) return;
      el.value = value;
      el.dispatchEvent(new Event(eventName, { bubbles: true }));
    };
    if (!cleanAttr(section.dataset.country) && prev.address.country?.trim()) {
      section.dataset.country = prev.address.country.trim();
    }
    fill("#delivery-country", prev.address.country, "change");
    fill("#delivery-recipient", prev.address.recipient);
    fill("#delivery-cpf", prev.address.taxId);
    fill("#delivery-phone", prev.contact.phone);
    fill("#delivery-email", prev.contact.email);
    fill("#delivery-line1", prev.address.line1);
    fill("#delivery-line2", prev.address.line2);
    fill("#delivery-district", prev.address.district);
    fill("#delivery-city", prev.address.city);
    fill("#delivery-region", prev.address.region);
    fill("#delivery-postal", prev.address.postalCode);
    fill("#delivery-instructions", prev.instructions);
    if (prev.pin && !validCoord(section.dataset.pinLatitude)) {
      section.dataset.pinLatitude = String(prev.pin.latitude);
      section.dataset.pinLongitude = String(prev.pin.longitude);
      section.dataset.pinSource = prev.pin.source;
      setPinStale(false);
    }
    if (prev.address.line1?.trim() && section.dataset.step === "search") {
      setStep("details");
    }
  }
  async function startNewOrder(prevDelivery?: DeliveryAddress) {
    stopReceiptWatch();
    returnCancelled = false;
    receipt = null;
    frozen = null;
    frozenPromise = null;
    frozenSelection = null;
    delivery = null;
    quote = null;
    quoteKey = null;
    quotedOrder = null;
    uploadedOrder = null;
    uploadedKeys = null;
    uploadingOrder = null;
    uploadPromise = null;
    setOrderId("");
    hideFrozenDelivery();
    section.hidden = false;
    refresh.hidden = true;
    if (newOrderBtn) newOrderBtn.hidden = true;
    pay.hidden = false;
    restoreDeliveryInputs(prevDelivery);
    await renderReview();
    startPrefreeze();
    pay.textContent = initialPayLabel;
    const here = new URL(location.href);
    here.searchParams.delete("order");
    here.searchParams.delete("checkout");
    if (here.hash === "#print-checkout-payment") {
      here.hash = "#print-checkout-panel";
    }
    history.replaceState(null, "", here.href);
    // A new order has a new price, which the reader sees before paying it.
    scheduleQuote();
  }
  screen.querySelector("#btn-order-print")!.addEventListener(
    "click",
    () => run(open),
    { signal },
  );
  pay.addEventListener("click", () =>
    run(async () => {
      if (receipt && mode === "live") {
        const startingNew = ["expired", "failed"].includes(receipt.paymentStatus!);
        await update();
        if (receipt.paymentStatus === "pending" && receipt.checkoutUrl) {
          openPayment(receipt.id, receipt.checkoutUrl);
          return;
        }
        if (!startingNew || !["expired", "failed"].includes(receipt.paymentStatus!)) return;
        await startNewOrder();
        return;
      }
      if (!review) return;
      const current = deliveryOf(screen);
      const missing = missingFields(current);
      if (missing.length > 0) {
        resetConfirm();
        if (statusSlot) delete statusSlot.dataset.dismissed;
        pulseSuspectFields(current);
        syncDraft();
        screen.querySelector<HTMLElement>(`#${missing[0].id}`)?.focus();
        return;
      }
      if (!isConfirming() && addressNeedsConfirmation(current)) {
        setStep("confirming");
        pulseSuspectFields(current);
        syncDraft();
        return;
      }
      setLine2Stale(false);
      section.dispatchEvent(new CustomEvent("confirmed"));
      resetConfirm();
      await prepare();
    }), { signal });
  newOrderBtn?.addEventListener("click", () =>
    run(async () => {
      if (!receipt || mode !== "live") return;
      const prevDelivery = receipt.delivery;
      await update();
      if (!["pending", "expired", "failed"].includes(receipt.paymentStatus ?? "")) return;
      await startNewOrder(prevDelivery);
      screen.querySelector<HTMLInputElement>("#delivery-email")?.focus();
    }), { signal });
  refresh.addEventListener("click", () => run(update), { signal });
  reloadBtn?.addEventListener("click", () => {
    if (internalReloadClick) return;
    reloadMapPin(true);
    syncDraft();
  }, { signal });
  const STRUCTURED_IDS = new Set([
    "delivery-country",
    "delivery-line1",
    "delivery-line2",
    "delivery-district",
    "delivery-city",
    "delivery-region",
    "delivery-postal",
  ]);
  const DERIVED_IDS = new Set([
    "delivery-country",
    "delivery-line1",
    "delivery-district",
    "delivery-city",
    "delivery-region",
    "delivery-postal",
  ]);
  const recentStructuredEdits = new Set<string>();
  let burstTimer: ReturnType<typeof setTimeout> | undefined;
  const onDeliveryEdit = (event: Event) => {
    if (reloadingPin) return;
    const target = event.target as HTMLElement | null;
    if (
      target?.classList.contains("delivery-suggestion-number-input") ||
      target?.classList.contains("delivery-phone-country-search")
    ) {
      return;
    }
    if (event.type === "change" && target?.id !== "delivery-country") return;
    if (
      event.type === "input" &&
      target &&
      !searchBox.contains(target) &&
      section.dataset.step === "search"
    ) {
      const first = suggestions.querySelector<HTMLButtonElement>('.delivery-suggestion[data-id="s0"], .delivery-suggestion');
      if (first) acceptSuggestionElement(first, undefined, true);
      else setStep("details");
    }
    resetConfirm();
    const id = target?.id ?? "";
    if (id === "delivery-text") {
      awaitingGpsFill = false;
      setSearchStale(false);
      const trimmed = textInput.value.trim();
      if (trimmed !== "") {
        textEditedByUser = trimmed !== lastGpsSearchedText;
        ghostAddress = trimmed;
      }
      syncGhostPlaceholder();
      clearTimeout(typingSearchTimer);
      typingSearchTimer = undefined;
    }
    if (id === "delivery-country" && countrySelect) {
      section.dataset.country = countrySelect.value;
    }
    if (id === "delivery-line1" && line1InputEl) {
      section.dataset.line1 = line1InputEl.value;
      checkLine1ChangedForLine2(line1InputEl.value);
    }
    if (id === "delivery-line2" && line2Input) {
      const trimmed = line2Input.value.trim();
      section.dataset.line2 = trimmed;
      lastNonEmptyLine2 = trimmed;
      if (trimmed !== "") {
        ghostLine2 = trimmed;
        section.dataset.line2Ghost = trimmed;
      }
      setLine2Stale(false);
      syncLine2GhostPlaceholder();
    }
    if (DERIVED_IDS.has(id)) {
      setSearchStale(true);
    }
    if (id === "delivery-text" || STRUCTURED_IDS.has(id)) {
      setPinStale(true);
    }
    if (DERIVED_IDS.has(id) && id !== "delivery-district") {
      recentStructuredEdits.add(id);
      clearTimeout(burstTimer);
      burstTimer = setTimeout(() => recentStructuredEdits.clear(), 150);
      const current = deliveryOf(screen);
      if (mandatoryAddressComplete(current) && recentStructuredEdits.size >= 2) {
        reloadMapPin();
      }
    }
    scheduleQuote();
  };
  section.addEventListener("input", onDeliveryEdit, { signal });
  section.addEventListener("change", onDeliveryEdit, { signal });
  line2Input?.addEventListener("keydown", (event) => {
    if (
      line2Input.value === "" &&
      ghostLine2 !== "" &&
      (event.key === "Tab" || event.key === "ArrowRight" || event.key === "ArrowLeft")
    ) {
      event.preventDefault();
      line2Input.value = ghostLine2;
      line2Input.dataset.value = ghostLine2;
      section.dataset.line2 = ghostLine2;
      section.dataset.line2Ghost = ghostLine2;
      lastNonEmptyLine2 = ghostLine2;
      setLine2Stale(false);
      syncLine2GhostPlaceholder();
      line2Input.dispatchEvent(new Event("input", { bubbles: true }));
      line2Input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, { signal });
  function checkGpsAutoSearch() {
    const near = cleanAttr(section.dataset.near);
    const pinSrc = cleanAttr(section.dataset.pinSource);
    const hasBoundSearchText =
      section.hasAttribute("data-search-text") &&
      !section.getAttribute("data-search-text")!.startsWith("{");
    const storeText = hasBoundSearchText
      ? cleanAttr(section.dataset.searchText)
      : cleanAttr(textInput.dataset.value) || textInput.value.trim();
    if (
      awaitingGpsFill &&
      (pinSrc === "gps" || near !== "") &&
      storeText !== "" &&
      storeText !== lastGpsSearchedText
    ) {
      awaitingGpsFill = false;
      if (textInput.value.trim() !== storeText) {
        textInput.value = storeText;
      }
      textInput.dataset.value = storeText;
      lastGpsSearchedText = storeText;
      ghostAddress = storeText;
      textEditedByUser = false;
      syncGhostPlaceholder();
      triggerSearchClick(true);
    } else if (storeText === "" && textInput.value.trim() === "") {
      syncGhostPlaceholder();
    }
  }
  // What a suggestion applies reaches the row without an input event.
  const observer = new MutationObserver((mutations) => {
    syncSectionStaleness();
    const near = cleanAttr(section.dataset.near);
    const pinLat = validCoord(section.dataset.pinLatitude) ? section.dataset.pinLatitude! : "";
    const pinLon = validCoord(section.dataset.pinLongitude) ? section.dataset.pinLongitude! : "";
    const pinSrc = cleanAttr(section.dataset.pinSource);
    const currentLine1 = line1InputEl?.value.trim() || cleanAttr(section.dataset.line1);
    const currentLine2 = line2Input?.value.trim() || cleanAttr(section.dataset.line2);
    if (currentLine2.trim() !== "") {
      lastNonEmptyLine2 = currentLine2.trim();
      ghostLine2 = currentLine2.trim();
    }
    if (currentLine1.trim() !== "") {
      checkLine1ChangedForLine2(currentLine1);
    }
    syncLine2GhostPlaceholder();
    if (pinSrc === "gps" || near !== "") usedGps = true;
    const gpsTurnedOn =
      (near !== "" && near !== lastNear) ||
      (pinSrc === "gps" && lastPinSource !== "gps");
    if (gpsTurnedOn) {
      awaitingGpsFill = true;
      lastGpsSearchedText = "";
      const hasBoundSearchText =
        section.hasAttribute("data-search-text") &&
        !section.getAttribute("data-search-text")!.startsWith("{");
      if (hasBoundSearchText && cleanAttr(section.dataset.searchText) === "") {
        textInput.value = "";
        textInput.dataset.value = "";
      }
      const pinQ = near || (pinLat && pinLon ? `${pinLat},${pinLon}` : "");
      if (pinQ) {
        const existingRev = [...section.querySelectorAll<HTMLElement>('[data-live="place_answer"] [data-kind="reverse"]')]
          .find((s) => cleanAttr(s.dataset.q) === pinQ && s.hasAttribute("data-p0") && !s.getAttribute("data-p0")!.startsWith("{"));
        if (!existingRev || cleanAttr(existingRev.dataset.p0) === "") {
          if (existingRev && cleanAttr(existingRev.dataset.p0) === "") {
            existingRev.remove();
            lastAppliedReverseKey = "";
          }
          if (geocoderReverseEl && cleanAttr(geocoderReverseEl.dataset.propQ) === pinQ) {
            geocoderReverseEl.dataset.propQ = "";
            setTimeout(() => {
              if (geocoderReverseEl) geocoderReverseEl.dataset.propQ = pinQ;
            }, 25);
          }
        }
        startSearchWait("reverse", pinQ, true);
      }
    }
    const gpsOff = (near === "" && lastNear !== "") || (pinSrc === "" && lastPinSource === "gps" && near === "");
    if (gpsOff) {
      usedGps = false;
      awaitingGpsFill = false;
      setSearchButtonIdle();
      lastNear = "";
      lastPinLat = "";
      lastPinLon = "";
      lastPinSource = "";
      if (!textEditedByUser && (textInput.value.trim() === lastGpsSearchedText || textInput.value.trim() === "")) {
        textInput.value = "";
        textInput.dataset.value = "";
      }
      lastGpsSearchedText = "";
      setStep("details");
      syncGhostPlaceholder();
    }
    if (near !== "") {
      lastNear = near;
    }
    if (pinLat && pinLon && (pinLat !== lastPinLat || pinLon !== lastPinLon || pinSrc !== lastPinSource)) {
      lastPinLat = pinLat;
      lastPinLon = pinLon;
      lastPinSource = pinSrc;
      setPinStale(false);
    }
    checkPlaceAnswers();
    checkGpsAutoSearch();
    if (mutations.some((m) => m.attributeName === "data-phone-country")) adoptStoredPhoneCountry();
    syncPhoneCountryFromAddress();
    adoptBoundPhone();
    syncCpfValidity();
    if (pendingMapReload && !isConfirming()) {
      applyAddressPinFromAnswers();
    }
    const current = deliveryOf(screen);
    if (mapStage?.dataset.stale === "true" && !usedGps && mandatoryAddressComplete(current)) {
      reloadMapPin();
    }
    scheduleQuote();
  });
  observer.observe(section, {
    attributes: true,
    attributeFilter: [
      "data-step",
      "data-order-id",
      "data-search-text",
      "data-search-q",
      "data-address-q",
      "data-near",
      "data-pin-latitude",
      "data-pin-longitude",
      "data-pin-source",
      "data-pin-stale",
      "data-line2-stale",
      "data-line2-ghost",
      "data-search-stale",
      "data-recipient",
      "data-tax-id",
      "data-phone",
      "data-phone-country",
      "data-line1",
      "data-line2",
      "data-district",
      "data-city",
      "data-region",
      "data-postal",
      "data-country",
    ],
  });
  const textObserver = new MutationObserver(() => {
    checkGpsAutoSearch();
  });
  textObserver.observe(textInput, { attributes: true, attributeFilter: ["data-value", "value"] });
  const offerObserver = new MutationObserver(() => {
    checkPlaceAnswers();
    if (pendingMapReload && !isConfirming()) {
      applyAddressPinFromAnswers();
    }
  });
  for (const slot of screen.querySelectorAll<HTMLElement>('.delivery-offer-slot, [data-live="place_answer"]')) {
    offerObserver.observe(slot, { childList: true, subtree: true, attributes: true });
  }
  const suggestions = screen.querySelector<HTMLElement>("#delivery-suggestions")!;
  const closeSuggestionsLabel = screen.querySelector<HTMLElement>(".delivery-suggestions-close");
  const countrySelect = screen.querySelector<HTMLSelectElement>("#delivery-country");
  const countryField = screen.querySelector<HTMLElement>(".f-country");
  const phoneInput = screen.querySelector<HTMLInputElement>("#delivery-phone");
  const phoneField = screen.querySelector<HTMLElement>(".f-phone");
  const cpfInput = screen.querySelector<HTMLInputElement>("#delivery-cpf");
  const cpfField = screen.querySelector<HTMLElement>(".f-cpf");
  function syncCpfValidity() {
    if (!cpfInput || !cpfField) return;
    const raw = cpfInput.value;
    const v = raw.trim();
    if ((raw.length > 0 && v === "") || (v && !validBrazilCpf(v))) cpfField.dataset.invalid = "true";
    else delete cpfField.dataset.invalid;
  }
  if (cpfInput) {
    cpfInput.addEventListener("input", (e) => {
      const deleting = Boolean((e as InputEvent).inputType?.startsWith("delete"));
      const d = cpfInput.value.replace(/\D/g, "").slice(0, 11);
      if (!deleting && d.length > 0) {
        const formatted = d.length <= 3
          ? d
          : d.length <= 6
          ? `${d.slice(0, 3)}.${d.slice(3)}`
          : d.length <= 9
          ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`
          : `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
        if (formatted !== cpfInput.value) {
          cpfInput.value = formatted;
          cpfInput.dataset.value = formatted;
        }
      }
      section.dataset.taxId = cpfInput.value.trim();
      syncCpfValidity();
    }, { signal });
    syncCpfValidity();
  }
  const SHORTLIST_COUNTRIES: CountryCode[] = ["BR", "AR", "IL", "US", "GB", "CN", "IN"];
  const countryFlag = (cc: string) =>
    cc.toUpperCase().replace(/./g, (ch) => String.fromCodePoint(127397 + ch.charCodeAt(0)));
  // The row's phone_country is the picker's own choice (a pick, an arriving
  // code), bound to the picker and mirrored on the section; empty, the picker
  // follows the address.
  const storedPhoneCountry = (): CountryCode | null => {
    const c = cleanAttr(section.dataset.phoneCountry);
    return validPhoneCountry(c) ? c : null;
  };
  let phoneCountryOverridden = storedPhoneCountry() !== null;
  let phoneCountry: CountryCode = (() => {
    const c = storedPhoneCountry() ?? (cleanAttr(section.dataset.country) || countrySelect?.value || effectiveCountry(deliveryOf(screen)));
    return validPhoneCountry(c) ? c : "US";
  })();
  // The row's control is a native select (print.html): its change is a
  // native source the machine's arrow reads, keyboards and readers pick from
  // it, and the button is its pointer face.
  const phoneCountrySelect = screen.querySelector<HTMLSelectElement>("#delivery-phone-country");
  let phoneCountryBtn: HTMLButtonElement | null = null;
  let phoneCountryMenu: HTMLElement | null = null;
  const phoneLang = document.documentElement.lang || "en";
  let phoneDisplayNames: Intl.DisplayNames | null = null;
  try {
    phoneDisplayNames = new Intl.DisplayNames([phoneLang], { type: "region" });
  } catch {
    phoneDisplayNames = null;
  }
  const nameOf = (cc: CountryCode) =>
    screen.querySelector<HTMLOptionElement>(`#delivery-country option[value="${cc}"]`)?.textContent?.trim() ||
    phoneDisplayNames?.of(cc) ||
    cc;
  const addressPhoneCountry = (): CountryCode => {
    const c = cleanAttr(section.dataset.country) || countrySelect?.value || effectiveCountry(deliveryOf(screen));
    return validPhoneCountry(c) ? c : "US";
  };
  function updatePhoneCountryBtn() {
    if (!phoneCountryBtn) return;
    phoneCountryBtn.dataset.phoneCountry = phoneCountry;
    phoneCountryBtn.textContent = `${countryFlag(phoneCountry)} +${getCountryCallingCode(phoneCountry)}`;
    // The empty option is the address's country, whichever that is now.
    const follows = phoneCountrySelect?.options[0];
    if (follows && follows.value === "") {
      const addr = addressPhoneCountry();
      follows.textContent = `${countryFlag(addr)} ${nameOf(addr)} +${getCountryCallingCode(addr)}`;
    }
  }
  // A choice is the row's: the select's value changes and its change arrow
  // writes phone_country (print.html's machine). One the row already holds
  // (a reload re-reading the bound number) writes nothing.
  function choosePhoneCountry(cc: CountryCode) {
    phoneCountry = cc;
    phoneCountryOverridden = true;
    updatePhoneCountryBtn();
    if (!phoneCountrySelect || phoneCountrySelect.value === cc) return;
    phoneCountrySelect.value = cc;
    phoneCountrySelect.dispatchEvent(new Event("change", { bubbles: true }));
  }
  // The row's phone_country arrives as phone does: another tab's pick, a
  // reload. Empty hands the picker back to the address.
  function adoptStoredPhoneCountry() {
    const stored = storedPhoneCountry();
    if (phoneCountrySelect) phoneCountrySelect.value = stored ?? "";
    if (stored) {
      if (stored === phoneCountry && phoneCountryOverridden) return;
      phoneCountry = stored;
      phoneCountryOverridden = true;
      updatePhoneCountryBtn();
    } else if (phoneCountryOverridden) {
      phoneCountryOverridden = false;
      syncPhoneCountryFromAddress();
    }
  }
  function syncPhoneCountryFromAddress() {
    if (phoneCountryOverridden) return;
    const c = cleanAttr(section.dataset.country) || countrySelect?.value || effectiveCountry(deliveryOf(screen));
    if (validPhoneCountry(c) && c !== phoneCountry) {
      phoneCountry = c;
      updatePhoneCountryBtn();
    }
  }
  function closePhoneCountryMenu() {
    if (phoneCountryMenu) phoneCountryMenu.hidden = true;
  }
  // The picker holds the calling code and the input the national number. A
  // value that arrives with its code (browser autofill, a pasted or picked
  // contact, a typed "+55") hands the code to the picker and keeps the rest:
  // the field never shows one code twice, and the number keeps its room.
  function formatPhoneInput(isDeleting: boolean) {
    if (!phoneInput) return;
    const raw = phoneInput.value;
    const trimmed = raw.trim();
    if (!trimmed) return;
    const arriving = new AsYouType(phoneCountry);
    arriving.input(trimmed);
    const detected = arriving.getCountry();
    // An IDD prefix ("0055 11…") reads as international too, with a code
    // libphonenumber can misread: without a "+", only a number it names a
    // country for moves.
    if (arriving.isInternational() && (trimmed.startsWith("+") || detected)) {
      const code = arriving.getCallingCode();
      const country = detected && validPhoneCountry(detected)
        ? detected
        : code === undefined
        ? undefined
        : getCountryCallingCode(phoneCountry) === code
        ? phoneCountry
        : primaryPhoneCountry(code);
      // A bare "+", a code still being typed, or one no country owns: the
      // text stands as typed, and is sent as typed.
      if (!country) return;
      choosePhoneCountry(country);
      const national = arriving.getNationalNumber();
      const formatted = national ? new AsYouType(phoneCountry).input(national) : "";
      phoneInput.value = formatted;
      phoneInput.dataset.value = formatted;
      return;
    }
    if (isDeleting) return;
    const digits = raw.replace(/\D/g, "");
    if (digits.length >= 2) {
      const ayt = new AsYouType(phoneCountry);
      const formatted = ayt.input(digits);
      if (formatted && formatted !== raw) {
        phoneInput.value = formatted;
        phoneInput.dataset.value = formatted;
      }
    }
  }
  // The row binds the box's value as a property, with no event: a reload,
  // or a draft written while the box still carried the code, arrives here as
  // autofill does. A focused box is the reader's; its input arrow has it.
  function adoptBoundPhone() {
    if (!phoneInput || document.activeElement === phoneInput) return;
    const bound = new AsYouType(phoneCountry);
    bound.input(phoneInput.value.trim());
    if (bound.isInternational()) formatPhoneInput(false);
  }
  if (phoneInput && phoneField) {
    if (phoneCountrySelect) {
      const follows = document.createElement("option");
      follows.value = "";
      phoneCountrySelect.replaceChildren(
        follows,
        ...ALL_PHONE_COUNTRIES.map((cc) => {
          const option = document.createElement("option");
          option.value = cc;
          option.textContent = `${countryFlag(cc)} ${nameOf(cc)} +${getCountryCallingCode(cc)}`;
          return option;
        }),
      );
      phoneCountrySelect.value = storedPhoneCountry() ?? "";
      // A pick made on the select itself (a keyboard, a reader): the machine
      // has the change; the picker follows.
      phoneCountrySelect.addEventListener("change", () => {
        const picked = phoneCountrySelect.value;
        if (validPhoneCountry(picked)) {
          phoneCountry = picked;
          phoneCountryOverridden = true;
          updatePhoneCountryBtn();
        } else {
          phoneCountryOverridden = false;
          syncPhoneCountryFromAddress();
        }
      });
    }
    phoneCountryBtn = document.createElement("button");
    phoneCountryBtn.type = "button";
    phoneCountryBtn.className = "delivery-phone-country-btn";
    phoneCountryBtn.tabIndex = -1;
    phoneCountryBtn.setAttribute("aria-hidden", "true");
    updatePhoneCountryBtn();
    phoneField.append(phoneCountryBtn);
    adoptBoundPhone();
    const renderPhoneCountryList = (listEl: HTMLElement, filterText: string) => {
      listEl.replaceChildren();
      const q = filterText.trim().toLowerCase();
      const makeOption = (cc: CountryCode) => {
        const dial = `+${getCountryCallingCode(cc)}`;
        const name = nameOf(cc);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "delivery-country-option delivery-phone-country-option";
        btn.dataset.phoneCountryValue = cc;
        btn.setAttribute("role", "option");
        btn.setAttribute("aria-selected", String(phoneCountry === cc));
        const labelSpan = document.createElement("span");
        labelSpan.textContent = `${countryFlag(cc)} ${name}`;
        const codeSpan = document.createElement("span");
        codeSpan.className = "delivery-phone-country-code";
        codeSpan.textContent = dial;
        btn.append(labelSpan, codeSpan);
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          choosePhoneCountry(cc);
          closePhoneCountryMenu();
          if (phoneInput.value.trim() && !phoneInput.value.trim().startsWith("+")) {
            const digits = phoneInput.value.replace(/\D/g, "");
            if (digits) {
              const formatted = new AsYouType(phoneCountry).input(digits) || digits;
              phoneInput.value = formatted;
              phoneInput.dataset.value = formatted;
              phoneInput.dispatchEvent(new Event("input", { bubbles: true }));
            }
          }
          phoneInput.focus();
        });
        return btn;
      };
      const sortedRest = ALL_PHONE_COUNTRIES
        .filter((cc) => !SHORTLIST_COUNTRIES.includes(cc))
        .sort((a, b) => nameOf(a).localeCompare(nameOf(b), phoneLang));
      if (!q) {
        for (const cc of SHORTLIST_COUNTRIES) listEl.append(makeOption(cc));
        const div = document.createElement("div");
        div.className = "delivery-phone-country-divider";
        listEl.append(div);
        for (const cc of sortedRest) listEl.append(makeOption(cc));
      } else {
        const matches = [...SHORTLIST_COUNTRIES, ...sortedRest].filter((cc) => {
          const dial = `+${getCountryCallingCode(cc)}`;
          return cc.toLowerCase().includes(q) || dial.includes(q) || nameOf(cc).toLowerCase().includes(q);
        });
        for (const cc of matches) listEl.append(makeOption(cc));
      }
    };
    const openPhoneCountryMenu = () => {
      if (!phoneCountryMenu) {
        phoneCountryMenu = document.createElement("div");
        phoneCountryMenu.className = "delivery-phone-country-menu";
        phoneCountryMenu.setAttribute("role", "listbox");
        const searchIn = document.createElement("input");
        searchIn.type = "search";
        searchIn.className = "delivery-phone-country-search";
        searchIn.placeholder = "+55, BR, Brasil...";
        const listEl = document.createElement("div");
        listEl.className = "delivery-phone-country-list";
        searchIn.addEventListener("input", (e) => {
          e.stopPropagation();
          renderPhoneCountryList(listEl, searchIn.value);
        });
        searchIn.addEventListener("click", (e) => e.stopPropagation());
        phoneCountryMenu.append(searchIn, listEl);
        phoneField.append(phoneCountryMenu);
      }
      const searchIn = phoneCountryMenu.querySelector<HTMLInputElement>(".delivery-phone-country-search")!;
      const listEl = phoneCountryMenu.querySelector<HTMLElement>(".delivery-phone-country-list")!;
      searchIn.value = "";
      renderPhoneCountryList(listEl, "");
      phoneCountryMenu.hidden = false;
      searchIn.focus();
    };
    phoneCountryBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (phoneCountryMenu && !phoneCountryMenu.hidden) closePhoneCountryMenu();
      else openPhoneCountryMenu();
    }, { signal });
    document.addEventListener("pointerdown", (e) => {
      if (phoneCountryMenu && !phoneCountryMenu.hidden && !phoneField.contains(e.target as Node)) {
        closePhoneCountryMenu();
      }
    }, { signal });
    phoneInput.addEventListener("input", (e) => {
      const inputEv = e as InputEvent;
      formatPhoneInput(Boolean(inputEv.inputType?.startsWith("delete")));
    }, { signal });
    const navWithContacts = navigator as unknown as {
      contacts?: {
        select?: (props: string[], opts: { multiple: boolean }) => Promise<Array<{ tel?: string[]; name?: string[]; email?: string[] }>>;
      };
    };
    if (typeof navWithContacts.contacts?.select === "function") {
      phoneField.dataset.hasContacts = "true";
      const contactsBtn = document.createElement("button");
      contactsBtn.type = "button";
      contactsBtn.className = "delivery-phone-contacts-btn";
      contactsBtn.textContent = "👤";
      contactsBtn.setAttribute(
        "aria-label",
        screen.querySelector('label[for="delivery-phone"]')?.textContent?.trim() || "Contacts",
      );
      contactsBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const picked = await navWithContacts.contacts!.select!(["tel", "name", "email"], { multiple: false });
        const contact = picked?.[0];
        if (!contact) return;
        if (contact.tel?.[0]) {
          phoneInput.value = contact.tel[0].trim();
          phoneInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
        const recEl = screen.querySelector<HTMLInputElement>("#delivery-recipient");
        if (contact.name?.[0] && recEl && !recEl.value.trim()) {
          recEl.value = contact.name[0].trim();
          recEl.dispatchEvent(new Event("input", { bubbles: true }));
        }
        const emEl = screen.querySelector<HTMLInputElement>("#delivery-email");
        if (contact.email?.[0] && emEl && !emEl.value.trim()) {
          emEl.value = contact.email[0].trim();
          emEl.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }, { signal });
      phoneField.append(contactsBtn);
    }
  }
  let countryMenu: HTMLElement | null = null;
  function closeCountryMenu() {
    if (countryMenu) countryMenu.hidden = true;
  }
  function openCountryMenu() {
    if (!countrySelect || !countryField) return;
    if (!countryMenu) {
      countryMenu = document.createElement("div");
      countryMenu.className = "delivery-country-menu";
      countryMenu.setAttribute("role", "listbox");
      countryField.append(countryMenu);
    }
    countryMenu.replaceChildren();
    for (const opt of Array.from(countrySelect.options)) {
      if (!opt.value) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "delivery-country-option";
      btn.dataset.countryValue = opt.value;
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", String(countrySelect.value === opt.value));
      btn.textContent = opt.textContent?.trim() || opt.value;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        countrySelect.value = opt.value;
        section.dataset.country = opt.value;
        countrySelect.dispatchEvent(new Event("input", { bubbles: true }));
        countrySelect.dispatchEvent(new Event("change", { bubbles: true }));
        closeCountryMenu();
      });
      countryMenu.append(btn);
    }
    countryMenu.hidden = !countryMenu.hasChildNodes();
  }
  if (countrySelect && countryField) {
    countrySelect.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (countryMenu && !countryMenu.hidden) closeCountryMenu();
      else openCountryMenu();
      countrySelect.focus();
    }, { signal });
    countrySelect.addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter" || e.key === "ArrowDown") {
        e.preventDefault();
        openCountryMenu();
        countryMenu?.querySelector<HTMLButtonElement>(".delivery-country-option")?.focus();
      } else if (e.key === "Escape") {
        closeCountryMenu();
      }
    }, { signal });
    document.addEventListener("pointerdown", (e) => {
      if (countryMenu && !countryMenu.hidden && !countryField.contains(e.target as Node)) {
        closeCountryMenu();
      }
    }, { signal });
  }
  locateBox?.addEventListener("pointerenter", () => { pointerInLocate = true; }, { signal });
  locateBox?.addEventListener("pointerleave", () => { pointerInLocate = false; }, { signal });
  locateBox?.addEventListener("mouseenter", () => { pointerInLocate = true; }, { signal });
  locateBox?.addEventListener("mouseleave", () => { pointerInLocate = false; }, { signal });
  const markPointerInSearch = () => {
    pointerInSearch = true;
    setTimeout(() => {
      pointerInSearch = false;
    }, 0);
  };
  searchBox.addEventListener("pointerdown", markPointerInSearch, { signal });
  searchBox.addEventListener("mousedown", markPointerInSearch, { signal });
  function readSuggestionParts(el: HTMLElement): SuggestionParts {
    const lineEl = el.querySelector<HTMLElement>(".delivery-suggestion-line");
    const metaEl = el.querySelector<HTMLElement>(".delivery-suggestion-meta, .delivery-suggestion-place");
    const rawLine1 = cleanAttr(el.dataset.line1) || cleanAttr(el.dataset.baseStreet) || lineEl?.textContent?.trim() || "";
    const committed = cleanAttr(el.dataset.numberCommitted);
    return {
      id: cleanAttr(el.dataset.id) || "s0",
      line1: committed || rawLine1,
      district: cleanAttr(el.dataset.district),
      city: cleanAttr(el.dataset.city),
      region: cleanAttr(el.dataset.region),
      postalCode: cleanAttr(el.dataset.postal),
      country: cleanAttr(el.dataset.country),
      label: cleanAttr(el.dataset.label) || metaEl?.textContent?.trim() || "",
    };
  }
  function acceptSuggestionElement(item: HTMLButtonElement, overrideLine1?: string, shouldClick = true) {
    const allSuggestions = [...suggestions.querySelectorAll<HTMLElement>(".delivery-suggestion")].map(readSuggestionParts);
    const chosen = readSuggestionParts(item);
    const lat = cleanAttr(item.dataset.latitude);
    const lon = cleanAttr(item.dataset.longitude);
    const country = chosen.country || cleanAttr(section.dataset.country) || effectiveCountry(deliveryOf(screen));
    const rawStreet = cleanAttr(item.dataset.baseStreet) || chosen.line1;
    const committed = overrideLine1 || cleanAttr(item.dataset.numberCommitted);
    let effectiveLine1 = committed || rawStreet;
    if (!committed && isMissingStreetNumber(rawStreet)) {
      const typedNum = extractTypedNumber(textInput.value, rawStreet);
      if (typedNum) {
        effectiveLine1 = formatStreetWithNumber(rawStreet, typedNum, country);
      }
    }
    const completed = disambiguatedSearchText(chosen, effectiveLine1, allSuggestions);
    clearTimeout(typingSearchTimer);
    typingSearchTimer = undefined;
    setSearchButtonIdle();
    setSearchStale(false);
    if (completed) {
      ghostAddress = completed;
      if (!textEditedByUser) lastGpsSearchedText = completed;
    }
    if (shouldClick) {
      if (completed) {
        const prevReloading = reloadingPin;
        reloadingPin = true;
        try {
          textInput.value = completed;
          textInput.dataset.value = completed;
          section.dataset.searchText = completed;
          textInput.dispatchEvent(new Event("input", { bubbles: true }));
        } finally {
          reloadingPin = prevReloading;
        }
      }
      item.dataset.accepting = "true";
      try {
        item.click();
      } finally {
        delete item.dataset.accepting;
      }
    }
    const applyDomFields = () => {
      const prevReloading = reloadingPin;
      reloadingPin = true;
      try {
        if (completed) {
          textInput.value = completed;
          textInput.dataset.value = completed;
          section.dataset.searchText = completed;
        }
        if (effectiveLine1) {
          checkLine1ChangedForLine2(effectiveLine1);
          const l1 = screen.querySelector<HTMLInputElement>("#delivery-line1");
          if (l1) {
            l1.value = effectiveLine1;
            section.dataset.line1 = effectiveLine1;
          }
        }
        const syncIfBound = (attrName: string, inputId: string, dataKey: string, val: string) => {
          if (!item.hasAttribute(attrName) || item.getAttribute(attrName)!.startsWith("{")) return;
          const el = screen.querySelector<HTMLInputElement | HTMLSelectElement>(`#${inputId}`);
          if (el && el.value !== val) {
            el.value = val;
          }
          section.dataset[dataKey] = val;
        };
        syncIfBound("data-district", "delivery-district", "district", chosen.district);
        if (chosen.city) {
          syncIfBound("data-city", "delivery-city", "city", chosen.city);
        }
        if (chosen.region) {
          syncIfBound("data-region", "delivery-region", "region", chosen.region);
        }
        if (chosen.postalCode) {
          syncIfBound("data-postal", "delivery-postal", "postal", chosen.postalCode);
        }
        if (chosen.country) {
          syncIfBound("data-country", "delivery-country", "country", chosen.country);
        }
        if (validCoord(lat) && validCoord(lon)) {
          section.dataset.pinLatitude = lat;
          section.dataset.pinLongitude = lon;
          section.dataset.pinSource = "search";
        }
        setPinStale(false);
        setStep("details");
        for (const offer of screen.querySelectorAll(".delivery-offer")) {
          offer.remove();
        }
        syncGhostPlaceholder();
      } finally {
        reloadingPin = prevReloading;
      }
      scheduleQuote();
    };
    applyDomFields();
    queueMicrotask(applyDomFields);
  }
  closeSuggestionsLabel?.addEventListener("click", () => {
    clearTimeout(typingSearchTimer);
    typingSearchTimer = undefined;
    const editingItem = suggestions.querySelector<HTMLButtonElement>('[data-editing-number="true"]');
    const numInput = editingItem?.querySelector<HTMLInputElement>(".delivery-suggestion-number-input");
    if (editingItem && numInput?.value.trim()) {
      numInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      return;
    }
    if (editingItem) delete editingItem.dataset.editingNumber;
    const numbered = suggestions.querySelector<HTMLButtonElement>(".delivery-suggestion[data-number-committed]");
    if (numbered) acceptSuggestionElement(numbered, undefined, true);
    else setStep("details");
  }, { signal });
  searchBtn.addEventListener("click", () => {
    if (!internalSearchBtnClick) {
      submitManualSearch(false);
    }
  }, { signal });
  const onSearchFocusOrClick = () => {
    setSearchStale(false);
    if (textInput.value.trim() !== "") {
      setStep("search");
    } else {
      syncGhostPlaceholder();
    }
  };
  textInput.addEventListener("focus", onSearchFocusOrClick, { signal });
  textInput.addEventListener("click", onSearchFocusOrClick, { signal });
  textInput.addEventListener("blur", () => {
    clearTimeout(typingSearchTimer);
    typingSearchTimer = undefined;
  }, { signal });
  textInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      submitManualSearch(false);
      return;
    }
    if (
      textInput.value === "" &&
      ghostAddress !== "" &&
      (event.key === "Tab" || event.key === "ArrowRight" || event.key === "ArrowLeft")
    ) {
      event.preventDefault();
      textInput.value = ghostAddress;
      textInput.dataset.value = ghostAddress;
      textEditedByUser = false;
      syncGhostPlaceholder();
      textInput.dispatchEvent(new Event("input", { bubbles: true }));
      triggerSearchClick(false);
    }
  }, { signal });
  const pickFirstSuggestionOnBlur = (event: FocusEvent) => {
    const related = event.relatedTarget as Node | null;
    if (pointerInSearch) return;
    if (pointerInLocate && (!related || locateBox?.contains(related))) return;
    if (related && searchBox.contains(related)) return;
    if (document.activeElement && searchBox.contains(document.activeElement) && document.activeElement !== textInput && !document.activeElement.classList.contains("delivery-suggestion-number-input")) return;
    const editingItem = suggestions.querySelector<HTMLButtonElement>('[data-editing-number="true"]');
    if (editingItem) {
      const numInput = editingItem.querySelector<HTMLInputElement>(".delivery-suggestion-number-input");
      if (numInput?.value.trim()) {
        numInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        return;
      }
      delete editingItem.dataset.editingNumber;
    }
    if (section.dataset.step !== "search") return;
    const first = suggestions.querySelector<HTMLButtonElement>('.delivery-suggestion[data-id="s0"], .delivery-suggestion');
    if (!first) {
      setStep("details");
      return;
    }
    acceptSuggestionElement(first, undefined, true);
  };
  searchBox.addEventListener("focusout", pickFirstSuggestionOnBlur, { signal });
  const suggestionObserver = new MutationObserver(() => decorateSuggestions());
  function decorateSuggestions() {
    suggestionObserver.disconnect();
    try {
      const items = suggestions.querySelectorAll<HTMLButtonElement>(".delivery-suggestion");
      if (
        section.dataset.step === "search" &&
        items.length > 0 &&
        document.activeElement instanceof HTMLIFrameElement
      ) {
        pointerInLocate = false;
        document.activeElement.blur();
        globalThis.focus();
        textInput.focus({ preventScroll: true });
      }
      if (items.length > 0 && pendingSearchKind === "search") {
        setSearchButtonIdle();
        flashButton(searchBtn, 260);
      }
      for (const item of items) {
        const lineEl = item.querySelector<HTMLElement>(".delivery-suggestion-line");
        if (!lineEl) continue;
        const metaEl = item.querySelector<HTMLElement>(".delivery-suggestion-meta, .delivery-suggestion-place");
        const rawLine1 = cleanAttr(item.dataset.line1) || lineEl.textContent?.trim() || "";
        const rowKey = `${cleanAttr(item.dataset.q)}|${rawLine1}|${cleanAttr(item.dataset.label) || metaEl?.textContent?.trim() || ""}`;
        if (item.dataset.rowKey !== rowKey) {
          item.dataset.rowKey = rowKey;
          item.dataset.baseStreet = rawLine1;
          delete item.dataset.numberCommitted;
          delete item.dataset.editingNumber;
          delete item.dataset.applyingNumber;
          item.querySelector(".delivery-suggestion-inline-number")?.remove();
        }
        const baseStreet = item.dataset.baseStreet ?? rawLine1;
        item.dataset.baseStreet = baseStreet;
        if (item.dataset.numberCommitted) {
          if (lineEl.textContent !== item.dataset.numberCommitted) {
            lineEl.textContent = item.dataset.numberCommitted;
          }
          item.dataset.missingNumber = "false";
          continue;
        }
        if (!isMissingStreetNumber(baseStreet)) {
          item.dataset.missingNumber = "false";
          item.querySelector(".delivery-suggestion-inline-number")?.remove();
          continue;
        }
        item.dataset.missingNumber = "true";
        if (item.querySelector(".delivery-suggestion-inline-number")) continue;
        const inlineWrap = document.createElement("span");
        inlineWrap.className = "delivery-suggestion-inline-number";
        const chip = document.createElement("span");
        chip.className = "delivery-suggestion-add-number";
        chip.setAttribute("role", "button");
        chip.tabIndex = 0;
        chip.textContent = text("add_number");
        const numInput = document.createElement("input");
        numInput.type = "text";
        numInput.className = "delivery-suggestion-number-input";
        numInput.placeholder = text("number_placeholder");
        numInput.hidden = true;
        const applyNumber = (acceptNow: boolean) => {
          if (item.dataset.applyingNumber === "true") return;
          const num = numInput.value.trim();
          if (!num) return;
          item.dataset.applyingNumber = "true";
          try {
            const country = cleanAttr(item.dataset.country) || cleanAttr(section.dataset.country) || effectiveCountry(deliveryOf(screen));
            const formatted = formatStreetWithNumber(baseStreet, num, country);
            item.dataset.numberCommitted = formatted;
            item.dataset.missingNumber = "false";
            delete item.dataset.editingNumber;
            if (lineEl.textContent !== formatted) {
              lineEl.textContent = formatted;
            }
            chip.hidden = true;
            numInput.hidden = true;
            if (acceptNow) {
              acceptSuggestionElement(item, formatted, true);
            }
          } finally {
            delete item.dataset.applyingNumber;
          }
        };
        const openNumberEditor = (event: Event) => {
          event.preventDefault();
          event.stopPropagation();
          item.dataset.editingNumber = "true";
          chip.hidden = true;
          numInput.hidden = false;
          void numInput.offsetWidth;
          numInput.focus();
        };
        chip.addEventListener("click", openNumberEditor);
        chip.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") openNumberEditor(event);
        });
        numInput.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        numInput.addEventListener("input", (event) => {
          event.stopPropagation();
          const num = numInput.value.trim();
          const country = cleanAttr(item.dataset.country) || cleanAttr(section.dataset.country) || effectiveCountry(deliveryOf(screen));
          if (num) {
            const formatted = formatStreetWithNumber(baseStreet, num, country);
            item.dataset.numberCommitted = formatted;
            const prevReloading = reloadingPin;
            reloadingPin = true;
            try {
              textInput.value = formatted;
              textInput.dataset.value = formatted;
              section.dataset.searchText = formatted;
              textInput.dispatchEvent(new Event("input", { bubbles: true }));
            } finally {
              reloadingPin = prevReloading;
            }
          } else {
            delete item.dataset.numberCommitted;
          }
        });
        numInput.addEventListener("keydown", (event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            applyNumber(true);
          }
        });
        numInput.addEventListener("blur", () => {
          if (item.dataset.editingNumber !== "true") return;
          if (numInput.value.trim()) applyNumber(true);
          else delete item.dataset.editingNumber;
        });
        inlineWrap.append(chip, numInput);
        lineEl.after(inlineWrap);
      }
    } finally {
      suggestionObserver.observe(suggestions, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["data-line1", "data-label", "data-q"],
      });
    }
  }
  decorateSuggestions();
  suggestions.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest(".delivery-suggestion-add-number, .delivery-suggestion-number-input")) return;
    const item = target.closest<HTMLButtonElement>(".delivery-suggestion");
    if (!item || item.dataset.accepting === "true") return;
    acceptSuggestionElement(item, undefined, false);
  }, { signal });
  suggestions.addEventListener("mousedown", (event) => {
    if ((event.target as Element).closest(".delivery-suggestion-number-input")) return;
    if ((event.target as Element).closest(".delivery-suggestion")) event.preventDefault();
  }, { signal });
  searchBtn.addEventListener("mousedown", (event) => event.preventDefault(), { signal });
  screen.querySelector("#btn-checkout-close")!.addEventListener("click", () => {
    panel.close();
  }, { signal });
  panel.addEventListener("close", () => {
    if (payingOrder || receipt?.paymentStatus === "pending") {
      restoreDeliveryInputs(receipt?.delivery);
      closePayment(true);
    }
    panel.hidden = true;
  }, { signal });
  for (
    const button of demo.querySelectorAll<HTMLButtonElement>(
      "[data-demo-result]",
    )
  ) {
    button.addEventListener("click", () => {
      receipt = {
        id: "demo",
        review: review ?? undefined,
        delivery: delivery ?? undefined,
        paymentStatus: button.dataset.demoResult,
        fulfillmentStatus: button.dataset.demoResult === "paid"
          ? "sent"
          : "pending",
      };
      demo.hidden = true;
      renderReceipt();
    }, { signal });
  }
  // Print shop: a file to carry away, through one print dialog, with no order.
  const shopStatus = screen.querySelector<HTMLElement>("#print-shop-status")!;
  const shopDownload = screen.querySelector<HTMLButtonElement>(
    "#btn-shop-download",
  )!;
  const showShop = (message: string, state: string) => {
    shopStatus.textContent = message;
    shopStatus.dataset.state = state;
    shopStatus.setAttribute("role", state === "error" ? "alert" : "status");
  };
  shopDownload.addEventListener("click", async () => {
    if (shopDownload.disabled) return;
    shopDownload.disabled = true;
    showShop(text("shop_preparing"), "preparing");
    try {
      await printShopDeck(screen, signal);
      showShop(text("shop_ready"), "ready");
    } catch (error) {
      if (!disposed) {
        showShop(
          `${text("shop_error")} ${
            error instanceof Error ? error.message : String(error)
          }`,
          "error",
        );
      }
    } finally {
      shopDownload.disabled = false;
    }
  }, { signal });
  screen.querySelector("#btn-shop-copy")!.addEventListener("click", async () => {
    await navigator.clipboard.writeText(
      screen.querySelector("#shop-order-text")!.textContent!.trim(),
    );
    showShop(text("shop_copied"), "copied");
  }, { signal });
  const deckCarousel = screen.querySelector<HTMLElement>(".deck-picker-carousel");
  let deckCarouselObserver: MutationObserver | null = null;
  let deckCarouselResize: ResizeObserver | null = null;
  if (deckCarousel) {
    const stage = deckCarousel.closest<HTMLElement>(".deck-picker-stage") ?? deckCarousel.parentElement!;
    stage.classList.add("deck-picker-stage");
    const makeNav = (dir: "prev" | "next", glyph: string) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `deck-picker-nav deck-picker-nav-${dir}`;
      btn.dataset.dir = dir;
      btn.setAttribute("aria-hidden", "true");
      btn.tabIndex = -1;
      btn.textContent = glyph;
      btn.addEventListener("click", () => {
        const rtl = getComputedStyle(deckCarousel).direction === "rtl";
        const sign = (dir === "next" ? 1 : -1) * (rtl ? -1 : 1);
        const step = Math.max(220, Math.round(deckCarousel.clientWidth * 0.72));
        deckCarousel.scrollBy({ left: sign * step, behavior: "smooth" });
      }, { signal });
      return btn;
    };
    const prevBtn = makeNav("prev", "‹");
    const nextBtn = makeNav("next", "›");
    const navBar = document.createElement("div");
    navBar.className = "deck-picker-nav-bar";
    navBar.append(prevBtn, nextBtn);
    stage.append(navBar);
    const syncCarouselNav = () => {
      const max = Math.max(0, deckCarousel.scrollWidth - deckCarousel.clientWidth);
      const rawLeft = Math.abs(deckCarousel.scrollLeft);
      const canPrev = max > 2 && rawLeft > 2;
      const canNext = max > 2 && rawLeft < max - 2;
      stage.dataset.canPrev = String(canPrev);
      stage.dataset.canNext = String(canNext);
      prevBtn.disabled = !canPrev;
      nextBtn.disabled = !canNext;
    };
    deckCarousel.addEventListener("scroll", syncCarouselNav, { passive: true, signal });
    deckCarousel.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && deckCarousel.scrollWidth > deckCarousel.clientWidth) {
        e.preventDefault();
        deckCarousel.scrollLeft += e.deltaY;
      }
    }, { passive: false, signal });
    deckCarouselObserver = new MutationObserver(() => syncCarouselNav());
    deckCarouselObserver.observe(deckCarousel, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "data-active"],
    });
    if (typeof ResizeObserver !== "undefined") {
      deckCarouselResize = new ResizeObserver(() => syncCarouselNav());
      deckCarouselResize.observe(deckCarousel);
    }
    syncCarouselNav();
  }
  modeOf().then((found) => {
    mode = found;
    screen.dataset.commerceMode = found;
    const urlParams = new URL(location.href).searchParams;
    const order = urlParams.get("order");
    if (!order || mode !== "live") return;
    returnCancelled = urlParams.get("checkout") === "cancelled";
    run(async () => {
      const saved = sessionStorage.getItem(`${receiptKey}:${order}`);
      const row = await rowOf(order);
      const fallbackReview: Review | undefined = saved
        ? JSON.parse(saved)
        : row.title
        ? {
          title: row.title,
          cards: row.cards,
          stock: row.stock,
          layout: layoutFor(row.cards, row.stock, row.country ?? row.delivery?.address.country ?? ""),
          images: [],
        }
        : undefined;
      receipt = receiptOf(row, fallbackReview);
      await open();
      if (
        location.hash === "#print-checkout-payment" &&
        receipt.paymentStatus === "pending" &&
        receipt.checkoutUrl
      ) {
        openPayment(order, receipt.checkoutUrl);
      } else {
        renderReceipt();
        if (!returnCancelled) {
          startReceiptWatch(order, { nudgeAfterMs: 0 });
        }
      }
    });
  }, (error) => {
    if (!disposed) throw error;
  });
  return () => {
    disposed = true;
    stopReceiptWatch();
    observer.disconnect();
    textObserver.disconnect();
    offerObserver.disconnect();
    suggestionObserver.disconnect();
    deckCarouselObserver?.disconnect();
    deckCarouselResize?.disconnect();
    clearTimeout(quoteTimer);
    clearTimeout(burstTimer);
    clearTimeout(typingSearchTimer);
    clearSearchTimers();
    closeCountryMenu();
    closePhoneCountryMenu();
    if (panel.open) panel.close();
  };
}

export { freezePrint } from "./artwork.ts";
