// Headless tests for the UI layout math (no renderer, no DOM).
// Run: node scripts/test-ui-layout.mjs
import {
  computeElementRect,
  pivotPoint,
  intersectRects,
  rectContains,
  computeScreenScale,
  layoutChildren,
  clampScroll,
  applyAnchorPreset,
  ELEMENT_DEFAULTS,
} from "../src/engine/ui/layout.js";

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}\n      got      ${a}\n      expected ${b}`);
  }
}

const screen = { x: 0, y: 0, w: 1280, h: 720 };

console.log("computeElementRect — point anchors");
check(
  "centered 200x100",
  computeElementRect(screen, { ...ELEMENT_DEFAULTS, size: [200, 100] }),
  { x: 540, y: 310, w: 200, h: 100 },
);
check(
  "top-left with pivot 0,0 and pos 10,20",
  computeElementRect(screen, {
    ...ELEMENT_DEFAULTS,
    anchorMin: [0, 0], anchorMax: [0, 0], pivot: [0, 0], pos: [10, 20], size: [50, 60],
  }),
  { x: 10, y: 20, w: 50, h: 60 },
);
check(
  "bottom-right pivot 1,1 offset -10,-10",
  computeElementRect(screen, {
    ...ELEMENT_DEFAULTS,
    anchorMin: [1, 1], anchorMax: [1, 1], pivot: [1, 1], pos: [-10, -10], size: [100, 40],
  }),
  { x: 1170, y: 670, w: 100, h: 40 },
);

console.log("computeElementRect — stretch");
check(
  "full stretch, 16px margins",
  computeElementRect(screen, {
    ...ELEMENT_DEFAULTS,
    anchorMin: [0, 0], anchorMax: [1, 1], pos: [16, 16], size: [16, 16],
  }),
  { x: 16, y: 16, w: 1248, h: 688 },
);
check(
  "top bar: stretch-x point-y",
  computeElementRect(screen, {
    ...ELEMENT_DEFAULTS,
    anchorMin: [0, 0], anchorMax: [1, 0], pivot: [0.5, 0], pos: [0, 0], size: [0, 48],
  }),
  { x: 0, y: 0, w: 1280, h: 48 },
);

console.log("nesting");
{
  const panel = computeElementRect(screen, { ...ELEMENT_DEFAULTS, size: [400, 300] });
  const inner = computeElementRect(panel, {
    ...ELEMENT_DEFAULTS,
    anchorMin: [0, 0], anchorMax: [1, 1], pos: [8, 8], size: [8, 8],
  });
  check("panel-relative stretch", inner, { x: 448, y: 218, w: 384, h: 284 });
}

console.log("pivotPoint");
check(
  "pivot 1,0 of rect",
  pivotPoint({ x: 10, y: 20, w: 100, h: 50 }, { pivot: [1, 0] }),
  { x: 110, y: 20 },
);

console.log("rect utils");
check(
  "intersection",
  intersectRects({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 60, w: 100, h: 100 }),
  { x: 50, y: 60, w: 50, h: 40 },
);
check("null clip passthrough", intersectRects(null, { x: 1, y: 2, w: 3, h: 4 }), { x: 1, y: 2, w: 3, h: 4 });
check("contains", rectContains({ x: 0, y: 0, w: 10, h: 10 }, 5, 5), true);
check("not contains", rectContains({ x: 0, y: 0, w: 10, h: 10 }, 15, 5), false);

console.log("computeScreenScale");
check("none", computeScreenScale("none", 1280, 720, 1920, 1080), 1);
check("fit on wider canvas", computeScreenScale("fit", 1280, 720, 2560, 720), 1);
check("fill on wider canvas", computeScreenScale("fill", 1280, 720, 2560, 720), 2);
check("width", computeScreenScale("width", 1280, 720, 640, 1000), 0.5);
check("height", computeScreenScale("height", 1280, 720, 640, 1440), 2);

console.log("layoutChildren — column");
{
  const container = { x: 100, y: 100, w: 300, h: 500 };
  const { rects, contentMain } = layoutChildren(
    container,
    { direction: "column", gap: 10, padding: 20, alignItems: "stretch", justify: "start" },
    [[100, 40], [100, 60]],
  );
  check("first child", rects[0], { x: 120, y: 120, w: 260, h: 40 });
  check("second child", rects[1], { x: 120, y: 170, w: 260, h: 60 });
  check("contentMain", contentMain, 40 + 60 + 10 + 40);
}

console.log("layoutChildren — row center/center");
{
  const container = { x: 0, y: 0, w: 400, h: 100 };
  const { rects } = layoutChildren(
    container,
    { direction: "row", gap: 20, padding: 0, alignItems: "center", justify: "center" },
    [[50, 40], [50, 40]],
  );
  check("first child", rects[0], { x: 140, y: 30, w: 50, h: 40 });
  check("second child", rects[1], { x: 210, y: 30, w: 50, h: 40 });
}

console.log("layoutChildren — space-between");
{
  const container = { x: 0, y: 0, w: 320, h: 100 };
  const { rects } = layoutChildren(
    container,
    { direction: "row", gap: 0, padding: 10, alignItems: "start", justify: "space-between" },
    [[50, 30], [50, 30], [50, 30]],
  );
  check("first at padding", rects[0].x, 10);
  check("last flush right", rects[2].x, 260);
}

console.log("clampScroll");
check("clamps low", clampScroll(-10, 500, 200), 0);
check("clamps high", clampScroll(999, 500, 200), 300);
check("no scroll when content fits", clampScroll(50, 100, 200), 0);

console.log("anchor presets");
{
  const preset = applyAnchorPreset("bottom-right", [120, 40]);
  check("bottom-right keeps size", preset, {
    anchorMin: [1, 1], anchorMax: [1, 1], pivot: [1, 1], pos: [0, 0], size: [120, 40],
  });
  const stretch = applyAnchorPreset("stretch", [120, 40]);
  check("stretch zeroes insets", stretch, {
    anchorMin: [0, 0], anchorMax: [1, 1], pivot: [0.5, 0.5], pos: [0, 0], size: [0, 0],
  });
  const sx = applyAnchorPreset("stretch-x", [120, 40]);
  check("stretch-x keeps height", sx.size, [0, 40]);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll UI layout tests passed.");
