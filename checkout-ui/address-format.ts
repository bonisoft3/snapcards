// The delivery form's shape for each country, from Google's address data
// (commerce/address-formats.json): which postal fields it has, on which lines,
// what each is called, which are required, and what a postcode looks like.
// The screen's fields stay where the template puts them; a stylesheet built
// from these rules (css()) orders, pairs, names and marks them by the draft's
// country, and the checkout's gate reads required() and postalProblem().
import data from "../commerce/address-formats.json" with { type: "json" };

/** Google's tokens the form has a field for: street (line1, with line2 after
 * it), dependent locality (bairro, district), city, state, postcode. Name,
 * organisation and sorting code have none. */
export type Token = "A" | "D" | "C" | "S" | "Z";
const TOKENS: readonly Token[] = ["A", "D", "C", "S", "Z"];
type Format = {
  fmt: string;
  require: string;
  zip?: string;
  zipex?: string;
  zipName: string;
  stateName: string;
  localityName: string;
  sublocalityName: string;
  states: Record<string, string>;
};
const formats = data.countries as Record<string, Format>;
// No country chosen yet: the fields an address anywhere may need.
const UNCHOSEN: Format = {
  fmt: "%A%n%C %S%n%Z", require: "ACZ", zipName: "postal", stateName: "state", localityName: "city", sublocalityName: "neighborhood", states: {},
};
// Prodigi posts an order to a street, a town and a postcode wherever it goes,
// so those are required even where the country's own post asks less.
const PRODIGI: readonly Token[] = ["A", "C", "Z"];

const formatOf = (country: string): Format => {
  if (country === "") return UNCHOSEN;
  const format = formats[country];
  if (format === undefined) throw new Error(`address-format: no format for ${country}; refresh commerce/address-formats.json`);
  return format;
};
export const countries = (): string[] => Object.keys(formats);
/** Whether the form has the country's shape: an applied search may name one
 * it has not, which the checkout asks the reader to change. */
export const known = (country: string): boolean => country === "" || Object.hasOwn(formats, country);

/** The form's lines, top to bottom, each the fields it holds left to right. */
export function rows(country: string): Token[][] {
  return formatOf(country).fmt.split("%n")
    .map((line) => [...line.matchAll(/%([A-Z])/g)].map((m) => m[1] as Token).filter((t) => TOKENS.includes(t)))
    .filter((line) => line.length > 0);
}

export function required(country: string): Set<Token> {
  const own = [...formatOf(country).require].filter((t): t is Token => TOKENS.includes(t as Token));
  return new Set([...own, ...PRODIGI]);
}

/** The postcode's example when it does not look like the country's, else null. */
export function postalProblem(country: string, value: string): string | null {
  const { zip, zipex } = formatOf(country);
  if (zip === undefined || value === "") return null;
  return new RegExp(`^(?:${zip})$`, "i").test(value.trim()) ? null : zipex!;
}


// What each field is called, by the data's kind: the screen holds one label
// span per kind (.k-<kind>) and shows the country's.
const kinds = (f: Format): Record<Token, string> => ({ A: "street", D: f.sublocalityName, C: f.localityName, S: f.stateName, Z: f.zipName });
export const KINDS: Record<Token, readonly string[]> = {
  A: ["street"],
  D: ["neighborhood", "district", "suburb"],
  C: ["city", "post_town"],
  S: ["state", "province"],
  Z: ["postal", "zip"],
};

// Six columns: a line of one field spans them all, of two half each, of three
// a third each.
const COLUMNS = 6;
function rules(scope: string, f: Format, country: string): string[] {
  const out: string[] = [];
  const lines = rows(country);
  const shown = new Set(lines.flat());
  const must = required(country);
  const kind = kinds(f);
  lines.forEach((line, i) => {
    line.forEach((token, j) => {
      const order = (i + 1) * 10 + j;
      out.push(`${scope} .f-${token} { display: grid; order: ${order}; grid-column: span ${COLUMNS / line.length}; }`);
      // The unit line follows the street, a line of its own.
      if (token === "A") out.push(`${scope} .f-line2 { order: ${order + 1}; }`);
    });
  });
  for (const token of TOKENS) {
    if (!shown.has(token)) out.push(`${scope} .f-${token} { display: none; }`);
    // Shown as well as the others hidden: the generic rules hide this kind
    // wherever the generic name is another.
    out.push(`${scope} .f-${token} .k:not(.k-${kind[token]}) { display: none; }`);
    out.push(`${scope} .f-${token} .k-${kind[token]} { display: inline; }`);
    out.push(`${scope} .f-${token} .delivery-optional { display: ${must.has(token) ? "none" : "inline"}; }`);
    // An empty required field the template could not mark required (its
    // country decides) asks for itself as the always-required ones do.
    if (must.has(token)) {
      out.push(`${scope} .f-${token}:has(input:placeholder-shown) .delivery-need { display: block; }`);
    }
  }
  return out;
}

/** The stylesheet the form's shape lives in, one block per country. */
export function css(): string {
  const scope = (country: string) => `.checkout-delivery[data-country="${country}"]`;
  return [
    "/* generated by checkout-ui/build.ts from commerce/address-formats.json — do not edit */",
    `.delivery-fields { grid-template-columns: repeat(${COLUMNS}, minmax(0, 1fr)); }`,
    ".delivery-fields > * { grid-column: 1 / -1; }",
    ".f-country { order: 0; }",
    // Unscoped: no country yet, or one an applied search named that has no
    // shape here, gets the generic one; a known country's rules outrank it.
    ...rules(".checkout-delivery", UNCHOSEN, ""),
    ...countries().flatMap((country) => rules(scope(country), formatOf(country), country)),
  ].join("\n") + "\n";
}
