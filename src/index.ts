// jamma: load a MAME Emscripten core into a page and run one game.
//
// MAME's Emscripten output is a classic (non-modular) script that reads a
// global `Module` and creates globals (`FS`, `JSMAME`), so only one machine
// can run per page.

export type RomSource = string | ArrayBuffer | Uint8Array | Blob;

export interface BootOptions {
  /** URL of the compiled core, e.g. "/cores/sega16/mamesega16.js". The .wasm is expected beside it. */
  core: string;
  /** MAME driver (short name), e.g. "shinobi". */
  driver: string;
  /** ROM zips keyed by file name, e.g. { "shinobi.zip": "/roms/shinobi.zip" }. Include parent sets for clones. */
  roms: Record<string, RomSource>;
  /** Canvas to render into. Its id is forced to "canvas", which SDL3 targets by default. */
  canvas: HTMLCanvasElement;
  /** Emulated screen size passed as -resolution. */
  resolution?: { width: number; height: number };
  /** Extra MAME command-line arguments. */
  args?: string[];
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
}

export interface Machine {
  driver: string;
  softReset(): void;
  hardReset(): void;
  /** Save state to a named slot in MAME's in-memory filesystem. */
  saveState(slot: string): void;
  loadState(slot: string): void;
  setMuted(muted: boolean): void;
  setShowFps(show: boolean): void;
  exit(): void;
}

interface JsMame {
  get_ui(): number;
  get_sound(): number;
  ui_set_show_fps(ui: number, show: number): void;
  sound_manager_mute(sound: number, mute: number, reason: number): void;
  soft_reset(): void;
  hard_reset(): void;
  save(name: string): void;
  load(name: string): void;
  exit(): void;
}

interface EmscriptenFS {
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
}

declare global {
  interface Window {
    Module?: Record<string, unknown>;
    FS?: EmscriptenFS;
    JSMAME?: JsMame;
  }
}

const ROM_DIR = "/roms";
// sound_manager::MUTE_REASON_UI (src/emu/sound.h)
const MUTE_REASON_UI = 0x02;

let booted = false;

async function toBytes(src: RomSource): Promise<Uint8Array> {
  if (typeof src === "string") {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`jamma: ${src} -> HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  if (src instanceof Uint8Array) return src;
  if (src instanceof Blob) return new Uint8Array(await src.arrayBuffer());
  return new Uint8Array(src);
}

/**
 * Fetch ROMs, load the core and start the driver. Call it from a user gesture
 * (click/keypress) so the browser lets MAME start audio.
 */
export async function boot(opts: BootOptions): Promise<Machine> {
  if (booted) throw new Error("jamma: a machine is already running on this page");
  booted = true;

  const roms = await Promise.all(
    Object.entries(opts.roms).map(async ([name, src]) => [name, await toBytes(src)] as const),
  );

  const { width, height } = opts.resolution ?? { width: 640, height: 480 };
  opts.canvas.id = "canvas";
  const coreBase = new URL(opts.core, location.href);

  await new Promise<void>((resolve, reject) => {
    window.Module = {
      canvas: opts.canvas,
      arguments: [
        opts.driver,
        "-rompath", ROM_DIR,
        "-window",
        "-resolution", `${width}x${height}`,
        ...(opts.args ?? []),
      ],
      locateFile: (path: string) => new URL(path, coreBase).href,
      print: opts.onStdout ?? ((s: string) => console.log(s)),
      printErr: opts.onStderr ?? ((s: string) => console.warn(s)),
      preRun: [
        () => {
          const fs = window.FS!;
          fs.mkdir(ROM_DIR);
          for (const [name, bytes] of roms) fs.writeFile(`${ROM_DIR}/${name}`, bytes);
        },
      ],
      onRuntimeInitialized: () => resolve(),
      onAbort: (what: unknown) => reject(new Error(`jamma: core aborted: ${String(what)}`)),
    };

    const script = document.createElement("script");
    script.src = coreBase.href;
    script.onerror = () => reject(new Error(`jamma: failed to load ${coreBase.href}`));
    document.body.appendChild(script);
  });

  const js = () => {
    if (!window.JSMAME) throw new Error("jamma: JSMAME bindings missing from core");
    return window.JSMAME;
  };

  return {
    driver: opts.driver,
    softReset: () => js().soft_reset(),
    hardReset: () => js().hard_reset(),
    saveState: (slot) => js().save(slot),
    loadState: (slot) => js().load(slot),
    setMuted: (muted) => js().sound_manager_mute(js().get_sound(), muted ? 1 : 0, MUTE_REASON_UI),
    setShowFps: (show) => js().ui_set_show_fps(js().get_ui(), show ? 1 : 0),
    exit: () => js().exit(),
  };
}
