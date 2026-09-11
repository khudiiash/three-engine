declare module "engine" {
  interface EngineEventMap {
    /** A lightning strike, with the delay before its thunder should be heard. */
    "atmosphere-lightning": [import("engine").AtmosphereStrike];
    /** The weather crossed to a new preset (authored or chosen by the chain). */
    "atmosphere-weather": [{ entityId: string; weather: string }];
  }
}
