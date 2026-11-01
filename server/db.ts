// The database: the batch and each editor's copy of it. The tables are in db/schema.sql.
import pg from "pg";
import type { z } from "zod";
import type { ContentPage } from "./content.ts";
import type { Outcome } from "./schemas.ts";

/** A connection pool, or one client inside a transaction (as the tests use). */
export type Db = Pick<pg.Pool, "query">;

export function connect(url = process.env.DATABASE_URL): pg.Pool {
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.");
  return new pg.Pool({ connectionString: url });
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
  /** The last saved text. */
  body: string;
  /** The text as imported. */
  originalBody: string;
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
  const sql = `SELECT ${COLUMNS}, cp.body, p.body AS "originalBody" ${OPEN_COPY} AND p.id = $2`;
  return (await db.query<CopyPageDetail>(sql, [externalId, pageId])).rows[0];
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

/** A stored change, and whether every rule it was checked against passed. */
export interface StoredChange extends Change {
  id: number;
  passed: boolean;
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
            pr.proposed_text AS proposed, pr.reason, COALESCE(bool_and(cr.passed), true) AS passed
     FROM copy_page
     JOIN proposals pr ON pr.copy_id = copy_page.copy_id AND pr.page_id = copy_page.page_id AND pr.kind <> 'outcome'
     LEFT JOIN check_results cr ON cr.proposal_id = pr.id
     GROUP BY pr.id ORDER BY pr.id`,
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
