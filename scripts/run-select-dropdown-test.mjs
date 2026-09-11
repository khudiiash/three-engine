// Every dropdown in the editor is `fields/Select.jsx`, not a native `<select>`.
//
// A native select is styleable down to its trigger and no further: the open
// list is drawn by the platform, so in this near-black editor every dropdown
// came up white. `Select` is the drop-in that replaced ~100 of them, and it
// only works as a drop-in if it keeps the DOM's contract — `<option>` children
// (including from `.map()`, `&&` and `<optgroup>`), and an `onChange` that
// hands back `{ target: { value } }` with a STRING, so `Number(e.target.value)`
// handlers keep working untouched.
//
//   npx vite --port 5219
//   node scripts/run-select-dropdown-test.mjs
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const URL = process.argv[2] ?? "http://localhost:5219/";
const CHROME =
  process.env.CHROME ??
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ].find((p) => fs.existsSync(p));

let failures = 0;
const check = (name, got, detail) => {
  console.log(`  ${got ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!got) failures++;
};

if (!CHROME) {
  console.error("no Chrome found; set CHROME=<path to chrome.exe>");
  process.exit(1);
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800 });

// Mount Select on its own against the real stylesheets — no editor, no project,
// so this stays a unit test of the control rather than a boot test.
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.evaluate(() => {
  document.body.innerHTML = '<div id="probe"></div>';
});

const result = await page.evaluate(async () => {
  const { mountSelectProbe } = await import("/scripts/lib/selectProbe.jsx");
  const seen = mountSelectProbe(document.getElementById("probe"));

  await new Promise((r) => setTimeout(r, 120));

  const trigger = document.querySelector("button.tx-select");
  const out = {
    renderedAsButton: !!trigger,
    noNativeSelect: !document.querySelector("select"),
    keepsCallerClass: trigger?.classList.contains("select-field") ?? false,
    showsCurrentLabel: trigger?.querySelector(".tx-select-value")?.textContent ?? null,
    triggerBg: trigger ? getComputedStyle(trigger).backgroundColor : null,
    // The caller class carries a CSS chevron for a native control; a real icon
    // is drawn now, so that image must be suppressed.
    chevronImage: trigger ? getComputedStyle(trigger).backgroundImage : null,
    triggerFont: trigger ? getComputedStyle(trigger).fontSize : null,
  };

  trigger.click();
  await new Promise((r) => setTimeout(r, 120));
  const menu = document.querySelector(".tx-select-menu");
  out.menuOpens = !!menu;
  out.menuBg = menu ? getComputedStyle(menu).backgroundColor : null;
  out.menuPortalled = menu ? menu.closest("#probe") === null : false;
  const items = [...(menu?.querySelectorAll(".dropdown-item") ?? [])].map((b) => b.textContent.trim());
  out.items = items;
  out.groupLabel = menu?.querySelector(".dropdown-section-label")?.textContent ?? null;
  const firstItem = menu?.querySelector(".dropdown-item");
  out.itemFont = firstItem ? getComputedStyle(firstItem).fontSize : null;
  // A tick glyph beside a value reads as a checkbox — and Phosphor's `fill`
  // weight (the icon set's default) draws Check as a filled tile with the mark
  // knocked out, which is literally a checkbox. The current entry is marked by
  // the row treatment every other menu in the editor uses instead.
  out.tickGlyphs = menu ? menu.querySelectorAll("svg").length : -1;
  out.selectedRowIsChecked = !!menu?.querySelector(".dropdown-item.checked");

  // Pick "C" from inside the optgroup, then the numeric-valued option.
  const pick = (label) =>
    [...document.querySelectorAll(".tx-select-menu .dropdown-item")].find((b) => b.textContent.trim().startsWith(label))?.click();
  pick("C");
  await new Promise((r) => setTimeout(r, 120));
  out.afterPick = document.querySelector("button.tx-select .tx-select-value")?.textContent ?? null;
  out.menuClosed = !document.querySelector(".tx-select-menu");
  document.querySelector("button.tx-select").click();
  await new Promise((r) => setTimeout(r, 120));
  pick("Three");
  await new Promise((r) => setTimeout(r, 120));
  out.onChangePayload = seen;
  return out;
});

await browser.close();

const isWhite = (c) => /rgb\(255,\s*255,\s*255\)/.test(c ?? "");

console.log("\nthe control replaces a native select");
check("renders a real button, not a <select>", result.renderedAsButton && result.noNativeSelect);
check("keeps the caller's field class on the trigger", result.keepsCallerClass);
check("shows the selected option's label", result.showsCurrentLabel === "Bravo", result.showsCurrentLabel);
check("drops the caller class's CSS chevron (a real icon is drawn)", result.chevronImage === "none", result.chevronImage);

console.log("\nnothing is white");
check("the trigger is not white", !isWhite(result.triggerBg), result.triggerBg);
check("the OPEN LIST is not white — the whole point", !isWhite(result.menuBg), result.menuBg);

console.log("\nit keeps the DOM's contract");
check("the menu opens", result.menuOpens);
check("it is portalled out of the field's own box", result.menuPortalled);
check("literal, mapped and optgroup children all become items", result.items.length === 5, result.items);
check("a false child is dropped, not rendered", !result.items.some((t) => t.includes("Hidden")));
check("optgroup renders its label", result.groupLabel === "Group", result.groupLabel);
check("picking updates the value", result.afterPick === "C", result.afterPick);
check("onChange gets { target: { value } }", result.onChangePayload[0]?.raw === "c", result.onChangePayload);
check("a numeric option value arrives as a STRING, exactly as the DOM gives it", result.onChangePayload[1]?.raw === "3", result.onChangePayload[1]);
check("so Number(e.target.value) still yields the number", result.onChangePayload[1]?.asNumber === "3");
check("the menu closes after a pick", result.menuClosed);

console.log("\nit looks like part of its field");
check("no tick glyph in the list — that reads as a checkbox", result.tickGlyphs === 0, result.tickGlyphs);
check("the current entry uses the shared 'checked' row treatment", result.selectedRowIsChecked);
check("the list matches the trigger's type size", result.itemFont === result.triggerFont, {
  trigger: result.triggerFont,
  item: result.itemFont,
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall dropdown checks passed");
