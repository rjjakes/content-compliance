// Fixed rules: loads config/rules.yml and checks a page against it.
// What each rule means is in docs/CONTENT.md, "Fixed rules".
import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface PageMeta {
  audience?: string;
  medicine?: string;
  certified?: string;
  path?: string;
}

export interface Page {
  meta: PageMeta;
  body: string;
}

/** What some checks need besides the page. A check without what it needs doesn't run. */
export interface CheckContext {
  /** The page as imported, for the protected wording rule. */
  originalBody?: string;
  /** Every path a link may point to, for the links rule. */
  knownPaths?: Set<string>;
  /** The day certification is measured from. Defaults to today. */
  today?: Date;
}

export interface RuleResult {
  ruleId: string;
  name: string;
  passed: boolean;
  reason?: string;
}

interface Rule {
  id: string;
  name: string;
  source: string;
  check: string;
  message?: string;
  when?: { audience?: string; names_a_medicine?: boolean };
  [setting: string]: unknown;
}

export interface RuleSet {
  protectedWording: { start: string; end: string };
  rules: Rule[];
}

/** A page broken into the parts the checks look at. */
interface Analysed {
  page: Page;
  context: CheckContext;
  protectedMarkers: RuleSet["protectedWording"];
  protectedBlocks: string[];
  /** Lower-case text with protected wording taken out. */
  text: string;
  unprotected: string;
  links: { text: string; target: string }[];
  images: { alt: string; src: string }[];
  headings: { level: number; text: string }[];
}

type Outcome = { status: "pass" } | { status: "fail"; reason: string } | { status: "skip" };
const pass: Outcome = { status: "pass" };
const skip: Outcome = { status: "skip" };
const fail = (reason: string): Outcome => ({ status: "fail", reason });

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const quoted = (words: string[]) => words.map((w) => `"${w}"`).join(", ");
const fill = (message: string, values: Record<string, string>) =>
  message.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? `{${key}}`);

function syllables(word: string): number {
  const w = word.toLowerCase();
  let n = (w.match(/[aeiouy]+/g) ?? []).length;
  if (w.endsWith("e") && n > 1 && !w.endsWith("le")) n -= 1;
  return Math.max(n, 1);
}

/** Flesch-Kincaid grade plus 5, which turns a US school grade into an age. */
function readingAge(prose: string): number {
  const sentences = prose.split("\n").flatMap((l) => l.trim().split(/(?<=[.!?])\s+/)).filter((s) => /\w/.test(s));
  const words = prose.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  if (!words.length || !sentences.length) return 0;
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  return 0.39 * (words.length / sentences.length) + 11.8 * (syl / words.length) - 15.59 + 5;
}

const CHECKS: Record<string, (rule: Rule, a: Analysed) => Outcome> = {
  protected_text_includes(rule, a) {
    const includes = rule.includes as string[];
    return a.protectedBlocks.some((b) => includes.every((s) => b.includes(s))) ? pass : fail(rule.message!);
  },

  text_includes_one_of(rule, a) {
    return (rule.phrases as string[]).some((p) => a.text.includes(p)) ? pass : fail(rule.message!);
  },

  no_words(rule, a) {
    const found = (rule.words as string[]).filter((w) => new RegExp(`\\b${escapeRegExp(w)}\\b`).test(a.text));
    return found.length ? fail(fill(rule.message!, { words: quoted(found) })) : pass;
  },

  no_pattern(rule, a) {
    return new RegExp(rule.pattern as string).test(a.text) ? fail(rule.message!) : pass;
  },

  protected_wording_unchanged(rule, a) {
    const original = a.context.originalBody;
    if (original === undefined) return skip;
    const before = protectedBlocksOf(original, a.protectedMarkers);
    return before.every((b) => a.protectedBlocks.includes(b)) ? pass : fail(rule.message!);
  },

  certified_within(rule, a) {
    const certified = a.page.meta.certified;
    if (!certified) return skip;
    const cutoff = new Date(a.context.today ?? new Date());
    cutoff.setFullYear(cutoff.getFullYear() - (rule.years as number));
    const date = new Date(certified);
    if (date >= cutoff) return pass;
    const shown = date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
    return fail(fill(rule.message!, { date: shown }));
  },

  reading_age(rule, a) {
    const prose = a.unprotected
      .split("\n")
      .filter((l) => l.trim() && !/^(#|!|<!--)/.test(l))
      .map((l) => l.replace(/^- /, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"))
      .join("\n");
    const age = readingAge(prose);
    return age > (rule.max as number) ? fail(fill(rule.message!, { age: age.toFixed(1) })) : pass;
  },

  image_alt_text(rule, a) {
    const missing = a.images.filter((i) => !i.alt.trim()).map((i) => i.src);
    return missing.length ? fail(fill(rule.message!, { image: missing.join(", ") })) : pass;
  },

  headings(rule, a) {
    const messages = rule.messages as Record<string, string>;
    const allowed = new Set(rule.allowed_capitals as string[]);
    const levels = a.headings.map((h) => h.level);
    if (levels.filter((l) => l === 1).length !== 1 || levels[0] !== 1) return fail(messages.main_heading);
    if (levels.some((l, i) => i > 0 && l - levels[i - 1] > 1)) return fail(messages.skipped_level);
    const wrong = a.headings.find((h) =>
      h.text.split(" ").slice(1).some((w) => /^[A-Z]/.test(w) && !allowed.has(w.replace(/[:?]$/, ""))),
    );
    return wrong ? fail(fill(messages.sentence_case, { heading: wrong.text })) : pass;
  },

  link_text(rule, a) {
    const banned = rule.banned_text as { contains: string[]; exact: string[] };
    const vague = a.links.find((l) => {
      const t = l.text.trim().toLowerCase();
      return banned.contains.some((c) => t.includes(c)) || banned.exact.includes(t);
    });
    return vague ? fail(fill(rule.message!, { text: vague.text })) : pass;
  },

  pdf_link_label(rule, a) {
    const label = new RegExp(rule.label as string);
    const unlabelled = a.links.find((l) => /\.pdf$/i.test(l.target) && !label.test(l.text));
    return unlabelled ? fail(fill(rule.message!, { text: unlabelled.text })) : pass;
  },

  links_work(rule, a) {
    const known = a.context.knownPaths;
    if (!known) return skip;
    const broken = a.links.find((l) => !/^(https?:|mailto:)/.test(l.target) && !known.has(l.target));
    return broken ? fail(fill(rule.message!, { link: broken.target })) : pass;
  },
};

function protectedPattern(markers: RuleSet["protectedWording"]): RegExp {
  return new RegExp(`${escapeRegExp(markers.start)}([\\s\\S]*?)${escapeRegExp(markers.end)}`, "g");
}

function protectedBlocksOf(body: string, markers: RuleSet["protectedWording"]): string[] {
  return [...body.matchAll(protectedPattern(markers))].map((m) => m[1].trim());
}

function analyse(page: Page, context: CheckContext, markers: RuleSet["protectedWording"]): Analysed {
  const unprotected = page.body.replace(protectedPattern(markers), " ");
  return {
    page,
    context,
    protectedMarkers: markers,
    protectedBlocks: protectedBlocksOf(page.body, markers),
    unprotected,
    text: unprotected.toLowerCase(),
    links: [...page.body.matchAll(/(?<!!)\[([^\]]*)\]\(([^)]*)\)/g)].map((m) => ({ text: m[1], target: m[2] })),
    images: [...page.body.matchAll(/!\[([^\]]*)\]\(([^)]*)\)/g)].map((m) => ({ alt: m[1], src: m[2] })),
    headings: [...page.body.matchAll(/^(#+) (.*)$/gm)].map((m) => ({ level: m[1].length, text: m[2] })),
  };
}

function applies(rule: Rule, meta: PageMeta): boolean {
  const when = rule.when;
  if (!when) return true;
  if (when.audience !== undefined && meta.audience !== when.audience) return false;
  if (when.names_a_medicine !== undefined && Boolean(meta.medicine) !== when.names_a_medicine) return false;
  return true;
}

export function parseRules(yaml: string): RuleSet {
  const config = parse(yaml);
  for (const rule of config.rules as Rule[]) {
    if (!(rule.check in CHECKS)) throw new Error(`Rule ${rule.id}: there is no check called "${rule.check}".`);
  }
  return { protectedWording: config.protected_wording, rules: config.rules };
}

export function loadRules(file: URL = new URL("../config/rules.yml", import.meta.url)): RuleSet {
  return parseRules(readFileSync(file, "utf8"));
}

/** Runs every rule that applies to the page. Rules that don't apply, or can't run, give no result. */
export function checkPage(page: Page, ruleSet: RuleSet, context: CheckContext = {}): RuleResult[] {
  const a = analyse(page, context, ruleSet.protectedWording);
  const results: RuleResult[] = [];
  for (const rule of ruleSet.rules) {
    if (!applies(rule, page.meta)) continue;
    const outcome = CHECKS[rule.check](rule, a);
    if (outcome.status === "skip") continue;
    results.push({
      ruleId: rule.id,
      name: rule.name,
      passed: outcome.status === "pass",
      ...(outcome.status === "fail" ? { reason: outcome.reason } : {}),
    });
  }
  return results;
}
