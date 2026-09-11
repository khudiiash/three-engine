import { BlockoutComponent } from "../level-design/BlockoutComponent.js";
import * as THREE from "three/webgpu";

const materials = new Map();
const palette = { wall: "#d5d1c7", floor: "#a7a69e", roof: "#657278", foundation: "#96958b", structure: "#bac3c7", road: "#535c63" };

/** Independent structural element. No required parent, storey or elevation.
 * Reuses the established mesh/physics geometry implementation. */
export class ArchitecturePieceComponent extends BlockoutComponent {
  static type = "architecturepiece";
  static label = "Architecture Piece";
  static tags = ["architecture", "structure", "wall", "slab", "roof", "3d"];
  static schema = [
    ...BlockoutComponent.schema.map(field => field.key === "color" ? { ...field, label: "Surface Tint" } : field),
    { key: "role", label: "Material Role", type: "select", options: ["", "wall", "floor", "roof", "foundation", "structure", "road"] },
  ];
  appearanceColor() { return this.props.color || palette[this.props.role] || palette[this.props.shape] || "#bac3c7"; }
  acquireAppearance(color) {
    let entry = materials.get(color);
    if (!entry) {
      const material = new THREE.MeshStandardNodeMaterial({ color, roughness: .8, metalness: 0 });
      material.name = `Architecture ${color}`;
      materials.set(color, entry = { material, refs: 0 });
    }
    entry.refs++; return entry.material;
  }
  releaseAppearance(material) {
    if (!material) return;
    for (const [key, entry] of materials) if (entry.material === material) {
      if (--entry.refs === 0) { material.dispose(); materials.delete(key); }
      return;
    }
  }
  onPropChanged(key) {
    if (key === "role") { this.refreshMaterial(); return; }
    super.onPropChanged(key);
  }
}
