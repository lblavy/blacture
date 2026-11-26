import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const project = import.meta.dirname;
const publicDirectory = resolve(project, "public");
const workerName = "service-worker.js";

function bindPrecache(): Plugin {
  return {
    name: "blacture-bind-precache",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const worker = bundle[workerName];
      if (!worker || worker.type !== "chunk")
        this.error("Missing compiled service worker");
      const files = new Map<string, string | Uint8Array>();
      for (const item of Object.values(bundle)) {
        files.set(
          item.fileName,
          item.type === "asset" ? item.source : item.code,
        );
      }
      const staticFiles = readdirSync(publicDirectory, {
        recursive: true,
        withFileTypes: true,
      });
      for (const entry of staticFiles) {
        if (!entry.isFile()) continue;
        const path = resolve(entry.parentPath, entry.name);
        const name = path
          .slice(publicDirectory.length + 1)
          .replaceAll("\\", "/");
        if (name === "_headers") continue;
        files.set(name, readFileSync(path));
      }
      const hash = createHash("sha256");
      const precache = [...files.keys()].sort();
      for (const file of precache) {
        hash.update(file).update("\0").update(files.get(file)!).update("\0");
      }
      worker.code = worker.code
        .replace(
          "__BLACTURE_CACHE_REVISION__",
          JSON.stringify(hash.digest("hex")),
        )
        .replace(
          "__BLACTURE_PRECACHE__",
          JSON.stringify(precache.filter((file) => file !== workerName)),
        );
    },
  };
}

export default defineConfig({
  base: "./",
  // The Markdown entity decoder provides a DOM-free export for Web Workers.
  resolve: {
    conditions: ["module", "worker", "browser", "development|production"],
  },
  plugins: [bindPrecache()],
  build: {
    rolldownOptions: {
      input: {
        app: resolve(project, "index.html"),
        "service-worker": resolve(project, "src/service-worker.ts"),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "service-worker"
            ? workerName
            : "assets/[name]-[hash].js",
      },
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "jsdom",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: {
        lines: 90,
        branches: 85,
        "src/domain/**/*.ts": { lines: 95 },
        "src/import/**/*.ts": { lines: 95 },
        "src/storage.ts": { lines: 95 },
      },
    },
  },
});
