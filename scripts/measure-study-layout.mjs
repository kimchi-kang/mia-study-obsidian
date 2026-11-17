import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Native CDP avoids Chrome's minimum window width (500px) for phone measurements.
const profile = await mkdtemp(join(tmpdir(), "mia-layout-"));
const chrome = spawn(process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
let socket;
const exited = new Promise(resolve => { chrome.once("exit", resolve); chrome.once("error", resolve); });
try {
  const endpoint = await new Promise((resolve, reject) => {
    let log = "";
    chrome.on("error", reject);
    chrome.on("exit", code => reject(new Error(`Chrome exited: ${code}\n${log}`)));
    chrome.stderr.on("data", data => {
      log += data;
      const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) resolve(match[1]);
    });
  });
  const targets = await (await fetch(endpoint.replace("ws:", "http:").replace(/\/devtools\/browser\/.*/, "/json/list"))).json();
  socket = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const results = [];
  if (process.env.MIA_LAYOUT_SCREENSHOTS) await mkdir(process.env.MIA_LAYOUT_SCREENSHOTS, { recursive: true });
  const sizes = [[1366, 1024, "tablet"], [1194, 834, "tablet"], [834, 1194, "tablet"], [678, 1024, "tablet"], [390, 844, "phone"], [844, 390, "phone"], [1440, 900, "desktop"], [1920, 1080, "desktop"], [1920, 1080, "tablet"]];
  for (const [width, height, device] of sizes) {
    await call("Emulation.setTouchEmulationEnabled", { enabled: device !== "desktop", maxTouchPoints: 1 });
    for (const theme of process.env.MIA_LAYOUT_STYLES ? ["theme-light", "theme-dark"] : [null]) {
      for (const route of ["dashboard", "progress", "questions", "keywords", "study"]) {
        await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
        const url = pathToFileURL(join(process.cwd(), "tests/fixtures/study-layout-harness.html"));
        url.search = new URLSearchParams({ route, device, ...(width === 844 ? { safeLeft: "47", safeRight: "47" } : {}) });
        await call("Page.navigate", { url: url.href });
        const { result, exceptionDetails } = await call("Runtime.evaluate", {
          expression: `new Promise((resolve, reject) => { const check = () => { if (location.href === ${JSON.stringify(url.href)} && document.readyState === 'complete' && window.miaLayoutReport) requestAnimationFrame(() => requestAnimationFrame(async () => {
            try {
              const theme = ${JSON.stringify(theme)};
              if (theme) { document.body.classList.remove("theme-light", "theme-dark"); document.body.classList.add(theme); }
              const report = window.miaLayoutReport();
              if (theme) {
                report.theme = theme;
                const elements = [document.querySelector(".mia-view"), ...document.querySelectorAll(".mia-view *")];
                report.computedStyles = await Promise.all(elements.map(async element => {
                  const styles = [null, "::before", "::after"].map(pseudo => {
                    const css = getComputedStyle(element, pseudo);
                    return [...css].sort().map(prop => [prop, css.getPropertyValue(prop)]);
                  });
                  const rect = element.getBoundingClientRect();
                  const geometry = [rect.x, rect.y, rect.width, rect.height, element.scrollWidth, element.scrollHeight, element.clientWidth, element.clientHeight];
                  const bytes = new TextEncoder().encode(JSON.stringify({ styles, geometry }));
                  const digest = await crypto.subtle.digest("SHA-256", bytes);
                  return { tag: element.tagName, cls: element.getAttribute("class"), hash: [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, "0")).join("") };
                }));
              }
              resolve(report);
            } catch (error) { reject(error); }
          })); else setTimeout(check, 10); }; check(); })`,
          awaitPromise: true, returnByValue: true,
        });
        if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails));
        const report = { width, height, ...result.value };
        if (report.paneWidth !== width || report.innerWidth !== width) throw new Error(`Wrong viewport: ${JSON.stringify(report)}`);
        results.push(report);
        if (process.env.MIA_LAYOUT_SCREENSHOTS) {
          const { data } = await call("Page.captureScreenshot", { format: "png" });
          await writeFile(join(process.env.MIA_LAYOUT_SCREENSHOTS, `${width}-${height}-${device}-${theme ? `${theme}-` : ""}${route}.png`), Buffer.from(data, "base64"));
        }
        console.log(`${width}×${height} ${route}: ${report.contentWidth.toFixed(1)}px / ${(100 * report.contentSafePaneRatio).toFixed(1)}%, overflow=${report.horizontalOverflow || report.paneHorizontalOverflow}, grids=${JSON.stringify(report.grids)}`);
      }
    }
  }
  await writeFile(process.argv[2] ?? "/tmp/mia-wide-measurements.json", JSON.stringify(results, null, 2) + "\n");
  if (results.some(r => r.device !== "desktop" && r.width < 1600 && r.contentSafePaneRatio < .94)) throw new Error("Touch content narrower than 94% of safe pane");
  if (results.some(r => r.device !== "desktop" && r.route !== "study" && r.contentWidth > 1600)) throw new Error("Library cap exceeded");
  if (results.some(r => r.route === "questions" && r.panelVisible !== (r.device !== "phone" && r.width >= 1000))) throw new Error("Detail panel visibility regressed");
  if (results.some(r => r.horizontalOverflow || r.paneHorizontalOverflow || r.overflowingElements.length)) throw new Error("Horizontal overflow detected");
} finally {
  socket?.close();
  chrome.kill();
  await exited;
  await rm(profile, { recursive: true, force: true });
}
