// The review pane's page view (docs/spec.md, "The editor's view of a page"): what must be fixed with the AI's fixes,
// the AI's suggestions, the page text and the outcome. The editor accepts or rejects each change, saves, and decides.
import type { App } from "@modelcontextprotocol/ext-apps";
import { diffWords } from "diff";
import { useState } from "react";
import type { Change, Decision, Outcome, PageDetail } from "../types";
import { usePage } from "../usePage";

const outcomeLabel = (o: Outcome) =>
  o.outcome === "redirect" ? `Redirect to page ${o.target}` : o.outcome === "retire" ? "Retire" : "Migrate";

type Decide = (decision: Decision) => void;

/** The passage before and after a change, with only the words that differ marked. */
function WordDiff({ before, after }: { before: string; after: string }) {
  const parts = diffWords(before, after);
  // The "before" side leaves out added words; the "after" side leaves out removed ones.
  const side = (marked: "removed" | "added") =>
    parts
      .filter((p) => !(marked === "removed" ? p.added : p.removed))
      .map((p, i) => (p[marked] ? <mark key={i} className={marked}>{p.value}</mark> : <span key={i}>{p.value}</span>));
  return (
    <>
      <del>{side("removed")}</del>
      <ins>{side("added")}</ins>
    </>
  );
}

/** One of the AI's changes as a diff, with Accept and Reject until the editor decides. */
function ChangeView({ change, decide, open }: { change: Change; decide: Decide; open: boolean }) {
  const [note, setNote] = useState("");
  return (
    <div className="change">
      <WordDiff before={change.original ?? ""} after={change.proposed ?? ""} />
      {change.reason && <p className="muted">{change.reason}</p>}
      {change.decision ? (
        <p className="muted">{change.decision === "accept" ? "Accepted" : "Rejected"}</p>
      ) : (
        open && (
          <div className="actions">
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label="Note" />
            <button onClick={() => decide({ action: "accept", changeId: change.id, note: note || undefined })}>Accept</button>
            <button onClick={() => decide({ action: "reject", changeId: change.id, note: note || undefined })}>Reject</button>
          </div>
        )
      )}
    </div>
  );
}

/** The outcome buttons. Migrate needs every rule to pass on the saved text; a redirect confirms the AI's target. */
function OutcomeActions({ page, decide }: { page: PageDetail; decide: Decide }) {
  const blocked = page.unsaved ? "Save your changes first." : page.failures.length ? "Every rule must pass first." : undefined;
  const target = page.outcome?.target;
  return (
    <div className="actions">
      <button disabled={!!blocked} onClick={() => decide({ action: "migrate" })}>
        Approve: migrate
      </button>
      <button onClick={() => decide({ action: "retire" })}>Approve: retire</button>
      {target && <button onClick={() => decide({ action: "redirect", target })}>Approve: redirect to page {target}</button>}
      {blocked && <p className="muted">{blocked}</p>}
    </div>
  );
}

interface Props {
  app: App;
  id: number;
  onBack: () => void;
}

export function PageView({ app, id, onBack }: Props) {
  const { page, failed, reload } = usePage(app, id);
  const [error, setError] = useState<string>();

  const decide: Decide = async (decision) => {
    setError(undefined);
    const result = await app.callServerTool({ name: "record_decision", arguments: { page: id, decision } });
    const first = result.content?.[0];
    if (result.isError) setError(first?.type === "text" ? first.text : "That didn't work.");
    reload();
  };

  if (failed) return <p className="muted">Page {id} couldn't be loaded.</p>;
  if (!page) return <p className="muted">Loading page {id}…</p>;
  const open = !page.status.startsWith("Approved");

  return (
    <>
      <button className="back" onClick={onBack}>
        Back
      </button>
      <h2>
        {page.id}. {page.title}
      </h2>
      <p className="muted">
        {page.type} · For {page.audience} · {page.status}
      </p>
      {error && <p className="error">{error}</p>}

      {page.unsaved && (
        <div className="actions">
          <p>
            Your accepted changes aren't saved.{" "}
            {page.pendingFailures.length
              ? `With them, ${page.pendingFailures.length} rule${page.pendingFailures.length > 1 ? "s" : ""} still fail.`
              : "With them, every rule passes."}
          </p>
          <button onClick={() => decide({ action: "save" })}>Save</button>
        </div>
      )}

      <h3>Must fix</h3>
      {page.failures.length ? (
        <ul className="failures">
          {page.failures.map((f) => {
            const forRule = page.changes.filter((c) => c.ruleId === f.ruleId);
            const fix = forRule.findLast((c) => c.kind === "fix");
            const cannotFix = forRule.findLast((c) => c.kind === "cannot_fix");
            return (
              <li key={f.ruleId}>
                <strong>{f.name}.</strong> {f.reason}
                {fix ? (
                  <ChangeView change={fix} decide={decide} open={open} />
                ) : (
                  cannotFix && <p className="muted">The AI can't fix this: {cannotFix.reason}</p>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p>All {page.rulesChecked} rules pass.</p>
      )}

      <h3>AI suggests</h3>
      {page.changes.some((c) => c.kind === "rewrite") ? (
        page.changes.filter((c) => c.kind === "rewrite").map((c) => <ChangeView key={c.id} change={c} decide={decide} open={open} />)
      ) : (
        <p className="muted">No suggestions.</p>
      )}

      <h3>Page text</h3>
      <pre className="page-text">{page.text}</pre>

      <h3>Outcome</h3>
      {page.outcome ? (
        <p>
          AI recommends: <strong>{outcomeLabel(page.outcome)}.</strong> {page.outcome.reason}
        </p>
      ) : (
        <p className="muted">The AI hasn't recommended an outcome yet.</p>
      )}
      {open ? <OutcomeActions page={page} decide={decide} /> : <p>{page.status}.</p>}
    </>
  );
}
