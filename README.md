# jamma

Reproducible MAME WebAssembly builds plus a small TypeScript loader for running arcade games in the browser.

The name comes from the JAMMA connector: the standard harness that lets any arcade board plug into any cabinet. jamma is that interface. It turns MAME into a core your app can load. It has no UI; apps such as `insert-coin` build on it.

## What's pinned

| | Version | Where |
|---|---|---|
| MAME | `mame0289` | `cores.json` → Docker build arg |
| Emscripten | `6.0.12` (`emscripten/emsdk` image) | `cores.json` → Docker build arg |

MAME 0.289 targets SDL3 under Emscripten, so it needs a recent emsdk. Bump both versions together.

## Building a core

Requirements: Docker and Bun.

```sh
bun install
bun scripts/build-core.ts sega16 --jobs 8
```

The first run builds the `jamma-builder:mame0289-emsdk6.0.12` image, which clones MAME and pre-builds the SDL3 ports. Each core then compiles only its listed drivers and writes `cores/<name>/mame<name>.js` and `mame<name>.wasm`. Object files are kept in the Docker volume `jamma-build-<name>`, so rebuilds are incremental.

The flags:

- `--jobs N` sets the number of parallel compile jobs. Docker Desktop's default 8 GB VM handles about 8; more can run out of memory.
- `--rebuild-image` rebuilds the builder image after you change a pinned version.

Cores are defined in `cores.json`:

| Core | Driver sources | Example games |
|---|---|---|
| `sega16` | `sega/segas16a.cpp`, `sega/segas16b.cpp` | shinobi, goldnaxe |
| `capcom194x` | `capcom/1942.cpp`, `capcom/1943.cpp` | 1942, 1943 |
| `williams` | `williams/williams.cpp` | alienar |

To add a core, add an entry to `cores.json` with the driver `.cpp` paths from `src/mame/` at the pinned tag. If the browser console shows a `ReferenceError` or a missing device, add the missing source file to `sources`.

## Using the loader

```ts
import { boot } from "jamma";

button.onclick = async () => {
  const machine = await boot({
    core: "/cores/sega16/mamesega16.js",
    driver: "goldnaxe",
    roms: { "goldnaxe.zip": "/roms/goldnaxe.zip" },
    canvas: document.querySelector("canvas")!,
  });
  machine.setShowFps(true);
};
```

`boot()` fetches the ROMs, writes them to `/roms` in MAME's in-memory filesystem, loads the core and starts the driver. The returned machine supports:

- `softReset()` and `hardReset()`
- `saveState(slot)` and `loadState(slot)`
- `setMuted(bool)` and `setShowFps(bool)`
- `exit()`

Constraints that come from MAME's Emscripten output:

- **One machine per page.** The core is a classic script that uses a global `Module`, `FS` and `JSMAME`.
- **Call `boot()` from a click or keypress.** Browsers block audio that starts without a user gesture.
- **The canvas id is set to `canvas`,** because SDL3 targets `#canvas` by default.
- **Serve the files over HTTP.** Opening the page as `file://` doesn't work.

## ROMs

ROMs are not included and are never committed (`roms/` and `*.zip` are gitignored). Keep in mind:

- **Sets must match the pinned MAME version.** A zip from an older MAME may have wrong or missing files. Check it with a native MAME of the same version: `mame -verifyroms <driver>`.
- **Clones need their parent.** `1942b` needs `1942.zip` and `1943ua` needs `1943.zip`, unless your zip is a merged set. Pass every zip the driver needs in `roms`.

## Local test page

```sh
bun example/serve.ts
```

Open http://localhost:8080. It serves `cores/` and `roms/` from the repo, and the page has fields for the core URL, the driver and the ROM zips.
