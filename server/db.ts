// The database: the batch and each editor's copy of it. The tables are in db/schema.sql.
import pg from "pg";
import type { z } from "zod";
import type { ContentPage } from "./content.ts";
import type { PageMeta } from "./rules.ts";
import type { Outcome } from "./schemas.ts";

/** Runs queries, and runs a function inside a transaction. Backed by a pool, or by one client. */
export interface Db {
  query: pg.Pool["query"];
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

export function connect(url = process.env.DATABASE_URL): Db {
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.");
  return poolDb(new pg.Pool({ connectionString: url }));
}

function poolDb(pool: pg.Pool): Db {
  return {
    query: pool.query.bind(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(clientDb(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/** One client, already inside a transaction. A nested transaction is a savepoint, so the tests can roll everything back. */
export function clientDb(client: pg.PoolClient, depth = 0): Db {
  return {
    query: client.query.bind(client) as pg.Pool["query"],
    async transaction(fn) {
      const savepoint = `sp${depth}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        const result = await fn(clientDb(client, depth + 1));
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        throw error;
      }
    },
  };
}

/** Locks one page of the editor's copy until the transaction ends, so two writers take turns. */
export async function lockPage(tx: Db, externalId: string, pageId: number): Promise<void> {
  await tx.query(
    `SELECT 1 FROM editors e
     JOIN copies c ON c.editor_id = e.id AND c.reset_at IS NULL
     JOIN copy_pages cp ON cp.copy_id = c.id
     WHERE e.external_id = $1 AND cp.page_id = $2
     FOR UPDATE OF cp`,
    [externalId, pageId],
  );
}

/** Until testers can be told apart, everyone is this one local editor. */
export const LOCAL_EDITOR = "local";

/** The page statuses in the README glossary, by their code in the database. */
export const STATUS_LABELS: Record<string, string> = {
  candidate: "Candidate",
  ready_for_review: "Ready for review",
  needs_manual_fix: "Needs manual fix",
  recommend_retire: "Recommend: retire",
  recommend_redirect: "Recommend: redirect",
  approved_migrate: "Approved: migrate",
  approved_retire: "Approved: retire",
  approved_redirect: "Approved: redirect",
};

/** A page of the editor's copy. The status is its code in the database. */
export interface CopyPage {
  id: number;
  title: string;
  type: string;
  status: string;
  outcome: z.infer<typeof Outcome> | null;
}

export interface CopyPageDetail extends CopyPage {
  /** What the rules need to know about the page: audience, medicine, certification date and path. */
  meta: PageMeta;
  /** The last saved text. */
  body: string;
  /** The text as imported. */
  originalBody: string;
  /** The editor's last save, as a decision id, or null if the page hasn't been saved. */
  lastSave: number | null;
}

/** Loads the pages from content/pages/ into the database, as the batch arrived. */
export async function loadBatch(db: Db, pages: ContentPage[]): Promise<void> {
  const rows = pages.map(({ meta, body }) => ({
    id: meta.id,
    path: meta.path,
    title: meta.title,
    page_type: meta.type,
    audience: meta.audience,
    medicine: meta.medicine ?? null,
    certified: meta.certified,
    body,
  }));
  await db.query(
    `INSERT INTO pages SELECT * FROM json_populate_recordset(null::pages, $1)
     ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path, title = EXCLUDED.title, page_type = EXCLUDED.page_type,
       audience = EXCLUDED.audience, medicine = EXCLUDED.medicine, certified = EXCLUDED.certified, body = EXCLUDED.body`,
    [JSON.stringify(rows)],
  );
}

/** The editor's open copy of the batch. If there is none, opens one with every page a candidate. */
export async function openCopy(db: Db, externalId: string): Promise<CopyPage[]> {
  const editor = await db.query<{ id: string }>(
    `INSERT INTO editors (external_id) VALUES ($1)
     ON CONFLICT (external_id) DO UPDATE SET external_id = EXCLUDED.external_id
     RETURNING id`,
    [externalId],
  );
  const editorId = editor.rows[0].id;
  // One statement, so a copy never exists without its pages.
  await db.query(
    `WITH new_copy AS (
       INSERT INTO copies (editor_id) VALUES ($1)
       ON CONFLICT (editor_id) WHERE reset_at IS NULL DO NOTHING
       RETURNING id
     )
     INSERT INTO copy_pages (copy_id, page_id, body)
     SELECT new_copy.id, pages.id, pages.body FROM new_copy, pages`,
    [editorId],
  );
  return getProgress(db, externalId);
}

// A page of the editor's open copy, with the AI's latest recommended outcome built as JSON.
const COLUMNS = `p.id, p.title, p.page_type AS type, cp.status,
  (SELECT json_strip_nulls(json_build_object('outcome', pr.outcome, 'target', pr.target_page_id, 'reason', pr.reason))
   FROM proposals pr WHERE pr.copy_id = c.id AND pr.page_id = p.id AND pr.kind = 'outcome'
   ORDER BY pr.id DESC LIMIT 1) AS outcome`;
const OPEN_COPY = `FROM editors e
  JOIN copies c ON c.editor_id = e.id AND c.reset_at IS NULL
  JOIN copy_pages cp ON cp.copy_id = c.id
  JOIN pages p ON p.id = cp.page_id
  WHERE e.external_id = $1`;

/** Each page's status and recommended outcome, as the panel shows them. */
export async function getProgress(db: Db, externalId: string): Promise<CopyPage[]> {
  return (await db.query<CopyPage>(`SELECT ${COLUMNS} ${OPEN_COPY} ORDER BY p.id`, [externalId])).rows;
}

/** One page of the editor's open copy, or nothing if the page isn't in it. */
export async function getCopyPage(db: Db, externalId: string, pageId: number): Promise<CopyPageDetail | undefined> {
  const sql = `SELECT ${COLUMNS}, cp.body, p.body AS "originalBody",
    json_strip_nulls(json_build_object('audience', p.audience, 'medicine', p.medicine, 'certified', p.certified::text, 'path', p.path)) AS meta,
    (SELECT max(d.id)::int FROM decisions d WHERE d.copy_id = c.id AND d.page_id = p.id AND d.action = 'save') AS "lastSave"
    ${OPEN_COPY} AND p.id = $2`;
  return (await db.query<CopyPageDetail>(sql, [externalId, pageId])).rows[0];
}

/** Every path a link on the site may point to: the batch's pages, plus the site's other files. */
export async function knownPaths(db: Db, siteFiles: string[]): Promise<Set<string>> {
  const result = await db.query<{ path: string }>("SELECT path FROM pages");
  return new Set([...siteFiles, ...result.rows.map((r) => r.path)]);
}

/** The triage check for exact duplicates: the other pages in the batch whose text as imported is identical. */
export async function findDuplicates(db: Db, pageId: number, text: string): Promise<number[]> {
  const result = await db.query<{ id: number }>("SELECT id FROM pages WHERE id <> $1 AND body = $2 ORDER BY id", [pageId, text]);
  return result.rows.map((r) => r.id);
}

// The editor's open copy of one page ($1 the editor, $2 the page), as the start of a statement.
const COPY_PAGE = `WITH copy_page AS (
  SELECT cp.copy_id, cp.page_id FROM editors e
  JOIN copies c ON c.editor_id = e.id AND c.reset_at IS NULL
  JOIN copy_pages cp ON cp.copy_id = c.id
  WHERE e.external_id = $1 AND cp.page_id = $2
)`;

/**
 * Stores the AI's recommended outcome and sets the page's status, in one statement.
 * A page to migrate stays a candidate until its fixes are proposed (docs/spec.md, "How it works", step 2.5).
 * Returns the new status.
 */
export async function recordOutcome(
  db: Db,
  externalId: string,
  pageId: number,
  { outcome, target, reason }: z.infer<typeof Outcome>,
): Promise<string> {
  const status = { migrate: "candidate", retire: "recommend_retire", redirect: "recommend_redirect" }[outcome];
  await db.query(
    `${COPY_PAGE},
     proposal AS (
       INSERT INTO proposals (copy_id, page_id, kind, outcome, target_page_id, reason)
       SELECT copy_id, page_id, 'outcome', $3, $4, $5 FROM copy_page
       RETURNING copy_id, page_id
     )
     UPDATE copy_pages cp SET status = $6, updated_at = now()
     FROM proposal WHERE cp.copy_id = proposal.copy_id AND cp.page_id = proposal.page_id`,
    [externalId, pageId, outcome, target ?? null, reason, status],
  );
  return status;
}

/** One fixed rule's result, as the audit trail stores it. */
export interface Check {
  ruleId: string;
  passed: boolean;
  reason?: string;
}

/** A fix, a reason the AI can't fix a rule, or a rewrite. */
export interface Change {
  kind: "fix" | "cannot_fix" | "rewrite";
  ruleId?: string;
  attempt?: number;
  original?: string;
  proposed?: string;
  reason?: string;
}

/** A stored change, whether every rule it was checked against passed, and the editor's latest decision on it. */
export interface StoredChange extends Change {
  id: number;
  passed: boolean;
  decision: "accept" | "reject" | null;
  decisionId: number | null;
}

/** Logs the fixed rules' results on a page as it stands ("Prepare for review"). */
export async function logPageChecks(db: Db, externalId: string, pageId: number, checks: Check[], configVersion: string) {
  await db.query(
    `${COPY_PAGE}
     INSERT INTO check_results (copy_id, page_id, ran_on, check_kind, check_id, config_version, passed, reason)
     SELECT copy_id, page_id, 'page', 'fixed_rule', c."ruleId", $3, c.passed, c.reason
     FROM copy_page, json_to_recordset($4) AS c("ruleId" text, passed boolean, reason text)`,
    [externalId, pageId, configVersion, JSON.stringify(checks)],
  );
}

/** Stores one of the AI's changes with the rule results it was checked against, in one statement. */
export async function recordChange(db: Db, externalId: string, pageId: number, change: Change, checks: Check[], configVersion: string) {
  const { kind, ruleId, attempt, original, proposed, reason } = change;
  await db.query(
    `${COPY_PAGE},
     proposal AS (
       INSERT INTO proposals (copy_id, page_id, kind, rule_id, attempt, original_text, proposed_text, reason)
       SELECT copy_id, page_id, $3, $4, $5, $6, $7, $8 FROM copy_page
       RETURNING id, copy_id, page_id
     )
     INSERT INTO check_results (copy_id, page_id, ran_on, proposal_id, check_kind, check_id, config_version, passed, reason)
     SELECT copy_id, page_id, 'proposal', id, 'fixed_rule', c."ruleId", $9, c.passed, c.reason
     FROM proposal, json_to_recordset($10) AS c("ruleId" text, passed boolean, reason text)`,
    [externalId, pageId, kind, ruleId ?? null, attempt ?? null, original ?? null, proposed ?? null, reason ?? null, configVersion, JSON.stringify(checks)],
  );
}

/** The AI's changes to one page, oldest first. A change passed if every rule it was checked against passed. */
export async function getChanges(db: Db, externalId: string, pageId: number): Promise<StoredChange[]> {
  const result = await db.query<StoredChange>(
    `${COPY_PAGE}
     SELECT pr.id::int AS id, pr.kind, pr.rule_id AS "ruleId", pr.attempt, pr.original_text AS original,
            pr.proposed_text AS proposed, pr.reason, COALESCE(bool_and(cr.passed), true) AS passed,
            d.action AS decision, d.id::int AS "decisionId"
     FROM copy_page
     JOIN proposals pr ON pr.copy_id = copy_page.copy_id AND pr.page_id = copy_page.page_id AND pr.kind <> 'outcome'
     LEFT JOIN check_results cr ON cr.proposal_id = pr.id
     LEFT JOIN LATERAL (SELECT action, id FROM decisions WHERE proposal_id = pr.id ORDER BY id DESC LIMIT 1) d ON true
     GROUP BY pr.id, d.action, d.id ORDER BY pr.id`,
    [externalId, pageId],
  );
  return result.rows;
}

export async function setStatus(db: Db, externalId: string, pageId: number, status: string) {
  await db.query(
    `${COPY_PAGE}
     UPDATE copy_pages cp SET status = $3, updated_at = now()
     FROM copy_page WHERE cp.copy_id = copy_page.copy_id AND cp.page_id = copy_page.page_id`,
    [externalId, pageId, status],
  );
}

/** An editor's decision, as the audit trail stores it (db/schema.sql, "decisions"). */
export interface DecisionRecord {
  action: "accept" | "reject" | "save" | "migrate" | "retire" | "redirect";
  proposalId?: number;
  targetPageId?: number;
  originalText?: string;
  finalText?: string;
  note?: string;
}

/**
 * Stores an editor's decision with the rule results it led to, and any new text or status for the page,
 * in one statement.
 */
export async function recordDecision(
  db: Db,
  externalId: string,
  pageId: number,
  decision: DecisionRecord,
  update: { body?: string; status?: string },
  checks: Check[],
  configVersion: string,
) {
  const { action, proposalId, targetPageId, originalText, finalText, note } = decision;
  await db.query(
    `${COPY_PAGE},
     decision AS (
       INSERT INTO decisions (copy_id, page_id, editor_id, proposal_id, action, target_page_id, original_text, final_text, note)
       SELECT copy_id, page_id, (SELECT id FROM editors WHERE external_id = $1), $3, $4, $5, $6, $7, $8 FROM copy_page
       RETURNING id, copy_id, page_id
     ),
     page_update AS (
       UPDATE copy_pages cp SET body = COALESCE($9::text, cp.body), status = COALESCE($10::text, cp.status), updated_at = now()
       FROM decision WHERE cp.copy_id = decision.copy_id AND cp.page_id = decision.page_id AND ($9::text IS NOT NULL OR $10::text IS NOT NULL)
     )
     INSERT INTO check_results (copy_id, page_id, ran_on, decision_id, check_kind, check_id, config_version, passed, reason)
     SELECT copy_id, page_id, 'decision', id, 'fixed_rule', c."ruleId", $11, c.passed, c.reason
     FROM decision, json_to_recordset($12) AS c("ruleId" text, passed boolean, reason text)`,
    [
      externalId, pageId, proposalId ?? null, action, targetPageId ?? null, originalText ?? null, finalText ?? null, note ?? null,
      update.body ?? null, update.status ?? null, configVersion, JSON.stringify(checks),
    ],
  );
}
