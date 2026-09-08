/**
 * The `.geom` thumbnail renderer moved into assetThumbs.js, which renders
 * materials and panoramas on the same offscreen renderer. This module keeps
 * the old names for the callers that predate that.
 */
export { requestGeometryThumb, invalidateGeometryThumb } from "./assetThumbs.js";
