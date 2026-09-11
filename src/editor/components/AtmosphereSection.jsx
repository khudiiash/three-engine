import { useEffect, useState } from "react";
import { engine } from "../engineInstance.js";
import { commandBus } from "../commands/CommandBus.js";
import { SetComponentPropCommand } from "../commands/componentCommands.js";
import { WEATHER_NAMES } from "../../modules/atmosphere/weather.js";

/**
 * The live half of an Atmosphere.
 *
 * The authored properties render from the component's schema like any other
 * component's — this adds the part a schema cannot show, and which is most of
 * what an author actually wants to look at: where the sun IS, when it rises
 * and sets on this day at this latitude, what the air temperature works out to
 * (which is what decides rain versus snow), and what is falling right now.
 *
 * ⚠ IT POLLS, and it has to. The running clock writes `timeOfDay` straight
 * onto props without a change event — deliberately, because a property change
 * per frame puts every scene-walking listener in the editor on the frame path
 * (see `_advanceClock`). So there is nothing to subscribe to, and a 500 ms
 * interval is the honest way to show a moving sky.
 */
const clock = (hours) => {
  if (hours == null || !Number.isFinite(hours)) return "—";
  const wrapped = ((hours % 24) + 24) % 24;
  const h = Math.floor(wrapped);
  const m = Math.round((wrapped - h) * 60);
  return `${String(m === 60 ? h + 1 : h).padStart(2, "0")}:${String(m === 60 ? 0 : m).padStart(2, "0")}`;
};

/** What is actually coming out of the sky, in words. */
function falling(weather) {
  const rain = weather?.rain ?? 0, snow = weather?.snow ?? 0;
  if (rain + snow < 0.01) return null;
  const rate = (value) => (value > 0.66 ? "heavy" : value > 0.3 ? "steady" : "light");
  if (rain > 0.02 && snow > 0.02) return "sleet";
  return snow > rain ? `${rate(snow)} snow` : `${rate(rain)} rain`;
}

export function AtmosphereSection({ entityId, props }) {
  const [, refresh] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => refresh((value) => value + 1), 500);
    return () => clearInterval(timer);
  }, [entityId]);

  const component = engine.getEntity(entityId)?.getComponent("atmosphere");
  const state = component?.state;
  const commit = (key, value) => commandBus.execute(new SetComponentPropCommand(entityId, "atmosphere", key, value));

  if (!state || state.status !== "Active") {
    return <div className="inspector-hint" role="status" style={{ margin: "6px 2px" }}>
      {state?.status ?? "The Atmosphere is not running."}
    </div>;
  }

  const weather = state.weather;
  const now = falling(weather);
  const rows = [
    ["Sun", state.sun ? `${state.sun.altitude.toFixed(1)}° ${state.sun.altitude > 0 ? "above" : "below"} · ${state.sun.azimuth.toFixed(0)}° from north` : "—"],
    ["Daylight", state.time.polar
      ? (state.time.polar === "day" ? "midnight sun" : "polar night")
      : `${clock(state.time.sunrise)} – ${clock(state.time.sunset)} · ${state.time.dayLength.toFixed(1)} h`],
    ["Season", `${state.time.season ?? "—"} · day ${Math.round(state.time.dayOfYear)}`],
    ["Temperature", weather.temperature == null ? "—" : `${weather.temperature.toFixed(1)} °C`],
    ["Sun light", state.light
      ? `${state.light.source}${state.light.source === "owned" ? " (created by the Atmosphere)" : ""} · ${state.light.body} · ${(state.light.applied ?? state.light.intensity).toFixed(2)}`
      : "—"],
    ["Cloud shadow", state.light ? `${state.light.cloudShadows}${state.light.cloudShadows === "spatial" ? "" : ` · sun dimmed ${Math.round((state.light.cloudShade ?? 0) * 100)}%`}` : "—"],
    ["Cloud", `${Math.round((weather.cloudCover ?? 0) * 100)}% cover`],
    ["Wind", `${(weather.wind ?? 0).toFixed(1)} m/s from ${Math.round(props.windDirection ?? 0)}°`],
  ];
  if (now) rows.push(["Falling", now]);
  if (state.moon && state.moon.altitude > 0) {
    rows.push(["Moon", `${Math.round(state.moon.illumination * 100)}% lit, ${state.moon.altitude.toFixed(0)}° up`]);
  }
  if (state.accumulation.snowDepth > 0.005) rows.push(["Settled snow", `${(state.accumulation.snowDepth * 100).toFixed(0)} cm`]);
  if (state.shelter?.mapping) rows.push(["Roofs", "capturing what is overhead"]);

  return <div data-atmosphere-section={entityId}>
    <div className="inspector-subheader">Right now</div>
    <div className="inspector-hint" role="status" style={{ margin: "2px 2px 8px" }}>
      {rows.map(([label, value]) => <div key={label}><strong style={{ opacity: 0.7 }}>{label}:</strong> {value}</div>)}
      {weather.blending && <div style={{ opacity: 0.7 }}>changing to {weather.current}…</div>}
      {state.sky?.refreshing && <div style={{ opacity: 0.55 }}>sky updating…</div>}
    </div>

    <div className="inspector-subheader">Time</div>
    <div className="atmosphere-clock" style={{ margin: "2px 2px 6px", fontVariantNumeric: "tabular-nums", fontSize: 18 }}>
      {clock(state.time.timeOfDay)}
      <span style={{ opacity: 0.55, fontSize: 12, marginLeft: 8 }}>
        {props.dayLength > 0 ? `${props.dayLength} min / day` : "paused"}
      </span>
    </div>
    <div className="camera-follow-row">
      {[["Dawn", 6.2], ["Noon", 12], ["Sunset", state.time.sunset ?? 19.5], ["Night", 0]].map(([label, hour]) =>
        <button key={label} className="toolbar-btn" onClick={() => commit("timeOfDay", +Number(hour).toFixed(3))}>{label}</button>)}
    </div>
    {/* How fast time goes, as the thing it actually is: how long a whole day
        takes in real minutes. 0 stops the clock. */}
    <div className="camera-follow-row">
      {[["Pause", 0], ["1 min", 1], ["5 min", 5], ["20 min", 20], ["2 h", 120]].map(([label, minutes]) =>
        <button key={label} className={`toolbar-btn${props.dayLength === minutes ? " active" : ""}`}
          onClick={() => commit("dayLength", minutes)}>{label}</button>)}
    </div>
    <div className="inspector-hint" style={{ margin: "4px 2px 8px" }}>
      A full day, sunrise to sunrise, in that many real minutes — the sun, the
      sky, the shadows and the temperature all follow it. Day of Year is the
      SEASON: it changes how high the sun climbs and how long the day lasts, so
      one day either way moves it very little and six months moves it a lot.
    </div>
    <div className="inspector-subheader">Weather</div>
    <div className="camera-follow-row" style={{ flexWrap: "wrap" }}>
      {["clear", "cloudy", "overcast", "rain", "storm", "snow", "auto"].map((name) =>
        <button key={name} className={`toolbar-btn${props.weather === name ? " active" : ""}`}
          onClick={() => commit("weather", name)}>{name}</button>)}
    </div>
    <div className="inspector-hint" style={{ margin: "4px 2px 0" }}>
      Weather crosses over {props.transition}s. Choosing snow or rain by name
      settles the temperature to match; on “auto” the thermometer decides which
      one falls.{WEATHER_NAMES.length > 7 && " Every preset is in the Weather dropdown."}
    </div>
  </div>;
}
