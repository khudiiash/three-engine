import test from "node:test";
import assert from "node:assert/strict";
import { airTemperature, celestialState, seasonName, seasonPhase } from "../src/modules/atmosphere/sunCycle.js";

/**
 * The ephemeris is the half of the Atmosphere that cannot be eyeballed: a sun
 * that is 8° too high at noon looks like a sun. So the claims here are the
 * ones with known right answers — solstice altitudes, day length, the polar
 * cases, and the phase-versus-position agreement that is the whole reason the
 * moon is computed rather than parked opposite the sun.
 */

const NORTH_SOLSTICE = 172;   // ~June 21
const SOUTH_SOLSTICE = 355;   // ~December 21
const EQUINOX = 80;           // ~March 21

test("noon altitude at the solstices is 90 - latitude ± the obliquity", () => {
  const summer = celestialState({ hour: 12, dayOfYear: NORTH_SOLSTICE, latitude: 45 });
  const winter = celestialState({ hour: 12, dayOfYear: SOUTH_SOLSTICE, latitude: 45 });
  assert.ok(Math.abs(summer.sun.altitude - 68.44) < 0.4, `summer noon ${summer.sun.altitude}`);
  assert.ok(Math.abs(winter.sun.altitude - 21.56) < 0.4, `winter noon ${winter.sun.altitude}`);
});

test("day length follows the season, and reverses across the equator", () => {
  const north = celestialState({ hour: 12, dayOfYear: NORTH_SOLSTICE, latitude: 45 });
  const northWinter = celestialState({ hour: 12, dayOfYear: SOUTH_SOLSTICE, latitude: 45 });
  const south = celestialState({ hour: 12, dayOfYear: NORTH_SOLSTICE, latitude: -45 });
  assert.ok(north.dayLength > 15 && north.dayLength < 16, `north summer ${north.dayLength}`);
  assert.ok(northWinter.dayLength > 8 && northWinter.dayLength < 9, `north winter ${northWinter.dayLength}`);
  // The same day is the southern winter — the shortest day, not the longest.
  assert.ok(south.dayLength < 9, `south on the June solstice ${south.dayLength}`);
  // A little OVER 24: both hemispheres are given the standard 0.833°
  // refraction-and-radius allowance, which is worth ~11 minutes each.
  const shared = north.dayLength + south.dayLength;
  assert.ok(shared > 24 && shared < 24.6, `the two hemispheres share the day: ${shared}`);
});

test("sunrise and sunset straddle solar noon", () => {
  const state = celestialState({ hour: 12, dayOfYear: 200, latitude: 52 });
  assert.ok(state.sunrise < state.solarNoon && state.sunset > state.solarNoon);
  const before = state.solarNoon - state.sunrise;
  const after = state.sunset - state.solarNoon;
  assert.ok(Math.abs(before - after) < 1e-9, "symmetric about solar noon");
  assert.ok(Math.abs(state.dayLength - (before + after)) < 1e-9);
});

test("the equation of time moves solar noon off 12:00 by up to a quarter hour", () => {
  let extreme = 0;
  for (let day = 1; day <= 365; day++) {
    const state = celestialState({ hour: 12, dayOfYear: day, latitude: 0 });
    extreme = Math.max(extreme, Math.abs(state.equationOfTime));
  }
  // The real swing is -14.2 … +16.4 minutes.
  assert.ok(extreme > 12 && extreme < 18, `equation of time peaks at ${extreme} minutes`);
});

test("polar day and polar night are reported, not clamped away", () => {
  const midnightSun = celestialState({ hour: 0, dayOfYear: NORTH_SOLSTICE, latitude: 78 });
  assert.equal(midnightSun.polar, "day");
  assert.ok(midnightSun.sun.altitude > 0, "the sun is up at midnight");
  assert.equal(midnightSun.dayLength, 24);
  const polarNight = celestialState({ hour: 12, dayOfYear: SOUTH_SOLSTICE, latitude: 78 });
  assert.equal(polarNight.polar, "night");
  assert.ok(polarNight.sun.altitude < 0, "the sun is down at noon");
  assert.equal(polarNight.dayLength, 0);
});

test("the compass is +X east, -Z north, and northOffset turns it", () => {
  const dawn = celestialState({ hour: 6, dayOfYear: EQUINOX, latitude: 0 });
  const [x, y, z] = dawn.sun.direction;
  assert.ok(x > 0.99, `equinox dawn is due east: ${x}`);
  assert.ok(Math.abs(y) < 0.06 && Math.abs(z) < 0.02);

  const noon = celestialState({ hour: 12, dayOfYear: SOUTH_SOLSTICE, latitude: 45 });
  assert.ok(noon.sun.direction[2] > 0.5, "a northern-hemisphere winter noon sun stands to the SOUTH (+Z)");
  assert.ok(Math.abs(noon.sun.azimuth - 180) < 2, `azimuth ${noon.sun.azimuth}`);

  const turned = celestialState({ hour: 12, dayOfYear: SOUTH_SOLSTICE, latitude: 45, northOffset: 90 });
  assert.ok(Math.abs(turned.sun.direction[1] - noon.sun.direction[1]) < 1e-9, "turning the compass never changes altitude");
  assert.ok(turned.sun.direction[0] < -0.5, "north at +90° puts the southern sun to the west");
});

test("a full moon is opposite the sun, a new moon beside it", () => {
  let full = null, dark = null;
  for (let day = 1; day <= 60; day += 0.25) {
    const state = celestialState({ hour: 12, dayOfYear: day, latitude: 20 });
    if (!full || state.moon.illumination > full.moon.illumination) full = state;
    if (!dark || state.moon.illumination < dark.moon.illumination) dark = state;
  }
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  assert.ok(full.moon.illumination > 0.99, `found a full moon: ${full.moon.illumination}`);
  assert.ok(dot(full.sun.direction, full.moon.direction) < -0.8, "the full moon stands opposite the sun");
  assert.ok(dark.moon.illumination < 0.02, `found a new moon: ${dark.moon.illumination}`);
  assert.ok(dot(dark.sun.direction, dark.moon.direction) > 0.8, "the new moon stands beside the sun");
});

test("the moon completes a synodic month in ~29.5 days", () => {
  const phases = [];
  for (let day = 1; day <= 70; day += 0.1) {
    phases.push(celestialState({ hour: 0, dayOfYear: day, latitude: 0 }).moon.illumination);
  }
  let peaks = 0;
  for (let i = 1; i < phases.length - 1; i++) {
    if (phases[i] > phases[i - 1] && phases[i] > phases[i + 1] && phases[i] > 0.9) peaks++;
  }
  assert.ok(peaks >= 2, `two full moons inside 70 days, found ${peaks}`);
});

test("seasons name the hemisphere you are standing in", () => {
  assert.equal(seasonName(NORTH_SOLSTICE, 45), "summer");
  assert.equal(seasonName(NORTH_SOLSTICE, -45), "winter");
  assert.equal(seasonName(SOUTH_SOLSTICE, 45), "winter");
  assert.equal(seasonName(EQUINOX, 45), "spring");
  const phase = seasonPhase(EQUINOX, 45);
  assert.ok(phase < 0.02 || phase > 0.98, `the spring equinox is the start of the turn: ${phase}`);
});

test("temperature is seasonal, daily and latitude-scaled", () => {
  const july = airTemperature({ dayOfYear: 196, hour: 15, latitude: 45 });
  const january = airTemperature({ dayOfYear: 15, hour: 5, latitude: 45 });
  assert.ok(july > january + 20, `July ${july} vs January ${january}`);
  assert.ok(january < 4 && january > -12, `a 45° N winter night is near freezing: ${january}`);
  const tropics = airTemperature({ dayOfYear: 15, hour: 5, latitude: 5 });
  assert.ok(tropics > january + 12, "the tropics do not have that winter");
  const arctic = airTemperature({ dayOfYear: 15, hour: 5, latitude: 78 });
  assert.ok(arctic < -15, `an arctic winter night is properly cold: ${arctic}`);
  // Cloud damps the daily swing; the climate offset moves the whole curve.
  const clear = airTemperature({ dayOfYear: 15, hour: 5, latitude: 45, cloudCover: 0 });
  const cloudy = airTemperature({ dayOfYear: 15, hour: 5, latitude: 45, cloudCover: 1 });
  assert.ok(cloudy > clear, "a cloudy night stays warmer");
  assert.ok(Math.abs(airTemperature({ climate: 10 }) - airTemperature({}) - 10) < 1e-9);
});
