// Bundles the panel into one HTML file, dist/mcp-app.html, which the server sends to the assistant.
// Modelled on ext-apps examples/basic-server-react/vite.config.ts.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  root: "panel",
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "../dist",
    // Kept, so a rebuild never leaves the server without the panel.
    emptyOutDir: false,
    rollupOptions: { input: "panel/mcp-app.html" },
  },
});
