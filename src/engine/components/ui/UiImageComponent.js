import * as THREE from "three/webgpu";
import { Component } from "../Component.js";
import { createUiImageMaterial, applyElementUniforms } from "../../ui/uiMaterial.js";
import { UI_LAYER } from "../../ui/UiSystem.js";
import { resolveAssetUrl, loadAssetMeta } from "../../assetResolver.js";
import { applyTextureMeta } from "../../textureMeta.js";

// One shared unit plane for every UI quad — meshes scale it per-rect.
let sharedPlane = null;
function getPlane() {
  if (!sharedPlane) sharedPlane = new THREE.PlaneGeometry(1, 1);
  return sharedPlane;
}

/**
 * Visual rectangle: solid color and/or texture with SDF rounded corners,
 * border stroke, and a fill cutoff for progress bars. All styling is
 * shader-side (one quad, uniform updates only) except texture/fillMode
 * changes, which rebuild the node material.
 */
export class UiImageComponent extends Component {
  static type = "uiimage";
  static label = "UI Image";
  static defaults = {
    color: "#ffffff",
    opacity: 1,
    texture: "", // image asset path; empty = flat color
    cornerRadius: 0,
    borderWidth: 0,
    borderColor: "#000000",
    fillMode: "none", // none | horizontal | vertical
    fillAmount: 1,
  };
  static schema = [
    { key: "color", label: "Color", type: "color" },
    { key: "opacity", label: "Opacity", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "texture", label: "Texture", type: "asset", exts: ["png", "jpg", "jpeg", "webp"] },
    { key: "cornerRadius", label: "Corner Radius", type: "number", min: 0, step: 1 },
    { key: "borderWidth", label: "Border Width", type: "number", min: 0, step: 1 },
    { key: "borderColor", label: "Border Color", type: "color" },
    { key: "fillMode", label: "Fill Mode", type: "select", options: ["none", "horizontal", "vertical"] },
    { key: "fillAmount", label: "Fill Amount", type: "number", min: 0, max: 1, step: 0.01 },
  ];

  onAttach() {
    this.texture = null;
    this.tint = new THREE.Color(1, 1, 1); // runtime-only (button states)
    this.generation = 0;
    this.mesh = new THREE.Mesh(getPlane(), createUiImageMaterial({ fillMode: this.props.fillMode }));
    this.mesh.layers.set(UI_LAYER);
    this.mesh.frustumCulled = false;
    this.mesh.userData.entityId = this.entity.id;
    // UI meshes sit at pixel-scale coordinates in the scene tree — keep the
    // editor's 3D raycaster from ever hitting them (picking goes through
    // UiSystem.hitTest instead).
    this.mesh.raycast = () => {};
    this.entity.object3D.add(this.mesh);
    if (this.props.texture) this.#loadTexture(this.props.texture);
  }

  onDetach() {
    this.generation++;
    if (this.mesh) {
      this.entity.object3D.remove(this.mesh);
      this.mesh.material.dispose();
      this.mesh = null;
    }
    this.texture?.dispose();
    this.texture = null;
  }

  onPropChanged(key) {
    if (!this.mesh) return;
    if (key === "texture") {
      this.texture?.dispose();
      this.texture = null;
      if (this.props.texture) this.#loadTexture(this.props.texture);
      else this.#rebuildMaterial();
    } else if (key === "fillMode") {
      this.#rebuildMaterial();
    }
    // Everything else is a uniform, written on the next layout pass.
  }

  #rebuildMaterial() {
    if (!this.mesh) return;
    this.mesh.material.dispose();
    this.mesh.material = createUiImageMaterial({
      texture: this.texture,
      fillMode: this.props.fillMode,
    });
  }

  async #loadTexture(path) {
    const generation = ++this.generation;
    try {
      const [url, meta] = await Promise.all([resolveAssetUrl(path), loadAssetMeta(path)]);
      if (!url) return;
      const tex = await new THREE.TextureLoader().loadAsync(url);
      if (generation !== this.generation || !this.mesh) {
        tex.dispose();
        return;
      }
      tex.colorSpace = THREE.SRGBColorSpace;
      if (meta) applyTextureMeta(tex, meta);
      this.texture = tex;
      this.#rebuildMaterial();
    } catch (err) {
      console.warn(`UI image texture failed to load: ${path}`, err);
    }
  }

  /** Runtime tint (button hover/pressed states) — not serialized. */
  setTint(color) {
    this.tint.set(color);
  }

  /** Called by the UiSystem layout pass with the computed frame. */
  onUiLayout({ rect, clipRect, alpha, k, feather, order, spec }) {
    const mesh = this.mesh;
    if (!mesh) return;
    const { w, h } = rect;
    mesh.scale.set(Math.max(w, 1e-4), Math.max(h, 1e-4), 1);
    mesh.position.set((0.5 - spec.pivot[0]) * w, -(0.5 - spec.pivot[1]) * h, 0);
    mesh.renderOrder = order;

    const u = mesh.material.userData.uiUniforms;
    u.size.value.set(w, h);
    u.radius.value = Math.min(this.props.cornerRadius, Math.min(w, h) / 2);
    u.borderWidth.value = this.props.borderWidth;
    u.borderColor.value.set(this.props.borderColor);
    u.color.value.set(this.props.color);
    u.tint.value.copy(this.tint);
    u.fillAmount.value = this.props.fillAmount;
    u.feather.value = feather;
    applyElementUniforms(mesh.material, { clipRect, alpha: alpha * (this.props.opacity ?? 1), k });
  }
}
