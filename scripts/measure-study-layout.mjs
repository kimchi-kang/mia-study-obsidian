import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Regenerate the additional screens from the current source before fingerprinting.
// Set MIA_LAYOUT_EXTENDED=0 only to reproduce the original five-route baseline.
const extendedEnabled = process.env.MIA_LAYOUT_EXTENDED !== "0";
if (extendedEnabled) {
  const generated = spawnSync(process.execPath, ["scripts/generate-study-layout-harness.mjs"], { stdio: "inherit", env: process.env });
  if (generated.error) throw generated.error;
  if (generated.status !== 0) throw new Error("Layout harness generation failed.");
}

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
  const extras = extendedEnabled ? JSON.parse(await readFile(".claude/slim/layout-extra-cases.json", "utf8")) : [];
  if (process.env.MIA_LAYOUT_SCREENSHOTS) await mkdir(process.env.MIA_LAYOUT_SCREENSHOTS, { recursive: true });
  const sizes = [[1366, 1024, "tablet"], [1194, 834, "tablet"], [834, 1194, "tablet"], [678, 1024, "tablet"], [360, 800, "phone"], [390, 844, "phone"], [844, 390, "phone"], [1440, 900, "desktop"], [1920, 1080, "desktop"], [1920, 1080, "tablet"]];
  for (const [width, height, device] of sizes.filter(size => !process.env.MIA_LAYOUT_SIZE || process.env.MIA_LAYOUT_SIZE.split(",").map(Number).includes(size[0]))) {
    await call("Emulation.setTouchEmulationEnabled", { enabled: device !== "desktop", maxTouchPoints: 1 });
    for (const theme of process.env.MIA_LAYOUT_STYLES ? ["theme-light", "theme-dark"] : [null]) {
      for (const route of ["dashboard", "progress", "questions", "keywords", "study", ...extras].filter(route => !process.env.MIA_LAYOUT_ROUTE || process.env.MIA_LAYOUT_ROUTE.split(",").includes(route))) {
        const extended = extras.includes(route);
        await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
        const url = pathToFileURL(join(process.cwd(), extended ? ".claude/slim/layout-extra.html" : "tests/fixtures/study-layout-harness.html"));
        url.search = new URLSearchParams({ route, device, ...(width === 844 ? { safeLeft: "47", safeRight: "47" } : {}) });
        await call("Page.navigate", { url: url.href });
        const { result, exceptionDetails } = await call("Runtime.evaluate", {
          expression: `new Promise((resolve, reject) => { const check = () => { if (location.href === ${JSON.stringify(url.href)} && document.readyState === 'complete' && window.miaLayoutReport) requestAnimationFrame(() => requestAnimationFrame(async () => {
            try {
              const theme = ${JSON.stringify(theme)};
              if (theme) { document.body.classList.remove("theme-light", "theme-dark"); document.body.classList.add(theme); }
              if (${JSON.stringify(process.env.MIA_LAYOUT_NIGHT === "1")}) {
                document.body.classList.add("mia-night-local");
                const view = document.querySelector(".mia-view");
                if (view) view.dataset.night = "true";
              }
              const report = window.miaLayoutReport();
              const controls = [...document.querySelectorAll(
                ".mia-target-strip button, .mia-target-dates :is(button, summary), .mia-review-forecast summary, "
                + ".mia-keyword-radar button, .mia-keyword-toolbar select, .mia-target-date-form :is(button, input:not([type=checkbox]), .mia-target-subject), "
                + ".mia-target-delete-modal button, :is(.mia-target-date-modal, .mia-target-delete-modal) .modal-close-button"
              )].filter(el => el.getClientRects().length);
              report.targetAndRadarTouch = controls.map(el => ({ label: el.textContent?.trim(), width: el.offsetWidth, height: el.offsetHeight }));
              const bars = document.querySelector(".mia-forecast-bars");
              report.targetAndRadarOverflow = bars ? bars.scrollWidth > bars.clientWidth + 1 : false;
              if (theme) {
                report.theme = theme;
                const elements = ${extended ? '[...document.querySelectorAll(".view-content *")]' : '[document.querySelector(".mia-view"), ...document.querySelectorAll(".mia-view *")]'};
                report.computedStyles = await Promise.all(elements.map(async element => {
                  const styles = [null, "::before", "::after"].map(pseudo => {
                    const css = getComputedStyle(element, pseudo);
                    return [...css].sort().map(prop => [prop, css.getPropertyValue(prop)]);
                  });
                  const rect = element.getBoundingClientRect();
                  const geometry = [rect.x, rect.y, rect.width, rect.height, element.scrollWidth, element.scrollHeight, element.clientWidth, element.clientHeight];
                  const bytes = new TextEncoder().encode(JSON.stringify({ styles, geometry }));
                  const digest = await crypto.subtle.digest("SHA-256", bytes);
                  return { ...(${JSON.stringify(process.env.MIA_LAYOUT_DETAILS ?? "")} && element.matches(${JSON.stringify(process.env.MIA_LAYOUT_DETAILS || "*")}) ? { styles, geometry } : {}), tag: element.tagName, cls: element.getAttribute("class"), hash: [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, "0")).join("") };
                }));
              }
              resolve(report);
            } catch (error) { reject(error); }
          })); else setTimeout(check, 10); }; check(); })`,
          awaitPromise: true, returnByValue: true,
        });
        if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails));
        const report = { width, height, ...result.value, ...(extended ? { extended: true } : {}) };
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
  const featureIssues = results.flatMap(r => {
    if (!r.targetAndRadarTouch.length) return [];
    const undersized = r.targetAndRadarTouch.filter(tap => tap.height < 44 || tap.width < 44);
    const overflow = r.targetAndRadarOverflow || r.horizontalOverflow || r.paneHorizontalOverflow;
    return overflow || undersized.length ? [{ route: r.route, width: r.width, theme: r.theme, overflow, undersized }] : [];
  });
  if (featureIssues.length) throw new Error(`Target date or radar layout: ${JSON.stringify(featureIssues)}`);
  if (results.some(r => !r.extended && r.device !== "desktop" && r.width < 1600 && r.contentSafePaneRatio < .94)) throw new Error("Touch content narrower than 94% of safe pane");
  if (results.some(r => !r.extended && r.device !== "desktop" && r.route !== "study" && r.contentWidth > 1600)) throw new Error("Library cap exceeded");
  if (results.some(r => !r.extended && r.route === "questions" && r.panelVisible !== (r.device !== "phone" && r.width >= 1000))) throw new Error("Detail panel visibility regressed");
  if (results.some(r => !r.extended && (r.horizontalOverflow || r.paneHorizontalOverflow || r.overflowingElements.length))) throw new Error("Horizontal overflow detected");
} finally {
  socket?.close();
  chrome.kill();
  await exited;
  await rm(profile, { recursive: true, force: true });
}
