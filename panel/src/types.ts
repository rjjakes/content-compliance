// What the server's tools return (the shapes are in server/schemas.ts), and the review pane's views.
import type { z } from "zod";
import type * as schemas from "../../server/schemas";

export type Outcome = z.infer<typeof schemas.Outcome>;
export type Batch = z.infer<typeof schemas.Batch>;
export type PageDetail = z.infer<typeof schemas.PageDetail>;

/** The review pane's views. The panel has no address bar, so the current view is kept in state. */
export type View = { name: "pages" } | { name: "page"; id: number };
