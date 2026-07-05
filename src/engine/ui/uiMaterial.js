import * as THREE from "three/webgpu";
import { uniform, uv, vec2, step, mix, texture as tslTexture, screenCoordinate } from "three/tsl";

/**
 * TSL node materials for UI quads. Every UI material is transparent,
 * depth-independent (painter's order via renderOrder) and carries a
 * screen-space clip rect uniform (physical pixels, y-down top-left origin)
 * so masks/scroll views clip without stencil buffers.
 *
 * The uniforms object returned alongside each material is what the UiSystem
 * writes into every layout pass — `material.userData.uiUniforms`.
 */

const HUGE_CLIP = [-1e7, -1e7, 1e7, 1e7];

function makeBaseUniforms() {
  return {
    clip: uniform(new THREE.Vector4(...HUGE_CLIP)),
    alpha: uniform(1), // element opacity × inherited opacity
  };
}

/** 1 where the fragment is inside the clip rect, 0 outside. */
function clipFactor(clipUniform) {
  const sc = screenCoordinate;
  return step(clipUniform.x, sc.x)
    .mul(step(sc.x, clipUniform.z))
    .mul(step(clipUniform.y, sc.y))
    .mul(step(sc.y, clipUniform.w));
}

function configureUiMaterial(material) {
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.fog = false;
  material.toneMapped = false;
}

/**
 * Image/panel material: SDF rounded rect with optional border, optional
 * texture, optional fill cutoff (progress bars). The node graph shape
 * depends on `options` — rebuild the material when texture presence or
 * fillMode changes; everything else is a uniform update.
 *
 * options: { texture?: THREE.Texture|null, fillMode?: "none"|"horizontal"|"vertical" }
 */
export function createUiImageMaterial(options = {}) {
  const u = {
    ...makeBaseUniforms(),
    color: uniform(new THREE.Color(1, 1, 1)),
    tint: uniform(new THREE.Color(1, 1, 1)), // runtime-only (button states)
    size: uniform(new THREE.Vector2(100, 100)), // rect size in UI px
    radius: uniform(0), // corner radius in UI px (clamped CPU-side)
    borderWidth: uniform(0),
    borderColor: uniform(new THREE.Color(0, 0, 0)),
    fillAmount: uniform(1),
    feather: uniform(1), // ~1 physical px expressed in UI px (1/k)
  };

  // Signed distance to a rounded rect, in UI pixels. uv() is 0..1 across the
  // quad; the SDF is symmetric so uv y-orientation doesn't matter.
  const p = uv().sub(0.5).mul(u.size);
  const q = p.abs().sub(u.size.mul(0.5)).add(u.radius);
  const dist = q.max(0).length().add(q.x.max(q.y).min(0)).sub(u.radius);
  const shape = dist.negate().div(u.feather).add(0.5).clamp(0, 1);
  // 1 inside the border ring's inner edge, 0 at it — mixes fill vs border.
  const innerFactor = dist.add(u.borderWidth).negate().div(u.feather).add(0.5).clamp(0, 1);

  let rgb = mix(u.borderColor, u.color, innerFactor).mul(u.tint);
  let alpha = u.alpha.mul(shape).mul(clipFactor(u.clip));

  if (options.texture) {
    const texel = tslTexture(options.texture);
    rgb = rgb.mul(texel.rgb);
    alpha = alpha.mul(texel.a);
  }
  if (options.fillMode === "horizontal") {
    alpha = alpha.mul(step(uv().x, u.fillAmount));
  } else if (options.fillMode === "vertical") {
    alpha = alpha.mul(step(uv().y, u.fillAmount));
  }

  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = rgb;
  material.opacityNode = alpha;
  configureUiMaterial(material);
  material.userData.uiUniforms = u;
  return material;
}

/**
 * Text material: color + alpha come straight from the canvas-rendered
 * texture (text color is baked into the canvas for correct subpixel blends).
 */
export function createUiTextMaterial(canvasTexture) {
  const u = makeBaseUniforms();
  const texel = tslTexture(canvasTexture);
  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = texel.rgb;
  material.opacityNode = texel.a.mul(u.alpha).mul(clipFactor(u.clip));
  configureUiMaterial(material);
  material.userData.uiUniforms = u;
  return material;
}

/** Writes the shared per-element uniforms (clip in physical px, opacity). */
export function applyElementUniforms(material, { clipRect, alpha, k }) {
  const u = material.userData.uiUniforms;
  if (!u) return;
  if (clipRect) {
    u.clip.value.set(clipRect.x * k, clipRect.y * k, (clipRect.x + clipRect.w) * k, (clipRect.y + clipRect.h) * k);
  } else {
    u.clip.value.set(...HUGE_CLIP);
  }
  u.alpha.value = alpha;
}
