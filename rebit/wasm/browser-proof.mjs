import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(
  path.join(
    process.env.REBIT_PLAYWRIGHT_ROOT ?? path.resolve(root, "../build-cores"),
    "package.json",
  ),
);
const { chromium, webkit } = require("playwright");
const browserName = process.env.REBIT_WASM_BROWSER ?? "chromium";
assert.ok(["chromium", "webkit"].includes(browserName));
const output = path.join(root, "build", `proof-${browserName}`);
await mkdir(output, { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    const file = path.resolve(root, "." + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep)) throw new Error("Invalid path");
    const types = {
      ".mjs": "text/javascript",
      ".html": "text/html",
      ".wasm": "application/wasm",
      ".st": "application/octet-stream",
      ".json": "application/json",
    };
    if (!types[path.extname(file)]) throw new Error("Invalid file type");
    response.setHeader("Content-Type", types[path.extname(file)]);
    response.end(await readFile(file));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await { chromium, webkit }[browserName].launch({
  headless: true,
});
const results = [];
try {
  for (const [game, machine] of [
    ["core", "st"],
    ["core", "ste"],
    ["arsh", "st"],
  ]) {
    const page = await browser.newPage();
    page.setDefaultTimeout(120_000);
    const logs = [],
      errors = [];
    page.on("console", (m) => logs.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    const name = `${game}-${machine}`;
    try {
      const start = performance.now();
      await page.goto(
        `${base}/rebit/wasm/index.html?game=${game}&machine=${machine}`,
      );
      await page.waitForFunction(() => !!window.proof);
      const loadMs = performance.now() - start;
      await page.evaluate(() => window.proof.run(1000));
      await page
        .locator("canvas")
        .screenshot({ path: path.join(output, `${name}-boot.png`) });
      const initial = await page.evaluate(() =>
        window.proof.canvas.toDataURL(),
      );
      await page.evaluate(
        (key) => {
          const p = window.proof;
          p.key(key, true);
          p.run(5);
          p.key(key, false);
          p.run(120);
        },
        game === "arsh" ? 13 : 32,
      );
      await page
        .locator("canvas")
        .screenshot({ path: path.join(output, `${name}-playing.png`) });
      assert.notEqual(
        await page.evaluate(() => window.proof.canvas.toDataURL()),
        initial,
        `${name}: input/gameplay did not change the screen`,
      );
      const stats = await page.evaluate(async () => {
        const p = window.proof,
          m = p.core;
        const sha = async (b) =>
          Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", b)),
            (x) => x.toString(16).padStart(2, "0"),
          ).join("");
        const saved = p.save();
        const runSequence = () => {
          for (let i = 0; i < 300; i++) {
            if (i === 10) p.key(32, true);
            if (i === 15) p.key(32, false);
            m._proof_run();
          }
          p.render();
          return p.save();
        };
        const first = runSequence();
        const picture = p.canvas.toDataURL();
        const audio = m.HEAPU8.slice(
          m._proof_audio(),
          m._proof_audio() + m._proof_audio_frames() * 4,
        );
        p.load(saved);
        const second = runSequence();
        const pictureRestored = picture === p.canvas.toDataURL();
        const secondAudio = m.HEAPU8.slice(
          m._proof_audio(),
          m._proof_audio() + m._proof_audio_frames() * 4,
        );
        const durations = [];
        const benchStart = performance.now();
        for (let i = 0; i < 1500; i++) {
          const t = performance.now();
          m._proof_run();
          durations.push(performance.now() - t);
          if (i % 50 === 0) {
            p.render();
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
        const elapsed = performance.now() - benchStart;
        durations.sort((a, b) => a - b);
        return {
          fps: m._proof_fps(),
          width: m._proof_width(),
          height: m._proof_height(),
          stateBytes: saved.length,
          firstStateSha256: await sha(first),
          secondStateSha256: await sha(second),
          pictureRestored,
          audioMatched: (await sha(audio)) === (await sha(secondAudio)),
          audioNonzero: m._proof_audio_nonzero(),
          heapBytes: m.HEAPU8.length,
          benchmarkFrames: durations.length,
          unpacedFps: 1500 / (elapsed / 1000),
          meanFrameMs: durations.reduce((a, b) => a + b, 0) / durations.length,
          p95FrameMs: durations[Math.floor(durations.length * 0.95)],
          maxFrameMs: durations.at(-1),
          sharedMemory: m.HEAPU8.buffer.constructor.name,
        };
      });
      assert.equal(
        stats.firstStateSha256,
        stats.secondStateSha256,
        `${name}: restored state diverged`,
      );
      assert.equal(
        stats.pictureRestored,
        true,
        `${name}: restored picture diverged`,
      );
      assert.equal(
        stats.audioMatched,
        true,
        `${name}: restored audio diverged`,
      );
      assert.ok(stats.audioNonzero > 0, `${name}: no nonzero audio output`);
      assert.equal(stats.sharedMemory, "ArrayBuffer");
      if (game === "core" && machine === "st") {
        await page.locator("#sound").click();
        const before = await page.evaluate(() => ({
          frame: window.proof.core._proof_frame(),
          time: performance.now(),
        }));
        await page.locator("#run").click();
        await page.waitForTimeout(20_000);
        await page.locator("#run").click();
        const after = await page.evaluate(() => ({
          frame: window.proof.core._proof_frame(),
          time: performance.now(),
        }));
        stats.pacedSeconds = (after.time - before.time) / 1000;
        stats.pacedFrames = after.frame - before.frame;
        stats.pacedFps = stats.pacedFrames / stats.pacedSeconds;
        assert.ok(
          stats.pacedFps > stats.fps * 0.95,
          `${name}: realtime playback fell behind`,
        );
        assert.ok(
          stats.pacedFps < stats.fps * 1.05,
          `${name}: realtime playback ran too fast`,
        );
      }
      assert.deepEqual(errors, []);
      results.push({ game, machine, browser: browserName, loadMs, ...stats });
      console.log(JSON.stringify(results.at(-1)));
    } finally {
      await writeFile(
        path.join(output, `${name}.log`),
        [...logs, ...errors].join("\n"),
      );
      await page.close();
    }
  }
} finally {
  await writeFile(
    path.join(output, "results.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
