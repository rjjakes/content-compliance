// The shapes the tools return. The server checks its results against them, and the panel
// takes its types from them, so each shape is written once.
import { z } from "zod";

export const Failure = z.object({ ruleId: z.string(), name: z.string(), reason: z.string() });

/** The AI's recommended outcome for a page. */
export const Outcome = z.object({
  outcome: z.enum(["migrate", "retire", "redirect"]),
  /** The page to redirect to. */
  target: z.number().optional(),
  reason: z.string(),
});

/** What open_batch and get_progress return. */
export const Batch = z.object({
  total: z.number(),
  decided: z.number(),
  pages: z.array(z.object({ id: z.number(), title: z.string(), type: z.string(), status: z.string(), outcome: Outcome.nullable() })),
});

/** One of the AI's changes the editor sees: a fix or rewrite that passed the rules, or why a rule can't be fixed. */
export const Change = z.object({
  id: z.number(),
  kind: z.enum(["fix", "cannot_fix", "rewrite"]),
  ruleId: z.string().nullable(),
  original: z.string().nullable(),
  proposed: z.string().nullable(),
  reason: z.string().nullable(),
  /** The editor's latest decision on it. */
  decision: z.enum(["accept", "reject"]).nullable(),
});

/** What get_page returns. */
export const PageDetail = z.object({
  id: z.number(),
  title: z.string(),
  type: z.string(),
  audience: z.string(),
  status: z.string(),
  text: z.string(),
  rulesChecked: z.number(),
  /** The rules that fail on the saved text. */
  failures: z.array(Failure),
  outcome: Outcome.nullable(),
  changes: z.array(Change),
  /** Whether the text has accepted changes that aren't saved yet, and the rules that would still fail with them. */
  unsaved: z.boolean(),
  pendingFailures: z.array(Failure),
});
