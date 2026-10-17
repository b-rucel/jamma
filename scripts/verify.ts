#!/usr/bin/env bun
// Check ROM sets against the pinned MAME version, like `mame -verifyroms`.
// Sets are <set>.zip files and <set>/ folders in the ROM folder; parent, BIOS and device
// sets are looked up there too. Unknown names are identified from their ROM checksums.
// Usage: bun scripts/verify.ts [--rompath roms] [set ...]

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import config from "../cores.json";
import { type Container, type Rom, containersFor, coreFor, openDb } from "./mamedb";

let rompath = "roms";
const named: string[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--rompath") rompath = args[++i];
  else named.push(args[i].replace(/\.zip$/, "").replace(/\/$/, ""));
}

if (!existsSync(rompath)) {
  console.error(`no ROM folder at ${rompath}`);
  process.exit(1);
}

const sets = named.length
  ? named
  : [...new Set(readdirSync(rompath)
      .filter((f) => f.endsWith(".zip") || statSync(join(rompath, f)).isDirectory())
      .map((f) => f.replace(/\.zip$/, "")))].sort();

const db = await openDb();
const opened = new Map<string, Container[]>();
const open = async (set: string) => {
  if (!opened.has(set)) opened.set(set, await containersFor(rompath, set));
  return opened.get(set)!;
};

type Problem = { rom: string; kind: "missing" | "wrong" | "missing-optional"; detail: string };

/** Find a ROM like MAME does: by CRC anywhere in a zip, by name in a folder. */
async function find(rom: Rom, searchSets: string[]): Promise<Problem | null> {
  let wrong: string | null = null;
  for (const set of searchSets) {
    for (const c of await open(set)) {
      if (c.kind === "zip") {
        for (const e of c.entries) {
          const crc = await c.crcOf(e);
          if (crc === rom.crc) return null;
          if (e === rom.name || e.endsWith(`/${rom.name}`)) wrong ??= `${set}.zip has CRC ${crc}`;
        }
      } else {
        const crc = await c.crcOf(rom.name);
        if (crc === rom.crc) return null;
        if (crc) wrong ??= `${set}/${rom.name} has CRC ${crc}`;
      }
    }
  }
  if (wrong) return { rom: rom.name, kind: "wrong", detail: `expected CRC ${rom.crc}, ${wrong}` };
  const where = rom.merge ? ` (comes from ${searchSets.slice(1).join("/") || "parent"})` : "";
  return { rom: rom.name, kind: rom.optional ? "missing-optional" : "missing", detail: `${rom.size} bytes, CRC ${rom.crc}${where}` };
}

let failed = 0;
for (const set of sets) {
  const m = db.machine(set);
  if (!m) {
    failed++;
    const crcs = new Set<string>();
    for (const c of await open(set)) for (const e of c.entries) { const crc = await c.crcOf(e); if (crc) crcs.add(crc); }
    const guess = db.identify([...crcs]);
    const hint = guess.length
      ? ` — contents match ${guess.map((g) => `${g.name} (${g.hits}/${g.total})`).join(", ")}`
      : "";
    console.log(`UNKNOWN  ${set}: not a ${config.mame} set name${hint}`);
    continue;
  }

  const chain = db.romofChain(set);
  const problems: Problem[] = [];
  for (const rom of db.roms(set)) {
    if (rom.status === "nodump" || !rom.crc) continue;
    const p = await find(rom, [set, ...chain]);
    if (p) problems.push(p);
  }
  for (const dev of db.romDevices(set)) {
    for (const rom of db.roms(dev)) {
      if (rom.status === "nodump" || !rom.crc) continue;
      const p = await find(rom, [set, ...chain, dev]);
      if (p) problems.push({ ...p, rom: `${dev}:${p.rom}`, detail: `${p.detail} (device ROM: ${set}.zip or ${dev}.zip)` });
    }
  }
  const disks = db.disks(set).filter((d) => d.status !== "nodump" && !d.optional);

  const hard = problems.filter((p) => p.kind !== "missing-optional");
  const core = coreFor(m.sourcefile) ?? `no core (src/mame/${m.sourcefile})`;
  const label = hard.length ? "BAD" : problems.length || disks.length ? "WARN" : "OK";
  if (hard.length) failed++;

  const needs = chain.length ? ` + ${chain.join(" + ")}` : "";
  console.log(`${label.padEnd(8)} ${set}${needs}: ${m.description} [${core}]`);
  for (const p of problems) console.log(`         ${p.kind.padEnd(16)} ${p.rom}: ${p.detail}`);
  for (const d of disks) console.log(`         needs-chd        ${d.name}.chd (not checked)`);
}

console.log(`\n${sets.length - failed}/${sets.length} sets usable with ${config.mame}`);
process.exit(failed ? 1 : 0);
