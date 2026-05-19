import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFile, writeFile } from "node:fs/promises";
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

function dataReadWritePlugin(): Plugin {
  return {
    name: "trader-data-rw",
    apply: "serve",
    configureServer(server) {
      const dataDir = resolve(
        server.config.root,
        "..",
        "src/skins/placeholder/data",
      );
      const allowed = new Set([
        "actors.json",
        "locations.json",
        "pairs.json",
      ]);
      server.middlewares.use("/__data", async (req, res, next) => {
        try {
          const url = new URL(req.url ?? "/", "http://localhost");
          const file = url.searchParams.get("file") ?? "";
          if (!allowed.has(file)) {
            res.statusCode = 400;
            res.end("unknown file");
            return;
          }
          const target = resolve(dataDir, file);
          if (req.method === "GET") {
            const text = await readFile(target, "utf8");
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(text);
            return;
          }
          if (req.method === "POST") {
            let body = "";
            req.on("data", (chunk: Buffer) => {
              body += chunk.toString("utf8");
            });
            req.on("end", async () => {
              try {
                const parsed = JSON.parse(body);
                const pretty = JSON.stringify(parsed, null, 2) + "\n";
                await writeFile(target, pretty, "utf8");
                res.statusCode = 204;
                res.end();
              } catch (err) {
                res.statusCode = 400;
                res.end(String(err));
              }
            });
            return;
          }
          next();
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });
    },
  };
}

export default defineConfig({
  // Honour BASE_URL so the same build serves correctly from a subpath
  // on GitHub Pages (e.g. /trader/) and from / in local dev.
  base: process.env.BASE_URL ?? "/",
  plugins: [react(), mapWritePlugin(), dataReadWritePlugin()],
  server: {
    // Out of the common dev-server range (3000 / 4200 / 5173 / 8080) so
    // trader doesn't fight other local projects for default ports.
    // strictPort means we fail rather than silently roll over.
    port: 6173,
    strictPort: true,
    open: false,
  },
});
