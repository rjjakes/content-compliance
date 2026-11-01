// Loads one page of the editor's copy through get_page, a tool only the panel can call.
import type { App } from "@modelcontextprotocol/ext-apps";
import { useEffect, useState } from "react";
import type { PageDetail } from "./types";

export function usePage(app: App, id: number): { page?: PageDetail; failed: boolean } {
  const [page, setPage] = useState<PageDetail>();
  const [failed, setFailed] = useState(false);

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
  }, [app, id]);

  return { page, failed };
}
