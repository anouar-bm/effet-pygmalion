// Renders scenes.html frame by frame (seeking the Motion timeline) into an mp4, then muxes the narration.
// usage: node render.mjs [--preview t1,t2,...] [--mux-only]
//   --preview writes PNG stills instead of the video; --mux-only reuses silent.mp4 and only redoes the audio.
import puppeteer from "puppeteer-core";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";

const dir = new URL(".", import.meta.url).pathname;
const FPS = 25, PAD = 0.7, TAIL = 0.9; // must match scenes.html
// Music bed gain (dB): -7 dB under the voice in pauses, -17 dB while it speaks (measured: voice ≈ -28 LUFS, music ≈ -17 LUFS).
const MUSIC_GAP_DB = -18.7, MUSIC_SPEECH_DB = -28.7, DUCK_IN = 0.4, DUCK_OUT = 0.8;
const CHROME = process.env.CHROME || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const timings = JSON.parse(await readFile(dir + "timings.json", "utf8"));
const themeIdx = process.argv.indexOf("--theme");
const theme = themeIdx > -1 ? process.argv[themeIdx + 1] : "dark";
if (!["dark", "light"].includes(theme)) throw new Error("--theme must be dark or light");
const suffix = theme === "light" ? "-light" : "";

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--hide-scrollbars"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  page.on("pageerror", e => { throw e; });
  await page.evaluateOnNewDocument(t => { window.TIMINGS = t; }, timings);
  await page.goto(`file://${dir}scenes.html?theme=${theme}`,{ waitUntil: "networkidle0" });
  await page.waitForFunction("window.READY === true", { timeout: 20000 });
  const total = await page.evaluate("window.TOTAL");
  const seekTo = t => page.evaluate(t => new Promise(r => { seek(t); requestAnimationFrame(() => requestAnimationFrame(r)); }), t);

  const previewIdx = process.argv.indexOf("--preview");
  if (previewIdx > -1) {
    for (const t of process.argv[previewIdx + 1].split(",").map(Number)) {
      await seekTo(t);
      await page.screenshot({ path: `${dir}preview${suffix}-${t}.png` });
    }
    console.log("previews written, total", total.toFixed(2));
  } else if (!process.argv.includes("--mux-only")) {
    const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "medium", `${dir}silent${suffix}.mp4`], { stdio: ["pipe", "inherit", "inherit"] });
    const ffDone = new Promise((res, rej) => ff.on("close", c => c === 0 ? res() : rej(new Error("ffmpeg video exit " + c))));
    const frames = Math.ceil(total * FPS);
    for (let i = 0; i < frames; i++) {
      await seekTo(i / FPS);
      const buf = await page.screenshot({ type: "jpeg", quality: 92 });
      if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once("drain", r));
      if (i % 250 === 0) console.log(`frame ${i}/${frames}`);
    }
    ff.stdin.end();
    await ffDone;
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
    mix += ",loudnorm=I=-16:TP=-1.5[a]"; // phone-friendly loudness; the raw narration sits around -28 LUFS
    const out = `${dir}../explainer${suffix}.mp4`;
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", `${dir}silent${suffix}.mp4`, ...inputs, "-filter_complex", mix,
      "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-ar", "48000", "-c:a", "aac", "-b:a", "160k", out], { stdio: "inherit" });
    console.log("done:", out, total.toFixed(1) + "s");
  }
} finally {
  await browser.close();
}
