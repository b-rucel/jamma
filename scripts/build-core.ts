#!/usr/bin/env bun
// Build one MAME core to cores/<name>/ inside the pinned Docker image.
// Usage: bun scripts/build-core.ts <core> [--jobs N] [--rebuild-image]

import { $ } from "bun";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import config from "../cores.json";
import { compressCore } from "./compress-core";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("--"));
const flag = (f: string) => args.includes(f);
const jobsIdx = args.indexOf("--jobs");
const jobs = jobsIdx >= 0 ? Number(args[jobsIdx + 1]) : navigator.hardwareConcurrency;

const cores = config.cores as Record<string, {
  sources: string[];
  extraSources?: string[];
  makeArgs?: string[];
}>;
if (!name || !cores[name]) {
  console.error(`usage: bun scripts/build-core.ts <core>\ncores: ${Object.keys(cores).join(", ")}`);
  process.exit(1);
}
const core = cores[name];

const image = `jamma-builder:${config.mame}-emsdk${config.emsdk}`;
const exists = (await $`docker image inspect ${image}`.quiet().nothrow()).exitCode === 0;
if (!exists || flag("--rebuild-image")) {
  await $`docker build -t ${image} --build-arg EMSDK_VERSION=${config.emsdk} --build-arg MAME_TAG=${config.mame} ${join(root, "docker")}`;
}

const out = join(root, "cores", name);
mkdirSync(out, { recursive: true });

// Object files live in a named volume per core so rebuilds are incremental.
// NOWERROR because clang on the asmjs target warns (-Werror otherwise) about
// '#pragma STDC FENV_ACCESS' in src/devices/cpu/drcbec.cpp, which it simply ignores there.
// extraSources is linker-repair drivers added by hand; core-from-roms keeps it on re-runs.
// makeArgs passes extra make variables for experiments (e.g. ARCHOPTS=-msimd128).
const sources = [...core.sources, ...(core.extraSources ?? [])];
const make = [
  `emmake make SUBTARGET=${name} SOURCES=${sources.join(",")} REGENIE=1 NOWERROR=1`,
  ...(core.makeArgs ?? []),
  `-j${jobs}`,
  `&& cp ${name}.js ${name}.wasm /out/`,
].join(" ");

await $`docker run --rm -v ${out}:/out -v jamma-build-${name}:/mame/build ${image} bash -c ${make}`;
await compressCore(out, name);
console.log(`built ${out}/${name}.{js,wasm} (+ .br/.gz)`);
