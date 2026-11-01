// Tests for the fixed rules (private test plan, test 1). Demo cases are in docs/CONTENT.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPage, loadRules, parseRules, type Page } from "./rules.ts";
import { knownPaths, loadPages, loadSiteFiles } from "./content.ts";

const rules = loadRules();
const pages = loadPages();
const known = knownPaths(pages, loadSiteFiles());
const today = new Date("2026-11-01");
const page = (id: number) => pages.find((p) => p.meta.id === id)!;

function failures(p: Page, context = {}) {
  return checkPage(p, rules, { knownPaths: known, today, originalBody: p.body, ...context })
    .filter((r) => !r.passed)
    .map((r) => r.ruleId)
    .sort();
}

/** A page with one change to its text. */
function edited(id: number, from: string | RegExp, to: string): Page {
  const p = page(id);
  const body = p.body.replace(from, to);
  assert.notEqual(body, p.body, `the edit to page ${id} did nothing`);
  return { meta: p.meta, body };
}

test("each demo page fails exactly the rules its demo case says", () => {
  const expected: Record<number, string[]> = {
    1: [],
    2: ["no-claims-list-words"],
    3: ["links-work"],
    4: ["side-effect-statement"],
    5: [],
    6: ["image-alt-text", "medicine-not-drug"],
    7: [],
    8: ["certified-in-two-years"],
    9: ["image-alt-text", "medicine-not-drug"],
    10: ["image-alt-text"],
  };
  for (const p of pages) assert.deepEqual(failures(p), expected[p.meta.id], `page ${p.meta.id}`);
});

test("every rule in the config runs on at least one demo page", () => {
  const ran = new Set(pages.flatMap((p) => checkPage(p, rules, { knownPaths: known, today, originalBody: p.body }).map((r) => r.ruleId)));
  assert.deepEqual([...ran].sort(), rules.rules.map((r) => r.id).sort());
});

test("patient writing rules don't apply to pages for healthcare professionals", () => {
  const ids = checkPage(page(5), rules, { today }).map((r) => r.ruleId);
  for (const id of ["reading-age", "medicine-not-drug", "side-effects-get-or-have", "side-effect-statement"]) {
    assert.ok(!ids.includes(id), id);
  }
});

test("audience: a page that doesn't say who it is for fails", () => {
  assert.deepEqual(failures(edited(7, "This page is for patients.", "")), ["audience-stated"]);
});

test("safe: unqualified safe fails, but protected wording is never checked", () => {
  assert.deepEqual(failures(edited(7, "# Hay fever\n", "# Hay fever\n\nThis treatment is safe.\n")), ["no-unqualified-safe"]);
  const inProtected = edited(1, "<!-- protected -->\nTake one tablet", "<!-- protected -->\nFor your safety, take one tablet");
  assert.deepEqual(failures(inProtected, { originalBody: inProtected.body }), []);
});

test("superlatives and claims fail, and anyone typing clinically proven is caught", () => {
  assert.deepEqual(failures(edited(7, "# Hay fever\n", "# Hay fever\n\nThis is the best treatment.\n")), ["no-unsupported-superlatives"]);
  assert.deepEqual(failures(edited(7, "# Hay fever\n", "# Hay fever\n\nIt is clinically proven.\n")), ["no-claims-list-words"]);
});

test("protected wording: changing a dosage warning fails", () => {
  const changed = edited(1, "Take one tablet once a day.", "Take two tablets once a day.");
  assert.deepEqual(failures(changed, { originalBody: page(1).body }), ["protected-wording-unchanged"]);
});

test("certification: older than two years fails", () => {
  assert.deepEqual(failures(page(8)), ["certified-in-two-years"]);
  const result = checkPage(page(8), rules, { today }).find((r) => r.ruleId === "certified-in-two-years");
  assert.equal(result?.reason, "Last certified 14 February 2023, more than two years ago.");
});

test("reading age: hard prose fails, and protected wording doesn't count", () => {
  const hard = "Pharmacological interventions necessitate comprehensive consideration of contraindications, concomitant administration and individual physiological characteristics.";
  const plain = "This page is for patients. Hay fever is an allergy to pollen.";
  const page = (text: string): Page => ({ meta: { audience: "patients" }, body: `# Hay fever\n\n${plain}\n\n${text}\n` });
  assert.deepEqual(checkPage(page(hard), rules).filter((r) => !r.passed).map((r) => r.ruleId), ["reading-age"]);
  const protectedHard = page(`<!-- protected -->\n${hard}\n<!-- /protected -->`);
  assert.deepEqual(checkPage(protectedHard, rules).filter((r) => !r.passed), []);
});

test("side effects are got or had, not experienced", () => {
  assert.deepEqual(failures(edited(7, "# Hay fever\n", "# Hay fever\n\nYou may experience side effects.\n")), ["side-effects-get-or-have"]);
});

test("headings: one main heading, no skipped levels, sentence case", () => {
  assert.deepEqual(failures(edited(7, "## Causes of hay fever", "# Causes of hay fever")), ["headings"]);
  assert.deepEqual(failures(edited(7, "## Causes of hay fever", "### Causes of hay fever")), ["headings"]);
  assert.deepEqual(failures(edited(7, "## Causes of hay fever", "## Causes Of Hay Fever")), ["headings"]);
});

test("link text: click here fails", () => {
  assert.deepEqual(failures(edited(1, "[Leaflet for Example medicine A]", "[click here]")), ["link-text"]);
});

test("PDF links: a link without (PDF only, [file size]) fails", () => {
  const p = edited(3, "Example medicine A patient leaflet (PDF only, 240KB)", "Example medicine A patient leaflet");
  assert.deepEqual(failures(p), ["links-work", "pdf-link-label"]);
});

test("links: fixing page 3's link to an existing file makes it pass", () => {
  assert.deepEqual(failures(edited(3, "example-medicine-a-leaflet-2021.pdf", "example-medicine-a-leaflet-v2.pdf")), []);
});

test("pasted text: rules that need page details or the site don't run", () => {
  const pasted: Page = { meta: { audience: "patients" }, body: "# My page\n\nThis page is for patients. It is clinically proven.\n" };
  const ids = checkPage(pasted, rules).map((r) => r.ruleId);
  for (const id of ["side-effect-statement", "protected-wording-unchanged", "certified-in-two-years", "links-work"]) {
    assert.ok(!ids.includes(id), id);
  }
  assert.deepEqual(checkPage(pasted, rules).filter((r) => !r.passed).map((r) => r.ruleId), ["no-claims-list-words"]);
});

test("a rule naming an unknown check stops the config loading", () => {
  const bad = "protected_wording: {start: a, end: b}\nrules: [{id: x, name: X, source: s, check: nope}]";
  assert.throws(() => parseRules(bad), /no check called "nope"/);
});
