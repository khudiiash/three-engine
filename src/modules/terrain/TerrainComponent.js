import * as THREE from "three/webgpu";
import { texture as tslTexture, uv, float, vec3, normalMap } from "three/tsl";
import { Component } from "../../engine/components/Component.js";
import { resolveAssetUrl, loadAssetMeta } from "../../engine/assetResolver.js";
import { applyTextureMeta } from "../../engine/textureMeta.js";

export const MAX_TERRAIN_LAYERS = 4;
export const SCULPT_TOOLS = ["raise", "lower", "smooth", "flatten", "sharpen", "erode", "noise"];

/** A fresh terrain layer — a full PBR surface (rock, grass, …), not just a
 *  texture. `albedo`/`normalMap`/`roughnessMap` are optional asset paths;
 *  `tint`/`roughness`/`metalness` are scalar fallbacks/multipliers so an
 *  untextured layer is still a valid flat-colored surface. */
export function makeTerrainLayer(overrides = {}) {
  return {
    albedo: "",
    normalMap: "",
    roughnessMap: "",
    tiling: 20,
    tint: "#8a8f7a",
    roughness: 0.95,
    metalness: 0,
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Binary <-> base64 helpers (scene-JSON friendly; keeps serialize.js generic).
// Bytes are stringified in chunks — spreading a large typed array straight into
// String.fromCharCode(...arr) overflows the call stack (a 256^2 splatmap is
// 256 KB).
// -----------------------------------------------------------------------------
function bytesToBinaryString(bytes) {
  const CHUNK = 8192;
  let out = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}
function encodeFloat32(arr) {
  return btoa(bytesToBinaryString(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)));
}
function decodeFloat32(str, length) {
  if (!str) return new Float32Array(length);
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const arr = new Float32Array(bytes.buffer);
  // Length mismatch (resolution changed elsewhere): start fresh rather than
  // reading past the buffer end.
  return arr.length === length ? arr : new Float32Array(length);
}
function encodeUint8(arr) {
  return btoa(bytesToBinaryString(arr));
}
function decodeUint8(str, length) {
  if (!str) return null;
  const bin = atob(str);
  if (bin.length !== length) return null;
  const arr = new Uint8Array(length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/** Default splatmap: layer 0 (R channel) fully covers the terrain. */
function makeDefaultSplat(resolution) {
  const arr = new Uint8Array(resolution * resolution * 4);
  for (let i = 0; i < resolution * resolution; i++) arr[i * 4] = 255;
  return arr;
}

// -----------------------------------------------------------------------------
// Brush math helpers (module-private).
// -----------------------------------------------------------------------------

/** Average of a vertex's 8-neighborhood (clamped at edges). */
function neighborAvg(src, cols, r, c, res) {
  let sum = 0, n = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr > res || cc < 0 || cc > res) continue;
      sum += src[rr * cols + cc];
      n++;
    }
  }
  return n ? sum / n : src[r * cols + c];
}

/** Minimum of a vertex's 8-neighborhood — morphological erosion carves down. */
function neighborMin(src, cols, r, c, res) {
  let mn = Infinity;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr > res || cc < 0 || cc > res) continue;
      mn = Math.min(mn, src[rr * cols + cc]);
    }
  }
  return Number.isFinite(mn) ? mn : src[r * cols + c];
}

function hash2(x, y, seed) {
  const h = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
/** Smooth 2D value noise in [0,1] — coherent bumps for the "noise" brush. */
function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, u), THREE.MathUtils.lerp(c, d, u), v);
}

/**
 * Heightmap-displaced ground plane with up to 4 splatmap-blended texture
 * layers. Geometry, heights, and the splatmap are all CPU-owned so brush
 * strokes can mutate live buffers directly for immediate visual feedback;
 * `props.heights`/`props.splatmap` are only re-encoded (base64) once per
 * stroke, on commit.
 *
 * Lives in the optional `terrain` module — not part of the base engine.
 * Sculpt/paint strokes are driven externally (the editor's viewport pointer
 * handlers call the brush methods); this component owns the data and the
 * material, exposing cheap mutation + commit methods.
 */
export class TerrainComponent extends Component {
  static type = "terrain";
  static label = "Terrain";
  static defaults = {
    size: 50,
    resolution: 128,
    splatResolution: 256,
    heights: "", // base64 Float32Array((resolution+1)^2), row-major
    splatmap: "", // base64 Uint8Array(splatResolution^2 * 4)
    layers: [makeTerrainLayer()], // PBR surfaces blended by the splatmap
    castShadow: false,
    receiveShadow: true,
  };
  static schema = [
    { key: "size", label: "Size", type: "number", min: 1, step: 1 },
    { key: "resolution", label: "Resolution", type: "number", min: 2, max: 512, step: 1 },
    { key: "splatResolution", label: "Splat Resolution", type: "number", min: 16, max: 1024, step: 1 },
    { key: "castShadow", label: "Cast Shadow", type: "boolean" },
    { key: "receiveShadow", label: "Receive Shadow", type: "boolean" },
  ];

  onAttach() {
    this.#buildGeometry();
    this.#buildSplatmap();
    this.#buildMaterial();
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.userData.entityId = this.entity.id;
    this.mesh.castShadow = !!this.props.castShadow;
    this.mesh.receiveShadow = !!this.props.receiveShadow;
    this.mesh.visible = this.enabled;
    this.entity.object3D.add(this.mesh);
    this.#loadLayerMaps();
  }

  onDetach() {
    if (!this.mesh) return;
    this.generation = (this.generation ?? 0) + 1;
    this.entity.object3D.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.splatTexture.dispose();
    this.#disposeLayerMaps();
    this.mesh = null;
  }

  onDisable() {
    if (this.mesh) this.mesh.visible = false;
  }

  onEnable() {
    if (this.mesh) this.mesh.visible = true;
  }

  onPropChanged(key) {
    if (key === "heights") {
      this.heightsArray = decodeFloat32(this.props.heights, (this.resolution + 1) ** 2);
      this.#applyHeightsToGeometry();
      return;
    }
    if (key === "splatmap") {
      const decoded = decodeUint8(this.props.splatmap, this.splatResolution * this.splatResolution * 4);
      this.splatData = decoded ?? makeDefaultSplat(this.splatResolution);
      this.splatTexture.image.data.set(this.splatData);
      this.splatTexture.needsUpdate = true;
      return;
    }
    if (key === "layers") {
      this.#loadLayerMaps();
      return;
    }
    if (key === "castShadow" || key === "receiveShadow") {
      if (this.mesh) this.mesh[key] = !!this.props[key];
      return;
    }
    // size / resolution / splatResolution: structural — full rebuild.
    this.onDetach();
    this.onAttach();
  }

  // ---------------------------------------------------------------------------
  // Geometry / heights
  // ---------------------------------------------------------------------------

  #buildGeometry() {
    const resolution = (this.resolution = Math.max(2, Math.floor(this.props.resolution ?? 128)));
    const size = this.props.size ?? 50;
    this.geometry = new THREE.PlaneGeometry(size, size, resolution, resolution);
    this.geometry.rotateX(-Math.PI / 2);
    this.heightsArray = decodeFloat32(this.props.heights, (resolution + 1) ** 2);
    this.#applyHeightsToGeometry();
  }

  #applyHeightsToGeometry() {
    const pos = this.geometry.getAttribute("position");
    const n = Math.min(pos.count, this.heightsArray.length);
    for (let i = 0; i < n; i++) pos.setY(i, this.heightsArray[i]);
    pos.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
  }

  /** Encode the live heights buffer back into `props` (call once per stroke). */
  commitHeights() {
    this.props.heights = encodeFloat32(this.heightsArray);
  }

  /**
   * Bilinear-sampled height at a local-space (x, z) — used by the editor's
   * brush indicator to hug the live surface (including mid-stroke changes,
   * before a commit re-encodes props.heights). Clamps outside the grid to the
   * nearest edge rather than extrapolating.
   */
  heightAtLocal(x, z) {
    const half = (this.props.size ?? 50) / 2;
    const cols = this.resolution + 1;
    const fc = THREE.MathUtils.clamp(((x + half) / (half * 2)) * this.resolution, 0, this.resolution);
    const fr = THREE.MathUtils.clamp(((z + half) / (half * 2)) * this.resolution, 0, this.resolution);
    const c0 = Math.floor(fc), r0 = Math.floor(fr);
    const c1 = Math.min(c0 + 1, this.resolution), r1 = Math.min(r0 + 1, this.resolution);
    const tc = fc - c0, tr = fr - r0;
    const h00 = this.heightsArray[r0 * cols + c0];
    const h10 = this.heightsArray[r0 * cols + c1];
    const h01 = this.heightsArray[r1 * cols + c0];
    const h11 = this.heightsArray[r1 * cols + c1];
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(h00, h10, tc),
      THREE.MathUtils.lerp(h01, h11, tc),
      tr,
    );
  }

  // ---------------------------------------------------------------------------
  // Splatmap
  // ---------------------------------------------------------------------------

  #buildSplatmap() {
    const resolution = (this.splatResolution = Math.max(2, Math.floor(this.props.splatResolution ?? 256)));
    const decoded = decodeUint8(this.props.splatmap, resolution * resolution * 4);
    this.splatData = decoded ?? makeDefaultSplat(resolution);
    this.splatTexture = new THREE.DataTexture(this.splatData, resolution, resolution, THREE.RGBAFormat);
    this.splatTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.splatTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.splatTexture.flipY = false;
    this.splatTexture.needsUpdate = true;
  }

  /** Encode the live splat buffer back into `props` (call once per stroke). */
  commitSplatmap() {
    this.props.splatmap = encodeUint8(this.splatData);
  }

  // ---------------------------------------------------------------------------
  // Material — per-layer PBR surfaces blended by the splatmap
  // ---------------------------------------------------------------------------

  #buildMaterial() {
    this.material = new THREE.MeshStandardNodeMaterial({
      color: 0x8a8f7a,
      roughness: 0.95,
      metalness: 0,
    });
    // Per-layer loaded maps: this.layerMaps[i] = { albedo, normal, roughness }.
    this.layerMaps = [];
    this.#wireMaterialNodes();
  }

  /**
   * Weighted-average splat blend of every layer, per PBR channel — so rock,
   * grass, sand etc. differ in roughness and surface normal, not just color:
   *
   *   color     = Σ(albedoᵢ·tintᵢ · wᵢ) / Σwᵢ
   *   roughness = Σ(roughnessᵢ         · wᵢ) / Σwᵢ
   *   metalness = Σ(metalnessᵢ         · wᵢ) / Σwᵢ
   *   normal    = normalMap( Σ(normalTexelᵢ · wᵢ) / Σwᵢ )   [if any normal maps]
   *
   * Every existing layer contributes (its scalar tint/roughness apply even
   * without maps), so an untextured layer is a valid flat-colored surface and
   * layer 0 is paintable. With no layers, all channel nodes are cleared and
   * the material falls back to its scalar base color.
   *
   * Normal blend note: unpacking a normal map is affine (texel·2−1), so
   * blending the raw 0..1 texels weighted (denominator = Σw) and then calling
   * normalMap() is identical to blending the unpacked tangent normals — it
   * lets us reuse three's tangent-space transform without hand-rolling the TBN.
   */
  #wireMaterialNodes() {
    const layers = (this.props.layers ?? []).slice(0, MAX_TERRAIN_LAYERS);
    const splat = tslTexture(this.splatTexture, uv());
    const weights = [splat.r, splat.g, splat.b, splat.a];
    const FLAT_NORMAL = vec3(0.5, 0.5, 1.0); // tangent-space "no bump" in 0..1

    let colorNum = null, roughNum = null, metalNum = null, normalNum = null;
    let denom = null;
    let hasNormal = false;

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i] ?? {};
      const maps = this.layerMaps[i] ?? {};
      const w = weights[i];
      const tiling = layer.tiling ?? 20;
      const layerUv = uv().mul(tiling);

      // Color: albedo × tint (tint alone when no albedo map).
      const tint = new THREE.Color(layer.tint ?? "#ffffff");
      const tintNode = vec3(tint.r, tint.g, tint.b);
      const albedo = maps.albedo ? tslTexture(maps.albedo, layerUv).rgb.mul(tintNode) : tintNode;
      const colorTerm = albedo.mul(w);

      // Roughness / metalness scalars (roughness map, red channel, when present).
      const rough = maps.roughness ? tslTexture(maps.roughness, layerUv).r.mul(layer.roughness ?? 1) : float(layer.roughness ?? 0.95);
      const roughTerm = rough.mul(w);
      const metalTerm = float(layer.metalness ?? 0).mul(w);

      // Normal texel (0..1), flat where a layer has no normal map.
      if (maps.normal) hasNormal = true;
      const normalTexel = (maps.normal ? tslTexture(maps.normal, layerUv).xyz : FLAT_NORMAL).mul(w);

      colorNum = colorNum ? colorNum.add(colorTerm) : colorTerm;
      roughNum = roughNum ? roughNum.add(roughTerm) : roughTerm;
      metalNum = metalNum ? metalNum.add(metalTerm) : metalTerm;
      normalNum = normalNum ? normalNum.add(normalTexel) : normalTexel;
      denom = denom ? denom.add(w) : w;
    }

    if (colorNum && denom) {
      const inv = denom.max(float(1e-4));
      this.material.colorNode = colorNum.div(inv);
      this.material.roughnessNode = roughNum.div(inv);
      this.material.metalnessNode = metalNum.div(inv);
      this.material.normalNode = hasNormal ? normalMap(normalNum.div(inv)) : null;
    } else {
      this.material.colorNode = null;
      this.material.roughnessNode = null;
      this.material.metalnessNode = null;
      this.material.normalNode = null;
    }
    this.material.needsUpdate = true;
  }

  /** Load one texture (or null) with the right color space + wrapping. */
  async #loadMap(path, { srgb }) {
    if (!path) return null;
    try {
      const [url, meta] = await Promise.all([
        resolveAssetUrl(path),
        loadAssetMeta(`${path}.meta`).catch(() => null),
      ]);
      const tex = await new THREE.TextureLoader().loadAsync(url);
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      applyTextureMeta(tex, meta);
      return tex;
    } catch (err) {
      console.error(`Terrain layer map "${path}": ${err.message}`);
      return null;
    }
  }

  async #loadLayerMaps() {
    const generation = (this.generation = (this.generation ?? 0) + 1);
    const layers = (this.props.layers ?? []).slice(0, MAX_TERRAIN_LAYERS);
    const loaded = await Promise.all(
      layers.map(async (layer) => ({
        // Back-compat: older scenes stored the albedo path as `texture`.
        albedo: await this.#loadMap(layer?.albedo ?? layer?.texture, { srgb: true }),
        normal: await this.#loadMap(layer?.normalMap, { srgb: false }),
        roughness: await this.#loadMap(layer?.roughnessMap, { srgb: false }),
      })),
    );
    if (generation !== this.generation || !this.mesh) return;
    this.#disposeLayerMaps();
    this.layerMaps = loaded;
    this.#wireMaterialNodes();
  }

  #disposeLayerMaps() {
    for (const maps of this.layerMaps ?? []) {
      maps?.albedo?.dispose?.();
      maps?.normal?.dispose?.();
      maps?.roughness?.dispose?.();
    }
    this.layerMaps = [];
  }

  // ---------------------------------------------------------------------------
  // Sculpt brush (called from the editor's viewport pointer handlers)
  // ---------------------------------------------------------------------------

  /**
   * local: THREE.Vector3 brush center in this entity's local space.
   * opts: { tool, radius, strength, hardness?, flattenHeight?, seed? }
   * Tools: raise, lower, smooth, flatten, sharpen, erode, noise.
   */
  applyHeightBrush(local, opts) {
    if (!this.geometry) return;
    const { tool, radius, strength, hardness = 0.5, flattenHeight = 0, seed = 0 } = opts;
    const cols = this.resolution + 1;
    const heights = this.heightsArray;
    const half = (this.props.size ?? 50) / 2;
    const step = (half * 2) / this.resolution;
    const exp = THREE.MathUtils.lerp(0.4, 4, hardness);

    // Neighbor-reading tools work off a snapshot so one pass isn't biased by
    // its own in-progress writes.
    const needsSnapshot = tool === "smooth" || tool === "sharpen" || tool === "erode";
    const src = needsSnapshot ? heights.slice() : heights;

    // Only touch vertices inside the brush's bounding box.
    const cMin = Math.max(0, Math.floor((local.x - radius + half) / step));
    const cMax = Math.min(this.resolution, Math.ceil((local.x + radius + half) / step));
    const rMin = Math.max(0, Math.floor((local.z - radius + half) / step));
    const rMax = Math.min(this.resolution, Math.ceil((local.z + radius + half) / step));

    for (let r = rMin; r <= rMax; r++) {
      for (let c = cMin; c <= cMax; c++) {
        const x = -half + c * step;
        const z = -half + r * step;
        const dist = Math.hypot(x - local.x, z - local.z);
        if (dist > radius) continue;
        const falloff = Math.pow(1 - dist / radius, exp);
        const amt = strength * falloff;
        const idx = r * cols + c;
        switch (tool) {
          case "raise":
            heights[idx] += amt;
            break;
          case "lower":
            heights[idx] -= amt;
            break;
          case "flatten":
            heights[idx] += (flattenHeight - heights[idx]) * Math.min(1, amt);
            break;
          case "smooth": {
            const avg = neighborAvg(src, cols, r, c, this.resolution);
            heights[idx] = src[idx] + (avg - src[idx]) * Math.min(1, amt);
            break;
          }
          case "sharpen": {
            const avg = neighborAvg(src, cols, r, c, this.resolution);
            heights[idx] = src[idx] + (src[idx] - avg) * amt;
            break;
          }
          case "erode": {
            const mn = neighborMin(src, cols, r, c, this.resolution);
            heights[idx] = src[idx] + (mn - src[idx]) * Math.min(1, amt);
            break;
          }
          case "noise":
            heights[idx] += (valueNoise(x * 0.5, z * 0.5, seed) * 2 - 1) * amt;
            break;
          default:
            break;
        }
      }
    }
    this.#applyHeightsToGeometry();
  }

  // ---------------------------------------------------------------------------
  // Paint brush — writes the splatmap channel of the active layer
  // ---------------------------------------------------------------------------

  /**
   * local: THREE.Vector3 brush center in local space.
   * opts: { layerIndex, radius, strength, hardness? }
   * Adds weight to the active layer's channel and renormalizes the four
   * channels so they sum to 255 per texel (a proper splat weight set).
   */
  applySplatBrush(local, opts) {
    if (!this.splatData) return;
    const { layerIndex, radius, strength, hardness = 0.5 } = opts;
    const layer = THREE.MathUtils.clamp(layerIndex | 0, 0, 3);
    const half = (this.props.size ?? 50) / 2;
    const res = this.splatResolution;
    const exp = THREE.MathUtils.lerp(0.4, 4, hardness);

    // Texel <-> world mapping matches the material's uv() sampling:
    //   world x = -half + u*size,  world z =  half - v*size   (see PlaneGeometry
    //   UVs after rotateX; DataTexture flipY = false).
    const worldToU = (wx) => (wx + half) / (half * 2);
    const worldToV = (wz) => (half - wz) / (half * 2);
    const uMin = worldToU(local.x - radius), uMax = worldToU(local.x + radius);
    const vLo = worldToV(local.z + radius), vHi = worldToV(local.z - radius);
    const xMin = Math.max(0, Math.floor(uMin * res)), xMax = Math.min(res - 1, Math.ceil(uMax * res));
    const yMin = Math.max(0, Math.floor(vLo * res)), yMax = Math.min(res - 1, Math.ceil(vHi * res));

    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) {
        const u = (x + 0.5) / res;
        const v = (y + 0.5) / res;
        const wx = u * half * 2 - half;
        const wz = half - v * half * 2;
        const dist = Math.hypot(wx - local.x, wz - local.z);
        if (dist > radius) continue;
        const falloff = Math.pow(1 - dist / radius, exp);
        const add = Math.min(1, strength * falloff) * 255;
        const base = (y * res + x) * 4;
        const cur = [this.splatData[base], this.splatData[base + 1], this.splatData[base + 2], this.splatData[base + 3]];
        cur[layer] = Math.min(255, cur[layer] + add);
        const sum = cur[0] + cur[1] + cur[2] + cur[3] || 1;
        for (let ch = 0; ch < 4; ch++) this.splatData[base + ch] = Math.round((cur[ch] / sum) * 255);
      }
    }
    this.splatTexture.needsUpdate = true;
  }
}
