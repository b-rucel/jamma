#!/usr/bin/env bun
// Write .br and .gz copies next to a built core's .js and .wasm, so a server can send the
// core compressed (44 MB -> ~6 MB brotli / ~8 MB gzip). Browsers only accept brotli over
// HTTPS or localhost; plain-HTTP LAN visits get gzip. build-core.ts runs this after each build.
// Usage: bun scripts/compress-core.ts <core>

import { join, resolve } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

export async function compressCore(dir: string, name: string) {
  for (const ext of ["js", "wasm"]) {
    const file = join(dir, `${name}.${ext}`);
    const data = await Bun.file(file).bytes();
    const br = brotliCompressSync(data, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: data.length },
    });
    await Bun.write(`${file}.br`, br);
    await Bun.write(`${file}.gz`, Bun.gzipSync(data, { level: 9 }));
    console.log(`${name}.${ext}: ${data.length} -> br ${br.length}`);
  }
}

if (import.meta.main) {
  const name = process.argv[2];
  if (!name) {
    console.error("usage: bun scripts/compress-core.ts <core>");
    process.exit(1);
  }
  await compressCore(join(resolve(import.meta.dir, ".."), "cores", name), name);
}
