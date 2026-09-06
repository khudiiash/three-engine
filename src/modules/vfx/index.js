import { VfxComponent } from "../../engine/components/VfxComponent.js";

/** Layered, time-addressable effects; physical surfaces have their own modules. */
export const vfxModule = {
  id: "vfx",
  name: "VFX",
  version: "0.1.0",
  category: "Rendering",
  tags: ["vfx", "timeline", "effects", "layers"],
  description: "Compose animated sprites, rings, meshes, ribbons, lights and particle systems on an effect timeline.",
  components: [VfxComponent],
};

export { VfxComponent };
