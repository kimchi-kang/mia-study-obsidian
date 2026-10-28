import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const { JSDOM } = createRequire(import.meta.url)("jsdom");
import { Rating } from "ts-fsrs";

vi.mock("obsidian", () => ({
  Plugin: class {}, Modal: class {}, ItemView: class {}, PluginSettingTab: class {}, MarkdownView: class {},
  TFile: class {}, TFolder: class {}, Component: class {}, Platform: { isMobile: false }, normalizePath: path => path,
  Notice: class {},
  Setting: class {
    constructor(root) { this.settingEl = root.createDiv(); this.controlEl = this.settingEl.createDiv(); }
    setName(text) { this.settingEl.createEl("label", { text }); return this; } setDesc(text) { this.settingEl.createEl("p", { text }); return this; }
    addText(fn) { const inputEl = this.controlEl.createEl("input"); fn({ inputEl, setValue(v) { inputEl.value = v; return this; }, onChange(f) { inputEl.addEventListener("input", () => f(inputEl.value)); return this; } }); return this; }
    addTextArea(fn) { const inputEl = this.controlEl.createEl("textarea"); fn({ inputEl, setValue(v) { inputEl.value = v; return this; }, setPlaceholder() { return this; }, onChange(f) { inputEl.addEventListener("input", () => f(inputEl.value)); return this; } }); return this; }
    addDropdown(fn) { const selectEl = this.controlEl.createEl("select"); fn({ selectEl, addOption(value, text) { selectEl.createEl("option", { value, text }); return this; }, setValue(v) { selectEl.value = v; return this; }, onChange(f) { selectEl.addEventListener("change", () => f(selectEl.value)); return this; } }); return this; }
    addToggle(fn) { const input = this.controlEl.createEl("input"); input.type = "checkbox"; fn({ setValue(v) { input.checked = v; return this; }, onChange(f) { input.addEventListener("change", () => f(input.checked)); return this; } }); return this; }
  },
}));
import MiaStudyPlugin from "../src/main";
import { simpleStudyFixture } from "./fixtures/simple-study-flow";
import { renderStudyManagementSettings } from "../src/ui/study-management-settings";
import { DEFAULT_SETTINGS } from "../src/core/models";
import { WORKLOAD_PRESETS, studySettingsPatch, workloadPreset } from "../src/core/simple-study-settings";
import { MiaDataStore } from "../src/services/data-store";
import { FsrsService } from "../src/core/fsrs-service";
import { buildReviewQueue } from "../src/core/recommendation-engine";

async function setup(settings, seedReviews = {}) {
  const dom = new JSDOM("<main></main>");
  const proto = dom.window.HTMLElement.prototype;
  proto.createEl = function(tag, options = {}) { const e = this.ownerDocument.createElement(tag); if (options.text) e.textContent = options.text; if (options.cls) e.className = options.cls; if (options.value) e.value = options.value; for (const [k,v] of Object.entries(options.attr ?? {})) e.setAttribute(k,v); this.append(e); return e; };
  proto.createDiv = function(o) { return this.createEl("div",o); };
  proto.createSpan = function(o) { return this.createEl("span",o); };
  proto.empty = function() { this.replaceChildren(); };
  proto.setText = function(t) { this.textContent = t; };
  proto.addClass = function(c) { this.classList.add(c); };
  let disk = settings ? { version: 1, settings, reviews: seedReviews } : undefined;
  const storage = { loadData: async () => structuredClone(disk), saveData: async d => { disk = structuredClone(d); } };
  const store = new MiaDataStore(storage); await store.load();
  const plugin = new MiaStudyPlugin();
  plugin.store = store; plugin.fsrs = new FsrsService(store.settings);
  plugin.index = { rebuild: vi.fn().mockResolvedValue(undefined) };
  const realUpdate = plugin.updateSettings.bind(plugin);
  plugin.updateSettings = vi.fn(realUpdate);
  const root = dom.window.document.querySelector("main");
  let pending;
  renderStudyManagementSettings(root, plugin, action => { pending = action(); return pending.catch(() => {}); });
  const find = label => root.querySelector(`[aria-label="${label}"]`);
  const edit = (label, value) => { const el = find(label); el.value = String(value); el.dispatchEvent(new dom.window.Event(el.tagName === "SELECT" ? "change" : "input", {bubbles:true})); };
  const click = text => [...root.querySelectorAll("button")].find(b => b.textContent === text).click();
  return { dom, root, store, plugin, storage, disk: () => structuredClone(disk), find, edit, click, save: async () => { click("학습 설정 저장"); await pending; }, restart: async () => { const restarted = new MiaDataStore(storage); await restarted.load(); return restarted; } };
}

describe("simple study settings", () => {
  for (const kind of ["new", "default", "custom"]) it(`${kind}: opening and switching never saves or changes values`, async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    if (kind === "custom") { settings.studyManagement.newCardsPerDay = 13; settings.studyManagement.learningSteps = ["3m", "1h"]; settings.targetRetention = .923; }
    const ui = await setup(kind === "new" ? undefined : settings);
    const before = structuredClone(ui.store.settings);
    expect(ui.find("공부량 프리셋").value).toBe(kind === "custom" ? "custom" : "normal");
    expect(ui.find("다시 보는 빈도").value).toBe(kind === "custom" ? "custom" : "0.9");
    ui.click("고급 설정"); ui.click("간편 설정");
    expect(ui.store.settings).toEqual(before); expect(ui.plugin.updateSettings).not.toHaveBeenCalled();
    await ui.save(); expect(ui.plugin.updateSettings).not.toHaveBeenCalled();
  });
  it("applies each workload preset only to its two fields and survives restart with review history intact", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    Object.assign(settings.studyManagement, { learningSteps: ["3m", "2h"], relearningSteps: [], dayStartsAt: 7, newCardsIgnoreReviewLimit: true, reviewOrder: "random" });
    settings.gradeIntervalsMinutes = { 1: 7 }; settings.maximumIntervalDays = 100; settings.targetRetention = .923;
    const ui = await setup(settings);
    const state = new FsrsService(settings).rate(undefined, Rating.Good, new Date("2026-10-20T12:00:00Z"));
    await ui.store.setReview("old", state);
    for (const [id, preset] of Object.entries(WORKLOAD_PRESETS)) {
      ui.edit("공부량 프리셋", id); expect(ui.store.settings.studyManagement.newCardsPerDay).not.toBe(preset.newCardsPerDay);
      await ui.save();
      const restarted = await ui.restart();
      expect(restarted.settings).toEqual({ ...settings, studyManagement: { ...settings.studyManagement, newCardsPerDay: preset.newCardsPerDay, reviewsPerDay: preset.reviewsPerDay } });
      expect(restarted.reviews).toEqual({ old: state });
    }
    expect(ui.root.textContent).toContain("고급 설정: 사용자 지정");
  });
  it("shares edits across modes, keeps exact custom values and resets only simple fields without losing unsaved advanced edits", async () => {
    const ui = await setup();
    ui.edit("하루에 새로 배울 문제 수", 7);
    ui.click("고급 설정"); ui.edit("목표 기억률", .923); ui.edit("하루를 새로 시작하는 시각", 8);
    ui.edit("처음 배우는 문제 1단계 간격", 3);
    ui.click("간편 설정"); expect(ui.find("다시 보는 빈도").value).toBe("custom"); expect(ui.find("공부량 프리셋").value).toBe("custom");
    ui.click("공부량·빈도만 기본값 불러오기");
    expect(ui.find("처음 배우는 문제 1단계 간격").value).toBe("3");
    await ui.save();
    expect(ui.store.settings.studyManagement).toEqual({ ...DEFAULT_SETTINGS.studyManagement, dayStartsAt: 8, learningSteps: ["3m", "10m"] });
    expect(ui.store.settings.targetRetention).toBe(.9);
  });
  it("prevents invalid input from saving and shows an honest summary", async () => {
    const ui = await setup(); ui.edit("하루 복습량", -1);
    expect(ui.root.querySelector(".mia-settings-summary").textContent).toContain("올바른 값");
    await ui.save(); expect(ui.plugin.updateSettings).not.toHaveBeenCalled();
    ui.edit("하루 복습량", 0); ui.edit("하루에 새로 배울 문제 수", 0); await ui.save();
    expect(ui.store.settings.studyManagement.reviewsPerDay).toBe(0);
  });
  it("keeps unrelated advanced changes made while the dialog is open", () => {
    const initial = structuredClone(DEFAULT_SETTINGS), latest = structuredClone(initial);
    latest.studyManagement.dayStartsAt = 10;
    const draft = { ...initial.studyManagement, newCardsPerDay: 5 };
    expect(studySettingsPatch(initial, draft, .9, latest).studyManagement).toEqual({ ...latest.studyManagement, newCardsPerDay: 5 });
    expect(workloadPreset(draft)).toBe("custom");
  });
  it("frequency selection changes real FSRS scheduling without changing budgets or existing due dates", async () => {
    const ui = await setup(); const now = new Date("2026-10-27T12:00:00Z");
    const previous = new FsrsService(DEFAULT_SETTINGS).rate(undefined, Rating.Easy, new Date("2026-09-01T12:00:00Z"));
    await ui.store.setReview("q", previous);
    ui.edit("다시 보는 빈도", "0.95"); await ui.save();
    const restarted = await ui.restart();
    expect(restarted.settings.targetRetention).toBe(.95); expect(restarted.settings.studyManagement).toEqual(DEFAULT_SETTINGS.studyManagement);
    expect(restarted.reviews.q).toEqual(previous);
    const shorter = new FsrsService({ ...restarted.settings, studyManagement: { ...restarted.settings.studyManagement, enableFuzz: false } }).rate(previous, Rating.Good, now);
    const longer = new FsrsService({ ...restarted.settings, targetRetention: .85, studyManagement: { ...restarted.settings.studyManagement, enableFuzz: false } }).rate(previous, Rating.Good, now);
    expect(Date.parse(shorter.card.due)).toBeLessThan(Date.parse(longer.card.due));
  });
  it("saved budgets affect the real new/review queue and preserve shared-limit behavior", async () => {
    const ui = await setup(); ui.edit("하루에 새로 배울 문제 수", 2); ui.edit("하루 복습량", 3); await ui.save();
    const now = new Date("2026-10-27T12:00:00Z"), fsrs = new FsrsService(ui.store.settings);
    const questions = Array.from({length: 8}, (_, i) => ({ id: `q${i}`, heading: `q${i}`, filePath: "test.md", coreKeywords: [], subKeywords: [], subject: "test", questionType: "정의형" }));
    expect(buildReviewQueue(questions, {}, fsrs, { now, management: ui.store.settings.studyManagement })).toHaveLength(2);
    const old = fsrs.rate(undefined, Rating.Easy, new Date("2026-09-01T12:00:00Z"));
    const reviews = Object.fromEntries(questions.slice(0, 4).map(q => [q.id, old]));
    const queue = buildReviewQueue(questions, reviews, fsrs, { now, management: ui.store.settings.studyManagement });
    expect(queue).toHaveLength(3); expect(queue.every(q => reviews[q.id])).toBe(true);
    expect(ui.root.textContent).toContain("복습이 상한을 채우면 새 문제는 나오지 않습니다");
  });
});


describe("behavior contracts from the simple-settings copy", () => {
  it("invalid advanced retention must not appear as a valid preset in simple mode", async () => {
    const ui = await setup(); ui.click("고급 설정"); ui.edit("목표 기억률", "1.2"); ui.click("간편 설정");
    expect(ui.find("다시 보는 빈도").value).toBe("custom");
    expect(ui.root.textContent).toContain("목표 기억률 입력을 확인");
    await ui.save(); expect(ui.plugin.updateSettings).not.toHaveBeenCalled();
  });
  it("a scheduling-only save cannot fail after committing just because unrelated indexing fails", async () => {
    const ui = await setup(); ui.plugin.index.rebuild.mockRejectedValue(Error("unrelated index failure"));
    ui.edit("공부량 프리셋", "light"); await expect(ui.save()).resolves.toBeUndefined();
    expect(ui.disk().settings.studyManagement.newCardsPerDay).toBe(10);
    expect(ui.plugin.index.rebuild).not.toHaveBeenCalled();
  });
  it("the daily boundary and zero-review meaning are explained without opening advanced mode", async () => {
    const ui = await setup();
    expect(ui.root.textContent).toContain("오전 4시");
    expect(ui.root.textContent).toContain("0이면 예정 복습을 쉬지만");
  });
  const now = new Date(2026, 9, 27, 12);
  // These literal expectations follow the published presets and documented shared cap:
  // 3 new + 7 reviews already used; one short repetition remains outside the cap.
  for (const [preset, savedNew, savedReviews, newCount, reviewCount] of [
    ["light",10,100,0,90], ["normal",20,200,17,120], ["more",40,400,37,120],
  ]) it(`${preset}: selection -> disk -> actual mixed queue obeys the advertised daily cap`, async () => {
    const fixture = simpleStudyFixture(now), settings = structuredClone(DEFAULT_SETTINGS);
    const ui = await setup(settings, fixture.reviews);
    ui.edit("공부량 프리셋", preset); await ui.save();
    // Normal is the unchanged baseline: seed settings still exist on disk.
    expect(ui.disk().settings.studyManagement.newCardsPerDay).toBe(savedNew);
    expect(ui.disk().settings.studyManagement.reviewsPerDay).toBe(savedReviews);
    const restarted = await ui.restart();
    const queue = buildReviewQueue(fixture.questions, restarted.reviews, new FsrsService(restarted.settings), {now, management: restarted.settings.studyManagement});
    expect(queue.filter(q => q.id.startsWith("mia-q-fresh-"))).toHaveLength(newCount);
    const freshOnly = buildReviewQueue(fixture.questions.filter(q => q.id.startsWith("mia-q-fresh-")), restarted.reviews, new FsrsService(restarted.settings), {now, management: restarted.settings.studyManagement});
    expect(freshOnly).toHaveLength({light:7,normal:17,more:37}[preset]);
    expect(queue.filter(q => /mia-q-(today|overdue)-/.test(q.id))).toHaveLength(reviewCount);
    expect(queue.filter(q => q.id === "mia-q-introduced-0")).toHaveLength(1);
    expect(queue.some(q => /mia-q-(future|done)-/.test(q.id))).toBe(false);
    expect(restarted.reviews).toEqual(fixture.reviews);
  });
  it("direct independent budgets persist across learning and restart, then renew at the configured 04:00 boundary", async () => {
    const f = simpleStudyFixture(now), settings = structuredClone(DEFAULT_SETTINGS);
    settings.studyManagement.newCardsIgnoreReviewLimit = true;
    const ui = await setup(settings, f.reviews);
    ui.edit("하루에 새로 배울 문제 수", 5); ui.edit("하루 복습량", 10); await ui.save();
    const queue = (store, time) => buildReviewQueue(f.questions, store.reviews, new FsrsService(store.settings), {now: time, management: store.settings.studyManagement});
    let result = queue(ui.store, now);
    expect(result.filter(q => q.id.startsWith("mia-q-fresh-"))).toHaveLength(2);
    expect(result.filter(q => /mia-q-(today|overdue)-/.test(q.id))).toHaveLength(3);
    await ui.store.setReview("mia-q-fresh-0", ui.plugin.fsrs.rate(undefined, Rating.Easy, now, "mia-q-fresh-0"));
    await ui.store.setReview("mia-q-overdue-0", ui.plugin.fsrs.rate(ui.store.getReview("mia-q-overdue-0"), Rating.Easy, now, "mia-q-overdue-0"));
    const restarted = await ui.restart();
    for (const time of [now, new Date(2026,9,28,0), new Date(2026,9,28,3,59,59)]) {
      result = queue(restarted,time);
      expect(result.filter(q=>q.id.startsWith("mia-q-fresh-"))).toHaveLength(1);
      expect(result.filter(q=>/mia-q-(today|overdue)-/.test(q.id))).toHaveLength(2);
    }
    result = queue(restarted,new Date(2026,9,28,4));
    expect(result.filter(q=>q.id.startsWith("mia-q-fresh-"))).toHaveLength(5);
    // The previous day's short repeat is now an interday review and shares its budget.
    expect(result.filter(q=>!q.id.startsWith("mia-q-fresh-"))).toHaveLength(10);
  });
  it("zero scheduled-review allowance preserves short learning repeats and shared-vs-independent new policy", async () => {
    for (const independent of [false,true]) {
      const f=simpleStudyFixture(now), settings=structuredClone(DEFAULT_SETTINGS);
      settings.studyManagement.newCardsIgnoreReviewLimit=independent;
      const ui=await setup(settings,f.reviews); ui.edit("하루 복습량",0); ui.edit("하루에 새로 배울 문제 수",5); await ui.save();
      const queue=buildReviewQueue(f.questions,ui.store.reviews,ui.plugin.fsrs,{now,management:ui.store.settings.studyManagement});
      expect(queue.map(q=>q.id).sort()).toEqual(independent ? ["mia-q-fresh-0","mia-q-fresh-1","mia-q-introduced-0"] : ["mia-q-introduced-0"]);
    }
  });
  it("a rejected write keeps disk and active settings unchanged, preserves draft, and allows retry", async () => {
    const f=simpleStudyFixture(now), ui=await setup(structuredClone(DEFAULT_SETTINGS),f.reviews);
    const before=ui.disk(), write=ui.storage.saveData;
    ui.storage.saveData=async()=>{throw Error("disk full");}; ui.edit("공부량 프리셋","more");
    await expect(ui.save()).rejects.toThrow("disk full");
    expect(ui.disk()).toEqual(before); expect(ui.store.settings.studyManagement.newCardsPerDay).toBe(20);
    expect(ui.find("공부량 프리셋").value).toBe("more"); expect(ui.root.textContent).toContain("저장하지 않은");
    ui.storage.saveData=write; await ui.save(); expect(ui.disk().settings.studyManagement.newCardsPerDay).toBe(40);
    expect(ui.store.reviews).toEqual(f.reviews);
  });
});

it("freezes choices during a pending write so later clicks cannot be silently discarded", async () => {
  const ui = await setup(); const write = ui.storage.saveData; let finish;
  ui.storage.saveData = data => new Promise(resolve => { finish = async () => { await write(data); resolve(); }; });
  ui.edit("공부량 프리셋", "light"); ui.click("학습 설정 저장");
  await Promise.resolve(); await Promise.resolve();
  expect(ui.find("공부량 프리셋").disabled).toBe(true);
  expect(ui.find("하루 복습량").disabled).toBe(true);
  await finish();
});

for (const invalid of ["", "-1", "10000", "1.5"]) it(`rejects the advertised invalid daily input: ${JSON.stringify(invalid)}`, async () => {
  const ui=await setup(); const before=ui.disk(); ui.edit("하루 복습량",invalid); await ui.save();
  expect(ui.plugin.updateSettings).not.toHaveBeenCalled(); expect(ui.disk()).toEqual(before);
  expect(ui.root.textContent).toContain("0–9999 사이 정수");
});
it("accepts the advertised upper boundary and reports custom values in both screens",async()=>{
  const ui=await setup();ui.edit("하루 복습량",9999);ui.edit("하루에 새로 배울 문제 수",9999);
  ui.click("고급 설정");expect(ui.find("하루 복습량").value).toBe("9999");ui.click("간편 설정");
  expect(ui.find("공부량 프리셋").value).toBe("custom");await ui.save();
  expect(ui.disk().settings.studyManagement.reviewsPerDay).toBe(9999);
  expect(ui.disk().settings.studyManagement.newCardsPerDay).toBe(9999);
});
it("choosing the custom status cannot falsely label an unchanged preset",async()=>{
  const ui=await setup();ui.edit("공부량 프리셋","custom");ui.edit("다시 보는 빈도","custom");
  expect(ui.find("공부량 프리셋").value).toBe("normal");expect(ui.find("다시 보는 빈도").value).toBe("0.9");
  expect(ui.plugin.updateSettings).not.toHaveBeenCalled();
});
it("preserves decimal custom memory targets in the pre-save change description",async()=>{
  const settings=structuredClone(DEFAULT_SETTINGS);settings.targetRetention=.923;
  const ui=await setup(settings);ui.edit("다시 보는 빈도","0.95");
  expect(ui.root.textContent).toContain("92.3% → 95%");
});
for (const [preset, expected] of [["light",90],["normal",190],["more",390]]) it(`${preset}: a large overdue backlog actually reaches its advertised review allowance`,async()=>{
  const now=new Date(2026,9,27,12), f=simpleStudyFixture(now);
  const sample=f.questions.find(q=>q.id==="mia-q-overdue-0"), state=f.reviews[sample.id];
  const backlog=Array.from({length:450},(_,i)=>({...sample,id:`mia-q-backlog-${i}`}));
  for (const q of backlog) f.reviews[q.id]=structuredClone(state);
  const ui=await setup(structuredClone(DEFAULT_SETTINGS),f.reviews);ui.edit("공부량 프리셋",preset);await ui.save();
  const result=buildReviewQueue(backlog,ui.store.reviews,ui.plugin.fsrs,{now,management:ui.store.settings.studyManagement});
  expect(result).toHaveLength(expected);
});

describe("visible configured step policy guidance",()=>{
 it("updates the displayed Hard interval and day transition as the draft changes",async()=>{
  const ui=await setup(DEFAULT_SETTINGS);ui.click("고급 설정");
  const notes=()=>[...ui.root.querySelectorAll('.mia-step-guidance')].map(el=>el.textContent);
  expect(notes()[0]).toContain('6분');
  ui.edit('처음 배우는 문제 1단계 간격',2);ui.edit('처음 배우는 문제 2단계 간격',20);
  expect(notes()[0]).toContain('11분');expect(notes()[0]).not.toContain('6분');
  ui.edit('처음 배우는 문제 2단계 단위','d');expect(notes()[0]).toContain('복습 상태로 전환');
  expect(ui.store.settings.studyManagement.learningSteps).toEqual(['1m','10m']);
 });
 it("does not promise six minutes when the Hard button has a fixed interval",async()=>{
  const settings=structuredClone(DEFAULT_SETTINGS);settings.gradeIntervalsMinutes={2:30};
  const ui=await setup(settings);ui.click('고급 설정');
  expect(ui.root.querySelector('.mia-step-guidance').textContent).toContain('고정 간격이 우선');
  expect(ui.root.querySelector('.mia-step-guidance').textContent).not.toContain('6분');
 });
});

describe('saved everyday study combinations', () => {
  it('stages a profile, applies another setup, reloads after restart and preserves expert values and history', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS), fixture = simpleStudyFixture(new Date(2026,9,28,12));
    settings.maximumIntervalDays = 3456; settings.gradeIntervalsMinutes = {2:17};
    settings.studyManagement.newCardsIgnoreReviewLimit = true; settings.studyManagement.reviewOrder = 'random';
    const ui = await setup(settings, fixture.reviews);
    ui.edit('하루에 새로 배울 문제 수',13); ui.edit('하루 복습량',87); ui.edit('목표 기억률',.923);
    ui.edit('처음 배우는 문제 1단계 간격',1.5); ui.edit('처음 배우는 문제 1단계 단위','h');
    ui.edit('내 설정 이름','평일 짧게'); ui.click('현재 입력을 내 설정으로 보관');
    expect(ui.disk().settings.savedStudyProfiles).toBeUndefined();
    await ui.save();
    expect(ui.disk().settings.savedStudyProfiles[0]).toMatchObject({name:'평일 짧게',newCardsPerDay:13, reviewsPerDay:87, learningSteps:['90m','10m'], targetRetention:.923});
    ui.edit('공부량 프리셋','more'); ui.edit('다시 보는 빈도','0.85'); await ui.save();
    ui.find('평일 짧게 불러오기').click();
    expect(ui.root.textContent).toContain('40 → 13'); expect(ui.disk().settings.studyManagement.newCardsPerDay).toBe(40);
    ui.click('고급 설정'); ui.click('간편 설정'); await ui.save();
    const restarted = await ui.restart();
    expect(restarted.settings.studyManagement).toMatchObject({newCardsPerDay:13, reviewsPerDay:87, learningSteps:['90m','10m'],newCardsIgnoreReviewLimit:true,reviewOrder:'random'});
    expect(restarted.settings.targetRetention).toBe(.923); expect(restarted.settings.maximumIntervalDays).toBe(3456);
    expect(restarted.settings.gradeIntervalsMinutes).toEqual({2:17}); expect(restarted.reviews).toEqual(fixture.reviews);
    expect(restarted.settings.savedStudyProfiles[0].name).toBe('평일 짧게');
  });
  it('rename and delete change only the saved library, never the active scheduling values',async()=>{
    const ui=await setup(DEFAULT_SETTINGS); ui.edit('내 설정 이름','A');ui.click('현재 입력을 내 설정으로 보관');await ui.save();
    ui.edit('공부량 프리셋','light');await ui.save();const before=structuredClone(ui.store.settings.studyManagement);
    ui.find('A 이름 변경').click();ui.edit('A 새 이름','이름이 길어도 저장되는 내 공부 조합');await ui.save();
    expect(ui.store.settings.studyManagement).toEqual(before);
    ui.find('이름이 길어도 저장되는 내 공부 조합 삭제').click();await ui.save();
    expect((await ui.restart()).settings.savedStudyProfiles).toEqual([]); expect(ui.store.settings.studyManagement).toEqual(before);
  });
  it('retains both the new library draft and inputs after a failed write and can retry', async()=>{
    const ui=await setup(DEFAULT_SETTINGS), write=ui.storage.saveData;
    ui.edit('내 설정 이름','실패 후 재시도');ui.click('현재 입력을 내 설정으로 보관');
    ui.storage.saveData=async()=>{throw Error('disk full');};await expect(ui.save()).rejects.toThrow('disk full');
    expect(ui.root.textContent).toContain('저장에 실패'); expect(ui.find('실패 후 재시도 불러오기')).toBeTruthy();
    expect(ui.store.settings.savedStudyProfiles).toBeUndefined();ui.storage.saveData=write;await ui.save();
    expect((await ui.restart()).settings.savedStudyProfiles).toHaveLength(1);
  });
  it('merges an unrelated external change while preserving a pending library edit',async()=>{
    const ui=await setup(DEFAULT_SETTINGS);ui.edit('내 설정 이름','내 조합');ui.click('현재 입력을 내 설정으로 보관');
    await ui.store.updateSettings({maximumIntervalDays:77});await ui.save();
    expect(ui.store.settings.maximumIntervalDays).toBe(77);expect(ui.store.settings.savedStudyProfiles).toHaveLength(1);
  });
  it('keeps a concurrent library conflict and the typed name without overwriting external edits',async()=>{
    const ui=await setup(DEFAULT_SETTINGS);ui.edit('내 설정 이름','이 기기');ui.click('현재 입력을 내 설정으로 보관');
    const remote={id:'other',name:'다른 기기',newCardsPerDay:8,reviewsPerDay:80,learningSteps:[],relearningSteps:[],targetRetention:.88};
    await ui.store.updateSettings({savedStudyProfiles:[remote]});
    await expect(ui.save()).rejects.toThrow();
    expect(ui.store.settings.savedStudyProfiles).toEqual([remote]);expect(ui.find('내 설정 이름').value).toBe('이 기기');
    expect(ui.find('이 기기 불러오기')).toBeTruthy();
  });
});

for(const bad of ['', '0', '1.5','52560001']) it(`step editor retains unrepresentable input ${JSON.stringify(bad)}`,async()=>{
  const ui=await setup(DEFAULT_SETTINGS);ui.edit('처음 배우는 문제 1단계 간격',bad);await ui.save();
  expect(ui.find('처음 배우는 문제 1단계 간격').value).toBe(bad);
  expect(ui.plugin.updateSettings).not.toHaveBeenCalled();expect(ui.root.textContent).toContain('정확한 분 단위');
});
it('step buttons reorder duplicate and descending durations without restricting valid algorithm inputs',async()=>{
 const ui=await setup(DEFAULT_SETTINGS);ui.find('처음 배우는 문제 2단계 위로').click();
 expect(ui.find('처음 배우는 문제 1단계 간격').value).toBe('10');ui.click('고급 설정');ui.click('간편 설정');
 await ui.save();expect(ui.store.settings.studyManagement.learningSteps).toEqual(['10m','1m']);
 ui.edit('처음 배우는 문제 2단계 간격',10);await ui.save();expect(ui.store.settings.studyManagement.learningSteps).toEqual(['10m','10m']);
 ui.edit('처음 배우는 문제 간격 결정','auto');await ui.save();expect(ui.store.settings.studyManagement.learningSteps).toEqual([]);
});

it('the loaded fractional profile drives the actual scheduler without changing any existing review dates',async()=>{
 const f=simpleStudyFixture(new Date(2026,9,28,12)),ui=await setup(DEFAULT_SETTINGS,f.reviews);
 ui.edit('처음 배우는 문제 1단계 간격',1.5);ui.edit('처음 배우는 문제 1단계 단위','h');
 ui.edit('틀린 문제 1단계 간격',2);ui.edit('틀린 문제 1단계 단위','h');
 ui.edit('내 설정 이름','간격 확인');ui.click('현재 입력을 내 설정으로 보관');await ui.save();
 const restarted=await ui.restart(), scheduler=new FsrsService(restarted.settings),now=new Date(2026,9,28,12);
 const first=scheduler.rate(undefined,Rating.Again,now,'fresh');
 expect(Date.parse(first.card.due)-now.getTime()).toBe(90*60_000);
 const previous=new FsrsService(DEFAULT_SETTINGS).rate(undefined,Rating.Easy,new Date(2026,8,1,12),'old');
 const failed=scheduler.rate(previous,Rating.Again,now,'old');
 expect(Date.parse(failed.card.due)-now.getTime()).toBe(120*60_000);
 expect(restarted.reviews).toEqual(f.reviews);
});
it('a successful correction clears the accessibility error while preserving a fractional exact duration',async()=>{
 const ui=await setup(DEFAULT_SETTINGS);ui.edit('처음 배우는 문제 1단계 간격',1.5);await ui.save();
 expect(ui.find('처음 배우는 문제 1단계 간격').getAttribute('aria-invalid')).toBe('true');
 ui.edit('처음 배우는 문제 1단계 단위','h');ui.edit('처음 배우는 문제 1단계 간격',2.5);
 expect(ui.find('처음 배우는 문제 1단계 간격').hasAttribute('aria-invalid')).toBe(false);
 await ui.save();expect(ui.store.settings.studyManagement.learningSteps[0]).toBe('150m');
});

it('missing profile fields leave old settings snapshots compatible and malformed libraries cannot overwrite data',async()=>{
 const ui=await setup(DEFAULT_SETTINGS);
 expect(Object.hasOwn(ui.store.settings,'savedStudyProfiles')).toBe(false);
 const before=ui.disk();
 await expect(ui.store.updateSettings({savedStudyProfiles:[{id:'broken',name:'bad'}]})).rejects.toThrow('내 설정');
 expect(ui.disk()).toEqual(before);
 expect(ui.store.settings.savedStudyProfiles).toBeUndefined();
});
it('reports the exact budget diff and discards stale preset preview after a direct edit',async()=>{
 const ui=await setup(DEFAULT_SETTINGS);ui.edit('공부량 프리셋','light');
 expect(ui.root.textContent).toContain('20개 → 10개');ui.edit('하루에 새로 배울 문제 수',12);
 expect(ui.root.textContent).not.toContain('불러오기 미리보기: 가볍게');expect(ui.root.textContent).toContain('새 문제 상한 20 → 12');
 expect(ui.find('공부량 프리셋').value).toBe('custom');
});
it('clearly distinguishes an uncommitted library edit, a stored combination, and the active values',async()=>{
 const ui=await setup(DEFAULT_SETTINGS);ui.edit('내 설정 이름','하루 계획');ui.click('현재 입력을 내 설정으로 보관');
 expect(ui.root.textContent).toContain('보관·수정 준비(미저장)');await ui.save();
 expect(ui.root.textContent).toContain('저장된 내 설정');expect(ui.root.textContent).toContain('현재 적용된 다섯 값과 같음');
 ui.edit('공부량 프리셋','light');await ui.save();expect(ui.root.textContent).toContain('현재 적용된 값과 다름');
});

it('keeps keyboard focus in the step editor after adding and removing rows, including the final row',async()=>{
 const ui=await setup(DEFAULT_SETTINGS), document=ui.dom.window.document;
 ui.find('처음 배우는 문제 단계 추가').click();
 expect(document.activeElement?.getAttribute('aria-label')).toBe('처음 배우는 문제 3단계 간격');
 ui.find('처음 배우는 문제 3단계 삭제').click();
 expect(document.activeElement?.getAttribute('aria-label')).toBe('처음 배우는 문제 2단계 간격');
 ui.find('처음 배우는 문제 1단계 삭제').click();
 expect(document.activeElement?.getAttribute('aria-label')).toBe('처음 배우는 문제 1단계 간격');
 ui.find('처음 배우는 문제 1단계 삭제').click();
 expect(document.activeElement?.getAttribute('aria-label')).toBe('처음 배우는 문제 단계 추가');
 expect(ui.store.settings.studyManagement.learningSteps).toEqual(['1m','10m']);
});

describe('beginner settings walkthrough regressions',()=>{
 it('restores only the requested daily field, step group or memory target, with no implicit save',async()=>{
  const settings=structuredClone(DEFAULT_SETTINGS);
  Object.assign(settings.studyManagement,{newCardsPerDay:7,reviewsPerDay:51,learningSteps:['90m'],relearningSteps:['2h'],dayStartsAt:7});
  settings.targetRetention=.923;settings.maximumIntervalDays=321;settings.gradeIntervalsMinutes={4:120};
  const ui=await setup(settings);const before=ui.disk();
  ui.find('하루에 새로 배울 문제 수만 기본값 복원').click();
  expect(ui.find('하루에 새로 배울 문제 수').value).toBe('20');expect(ui.find('하루 복습량').value).toBe('51');
  ui.find('틀린 문제 단계만 기본값 복원').click();
  expect(ui.find('틀린 문제 1단계 간격').value).toBe('10');expect(ui.find('처음 배우는 문제 1단계 간격').value).toBe('90');
  ui.find('복습 목표만 기본값 복원').click();expect(ui.find('목표 기억률').value).toBe('0.9');
  expect(ui.disk()).toEqual(before);await ui.save();
  expect(ui.store.settings.studyManagement).toMatchObject({newCardsPerDay:20,reviewsPerDay:51,learningSteps:['90m'],relearningSteps:['10m'],dayStartsAt:7});
  expect(ui.store.settings.maximumIntervalDays).toBe(321);expect(ui.store.settings.gradeIntervalsMinutes).toEqual({4:120});
 });
 it('opens rename with the existing name, preserves invalid edits and lets the main save finish a valid rename',async()=>{
  const ui=await setup(DEFAULT_SETTINGS);ui.edit('내 설정 이름','평일');ui.click('현재 입력을 내 설정으로 보관');await ui.save();
  ui.find('평일 이름 변경').click();expect(ui.find('평일 새 이름').value).toBe('평일');
  expect(ui.dom.window.document.activeElement).toBe(ui.find('평일 새 이름'));
  ui.edit('평일 새 이름','  ');await ui.save();expect(ui.root.textContent).toContain('1–80자');
  expect(ui.find('평일 새 이름').value).toBe('  ');
  ui.edit('평일 새 이름','주말');await ui.save();expect(ui.disk().settings.savedStudyProfiles[0].name).toBe('주말');
  expect(ui.store.settings.studyManagement).toEqual(DEFAULT_SETTINGS.studyManagement);
 });
 it('keeps duplicate names while distinguishing their visible and accessible controls',async()=>{
  const ui=await setup(DEFAULT_SETTINGS);ui.edit('내 설정 이름','평일');ui.click('현재 입력을 내 설정으로 보관');ui.click('현재 입력을 내 설정으로 보관');await ui.save();
  expect(ui.find('평일 (같은 이름 1/2) 불러오기')).toBeTruthy();expect(ui.find('평일 (같은 이름 2/2) 불러오기')).toBeTruthy();
  ui.find('평일 (같은 이름 1/2) 삭제').click();await ui.save();
  expect(ui.find('평일 불러오기')).toBeTruthy();expect(ui.disk().settings.savedStudyProfiles.map(x=>x.name)).toEqual(['평일']);
 });
 it('retains the last rapid input and ignores a repeated save while the first write is pending',async()=>{
  const ui=await setup(DEFAULT_SETTINGS),write=ui.storage.saveData;let finish;
  ui.storage.saveData=data=>new Promise(resolve=>{finish=async()=>{await write(data);resolve();};});
  for(const value of [9,80,11])ui.edit('하루에 새로 배울 문제 수',value);
  ui.click('학습 설정 저장');ui.click('학습 설정 저장');await Promise.resolve();await Promise.resolve();
  expect(ui.plugin.updateSettings).toHaveBeenCalledTimes(1);expect(ui.root.textContent).toContain('저장 중');
  await finish();await new Promise(resolve=>setTimeout(resolve,0));
  expect(ui.disk().settings.studyManagement.newCardsPerDay).toBe(11);
  ui.storage.saveData=write;ui.edit('하루에 새로 배울 문제 수',17);await ui.save();expect((await ui.restart()).settings.studyManagement.newCardsPerDay).toBe(17);
 });
});


it('cancels an inline rename with focus returned, then keeps an 80-character name across restart',async()=>{
 const ui=await setup(DEFAULT_SETTINGS);ui.edit('내 설정 이름','기존');ui.click('현재 입력을 내 설정으로 보관');await ui.save();
 const active=structuredClone(ui.store.settings.studyManagement);
 ui.find('기존 이름 변경').click();ui.edit('기존 새 이름','취소할 이름');ui.click('이름 변경 취소');
 expect(ui.dom.window.document.activeElement).toBe(ui.find('기존 이름 변경'));await ui.save();
 expect(ui.disk().settings.savedStudyProfiles[0].name).toBe('기존');
 ui.find('기존 이름 변경').click();ui.edit('기존 새 이름','가'.repeat(81));await ui.save();
 expect(ui.find('기존 새 이름').value).toHaveLength(81);expect(ui.disk().settings.savedStudyProfiles[0].name).toBe('기존');
 ui.edit('기존 새 이름','가'.repeat(80));ui.find('기존 새 이름').dispatchEvent(new ui.dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
 expect(ui.dom.window.document.activeElement).toBe(ui.find('가'.repeat(80)+' 이름 변경'));await ui.save();
 expect((await ui.restart()).settings.savedStudyProfiles[0].name).toHaveLength(80);expect(ui.store.settings.studyManagement).toEqual(active);
});

it('corrects a rejected minute fraction into exact decimal days without replacing the focused input',async()=>{
 const ui=await setup(DEFAULT_SETTINGS);const input=ui.find('처음 배우는 문제 1단계 간격');
 ui.edit('처음 배우는 문제 1단계 간격','1.1');await ui.save();expect(ui.dom.window.document.activeElement).toBe(input);
 expect(input.value).toBe('1.1');ui.edit('처음 배우는 문제 1단계 단위','d');
 expect(ui.find('처음 배우는 문제 1단계 간격')).toBe(input);await ui.save();
 expect((await ui.restart()).settings.studyManagement.learningSteps).toEqual(['1584m','10m']);
});
