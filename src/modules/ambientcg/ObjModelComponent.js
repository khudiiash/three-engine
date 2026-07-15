import * as THREE from "three/webgpu";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { Component } from "../../engine/components/Component.js";
import { resolveAssetUrl } from "../../engine/assetResolver.js";

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/**
 * Loads a Wavefront OBJ model + its companion .mtl + texture maps into a
 * single Object3D hierarchy attached to the entity.
 *
 * Designed for assets downloaded by the AmbientCG module — single mesh,
 * single material, optional PBR textures (most ambientCG 3D models use
 * one `map_Kd` diffuse texture, sometimes with a normal map named
 * `bump`/`map_Bump`). The OBJLoader's URL machinery can't follow the
 * editor's `resolveAssetUrl` blob: URLs without help, so we read the OBJ
 * and MTL text directly and parse the OBJ ourselves, then resolve each
 * referenced texture through the asset pipeline.
 *
 * Lives in the `ambientcg` module so projects opt in explicitly; without
 * the module enabled the component degrades to "missing" in the inspector
 * but the prefab still round-trips.
 */
export class ObjModelComponent extends Component {
  static type = "objModel";
  static label = "OBJ Model";
  static defaults = {
    obj: "",
    mtl: "",
    textures: {}, // material slot -> texture filename (within the same folder)
    castShadow: true,
    receiveShadow: true,
  };
  static schema = [
    { key: "obj", label: "OBJ File", type: "asset", exts: ["obj"] },
    { key: "mtl", label: "MTL File", type: "asset", exts: ["mtl"] },
    { key: "castShadow", label: "Cast Shadow", type: "boolean" },
    { key: "receiveShadow", label: "Receive Shadow", type: "boolean" },
  ];

  onAttach() {
    this.root = null;
    this.disposables = [];
    this.generation = (this.generation ?? 0) + 1;
    if (this.props.obj) this.#load(this.generation);
  }

  onDetach() {
    this.generation = (this.generation ?? 0) + 1;
    if (this.root) {
      this.entity.object3D.remove(this.root);
      this.root.traverse((obj) => {
        obj.geometry?.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) m?.dispose?.();
      });
      this.root = null;
    }
    for (const d of this.disposables) d?.dispose?.();
    this.disposables = [];
  }

  onDisable() {
    if (this.root) this.root.visible = false;
  }

  onEnable() {
    if (this.root) this.root.visible = true;
  }

  onPropChanged(key) {
    if (key === "castShadow" || key === "receiveShadow") {
      if (this.root) {
        this.root.traverse((obj) => {
          if (obj.isMesh) {
            obj.castShadow = this.props.castShadow !== false;
            obj.receiveShadow = this.props.receiveShadow !== false;
          }
        });
      }
      return;
    }
    this.onDetach();
    this.onAttach();
  }

  async #load(generation) {
    try {
      // Read text directly: blob: URLs can't be fetched across the editor's
      // asset resolver for resources the OBJ references (relative `mtl`,
      // `map_Kd`, etc), so we side-step the URL machinery entirely.
      const objText = await invoke("read_text_file", { path: this.props.obj });
      if (generation !== this.generation) return;

      const mtlPath = this.props.mtl || this.props.obj.replace(/\.obj$/i, ".mtl");
      let mtlText = null;
      try {
        mtlText = await invoke("read_text_file", { path: mtlPath });
      } catch {
        mtlText = null;
      }
      if (generation !== this.generation) return;

      const loader = new OBJLoader();
      const group = loader.parse(objText);
      if (generation !== this.generation) return;

      // Parse the MTL for the diffuse / bump texture references. ambientCG
      // .mtl files usually carry a single material entry referencing
      // <assetId>_Color.jpg via `map_Kd`. We don't try to honour every
      // PBR slot the .mtl spec supports — diffuse is enough for v1.
      const mtlRefs = mtlText ? parseMtlTextures(mtlText) : { diffuse: null, bump: null };
      const folder = mtlPath.split(/[\\/]/).slice(0, -1).join("/");
      const resolve = (rel) => (rel ? `${folder}/${rel}` : null);

      const diffuseMap = mtlRefs.diffuse ? await loadTexture(resolve(mtlRefs.diffuse)) : null;
      if (generation !== this.generation) {
        diffuseMap?.dispose();
        return;
      }
      const bumpMap = mtlRefs.bump ? await loadTexture(resolve(mtlRefs.bump)) : null;
      if (generation !== this.generation) {
        diffuseMap?.dispose();
        bumpMap?.dispose();
        return;
      }
      if (diffuseMap) this.disposables.push(diffuseMap);
      if (bumpMap) this.disposables.push(bumpMap);

      // Apply a MeshStandardMaterial everywhere the OBJ loader emitted a
      // Mesh with a placeholder material. ambientCG models are all single-
      // material; multi-material cases fall through with the loader's
      // defaults (rare for CC0 ambientCG models).
      const material = new THREE.MeshStandardMaterial({
        map: diffuseMap ?? null,
        normalMap: bumpMap ?? null,
        // ambientCG bump maps are authored for DirectX (Y inverted). Flip
        // the normal map so the visual result matches what a Blender user
        // would expect when authoring the same material.
        normalScale: bumpMap ? new THREE.Vector2(1, -1) : new THREE.Vector2(1, 1),
        color: 0xffffff,
        metalness: 0,
        roughness: 1,
        side: THREE.DoubleSide,
      });
      this.disposables.push(material);

      group.traverse((obj) => {
        if (obj.isMesh) {
          obj.material = material;
          obj.castShadow = this.props.castShadow !== false;
          obj.receiveShadow = this.props.receiveShadow !== false;
          obj.userData.entityId = this.entity.id;
        }
      });

      this.root = group;
      this.entity.object3D.add(group);
      this.root.visible = this._enabled;
      this.entity.engine?.emit?.("model-loaded", this.entity);
    } catch (err) {
      console.error(`ObjModel: failed to load "${this.props.obj}": ${err.message ?? err}`);
    }
  }
}

async function loadTexture(path) {
  const url = await resolveAssetUrl(path);
  const tex = await new THREE.TextureLoader().loadAsync(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Minimal MTL parser: extracts `map_Kd` (diffuse) and `map_Bump` / `bump`
 * references from the material block(s). ambientCG MTLs are well-behaved
 * single-material files so a regex sweep is plenty.
 */
function parseMtlTextures(mtlText) {
  const out = { diffuse: null, bump: null };
  for (const line of mtlText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed) continue;
    // map_Kd [-options] filename
    const mKd = trimmed.match(/^map_Kd\s+(?:-[a-z]+\s+[^ ]+\s+)*(.+)$/);
    if (mKd && !out.diffuse) {
      out.diffuse = mKd[1].trim();
      continue;
    }
    // `bump` and `map_Bump` are both legitimate in the OBJ/MTL spec
    const mBump = trimmed.match(/^(?:map_Bump|bump)\s+(?:-[a-z]+\s+[^ ]+\s+)*(.+)$/);
    if (mBump && !out.bump) {
      out.bump = mBump[1].trim();
      continue;
    }
  }
  return out;
}