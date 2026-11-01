// Tests for the MCP server's tools, called through an MCP client the way the AI calls them.
// They use the database in .env, inside a transaction that is rolled back, so they leave nothing behind.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/server";
import { loadPages } from "./content.ts";
import { connect, loadBatch } from "./db.ts";
import { createServer } from "./server.ts";

const pool = connect();
const db = await pool.connect();
await db.query("BEGIN");
await loadBatch(db, loadPages());

const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await createServer({ db, editor: "test" }).connect(serverSide);
const client = new Client({ name: "test", version: "1.0.0" });
await client.connect(clientSide);

after(async () => {
  await client.close();
  await db.query("ROLLBACK");
  db.release();
  await pool.end();
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { result, structured: result.structuredContent as any };
}

test("open_batch: opens the editor's copy of the batch with every page a candidate", async () => {
  const { structured } = await call("open_batch");
  assert.equal(structured.total, 10);
  assert.deepEqual(new Set(structured.pages.map((p: { status: string }) => p.status)), new Set(["Candidate"]));
});

test("check_page: changed text is checked against the page as imported", async () => {
  const body = loadPages().find((p) => p.meta.id === 1)!.body;
  const { structured } = await call("check_text", { page: 1, text: body.replace("Take one tablet once a day.", "Take two tablets once a day.") });
  assert.deepEqual(structured.failures.map((f: { ruleId: string }) => f.ruleId), ["protected-wording-unchanged"]);
});

test("check_page: the duplicate check matches page 9 with page 6, but not page 8 with page 7", async () => {
  assert.deepEqual((await call("check_page", { page: 9 })).structured.duplicateOf, [6]);
  assert.deepEqual((await call("check_page", { page: 8 })).structured.duplicateOf, []);
});

test("recommend_outcome: each outcome sets the page's status, and the panel sees it", async () => {
  await call("recommend_outcome", { page: 8, outcome: "redirect", target: 7, reason: "Older version of page 7." });
  await call("recommend_outcome", { page: 10, outcome: "retire", reason: "The open day is over." });
  await call("recommend_outcome", { page: 7, outcome: "migrate", reason: "Current and passes every rule." });
  const pages = (await call("get_progress")).structured.pages;
  const page = (id: number) => pages.find((p: { id: number }) => p.id === id);
  assert.equal(page(8).status, "Recommend: redirect");
  assert.deepEqual(page(8).outcome, { outcome: "redirect", target: 7, reason: "Older version of page 7." });
  assert.equal(page(10).status, "Recommend: retire");
  assert.equal(page(7).status, "Candidate");
  assert.equal((await call("get_page", { page: 7 })).structured.outcome.outcome, "migrate");
});

test("recommend_outcome: refuses a redirect to a page that isn't in the batch", async () => {
  const { result } = await call("recommend_outcome", { page: 9, outcome: "redirect", target: 11, reason: "Test." });
  assert.equal(result.isError, true);
});

test("check_page: checking the page as it stands goes into the audit trail", async () => {
  await call("check_page", { page: 2 });
  const logged = await db.query(
    `SELECT count(*)::int AS n FROM check_results cr JOIN copies c ON c.id = cr.copy_id JOIN editors e ON e.id = c.editor_id
     WHERE e.external_id = 'test' AND cr.page_id = 2 AND cr.ran_on = 'page'`,
  );
  assert.ok(logged.rows[0].n > 0);
});

test("propose_fixes: a page recommended for redirect gets no fixes", async () => {
  const { result } = await call("propose_fixes", { page: 8, changes: [] });
  assert.equal(result.isError, true);
});

test("propose_fixes: a fix that fails is kept from the editor and retried; one that passes makes the page ready", async () => {
  await call("recommend_outcome", { page: 2, outcome: "migrate", reason: "Test." });
  const fix = (proposed: string) => ({ kind: "fix", ruleId: "no-claims-list-words", original: "It is clinically proven to soothe itching", proposed });
  await call("propose_fixes", { page: 2, changes: [fix("It is proven to help soothe itching")] });
  await call("propose_fixes", { page: 2, changes: [fix("It can soothe itching")] });
  const page = (await call("get_page", { page: 2 })).structured;
  assert.equal(page.status, "Ready for review");
  assert.deepEqual(page.changes.map((c: { proposed: string }) => c.proposed), ["It can soothe itching"]);
});

test("propose_fixes: a rewrite that changes protected wording is dropped", async () => {
  await call("recommend_outcome", { page: 1, outcome: "migrate", reason: "Test." });
  await call("propose_fixes", { page: 1, changes: [{ kind: "rewrite", original: "Take one tablet once a day.", proposed: "Take two tablets once a day." }] });
  const page = (await call("get_page", { page: 1 })).structured;
  assert.deepEqual(page.changes, []);
  assert.equal(page.status, "Ready for review");
});

test("propose_fixes: after two failed tries, a rule needs a manual fix", async () => {
  await call("recommend_outcome", { page: 3, outcome: "migrate", reason: "Test." });
  const fix = (file: string) => ({ kind: "fix", ruleId: "links-work", original: "example-medicine-a-leaflet-2021.pdf", proposed: file });
  await call("propose_fixes", { page: 3, changes: [fix("leaflet-a.pdf"), fix("leaflet-b.pdf")] });
  const { result } = await call("propose_fixes", { page: 3, changes: [fix("leaflet-c.pdf")] });
  assert.match((result.content[0] as { text: string }).text, /both tries are used/);
  assert.equal((await call("get_page", { page: 3 })).structured.status, "Needs manual fix");
});

test("record_decision: migrate waits until the accepted fix is saved and every rule passes", async () => {
  const refused = async () => (await call("record_decision", { page: 2, decision: { action: "migrate" } })).result.isError;
  assert.equal(await refused(), true, "a rule fails");
  const fix = (await call("get_page", { page: 2 })).structured.changes[0];
  await call("record_decision", { page: 2, decision: { action: "accept", changeId: fix.id } });
  assert.equal((await call("get_page", { page: 2 })).structured.unsaved, true);
  assert.equal(await refused(), true, "not saved");
  await call("record_decision", { page: 2, decision: { action: "save" } });
  const saved = (await call("get_page", { page: 2 })).structured;
  assert.deepEqual(saved.failures, []);
  assert.match(saved.text, /It can soothe itching/);
  await call("record_decision", { page: 2, decision: { action: "migrate" } });
  assert.equal((await call("get_page", { page: 2 })).structured.status, "Approved: migrate");
});

test("record_decision: retire is always allowed, and a redirect needs a target in the batch", async () => {
  await call("record_decision", { page: 10, decision: { action: "retire" } });
  assert.equal((await call("record_decision", { page: 8, decision: { action: "redirect" } })).result.isError, true);
  await call("record_decision", { page: 8, decision: { action: "redirect", target: 7 } });
  const batch = (await call("get_progress")).structured;
  const status = (id: number) => batch.pages.find((p: { id: number }) => p.id === id).status;
  assert.equal(status(10), "Approved: retire");
  assert.equal(status(8), "Approved: redirect");
  assert.equal(batch.decided, 3);
});
