// The card in the conversation: progress and one button that opens the review pane full screen.
import type { Batch } from "../types";

interface Props {
  batch: Batch;
  /** Whether the review pane has been opened before. */
  opened: boolean;
  onOpen: () => void;
}

export function CardView({ batch, opened, onOpen }: Props) {
  return (
    <div className="card">
      <p>
        {batch.decided} of {batch.total} pages decided
      </p>
      <button onClick={onOpen}>{opened ? "Continue review" : "Open review"}</button>
    </div>
  );
}
