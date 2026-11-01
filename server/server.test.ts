// Tests for the MCP server's tools, called through an MCP client the way the AI and the panel call them.
// They use the database in .env inside one transaction, rolled back at the end, so they leave nothing behind.
// Each test starts from a freshly opened batch and sets up what it needs; a savepoint undoes it afterwards.
import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/server";
import postgres from "postgres";
import { loadPages } from "./content.ts";
import { loadBatch, type Db } from "./db.ts";
import type { Batch, PageDetail } from "./schemas.ts";
import { createServer } from "./server.ts";
import type { z } from "zod";

// One transaction, held open while the tests run and rolled back at the end.
const sql = postgres(process.env.DATABASE_URL!);
let finish!: () => void;
const finished = new Promise<void>((resolve) => (finish = resolve));
const transaction = new Promise<Db>((ready) => {
  sql.begin(async (tx) => {
    ready(tx);
    await finished;
    await tx.rollback();
  });
});
const db = await transaction;
await loadBatch(db, loadPages());

const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await createServer({ db, editor: "test" }).connect(serverSide);
const client = new Client({ name: "test", version: "1.0.0" });
await client.connect(clientSide);
await client.callTool({ name: "open_batch", arguments: {} });

beforeEach(async () => {
  await db`SAVEPOINT each_test`;
});
afterEach(async () => {
  await db`ROLLBACK TO SAVEPOINT each_test`;
});
after(async () => {
  await client.close();
  finish();
  await sql.end();
});

/** Calls a tool and returns its result, with the structured content typed as T. */
async function call<T = unknown>(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { result, structured: result.structuredContent as T };
}
const getPage = async (page: number) => (await call<z.infer<typeof PageDetail>>("get_page", { page })).structured;
const getProgress = async () => (await call<z.infer<typeof Batch>>("get_progress")).structured;
const recommendMigrate = (page: number) => call("recommend_outcome", { page, outcome: "migrate", reason: "Test." });
const decide = (page: number, decision: Record<string, unknown>) => call("record_decision", { page, decision });

/** The passing fix for page 2's claims-list failure, as the AI would propose it. */
const PAGE_2_FIX = { kind: "fix", ruleId: "no-claims-list-words", original: "It is clinically proven to soothe itching", proposed: "It can soothe itching" };

/** How many check results the test editor's copy holds, for all pages or for one page and kind of check. */
async function loggedChecks(pageId?: number, ranOn?: string) {
  const [row] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM check_results cr JOIN copies c ON c.id = cr.copy_id JOIN editors e ON e.id = c.editor_id
    WHERE e.external_id = 'test' ${pageId === undefined ? db`` : db`AND cr.page_id = ${pageId} AND cr.ran_on = ${ranOn!}`}`;
  return row.n;
}

test("open_batch: opens the editor's copy of the batch with every page a candidate", async () => {
  const batch = (await call<z.infer<typeof Batch>>("open_batch")).structured;
  assert.equal(batch.total, 10);
  assert.deepEqual(new Set(batch.pages.map((p) => p.status)), new Set(["Candidate"]));
});

test("check_text: changed text is checked against the page as imported, and nothing is stored", async () => {
  const body = loadPages().find((p) => p.meta.id === 1)!.body;
  const text = body.replace("Take one tablet once a day.", "Take two tablets once a day.");
  const { structured } = await call<{ failures: { ruleId: string }[] }>("check_text", { page: 1, text });
  assert.deepEqual(structured.failures.map((f) => f.ruleId), ["protected-wording-unchanged"]);
  assert.equal(await loggedChecks(), 0);
});

test("check_page: the duplicate check matches page 9 with page 6, but not page 8 with page 7", async () => {
  type Checked = { duplicateOf: number[] };
  assert.deepEqual((await call<Checked>("check_page", { page: 9 })).structured.duplicateOf, [6]);
  assert.deepEqual((await call<Checked>("check_page", { page: 8 })).structured.duplicateOf, []);
});

test("check_page: the results go into the audit trail", async () => {
  await call("check_page", { page: 2 });
  assert.ok((await loggedChecks(2, "page")) > 0);
});

test("recommend_outcome: each outcome sets the page's status, and the panel sees it", async () => {
  await call("recommend_outcome", { page: 8, outcome: "redirect", target: 7, reason: "Older version of page 7." });
  await call("recommend_outcome", { page: 10, outcome: "retire", reason: "The open day is over." });
  await recommendMigrate(7);
  const page = (id: number, pages: z.infer<typeof Batch>["pages"]) => pages.find((p) => p.id === id)!;
  const { pages } = await getProgress();
  assert.equal(page(8, pages).status, "Recommend: redirect");
  assert.deepEqual(page(8, pages).outcome, { outcome: "redirect", target: 7, reason: "Older version of page 7." });
  assert.equal(page(10, pages).status, "Recommend: retire");
  assert.equal(page(7, pages).status, "Candidate");
  assert.equal((await getPage(7)).outcome?.outcome, "migrate");
});

test("recommend_outcome: refuses a redirect to a page that isn't in the batch", async () => {
  const { result } = await call("recommend_outcome", { page: 9, outcome: "redirect", target: 11, reason: "Test." });
  assert.equal(result.isError, true);
});

test("propose_fixes: a page recommended for redirect gets no fixes", async () => {
  await call("recommend_outcome", { page: 8, outcome: "redirect", target: 7, reason: "Test." });
  const { result } = await call("propose_fixes", { page: 8, changes: [] });
  assert.equal(result.isError, true);
});

test("propose_fixes: a fix that fails is kept from the editor and retried; one that passes makes the page ready", async () => {
  await recommendMigrate(2);
  await call("propose_fixes", { page: 2, changes: [{ ...PAGE_2_FIX, proposed: "It is proven to help soothe itching" }] });
  await call("propose_fixes", { page: 2, changes: [PAGE_2_FIX] });
  const page = await getPage(2);
  assert.equal(page.status, "Ready for review");
  assert.deepEqual(page.changes.map((c) => c.proposed), ["It can soothe itching"]);
});

test("propose_fixes: a rewrite that changes protected wording is dropped", async () => {
  await recommendMigrate(1);
  const rewrite = { kind: "rewrite", original: "Take one tablet once a day.", proposed: "Take two tablets once a day." };
  await call("propose_fixes", { page: 1, changes: [rewrite] });
  const page = await getPage(1);
  assert.deepEqual(page.changes, []);
  assert.equal(page.status, "Ready for review");
});

test("propose_fixes: after two failed tries, a rule needs a manual fix", async () => {
  await recommendMigrate(3);
  const fix = (file: string) => ({ kind: "fix", ruleId: "links-work", original: "example-medicine-a-leaflet-2021.pdf", proposed: file });
  await call("propose_fixes", { page: 3, changes: [fix("leaflet-a.pdf"), fix("leaflet-b.pdf")] });
  const { result } = await call("propose_fixes", { page: 3, changes: [fix("leaflet-c.pdf")] });
  assert.match((result.content[0] as { text: string }).text, /both tries are used/);
  assert.equal((await getPage(3)).status, "Needs manual fix");
});

test("record_decision: migrate waits until the accepted fix is saved and every rule passes", async () => {
  await recommendMigrate(2);
  await call("propose_fixes", { page: 2, changes: [PAGE_2_FIX] });
  const migrate = async () => (await decide(2, { action: "migrate" })).result.isError;
  assert.equal(await migrate(), true, "a rule fails");
  await decide(2, { action: "accept", changeId: (await getPage(2)).changes[0].id });
  assert.equal((await getPage(2)).unsaved, true);
  assert.equal(await migrate(), true, "not saved");
  await decide(2, { action: "save" });
  const saved = await getPage(2);
  assert.deepEqual(saved.failures, []);
  assert.match(saved.text, /It can soothe itching/);
  await decide(2, { action: "migrate" });
  assert.equal((await getPage(2)).status, "Approved: migrate");
});

test("record_decision: retire is always allowed, and a redirect needs a target in the batch", async () => {
  await decide(10, { action: "retire" });
  assert.equal((await decide(8, { action: "redirect" })).result.isError, true);
  await decide(8, { action: "redirect", target: 7 });
  const batch = await getProgress();
  const status = (id: number) => batch.pages.find((p) => p.id === id)!.status;
  assert.equal(status(10), "Approved: retire");
  assert.equal(status(8), "Approved: redirect");
  assert.equal(batch.decided, 2);
});
