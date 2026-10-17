#!/usr/bin/env bun
// Look up a MAME set in the pinned version: driver source, which jamma core covers it,
// and which other sets (parent, BIOS, devices) must be loaded with it.
// Usage: bun scripts/lookup.ts <set | search words>

import config from "../cores.json";
import { coreFor, openDb } from "./mamedb";

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error("usage: bun scripts/lookup.ts <set | search words>");
  process.exit(1);
}

const db = await openDb();
const m = db.machine(query);

if (!m) {
  const hits = db.search(query);
  if (!hits.length) {
    console.log(`no ${config.mame} set or title matches "${query}"`);
    process.exit(1);
  }
  for (const h of hits) {
    console.log(`${h.name.padEnd(14)} ${h.description} (${h.manufacturer}, ${h.year})${h.cloneof ? `  [clone of ${h.cloneof}]` : ""}`);
  }
  process.exit(0);
}

const roms = db.roms(m.name).filter((r) => r.status !== "nodump");
const chain = db.romofChain(m.name);
const devices = db.romDevices(m.name);
const disks = db.disks(m.name);
const core = coreFor(m.sourcefile);
const clones = db.clones(m.name);
const screen = m.width ? `${m.width}x${m.height}, rotate ${m.rotate}` : "none";

console.log(`${m.name}: ${m.description}`);
console.log(`  ${m.manufacturer}, ${m.year} | emulation ${m.status ?? "n/a"} | screen ${screen}`);
console.log(`  driver   src/mame/${m.sourcefile}`);
console.log(`  core     ${core ?? `none — add src/mame/${m.sourcefile} to a core in cores.json`}`);
if (m.cloneof) console.log(`  parent   ${m.cloneof}`);
const bios = chain.filter((s) => db.machine(s)?.isbios);
if (bios.length) console.log(`  bios     ${bios.join(", ")}`);
console.log(`  roms     ${roms.length} files (${roms.filter((r) => r.merge).length} shared with parent/bios)`);
if (disks.length) console.log(`  disks    ${disks.map((d) => `${d.name}.chd`).join(", ")}`);
console.log(`  load     ${[m.name, ...chain].map((s) => `${s}.zip`).join(" + ")}`);
if (devices.length) console.log(`  devices  ${devices.join(", ")} (device ROMs: in the set's zip or <device>.zip)`);
if (clones.length) console.log(`  clones   ${clones.join(", ")}`);
