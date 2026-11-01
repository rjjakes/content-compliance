// The review pane's list view: "Prepare for review", then every page with its status and recommended outcome.
import type { Batch } from "../types";

interface Props {
  batch: Batch;
  /** Whether "Prepare for review" has sent its request. */
  prepared: boolean;
  onPrepare: () => void;
  onOpen: (id: number) => void;
}

export function PageListView({ batch, prepared, onPrepare, onOpen }: Props) {
  // The button works once: it goes when the request is sent, or once the AI has started.
  const started = batch.pages.some((p) => p.outcome);

  return (
    <>
      <h1>
        Review: {batch.decided} of {batch.total} pages decided
      </h1>
      {!started &&
        (prepared ? (
          <p className="prepare muted">The request is in the chat. If it is waiting in the message box, send it.</p>
        ) : (
          <button className="prepare" onClick={onPrepare}>
            Prepare for review
          </button>
        ))}
      <ul className="page-list">
        {batch.pages.map((p) => (
          <li key={p.id}>
            <button onClick={() => onOpen(p.id)}>
              <span>
                {p.id}. {p.title}
              </span>
              <span className="muted">
                {p.type} · {p.status}
                {p.outcome?.outcome === "migrate" && " · AI recommends migrate"}
                {p.outcome?.target && ` to page ${p.outcome.target}`}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
