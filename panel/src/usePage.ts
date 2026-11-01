// Loads one page of the editor's copy through get_page, and loads it again after each decision.
import type { App } from "@modelcontextprotocol/ext-apps";
import { useCallback, useEffect, useState } from "react";
import type { PageDetail } from "./types";

export function usePage(app: App, id: number): { page?: PageDetail; failed: boolean; reload: () => void } {
  const [page, setPage] = useState<PageDetail>();
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let current = true;
    app.callServerTool({ name: "get_page", arguments: { page: id } }).then(
      (result) => {
        if (!current) return;
        if (result.isError) setFailed(true);
        else setPage(result.structuredContent as unknown as PageDetail);
      },
      () => current && setFailed(true),
    );
    return () => {
      current = false;
    };
  }, [app, id, version]);

  return { page, failed, reload };
}
