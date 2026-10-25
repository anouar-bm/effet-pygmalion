// Renders scenes.html frame by frame (seeking the Motion timeline) into an mp4, then muxes the narration.
// usage: [WORKERS=n] node render.mjs [--preview t1,t2,...] [--mux-only]
//   --preview writes PNG stills instead of the video; --mux-only reuses silent.mp4 and only redoes the audio.
import puppeteer from "puppeteer-core";
import { readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";

const dir = new URL(".", import.meta.url).pathname;
const FPS = 25, PAD = 0.7, TAIL = 0.9; // must match scenes.html
// Music bed gain (dB): -7 dB under the voice in pauses, -17 dB while it speaks (measured: voice ≈ -22.5 LUFS, music ≈ -17 LUFS).
const MUSIC_GAP_DB = -13.2, MUSIC_SPEECH_DB = -23.2, DUCK_IN = 0.4, DUCK_OUT = 0.8;
const CHROME = process.env.CHROME || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const timings = JSON.parse(await readFile(dir + "timings.json", "utf8"));
const narration = JSON.parse(await readFile(dir + "narration.json", "utf8"));

// Replaces each run of words spelling `from` with one word `to` spanning their times, so the cue splitter keeps it whole.
function respell(words, captions = {}) {
  let out = words;
  for (const [from, to] of Object.entries(captions)) {
    const n = from.split(" ").length;
    const i = out.findIndex((_, k) => out.slice(k, k + n).map(x => x.w).join(" ") === from);
    if (i < 0) throw new Error(`caption "${from}" not found in narration words`);
    out = [...out.slice(0, i), { w: to, start: out[i].start, end: out[i + n - 1].end }, ...out.slice(i + n)];
  }
  return out;
}
{
  const w = respell([{ w: "de", start: 1, end: 2 }, { w: "Qalaat", start: 2, end: 3 }, { w: "Al", start: 3, end: 4 }, { w: "x.", start: 4, end: 5 }], { "Qalaat Al": "El Kelaâ" });
  if (JSON.stringify(w) !== JSON.stringify([{ w: "de", start: 1, end: 2 }, { w: "El Kelaâ", start: 2, end: 4 }, { w: "x.", start: 4, end: 5 }])) throw new Error("respell selftest failed");
}

// Captions (../explainer.vtt): each sentence split into the fewest balanced lines of at most ~7 words / 42 chars,
// timed from the ElevenLabs word timestamps in timings.json (written by tts.mjs).
// A scene's optional "captions" map in narration.json shows a spoken phrase written differently (phonetic spelling → official).
const vttTime = t => new Date(t * 1000).toISOString().slice(11, 23);
const cues = [];
let speech = 0;
timings.forEach((s, idx) => {
  if (!s.words?.length) throw new Error(`no word timestamps for scene ${s.id}: rerun tts.mjs`);
  speech += PAD;
  const sentences = [[]];
  for (const w of respell(s.words, narration[idx]?.captions)) { sentences.at(-1).push(w); if (/[.!?…]$/.test(w.w)) sentences.push([]); }
  for (const sw of sentences.filter(x => x.length)) {
    const k = Math.max(Math.ceil(sw.map(x => x.w).join(" ").length / 42), Math.ceil(sw.length / 7));
    for (let j = 0; j < k; j++) {
      const l = sw.slice(Math.round(j * sw.length / k), Math.round((j + 1) * sw.length / k));
      cues.push(`${vttTime(speech + l[0].start)} --> ${vttTime(speech + l.at(-1).end)}\n${l.map(x => x.w).join(" ")}`);
    }
  }
  speech += s.duration + TAIL;
});
await writeFile(`${dir}../explainer.vtt`, "WEBVTT\n\n" + cues.join("\n\n") + "\n");
if (narration.length !== timings.length) throw new Error("narration.json and timings.json disagree: rerun tts.mjs");

const themeIdx = process.argv.indexOf("--theme");
const theme = themeIdx > -1 ? process.argv[themeIdx + 1] : "dark";
if (!["dark", "light"].includes(theme)) throw new Error("--theme must be dark or light");
const suffix = theme === "light" ? "-light" : "";

// Workers render contiguous frame ranges in parallel (one headless browser each); the timeline is a pure
// function of time, so the chunks join seamlessly. Default: half the CPU cores.
const WORKERS = Number(process.env.WORKERS) || Math.max(1, Math.floor(os.cpus().length / 2));

async function openPage() {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--hide-scrollbars"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  page.on("pageerror", e => { throw e; });
  await page.evaluateOnNewDocument(t => { window.TIMINGS = t; }, timings);
  await page.goto(`file://${dir}scenes.html?theme=${theme}`, { waitUntil: "networkidle0" });
  await page.waitForFunction("window.READY === true", { timeout: 20000 });
  const seekTo = t => page.evaluate(t => new Promise(r => { seek(t); requestAnimationFrame(() => requestAnimationFrame(r)); }), t);
  return { browser, page, seekTo, total: await page.evaluate("window.TOTAL") };
}

// Renders frames [from, to) into one H.264 segment.
async function renderChunk(from, to, out, onFrame) {
  const { browser, page, seekTo } = await openPage();
  try {
    const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "medium", out], { stdio: ["pipe", "inherit", "inherit"] });
    const ffDone = new Promise((res, rej) => ff.on("close", c => c === 0 ? res() : rej(new Error(`ffmpeg ${out} exit ${c}`))));
    for (let i = from; i < to; i++) {
      await seekTo(i / FPS);
      const buf = await page.screenshot({ type: "jpeg", quality: 92, optimizeForSpeed: true });
      if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once("drain", r));
      onFrame();
    }
    ff.stdin.end();
    await ffDone;
  } finally {
    await browser.close();
  }
}

const previewIdx = process.argv.indexOf("--preview");
const probe = await openPage();
const total = probe.total;
try {
  if (previewIdx > -1) {
    for (const t of process.argv[previewIdx + 1].split(",").map(Number)) {
      await probe.seekTo(t);
      await probe.page.screenshot({ path: `${dir}preview${suffix}-${t}.png` });
    }
    console.log("previews written, total", total.toFixed(2));
  }
} finally {
  await probe.browser.close();
}

if (previewIdx === -1 && !process.argv.includes("--mux-only")) {
  const frames = Math.ceil(total * FPS), started = Date.now();
  let done = 0;
  const onFrame = () => { if (++done % 500 === 0) console.log(`frame ${done}/${frames} · ${(done / ((Date.now() - started) / 1000)).toFixed(1)} fps`); };
  const parts = Array.from({ length: WORKERS }, (_, k) => ({
    from: Math.floor(k * frames / WORKERS), to: Math.floor((k + 1) * frames / WORKERS), file: `${dir}silent-part${k}.mp4` }));
  await Promise.all(parts.map(p => renderChunk(p.from, p.to, p.file, onFrame)));
  await writeFile(`${dir}parts.txt`, parts.map(p => `file '${p.file}'`).join("\n") + "\n");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", `${dir}parts.txt`, "-c", "copy", `${dir}silent${suffix}.mp4`], { stdio: "inherit" });
  for (const p of parts) await rm(p.file);
  await rm(`${dir}parts.txt`);
  console.log(`video: ${frames} frames with ${WORKERS} workers in ${((Date.now() - started) / 1000).toFixed(0)} s`);
}

if (previewIdx === -1) {
  // Place each narration clip at its scene's speech start.
  const inputs = [], filters = [];
  let t = 0;
  timings.forEach((s, i) => {
    inputs.push("-i", `${dir}audio/${s.id}.mp3`);
    const ms = Math.round((t + PAD) * 1000);
    filters.push(`[${i + 1}:a]adelay=${ms}|${ms}[a${i}]`);
    t += PAD + s.duration + TAIL;
  });
  let mix = `${filters.join(";")};${timings.map((_, i) => `[a${i}]`).join("")}amix=inputs=${timings.length}:normalize=0`;
  const music = `${dir}audio/music.mp3`;
  if (existsSync(music)) {
    // Duck the music around each narration clip: 1 while speaking, ramping in DUCK_IN before and out DUCK_OUT after.
    const speaking = [];
    let t2 = 0;
    timings.forEach(s => { speaking.push([t2 + PAD, t2 + PAD + s.duration]); t2 += PAD + s.duration + TAIL; });
    const duck = speaking.map(([a, b]) => `clip(min((t-${(a - DUCK_IN).toFixed(2)})/${DUCK_IN}\\,(${(b + DUCK_OUT).toFixed(2)}-t)/${DUCK_OUT})\\,0\\,1)`)
      .reduce((acc, e) => `max(${acc}\\,${e})`);
    const gain = `pow(10\\,(${MUSIC_GAP_DB}+(${MUSIC_SPEECH_DB - MUSIC_GAP_DB})*${duck})/20)`;
    inputs.push("-i", music);
    mix += `[voice];[${timings.length + 1}:a]atrim=0:${total.toFixed(2)},volume=eval=frame:volume='${gain}',afade=t=in:d=1.5,afade=t=out:st=${(total - 3).toFixed(2)}:d=3[bed];[voice][bed]amix=inputs=2:normalize=0`;
  }
  mix += ",loudnorm=I=-16:TP=-1.5[a]"; // phone-friendly loudness; the raw narration sits around -22.5 LUFS
  const out = `${dir}../explainer${suffix}.mp4`;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", `${dir}silent${suffix}.mp4`, ...inputs, "-filter_complex", mix,
    "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-ar", "48000", "-c:a", "aac", "-b:a", "160k", out], { stdio: "inherit" });
  console.log("done:", out, total.toFixed(1) + "s");
}
