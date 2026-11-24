// Refreshes address-formats.json from Google's Address Data Service, the data
// libaddressinput, Chrome and Android build their address forms from (CC-BY
// 4.0). Run by hand when _printCountries changes, naming the same countries:
//   deno run --allow-net --allow-write=commerce commerce/address-formats.ts BR AR IL US GB CN
// Each country keeps only what the delivery form reads, with the service's
// defaults (data/ZZ) written in, so a reader of the file needs no fallbacks.
const SERVICE = "https://chromium-i18n.appspot.com/ssl-address/data/";
const countries = Deno.args;
if (countries.length === 0 || !countries.every((c) => /^[A-Z]{2}$/.test(c))) {
  throw new Error("address-formats: name the countries, ISO 3166-1 alpha-2");
}
type Entry = { [key: string]: string | undefined };
const read = async (key: string): Promise<Entry> => {
  const response = await fetch(`${SERVICE}${key}`);
  if (!response.ok) throw new Error(`address-formats: ${key} answered HTTP ${response.status}`);
  return await response.json();
};
const defaults = await read("ZZ");
const out: { [country: string]: unknown } = {};
for (const country of countries) {
  const d = { ...defaults, ...await read(country) };
  const keys = d.sub_keys?.split("~") ?? [];
  const names = d.sub_names?.split("~") ?? keys;
  out[country] = {
    fmt: d.fmt,
    require: d.require,
    ...(d.zip === undefined ? {} : { zip: d.zip, zipex: d.zipex!.split(",")[0] }),
    zipName: d.zip_name_type,
    stateName: d.state_name_type,
    localityName: d.locality_name_type,
    sublocalityName: d.sublocality_name_type,
    states: Object.fromEntries(keys.map((key, i) => [key, names[i]])),
  };
}
const file = new URL("./address-formats.json", import.meta.url);
await Deno.writeTextFile(file, JSON.stringify({
  source: SERVICE,
  license: "CC-BY 4.0, Google",
  fetched: new Date().toISOString().slice(0, 10),
  countries: out,
}, null, "\t") + "\n");
