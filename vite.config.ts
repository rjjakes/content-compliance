// Bundles the panel into one HTML file, dist/mcp-app.html, which the server sends to the assistant.
// Modelled on ext-apps examples/basic-server-react/vite.config.ts.
// In development (npm run dev) Vite serves the panel instead, so changes show in the host without a rebuild.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  root: "panel",
  plugins: [react(), viteSingleFile()],
  server: {
    port: 5173,
    strictPort: true,
    // The panel runs in the host's sandboxed frame, so its scripts load from another origin.
    cors: true,
    origin: "http://localhost:5173",
  },
  build: {
    outDir: "../dist",
    // Kept, so a rebuild never leaves the server without the panel.
    emptyOutDir: false,
    rollupOptions: { input: fileURLToPath(new URL("panel/mcp-app.html", import.meta.url)) },
  },
});
