#!/usr/bin/env bun
// Local test harness: serves the example page, the loader, built cores and your ROMs.
// Usage: bun example/serve.ts [--port 8080]

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const portIdx = process.argv.indexOf("--port");
const port = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : 8080;

// Serve files only from these directories.
const mounts: Record<string, string> = {
  "/cores/": join(root, "cores"),
  "/roms/": join(root, "roms"),
};

// Send a precompressed copy (scripts/compress-core.ts) when the browser accepts it and it's
// newer than the original: brotli on localhost/HTTPS, gzip over plain-HTTP LAN. The ETag lets
// repeat visits get a 304 instead of re-downloading a 44 MB core.
function serveFile(req: Request, file: string) {
  const accept = req.headers.get("accept-encoding") ?? "";
  const mtime = statSync(file).mtimeMs;
  const pick = (["br", "gzip"] as const).find((enc) => {
    const copy = `${file}.${enc === "br" ? "br" : "gz"}`;
    return accept.includes(enc) && existsSync(copy) && statSync(copy).mtimeMs >= mtime;
  });
  const sent = pick ? `${file}.${pick === "br" ? "br" : "gz"}` : file;
  const st = statSync(sent);
  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const headers: Record<string, string> = {
    "content-type": Bun.file(file).type,
    "cache-control": "no-cache",
    etag,
    vary: "accept-encoding",
  };
  if (pick) headers["content-encoding"] = pick;
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(Bun.file(sent), { headers });
}

const server = Bun.serve({
  port,
  async fetch(req) {
    const { pathname } = new URL(req.url);

    if (pathname === "/") return new Response(Bun.file(join(import.meta.dir, "index.html")));

    // Every game in every built core's games.json, tagged with the core URL that boots it.
    if (pathname === "/games.json") {
      const games = [];
      for (const core of readdirSync(mounts["/cores/"])) {
        const manifest = join(mounts["/cores/"], core, "games.json");
        if (!existsSync(manifest)) continue;
        const m = await Bun.file(manifest).json();
        if (!existsSync(join(mounts["/cores/"], core, m.coreFile))) continue;
        for (const g of m.games) games.push({ ...g, core, coreUrl: `/cores/${core}/${m.coreFile}` });
      }
      return Response.json(games);
    }

    if (pathname === "/jamma.js") {
      const out = await Bun.build({ entrypoints: [join(root, "src/index.ts")], target: "browser" });
      if (!out.success) return new Response(out.logs.join("\n"), { status: 500 });
      return new Response(out.outputs[0], { headers: { "content-type": "text/javascript" } });
    }

    for (const [prefix, dir] of Object.entries(mounts)) {
      if (!pathname.startsWith(prefix)) continue;
      const file = normalize(join(dir, decodeURIComponent(pathname.slice(prefix.length))));
      if (!file.startsWith(dir)) break;
      if (existsSync(file) && statSync(file).isFile()) return serveFile(req, file);
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`jamma example: http://localhost:${server.port}`);
