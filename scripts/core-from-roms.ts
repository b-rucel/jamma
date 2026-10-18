#!/usr/bin/env bun
// Derive a core from the verified ROM folder: write the cores.json entry plus
// cores/<core>/games.json, the manifest the browser loader boots sets from.
// Usage: bun scripts/core-from-roms.ts <core> [--rompath roms] [--description "..."]

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import config from "../cores.json";
import { openDb } from "./mamedb";
import { checkSet, listSets } from "./romcheck";

const root = resolve(import.meta.dir, "..");

const args = process.argv.slice(2);
const core = args.find((a) => !a.startsWith("--"));
const flagValue = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const rompath = flagValue("--rompath") ?? "roms";
const description = flagValue("--description");

if (!core) {
  console.error(`usage: bun scripts/core-from-roms.ts <core> [--rompath roms] [--description "..."]`);
  process.exit(1);
}
if (!existsSync(rompath)) {
  console.error(`no ROM folder at ${rompath}`);
  process.exit(1);
}

const db = await openDb();

// Usable sets boot in the browser: nothing missing (OK) or only fixable warnings (WARN),
// minus sets that need a CHD, which jamma can't ship yet.
const usable = [];
const skipped: string[] = [];
for (const set of listSets(rompath)) {
  const r = await checkSet(db, rompath, set);
  if (r.status === "BAD") skipped.push(`${set}: missing required ROM(s)`);
  else if (r.status === "UNKNOWN") skipped.push(`${set}: not a ${config.mame} set name`);
  else if (r.disks.length) skipped.push(`${set}: needs CHD (${r.disks.map((d) => `${d.name}.chd`).join(", ")})`);
  else usable.push(r);
}

const sources = [...new Set(usable.map((r) => `src/mame/${r.machine!.sourcefile}`))].sort();

// Replace this core's entry; keep its extraSources so manual driver fixes survive
// re-running this script, and leave every other core untouched.
const configPath = join(root, "cores.json");
const json = await Bun.file(configPath).json();
const prev = json.cores[core] ?? {};
const entry: { description: string; sources: string[]; games: string[]; extraSources?: string[] } = {
  description: description ?? prev.description ?? core,
  sources,
  games: usable.map((r) => r.set),
};
if (prev.extraSources) entry.extraSources = prev.extraSources;
json.cores[core] = entry;
await Bun.write(configPath, JSON.stringify(json, null, 2) + "\n");

/** The roms option for the loader: this set's zip, its loose files, then the zips
 *  of the romof chain and device sets that exist in the folder. MAME finds a ROM
 *  inside a zip by CRC, so extra zips are harmless when not needed. */
const romsFor = (set: string, chain: string[]) => {
  const roms: string[] = [];
  if (existsSync(join(rompath, `${set}.zip`))) roms.push(`${set}.zip`);
  const walk = (dir: string, rel: string) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (f.isDirectory()) walk(join(dir, f.name), `${rel}${f.name}/`);
      else roms.push(`${set}/${rel}${f.name}`);
    }
  };
  if (existsSync(join(rompath, set)) && statSync(join(rompath, set)).isDirectory()) walk(join(rompath, set), "");
  for (const s of [...chain, ...db.romDevices(set)]) {
    if (!roms.includes(`${s}.zip`) && existsSync(join(rompath, `${s}.zip`))) roms.push(`${s}.zip`);
  }
  return roms;
};

const warningsFor = (problems: { rom: string; kind: string }[]) =>
  problems.map((p) => (p.kind === "wrong" ? `${p.rom}: wrong checksum` : `${p.rom}: missing (optional)`));

const manifest = {
  mame: config.mame,
  core,
  coreFile: `${core}.js`,
  generatedAt: new Date().toISOString(),
  games: usable
    .map((r) => ({
      name: r.set,
      title: r.machine!.description,
      year: r.machine!.year,
      manufacturer: r.machine!.manufacturer,
      driver: r.machine!.sourcefile,
      parent: r.machine!.cloneof,
      roms: romsFor(r.set, r.chain),
      rotate: r.machine!.rotate ?? 0,
      width: r.machine!.width ?? 0,
      height: r.machine!.height ?? 0,
      emulation: r.machine!.status ?? "unknown",
      verify: r.status,
      warnings: warningsFor(r.problems),
    }))
    .sort((a, b) => a.title.localeCompare(b.title)),
};

await Bun.write(join(root, "cores", core, "games.json"), JSON.stringify(manifest, null, 2) + "\n");

for (const s of skipped) console.log(`skip  ${s}`);
console.log(`${core}: ${usable.length} usable sets, ${sources.length} drivers (${skipped.length} skipped)`);
console.log(`wrote cores.json (cores.${core}) + cores/${core}/games.json`);
