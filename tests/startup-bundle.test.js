import { readFileSync } from "node:fs";
import vm from "node:vm";
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
    Notice: class {}, Platform: { isMobile: true, isDesktopApp: false }, normalizePath: (path) => path };
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(new URL("../main.js", import.meta.url), "utf8"), {
    module, exports: module.exports,
    require(name) { imports.push(name); if (name !== "obsidian") throw Error(`Unavailable mobile module: ${name}`); return boundary; },
    console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Blob, URL, structuredClone,
    setTimeout, clearTimeout, setInterval, clearInterval,
    navigator: { userAgent: "iPhone" }, window: {}, self: {},
  }, { timeout: 5000 });
  const app = { loadLocalStorage: (key) => local.get(key), saveLocalStorage: (key, value) => local.set(key, value),
    vault: { getName: () => "Test", configDir: ".obsidian", adapter: { exists: async () => false } },
    workspace: { onLayoutReady() {} } };
  return { plugin: new module.exports.default(app, { version: "test", id: "mia-study" }), imports, views, commands, local };
}

describe("production mobile startup bundle", () => {
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
