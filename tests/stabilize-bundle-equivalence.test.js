import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("obsidian", async () => {
  const { obsidianLayoutBoundary } = await import("./fixtures/study-layout-obsidian");
  return obsidianLayoutBoundary();
});
import { createLayoutDom } from "./fixtures/study-layout-render";
import { obsidianLayoutBoundary } from "./fixtures/study-layout-obsidian";
// This fixture was captured from the unmodified 1.4.26 production main.js.
const fixture = new URL("./fixtures/stabilize-bundle-scenarios.json", import.meta.url);
let dom;
afterEach(() => { dom?.window.close(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("preserves production CJS study, resume, merge and load/save bytes against 1.4.26", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-17T00:00:00Z"));
  vi.spyOn(Math, "random").mockReturnValue(.999999);
  dom = createLayoutDom(); vi.stubGlobal("document", dom.window.document); vi.stubGlobal("window", dom.window);
  const local = new Map(), files = new Map(), views = new Map(), commands = [], imports = [], notices = [];
  let disk = null, serial = 0;
  class Plugin {
    constructor(app, manifest) { this.app = app; this.manifest = manifest; }
    loadData = async () => disk === null ? null : JSON.parse(disk);
    saveData = async data => { disk = JSON.stringify(data, null, 2); };
    register() {} registerView(type, create) { views.set(type, create); }
    addRibbonIcon() {} addCommand(command) { commands.push(command.id); } addSettingTab() {}
  }
  const boundary = { ...obsidianLayoutBoundary(), Plugin, PluginSettingTab: class {}, TFile: class {}, TFolder: class {}, MarkdownView: class {},
    Notice: class { constructor(message) { notices.push(message); } }, normalizePath: path => path,
    Platform: { isMobile: true, isDesktopApp: false } };
  const module = { exports: {} };
  const context = { module, exports: module.exports, require(name) { imports.push(name); if (name !== "obsidian") throw Error(`Unavailable mobile module: ${name}`); return boundary; },
    console, Date, Math, performance, crypto: { ...webcrypto, randomUUID: () => `fixed-${++serial}` }, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Blob, URL, structuredClone,
    document, setTimeout, clearTimeout, setInterval, clearInterval, navigator: { userAgent: "iPhone" } };
  context.window = context; context.self = context;
  vm.runInNewContext(readFileSync(process.env.MIA_STABILIZE_BUNDLE ?? new URL("../main.js", import.meta.url), "utf8"), context, { timeout: 5000 });
  const adapter = { exists: async path => files.has(path), read: async path => path.endsWith("/data.json") ? disk : files.get(path), write: async (path, text) => { files.set(path, text); } };
  const app = { loadLocalStorage: key => local.get(key), saveLocalStorage: (key, value) => local.set(key, structuredClone(value)),
    vault: { getName: () => "Synthetic", configDir: ".obsidian", adapter }, workspace: { onLayoutReady() {}, requestSaveLayout() {} } };
  const plugin = new module.exports.default(app, { version: "1.4.26", id: "mia-study" });
  await plugin.onload();
  // Normalize legacy/default data through the actual load -> settings-save path.
  await plugin.store.updateSettings({}); const loaded = disk;
  const question = id => ({ id, heading: `질문 ${id}`, questionMarkdown: `질문 ${id}`, answerMarkdown: "정답", subject: "가상과목", questionType: "정의형", filePath: "bank.md", location: { headingLine: 0 }, coreKeywords: [], subKeywords: [], followUpIds: [] });
  const questions = [question("mia-q-one"), question("mia-q-two")];
  plugin.index = { registered: questions, diagnostics: [], candidates: [], isReady: true, stop() {}, questionById: id => questions.find(q => q.id === id) };
  const leaf = { app, setViewState: async ({ state }) => view.setState(state, {}) };
  const view = views.get("mia-study-view")(leaf); document.body.append(view.contentEl);
  // No onOpen: only host event registration is omitted; the real render/session/store run.
  view.startReview(questions.map(q => q.id));
  const recallBefore = view.getState();
  view.contentEl.querySelector(".mia-reveal").click();
  vi.advanceTimersByTime(1250);
  view.contentEl.querySelector('[data-grade="3"]').click();
  for (let i = 0; i < 100; i++) await Promise.resolve();
  expect(plugin.store.getReview("mia-q-one")?.history).toHaveLength(1);
  const rated = disk;
  const ratedReview = JSON.stringify(plugin.store.getReview("mia-q-one"));
  const result = view.studyResult();
  await view.undoLastRating();
  for (let i = 0; i < 100; i++) await Promise.resolve();
  const undone = disk;
  expect(plugin.store.getReview("mia-q-one")).toBeUndefined();
  view.startReview(questions.map(q => q.id), "browse");
  const browse = view.getState();
  expect(view.contentEl.querySelector(".mia-ratings")).toBeNull();
  view.moveToQuestion(1);
  for (let i = 0; i < 100; i++) await Promise.resolve();
  const resumeBytes = files.get(".obsidian/plugins/mia-study/ui-state.json");
  await view.resumeStudy();
  const resumed = view.getState();
  // Incoming external review must merge with the current durable tombstone.
  const incoming = JSON.parse(disk);
  incoming.reviews["mia-q-two"] = plugin.fsrs.rate(undefined, 4, new Date(), "mia-q-two", 4321);
  incoming.reviewVersions["mia-q-two"] = "2026-11-17T00:00:00.000Z:remote";
  disk = JSON.stringify(incoming, null, 2); await plugin.store.synchronize();
  const merged = disk;
  await plugin.store.load(); await plugin.store.updateSettings({});
  const roundtrip = disk;
  expect(roundtrip).toBe(merged);
  await view.onClose(); plugin.onunload();
  const actual = JSON.parse(JSON.stringify({ commands, viewTypes: [...views.keys()], loaded, recallBefore, rated, ratedReview, result, undone, browse, resumeBytes, resumed, merged, roundtrip, notices }));
  expect(actual).toEqual(JSON.parse(readFileSync(fixture, "utf8")));
  expect(imports.every(name => name === "obsidian")).toBe(true);
});
