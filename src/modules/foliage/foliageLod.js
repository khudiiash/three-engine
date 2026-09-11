/** A cell is a quality decision as well as a draw group. A 24 m grass cell
 * keeps thousands of blades detailed when just one corner is near the camera. */
export function foliageCellSize(props) {
  const authored = Math.max(1, Number(props.chunkSize) || 24);
  const low = props.species === "grass" || props.species === "wildflowers";
  const height = Math.max(.05, Number(props.height) || 1);
  return Math.min(authored, low ? Math.max(6, Math.min(12, height * 12)) : Math.max(12, Math.min(24, height * 2)));
}

/** Authored distances are upper bounds: subpixel detail earns no extra work.
 * projectionScale is render-target pixels per world unit at distance one.
 * The caller supplies an output object so camera motion allocates nothing. */
export function foliageDetailDistances(props, projectionScale, plantSize, output = {}) {
  const low = props.species === "grass" || props.species === "wildflowers";
  const pixels = Math.max(0, projectionScale) * Math.max(.01, plantSize);
  const near = Math.max(0, Number(props.lodNear) || 0);
  const far = Math.max(near + 1, Number(props.lodFar) || near + 1);
  output.lodNear = pixels > 0 ? Math.min(near, pixels / (low ? 80 : 220)) : near;
  output.lodFar = pixels > 0 ? Math.min(far, pixels / (low ? 18 : 56)) : far;
  output.maxDistance = Math.max(far + 1, Number(props.maxDistance) || far + 1);
  return output;
}

/** Distance uses the nearest point of a tight box, not its enclosing sphere.
 * Hysteresis makes a stationary boundary stable under jitter. */
export function foliageLodLevel(distance, previous, props, impostorReady = true) {
  const near = Math.max(0, Number(props.lodNear) || 0);
  const far = Math.max(near + 1, Number(props.lodFar) || near + 1);
  const end = Math.max(far + 1, Number(props.maxDistance) || far + 1);
  const boundaries = [near, far, end];
  let level = distance < near ? 0 : distance < far ? 1 : distance < end ? 2 : 3;
  if (previous >= 0 && previous <= 3 && level !== previous) {
    if (level > previous && distance < boundaries[Math.min(previous, 2)] * 1.08) level = previous;
    if (level < previous && distance > boundaries[Math.max(0, previous - 1)] * .92) level = previous;
  }
  return level === 2 && !impostorReady ? 1 : level;
}

export function partitionFoliage(instances, chunkSize = 24, maxChunkInstances = 1024) {
  const size = Math.max(1, Number(chunkSize) || 24);
  const cells = new Map();
  for (const instance of instances) {
    const p = instance.position;
    const key = `${Math.floor(p[0] / size)},${Math.floor(p[1] / size)},${Math.floor(p[2] / size)}`;
    let cell = cells.get(key);
    if (!cell) cells.set(key, cell = []);
    cell.push(instance);
  }
  const chunks = [];
  const limit = Math.max(1, Math.floor(Number(maxChunkInstances) || 1024));
  const split = (key, cell) => {
    if (cell.length <= limit) { chunks.push({ key, instances: cell }); return; }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const instance of cell) for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], instance.position[axis]);
      max[axis] = Math.max(max[axis], instance.position[axis]);
    }
    const extent = max.map((value, axis) => value - min[axis]);
    const axis = extent[1] > extent[0] && extent[1] >= extent[2] ? 1 : extent[2] > extent[0] ? 2 : 0;
    cell.sort((a, b) => a.position[axis] - b.position[axis]);
    const half = Math.ceil(cell.length / 2);
    split(`${key}a`, cell.slice(0, half)); split(`${key}b`, cell.slice(half));
  };
  for (const [key, cell] of cells) {
    // Consecutive slices of randomly scattered points all span the SAME cell.
    // Median splitting makes a dense child genuinely smaller for LOD/culling.
    split(`${key}:0`, cell);
  }
  return chunks;
}
