// The MCP server and its tools. Modelled on ext-apps examples/basic-server-react/server.ts.
// The tools are described in docs/spec.md, "Tools (proposed)".
import { readFile } from "node:fs/promises";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer, type CallToolResult, type ReadResourceResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { knownPaths, loadPages, loadSiteFiles, type ContentPage } from "./content.ts";
import { getCopyPage, getProgress, LOCAL_EDITOR, openCopy, recordOutcome, STATUS_LABELS, type CopyPage, type Db } from "./db.ts";
import { checkPage, loadRules } from "./rules.ts";
import { Batch, Failure, Outcome, PageDetail } from "./schemas.ts";

const rules = loadRules();
const pages = loadPages();
const known = knownPaths(pages, loadSiteFiles());

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

/** Runs the fixed rules on a page's text, against the page as imported. */
function runRules(page: ContentPage, text: string) {
  const results = checkPage({ meta: page.meta, body: text }, rules, { originalBody: page.body, knownPaths: known });
  const failures = results.filter((r) => !r.passed).map((r) => ({ ruleId: r.ruleId, name: r.name, reason: r.reason! }));
  return { rulesChecked: results.length, failures };
}

/** The triage check for exact duplicates: other pages in the batch with the same text. */
const duplicatesOf = (id: number, text: string) => pages.filter((p) => p.meta.id !== id && p.body === text).map((p) => p.meta.id);

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
const notInBatch = (id: number) => error(`There is no page ${id}. The batch has pages 1 to ${pages.length}.`);

export interface ServerOptions {
  db: Db;
  /** Who is using the server. Until testers can be told apart, the one local editor. */
  editor?: string;
}

/** A new server for each request: nothing is kept in memory between requests. */
export function createServer({ db, editor = LOCAL_EDITOR }: ServerOptions): McpServer {
  const server = new McpServer({ name: "Content compliance", version: "0.1.0" });

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

  server.registerTool(
    "check_page",
    {
      title: "Check page",
      description:
        "Runs the fixed rules on a page in the batch and returns each failure with its reason. " +
        "Also says if the page's text is identical to another page in the batch: a fact for triage, not a failure. " +
        "Give text to check a changed version of the page against the same rules.",
      inputSchema: z.object({
        page: z.number().int().describe(`The page's number in the batch, from 1 to ${pages.length}.`),
        text: z.string().optional().describe("The page's text after changes, in Markdown. Leave it out to check the page as imported."),
      }),
      outputSchema: z.object({
        page: z.number(),
        title: z.string(),
        rulesChecked: z.number(),
        failures: z.array(Failure),
        duplicateOf: z.array(z.number()),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ page: id, text }): Promise<CallToolResult> => {
      const page = pages.find((p) => p.meta.id === id);
      if (!page) return notInBatch(id);
      const body = text ?? page.body;
      const { rulesChecked, failures } = runRules(page, body);
      const duplicateOf = duplicatesOf(id, body);
      const heading = `Page ${id}, ${page.meta.type}, ${page.meta.title}:`;
      const summary = failures.length
        ? [`${heading} ${failures.length} of ${rulesChecked} rules fail.`, ...failures.map((f) => `- ${f.name}: ${f.reason}`)]
        : [`${heading} all ${rulesChecked} rules pass.`];
      if (duplicateOf.length) {
        summary.push(`Its text is identical to page ${duplicateOf.join(" and page ")}. This is a fact for triage, not a failure.`);
      }
      return {
        content: [{ type: "text", text: summary.join("\n") }],
        structuredContent: { page: id, title: page.meta.title, rulesChecked, failures, duplicateOf },
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
        page: z.number().int().describe(`The page's number in the batch, from 1 to ${pages.length}.`),
        outcome: z.enum(["migrate", "retire", "redirect"]),
        reason: z.string().min(1).describe("Why, in a sentence or two, in plain English for the editor."),
        target: z.number().int().optional().describe("For a redirect only: the number of the page to redirect to."),
        model: z.string().optional().describe("The AI model making the recommendation, for the audit trail."),
      }),
      outputSchema: z.object({ page: z.number(), outcome: Outcome, status: z.string() }),
    },
    async ({ page: id, outcome, reason, target, model }): Promise<CallToolResult> => {
      if (!pages.some((p) => p.meta.id === id)) return notInBatch(id);
      const saved = await getCopyPage(db, editor, id);
      if (!saved) return error("The batch isn't open yet. Call open_batch first.");
      if (saved.status.startsWith("approved_")) return error(`The editor has already decided page ${id}, so its outcome can't change.`);
      if (outcome === "redirect") {
        if (target === undefined) return error("A redirect needs a target: the number of the page to redirect to.");
        if (target === id) return error("A page can't redirect to itself.");
        if (!pages.some((p) => p.meta.id === target)) return error(`Page ${target} isn't in the batch, so it can't be a redirect target.`);
      } else if (target !== undefined) {
        return error("Only a redirect has a target.");
      }

      const recommended = { outcome, ...(target ? { target } : {}), reason };
      const status = STATUS_LABELS[await recordOutcome(db, editor, id, recommended, model)];
      return {
        content: [{ type: "text", text: `Stored for page ${id}: ${outcomeText(recommended)}. Its status is now "${status}".` }],
        structuredContent: { page: id, outcome: recommended, status },
      };
    },
  );

  // Panel only: the AI can't see or call these.
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

  registerAppTool(
    server,
    "get_page",
    {
      title: "Get page",
      description: "Returns one page of the editor's copy in full: its text, status, rule results and recommended outcome. Panel only.",
      inputSchema: z.object({ page: z.number().int() }),
      outputSchema: PageDetail,
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ page: id }): Promise<CallToolResult> => {
      const page = pages.find((p) => p.meta.id === id);
      const saved = page && (await getCopyPage(db, editor, id));
      if (!page || !saved) return notInBatch(id);
      const { title, type, status, body, outcome } = saved;
      const detail = { id, title, type, audience: page.meta.audience ?? "", status: STATUS_LABELS[status], text: body, outcome };
      return { content: [], structuredContent: { ...detail, ...runRules(page, body) } };
    },
  );

  return server;
}
