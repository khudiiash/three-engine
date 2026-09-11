/**
 * Sky and weather, as ops.
 *
 * Everything AUTHORED on an Atmosphere is an ordinary component property and
 * goes through `component.setProp` like every other component's — which is why
 * there is no `atmosphere.set` for latitude or cloud settings. What is here is
 * the half that `setProp` cannot express:
 *
 *   · `atmosphere.status` — the whole DERIVED state. Where the sun actually
 *     is, what the light ended up being, the temperature, whether it is
 *     currently raining or snowing and how wet the ground has become. None of
 *     that is in `props`, so an agent reading the component back learns almost
 *     nothing about what the scene looks like right now. This is the answer to
 *     "what is the weather doing".
 *   · `atmosphere.setWeather` — a weather change is a TRANSITION, not a value
 *     write. Setting the prop directly works, but the op is where the
 *     transition time lives and where an unknown name is refused with the list
 *     of real ones rather than silently becoming clear skies.
 *   · `atmosphere.setTime` — the clock is written straight onto props by the
 *     running day (no change event, see `_advanceClock`), so an agent must not
 *     read `timeOfDay` off the component and expect it to be current. This
 *     sets it properly and returns the new sunrise/sunset.
 *   · `atmosphere.strike` — a lightning flash on demand, for a cutscene or for
 *     seeing what one looks like without waiting for a storm.
 */
import { defineOp } from "../registry.js";
import { engine } from "../../engineInstance.js";
import { useModulesStore } from "../../modules.js";
import { WEATHER_NAMES } from "../../../modules/atmosphere/weather.js";

function requireModule() {
  if (!useModulesStore.getState().enabled.includes("atmosphere")) {
    throw new Error('The "atmosphere" module is not enabled for this project. Enable it with module.setEnabled.');
  }
}

/** The scene's Atmosphere. There is only ever one — see the component. */
function findAtmosphere(entityId) {
  requireModule();
  if (entityId) {
    const entity = engine.getEntity(entityId);
    if (!entity) throw new Error(`No entity "${entityId}".`);
    const component = entity.getComponent("atmosphere");
    if (!component) throw new Error(`Entity "${entity.name}" has no atmosphere component. Add it with component.add.`);
    return { entity, component };
  }
  for (const entity of engine.entities.values()) {
    const component = entity.getComponent("atmosphere");
    if (component) return { entity, component };
  }
  throw new Error(
    'This scene has no Atmosphere. Create one with entity.create then component.add({ type: "atmosphere" }).',
  );
}

const round = (value, places = 3) => (typeof value === "number" && Number.isFinite(value) ? +value.toFixed(places) : value);
const roundAll = (values, places = 3) => (Array.isArray(values) ? values.map((v) => round(v, places)) : values);

function report(entity, component) {
  const state = component.state;
  return {
    entityId: entity.id,
    name: entity.name,
    enabled: component.enabled,
    status: state.status,
    time: {
      ...state.time,
      timeOfDay: round(state.time.timeOfDay, 4),
      sunrise: round(state.time.sunrise, 3),
      sunset: round(state.time.sunset, 3),
      dayLength: round(state.time.dayLength, 3),
      seasonPhase: round(state.time.seasonPhase, 4),
      // A running clock advances props without a change event, so an agent
      // needs to be told whether what it just read will still be true.
      running: (Number(component.props.dayLength) || 0) > 0,
    },
    sun: state.sun && {
      altitude: round(state.sun.altitude, 2),
      azimuth: round(state.sun.azimuth, 2),
      direction: roundAll(state.sun.direction, 4),
      up: state.sun.altitude > 0,
    },
    moon: state.moon && {
      altitude: round(state.moon.altitude, 2),
      illumination: round(state.moon.illumination, 3),
      phase: round(state.moon.phase, 3),
    },
    light: state.light && {
      body: state.light.body,
      intensity: round(state.light.intensity, 4),
      color: roundAll(state.light.color, 3),
      // Which light in the scene it is actually driving — "owned" means the
      // Atmosphere made one because the scene had no directional light.
      source: state.light.source,
    },
    weather: {
      current: state.weather.current,
      auto: state.weather.auto,
      blending: state.weather.blend < 1,
      temperature: round(state.weather.temperature, 2),
      cloudCover: round(state.weather.cloudCover),
      cloudDensity: round(state.weather.cloudDensity),
      rain: round(state.weather.rain),
      snow: round(state.weather.snow),
      wind: round(state.weather.wind, 2),
      gust: round(state.weather.gust, 2),
      fogDensity: round(state.weather.fogDensity, 5),
      thunder: round(state.weather.thunder, 3),
      sunLight: round(state.weather.sunLight, 3),
    },
    ground: {
      wetness: round(state.accumulation.wetness, 3),
      snowDepth: round(state.accumulation.snowDepth, 3),
    },
    sky: state.sky && {
      irradiance: roundAll(state.sky.irradiance, 4),
      horizon: roundAll(state.sky.horizon, 4),
      cloudOpacity: round(state.sky.cloudOpacity),
      refreshing: state.sky.refreshing,
    },
    shelter: state.shelter,
    lightning: { flash: round(state.lightning.flash, 3), nextIn: round(state.lightning.nextIn, 1) },
  };
}

defineOp({
  name: "atmosphere.status",
  readOnly: true,
  description:
    "What the sky and the weather are actually doing — the derived half of an Atmosphere, none of which is in its properties. Reports where the sun and moon are (altitude, azimuth, phase), the colour and intensity the directional light ended up with and WHICH light that is, the current weather with its blended cloud/rain/snow/wind channels, the air temperature that decides rain versus snow, how wet or snow-covered the ground has become, the sky's own irradiance and horizon colour, and whether the camera is currently under cover. Read this rather than the component's props: the clock advances props without emitting a change, so `timeOfDay` read off the component can be stale.",
  params: { entityId: { type: "string", description: "The Atmosphere entity. Omit for the scene's only one." } },
  run: ({ entityId }) => {
    const { entity, component } = findAtmosphere(entityId);
    return report(entity, component);
  },
});

defineOp({
  name: "atmosphere.setWeather",
  undoable: true,
  description:
    `Cross to a weather, over time. One of: auto, ${WEATHER_NAMES.join(", ")}. "auto" hands the sky back to its own seeded chain, which walks between neighbouring weathers and is vetoed by the season — it will not snow in a warm month. The change is a blend, not a cut: pass transition (seconds) to say how long the front takes to arrive, 0 for immediately. Severity is a separate property (weatherIntensity, 0…1) that blends the chosen weather towards clear, so "rain at 0.3" is lighter rain rather than darker rain.`,
  params: {
    weather: { type: "string", required: true, description: `auto, ${WEATHER_NAMES.join(", ")}` },
    transition: { type: "number", description: "Seconds for the change to complete. Omit to keep the component's own." },
    intensity: { type: "number", description: "0…1 severity, blending the weather towards clear." },
    entityId: { type: "string", description: "The Atmosphere entity. Omit for the scene's only one." },
  },
  run: ({ weather, transition, intensity, entityId }) => {
    const { entity, component } = findAtmosphere(entityId);
    if (intensity != null) component.setProp("weatherIntensity", Math.max(0, Math.min(1, Number(intensity) || 0)));
    component.setWeather(weather, { transition });
    return report(entity, component);
  },
});

defineOp({
  name: "atmosphere.setTime",
  undoable: true,
  description:
    "Set the clock. `hour` is local apparent time (12 is near solar noon at every latitude) and may be fractional; `dayOfYear` is 1…365 and IS the season — it decides the sun's noon altitude, the length of the day and, through the temperature model, whether precipitation falls as rain or snow. Returns the new sunrise, sunset and day length. To make time flow, set the component's `dayLength` property (real minutes per game day; 0 freezes it).",
  params: {
    hour: { type: "number", description: "0…24, fractional allowed." },
    dayOfYear: { type: "number", description: "1…365. This is the season." },
    entityId: { type: "string", description: "The Atmosphere entity. Omit for the scene's only one." },
  },
  run: ({ hour, dayOfYear, entityId }) => {
    const { entity, component } = findAtmosphere(entityId);
    if (hour == null && dayOfYear == null) throw new Error("Pass hour, dayOfYear, or both.");
    component.setTime(hour, dayOfYear);
    return report(entity, component);
  },
});

defineOp({
  name: "atmosphere.strike",
  description:
    "Fire a lightning flash now, whatever the weather. Returns the strike's distance and its thunder delay in seconds (distance / 343 m/s) so a sound can be scheduled against it; the same payload is emitted as the engine event `atmosphere-lightning`, which is how a script or an audio system hears about the strikes a storm fires on its own.",
  params: {
    strength: { type: "number", description: "0…1 flash strength. Default 1." },
    entityId: { type: "string", description: "The Atmosphere entity. Omit for the scene's only one." },
  },
  run: ({ strength, entityId }) => {
    const { component } = findAtmosphere(entityId);
    return component.strike(strength == null ? 1 : Number(strength));
  },
});
