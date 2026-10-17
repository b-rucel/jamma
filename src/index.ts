// jamma: load a MAME Emscripten core into a page and run one game.
//
// MAME's Emscripten output is a classic (non-modular) script that reads a
// global `Module` and creates globals (`FS`, `JSMAME`), so only one machine
// can run per page.

export type RomSource = string | ArrayBuffer | Uint8Array | Blob;

export interface BootOptions {
  /** URL of the compiled core, e.g. "/cores/sega16/sega16.js". The .wasm is expected beside it. */
  core: string;
  /** MAME driver (short name), e.g. "shinobi". */
  driver: string;
  /**
   * ROM zips keyed by file name, e.g. { "shinobi.zip": "/roms/shinobi.zip" }. Include parent sets for clones.
   * Names may contain a set folder ("goldnaxe/315-5298.b9") to add loose files MAME looks for beside the zip.
   */
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
  /** Enter or leave browser fullscreen on the canvas, keeping the game's aspect ratio. Call from a user gesture. */
  toggleFullscreen(): Promise<void>;
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
  mkdirTree(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
}

declare global {
  interface Window {
    Module?: Record<string, unknown>;
    FS?: EmscriptenFS;
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
        // The default "opengl" renderer calls desktop GL functions WebGL lacks (glShadeModel).
        "-video", "bgfx",
        ...(opts.args ?? []),
      ],
      locateFile: (path: string) => new URL(path, coreBase).href,
      print: opts.onStdout ?? ((s: string) => console.log(s)),
      printErr: opts.onStderr ?? ((s: string) => console.warn(s)),
      preRun: [
        () => {
          const fs = window.FS!;
          fs.mkdirTree(ROM_DIR);
          for (const [name, bytes] of roms) {
            const path = `${ROM_DIR}/${name}`;
            fs.mkdirTree(path.slice(0, path.lastIndexOf("/")));
            fs.writeFile(path, bytes);
          }
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

  // SDL grows the canvas to the screen in fullscreen but doesn't shrink it back on exit.
  // A resize event makes SDL re-read the canvas's CSS size, so give the canvas a CSS size.
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) window.dispatchEvent(new Event("resize"));
  });

  // MAME's own JSMAME object is built by its post-js before the wasm loads, so its
  // number-only cwraps come out undefined. Bind the same exports now that they exist.
  const cwrap = window.Module!.cwrap as (name: string, ret: string | null, args?: string[]) => any;
  const bindings: JsMame = {
    get_ui: cwrap("_ZN15running_machine17emscripten_get_uiEv", "number"),
    get_sound: cwrap("_ZN15running_machine20emscripten_get_soundEv", "number"),
    ui_set_show_fps: cwrap("_ZN15mame_ui_manager12set_show_fpsEb", null, ["number", "number"]),
    sound_manager_mute: cwrap("_ZN13sound_manager4muteEbh", null, ["number", "number", "number"]),
    soft_reset: cwrap("_ZN15running_machine21emscripten_soft_resetEv", null),
    hard_reset: cwrap("_ZN15running_machine21emscripten_hard_resetEv", null),
    save: cwrap("_ZN15running_machine15emscripten_saveEPKc", null, ["string"]),
    load: cwrap("_ZN15running_machine15emscripten_loadEPKc", null, ["string"]),
    exit: cwrap("_ZN15running_machine15emscripten_exitEv", null, []),
  };
  const js = () => bindings;

  return {
    driver: opts.driver,
    softReset: () => js().soft_reset(),
    hardReset: () => js().hard_reset(),
    saveState: (slot) => js().save(slot),
    loadState: (slot) => js().load(slot),
    setMuted: (muted) => js().sound_manager_mute(js().get_sound(), muted ? 1 : 0, MUTE_REASON_UI),
    setShowFps: (show) => js().ui_set_show_fps(js().get_ui(), show ? 1 : 0),
    toggleFullscreen: async () => {
      if (document.fullscreenElement) return document.exitFullscreen();
      // Fullscreen stretches the canvas to the screen; letterbox instead.
      opts.canvas.style.objectFit = "contain";
      await opts.canvas.requestFullscreen();
    },
    exit: () => js().exit(),
  };
}
