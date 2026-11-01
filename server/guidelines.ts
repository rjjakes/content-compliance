// AI guidelines: loads config/guidelines.yml. They guide the AI's suggestions and never fail a page.
// What each guideline means is in docs/CONTENT.md, "AI guidelines".
import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface Guideline {
  id: string;
  guideline: string;
  source?: string;
}

export function parseGuidelines(yaml: string): Guideline[] {
  const guidelines = parse(yaml).guidelines as Guideline[];
  const ids = new Set<string>();
  for (const g of guidelines) {
    if (!g.id || !g.guideline) throw new Error("Every guideline needs an id and its wording.");
    if (ids.has(g.id)) throw new Error(`Guideline ${g.id} appears twice.`);
    ids.add(g.id);
  }
  return guidelines;
}

export function loadGuidelines(file: URL = new URL("../config/guidelines.yml", import.meta.url)): Guideline[] {
  return parseGuidelines(readFileSync(file, "utf8"));
}
