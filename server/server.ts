// The MCP server and its tools. Modelled on ext-apps examples/basic-server-react/server.ts.
// The tools are described in docs/spec.md, "Tools (proposed)".
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer, type CallToolResult, type ReadResourceResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { loadSiteFiles } from "./content.ts";
import {
  findDuplicates, getChanges, getCopyPage, getProgress, knownPaths, LOCAL_EDITOR, logPageChecks, openCopy, recordChange, recordDecision,
  recordOutcome, setStatus, STATUS_LABELS, type CopyPage, type CopyPageDetail, type Db, type StoredChange,
} from "./db.ts";
import { loadGuidelines } from "./guidelines.ts";
import { checkPage, loadRules } from "./rules.ts";
import { Batch, Decision, Failure, Outcome, PageDetail } from "./schemas.ts";

const RULES_FILE = new URL("../config/rules.yml", import.meta.url);
const rules = loadRules(RULES_FILE);
/** Which version of the rules config ran, stored with every logged check. */
const RULES_VERSION = createHash("sha256").update(readFileSync(RULES_FILE)).digest("hex").slice(0, 12);
const guidelines = loadGuidelines();
/** The site's files that aren't pages, for the links rule. The pages themselves come from the database. */
const siteFiles = loadSiteFiles();

const PANEL_URI = "ui://content-compliance/panel.html";
const PANEL_FILE = new URL("../dist/mcp-app.html", import.meta.url);
/** In development, the Vite dev server that serves the panel (npm run dev sets it). */
const PANEL_DEV_URL = process.env.PANEL_DEV_URL;

/** In development, the panel loads its code from the dev server, so the host must allow it. */
const PANEL_CSP = PANEL_DEV_URL && { resourceDomains: [PANEL_DEV_URL], connectDomains: [PANEL_DEV_URL, PANEL_DEV_URL.replace(/^http/, "ws")] };

/**
 * The panel's HTML: the built file, or in development the dev server's page with its script
 * addresses made absolute. A host keeps the HTML it first fetched, but the code behind it then
 * comes from the dev server, so changes show without restarting the host.
 */
async function panelHtml(): Promise<string> {
  if (!PANEL_DEV_URL) {
    return readFile(PANEL_FILE, "utf8").catch(() => {
      throw new Error("The panel isn't built. Run npm run build.");
    });
  }
  const page = await (await fetch(`${PANEL_DEV_URL}/mcp-app.html`)).text();
  return page.replace(/(src="|from ")\//g, `$1${PANEL_DEV_URL}/`);
}

/** Runs the fixed rules on a page's text, against the page as imported. Checks are the results as the audit trail stores them. */
function runRules(page: CopyPageDetail, text: string, known: Set<string>) {
  const results = checkPage({ meta: page.meta, body: text }, rules, { originalBody: page.originalBody, knownPaths: known });
  const failures = results.filter((r) => !r.passed).map((r) => ({ ruleId: r.ruleId, name: r.name, reason: r.reason! }));
  const checks = results.map(({ ruleId, passed, reason }) => ({ ruleId, passed, reason }));
  return { checks, rulesChecked: results.length, failures };
}

/** The page text with the changes the editor has accepted since the last save applied. */
function workingText(saved: CopyPageDetail, changes: StoredChange[]): string {
  let text = saved.body;
  for (const c of changes) {
    const acceptedSinceSave = c.decision === "accept" && c.decisionId! > (saved.lastSave ?? 0);
    if (acceptedSinceSave && c.original && text.split(c.original).length === 2) text = text.split(c.original).join(c.proposed!);
  }
  return text;
}

/**
 * A page's status once the AI has proposed its changes (docs/spec.md, "How it works", step 2.5): ready for review
 * if every failing rule has a fix that passed; needs a manual fix if a rule the AI couldn't fix, or failed twice, is left.
 */
function statusAfterChanges(failing: string[], changes: StoredChange[]): string {
  const fixed = (rule: string) => changes.some((c) => c.kind === "fix" && c.ruleId === rule && c.passed);
  const givenUp = (rule: string) =>
    changes.some((c) => c.kind === "cannot_fix" && c.ruleId === rule) || changes.filter((c) => c.kind === "fix" && c.ruleId === rule).length >= 2;
  const open = failing.filter((rule) => !fixed(rule));
  if (!open.length) return "ready_for_review";
  return open.some(givenUp) ? "needs_manual_fix" : "candidate";
}

/** The batch as the panel shows it: status labels, and how many pages are decided. */
function toBatch(copyPages: CopyPage[]) {
  return {
    total: copyPages.length,
    decided: copyPages.filter((p) => p.status.startsWith("approved_")).length,
    pages: copyPages.map((p) => ({ ...p, status: STATUS_LABELS[p.status] })),
  };
}

const outcomeText = (o: z.infer<typeof Outcome>) => (o.target ? `${o.outcome} to page ${o.target}` : o.outcome);

const error = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });
const notOpen = (id: number) => error(`Page ${id} isn't in the open batch. Call open_batch first.`);
const PAGE_NUMBER = z.number().int().describe("The page's number in the batch.");

export interface ServerOptions {
  db: Db;
  /** Who is using the server. Until testers can be told apart, the one local editor. */
  editor?: string;
}

/** A new server for each request: nothing is kept in memory between requests. */
export function createServer({ db, editor = LOCAL_EDITOR }: ServerOptions): McpServer {
  const server = new McpServer({ name: "Content compliance", version: "0.1.0" });

  // The paths links may point to, loaded once per request.
  let knownPromise: Promise<Set<string>> | undefined;
  const known = () => (knownPromise ??= knownPaths(db, siteFiles));
  /** The fixed rules on a page's text. */
  const check = async (page: CopyPageDetail, text: string) => runRules(page, text, await known());

  registerAppTool(
    server,
    "open_batch",
    {
      title: "Open batch",
      description:
        "Opens the panel where the editor reviews the batch of pages moving to the new site. " +
        "It lists each page with its number, status and any recommended outcome.",
      inputSchema: z.object({}),
      outputSchema: Batch,
      _meta: { ui: { resourceUri: PANEL_URI } },
    },
    async (): Promise<CallToolResult> => {
      const batch = toBatch(await openCopy(db, editor));
      const summary = [
        `The panel shows the batch: ${batch.total} pages, ${batch.decided} decided.`,
        ...batch.pages.map(
          (p) => `- Page ${p.id}, ${p.type}, ${p.title}: ${p.status}${p.outcome ? ` (recommended: ${outcomeText(p.outcome)})` : ""}`,
        ),
      ];
      return { content: [{ type: "text", text: summary.join("\n") }], structuredContent: batch };
    },
  );

  // No border: the panel sits on the conversation, in the host's own colours. The spec lets these
  // settings go on the resource or on its contents; both, in case a host reads only one.
  const ui = { prefersBorder: false, ...(PANEL_CSP ? { csp: PANEL_CSP } : {}) };
  registerAppResource(server, PANEL_URI, PANEL_URI, { mimeType: RESOURCE_MIME_TYPE, _meta: { ui } }, async (): Promise<ReadResourceResult> => ({
    contents: [{ uri: PANEL_URI, mimeType: RESOURCE_MIME_TYPE, text: await panelHtml(), _meta: { ui } }],
  }));

  /** One line per rule failure, after a heading for the page. */
  const failureLines = (page: CopyPageDetail, { rulesChecked, failures }: Awaited<ReturnType<typeof check>>) => {
    const heading = `Page ${page.id}, ${page.type}, ${page.title}:`;
    if (!failures.length) return [`${heading} all ${rulesChecked} rules pass.`];
    return [`${heading} ${failures.length} of ${rulesChecked} rules fail.`, ...failures.map((f) => `- ${f.name}: ${f.reason}`)];
  };

  server.registerTool(
    "check_page",
    {
      title: "Check page",
      description:
        "Runs the fixed rules on a page as the editor's copy holds it, and returns each failure with its reason. " +
        "Also says if the page's text is identical to another page in the batch: a fact for triage, not a failure. " +
        "The results go into the audit trail, so call it once per page when preparing the batch for review. " +
        "To try out changed text, use check_text.",
      inputSchema: z.object({ page: PAGE_NUMBER }),
      outputSchema: z.object({
        page: z.number(),
        title: z.string(),
        rulesChecked: z.number(),
        failures: z.array(Failure),
        duplicateOf: z.array(z.number()),
      }),
    },
    async ({ page: id }): Promise<CallToolResult> => {
      const page = await getCopyPage(db, editor, id);
      if (!page) return notOpen(id);
      const result = await check(page, page.body);
      await logPageChecks(db, page, result.checks, RULES_VERSION);
      const duplicateOf = await findDuplicates(db, id, page.body);
      const summary = failureLines(page, result);
      if (duplicateOf.length) {
        summary.push(`Its text is identical to page ${duplicateOf.join(" and page ")}. This is a fact for triage, not a failure.`);
      }
      return {
        content: [{ type: "text", text: summary.join("\n") }],
        structuredContent: { page: id, title: page.title, rulesChecked: result.rulesChecked, failures: result.failures, duplicateOf },
      };
    },
  );

  server.registerTool(
    "check_text",
    {
      title: "Check text",
      description:
        "Runs the fixed rules on changed text for a page in the batch, and returns each failure with its reason. " +
        "Nothing is stored: use it to try out a fix or a rewrite before proposing it.",
      inputSchema: z.object({
        page: PAGE_NUMBER,
        text: z.string().describe("The page's text after changes, in Markdown."),
      }),
      outputSchema: z.object({ page: z.number(), title: z.string(), rulesChecked: z.number(), failures: z.array(Failure) }),
      annotations: { readOnlyHint: true },
    },
    async ({ page: id, text }): Promise<CallToolResult> => {
      const page = await getCopyPage(db, editor, id);
      if (!page) return notOpen(id);
      const result = await check(page, text);
      return {
        content: [{ type: "text", text: failureLines(page, result).join("\n") }],
        structuredContent: { page: id, title: page.title, rulesChecked: result.rulesChecked, failures: result.failures },
      };
    },
  );

  server.registerTool(
    "recommend_outcome",
    {
      title: "Recommend outcome",
      description:
        "Stores your recommended outcome for one page: migrate, retire or redirect, with a reason the editor will read. " +
        "A redirect names the page to redirect to, which must be another page in the batch. " +
        "Check the page with check_page first. The editor makes the final decision in the panel.",
      inputSchema: z.object({
        page: PAGE_NUMBER,
        outcome: z.enum(["migrate", "retire", "redirect"]),
        reason: z.string().min(1).describe("Why, in a sentence or two, in plain English for the editor."),
        target: z.number().int().optional().describe("For a redirect only: the number of the page to redirect to."),
      }),
      outputSchema: z.object({ page: z.number(), outcome: Outcome, status: z.string() }),
    },
    async ({ page: id, outcome, reason, target }): Promise<CallToolResult> => {
      const saved = await getCopyPage(db, editor, id);
      if (!saved) return notOpen(id);
      if (saved.status.startsWith("approved_")) return error(`The editor has already decided page ${id}, so its outcome can't change.`);
      if (outcome === "redirect") {
        if (target === undefined) return error("A redirect needs a target: the number of the page to redirect to.");
        if (target === id) return error("A page can't redirect to itself.");
        if (!(await getCopyPage(db, editor, target))) return error(`Page ${target} isn't in the batch, so it can't be a redirect target.`);
      } else if (target !== undefined) {
        return error("Only a redirect has a target.");
      }

      const recommended = { outcome, ...(target ? { target } : {}), reason };
      const status = STATUS_LABELS[await recordOutcome(db, saved, recommended)];
      return {
        content: [{ type: "text", text: `Stored for page ${id}: ${outcomeText(recommended)}. Its status is now "${status}".` }],
        structuredContent: { page: id, outcome: recommended, status },
      };
    },
  );

  server.registerTool(
    "propose_fixes",
    {
      title: "Propose fixes",
      description: [
        "Proposes changes to one page you recommended to migrate: a fix for each rule it fails, or why a failure can't be fixed, " +
          "and rewrites that bring the page in line with the AI guidelines below. Read the page with get_page first.",
        "Each fix or rewrite replaces one passage: give the passage exactly as it is now, and its new text. " +
          "The server checks each change on its own: a fix must make its rule pass, and no change may make another rule fail. " +
          "A change that fails is kept for the audit trail but not shown to the editor. Each failing rule gets two tries.",
        "Call it once for every page you recommended to migrate, with no changes if there is nothing to change. " +
          "The editor accepts, edits or rejects each change.",
        "AI guidelines:",
        ...guidelines.map((g) => `- ${g.guideline}`),
      ].join("\n"),
      inputSchema: z.object({
        page: PAGE_NUMBER,
        changes: z.array(
          z.object({
            kind: z.enum(["fix", "cannot_fix", "rewrite"]),
            ruleId: z.string().optional().describe("For a fix or cannot_fix: the failing rule's id, as check_page gives it."),
            original: z.string().optional().describe("For a fix or rewrite: the passage exactly as it is now."),
            proposed: z.string().optional().describe("For a fix or rewrite: the passage's new text."),
            reason: z.string().optional().describe("Why, in plain English for the editor. Required for cannot_fix."),
          }),
        ),
      }),
    },
    async ({ page: id, changes }): Promise<CallToolResult> => {
      // One transaction, with the page locked, so a second call on the same page waits its turn.
      return db.begin(async (tx) => {
        const saved = await getCopyPage(tx, editor, id, { lock: true });
        if (!saved) return notOpen(id);
        if (saved.status.startsWith("approved_")) return error(`The editor has already decided page ${id}.`);
        if (saved.outcome?.outcome !== "migrate") {
          return error(
            saved.outcome
              ? `Page ${id} is recommended to ${saved.outcome.outcome}, so it gets no fixes or rewrites.`
              : `Recommend an outcome for page ${id} first.`,
          );
        }

        const text = saved.body;
        const failing = (await check(saved, text)).failures.map((f) => f.ruleId);
        const tries = new Map<string, number>();
        for (const c of await getChanges(tx, saved)) if (c.kind === "fix") tries.set(c.ruleId!, (tries.get(c.ruleId!) ?? 0) + 1);

        const report: string[] = [];
        for (const { kind, ruleId, original, proposed, reason } of changes) {
          const label = kind === "rewrite" ? `Rewrite of "${original?.slice(0, 40)}…"` : `${kind === "fix" ? "Fix" : "No fix"} for ${ruleId}`;
          if (kind !== "rewrite" && !failing.includes(ruleId!)) {
            report.push(`${label}: refused, page ${id} doesn't fail that rule.`);
            continue;
          }
          if (kind === "cannot_fix") {
            if (!reason) {
              report.push(`${label}: refused, say why it can't be fixed.`);
              continue;
            }
            await recordChange(tx, saved, { kind, ruleId, reason }, [], RULES_VERSION);
            report.push(`${label}: stored. The page needs a manual fix.`);
            continue;
          }
          if (!original || proposed === undefined || text.split(original).length !== 2) {
            report.push(`${label}: refused, the passage must appear exactly once in the page.`);
            continue;
          }
          const attempt = kind === "fix" ? (tries.get(ruleId!) ?? 0) + 1 : undefined;
          if (attempt && attempt > 2) {
            report.push(`${label}: refused, both tries are used. The page needs a manual fix.`);
            continue;
          }
          if (attempt) tries.set(ruleId!, attempt);
          // Checked against the rule it fixes and every rule that passed before, so earlier failures don't count against it.
          const checks = (await check(saved, text.split(original).join(proposed))).checks.filter(
            (c) => c.ruleId === ruleId || !failing.includes(c.ruleId),
          );
          await recordChange(tx, saved, { kind, ruleId, attempt, original, proposed, reason }, checks, RULES_VERSION);
          const broken = checks.filter((c) => !c.passed).map((c) => c.reason);
          report.push(broken.length ? `${label}: failed the rules, not shown to the editor. ${broken.join(" ")}` : `${label}: passed.`);
        }

        const status = statusAfterChanges(failing, await getChanges(tx, saved));
        await setStatus(tx, saved, status);
        report.push(`Page ${id} is now "${STATUS_LABELS[status]}".`);
        return { content: [{ type: "text", text: report.join("\n") }] };
      });
    },
  );

  // Panel only: the AI can't see or call these. People decide.
  registerAppTool(
    server,
    "record_decision",
    {
      title: "Record decision",
      description:
        "Records the editor's decision on a page: accept or reject one of the AI's changes, save the page, " +
        "or approve its outcome. Migrate needs every rule to pass on the saved text. Panel only.",
      inputSchema: z.object({ page: PAGE_NUMBER, decision: Decision }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ page: id, decision }): Promise<CallToolResult> => {
      // One transaction, with the page locked, so a second call on the same page waits its turn.
      return db.begin(async (tx) => {
        const saved = await getCopyPage(tx, editor, id, { lock: true });
        if (!saved) return notOpen(id);
        if (saved.status.startsWith("approved_")) return error(`Page ${id} is already decided.`);
        const changes = await getChanges(tx, saved);
        const text = workingText(saved, changes);
        const { action, note } = decision;

        switch (decision.action) {
          case "accept":
          case "reject": {
            const change = changes.find((c) => c.id === decision.changeId && c.passed && c.kind !== "cannot_fix");
            if (!change) return error("There is no such change on this page.");
            if (action === "accept" && text.split(change.original!).length !== 2) return error("This change no longer fits the page text.");
            await recordDecision(tx, saved, { action, proposalId: change.id, note }, {}, [], RULES_VERSION);
            break;
          }
          case "save": {
            if (text === saved.body) return error("There are no changes to save.");
            const record = { action, originalText: saved.body, finalText: text, note };
            await recordDecision(tx, saved, record, { body: text }, (await check(saved, text)).checks, RULES_VERSION);
            break;
          }
          case "migrate": {
            if (text !== saved.body) return error("Save your changes first.");
            const { checks, failures } = await check(saved, saved.body);
            if (failures.length) return error("A page can migrate only when every rule passes.");
            await recordDecision(tx, saved, { action, note }, { status: "approved_migrate" }, checks, RULES_VERSION);
            break;
          }
          case "retire":
            await recordDecision(tx, saved, { action, note }, { status: "approved_retire" }, [], RULES_VERSION);
            break;
          case "redirect": {
            const { target } = decision;
            if (target === id || !(await getCopyPage(tx, editor, target))) return error("A redirect needs a target: another page in the batch.");
            await recordDecision(tx, saved, { action, targetPageId: target, note }, { status: "approved_redirect" }, [], RULES_VERSION);
            break;
          }
        }
        return { content: [{ type: "text", text: `Recorded: ${action} on page ${id}.` }] };
      });
    },
  );

  registerAppTool(
    server,
    "get_progress",
    {
      title: "Get progress",
      description: "Returns each page's status and recommended outcome, for the panel to show as the AI works. Panel only.",
      inputSchema: z.object({}),
      outputSchema: Batch,
      _meta: { ui: { visibility: ["app"] } },
    },
    async (): Promise<CallToolResult> => ({ content: [], structuredContent: toBatch(await getProgress(db, editor)) }),
  );

  server.registerTool(
    "get_page",
    {
      title: "Get page",
      description:
        "Returns one page of the editor's copy in full: its text, status, rule failures, recommended outcome, " +
        "and the AI's changes that passed the rules.",
      inputSchema: z.object({ page: PAGE_NUMBER }),
      outputSchema: PageDetail,
      annotations: { readOnlyHint: true },
    },
    async ({ page: id }): Promise<CallToolResult> => {
      const saved = await getCopyPage(db, editor, id);
      if (!saved) return notOpen(id);
      const { title, type, status, body, outcome } = saved;
      const stored = await getChanges(db, saved);
      const text = workingText(saved, stored);
      const { rulesChecked, failures } = await check(saved, body);
      const changes = stored
        .filter((c) => c.passed)
        .map(({ id, kind, ruleId, original, proposed, reason, decision }) => ({ id, kind, ruleId, original, proposed, reason, decision }));
      const detail = {
        id, title, type, audience: saved.meta.audience ?? "", status: STATUS_LABELS[status], text, outcome, rulesChecked, failures, changes,
        unsaved: text !== body, pendingFailures: text !== body ? (await check(saved, text)).failures : failures,
      };
      return { content: [{ type: "text", text: JSON.stringify(detail) }], structuredContent: detail };
    },
  );

  return server;
}
