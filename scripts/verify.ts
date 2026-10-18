#!/usr/bin/env bun
// Check ROM sets against the pinned MAME version, like `mame -verifyroms`.
// Sets are <set>.zip files and <set>/ folders in the ROM folder; parent, BIOS and device
// sets are looked up there too. Unknown names are identified from their ROM checksums.
// Usage: bun scripts/verify.ts [--rompath roms] [set ...]

import { existsSync } from "node:fs";
import config from "../cores.json";
import { coreFor, openDb } from "./mamedb";
import { type CheckResult, checkSet, listSets } from "./romcheck";

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

const sets = named.length ? named : listSets(rompath);
const db = await openDb();

const print = (r: CheckResult) => {
  const m = r.machine!;
  const core = coreFor(m.sourcefile) ?? `no core (src/mame/${m.sourcefile})`;
  const needs = r.chain.length ? ` + ${r.chain.join(" + ")}` : "";
  console.log(`${r.status.padEnd(8)} ${r.set}${needs}: ${m.description} [${core}]`);
  for (const p of r.problems) console.log(`         ${p.kind.padEnd(16)} ${p.rom}: ${p.detail}`);
  for (const d of r.disks) console.log(`         needs-chd        ${d.name}.chd (not checked)`);
};

let failed = 0;
for (const set of sets) {
  const r = await checkSet(db, rompath, set);
  if (r.status === "UNKNOWN") {
    failed++;
    const hint = r.suggestions?.length
      ? ` — contents match ${r.suggestions.map((g) => `${g.name} (${g.hits}/${g.total})`).join(", ")}`
      : "";
    console.log(`UNKNOWN  ${set}: not a ${config.mame} set name${hint}`);
    continue;
  }
  if (r.status === "BAD") failed++;
  print(r);
}

console.log(`\n${sets.length - failed}/${sets.length} sets usable with ${config.mame}`);
process.exit(failed ? 1 : 0);
