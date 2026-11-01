// Connects to the host and shows one view: the card in the conversation or, full screen,
// the list of pages or one page. The design is in docs/spec.md, "The panel in the conversation".
// Modelled on ext-apps examples/basic-server-react.
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { Batch, View } from "./types";
import { usePrepare } from "./usePrepare";
import { useProgress } from "./useProgress";
import { CardView } from "./views/CardView";
import { PageListView } from "./views/PageListView";
import { PageView } from "./views/PageView";

export function Panel() {
  const [batch, setBatch] = useState<Batch>();
  const [context, setContext] = useState<McpUiHostContext>();
  const [view, setView] = useState<View>({ name: "pages" });
  const [opened, setOpened] = useState(false);

  const { app, error } = useApp({
    appInfo: { name: "Content compliance", version: "0.1.0" },
    capabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    onAppCreated: (app) => {
      app.addEventListener("toolresult", (result) => setBatch(result.structuredContent as unknown as Batch));
      app.addEventListener("hostcontextchanged", (changed) => setContext((c) => ({ ...c, ...changed })));
    },
  });
  useHostStyles(app, app?.getHostContext());
  useEffect(() => {
    if (app) setContext(app.getHostContext());
  }, [app]);
  useProgress(app, batch !== undefined, setBatch);
  const preparation = usePrepare(app);

  const fullScreen = context?.displayMode === "fullscreen";
  const canOpen = context?.availableDisplayModes?.includes("fullscreen") ?? false;
  useEffect(() => {
    if (fullScreen) setOpened(true);
  }, [fullScreen]);
  // Each view starts at the top.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [view]);

  let content: ReactNode;
  if (error) {
    content = <p className="muted">The panel couldn't connect: {error.message}</p>;
  } else if (!app || !batch) {
    content = <p className="muted">Opening the batch…</p>;
  } else if (canOpen && !fullScreen) {
    // A host that can't show the panel full screen gets the review pane's views in the conversation instead.
    content = <CardView batch={batch} opened={opened} onOpen={() => app.requestDisplayMode({ mode: "fullscreen" })} />;
  } else if (view.name === "page") {
    content = <PageView key={view.id} app={app} id={view.id} onBack={() => setView({ name: "pages" })} />;
  } else {
    content = (
      <PageListView
        batch={batch}
        prepared={preparation.sent}
        onPrepare={preparation.prepare}
        onOpen={(id) => setView({ name: "page", id })}
      />
    );
  }
  return <main style={insetStyle(context)}>{content}</main>;
}

/** The host's safe area, added to the panel's own padding in panel.css. */
function insetStyle(context?: McpUiHostContext): CSSProperties | undefined {
  const insets = context?.safeAreaInsets;
  if (!insets) return undefined;
  return {
    "--inset-top": `${insets.top}px`,
    "--inset-right": `${insets.right}px`,
    "--inset-bottom": `${insets.bottom}px`,
    "--inset-left": `${insets.left}px`,
  } as CSSProperties;
}
