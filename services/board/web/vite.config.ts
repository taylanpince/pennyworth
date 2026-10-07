import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true, sourcemap: false },
  // `npm run dev:web` proxies the API to a board server on :3120.
  server: { port: 5173, proxy: { "/api": { target: "http://127.0.0.1:3120", headers: { host: "localhost:3120" } } } },
});
