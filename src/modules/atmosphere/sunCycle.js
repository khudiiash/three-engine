/**
 * ⭐ WHERE THE SUN AND THE MOON ACTUALLY ARE.
 *
 * A game's sky is usually "an angle that goes round"; that reads as wrong the
 * moment anyone looks twice, because the two things people DO notice about a
 * sky are seasonal — how high the sun climbs at noon, and how long the day
 * lasts — and neither exists in a spinning angle. So this is the real
 * low-precision ephemeris (Meeus, ch. 25 / 47), which costs about eighty lines
 * and buys: seasons for free (declination IS the season), a day length that
 * changes with latitude, a sun that rises north of east in summer, and a moon
 * whose phase and rise time agree with each other (a full moon rises at
 * sunset — a detail that is free here and impossible to fake).
 *
 * ⚠ THE CLOCK IS LOCAL APPARENT TIME, NOT UTC. `hour` is what a clock in the
 * scene says, and 12:00 means "near solar noon" at every longitude — so there
 * is no timezone or longitude property to get wrong. The equation of time is
 * still applied (±16 minutes over the year), because it is what makes the
 * earliest sunset and the shortest day fall on different dates, and it is one
 * line once the sun's true longitude exists.
 *
 * Frame: three.js Y-up, +X east, -Z north, `northOffset` degrees rotating the
 * compass about Y for scenes that were not built facing north.
 *
 * No `three` import: this is arithmetic over numbers, so `npm run
 * test:atmosphere` runs it under bare Node with no GPU and no renderer.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
/** Earth's obliquity, J2000. Drifts 0.013 deg/century — irrelevant here. */
const OBLIQUITY = 23.4393 * RAD;
/** Synodic month: new moon to new moon. */
export const SYNODIC_MONTH = 29.530588853;
export const TROPICAL_YEAR = 365.2422;

const sin = Math.sin, cos = Math.cos, asin = Math.asin, atan2 = Math.atan2, tan = Math.tan;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** Wrap to [-180, 180) degrees — every angle difference below needs it. */
const wrap180 = (deg) => ((deg + 180) % 360 + 360) % 360 - 180;
const wrap360 = (deg) => ((deg % 360) + 360) % 360;

/**
 * Days since the J2000 epoch, from the two properties a scene actually
 * authors. `dayOfYear` is 1-based (1 = January 1) and fractional days are
 * allowed, so a running clock is just `dayOfYear + hour/24`.
 *
 * `year` exists only so a long campaign's moon phases do not repeat exactly
 * every 365 days; it is not a date picker and nothing else reads it.
 */
export function epochDays(dayOfYear, hour, year = 2000) {
  const y = Math.round(Number(year)) || 2000;
  return (y - 2000) * 365.25 + (Number(dayOfYear) || 1) - 1 + (Number(hour) || 0) / 24 - 0.5;
}

/** Sun in ecliptic coordinates: mean longitude and true longitude, degrees. */
function sunEcliptic(d) {
  const meanLongitude = wrap360(280.4665 + 0.98564736 * d);
  const meanAnomaly = (357.5291 + 0.98560028 * d) * RAD;
  // Equation of the centre — the two terms that matter below 0.01 degrees.
  const centre = 1.9148 * sin(meanAnomaly) + 0.02 * sin(2 * meanAnomaly);
  return { meanLongitude, longitude: wrap360(meanLongitude + centre) };
}

/** Ecliptic (lon, lat) to equatorial (right ascension, declination), degrees. */
function equatorial(longitudeDeg, latitudeDeg = 0) {
  const l = longitudeDeg * RAD, b = latitudeDeg * RAD;
  const sinDec = sin(b) * cos(OBLIQUITY) + cos(b) * sin(OBLIQUITY) * sin(l);
  const declination = asin(clamp(sinDec, -1, 1)) * DEG;
  const rightAscension = wrap360(atan2(
    sin(l) * cos(OBLIQUITY) - tan(b) * sin(OBLIQUITY),
    cos(l),
  ) * DEG);
  return { rightAscension, declination };
}

/**
 * (hour angle, declination, latitude) into the horizontal frame, then into
 * world space. Written without a division by cos(altitude) so the poles are
 * not a special case: both azimuth components come out of the same pair of
 * dot products the altitude does.
 */
function horizontal(hourAngleDeg, declinationDeg, latitudeDeg, northOffsetDeg) {
  const H = hourAngleDeg * RAD, dec = declinationDeg * RAD, phi = latitudeDeg * RAD;
  const sinAlt = clamp(sin(phi) * sin(dec) + cos(phi) * cos(dec) * cos(H), -1, 1);
  const altitude = asin(sinAlt);
  const north = cos(phi) * sin(dec) - sin(phi) * cos(dec) * cos(H);
  const east = -cos(dec) * sin(H);
  const azimuth = wrap360(atan2(east, north) * DEG);
  // Compass to world: +X east, -Z north, `northOffset` turns the compass.
  const turn = (azimuth + (Number(northOffsetDeg) || 0)) * RAD;
  const horizontalScale = cos(altitude);
  return {
    altitude: altitude * DEG,
    azimuth,
    // Direction TO the body, unit length.
    direction: [horizontalScale * sin(turn), sinAlt, -horizontalScale * cos(turn)],
  };
}

/**
 * The moon, to about a degree — enough that it rises where its phase says it
 * should. Three periodic terms out of Meeus' sixty: evection, the annual
 * equation and the variation. The rest move it by minutes of arc, which is
 * smaller than the disc this draws.
 */
function moonEcliptic(d, sunMeanLongitude) {
  const meanLongitude = wrap360(218.316 + 13.176396 * d);
  const meanAnomaly = (134.963 + 13.064993 * d) * RAD;
  const argumentOfLatitude = (93.272 + 13.229350 * d) * RAD;
  const elongation = (meanLongitude - sunMeanLongitude) * RAD;
  const longitude = wrap360(
    meanLongitude
    + 6.289 * sin(meanAnomaly)
    + 1.274 * sin(2 * elongation - meanAnomaly)
    + 0.658 * sin(2 * elongation)
    - 0.186 * sin((357.529 + 0.98560028 * d) * RAD),
  );
  const latitude = 5.128 * sin(argumentOfLatitude);
  return { longitude, latitude };
}

/**
 * Everything the sky, the lights and the weather need to know about the time.
 *
 * @param {object} time
 * @param {number} [time.hour]        local clock hour, 0…24 (fractional)
 * @param {number} [time.dayOfYear]   1…365.25, fractional
 * @param {number} [time.latitude]    degrees, -90…90
 * @param {number} [time.northOffset] degrees the world's north is turned by
 * @param {number} [time.year]        only advances the moon's phase between years
 */
export function celestialState({ hour = 12, dayOfYear = 172, latitude = 45, northOffset = 0, year = 2000 } = {}) {
  const d = epochDays(dayOfYear, hour, year);
  const sunEcl = sunEcliptic(d);
  const sunEq = equatorial(sunEcl.longitude);
  // Equation of time: the gap between the mean sun (the clock) and the true
  // sun (the sky), in minutes. Four minutes per degree.
  const equationOfTime = 4 * wrap180(sunEcl.meanLongitude - sunEq.rightAscension);
  // Local hour angle of the true sun. Noon on the clock is solar noon plus the
  // equation of time — the whole reason it is computed.
  const sunHourAngle = (hour - 12) * 15 + equationOfTime / 4;
  const sun = horizontal(sunHourAngle, sunEq.declination, latitude, northOffset);
  // Local sidereal time, recovered from the sun rather than from UTC: the
  // clock is local apparent time by construction, so LST = H_sun + RA_sun.
  const siderealDeg = sunHourAngle + sunEq.rightAscension;

  const moonEcl = moonEcliptic(d, sunEcl.meanLongitude);
  const moonEq = equatorial(moonEcl.longitude, moonEcl.latitude);
  const moon = horizontal(wrap180(siderealDeg - moonEq.rightAscension), moonEq.declination, latitude, northOffset);
  // Phase angle: 0 = new, 0.5 = full. Illuminated fraction is what the disc
  // shader wants for its terminator.
  const elongation = wrap360(moonEcl.longitude - sunEcl.longitude);
  const illumination = (1 - cos(elongation * RAD)) / 2;

  // Sunrise / sunset for the geometric horizon plus the standard 0.833 degree
  // refraction-and-radius correction. |cos H0| > 1 is polar day or polar
  // night, and both are real answers a game at high latitude has to render.
  const dec = sunEq.declination * RAD, phi = latitude * RAD;
  const cosH0 = (cos(90.833 * RAD) - sin(phi) * sin(dec)) / (cos(phi) * cos(dec));
  const polar = Math.abs(cosH0) > 1 ? (cosH0 > 0 ? "night" : "day") : null;
  const halfDay = polar ? (polar === "day" ? 12 : 0) : Math.acos(clamp(cosH0, -1, 1)) * DEG / 15;
  const solarNoon = 12 - equationOfTime / 60;

  return {
    dayOfYear, hour, latitude, northOffset,
    sun: { ...sun, declination: sunEq.declination, hourAngle: sunHourAngle },
    moon: { ...moon, illumination, phase: elongation / 360, declination: moonEq.declination },
    equationOfTime,
    solarNoon,
    sunrise: polar ? null : solarNoon - halfDay,
    sunset: polar ? null : solarNoon + halfDay,
    dayLength: halfDay * 2,
    polar,
    siderealAngle: wrap360(siderealDeg),
    // -1 … 1, negative in the local winter. This IS the season: the
    // declination projected onto the hemisphere you stand in, so the southern
    // hemisphere gets its summer in December without a second code path.
    seasonAxis: clamp(sunEq.declination / 23.4393, -1, 1) * (latitude < 0 ? -1 : 1),
    season: seasonName(dayOfYear, latitude),
    seasonPhase: seasonPhase(dayOfYear, latitude),
  };
}

/**
 * Season as a continuous [0,1) turn of the year: 0 = the spring equinox of the
 * hemisphere you are standing in, 0.25 = midsummer. Weather reads the
 * CONTINUOUS value (a snow chance does not step on a date); the name is for
 * the inspector and for scripts.
 */
export function seasonPhase(dayOfYear, latitude = 45) {
  const shifted = (Number(dayOfYear) || 1) - 80; // ~March 21, the spring equinox
  const turn = ((shifted / TROPICAL_YEAR) % 1 + 1) % 1;
  return latitude < 0 ? (turn + 0.5) % 1 : turn;
}

export const SEASONS = ["spring", "summer", "autumn", "winter"];

export function seasonName(dayOfYear, latitude = 45) {
  return SEASONS[Math.min(3, Math.floor(seasonPhase(dayOfYear, latitude) * 4))];
}

/**
 * Air temperature in Celsius — the one number that decides rain versus snow,
 * and the one a gameplay script asks for. Two terms: the seasonal swing (peak
 * about 30 days after midsummer, the standard thermal lag) and the daily swing
 * (coldest just before sunrise, warmest mid-afternoon), with amplitudes that
 * grow with latitude because that is what continental climates do.
 *
 * `climate` shifts the whole curve so a scene can be arctic or tropical
 * without moving its latitude — latitude also decides the sun's path, and an
 * author usually wants to change only one of the two.
 */
export function airTemperature({ dayOfYear = 172, hour = 12, latitude = 45, climate = 0, cloudCover = 0, precipitation = 0 } = {}) {
  const phi = Math.abs(clamp(Number(latitude) || 0, -90, 90)) / 90;
  // Annual mean: ~26 C at the equator falling to ~-18 C at the poles.
  const annualMean = 26 - 44 * phi * phi + (Number(climate) || 0);
  // ⚠ THE LAG IS SUBTRACTED, NOT ADDED. `seasonPhase` is 0.25 at midsummer and
  // the warmest day is ~30 days AFTER it, so the curve's peak belongs at
  // 0.25 + 30/year. The first cut had the sign the other way and put the
  // coldest night of a 45° N January at +5 °C — a whole season's error hiding
  // inside a plausible-looking number.
  const seasonal = 20 * phi * cos(2 * Math.PI * (seasonPhase(dayOfYear, latitude) - 0.25 - 30 / TROPICAL_YEAR));
  // Daily swing, damped by cloud: a cloudy night does not get cold.
  const daily = (3 + 4 * (1 - phi)) * (1 - 0.6 * clamp(cloudCover, 0, 1))
    * cos(2 * Math.PI * ((Number(hour) || 0) - 15) / 24);
  return annualMean + seasonal + daily - 2 * clamp(precipitation, 0, 1);
}
