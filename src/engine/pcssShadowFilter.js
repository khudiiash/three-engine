import {
  Fn,
  If,
  clamp,
  float,
  max,
  orthographicDepthToViewZ,
  reference,
  renderGroup,
  step,
  texture,
  vec2,
  vogelDiskSample,
} from "three/tsl";

const BLOCKER_SAMPLES = 8;
const FILTER_SAMPLES = 12;

/**
 * Stable directional-light PCSS filter for Three's WebGPU shadow pipeline.
 *
 * `LightShadow.radius` is interpreted as the area-light radius in world
 * units. The blocker search estimates receiver/caster separation, then grows
 * the PCF disk from contact-hard to a bounded soft penumbra. The fixed
 * shadow-map-space Vogel pattern avoids temporal noise and camera-space grain.
 */
export const PCSSShadowFilter = Fn(
  ({ depthTexture, shadowCoord, shadow, depthLayer }, builder) => {
    const mapSize = reference("mapSize", "vec2", shadow).setGroup(
      renderGroup,
    );
    const sourceRadius = max(
      reference("radius", "float", shadow).setGroup(renderGroup),
      0,
    );
    const cameraNear = reference(
      "near",
      "float",
      shadow.camera,
    ).setGroup(renderGroup);
    const cameraFar = reference(
      "far",
      "float",
      shadow.camera,
    ).setGroup(renderGroup);
    const cameraLeft = reference(
      "left",
      "float",
      shadow.camera,
    ).setGroup(renderGroup);
    const cameraRight = reference(
      "right",
      "float",
      shadow.camera,
    ).setGroup(renderGroup);

    const texelSize = vec2(1).div(mapSize);
    const shadowWorldWidth = max(cameraRight.sub(cameraLeft), 1e-4);
    const receiverDepth = shadowCoord.z;
    const receiverDistance = max(
      orthographicDepthToViewZ(
        receiverDepth,
        cameraNear,
        cameraFar,
      ).negate(),
      cameraNear,
    );

    const rawDepth = (uv) => {
      let sample = texture(depthTexture, uv);
      if (depthTexture.isArrayTexture) sample = sample.depth(depthLayer);
      return sample.x;
    };

    const depthCompare = (uv) => {
      const sampleDepth = rawDepth(uv);
      return builder.renderer.reversedDepthBuffer === true
        ? step(sampleDepth, receiverDepth)
        : step(receiverDepth, sampleDepth);
    };

    // Search far enough to find the blockers capable of producing this
    // penumbra, but cap the disk so a large artistic radius cannot explode
    // the shadow cost/blur across the whole map.
    const receiverRatio = clamp(
      receiverDistance.sub(cameraNear).div(receiverDistance),
      0,
      1,
    );
    const searchRadius = clamp(
      sourceRadius.div(shadowWorldWidth).mul(receiverRatio),
      texelSize.x.mul(1.5),
      texelSize.x.mul(20),
    );

    const blockerDistanceSum = float(0).toVar();
    const blockerCount = float(0).toVar();
    const accumulateBlocker = (uv) => {
      const sampleDepth = rawDepth(uv);
      const isBlocker =
        builder.renderer.reversedDepthBuffer === true
          ? sampleDepth.greaterThan(receiverDepth)
          : sampleDepth.lessThan(receiverDepth);
      If(isBlocker, () => {
        blockerDistanceSum.addAssign(
          max(
            orthographicDepthToViewZ(
              sampleDepth,
              cameraNear,
              cameraFar,
            ).negate(),
            cameraNear,
          ),
        );
        blockerCount.addAssign(1);
      });
    };

    // Always include the receiver's own shadow texel; the remaining taps use
    // a compact disk with a fixed orientation in light space.
    accumulateBlocker(shadowCoord.xy);
    for (let i = 0; i < BLOCKER_SAMPLES; i++) {
      accumulateBlocker(
        shadowCoord.xy.add(
          vogelDiskSample(i, BLOCKER_SAMPLES, float(0)).mul(
            searchRadius,
          ),
        ),
      );
    }

    const visibility = float(1).toVar();
    If(blockerCount.greaterThan(0), () => {
      const blockerDistance = blockerDistanceSum.div(blockerCount);
      const separation = max(receiverDistance.sub(blockerDistance), 0);
      const penumbraWorld = sourceRadius.mul(separation).div(
        max(blockerDistance, cameraNear),
      );
      const filterRadius = clamp(
        penumbraWorld.div(shadowWorldWidth),
        texelSize.x.mul(0.65),
        texelSize.x.mul(24),
      );

      const filtered = float(0).toVar();
      filtered.addAssign(depthCompare(shadowCoord.xy));
      for (let i = 0; i < FILTER_SAMPLES; i++) {
        filtered.addAssign(
          depthCompare(
            shadowCoord.xy.add(
              vogelDiskSample(i, FILTER_SAMPLES, float(0)).mul(
                filterRadius,
              ),
            ),
          ),
        );
      }
      visibility.assign(filtered.mul(1 / (FILTER_SAMPLES + 1)));
    });

    return visibility;
  },
);
