import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function mapWritePlugin(): Plugin {
  return {
    name: "trader-map-write",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__map", (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        req.on("end", async () => {
          try {
            const parsed = JSON.parse(body);
            const pretty = JSON.stringify(parsed, null, 2) + "\n";
            const target = resolve(server.config.root, "public/map.json");
            await writeFile(target, pretty, "utf8");
            res.statusCode = 204;
            res.end();
          } catch (err) {
            res.statusCode = 400;
            res.end(String(err));
          }
        });
      });
    },
  };
}

export default defineConfig({
  // Honour BASE_URL so the same build serves correctly from a subpath
  // on GitHub Pages (e.g. /trader/) and from / in local dev.
  base: process.env.BASE_URL ?? "/",
  plugins: [react(), mapWritePlugin()],
  server: {
    port: 5173,
    open: false,
  },
});
