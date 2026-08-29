// §19 6.25d — MAKE THE GPU'S OWN ERRORS VISIBLE IN A HARNESS. A pipeline that
// fails to build, a bind group over the limit, a lost device: WebGPU reports
// these as UNCAPTURED errors on the device, not as console lines, so a
// puppeteer harness that only tees `console` sees a kernel silently not run.
// Install BEFORE navigation: patches `GPUAdapter.prototype.requestDevice` so
// every device the page creates forwards `uncapturederror` and `lost` to
// `console.error("[webgpu] …")`, which the page's console tee then carries.
//
//   await installWebGpuErrorLog(page);           // then page.goto(...)
//   page.on("console", (m) => { if (m.text().startsWith("[webgpu]")) ... });
export async function installWebGpuErrorLog(page) {
  await page.evaluateOnNewDocument(() => {
    const proto = globalThis.GPUAdapter?.prototype;
    if (!proto?.requestDevice) return;
    const orig = proto.requestDevice;
    proto.requestDevice = async function (...a) {
      const dev = await orig.apply(this, a);
      dev.addEventListener("uncapturederror", (e) => console.error("[webgpu] " + String(e?.error?.message ?? e).slice(0, 1500)));
      dev.lost?.then?.((i) => console.error("[webgpu] device lost: " + i?.message));
      return dev;
    };
  });
}
