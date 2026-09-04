// Drive a GI look A/B against the LIVE editor: pin the pose, flip dev flags,
// let the field settle, capture the frame AND the transport numbers.
//
// WHY A SCRIPT, AND WHY THE POSE IS RE-PINNED IN A LOOP. §11.47's method rule:
// a change to the shadow term, the light's transform or the g-buffer's
// resolution is a LOOK change and needs a look receipt, and a look receipt is
// an image at a FIXED pose. This editor's pose drifts — a human or a second
// agent session moves it between calls — and an arm captured at a different
// pose than its twin measures the pose, not the change. So the camera is
// re-asserted every 500 ms for the whole settle window, inside the same
// connection that takes the shot.
//
//   node scripts/gi-look-ab.mjs --out shots/base --settle 12000 \
//        --flags '{"__giGatherLosLive":null}'
//
// Writes <out>.png and <out>.json (the profile_giPasses payload). --cam takes
// `x,y,z:tx,ty,tz`; the default is the Level pose the fidelity work uses.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const out = arg("out");
if (!out) {
  console.error("usage: node scripts/gi-look-ab.mjs --out <path-without-extension> " +
    "[--flags '<json>'] [--settle ms] [--cam x,y,z:tx,ty,tz] [--size WxH] [--rebuild]");
  process.exit(2);
}
const flags = JSON.parse(arg("flags", "{}"));
const settle = Number(arg("settle", 12000));
const [w, h] = arg("size", "1612x943").split("x").map(Number);
const camSpec = arg("cam", "4.0505606763,0.8782496472,-6.8410183166:2.4517299361,0.4758155539,-0.4486105988");
const [pos, tgt] = camSpec.split(":").map((s) => s.split(",").map(Number));
const camera = { position: pos, target: tgt };

const here = path.dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, "..", "mcp", "server.mjs")],
  stderr: "ignore",
});
const client = new Client({ name: "gi-look-ab", version: "1.0.0" }, { capabilities: {} });
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (res?.isError) throw new Error(`${name}: ${text}`);
  return { text, image: (res?.content ?? []).find((c) => c.type === "image" && c.data) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await client.connect(transport);
// THE BROKER ATTACHES BEFORE THE EDITOR DOES. `client.connect` resolves as soon
// as the stdio server is up; the server then dials the broker and the broker
// then finds the editor, and a tool call landing in that gap fails with
// "needs the engine editor to be running and connected" — which reads exactly
// like the editor being down. Every spurious arm failure in this rig was this
// race, and the retry loop around it hid the cause by usually succeeding.
for (let i = 0; i < 40; i++) {
  try {
    const st = await call("editor_status");
    if (JSON.parse(st.text)?.connected) break;
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 500));
}
for (const [name, value] of Object.entries(flags)) {
  const r = await call("profile_giFlag", { name, value, rebuild: argv.includes("--rebuild") });
  console.error(`  flag ${r.text.replace(/\s+/g, " ")}`);
}
// `--pin once`: the path-tracer debug view RESETS ITS ACCUMULATION whenever the
// camera is touched, so re-asserting the pose every 500 ms holds it at ONE
// SAMPLE for ever — and a one-sample path trace is an ambient-only frame that
// looks like a bright, band-free, shadowless room. It is a convincing reference
// and it is not one. Pin once and leave it alone; drift is the price.
const t0 = Date.now();
await call("viewport_setCamera", camera);
if (arg("pin", "loop") === "loop") {
  do {
    await call("viewport_setCamera", camera);
    await sleep(500);
  } while (Date.now() - t0 < settle);
  await call("viewport_setCamera", camera);
} else {
  await sleep(settle);
}

const shot = await call("viewport_screenshot", { width: w, height: h });
if (shot.image) {
  writeFileSync(`${out}.png`, Buffer.from(shot.image.data, "base64"));
  console.error(`  wrote ${out}.png`);
}
const st = await call("profile_giPasses", { samples: Number(arg("samples", 12)) });
writeFileSync(`${out}.json`, st.text);
console.error(`  wrote ${out}.json`);
await client.close();
process.exit(0);
