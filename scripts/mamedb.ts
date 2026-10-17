// MAME machine database for the pinned version, built from MAME's official -listxml
// release asset into .cache/<mame>.sqlite. Shared by lookup.ts and verify.ts.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import config from "../cores.json";

const root = resolve(import.meta.dir, "..");
const cacheDir = join(root, ".cache");

export interface Machine {
  name: string;
  description: string;
  year: string;
  manufacturer: string;
  sourcefile: string;
  cloneof: string | null;
  romof: string | null;
  isbios: number;
  isdevice: number;
  status: string | null;
  rotate: number | null;
  width: number | null;
  height: number | null;
}

export interface Rom {
  name: string;
  size: number;
  crc: string | null;
  merge: string | null;
  status: string | null;
  optional: number;
}

const SCHEMA = `
  CREATE TABLE machines (
    name TEXT PRIMARY KEY, description TEXT, year TEXT, manufacturer TEXT, sourcefile TEXT,
    cloneof TEXT, romof TEXT, isbios INTEGER, isdevice INTEGER, status TEXT,
    rotate INTEGER, width INTEGER, height INTEGER);
  CREATE TABLE roms (machine TEXT, name TEXT, size INTEGER, crc TEXT, merge TEXT, status TEXT, optional INTEGER);
  CREATE TABLE disks (machine TEXT, name TEXT, sha1 TEXT, merge TEXT, status TEXT, optional INTEGER);
  CREATE TABLE devices (machine TEXT, device TEXT);
`;
const INDEXES = `
  CREATE INDEX roms_machine ON roms(machine);
  CREATE INDEX roms_crc ON roms(crc);
  CREATE INDEX disks_machine ON disks(machine);
  CREATE INDEX devices_machine ON devices(machine);
  CREATE INDEX machines_cloneof ON machines(cloneof);
  CREATE INDEX machines_sourcefile ON machines(sourcefile);
`;

const attrs = (line: string) => {
  const out: Record<string, string> = {};
  for (const m of line.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
};

const text = (line: string, tag: string) => {
  const m = line.match(new RegExp(`<${tag}>(.*)</${tag}>`));
  return m ? m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&") : null;
};

async function build(dbPath: string) {
  const zip = join(cacheDir, `${config.mame}lx.zip`);
  if (!existsSync(zip)) {
    const url = `https://github.com/mamedev/mame/releases/download/${config.mame}/${config.mame}lx.zip`;
    console.error(`downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    await Bun.write(zip, res);
  }

  console.error(`indexing ${basename(zip)} (one-time, ~1 min)`);
  const tmp = `${dbPath}.tmp`;
  if (existsSync(tmp)) await Bun.file(tmp).delete();
  const db = new Database(tmp);
  db.exec(SCHEMA);
  const insMachine = db.prepare(
    "INSERT INTO machines VALUES ($name,$description,$year,$manufacturer,$sourcefile,$cloneof,$romof,$isbios,$isdevice,$status,$rotate,$width,$height)",
  );
  const insRom = db.prepare("INSERT INTO roms VALUES (?,?,?,?,?,?,?)");
  const insDisk = db.prepare("INSERT INTO disks VALUES (?,?,?,?,?,?)");
  const insDevice = db.prepare("INSERT INTO devices VALUES (?,?)");

  const proc = Bun.spawn(["unzip", "-p", zip], { stdout: "pipe" });
  let m: Record<string, any> | null = null;
  let devices = new Set<string>();
  let buf = "";

  const handle = (line: string) => {
    const t = line.trimStart();
    if (t.startsWith("<machine ")) {
      const a = attrs(t);
      m = {
        $name: a.name, $description: "", $year: "", $manufacturer: "", $sourcefile: a.sourcefile,
        $cloneof: a.cloneof ?? null, $romof: a.romof ?? null,
        $isbios: a.isbios === "yes" ? 1 : 0, $isdevice: a.isdevice === "yes" ? 1 : 0,
        $status: null, $rotate: null, $width: null, $height: null,
      };
      devices = new Set();
    } else if (!m) {
      return;
    } else if (t.startsWith("<rom ")) {
      const a = attrs(t);
      insRom.run(m.$name, a.name, Number(a.size), a.crc ?? null, a.merge ?? null, a.status ?? null, a.optional === "yes" ? 1 : 0);
    } else if (t.startsWith("<disk ")) {
      const a = attrs(t);
      insDisk.run(m.$name, a.name, a.sha1 ?? null, a.merge ?? null, a.status ?? null, a.optional === "yes" ? 1 : 0);
    } else if (t.startsWith("<device_ref ")) {
      devices.add(attrs(t).name);
    } else if (t.startsWith("<display ") && m.$rotate === null) {
      const a = attrs(t);
      m.$rotate = Number(a.rotate ?? 0);
      m.$width = a.width ? Number(a.width) : null;
      m.$height = a.height ? Number(a.height) : null;
    } else if (t.startsWith("<driver ")) {
      m.$status = attrs(t).status ?? null;
    } else if (t.startsWith("<description>")) {
      m.$description = text(t, "description");
    } else if (t.startsWith("<year>")) {
      m.$year = text(t, "year");
    } else if (t.startsWith("<manufacturer>")) {
      m.$manufacturer = text(t, "manufacturer");
    } else if (t.startsWith("</machine>")) {
      insMachine.run(m);
      for (const d of devices) insDevice.run(m.$name, d);
      m = null;
    }
  };

  db.exec("BEGIN");
  const decoder = new TextDecoder();
  for await (const chunk of proc.stdout) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      handle(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  db.exec("COMMIT");
  db.exec(INDEXES);
  db.close();
  if ((await proc.exited) !== 0) throw new Error("unzip failed reading listxml");
  await Bun.write(dbPath, Bun.file(tmp));
  await Bun.file(tmp).delete();
}

export async function openDb(): Promise<MameDb> {
  mkdirSync(cacheDir, { recursive: true });
  const dbPath = join(cacheDir, `${config.mame}.sqlite`);
  if (!existsSync(dbPath)) await build(dbPath);
  return new MameDb(new Database(dbPath, { readonly: true }));
}

export class MameDb {
  constructor(private db: Database) {}

  machine(name: string): Machine | null {
    return this.db.query("SELECT * FROM machines WHERE name = ?").get(name) as Machine | null;
  }

  roms(name: string): Rom[] {
    return this.db.query("SELECT name,size,crc,merge,status,optional FROM roms WHERE machine = ?").all(name) as Rom[];
  }

  disks(name: string) {
    return this.db.query("SELECT name,sha1,merge,status,optional FROM disks WHERE machine = ?").all(name) as
      { name: string; sha1: string | null; merge: string | null; status: string | null; optional: number }[];
  }

  clones(name: string): string[] {
    return (this.db.query("SELECT name FROM machines WHERE cloneof = ? ORDER BY name").all(name) as { name: string }[]).map((r) => r.name);
  }

  /** Parent, then BIOS: the other sets MAME searches for this set's ROMs. */
  romofChain(name: string): string[] {
    const chain: string[] = [];
    let cur = this.machine(name)?.romof;
    while (cur && !chain.includes(cur)) {
      chain.push(cur);
      cur = this.machine(cur)?.romof;
    }
    return chain;
  }

  /** Devices this machine uses that carry their own ROMs. */
  romDevices(name: string): string[] {
    return (this.db.query(
      "SELECT DISTINCT d.device AS name FROM devices d JOIN roms r ON r.machine = d.device WHERE d.machine = ? ORDER BY d.device",
    ).all(name) as { name: string }[]).map((r) => r.name);
  }

  search(term: string, limit = 20): Machine[] {
    const like = `%${term}%`;
    return this.db.query(
      "SELECT * FROM machines WHERE isdevice = 0 AND (name LIKE ? OR description LIKE ?) ORDER BY cloneof IS NOT NULL, name LIMIT ?",
    ).all(like, like, limit) as Machine[];
  }

  /** Machines whose ROMs match the most of the given CRCs, best first. */
  identify(crcs: string[], limit = 3): { name: string; hits: number; total: number }[] {
    if (!crcs.length) return [];
    const marks = crcs.map(() => "?").join(",");
    return this.db.query(
      `SELECT r.machine AS name, COUNT(DISTINCT r.crc) AS hits,
              (SELECT COUNT(*) FROM roms WHERE machine = r.machine) AS total
       FROM roms r JOIN machines m ON m.name = r.machine
       WHERE r.crc IN (${marks}) AND m.isdevice = 0
       GROUP BY r.machine ORDER BY hits DESC, total ASC LIMIT ?`,
    ).all(...crcs, limit) as { name: string; hits: number; total: number }[];
  }
}

/** Core in cores.json whose sources include this MAME source file (relative to src/mame). */
export function coreFor(sourcefile: string): string | null {
  const cores = config.cores as Record<string, { sources: string[] }>;
  for (const [name, core] of Object.entries(cores)) {
    if (core.sources.includes(`src/mame/${sourcefile}`)) return name;
  }
  return null;
}

/** A ROM container as MAME sees it: a zip or a folder named after a set. */
export interface Container {
  kind: "zip" | "dir";
  path: string;
  /** Entry path inside the container -> lowercase hex CRC32 (folders: computed on demand). */
  crcOf(entry: string): Promise<string | null>;
  entries: string[];
}

export async function openZip(path: string): Promise<Container> {
  const file = Bun.file(path);
  const size = file.size;
  const tail = new DataView(await file.slice(Math.max(0, size - 65557)).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${path}: not a zip`);
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new Error(`${path}: zip64 not supported`);

  const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const crcs = new Map<string, string>();
  const dec = new TextDecoder();
  for (let p = 0, i = 0; i < count; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new Error(`${path}: bad central directory`);
    const crc = cd.getUint32(p + 16, true).toString(16).padStart(8, "0");
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    if (!name.endsWith("/")) crcs.set(name, crc);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { kind: "zip", path, entries: [...crcs.keys()], crcOf: async (e) => crcs.get(e) ?? null };
}

export function openDir(path: string): Container {
  const entries: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else entries.push(relative(path, full));
    }
  };
  walk(path);
  const cache = new Map<string, string>();
  return {
    kind: "dir",
    path,
    entries,
    crcOf: async (e) => {
      if (!entries.includes(e)) return null;
      if (!cache.has(e)) {
        const crc = Bun.hash.crc32(await Bun.file(join(path, e)).arrayBuffer());
        cache.set(e, (crc >>> 0).toString(16).padStart(8, "0"));
      }
      return cache.get(e)!;
    },
  };
}

/** Containers for a set name in a ROM folder: <set>.zip and/or <set>/. */
export async function containersFor(rompath: string, set: string): Promise<Container[]> {
  const out: Container[] = [];
  const zip = join(rompath, `${set}.zip`);
  const dir = join(rompath, set);
  if (existsSync(zip)) out.push(await openZip(zip));
  if (existsSync(dir) && statSync(dir).isDirectory()) out.push(openDir(dir));
  return out;
}
