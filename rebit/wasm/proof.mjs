import createHatariB from "../../build/hatarib-proof.mjs";

const canvas = document.querySelector("canvas");
const context = canvas.getContext("2d");
const status = document.querySelector("#status");
const query = new URLSearchParams(location.search);
const game = query.get("game") === "arsh" ? "arsh" : "core";
const core = await createHatariB({ printErr: (text) => console.warn(text) });
for (const path of ["/system", "/saves", "/roms"]) core.FS.mkdirTree(path);
const disk = new Uint8Array(
  await (await fetch(`../../build/fixtures/${game}.st`)).arrayBuffer(),
);
core.FS.writeFile("/roms/game.st", disk);
const loaded = core.ccall(
  "proof_init",
  "number",
  ["string", "number", "number"],
  [
    "/roms/game.st",
    query.get("machine") === "ste" ? 2 : 0,
    game === "arsh" ? 1 : 0,
  ],
);
if (!loaded) throw new Error("Game failed to load");

let running = false;
let last = 0;
let credit = 0;
let audio;
let audioAt = 0;
function render() {
  const w = core._proof_width(),
    h = core._proof_height();
  if (!w || !h) return;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const bytes = new Uint8ClampedArray(
    core.HEAPU8.buffer,
    core._proof_pixels(),
    w * h * 4,
  );
  context.putImageData(new ImageData(new Uint8ClampedArray(bytes), w, h), 0, 0);
}
function sound() {
  const frames = core._proof_audio_frames();
  if (!audio || audio.state !== "running" || !frames) return;
  const buffer = audio.createBuffer(2, frames, core._proof_sample_rate());
  const data = new Int16Array(
    core.HEAPU8.buffer,
    core._proof_audio(),
    frames * 2,
  );
  for (let channel = 0; channel < 2; ++channel) {
    const output = buffer.getChannelData(channel);
    for (let i = 0; i < frames; ++i) output[i] = data[i * 2 + channel] / 32768;
  }
  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.connect(audio.destination);
  audioAt = Math.max(audioAt, audio.currentTime + 0.035);
  if (audioAt > audio.currentTime + 0.25) audioAt = audio.currentTime + 0.035;
  source.start(audioAt);
  audioAt += buffer.duration;
}
function tick(now) {
  requestAnimationFrame(tick);
  if (!running) {
    last = now;
    return;
  }
  credit = Math.min(credit + Math.min(now - last, 100), 100);
  last = now;
  const step = 1000 / core._proof_fps();
  while (credit >= step) {
    core._proof_run();
    sound();
    credit -= step;
  }
  render();
}
requestAnimationFrame(tick);
const special = {
  Enter: 13,
  Escape: 27,
  ArrowUp: 273,
  ArrowDown: 274,
  ArrowRight: 275,
  ArrowLeft: 276,
};
for (const type of ["keydown", "keyup"])
  addEventListener(type, (event) => {
    const key =
      special[event.key] ??
      (event.key.length === 1 ? event.key.toLowerCase().charCodeAt(0) : 0);
    if (!key || event.repeat) return;
    event.preventDefault();
    core._proof_key(key, type === "keydown" ? 1 : 0);
  });
document.querySelector("#run").onclick = () => {
  running = !running;
  credit = 0;
};
document.querySelector("#sound").onclick = async () => {
  audio ??= new AudioContext();
  await audio.resume();
};
window.proof = {
  core,
  render,
  canvas,
  run(count) {
    for (let i = 0; i < count; ++i) core._proof_run();
    render();
  },
  key(key, down) {
    core._proof_key(key, down ? 1 : 0);
  },
  save() {
    if (!core._proof_save()) throw new Error("Save failed");
    return core.HEAPU8.slice(
      core._proof_state(),
      core._proof_state() + core._proof_state_size(),
    );
  },
  load(state) {
    if (state.length !== core._proof_state_size())
      throw new Error("Wrong snapshot length");
    core.HEAPU8.set(state, core._proof_state());
    if (!core._proof_load()) throw new Error("Restore failed");
  },
};
status.textContent = `${game} loaded · ${core._proof_fps()} Hz · EmuTOS · press Run to play`;
