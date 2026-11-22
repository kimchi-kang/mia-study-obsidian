import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import postcss from "postcss";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", async () => {
  const { obsidianLayoutBoundary } = await import("./fixtures/study-layout-obsidian");
  return obsidianLayoutBoundary();
});
import { createLayoutDom } from "./fixtures/study-layout-render";
import { obsidianLayoutBoundary } from "./fixtures/study-layout-obsidian";
import { parseNightPreference, StudyUiStore } from "../src/services/study-ui-store";
import { NIGHT_GLOBAL_CLASS, NightModeController } from "../src/ui/night-mode";

let dom;
afterEach(() => { dom?.window.close(); dom = undefined; vi.unstubAllGlobals(); });

describe("야간 모드 저장값", () => {
  it.each([
    [undefined, { nightMode: false, nightScope: "app" }],
    [null, { nightMode: false, nightScope: "app" }],
    [{ nightMode: true }, { nightMode: true, nightScope: "app" }],
    [{ nightMode: true, nightScope: "plugin" }, { nightMode: true, nightScope: "plugin" }],
    [{ nightMode: "yes", nightScope: "screen" }, { nightMode: false, nightScope: "app" }],
    ["망가진 값", { nightMode: false, nightScope: "app" }],
  ])("%j → %j", (raw, expected) => expect(parseNightPreference(raw)).toEqual(expected));

  it("기기별 키에 추가로 저장하고 보기 설정 저장값은 건드리지 않는다", () => {
    const local = new Map();
    const app = { loadLocalStorage: key => local.get(key), saveLocalStorage: (key, value) => local.set(key, structuredClone(value)), vault: { adapter: {} } };
    const store = new StudyUiStore(app, "ui.json");
    expect(store.night).toEqual({ nightMode: false, nightScope: "app" });
    expect(store.updateNight({ nightMode: true })).toEqual({ nightMode: true, nightScope: "app" });
    store.updateNight({ nightScope: "plugin" });
    expect(local.get("mia-study:night:ui.json")).toEqual({ nightMode: true, nightScope: "plugin" });
    expect([...local.keys()]).toEqual(["mia-study:night:ui.json"]);
  });
});

describe("body 클래스", () => {
  it.each([
    [{ nightMode: true, nightScope: "app" }, true],
    [{ nightMode: true, nightScope: "plugin" }, false],
    [{ nightMode: false, nightScope: "app" }, false],
  ])("%j이면 전체 적용 %s", (preference, expected) => {
    dom = createLayoutDom();
    const body = dom.window.document.body;
    const controller = new NightModeController(body, () => preference);
    controller.apply();
    expect(body.classList.contains(NIGHT_GLOBAL_CLASS)).toBe(expected);
    controller.destroy();
    expect(body.classList.contains(NIGHT_GLOBAL_CLASS)).toBe(false);
  });

  it("Obsidian 테마 클래스는 바꾸지 않는다", () => {
    dom = createLayoutDom();
    const body = dom.window.document.body;
    body.classList.add("theme-light");
    const controller = new NightModeController(body, () => ({ nightMode: true, nightScope: "app" }));
    controller.apply(); controller.destroy();
    expect([...body.classList]).toEqual(["theme-light"]);
  });
});

async function loadBundle(initialNight, { failNightSave = false } = {}) {
  dom = createLayoutDom(); vi.stubGlobal("document", dom.window.document); vi.stubGlobal("window", dom.window);
  const local = new Map(), files = new Map(), views = new Map(), commands = new Map(), notices = [], windowEvents = new Map();
  let disk = null;
  class Plugin {
    constructor(app, manifest) { this.app = app; this.manifest = manifest; }
    loadData = async () => disk === null ? null : JSON.parse(disk);
    saveData = async data => { disk = JSON.stringify(data, null, 2); };
    register() {} registerEvent() {} registerView(type, create) { views.set(type, create); }
    addRibbonIcon() {} addCommand(command) { commands.set(command.id, command); } addSettingTab() {}
  }
  const boundary = { ...obsidianLayoutBoundary(), Plugin, PluginSettingTab: class {}, TFile: class {}, TFolder: class {}, MarkdownView: class {},
    Notice: class { constructor(message) { notices.push(message); } }, normalizePath: path => path, Platform: { isMobile: true, isDesktopApp: false } };
  const module = { exports: {} };
  const context = { module, exports: module.exports, require: () => boundary,
    console, Date, Math, performance, crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Blob, URL, structuredClone,
    document, setTimeout, clearTimeout, setInterval, clearInterval, navigator: { userAgent: "iPhone" } };
  context.window = context; context.self = context;
  vm.runInNewContext(readFileSync(new URL("../main.js", import.meta.url), "utf8"), context, { timeout: 5000 });
  const leaves = [];
  const adapter = { exists: async path => files.has(path), read: async path => path.endsWith("/data.json") ? disk : files.get(path), write: async (path, text) => { files.set(path, text); } };
  const app = { loadLocalStorage: key => local.get(key),
    saveLocalStorage: (key, value) => { if (failNightSave && key.startsWith("mia-study:night:")) throw new Error("QuotaExceededError"); local.set(key, structuredClone(value)); },
    vault: { getName: () => "Synthetic", configDir: ".obsidian", adapter },
    workspace: { onLayoutReady() {}, requestSaveLayout() {}, getLeavesOfType: () => leaves, on: (name, callback) => { windowEvents.set(name, callback); return { name }; } } };
  if (initialNight) local.set("mia-study:night:.obsidian/plugins/mia-study/ui-state.json", initialNight);
  const plugin = new module.exports.default(app, { version: "1.5.7", id: "mia-study" });
  await plugin.onload();
  return { plugin, app, views, commands, leaves, local, notices, windowEvents, body: dom.window.document.body };
}

describe("플러그인 수명과 명령", () => {
  it("저장된 전체 야간 모드는 화면을 열지 않아도 로드 때 붙고 언로드 때 떨어진다", async () => {
    const { plugin, body } = await loadBundle({ nightMode: true, nightScope: "app" });
    expect(body.classList.contains("mia-night-global")).toBe(true);
    plugin.onunload();
    expect(body.classList.contains("mia-night-global")).toBe(false);
  });

  it("범위가 MIA 화면뿐이면 body에 붙지 않는다", async () => {
    const { plugin, body } = await loadBundle({ nightMode: true, nightScope: "plugin" });
    expect(body.classList.contains("mia-night-global")).toBe(false);
    plugin.onunload();
  });

  it("명령과 첫 화면 버튼이 같은 상태를 쓰고, 열린 화면의 표시를 바로 바꾼다", async () => {
    const { plugin, views, commands, leaves, local, body } = await loadBundle();
    plugin.index = { registered: [], diagnostics: [], candidates: [], isReady: true, stop() {}, questionById: () => undefined };
    const leaf = { app: plugin.app, setViewState: async ({ state }) => view.setState(state, {}) };
    const view = views.get("mia-study-view")(leaf); leaf.view = view; leaves.push(leaf);
    body.append(view.contentEl);
    view.navigate("dashboard");
    const button = () => view.contentEl.querySelector(".mia-night-button");
    expect(button()?.textContent).toBe("야간");
    expect(button()?.getAttribute("aria-pressed")).toBe("false");
    expect(view.contentEl.dataset.night).toBe("false");

    commands.get("toggle-night-mode").callback();
    expect(body.classList.contains("mia-night-global")).toBe(true);
    expect(button()?.getAttribute("aria-pressed")).toBe("true");
    expect(view.contentEl.dataset.night).toBe("true");
    expect(local.get("mia-study:night:.obsidian/plugins/mia-study/ui-state.json")).toEqual({ nightMode: true, nightScope: "app" });

    button().click();
    expect(body.classList.contains("mia-night-global")).toBe(false);
    expect(button()?.getAttribute("aria-pressed")).toBe("false");
    expect(view.contentEl.dataset.night).toBe("false");
    expect(commands.get("toggle-night-mode").name).toBe("적색 야간 모드 전환");
    plugin.onunload();
  });
});

describe("1.6.3 야간 보완", () => {
  it("범위가 MIA 화면뿐이면 body에 창 전용 클래스를 붙여 MIA 창에도 적용한다", async () => {
    const { plugin, body } = await loadBundle({ nightMode: true, nightScope: "plugin" });
    expect(body.classList.contains("mia-night-local")).toBe(true);
    expect(body.classList.contains("mia-night-global")).toBe(false);
    plugin.onunload();
    expect(body.classList.contains("mia-night-local")).toBe(false);
  });

  it("기기 저장소에 쓰지 못하면 예외 없이 안내하고 상태를 바꾸지 않는다", async () => {
    const { plugin, commands, notices, body } = await loadBundle(undefined, { failNightSave: true });
    expect(() => commands.get("toggle-night-mode").callback()).not.toThrow();
    expect(notices.some(message => message.includes("야간 모드 설정 저장 실패"))).toBe(true);
    expect(body.classList.contains("mia-night-global")).toBe(false);
    plugin.onunload();
  });

  it("기기 저장소를 읽지 못해도 기본값으로 시작한다", () => {
    const app = { loadLocalStorage: key => { if (key.startsWith("mia-study:night:")) throw new Error("SecurityError"); return null; }, saveLocalStorage() {}, vault: { adapter: {} } };
    expect(new StudyUiStore(app, "ui.json").night).toEqual({ nightMode: false, nightScope: "app" });
  });

  it("데스크톱 별도 창에도 같은 상태를 붙이고 닫히면 뗀다", async () => {
    const { plugin, windowEvents } = await loadBundle({ nightMode: true, nightScope: "app" });
    const popout = createLayoutDom().window.document.body;
    windowEvents.get("window-open")({ doc: { body: popout } });
    expect(popout.classList.contains("mia-night-global")).toBe(true);
    plugin.updateNightMode({ nightMode: false });
    expect(popout.classList.contains("mia-night-global")).toBe(false);
    plugin.updateNightMode({ nightMode: true });
    windowEvents.get("window-close")({ doc: { body: popout } });
    expect(popout.classList.contains("mia-night-global")).toBe(false);
    plugin.onunload();
  });
});

describe("CSS 계약", () => {
  const root = postcss.parse(readFileSync(new URL("../styles.css", import.meta.url), "utf8"));
  const decls = selector => {
    const values = {};
    root.walkRules(rule => { if (rule.selectors.includes(selector)) rule.walkDecls(d => { values[d.prop] = d.value; }); });
    return values;
  };
  it.each(["body.mia-night-global::before", "body.mia-night-global::after"])("%s 덮개는 화면에 고정되고 터치를 막지 않는다", selector => {
    const values = decls(selector);
    expect(values.position).toBe("fixed");
    expect(values["pointer-events"]).toBe("none");
    expect(values.inset).toBe("0");
    expect(values.transition).toBe("none");
  });
  it("위 덮개는 곱하기로 빨강만 남기고 아래 덮개는 흑백으로 바꾼다", () => {
    expect(decls("body.mia-night-global::after")).toMatchObject({ background: "#ff0000", "mix-blend-mode": "multiply" });
    expect(decls("body.mia-night-global::before")).toMatchObject({ "backdrop-filter": "grayscale(1)" });
  });
  it("MIA 화면만 적용할 때 MIA 창 덮개도 고정되고 터치를 막지 않는다", () => {
    const modal = 'body.mia-night-local .modal-container:has(.modal[class*="mia-"], .mia-keyboard-settings)';
    expect(decls(`${modal}::after`)).toMatchObject({ position: "fixed", "pointer-events": "none", "mix-blend-mode": "multiply", background: "#ff0000" });
    expect(decls(`${modal}::before`)).toMatchObject({ position: "fixed", "pointer-events": "none", "backdrop-filter": "grayscale(1)" });
  });
  it("MIA 화면만 적용할 때 MIA 창 뒤 가림막은 밝은 빨강 대신 검정이다", () => {
    const modal = 'body.mia-night-local .modal-container:has(.modal[class*="mia-"], .mia-keyboard-settings)';
    expect(decls(`${modal} > .modal-bg`)).toMatchObject({ "background-color": "#000000" });
  });
  it.each(["--mia-again", "--mia-hard", "--mia-good", "--mia-easy"])("야간 평가 면 %s 위 흰 글자는 적색 덮개를 지나도 4.5:1 이상이다", token => {
    const hex = decls('.mia-view[data-night="true"]')[token];
    expect(hex).toMatch(/^#[0-9A-F]{6}$/i);
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
    // 흑백 필터 뒤 회색값이 곱하기 덮개를 지나 빨강 채널로만 남는다.
    const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const linear = gray <= 0.04045 ? gray / 12.92 : ((gray + 0.055) / 1.055) ** 2.4;
    expect((0.2126 + 0.05) / (0.2126 * linear + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
  it("야간 버튼은 켜짐일 때 파란 면으로 구분된다", () => {
    expect(decls('.mia-view .mia-settings-buttons > .mia-night-button[aria-pressed="true"]')).toMatchObject({ "background-color": "var(--mia-blue)", color: "var(--mia-on-color)" });
  });
  it("MIA 화면만 적용할 때 덮개도 터치를 막지 않는다", () => {
    const leaf = 'body:not(.mia-night-global) .workspace-leaf-content:has(.mia-view[data-night="true"])';
    expect(decls(`${leaf}::after`)).toMatchObject({ position: "absolute", "pointer-events": "none", "mix-blend-mode": "multiply" });
    expect(decls(`${leaf}::before`)).toMatchObject({ position: "absolute", "pointer-events": "none" });
  });
});
