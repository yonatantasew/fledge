import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  build: { outDir: "dist", emptyOutDir: true },
  // The server bundles every library it uses (the Anthropic SDK and what it
  // loads), so the installed package has no runtime dependencies. Vite itself is
  // only imported by `--dev`, from a clone that has it installed.
  ssr: { noExternal: true, external: ["vite"] },
});
