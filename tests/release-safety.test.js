import { afterEach, describe, expect, it, vi } from "vitest";
import { Rating } from "ts-fsrs";

const ui = vi.hoisted(() => ({ detail: null, notices: [] }));
vi.mock("obsidian", () => ({
  Plugin: class {}, Modal: class {}, ItemView: class {}, PluginSettingTab: class {},
  MarkdownView: class {}, Notice: class { constructor(message) { ui.notices.push(message); } },
  TFile: class {}, TFolder: class {}, Component: class {}, Setting: class {},
  Platform: { isMobile: true }, normalizePath: path => path,
}));
vi.mock("../src/ui/question-detail-modal", () => ({
  QuestionDetailModal: class {
    constructor(_app, _question, review, _recommendations, _meanings, actions) { ui.detail = { review, actions }; }
    open() {}
  },
}));

import MiaStudyPlugin from "../src/main";
import { MiaDataStore } from "../src/services/data-store";
import { FsrsService } from "../src/core/fsrs-service";
import { DEFAULT_PLUGIN_DATA } from "../src/core/models";
import { validateSubjectName } from "../src/core/managed-question";
import { validateKeywordName } from "../src/core/keyword-note";
import { keywordNotePath } from "../src/core/keyword-path";
import { TFile, TFolder } from "obsidian";

const fsrs = new FsrsService({ targetRetention: .9, maximumIntervalDays: 36500 });
const at = new Date("2026-10-20T00:00:00Z");
const first = () => fsrs.rate(undefined, Rating.Good, at, "q");
function environment() {
  let disk = structuredClone(DEFAULT_PLUGIN_DATA);
  const device = recovery => {
    const plugin = { loadData: vi.fn(async () => structuredClone(disk)), saveData: vi.fn(async value => { disk = structuredClone(value); }) };
    return { store: new MiaDataStore(plugin, recovery), plugin };
  };
  return { device, read: () => structuredClone(disk), overwrite: value => { disk = structuredClone(value); } };
}
afterEach(() => { vi.useRealTimers(); ui.detail = null; ui.notices.length = 0; });

describe("detail review conflict protection", () => {
  it.each(["rate", "reset"])("rejects stale %s after a different device saved, even if the local store was synchronized", async action => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-20T00:20:00Z"));
    const env = environment(), phone = env.device(), tablet = env.device();
    await phone.store.load(); await phone.store.setReview("q", first()); await tablet.store.load();
    const question = { id: "q", heading: "문제", questionMarkdown: "문제", answerMarkdown: "정답", subject: "수학", questionType: "정의형", filePath: "MIA/수학/문제은행.md", coreKeywords: [], subKeywords: [], followUpIds: [] };
    const plugin = new MiaStudyPlugin();
    plugin.app = {}; plugin.store = tablet.store; plugin.fsrs = fsrs;
    plugin.index = { questionById: () => question, registered: [question] };
    await plugin.openQuestionDetail(question);
    const baseline = structuredClone(ui.detail.review);
    const newer = fsrs.rate(baseline, Rating.Hard, new Date("2026-10-20T00:10:00Z"), "q");
    await phone.store.setReview("q", newer); await tablet.store.synchronize();
    const writes = tablet.plugin.saveData.mock.calls.length;
    const work = action === "rate" ? ui.detail.actions.rate(Rating.Easy) : ui.detail.actions.resetReview();
    await expect(work).rejects.toThrow("다른 기기");
    expect(env.read().reviews.q).toEqual(newer);
    expect(tablet.plugin.saveData).toHaveBeenCalledTimes(writes);
  });
  it("rejects a newly delivered review when a direct rating reaches the write queue", async () => {
    const env = environment(), device = env.device(); await device.store.load();
    const plugin = new MiaStudyPlugin(); plugin.store = device.store; plugin.fsrs = fsrs;
    const latest = first(), disk = env.read(); disk.reviews.q = latest;
    disk.reviewVersions.q = "2026-10-20T00:00:00.000Z:remote"; env.overwrite(disk);
    await expect(plugin.rateQuestionDirectly("q", Rating.Easy, undefined)).rejects.toThrow("다른 기기");
    expect(env.read().reviews.q).toEqual(latest);
    expect(device.plugin.saveData).not.toHaveBeenCalled();
  });
});

describe("recovery storage failure boundaries", () => {
  it("starts from valid disk data and preserves quarantine when recovery reading fails", async () => {
    const env = environment(), disk = env.read(); disk.reviews.q = first();
    disk.quarantinedReviews.bad = { card: "corrupt" }; env.overwrite(disk);
    const { store, plugin } = env.device({ read: () => { throw Error("unavailable"); }, write() {} });
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.getReview("q")).toEqual(disk.reviews.q);
    expect(store.loadWarnings.join(" ")).toMatch(/복구/);
    expect(plugin.saveData).not.toHaveBeenCalled();
    await store.updateSettings({ targetRetention: .85 });
    expect(env.read().quarantinedReviews.bad).toEqual(disk.quarantinedReviews.bad);
  });
  it.each(["review", "reset", "settings", "synchronize"])("commits %s and notifies subscribers when only recovery writing fails", async action => {
    const env = environment(); let fail = false;
    const onWarning = vi.fn(), cache = { read: () => null, write: vi.fn(() => { if (fail) throw Error("quota"); }), onWarning };
    const { store } = env.device(cache); await store.load(); await store.setReview("q", first());
    const notify = vi.fn(); store.subscribe(notify); fail = true;
    let expected;
    if (action === "review") { expected = fsrs.rate(first(), Rating.Hard, new Date("2026-10-20T00:10:00Z"), "q"); await expect(store.setReview("q", expected)).resolves.toBeUndefined(); }
    if (action === "reset") await expect(store.removeReview("q")).resolves.toBeUndefined();
    if (action === "settings") await expect(store.updateSettings({ targetRetention: .85 })).resolves.toBeUndefined();
    if (action === "synchronize") { const disk = env.read(); disk.settings.targetRetention = .85; env.overwrite(disk); await expect(store.synchronize()).resolves.toBeUndefined(); }
    expect(onWarning).toHaveBeenCalledOnce(); expect(onWarning.mock.calls[0][0]).toMatch(/복구/);
    expect(notify).toHaveBeenCalledOnce();
    expect(store.getReview("q")).toEqual(env.read().reviews.q);
    expect(store.settings).toEqual(env.read().settings);
    if (action === "review") expect(env.read().reviews.q).toEqual(expected);
    if (action === "reset") expect(env.read().reviews.q).toBeUndefined();
  });
  it("warns once per failure episode and retries the recovery copy on the next commit", async () => {
    const env = environment(); let fail = true, recovery;
    const onWarning = vi.fn();
    const { store } = env.device({ read: () => null, write: data => { if (fail) throw Error("quota"); recovery = structuredClone(data); }, onWarning });
    await store.load(); await store.setReview("q", first()); await store.updateSettings({ targetRetention: .85 });
    expect(onWarning).toHaveBeenCalledOnce();
    fail = false; await store.updateSettings({ targetRetention: .8 }); expect(recovery).toEqual(env.read());
    fail = true; await store.updateSettings({ targetRetention: .9 }); expect(onWarning).toHaveBeenCalledTimes(2);
  });
  it("does not write a recovery copy or emit success when the primary write fails", async () => {
    const env = environment(), write = vi.fn(), onWarning = vi.fn();
    const { store, plugin } = env.device({ read: () => null, write, onWarning });
    await store.load(); const notify = vi.fn(); store.subscribe(notify);
    plugin.saveData.mockRejectedValueOnce(Error("disk full"));
    await expect(store.setReview("q", first())).rejects.toThrow("disk full");
    expect(store.getReview("q")).toBeUndefined(); expect(env.read().reviews.q).toBeUndefined();
    expect(write).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled(); expect(onWarning).not.toHaveBeenCalled();
    await store.setReview("q", first()); expect(notify).toHaveBeenCalledOnce();
  });
});

describe("portable subject and keyword writes", () => {
  function vaultEnvironment() {
    const root = Object.assign(new TFolder(), { path: "", name: "", children: [] });
    const files = new Map([["", root]]), contents = new Map();
    const add = (path, file) => {
      const parts = path.split("/"); const name = parts.pop(); const parent = files.get(parts.join("/"));
      Object.assign(file, { path, name, ...(file instanceof TFolder ? { children: [] } : {}) });
      parent.children.push(file); files.set(path, file); return file;
    };
    const vault = {
      getRoot: () => root, getAbstractFileByPath: path => files.get(path),
      createFolder: vi.fn(async path => add(path, new TFolder())),
      create: vi.fn(async (path, content) => { contents.set(path, content); return add(path, new TFile()); }),
      process: vi.fn(async (file, update) => { contents.set(file.path, update(contents.get(file.path))); }),
    };
    const plugin = new MiaStudyPlugin(); plugin.app = { vault };
    plugin.store = { settings: { sourceRoots: ["MIA"], keywordFolder: "MIA/키워드" } };
    return { plugin, vault, contents, files };
  }
  it("creates a normal subject with its bank and generated note", async () => {
    const env = vaultEnvironment(); await env.plugin.createSubject("공학수학");
    expect(env.contents.get("MIA/공학수학/문제은행.md")).toContain("공학수학");
    expect(env.contents.get("MIA/공학수학/공학수학 노트.md")).toContain("mia-study-subject-note");
    expect(env.vault.create).toHaveBeenCalledTimes(2);
  });
  it("updates an exactly matching keyword without creating a second note", async () => {
    const env = vaultEnvironment(); await env.plugin.saveKeywordMeaning("가우스 법칙", "첫 의미");
    await env.plugin.saveKeywordMeaning("가우스 법칙", "수정된 의미");
    expect(env.contents.get("MIA/키워드/가우스 법칙.md")).toContain("수정된 의미");
    expect(env.vault.create).toHaveBeenCalledOnce(); expect(env.vault.process).toHaveBeenCalledOnce();
  });
  it("detects case collisions during keyword rename without merging or trashing either note", async () => {
    const env = vaultEnvironment(); await env.plugin.saveKeywordMeaning("Math", "수학");
    await env.plugin.saveKeywordMeaning("Other", "다른 의미");
    await expect(env.plugin.saveKeyword({name: "Other", target: "MIA/키워드/Other", filePath: "MIA/키워드/Other.md"}, "math", "새 의미")).rejects.toThrow(/표기/);
    expect(env.contents.get("MIA/키워드/Math.md")).toContain("수학");
    expect(env.contents.get("MIA/키워드/Other.md")).toContain("다른 의미");
    expect(env.vault.process).not.toHaveBeenCalled();
  });
  it.each(["CON", "con.txt", "PRN", "aux", "NUL", "COM1", "COM¹", "LPT9", "LPT³", "수학."])("rejects unsafe Windows name %s", name => {
    expect(() => validateSubjectName(name)).toThrow(); expect(() => validateKeywordName(name)).toThrow();
  });
  it.each(["공학수학", "CONCEPT", "COM10", "C언어", "논리 회로", "수학.기초"])("preserves valid name %s", name => {
    expect(validateSubjectName(name)).toBe(name); expect(validateKeywordName(name)).toBe(name);
  });
  it.each(["MIA/CON/개념", "MIA/키워드/NUL.md", "MIA/수학./개념", "MIA/개념?"])("rejects invalid explicit keyword path %s", path => {
    expect(() => keywordNotePath(path, "개념", "MIA/키워드")).toThrow();
  });
  it.each([["Math", "math"], ["가".normalize("NFD"), "가"]])("blocks colliding subject spelling %s before creating a folder", async (existingName, requested) => {
    const root = Object.assign(new TFolder(), { path: "MIA", name: "MIA", children: [] });
    root.children.push(Object.assign(new TFolder(), { path: `MIA/${existingName}`, name: existingName, children: [] }));
    const vaultRoot = Object.assign(new TFolder(), { path: "", children: [root] });
    const plugin = new MiaStudyPlugin(); plugin.store = { settings: { sourceRoots: ["MIA"], keywordFolder: "MIA/키워드" } };
    const createFolder = vi.fn(), create = vi.fn();
    plugin.app = { vault: { getRoot: () => vaultRoot, getAbstractFileByPath: path => path === "MIA" ? root : null, createFolder, create } };
    await expect(plugin.createSubject(requested)).rejects.toThrow(/표기|이름/);
    expect(createFolder).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });
  it("rejects an explicit keyword path spelling collision before modifying an existing note", async () => {
    const root = Object.assign(new TFolder(), { path: "MIA", name: "MIA", children: [] });
    const keywords = Object.assign(new TFolder(), { path: "MIA/키워드", name: "키워드", children: [] }); root.children.push(keywords);
    const file = Object.assign(new TFile(), { path: "MIA/키워드/Math.md", name: "Math.md" }); keywords.children.push(file);
    const vaultRoot = Object.assign(new TFolder(), { path: "", children: [root] });
    const files = new Map([[root.path, root], [keywords.path, keywords], [file.path, file]]);
    const process = vi.fn(), create = vi.fn();
    const plugin = new MiaStudyPlugin(); plugin.store = { settings: { keywordFolder: "MIA/키워드" } };
    plugin.app = { vault: { getRoot: () => vaultRoot, getAbstractFileByPath: path => files.get(path), process, create } };
    await expect(plugin.saveKeywordReferenceMeaning("MIA/키워드/math", "math", "의미")).rejects.toThrow(/표기|이름/);
    expect(process).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });
});
