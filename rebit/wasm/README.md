# Rebit hatariB WebAssembly feasibility proof

**Result: feasible.** The existing hatariB libretro implementation builds with
Emscripten 3.1.74 and runs real Atari ST games in Chromium and WebKit. The proof
requires no changes to the emulation sources, no pthreads, no SharedArrayBuffer,
and no Asyncify. The upstream frame-at-a-time CPU entry point already returns
control to the browser after each emulated frame.

This branch provides an experimental build and a small libretro test frontend.
It is not the Rebit product integration or a published core release.

## Build

Requirements: Emscripten 3.1.74, CMake, GNU make, a native C compiler for Hatari's
CPU source generators, Python 3, and Node.js. Use a fresh checkout for this proof;
its build directories must not contain an earlier native build.

```sh
git submodule update --init --depth 1
source /path/to/emsdk/emsdk_env.sh
bash rebit/wasm/build.sh
python3 rebit/wasm/fixtures.py
```

Outputs, all ignored by Git:

- `build/hatarib_libretro_emscripten.a`: static libretro core for a WASM frontend.
- `build/hatarib-proof.mjs` and `.wasm`: browser test frontend plus linked core.
- `build/fixtures/`: generated game disks, original licenses, and hash manifest.

The reviewed build uses `-O3 -flto`, a 4 MiB stack, and a 128 MiB initial heap
with growth enabled. The linked proof WASM is 16,780,765 bytes, or approximately
2.3 MB with gzip. This includes support for the additional Atari machine types;
TT/Falcon are not covered by this proof. `reviewed-artifacts.json` records the
reviewed files. Rebuilds embed the current Git revision, so their digests can
differ from the initially reviewed build.

## Games and firmware

The download script pins commits and verifies original program SHA-256 values.
It creates 720 KiB FAT12 floppies with the game in `AUTO/GAME.PRG`, so the games
start without desktop interaction. No commercial game or Atari BIOS is included.

- [CORE](https://github.com/flindholm-lab/CORE), revision
  `9bdd939525c0e7d36e8015164dae0e81365fe2f0`, MIT: colour action game with music,
  tested on ST and STE. Space starts the game and dives through the rings.
- [Deputy Arsh](https://github.com/jvaneg/ARSH), revision
  `c6eab54bec50802838e3abc0bc38795c8e7e20d5`, MIT: monochrome endless runner,
  tested on ST. Enter starts; Z/X/C jump, kick, and slide.

The core's embedded EmuTOS 1.4 is used. These test configurations report 60 Hz
for CORE and 71 Hz for the monochrome game. A game's advertised PAL timing is
not used as a substitute for the actual emulated video timing.

## Browser proof

Use Playwright 1.61.1 with its Chromium/WebKit browser packages. The script finds
the package in the sibling `build-cores` repository by default; set
`REBIT_PLAYWRIGHT_ROOT` to a different directory containing `node_modules/playwright`
if needed. Browser system dependencies must also be available.

```sh
node rebit/wasm/browser-proof.mjs
REBIT_WASM_BROWSER=webkit node rebit/wasm/browser-proof.mjs
```

The runner starts an ephemeral HTTP server bound only to `127.0.0.1`, and closes
it and the browser on completion. It serves the module, games, and test frontend
from the same origin, without cross-origin isolation headers.

The tests cover:

1. Actual game boot and keyboard input in ST/STE and monochrome modes.
2. Rendering and nonzero emulated audio output.
3. Save, run 300 input frames, restore, repeat those inputs, and compare the full
   8 MiB serialized state, rendered picture, and final frame's audio samples.
4. A 1,500-frame throughput sample for each configuration.
5. Twenty seconds of animation-frame-driven CORE playback with Web Audio enabled.

Results and screenshots are written to `build/proof-{browser}/`. The reviewed
results are also recorded in `results.json`.

For manual use, serve this repository on loopback and open the proof:

```sh
python3 -m http.server 4186 --bind 127.0.0.1
# http://127.0.0.1:4186/rebit/wasm/index.html
# Add ?game=arsh for the monochrome game or ?machine=ste for STE.
```

## Reviewed results — 2026-10-05

CPU: Intel Core i5-9400F, Linux x86-64. Chromium ran on the host; WebKit ran in
the cached `mcr.microsoft.com/playwright:v1.61.1-noble` container, because the
host lacks WebKit's Ubuntu library dependencies. The container had no external
network access. Both used the same locally built WASM and game files.

| Browser  | Game / machine   | Mean frame | p95 frame | Unpaced throughput |
| -------- | ---------------- | ---------- | --------- | ------------------ |
| Chromium | CORE / ST        | 3.72 ms    | 5.0 ms    | 263 FPS            |
| Chromium | CORE / STE       | 3.77 ms    | 5.1 ms    | 260 FPS            |
| Chromium | Deputy Arsh / ST | 3.09 ms    | 3.2 ms    | 316 FPS            |
| WebKit   | CORE / ST        | 4.49 ms    | 6.0 ms    | 219 FPS            |
| WebKit   | CORE / STE       | 4.42 ms    | 6.0 ms    | 221 FPS            |
| WebKit   | Deputy Arsh / ST | 3.64 ms    | 4.0 ms    | 267 FPS            |

CORE's timed playback achieved 59.85 FPS in Chromium and 59.91 FPS in WebKit.
Frame timings include the core and C framebuffer conversion, but the unpaced
loop draws the HTML canvas only periodically. The separate timed check renders
through requestAnimationFrame and schedules Web Audio. These are short desktop
tests, not physical phone, thermal, or production network benchmarks.

All six game/machine/browser cases passed. The restored state, picture, and
audio matched within each run; each corresponding game's state SHA-256 also
matched across Chromium and WebKit. This limited input sequence does not
establish general netplay determinism.

## Remaining product work

- Integrate the static archive with Rebit's RetroArch/Nostalgist frontend, pin
  provenance, and publish a reviewed versioned artifact.
- Add the system/upload rules, multidisk UI, touch controls, and TOS import.
- Connect changed floppy files to durable Rebit saves. This proof checks native
  snapshot restoration, not persistence through a fresh browser session.
- Benchmark physical Android/iOS WebViews and a broader game sample. IPF requires
  an additional library and is not included in this build.
- Treat netplay as a separate validation effort: keyboard/mouse synchronization,
  disk writes, timing, and snapshot size all need review.
