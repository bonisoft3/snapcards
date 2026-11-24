// The delivery form takes each country's shape from Google's address data:
// its lines, its names for each field, what its post requires, and what its
// postcodes look like, with Prodigi's own needs on top.
import { countries, css, postalProblem, required, rows } from "../checkout-ui/address-format.ts";

const assertEquals = (actual: unknown, expected: unknown, what = "") => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

Deno.test("each country's lines are its post's, in its order", () => {
  assertEquals(rows("BR"), [["A"], ["D"], ["C", "S"], ["Z"]], "BR");
  assertEquals(rows("US"), [["A"], ["C", "S", "Z"]], "US");
  assertEquals(rows("GB"), [["A"], ["C"], ["Z"]], "GB");
  assertEquals(rows("AR"), [["A"], ["Z", "C"], ["S"]], "AR");
  // Local script order: the postcode first, the street after the district.
  assertEquals(rows("CN"), [["Z"], ["S", "C", "D"], ["A"]], "CN");
  assertEquals(rows(""), [["A"], ["C", "S"], ["Z"]], "no country yet");
});

Deno.test("a field is required where the country's post or Prodigi needs it", () => {
  assertEquals([...required("BR")].sort(), ["A", "C", "S", "Z"], "BR");
  assertEquals([...required("GB")].sort(), ["A", "C", "Z"], "GB");
  // Israel's post asks only street and city; Prodigi posts to a postcode too.
  assertEquals([...required("IL")].sort(), ["A", "C", "Z"], "IL");
});

Deno.test("a postcode that does not look like the country's answers its example", () => {
  assertEquals(postalProblem("BR", "01305-000"), null);
  assertEquals(postalProblem("BR", "01305000"), null);
  assertEquals(postalProblem("BR", "0130"), "40301-110");
  assertEquals(postalProblem("GB", "ec1y 8sy"), null, "case does not matter");
  assertEquals(postalProblem("US", "9501"), "95014");
  // An empty postcode is the gate's to ask for, not a malformed one.
  assertEquals(postalProblem("US", ""), null);
});

// The country select is filled from _printCountries; a country it offers with
// no format here would take the generic form, and one here it does not offer
// is dead weight.
Deno.test("the formats are the countries an order ships to, no more and no fewer", async () => {
  const screen = await Deno.readTextFile(new URL("../screens/print.html", import.meta.url));
  const offered = [...screen.matchAll(/<option value="([A-Z]{2})" data-text="\{msg\.country_/g)].map((m) => m[1]);
  assertEquals([...countries()].sort(), [...offered].sort(), "address-formats.json against the country select:");
});

Deno.test("the print screen lists each country's states by code, and none for a country without", async () => {
  const screen = await Deno.readTextFile(new URL("../screens/print.html", import.meta.url));
  if (!screen.includes('<datalist id="delivery-states-BR">') || !screen.includes('<option value="SP" label="São Paulo">')) throw new Error("no Brazilian states");
  if (screen.includes('id="delivery-states-GB"')) throw new Error("Britain has no states to list");
});

Deno.test("the stylesheet shapes every country the form offers, and the unchosen one", () => {
  const sheet = css();
  for (const country of countries()) {
    if (!sheet.includes(`[data-country="${country}"] .f-A`)) throw new Error(`no rules for "${country}"`);
  }
  // No country, or one with no shape here, takes the generic one.
  if (!sheet.includes(".checkout-delivery .f-A {")) throw new Error("no generic shape");
  // Each kind the data names has a label span to show.
  if (!sheet.includes('[data-country="US"] .f-Z .k:not(.k-zip)')) throw new Error("US postcode is not a ZIP code");
  if (!sheet.includes('[data-country="GB"] .f-S { display: none; }')) throw new Error("GB shows a state");
});
