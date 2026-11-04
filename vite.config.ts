import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
export default defineConfig({
  plugins: [react(), tailwind()],
  clearScreen: false,
  build: {
    manifest: true,
    rolldownOptions: {
      output: {
        // Monaco has cross-module initialization dependencies; preserve them across chunks.
        strictExecutionOrder: true,
        codeSplitting: {
          groups: [
            {
              name: "monaco",
              test: /node_modules\/monaco-editor\//,
              maxSize: 1_200_000,
            },
            {
              name: "react",
              test: /node_modules\/(?:react|react-dom|scheduler)\//,
              priority: 10,
            },
            { name: "storage", test: /node_modules\/dexie\// },
          ],
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  worker: { format: "es" },
});
