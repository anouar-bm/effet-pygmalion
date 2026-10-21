// Generates a cover illustration (page hero + video poster) with OpenAI gpt-image-2.5-flare (the fast everyday model; gpt-image-2.5-sunburst is the slower, most precise one).
// usage: node cover.mjs "<prompt>" [out.png]   — writes cover.png next to this script by default.
import { writeFile } from "node:fs/promises";

const key = process.env.OPENAI_API_KEY_PERS;
if (!key) throw new Error("OPENAI_API_KEY_PERS missing");
const [prompt, out = new URL("cover.png", import.meta.url).pathname] = process.argv.slice(2);
if (!prompt) throw new Error('usage: node cover.mjs "<prompt>" [out.png]');

const res = await fetch("https://api.openai.com/v1/images/generations", {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({ model: "gpt-image-2.5-flare", prompt, size: "1536x1024", quality: "high", n: 1 }),
});
if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
const { data } = await res.json();
await writeFile(out, Buffer.from(data[0].b64_json, "base64"));
console.log(out, "written");
