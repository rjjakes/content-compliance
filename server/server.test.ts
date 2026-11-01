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
  const { structured } = await call("check_page", { page: 1, text: body.replace("Take one tablet once a day.", "Take two tablets once a day.") });
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
