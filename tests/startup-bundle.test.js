import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

function mobilePlugin(loadError) {
  const imports = [], views = [], commands = [], local = new Map();
  class Plugin {
    constructor(app, manifest) { this.app = app; this.manifest = manifest; }
    async loadData() { if (loadError) throw loadError; return {}; }
    register() {} registerView(type) { views.push(type); }
    addRibbonIcon() {} addCommand(command) { commands.push(command.id); } addSettingTab() {}
  }
  const boundary = { Plugin, ItemView: class {}, Modal: class {}, PluginSettingTab: class {}, Component: class {},
    Notice: class {}, TFile: class {}, TFolder: class {}, Platform: { isMobile: true, isDesktopApp: false }, normalizePath: (path) => path };
  const module = { exports: {} };
  const context = {
    module, exports: module.exports,
    require(name) { imports.push(name); if (name !== "obsidian") throw Error(`Unavailable mobile module: ${name}`); return boundary; },
    console, performance, crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Blob, URL, structuredClone,
    setTimeout, clearTimeout, setInterval, clearInterval,
    navigator: { userAgent: "iPhone" },
  };
  // Browser globals alias one object; library browser polyfills install on self.
  context.window = context; context.self = context;
  vm.runInNewContext(readFileSync(new URL("../main.js", import.meta.url), "utf8"), context, { timeout: 5000 });
  const app = { loadLocalStorage: (key) => local.get(key), saveLocalStorage: (key, value) => local.set(key, value),
    vault: { getName: () => "Test", configDir: ".obsidian", adapter: { exists: async () => false } },
    workspace: { onLayoutReady() {} } };
  return { plugin: new module.exports.default(app, { version: "test", id: "mia-study" }), imports, views, commands, local };
}

describe("production mobile startup bundle", () => {
  it("preserves the own-code MIT license in the three-file installation", () => {
    const license = readFileSync(new URL("../LICENSE", import.meta.url), "utf8").trimEnd();
    const bundle = readFileSync(new URL("../main.js", import.meta.url), "utf8");
    expect(license).toContain("MIT License");
    expect(license).toContain("Copyright (c) 2026 kimchi-kang");
    expect(bundle).toContain(`/*! MIA Study own code\n${license}\n`);
    expect(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).license).toBe("MIT");
  });
  it("ships the complete third-party notice text inside the installable bundle", () => {
    const notices = readFileSync(new URL("../THIRD-PARTY-NOTICES.txt", import.meta.url), "utf8").trimEnd();
    const bundle = readFileSync(new URL("../main.js", import.meta.url), "utf8");
    expect(bundle.startsWith(`/*! MIA third-party notices\n${notices}\n*/\n`)).toBe(true);
    for (const notice of ["docx 9.12.0", "sax 1.2.4", "readable-stream 3.6.2", "pako 1.0.11 — zlib source notices", "String.fromCodePoint 0.1.0", "BSD-3-Clause", "Copyright Fedor Indutny, 2014."]) {
      expect(notices).toContain(notice);
    }
  });
  it("loads and registers MIA on mobile without Buffer, Node or Electron modules", async () => {
    const run = mobilePlugin(); await run.plugin.onload();
    expect(run.imports.every((name) => name === "obsidian")).toBe(true);
    expect(run.views).toContain("mia-study-view");
    expect(run.commands).toContain("show-startup-status");
    expect(run.local.get("mia-study:startup-diagnostics:v1").at(-1).phase).toBe("loaded");
    run.plugin.onunload();
  });
  it("records startup failure without note contents and can unload before the index exists", async () => {
    const run = mobilePlugin(new Error("private-note-content"));
    await expect(run.plugin.onload()).rejects.toThrow("private-note-content");
    expect(run.local.get("mia-study:startup-diagnostics:v1").at(-1).phase).toBe("failed");
    expect(JSON.stringify([...run.local])).not.toContain("private-note-content");
    expect(() => run.plugin.onunload()).not.toThrow();
  });
});


describe("production mobile API boundaries without desktop modules", () => {
  it("persists a grade and reset and rejects reserved keys without changing disk", async () => {
    const run = mobilePlugin(); let disk = "{}";
    run.plugin.loadData = async () => JSON.parse(disk);
    run.plugin.saveData = async data => { disk = JSON.stringify(data, null, 2); };
    run.plugin.app.vault.adapter.read = async () => disk;
    await run.plugin.onload();
    await run.plugin.rateQuestionDirectly("mia-q-mobile-api", 3, undefined);
    const review = run.plugin.store.getReview("mia-q-mobile-api");
    expect(review.history).toHaveLength(1);
    expect(JSON.parse(disk).reviews["mia-q-mobile-api"]).toEqual(review);
    const before = disk;
    await expect(run.plugin.store.setReview("__proto__", review)).rejects.toThrow(/키/);
    await expect(run.plugin.store.removeReviews(["mia-q-mobile-api", "constructor"])).rejects.toThrow(/키/);
    expect(disk).toBe(before);
    await run.plugin.store.removeReview("mia-q-mobile-api", {state: review});
    expect(run.plugin.store.getReview("mia-q-mobile-api")).toBeUndefined();
    expect(JSON.parse(disk).reviewVersions["mia-q-mobile-api"]).toBeTruthy();
    expect(run.imports.every(name => name === "obsidian")).toBe(true);
    run.plugin.onunload();
  });
  it("exports Word tables into the mobile vault with Node and Electron unavailable", async () => {
    const run = mobilePlugin(), files = new Map();
    run.plugin.app.vault.getRoot = () => ({children: []});
    run.plugin.app.vault.getAbstractFileByPath = path => files.get(path);
    run.plugin.app.vault.createFolder = async path => { files.set(path, {path}); };
    run.plugin.app.vault.createBinary = async (path, data) => { files.set(path, new Uint8Array(data)); };
    await run.plugin.onload();
    run.plugin.index = {rebuild: async () => {}, stop() {}, registered: [{
      subject: "가상출력", filePath: "MIA/가상출력/a.md", location: {headingLine: 1},
      questionMarkdown: "MOBILE_PROMPT_END", answerMarkdown: "MOBILE_ANSWER_END\n\n| 머리 | 값 |\n| --- | --- |\n| 보존 | 7 |",
    }]};
    const result = await run.plugin.exportSubject("가상출력");
    expect(result.path.startsWith("MIA 출력/")).toBe(true); expect(result.count).toBe(1);
    const zip = await JSZip.loadAsync(files.get(result.path), {checkCRC32: true});
    const xml = await zip.file("word/document.xml").async("string");
    for (const marker of ["MOBILE_PROMPT_END", "MOBILE_ANSWER_END", "보존", "<w:tbl>"]) expect(xml).toContain(marker);
    expect(result.warnings).toEqual([]);
    expect(result.openFile).toBeUndefined(); expect(result.revealFile).toBeUndefined();
    // JSZip probes an optional stream feature and handles its unavailable-module error.
    expect(run.imports.filter(name => name !== "obsidian")).toEqual(["stream"]);
    run.plugin.onunload();
  });
});
