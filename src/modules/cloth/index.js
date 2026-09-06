import { ClothComponent } from "../../engine/components/ClothComponent.js";

export const clothModule = {
  id: "cloth", name: "Cloth", version: "0.2.0", category: "Rendering",
  tags: ["cloth", "compute", "webgpu", "simulation"],
  description: "Turn a plane mesh into GPU cloth with selectable pins, fabric constraints and gusting wind. Appearance comes from the mesh material.",
  components: [ClothComponent],
};
export { ClothComponent };
