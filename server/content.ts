// Loads the demo batch: the pages in content/pages/ and the site's file list.
import { readFileSync, readdirSync } from "node:fs";
import { parse } from "yaml";
import type { Page, PageMeta } from "./rules.ts";

export interface ContentPage extends Page {
  meta: PageMeta & { id: number; title: string; type: string; path: string };
}

const CONTENT = new URL("../content/", import.meta.url);

export function loadPages(dir = new URL("pages/", CONTENT)): ContentPage[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => {
      const raw = readFileSync(new URL(name, dir), "utf8");
      const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!match) throw new Error(`${name} has no front matter`);
      return { meta: parse(match[1]), body: match[2].trim() + "\n" };
    });
}

export function loadSiteFiles(file = new URL("site-files.yml", CONTENT)): string[] {
  return parse(readFileSync(file, "utf8")).files;
}

/** Every path a link on the site may point to: its files and its pages. */
export function knownPaths(pages: ContentPage[], files: string[]): Set<string> {
  return new Set([...files, ...pages.map((p) => p.meta.path)]);
}
