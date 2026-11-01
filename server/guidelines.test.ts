// Tests for the AI guidelines config. The guidelines are explained in docs/CONTENT.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadGuidelines, parseGuidelines } from "./guidelines.ts";

/** Wording without a trailing source in brackets or full stop, so the docs and the config compare. */
const wording = (s: string) => s.replace(/\s*\([^()]*\)\.?$/, "").replace(/\.$/, "");

test("the config has the same guidelines, in the same words, as docs/CONTENT.md", () => {
  const doc = readFileSync(new URL("../docs/CONTENT.md", import.meta.url), "utf8");
  const section = doc.split("\n## AI guidelines\n")[1].split("\n## ")[0];
  const documented = section.split("\n").filter((l) => l.startsWith("- ")).map((l) => wording(l.slice(2)));
  assert.deepEqual(loadGuidelines().map((g) => wording(g.guideline)), documented);
});

test("a guideline without wording, or an id used twice, stops the config loading", () => {
  assert.throws(() => parseGuidelines("guidelines: [{id: x}]"), /needs an id and its wording/);
  assert.throws(() => parseGuidelines("guidelines: [{id: x, guideline: a}, {id: x, guideline: b}]"), /x appears twice/);
});
