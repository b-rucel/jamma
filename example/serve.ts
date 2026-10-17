#!/usr/bin/env bun
// Local test harness: serves the example page, the loader, built cores and your ROMs.
// Usage: bun example/serve.ts [--port 8080]

import { join, normalize, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const portIdx = process.argv.indexOf("--port");
const port = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : 8080;

// Serve files only from these directories.
const mounts: Record<string, string> = {
  "/cores/": join(root, "cores"),
  "/roms/": join(root, "roms"),
};

const server = Bun.serve({
  port,
  async fetch(req) {
    const { pathname } = new URL(req.url);

    if (pathname === "/") return new Response(Bun.file(join(import.meta.dir, "index.html")));

    if (pathname === "/jamma.js") {
      const out = await Bun.build({ entrypoints: [join(root, "src/index.ts")], target: "browser" });
      if (!out.success) return new Response(out.logs.join("\n"), { status: 500 });
      return new Response(out.outputs[0], { headers: { "content-type": "text/javascript" } });
    }

    for (const [prefix, dir] of Object.entries(mounts)) {
      if (!pathname.startsWith(prefix)) continue;
      const file = normalize(join(dir, decodeURIComponent(pathname.slice(prefix.length))));
      if (!file.startsWith(dir)) break;
      const f = Bun.file(file);
      if (await f.exists()) return new Response(f);
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`jamma example: http://localhost:${server.port}`);
