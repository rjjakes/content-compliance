// Reads progress from the server through get_progress, a tool only the panel can call, so the views
// update as the AI works (docs/spec.md, "How the panel stays up to date"). The two-second interval
// is the one in ext-apps examples/system-monitor-server.
import type { App } from "@modelcontextprotocol/ext-apps";
import { useEffect } from "react";
import type { Batch } from "./types";

const POLL_INTERVAL = 2000;

export function useProgress(app: App | null, enabled: boolean, onProgress: (batch: Batch) => void) {
  useEffect(() => {
    if (!app || !enabled) return;
    let busy = false;
    const id = window.setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await app.callServerTool({ name: "get_progress", arguments: {} });
        if (!result.isError) onProgress(result.structuredContent as unknown as Batch);
      } catch {
        // The next read tries again.
      } finally {
        busy = false;
      }
    }, POLL_INTERVAL);
    return () => window.clearInterval(id);
  }, [app, enabled, onProgress]);
}
