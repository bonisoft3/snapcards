import { attrMap, resolveMachineMarkup } from "@bonisoft3/omnishell/interpreter/lint.ts";

const config = JSON.parse(await Deno.readTextFile(new URL("../shell/shell.json", import.meta.url)));

export async function screenMarkup(screen) {
  const route = config.routes.find(route => route.screen === screen);
  if (!route?.files?.html) throw new Error(`No HTML declared for screen ${screen}`);
  const html = await Deno.readTextFile(new URL(`../${route.files.html}`, import.meta.url));
  return resolveMachineMarkup(html, config.cortex?.actors, screen);
}

export const machineAttribute = value => JSON.parse(attrMap(` data-machine='${value}'`).get("data-machine"));
