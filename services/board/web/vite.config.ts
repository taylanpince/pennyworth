import { readFileSync, writeFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const name = process.env.BOARD_NAME || "Pennyworth";
const icon = process.env.BOARD_ICON || "/icon.png";
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

export default defineConfig({
  define: {
    __BOARD_NAME__: JSON.stringify(name),
    __BOARD_ICON__: JSON.stringify(icon),
  },
  root: new URL(".", import.meta.url).pathname,
  plugins: [
    react(),
    {
      name: "instance-branding",
      transformIndexHtml: (html) =>
        html
          .replaceAll("Pennyworth", escape(name))
          .replaceAll("/icon.png", escape(icon)),
      closeBundle() {
        const path = new URL(
          "../dist/web/manifest.webmanifest",
          import.meta.url,
        );
        const manifest = JSON.parse(readFileSync(path, "utf8"));
        manifest.name = manifest.short_name = name;
        manifest.id = process.env.BOARD_APP_ID || "/";
        manifest.icons[0].src = icon;
        writeFileSync(path, JSON.stringify(manifest));
      },
    },
  ],
  build: { outDir: "../dist/web", emptyOutDir: true, sourcemap: false },
  // `npm run dev:web` proxies the API to a board server on :3120.
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3120",
        headers: { host: "localhost:3120" },
      },
    },
  },
});
