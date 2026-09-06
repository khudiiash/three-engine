import { WaterComponent } from "../../engine/components/WaterComponent.js";

export const waterModule = {
  id: "water", name: "Water", version: "0.2.0", category: "Rendering",
  tags: ["water", "compute", "webgpu", "simulation"],
  description: "GPU heightfield water with continuous waves, optical-depth coloring and crest foam.",
  components: [WaterComponent],
};
export { WaterComponent };
