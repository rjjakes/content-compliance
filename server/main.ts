// Loads the batch into the database, then serves the MCP server over HTTP at http://localhost:3001/mcp.
// Modelled on ext-apps examples/basic-server-react/main.ts: a new server for each request, with no sessions.
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import cors from "cors";
import { loadPages } from "./content.ts";
import { connect, loadBatch } from "./db.ts";
import { createServer } from "./server.ts";

const port = Number(process.env.PORT ?? 3001);
const db = connect();
await loadBatch(db, loadPages());

// Checks the Host and Origin headers for a local address, against DNS rebinding.
const app = createMcpExpressApp({ host: "127.0.0.1" });
app.use(cors());

app.all("/mcp", async (req, res) => {
  const server = createServer({ db });
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP error:", error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

app.listen(port, "127.0.0.1", (error) => {
  if (error) {
    console.error("Failed to start the server:", error);
    process.exit(1);
  }
  console.log(`MCP server listening on http://localhost:${port}/mcp`);
});
