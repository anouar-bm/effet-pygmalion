// Generates one narration mp3 per scene with ElevenLabs (with character timestamps), then writes timings.json:
// [{ id, duration, words: [{ w, start, end }] }]. Word times drive exact captions and let scenes cue on words.
// usage: node tts.mjs <voice_id>        uses the authenticated `elevenlabs` CLI; env: TTS_LANG (default fr)
//        node tts.mjs --selftest        checks the word grouping offline
// Cached: an existing audio/<id>.mp3 + audio/<id>.json is reused; delete both to regenerate a scene.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

// Group ElevenLabs character timings into words (split on whitespace).
function wordsFromAlignment({ characters, character_start_times_seconds: st, character_end_times_seconds: en }) {
  const words = [];
  let cur = null;
  characters.forEach((c, i) => {
    if (/\s/.test(c)) { if (cur) words.push(cur); cur = null; return; }
    if (!cur) cur = { w: "", start: st[i], end: en[i] };
    cur.w += c;
    cur.end = en[i];
  });
  if (cur) words.push(cur);
  return words;
}

if (process.argv[2] === "--selftest") {
  const chars = [..."Un  été."];
  const words = wordsFromAlignment({ characters: chars,
    character_start_times_seconds: chars.map((_, i) => i / 10), character_end_times_seconds: chars.map((_, i) => (i + 1) / 10) });
  assert.deepEqual(words, [{ w: "Un", start: 0, end: 0.2 }, { w: "été.", start: 0.4, end: 0.8 }]);
  console.log("selftest ok");
  process.exit(0);
}

const dir = new URL(".", import.meta.url).pathname;
const voice = process.argv[2];
if (!voice) throw new Error("usage: node tts.mjs <voice_id>");

const scenes = JSON.parse(await readFile(dir + "narration.json", "utf8"));
await mkdir(dir + "audio", { recursive: true });

const timings = [];
for (const s of scenes) {
  const mp3 = `${dir}audio/${s.id}.mp3`, align = `${dir}audio/${s.id}.json`;
  if (!existsSync(mp3) || !existsSync(align)) {
    const params = { voice_id: voice, output_format: "mp3_44100_128", text: s.text, model_id: "eleven_multilingual_v2",
      language_code: process.env.TTS_LANG || "fr", voice_settings: { stability: 0.5, similarity_boost: 0.75 } };
    const res = JSON.parse(execFileSync("elevenlabs", ["text-to-speech", "convert_with_timestamps", "--format", "json",
      "--params", JSON.stringify(params)], { maxBuffer: 64 << 20 }).toString());
    if (res.error) throw new Error(`${s.id}: ${res.error.message}`);
    const { audio_base64, alignment } = res;
    if (!audio_base64 || !alignment) throw new Error(`${s.id}: response without audio or alignment`);
    await writeFile(mp3, Buffer.from(audio_base64, "base64"));
    await writeFile(align, JSON.stringify(alignment));
  }
  const duration = parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp3]).toString());
  const words = wordsFromAlignment(JSON.parse(await readFile(align, "utf8")));
  timings.push({ id: s.id, duration, words });
  console.log(s.id, duration.toFixed(2) + "s", words.length, "words");
}
await writeFile(dir + "timings.json", JSON.stringify(timings, null, 2));
