import { AtmosphereComponent } from "./AtmosphereComponent.js";

/**
 * Sky, sun, moon, stars, clouds — and the weather that moves through them.
 *
 * One module rather than two, because a storm's rain and a storm's sky are the
 * same state seen twice; see `AtmosphereComponent.js` for the argument and for
 * the list of scene values it borrows while enabled.
 */
export const atmosphereModule = {
  id: "atmosphere",
  name: "Atmosphere",
  version: "1.0.0",
  category: "World",
  tags: ["sky", "weather", "sun", "clouds", "rain", "snow", "seasons", "world", "3d"],
  description:
    "Procedural sky with a real sun and moon, seasons, day length, clouds, stars — and weather that drives the light, the fog, the wind, rain and snow.",
  components: [AtmosphereComponent],
  setup(engine) {
    engine._atmosphereModuleEnabled = true;
    // A scene saved with an Atmosphere loads before the module is enabled, so
    // its component is parked as `missingType`. Same handshake as foliage.
    for (const entity of engine.entities.values()) {
      const component = entity.getComponent("atmosphere");
      if (component?.missingType === "atmosphere") {
        const props = { ...component.props };
        entity.removeComponent("atmosphere");
        entity.addComponent(new AtmosphereComponent(props));
        continue;
      }
      if (component && component._attached !== false && !component._alive) component.onAttach();
    }
    return {
      dispose() {
        engine._atmosphereModuleEnabled = false;
        for (const entity of engine.entities.values()) {
          const component = entity.getComponent("atmosphere");
          if (component?._alive) component.onDetach();
        }
      },
    };
  },
};

export { AtmosphereComponent };
