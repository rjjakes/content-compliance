// The review pane's page view (docs/spec.md, "The editor's view of a page"): what must be fixed with the AI's fixes,
// the AI's suggestions, the page text and the recommended outcome, with Back to the list.
import type { App } from "@modelcontextprotocol/ext-apps";
import type { Change, Outcome } from "../types";
import { usePage } from "../usePage";

const outcomeLabel = (o: Outcome) =>
  o.outcome === "redirect" ? `Redirect to page ${o.target}` : o.outcome === "retire" ? "Retire" : "Migrate";

/** One of the AI's changes, as the passage before and after. */
function ChangeView({ change }: { change: Change }) {
  return (
    <div className="change">
      <del>{change.original}</del>
      <ins>{change.proposed}</ins>
      {change.reason && <p className="muted">{change.reason}</p>}
    </div>
  );
}

interface Props {
  app: App;
  id: number;
  onBack: () => void;
}

export function PageView({ app, id, onBack }: Props) {
  const { page, failed } = usePage(app, id);

  return (
    <>
      <button className="back" onClick={onBack}>
        Back
      </button>
      {failed ? (
        <p className="muted">Page {id} couldn't be loaded.</p>
      ) : !page ? (
        <p className="muted">Loading page {id}…</p>
      ) : (
        <>
          <h2>
            {page.id}. {page.title}
          </h2>
          <p className="muted">
            {page.type} · For {page.audience} · {page.status}
          </p>

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
                    {fix ? <ChangeView change={fix} /> : cannotFix && <p className="muted">The AI can't fix this: {cannotFix.reason}</p>}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p>All {page.rulesChecked} rules pass.</p>
          )}

          <h3>AI suggests</h3>
          {page.changes.some((c) => c.kind === "rewrite") ? (
            page.changes.filter((c) => c.kind === "rewrite").map((c) => <ChangeView key={c.id} change={c} />)
          ) : (
            <p className="muted">No suggestions.</p>
          )}

          <h3>Page text</h3>
          <pre className="page-text">{page.text}</pre>

          <h3>Recommended outcome</h3>
          {page.outcome ? (
            <p>
              <strong>{outcomeLabel(page.outcome)}.</strong> {page.outcome.reason}
            </p>
          ) : (
            <p className="muted">The AI hasn't recommended an outcome yet.</p>
          )}
        </>
      )}
    </>
  );
}
