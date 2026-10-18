# jamma

Reproducible MAME WebAssembly builds plus a small TypeScript loader for running arcade games in the browser.

The name comes from the JAMMA connector: the standard harness that lets any arcade board plug into any cabinet. jamma is that interface. It turns MAME into a core your app can load. It has no UI; apps such as `insert-coin` build on it.

## Before you start

jamma ships no built cores and no ROMs. You build the cores yourself and bring your own ROM sets.

- **Docker**, with at least 8 GB of memory for its VM (Docker Desktop's default). The builder image is about 5.5 GB, and each core keeps its compiled objects in a Docker volume of 300–450 MB so rebuilds are incremental.
- **Bun** 1.2 or newer, for the build, ROM and test-server scripts.
- **Time.** The first build of a core takes 25–30 minutes at 8 parallel jobs. That figure is from a 16-core Intel Mac; the `arcade` core (47 drivers) took about 27 minutes. Every core compiles MAME's shared emulation code once, whether it has 2 drivers or 50. Building the builder image the first time adds a few minutes.
- **Your own ROM sets**, matching MAME 0.289. Sets made for older MAME versions may be missing files that 0.289 requires; `bun scripts/verify.ts` tells you which sets are usable before you build. ROMs are copyrighted, and jamma doesn't provide or link to any. For legal test games, [mamedev.org/roms](https://www.mamedev.org/roms/) lists ones whose rights holders allow free distribution.
- **A browser with WebGL 2**, loading pages over HTTP. Opening a page as `file://` doesn't work.

## What's pinned

| | Version | Where |
|---|---|---|
| MAME | `mame0289` | `cores.json` → Docker build arg |
| Emscripten | `6.0.12` (`emscripten/emsdk` image) | `cores.json` → Docker build arg |

MAME 0.289 targets SDL3 under Emscripten, so it needs a recent emsdk. Bump both versions together.

## Building a core

See [Before you start](#before-you-start) for requirements.

```sh
bun install
bun scripts/build-core.ts sega16 --jobs 8
```

The first run builds the `jamma-builder:mame0289-emsdk6.0.12` image, which clones MAME and pre-builds the SDL3 ports. Each core then compiles only its listed drivers and writes `cores/<name>/<name>.js` and `<name>.wasm`. Object files are kept in the Docker volume `jamma-build-<name>`, so rebuilds are incremental.

After the build, `scripts/compress-core.ts` writes `.br` and `.gz` copies of the `.js` and `.wasm` (the arcade core: 44 MB → 6.2 MB brotli, 8.3 MB gzip). Serve them with `Content-Encoding` matching the browser's `Accept-Encoding`. Browsers only offer brotli over HTTPS or localhost, so plain-HTTP LAN visits need the gzip copy. `example/serve.ts` does this and adds an ETag, so repeat visits get a 304 instead of re-downloading the core. To compress an existing core without rebuilding, run `bun scripts/compress-core.ts <core>`.

The flags:

- `--jobs N` sets the number of parallel compile jobs. Docker Desktop's default 8 GB VM handles about 8; more can run out of memory.
- `--rebuild-image` rebuilds the builder image after you change a pinned version.

A core is built from its `sources` plus any optional `extraSources` listed on its entry. `extraSources` is for driver files the linker turns out to need after the fact, when a boot fails with a missing-driver `ReferenceError`; listing them there keeps them out of `core-from-roms`' generated `sources` so a re-run of that script can't remove the fix. `makeArgs` on a core appends variables to the build's `emmake make` (e.g. `"ARCHOPTS=-msimd128"` to let clang autovectorize for WASM SIMD).

Tested and not adopted (2026-10-17, 5 games): WASM SIMD (`-msimd128`) and a link-time `-O3` (MAME caps the emcc link at `-O2`) each sped up some drivers and slowed others (e.g. Gyruss −11% / −21%, Golden Axe +18% / +10% per frame), with no net gain over the default build.

Cores are defined in `cores.json`:

| Core | Driver sources | Example games |
|---|---|---|
| `sega16` | `sega/segas16a.cpp`, `sega/segas16b.cpp` | shinobi, goldnaxe |
| `capcom194x` | `capcom/1942.cpp`, `capcom/1943.cpp` | 1942, 1943 |
| `williams` | `williams/williams.cpp` | alienar |

To add a core, add an entry to `cores.json` with the driver `.cpp` paths from `src/mame/` at the pinned tag. If the browser console shows a `ReferenceError` or a missing device, add the missing source file to `sources`. Or derive one from a ROM folder:

```sh
bun scripts/core-from-roms.ts arcade --description "Collection from roms/"
```

It verifies every set in the ROM folder, writes the `cores.json` entry (driver `sources` plus the `games` list) and `cores/<core>/games.json`, the manifest the loader can boot every usable set from. Only usable sets make it in: `OK` or `WARN` from `verify`, no CHDs needed. Sets that already have an `extraSources` array on their entry keep it when re-run, so linker fixes survive regeneration.

## Looking up and verifying ROM sets

Both commands use MAME's official `-listxml` for the pinned version (the `mameNNNNlx.zip` release asset). The first run downloads it and indexes it into `.cache/<mame>.sqlite`, which takes about 20 seconds; later runs are instant.

```sh
bun scripts/lookup.ts 1942b        # driver, covering core, parent/BIOS/device sets to load
bun scripts/lookup.ts golden axe   # search titles
bun scripts/verify.ts              # check every <set>.zip and <set>/ in roms/
bun scripts/verify.ts goldnaxe 1942b --rompath roms
```

`lookup` prints the driver source, which core in `cores.json` includes it (or which source to add), the zips to load together (`1942b.zip + 1942.zip`, `mslug.zip + neogeo.zip`), any devices that carry their own ROMs, and any CHDs.

`verify` checks sets the way MAME loads them: by CRC anywhere in a zip, and by file name in a folder. It also searches the parent, BIOS and device sets in the same folder. Each set is reported as:

- `OK`: everything is present.
- `WARN`: wrong checksums, optional files missing, or the set needs a CHD (CHDs aren't checked). A wrong checksum only warns — MAME starts anyway, which is how the placeholder PLDs in the ROM section work.
- `BAD`: required files are missing — MAME won't start.
- `UNKNOWN`: the name isn't a set in this version. It suggests the set whose ROMs match the contents, e.g. `blacktiger` → `blktiger (20/20)`.

It exits with status 1 if any set is `BAD` or `UNKNOWN`.

## Using the loader

```ts
import { boot } from "jamma";

button.onclick = async () => {
  const machine = await boot({
    core: "/cores/sega16/sega16.js",
    driver: "goldnaxe",
    roms: { "goldnaxe.zip": "/roms/goldnaxe.zip" },
    canvas: document.querySelector("canvas")!,
  });
  machine.setShowFps(true);
};
```

`boot()` fetches the ROMs, writes them to `/roms` in MAME's in-memory filesystem, loads the core and starts the driver. Boot defaults, each overridable via `args`:

- **`-nothrottle`, paced by jamma.** In the browser, each MAME main-loop iteration emulates exactly 1/60 s, on `requestAnimationFrame`. MAME's own throttle then busy-waits on the main thread (`sleep_for` without threads), which took about a third of every frame. jamma turns the throttle off and paces iterations to 60 per second itself (`pace60()`), so 120/144 Hz displays don't run games 2× fast. Measured on an Intel Mac: Golden Axe went from 15.8 to 10.9 ms per frame, and Gyruss from 49.7 fps (19.4 ms per frame) to a steady 60 fps (9.2 ms). Passing `-throttle` in `args` brings MAME's throttle back. `-autoframeskip` only works with the throttle on.
- **Audio resume:** browsers keep MAME's `AudioContext` suspended when it starts without a gesture (it is created seconds after Boot, outside the click that booted the game). jamma listens for `pointerdown`, `keydown` and `touchstart` on the page and resumes the context, so sound starts on the first input after boot.

The returned machine supports:

- `softReset()` and `hardReset()`
- `saveState(slot)` and `loadState(slot)`
- `setMuted(bool)` and `setShowFps(bool)`
- `toggleFullscreen()`: fullscreen on the canvas, letterboxed. Call it from a click; give the canvas a CSS size (e.g. `width: 100%; aspect-ratio: 4 / 3`) so it returns to that size on exit.
- `exit()`

Constraints that come from MAME's Emscripten output:

- **One machine per page.** The core is a classic script that uses a global `Module`, `FS` and `JSMAME`.
- **Call `boot()` from a click or keypress.** Browsers block audio that starts without a user gesture.
- **The canvas id is set to `canvas`,** because SDL3 targets `#canvas` by default.
- **Controllers must be connected before `boot()`.** MAME registers controllers only at startup; ones that appear later are ignored. Chrome exposes a gamepad (USB or Bluetooth) only after one of its buttons is pressed on the page, so have players press a controller button first (listen for `gamepadconnected`). With MAME's defaults, Back inserts a coin and Start is player 1 start.
- **Video defaults to `-video bgfx`.** MAME's default OpenGL renderer calls desktop GL functions that WebGL doesn't have.
- **Serve the files over HTTP.** Opening the page as `file://` doesn't work.

## ROMs

ROMs are not included and are never committed (`roms/` and `*.zip` are gitignored). Keep in mind:

- **Sets must match the pinned MAME version.** A zip from an older MAME may have wrong or missing files. Check it with a native MAME of the same version: `mame -verifyroms <driver>`.
- **Newer MAME versions add dumps that older zips don't have**, such as PLDs. If the log says `NOT FOUND` for a PLD the game doesn't use, a placeholder file of the right size at `roms/<set>/<file>` lets MAME start with a checksum warning. For example, `goldnaxe` in 0.289 needs `goldnaxe/315-5298.b9` (235 bytes).
- **Clones need their parent.** `1942b` needs `1942.zip` and `1943ua` needs `1943.zip`, unless your zip is a merged set. Pass every zip the driver needs in `roms`.

## Local test page

```sh
bun example/serve.ts
```

Open http://localhost:8080. It serves `cores/` and `roms/` from the repo, and the page has fields for the core URL, the driver and the ROM zips.
