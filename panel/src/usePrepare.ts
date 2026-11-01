// "Prepare for review" hands the request to the AI through the chat (docs/spec.md, "How the AI does its part").
// In Claude Desktop the request lands in the message box, and goes when the editor sends it.
import type { App } from "@modelcontextprotocol/ext-apps";
import { useCallback, useState } from "react";

const REQUEST =
  "Prepare the content batch for review. For each page in the batch, check it with check_page, " +
  "then recommend migrate, retire or redirect with recommend_outcome, giving a reason. " +
  "Use the whole list of pages to choose redirect targets and to keep one copy of any duplicates.";

/** Whether the request has gone to the chat, and the function that sends it. If the chat refuses it, the button comes back. */
export function usePrepare(app: App | null) {
  const [sent, setSent] = useState(false);

  const prepare = useCallback(async () => {
    if (!app) return;
    setSent(true);
    const { isError } = await app.sendMessage({ role: "user", content: [{ type: "text", text: REQUEST }] }).catch(() => ({ isError: true }));
    if (isError) setSent(false);
  }, [app]);

  return { sent, prepare };
}
