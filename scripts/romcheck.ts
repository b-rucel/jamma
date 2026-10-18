// Shared per-set ROM checking, like `mame -verifyroms`. Used by verify.ts and core-from-roms.ts.
// Mirrors how MAME loads: by CRC anywhere in a zip, by name in a folder; a clone or BIOS set
// also searches its romof chain, device ROMs the set, its chain or <device>.zip. One
// opened-container cache per run, since every set reopens the same parents.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Container, type Machine, type Rom, containersFor } from "./mamedb";
import type { MameDb } from "./mamedb";

export type Status = "OK" | "WARN" | "BAD" | "UNKNOWN";

export type Problem = { rom: string; kind: "missing" | "wrong" | "missing-optional"; detail: string };

export interface CheckResult {
  set: string;
  status: Status;
  machine: Machine | null;
  /** Parent, then BIOS: the other sets MAME searches for this set's ROMs. */
  chain: string[];
  problems: Problem[];
  /** Required disks (CHDs); a set with these can't be checked yet. */
  disks: { name: string; sha1: string | null; merge: string | null; status: string | null; optional: number }[];
  /** For UNKNOWN: sets whose ROMs match the contents, best first. */
  suggestions?: { name: string; hits: number; total: number }[];
}

// Opened containers are cached per run: checks walk the same parent and device sets over and over.
const opened = new Map<string, Promise<Container[]>>();
const open = (rompath: string, set: string) => {
  const key = join(rompath, set);
  if (!opened.has(key)) opened.set(key, containersFor(rompath, set));
  return opened.get(key)!;
};

/** Find a ROM like MAME does: by CRC anywhere in a zip, by name in a folder. */
async function find(rom: Rom, searchSets: string[], rompath: string): Promise<Problem | null> {
  let wrong: string | null = null;
  for (const set of searchSets) {
    for (const c of await open(rompath, set)) {
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

/** All set names in a ROM folder: <set>.zip files and <set>/ folders. */
export function listSets(rompath: string): string[] {
  return [...new Set(readdirSync(rompath)
    .filter((f) => f.endsWith(".zip") || statSync(join(rompath, f)).isDirectory())
    .map((f) => f.replace(/\.zip$/, "")))].sort();
}

/**
 * Check one set the way MAME loads it. A required ROM that is missing stops MAME from
 * starting (BAD); a wrong checksum or a missing optional ROM only warns and the game runs,
 * so those are WARN. Sets needing a CHD can't be checked yet (also WARN).
 */
export async function checkSet(db: MameDb, rompath: string, set: string): Promise<CheckResult> {
  const machine = db.machine(set);
  if (!machine) {
    const crcs = new Set<string>();
    for (const c of await open(rompath, set)) for (const e of c.entries) { const crc = await c.crcOf(e); if (crc) crcs.add(crc); }
    return { set, status: "UNKNOWN", machine: null, chain: [], problems: [], disks: [], suggestions: db.identify([...crcs]) };
  }

  const chain = db.romofChain(set);
  const problems: Problem[] = [];
  for (const rom of db.roms(set)) {
    if (rom.status === "nodump" || !rom.crc) continue;
    const p = await find(rom, [set, ...chain], rompath);
    if (p) problems.push(p);
  }
  for (const dev of db.romDevices(set)) {
    for (const rom of db.roms(dev)) {
      if (rom.status === "nodump" || !rom.crc) continue;
      const p = await find(rom, [set, ...chain, dev], rompath);
      if (p) problems.push({ ...p, rom: `${dev}:${p.rom}`, detail: `${p.detail} (device ROM: ${set}.zip or ${dev}.zip)` });
    }
  }
  const disks = db.disks(set).filter((d) => d.status !== "nodump" && !d.optional);

  const hard = problems.filter((p) => p.kind === "missing");
  const status: Status = hard.length ? "BAD" : problems.length || disks.length ? "WARN" : "OK";
  return { set, status, machine, chain, problems, disks };
}
