// Probe: run the editor's FBX import path headlessly on real files.
//
// `src/editor/fbxImport.js` does three things in sequence — sniff the header,
// parse with FBXLoader, re-export as a binary GLB for the normal unpack
// pipeline. Only the middle step needs a browser, and only for textures, so
// all three run here against files on disk. That makes "does FBX import
// work?" answerable without dragging anything into the editor.
//
// The header sniff is duplicated from fbxImport.js rather than imported
// because that module pulls in Tauri IPC and a Zustand store at module load.
// Keep the two in sync — the constants below are the contract.
//
//   node scripts/run-fbx-import-probe.mjs <file.fbx> [more.fbx ...]
//   node scripts/run-fbx-import-probe.mjs            # vendored Y Bot set
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// FBXLoader/GLTFExporter touch these at module scope only; the vendored test
// models carry no embedded textures, so no real canvas is needed.
globalThis.self = globalThis;
globalThis.document ??= { createElement: () => ({ style: {} }), createElementNS: () => ({ style: {} }) };
globalThis.window ??= { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
class NodeFileReader {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buf) => {
      this.result = buf;
      this.onloadend?.();
    });
  }
}
globalThis.FileReader ??= NodeFileReader;

const MAX_ASCII_FBX_BYTES = 256 * 1024 * 1024;
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

/** Mirrors fbxImport.js `inspectFbx` — the reason an import is rejected. */
function inspect(bytes, size) {
  const text = new TextDecoder().decode(bytes.slice(0, 4096));
  if (text.startsWith(LFS_POINTER_PREFIX)) {
    const oid = text.match(/oid sha256:(\w+)/)?.[1] ?? "?";
    const real = Number(text.match(/size (\d+)/)?.[1] ?? 0);
    throw new Error(`Git LFS pointer, not the model (oid ${oid.slice(0, 10)}…, real size ${real} bytes)`);
  }
  const binary = text.startsWith("Kaydara FBX Binary  \0");
  const version = binary
    ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(23, true)
    : Number(text.match(/FBXVersion:\s*(\d+)/)?.[1] ?? 0);
  if (!binary && !version) throw new Error("no FBX header/version found");
  if (version < 7000) throw new Error(`FBX ${version} is too old; 7000+ required`);
  if (!binary && size > MAX_ASCII_FBX_BYTES) throw new Error("ASCII FBX too large");
  return { binary, version };
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.join(scriptDir, "../src/modules/character-controller/assets/source");
const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(sourceDir).filter((f) => f.toLowerCase().endsWith(".fbx")).map((f) => path.join(sourceDir, f));

let failures = 0;
for (const file of targets) {
  const label = path.basename(file);
  try {
    const buf = fs.readFileSync(file);
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const { binary, version } = inspect(bytes, buf.byteLength);

    const t0 = performance.now();
    const root = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
    const parseMs = performance.now() - t0;

    let meshes = 0;
    let skinned = 0;
    let triangles = 0;
    let bones = 0;
    const materials = new Set();
    const textures = new Set();
    root.traverse((o) => {
      if (o.isBone) bones++;
      if (!o.isMesh) return;
      meshes++;
      if (o.isSkinnedMesh) skinned++;
      const g = o.geometry;
      triangles += Math.floor((g.index?.count ?? g.getAttribute("position")?.count ?? 0) / 3);
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m) continue;
        materials.add(m.name || m.uuid);
        for (const slot of ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap"]) {
          if (m[slot]?.image) textures.add(m[slot].uuid);
        }
      }
    });
    const clips = root.animations ?? [];

    const t1 = performance.now();
    const glb = await new GLTFExporter().parseAsync(root, {
      binary: true,
      animations: clips,
      onlyVisible: false,
      truncateDrawRange: false,
    });
    const exportMs = performance.now() - t1;
    if (!(glb instanceof ArrayBuffer)) throw new Error("conversion did not produce a binary GLB");

    console.log(
      `PASS  ${label}\n` +
        `      ${binary ? "binary" : "ascii"} FBX ${version} · ${(buf.byteLength / 1048576).toFixed(2)} MB\n` +
        `      ${meshes} mesh(es) (${skinned} skinned) · ${triangles.toLocaleString()} tris · ${bones} bones\n` +
        `      ${materials.size} material(s) · ${textures.size} texture(s) · ${clips.length} clip(s)` +
        (clips.length ? ` [${clips.map((c) => `${c.name} ${c.duration.toFixed(2)}s`).join(", ")}]` : "") +
        `\n      parse ${parseMs.toFixed(0)}ms · export ${exportMs.toFixed(0)}ms → GLB ${(glb.byteLength / 1048576).toFixed(2)} MB`,
    );
  } catch (err) {
    failures++;
    console.log(`FAIL  ${label}\n      ${err.message ?? err}`);
  }
}
console.log(`\n${targets.length - failures}/${targets.length} passed`);
process.exit(failures ? 1 : 0);
