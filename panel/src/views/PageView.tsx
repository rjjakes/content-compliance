// The review pane's page view: what must be fixed, the page text and the recommended outcome, with Back to the list.
import type { App } from "@modelcontextprotocol/ext-apps";
import type { Outcome } from "../types";
import { usePage } from "../usePage";

const outcomeLabel = (o: Outcome) =>
  o.outcome === "redirect" ? `Redirect to page ${o.target}` : o.outcome === "retire" ? "Retire" : "Migrate";

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
              {page.failures.map((f) => (
                <li key={f.ruleId}>
                  <strong>{f.name}.</strong> {f.reason}
                </li>
              ))}
            </ul>
          ) : (
            <p>All {page.rulesChecked} rules pass.</p>
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
