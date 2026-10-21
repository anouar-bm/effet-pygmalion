// Generates one narration mp3 per scene with ElevenLabs, then writes timings.json (durations via ffprobe).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const dir = new URL(".", import.meta.url).pathname;
const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error("ELEVENLABS_API_KEY missing");
const voice = process.argv[2];
if (!voice) throw new Error("usage: node tts.mjs <voice_id>");

const scenes = JSON.parse(await readFile(dir + "narration.json", "utf8"));
await mkdir(dir + "audio", { recursive: true });

const timings = [];
for (const s of scenes) {
  const out = `${dir}audio/${s.id}.mp3`;
  if (!existsSync(out)) {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ text: s.text, model_id: "eleven_multilingual_v2", language_code: "fr",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    });
    if (!res.ok) throw new Error(`${s.id}: ${res.status} ${await res.text()}`);
    await writeFile(out, Buffer.from(await res.arrayBuffer()));
  }
  const dur = parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]).toString());
  timings.push({ id: s.id, duration: dur });
  console.log(s.id, dur.toFixed(2));
}
await writeFile(dir + "timings.json", JSON.stringify(timings, null, 2));
