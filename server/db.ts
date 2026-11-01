// The database: the batch and each editor's copy of it. The tables are in db/schema.sql.
// Queries are tagged templates (the postgres package): values go in as parameters, lists as helpers.
import postgres, { type Sql, type TransactionSql } from "postgres";
import type { z } from "zod";
import type { ContentPage } from "./content.ts";
import type { PageMeta } from "./rules.ts";
import type { Outcome } from "./schemas.ts";

/** The database, or a transaction on it. Inside a transaction, `begin` makes a savepoint, so the writes below nest safely. */
export type Db = Sql | TransactionSql;

export function connect(url = process.env.DATABASE_URL): Db {
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.");
  return postgres(url);
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

/** A page of the editor's copy in full. The writes below take one of these, so they know which copy to write to. */
export interface CopyPageDetail extends CopyPage {
  copyId: number;
  editorId: number;
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
    audience: meta.audience ?? null,
    medicine: meta.medicine ?? null,
    certified: meta.certified ?? null,
    body,
  }));
  await db`
    INSERT INTO pages ${db(rows)}
    ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path, title = EXCLUDED.title, page_type = EXCLUDED.page_type,
      audience = EXCLUDED.audience, medicine = EXCLUDED.medicine, certified = EXCLUDED.certified, body = EXCLUDED.body`;
}

/** The editor's open copy of the batch. If there is none, opens one with every page a candidate. */
export async function openCopy(db: Db, externalId: string): Promise<CopyPage[]> {
  return db.begin(async (tx) => {
    const [editor] = await tx<{ id: number }[]>`
      INSERT INTO editors (external_id) VALUES (${externalId})
      ON CONFLICT (external_id) DO UPDATE SET external_id = EXCLUDED.external_id
      RETURNING id::int`;
    await tx`
      WITH new_copy AS (
        INSERT INTO copies (editor_id) VALUES (${editor.id})
        ON CONFLICT (editor_id) WHERE reset_at IS NULL DO NOTHING
        RETURNING id
      )
      INSERT INTO copy_pages (copy_id, page_id, body)
      SELECT new_copy.id, pages.id, pages.body FROM new_copy, pages`;
    return getProgress(tx, externalId);
  });
}

/** The pages of the editor's open copy, in full, with the AI's latest recommended outcome built as JSON. */
function selectCopyPages(db: Db, externalId: string, pageId?: number, lock = false) {
  return db<CopyPageDetail[]>`
    SELECT p.id, p.title, p.page_type AS type, cp.status, c.id::int AS "copyId", c.editor_id::int AS "editorId",
      json_strip_nulls(json_build_object('audience', p.audience, 'medicine', p.medicine, 'certified', p.certified::text, 'path', p.path)) AS meta,
      cp.body, p.body AS "originalBody",
      (SELECT json_strip_nulls(json_build_object('outcome', pr.outcome, 'target', pr.target_page_id, 'reason', pr.reason))
       FROM proposals pr WHERE pr.copy_id = c.id AND pr.page_id = p.id AND pr.kind = 'outcome'
       ORDER BY pr.id DESC LIMIT 1) AS outcome,
      (SELECT max(d.id)::int FROM decisions d WHERE d.copy_id = c.id AND d.page_id = p.id AND d.action = 'save') AS "lastSave"
    FROM editors e
    JOIN copies c ON c.editor_id = e.id AND c.reset_at IS NULL
    JOIN copy_pages cp ON cp.copy_id = c.id
    JOIN pages p ON p.id = cp.page_id
    WHERE e.external_id = ${externalId} ${pageId === undefined ? db`` : db`AND p.id = ${pageId}`}
    ORDER BY p.id
    ${lock ? db`FOR UPDATE OF cp` : db``}`;
}

/** Each page's status and recommended outcome, as the panel shows them. */
export async function getProgress(db: Db, externalId: string): Promise<CopyPage[]> {
  const rows = await selectCopyPages(db, externalId);
  return rows.map(({ id, title, type, status, outcome }) => ({ id, title, type, status, outcome }));
}

/**
 * One page of the editor's open copy, or nothing if the page isn't in it. With `lock`, inside a transaction,
 * the page's row stays locked until the transaction ends, so two writers take turns.
 */
export async function getCopyPage(db: Db, externalId: string, pageId: number, { lock = false } = {}): Promise<CopyPageDetail | undefined> {
  const [row] = await selectCopyPages(db, externalId, pageId, lock);
  return row;
}

/** Every path a link on the site may point to: the batch's pages, plus the site's other files. */
export async function knownPaths(db: Db, siteFiles: string[]): Promise<Set<string>> {
  const rows = await db<{ path: string }[]>`SELECT path FROM pages`;
  return new Set([...siteFiles, ...rows.map((r) => r.path)]);
}

/** The triage check for exact duplicates: the other pages in the batch whose text as imported is identical. */
export async function findDuplicates(db: Db, pageId: number, text: string): Promise<number[]> {
  const rows = await db<{ id: number }[]>`SELECT id FROM pages WHERE id <> ${pageId} AND body = ${text} ORDER BY id`;
  return rows.map((r) => r.id);
}

/**
 * Stores the AI's recommended outcome and sets the page's status.
 * A page to migrate stays a candidate until its fixes are proposed (docs/spec.md, "How it works", step 2.5).
 * Returns the new status.
 */
export async function recordOutcome(db: Db, page: CopyPageDetail, { outcome, target, reason }: z.infer<typeof Outcome>): Promise<string> {
  const status = { migrate: "candidate", retire: "recommend_retire", redirect: "recommend_redirect" }[outcome];
  await db.begin(async (tx) => {
    await tx`
      INSERT INTO proposals (copy_id, page_id, kind, outcome, target_page_id, reason)
      VALUES (${page.copyId}, ${page.id}, 'outcome', ${outcome}, ${target ?? null}, ${reason})`;
    await setStatus(tx, page, status);
  });
  return status;
}

/** One fixed rule's result, as the audit trail stores it. */
export interface Check {
  ruleId: string;
  passed: boolean;
  reason?: string;
}

/** The rows for check_results, from the rules' results. */
function checkRows(
  page: CopyPageDetail,
  ranOn: "page" | "proposal" | "decision",
  checks: Check[],
  configVersion: string,
  ids: { proposal_id?: number; decision_id?: number } = {},
) {
  return checks.map((c) => ({
    copy_id: page.copyId,
    page_id: page.id,
    ran_on: ranOn,
    ...ids,
    check_kind: "fixed_rule",
    check_id: c.ruleId,
    config_version: configVersion,
    passed: c.passed,
    reason: c.reason ?? null,
  }));
}

/** Logs the fixed rules' results on a page as it stands ("Prepare for review"). */
export async function logPageChecks(db: Db, page: CopyPageDetail, checks: Check[], configVersion: string): Promise<void> {
  if (checks.length) await db`INSERT INTO check_results ${db(checkRows(page, "page", checks, configVersion))}`;
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

/** Stores one of the AI's changes with the rule results it was checked against. */
export async function recordChange(db: Db, page: CopyPageDetail, change: Change, checks: Check[], configVersion: string): Promise<void> {
  const { kind, ruleId, attempt, original, proposed, reason } = change;
  await db.begin(async (tx) => {
    const [proposal] = await tx<{ id: number }[]>`
      INSERT INTO proposals (copy_id, page_id, kind, rule_id, attempt, original_text, proposed_text, reason)
      VALUES (${page.copyId}, ${page.id}, ${kind}, ${ruleId ?? null}, ${attempt ?? null}, ${original ?? null}, ${proposed ?? null}, ${reason ?? null})
      RETURNING id::int`;
    const rows = checkRows(page, "proposal", checks, configVersion, { proposal_id: proposal.id });
    if (rows.length) await tx`INSERT INTO check_results ${tx(rows)}`;
  });
}

/** The AI's changes to one page, oldest first. A change passed if every rule it was checked against passed. */
export async function getChanges(db: Db, page: CopyPageDetail): Promise<StoredChange[]> {
  return db<StoredChange[]>`
    SELECT pr.id::int AS id, pr.kind, pr.rule_id AS "ruleId", pr.attempt, pr.original_text AS original,
           pr.proposed_text AS proposed, pr.reason, COALESCE(bool_and(cr.passed), true) AS passed,
           d.action AS decision, d.id::int AS "decisionId"
    FROM proposals pr
    LEFT JOIN check_results cr ON cr.proposal_id = pr.id
    LEFT JOIN LATERAL (SELECT action, id FROM decisions WHERE proposal_id = pr.id ORDER BY id DESC LIMIT 1) d ON true
    WHERE pr.copy_id = ${page.copyId} AND pr.page_id = ${page.id} AND pr.kind <> 'outcome'
    GROUP BY pr.id, d.action, d.id ORDER BY pr.id`;
}

export async function setStatus(db: Db, page: CopyPageDetail, status: string): Promise<void> {
  await db`UPDATE copy_pages SET status = ${status}, updated_at = now() WHERE copy_id = ${page.copyId} AND page_id = ${page.id}`;
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

/** Stores an editor's decision with the rule results it led to, and any new text or status for the page. */
export async function recordDecision(
  db: Db,
  page: CopyPageDetail,
  record: DecisionRecord,
  update: { body?: string; status?: string },
  checks: Check[],
  configVersion: string,
): Promise<void> {
  const { action, proposalId, targetPageId, originalText, finalText, note } = record;
  await db.begin(async (tx) => {
    const [decision] = await tx<{ id: number }[]>`
      INSERT INTO decisions (copy_id, page_id, editor_id, proposal_id, action, target_page_id, original_text, final_text, note)
      VALUES (${page.copyId}, ${page.id}, ${page.editorId}, ${proposalId ?? null}, ${action}, ${targetPageId ?? null},
              ${originalText ?? null}, ${finalText ?? null}, ${note ?? null})
      RETURNING id::int`;
    if (update.body !== undefined) {
      await tx`UPDATE copy_pages SET body = ${update.body}, updated_at = now() WHERE copy_id = ${page.copyId} AND page_id = ${page.id}`;
    }
    if (update.status !== undefined) await setStatus(tx, page, update.status);
    const rows = checkRows(page, "decision", checks, configVersion, { decision_id: decision.id });
    if (rows.length) await tx`INSERT INTO check_results ${tx(rows)}`;
  });
}
