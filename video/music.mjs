// Generates the background music bed (audio/music.mp3) once with the ElevenLabs Music API, sized to the video.
import { readFile, writeFile } from "node:fs/promises";

const dir = new URL(".", import.meta.url).pathname;
const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error("ELEVENLABS_API_KEY missing");
const PAD = 0.7, TAIL = 0.9, END_HOLD = 1.5; // must match scenes.html
const timings = JSON.parse(await readFile(dir + "timings.json", "utf8"));
const total = timings.reduce((t, s) => t + PAD + s.duration + TAIL, 0) - TAIL + END_HOLD;

const res = await fetch("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128", {
  method: "POST",
  headers: { "xi-api-key": key, "content-type": "application/json" },
  body: JSON.stringify({
    prompt: "Calm, warm and hopeful instrumental underscore for a narrated educational video about teachers believing in their pupils. "
      + "Around 85 BPM. Soft solo piano with light sustained strings, sparse and unobtrusive so a voice-over stays clear, no vocals, no drums at first. "
      + "Gently builds in the last third with fuller strings and a soft pulse, ending on an uplifting, resolved final chord.",
    music_length_ms: Math.ceil(total + 2) * 1000,
    force_instrumental: true,
  }),
});
if (!res.ok) throw new Error(`music: ${res.status} ${await res.text()}`);
await writeFile(dir + "audio/music.mp3", Buffer.from(await res.arrayBuffer()));
console.log("music.mp3 written for", total.toFixed(1) + "s");
