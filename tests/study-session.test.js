import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Rating } from "ts-fsrs";
import { FsrsService } from "../src/core/fsrs-service";
import { QuestionIndex } from "../src/services/question-index";

const modalBoundary = vi.hoisted(() => ({ instances: [] }));

// Only Obsidian's UI boundary is replaced; the view, timers and FSRS are real.
vi.mock("obsidian", () => {
  class Element {
    children = []; handlers = new Map(); text = ""; disabled = false;
    style = { setProperty() {} }; dataset = {}; attrs = {};
    constructor(options = {}) { this.text = options.text ?? ""; this.cls=options.cls??""; this.attrs={...options.attr}; this.validity={valid:true}; this.value=options.value??""; }
    createEl(tag, options = {}) { const child = new Element(options); child.tag = tag; child.parent=this; this.children.push(child); return child; }
    createDiv(options) { return this.createEl("div", options); }
    createSpan(options) { return this.createEl("span", options); }
    empty() { this.children = []; }
    append(...children) { for (const child of children) this.appendChild(child); }
    insertBefore(child, before) { child.remove(); child.parent=this; const i=this.children.indexOf(before); this.children.splice(i<0?this.children.length:i,0,child); return child; }
    appendChild(child) { child.remove(); child.parent=this; this.children.push(child); return child; }
    setAttribute(name,value) { this.attrs[name]=value; }
    removeAttribute(name) { delete this.attrs[name]; }
    setText(text) { this.text = text; }
    addClass() {} removeClass() {} setAttr(name,value) { this.attrs[name]=value; } focus() { this.focused=true; }
    contains(element) { return this===element || this.children.some(child=>child.contains(element)); }
    querySelectorAll(selector) { const tags=selector.split(",").map(tag=>tag.trim()); return this.children.flatMap(child=>[...(tags.includes(child.tag)?[child]:[]),...child.querySelectorAll(selector)]); }
    querySelector(selector) {
      if(selector===".mia-session-edit-actions button") { const find=el=>el.cls.split(" ").includes("mia-session-edit-actions")?el.children.find(child=>child.tag==="button"):el.children.map(find).find(Boolean);return find(this)??null; }
      if(selector!==".mia-save-status")return null;
      const visit=element=>{for(const child of element.children){if(child.cls.split(" ").includes("mia-save-status"))return child;const found=visit(child);if(found)return found;}return null;};return visit(this);
    }
    scrollIntoView() {}
    scrollTo() {}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    get content() { return [this.text, ...this.children.map(child => child.content)].join(" "); }
    find(text, exact = false) { return this.children.flatMap(child => [child, child.find(text, exact)]).find(child => child && child.tag === "button" && (exact ? child.content.trim() === text : child.content.trim().startsWith(text))); }
    async click() { if (!this.disabled) await (this.onclick ?? this.handlers.get("click"))?.(); }
  }
  class Control {
    constructor(root,tag) { this.inputEl=root.createEl(tag); this.selectEl=this.inputEl; this.inputEl.validity={valid:true}; }
    setValue(value) { this.inputEl.value=value; return this; }
    setPlaceholder(value) { this.inputEl.placeholder=value; return this; }
    onChange(fn) { this.inputEl.handlers.set("input", fn); return this; }
    addOption() { return this; }
  }
  class Setting {
    constructor(root) { this.settingEl=root.createDiv({cls:"setting-item"}); this.control=this.settingEl.createDiv(); this.controlEl=this.control; }
    setName(value) { this.settingEl.createEl("label",{text:value}); return this; }
    setDesc(value) { this.settingEl.createEl("p",{text:value}); return this; }
    addText(fn) { fn(new Control(this.control,"input")); return this; }
    addTextArea(fn) { fn(new Control(this.control,"textarea")); return this; }
    addDropdown(fn) { fn(new Control(this.control,"select")); return this; }
    addToggle(fn) { fn(new Control(this.control,"input")); return this; }
    addButton(fn) {
      const button=this.control.createEl("button");
      const control={setButtonText(value){button.text=value;return this;},setCta(){return this;},setDisabled(value){button.disabled=value;return this;},onClick(fn){button.handlers.set("click",fn);return this;}};
      fn(control); return this;
    }
  }
  return {
    Setting,
    PluginSettingTab: class { constructor(app) { this.app=app; this.containerEl=new Element(); this.containerEl.ownerDocument={defaultView:null}; } hide() {} },
    ItemView: class { constructor(leaf) { this.leaf = leaf; this.app = leaf.app; this.contentEl = new Element(); } },
    Component: class {
      children = [];
      load() {}
      unload() { for (const child of this.children) child.unload(); this.children = []; }
      addChild(child) { this.children.push(child); child.load(); return child; }
      removeChild(child) { child.unload(); this.children = this.children.filter(item => item !== child); return child; }
    },
    Modal: class { constructor(app) { this.app=app; this.contentEl=new Element(); this.modalEl=new Element(); this.containerEl=new Element(); modalBoundary.instances.push(this); } setTitle() {} open = vi.fn(); close = vi.fn(); }, Notice: class {}, Platform: { isMobile: false },
    MarkdownRenderer: { render: async (_app, text, element) => { element.text = text; } },
  };
});
import { MarkdownRenderer } from "obsidian";
import { StudyUiStore } from "../src/services/study-ui-store";
import { MiaStudyView } from "../src/ui/study-view";
import { MiaSettingTab } from "../src/ui/settings-tab";
import { StudyManagementModal } from "../src/ui/study-management-modal";
import { MiaDataStore } from "../src/services/data-store";
import { buildReviewQueue } from "../src/core/recommendation-engine";
import { DEFAULT_SETTINGS } from "../src/core/models";
import { calculateProgress } from "../src/core/progress";

function setup({ failSave = false, start = true, linked = false } = {}) {
  const question = { id: "q", heading: "질문", questionMarkdown: "질문", answerMarkdown: "정답", subject: "과목", questionType: "정의형", filePath: "bank.md", coreKeywords: [], subKeywords: [], followUpIds: [] };
  const reviews = {};
  const questions = linked ? [{ ...question, followUpIds: ["related"] }, { ...question, id: "related", heading: "꼬리질문" }] : [question];
  const files = new Map();
  const studyApp = { loadLocalStorage: () => null, saveLocalStorage() {}, vault: { adapter: { exists: async path => files.has(path), read: async path => files.get(path), write: async (path, data) => { files.set(path, data); } } } };
  const plugin = {
    manifest: { version: "1.0.3" },
    studyUi: new StudyUiStore(studyApp, "ui-state.json"),
    openQuestionPreview: vi.fn().mockResolvedValue(undefined),
    openManagedQuestionEditor: vi.fn().mockResolvedValue(undefined),
    listSubjects: () => [],
    fsrs: new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 }),
    index: { diagnostics: [], candidates: [], isReady: true, registered: questions, questionById: id => questions.find(item => item.id === id) },
    store: {
      settings: { ...structuredClone(DEFAULT_SETTINGS), studyManagement: { ...structuredClone(DEFAULT_SETTINGS.studyManagement), newCardOrder: "random", newReviewOrder: "after", reviewOrder: "random" } },
      reviews, getReview: id => reviews[id],
      getReviewVersion: id => reviews[id] ? JSON.stringify(reviews[id]) : null,
      setReview: async (id, state) => { if (failSave) throw Error("disk full"); reviews[id] = state; },
      removeReview: async id => { delete reviews[id]; },
    },
  };
  plugin.synchronizeStudyData = () => plugin.store.synchronize();
  let view;
  const leaf = { app: { workspace: { requestSaveLayout() {} } }, setViewState: async ({ state }) => view.setState(state, {}) };
  view = new MiaStudyView(leaf, plugin);
  if (start) view.startReview(["q"]);
  return { view, plugin, reviews, files, studyApp, button: text => view.contentEl.find(text), exactButton: text => view.contentEl.find(text, true), content: () => view.contentEl.content };
}

beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0.999999);
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
  vi.stubGlobal("window", { setTimeout, clearTimeout });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("learning settings dialog", () => {
  const field = (ui, label) => {
    const visit = element => element.attrs["aria-label"] === label ? element : element.children.map(visit).find(Boolean);
    return visit(ui.modal.contentEl);
  };
  const dashboard = async () => {
    const ui = setup({ start: false });
    ui.plugin.updateSettings = vi.fn(async patch => { Object.assign(ui.plugin.store.settings, structuredClone(patch)); });
    await ui.view.setState({ route: "dashboard", queue: [], queueIndex: 0, answerVisible: false, sessionMode: "recall" }, {});
    const modal=new StudyManagementModal(ui.view.app,ui.plugin,()=>ui.view.render());modal.onOpen();
    return {...ui,modal,exactButton:text=>modal.contentEl.find(text,true),content:()=>modal.contentEl.content};
  };
  it("opens learning settings from a header button without a full settings form on home", async () => {
    const ui=setup({start:false});ui.view.showDashboard();
    expect(ui.exactButton("보기 설정")).toBeDefined();
    expect(ui.content()).not.toContain("하루에 새로 배울 문제 수");expect(ui.content()).not.toContain("학습 설정 저장");
    await ui.exactButton("학습 설정").click();
    const modal=modalBoundary.instances.at(-1);expect(modal).toBeInstanceOf(StudyManagementModal);expect(modal.open).toHaveBeenCalledOnce();
  });
  it("shows the learning fields and cancellation in the dialog",async()=>{
    const ui=await dashboard();
    for(const label of ["하루에 새로 배울 문제 수","처음 배우는 문제","틀린 문제","복습 순서","FSRS-6 매개변수","학습 설정 저장","취소"])expect(ui.content()).toContain(label);
  });
  it("discards changes when cancelled and reopens with saved values",async()=>{
    const ui=await dashboard();const input=field(ui,"하루에 새로 배울 문제 수");input.value="9";input.handlers.get("input")("9");
    await ui.exactButton("취소").click();expect(ui.modal.close).toHaveBeenCalledOnce();expect(ui.plugin.updateSettings).not.toHaveBeenCalled();
    ui.modal.onOpen();expect(field(ui,"하루에 새로 배울 문제 수").value).toBe("20");
  });
  it("preserves an unsaved dialog field across dashboard refreshes and closes after saving", async () => {
    const ui = await dashboard(); const input = field(ui, "하루에 새로 배울 문제 수");
    input.value = "7"; input.handlers.get("input")("7");
    ui.view.render();
    expect(field(ui, "하루에 새로 배울 문제 수")).toBe(input);
    expect(field(ui, "하루에 새로 배울 문제 수").value).toBe("7");
    await ui.exactButton("학습 설정 저장").click();
    expect(ui.plugin.store.settings.studyManagement.newCardsPerDay).toBe(7);
    expect(ui.modal.close).toHaveBeenCalledOnce();
  });
  it("saves numeric step amounts and units without requiring Anki syntax", async () => {
    const ui = await dashboard();
    const amount = field(ui, "처음 배우는 문제 1단계 간격"); amount.value = "1.5"; amount.handlers.get("input")();
    const unit = field(ui, "처음 배우는 문제 1단계 단위"); unit.value = "h"; unit.handlers.get("change")();
    await ui.exactButton("학습 설정 저장").click();
    expect(ui.plugin.store.settings.studyManagement.learningSteps).toEqual(["90m", "10m"]);
  });
  it("loads defaults into the draft without silently saving them", async () => {
    const ui = await dashboard();ui.plugin.store.settings.studyManagement.newCardsPerDay = 7;ui.modal.onOpen();
    await ui.exactButton("공부량·빈도만 기본값 불러오기").click();
    expect(field(ui, "하루에 새로 배울 문제 수").value).toBe("20");expect(ui.plugin.updateSettings).not.toHaveBeenCalled();expect(ui.plugin.store.settings.studyManagement.newCardsPerDay).toBe(7);
    await ui.exactButton("학습 설정 저장").click();expect(ui.plugin.store.settings.studyManagement.newCardsPerDay).toBe(20);
  });
  it("allows automatic steps and adds/removes manual steps without ambiguous labels", async () => {
    const ui = await dashboard();
    field(ui, "처음 배우는 문제 1단계 삭제").click();
    expect(field(ui, "처음 배우는 문제 1단계 간격").value).toBe("10");
    field(ui, "처음 배우는 문제 단계 추가").click();
    expect(field(ui, "처음 배우는 문제 2단계 간격").value).toBe("10");
    field(ui, "처음 배우는 문제 간격 결정").handlers.get("input")("auto");
    await ui.exactButton("학습 설정 저장").click();expect(ui.plugin.store.settings.studyManagement.learningSteps).toEqual([]);
  });
  it("reveals advanced settings and points to an invalid parameter field on save", async () => {
    const ui = await dashboard();const parameters = field(ui, "FSRS-6 매개변수");parameters.handlers.get("input")("1, 2");
    await ui.exactButton("학습 설정 저장").click();expect(ui.plugin.updateSettings).not.toHaveBeenCalled();
    const visit = el => el.cls === "mia-settings-expert" ? el : el.children.map(visit).find(Boolean);
    expect(visit(ui.modal.contentEl).hidden).toBe(false);
    expect(parameters.focused).toBe(true);
  });
  it("keeps the draft and allows retry after a rejected save", async () => {
    const ui = await dashboard(); const input = field(ui, "하루에 새로 배울 문제 수");
    input.value = "9"; input.handlers.get("input")("9");
    ui.plugin.updateSettings.mockRejectedValueOnce(new Error("disk full"));
    await ui.exactButton("학습 설정 저장").click();
    expect(ui.plugin.store.settings.studyManagement.newCardsPerDay).toBe(20);
    expect(field(ui, "하루에 새로 배울 문제 수").value).toBe("9");
    expect(ui.exactButton("학습 설정 저장").disabled).toBe(false);
    expect(ui.modal.close).not.toHaveBeenCalled();
    await ui.exactButton("학습 설정 저장").click();
    expect(ui.plugin.store.settings.studyManagement.newCardsPerDay).toBe(9);
  });
});

describe("Obsidian learning settings integration", () => {
  const field = (root, label) => root.attrs["aria-label"] === label ? root : root.children.map(child => field(child,label)).find(Boolean);
  it("keeps existing settings above and below learning settings, including when loading defaults", async () => {
    const ui=setup({start:false});const tab=new MiaSettingTab({},ui.plugin);tab.display();
    const original=field(tab.containerEl,"못 암기 복습 간격");original.value="12";original.handlers.get("input")("12");
    for(const text of ["문제 폴더","목표 기억률","최대 복습 간격(일)","키워드 노트 폴더"])expect(tab.containerEl.content).toContain(text);
    await tab.containerEl.find("공부량·빈도만 기본값 불러오기",true).click();
    for(const text of ["문제 폴더","목표 기억률","최대 복습 간격(일)","키워드 노트 폴더"])expect(tab.containerEl.content).toContain(text);
    expect(field(tab.containerEl,"못 암기 복습 간격")).toBe(original);expect(original.value).toBe("12");
  });
  it("keeps the learning draft and unrelated drafts after a failed save, then retries", async () => {
    const ui=setup({start:false});ui.plugin.updateSettings=vi.fn(async patch=>Object.assign(ui.plugin.store.settings,structuredClone(patch)));
    const tab=new MiaSettingTab({},ui.plugin);tab.display();
    const fresh=field(tab.containerEl,"하루에 새로 배울 문제 수");fresh.value="9";fresh.handlers.get("input")("9");
    const fixed=field(tab.containerEl,"못 암기 복습 간격");fixed.value="12";fixed.handlers.get("input")("12");
    ui.plugin.updateSettings.mockRejectedValueOnce(Error("disk full"));
    await tab.containerEl.find("학습 설정 저장",true).click();
    expect(field(tab.containerEl,"하루에 새로 배울 문제 수")).toBe(fresh);expect(fresh.value).toBe("9");
    expect(field(tab.containerEl,"못 암기 복습 간격")).toBe(fixed);expect(fixed.value).toBe("12");
    expect(ui.plugin.store.settings.studyManagement.newCardsPerDay).toBe(20);
    await tab.containerEl.find("학습 설정 저장",true).click();expect(ui.plugin.store.settings.studyManagement.newCardsPerDay).toBe(9);
  });
});

describe("study view scheduling integration", () => {
  it("disables global and subject recall at the daily limit while leaving browse available", async () => {
    const ui = setup({ start: false });
    ui.plugin.store.settings.studyManagement.newCardsPerDay = 0;
    ui.view.showDashboard();
    expect(ui.exactButton("시험 모드 시작").disabled).toBe(true);
    expect(ui.exactButton("시험").disabled).toBe(true);
    expect(ui.exactButton("전체 암기 모드").disabled).toBe(false);
    expect(ui.exactButton("암기").disabled).toBe(false);
    await ui.exactButton("암기").click();
    expect(ui.view.getState().queue).toEqual(["q"]);
    expect(ui.view.getState().sessionMode).toBe("browse");
  });

  it.each([
    ["시험 모드 시작", "recall", false], ["전체 암기 모드", "browse", false],
    ["시험", "recall", true], ["암기", "browse", true],
  ])("uses due-first randomized eligibility from %s", async (label, mode, subjectOnly) => {
    const ui = setup({ start: false }); const template = ui.plugin.index.registered[0];
    const ids = ["new-a", "due-a", "future", "due-b", "new-b", "other"];
    ui.plugin.index.registered.splice(0, 1, ...ids.map(id => ({ ...template, id, heading: id, subject: id === "other" ? "다른 과목" : "과목" })));
    const mature = ui.plugin.fsrs.rate(undefined, Rating.Easy, new Date(Date.now() - 30 * 86_400_000));
    for (const id of ["due-a", "due-b"]) ui.reviews[id] = structuredClone(mature);
    ui.reviews.future = ui.plugin.fsrs.rate(undefined, Rating.Easy);
    Math.random.mockReturnValue(0);
    ui.view.showDashboard(); await ui.exactButton(label).click();
    const state = ui.view.getState();
    expect(state.sessionMode).toBe(mode);
    expect(state.answerVisible).toBe(mode === "browse");
    expect(state.queue.slice(0, 2)).toEqual(["due-b", "due-a"]);
    expect(state.queue.slice(2)).toEqual(subjectOnly ? ["new-b", "new-a"] : ["new-b", "other", "new-a"]);
    expect(state.queue).not.toContain("future");
    const fixed = [...state.queue];
    await ui.view.setState(ui.view.getState(), {});
    expect(ui.view.getState().queue).toEqual(fixed);
    ui.view.showDashboard(); await ui.button("이어하기").click();
    expect(ui.view.getState().queue).toEqual(fixed);
    expect(ui.reviews[fixed[0]].history).toHaveLength(1);
  });

  it.each(["시험 모드 시작", "전체 암기 모드", "시험", "암기"])("disables %s when every review is still in the future", label => {
    const ui = setup({ start: false }); ui.reviews.q = ui.plugin.fsrs.rate(undefined, Rating.Easy);
    ui.view.showDashboard(); expect(ui.exactButton(label).disabled).toBe(true);
  });

  it("graduates Again → Good → Good and clears resume without pulling a future review into today", async () => {
    const ui = setup();
    for (const label of ["못 암기", "암기", "암기"]) {
      await ui.button("정답 보기").click(); await ui.button(label).click();
      if (label !== "암기" || ui.reviews.q.history.length < 3) {
        expect(ui.content()).toContain("다음 복습 대기 중");
        const wait = Date.parse(ui.reviews.q.card.due) - Date.now();
        await vi.advanceTimersByTimeAsync(wait);
      }
    }
    expect(ui.reviews.q.history.map(log => log.rating)).toEqual([Rating.Again, Rating.Good, Rating.Good]);
    expect(ui.content()).toContain("학습 완료");
    expect(ui.content()).not.toContain("다음 복습 대기 중");
    await ui.plugin.studyUi.load(); expect(ui.plugin.studyUi.resume).toBeNull();
    expect(buildReviewQueue(ui.plugin.index.registered, ui.reviews, ui.plugin.fsrs)).toEqual([]);
  });

  it("retries a failed rating without skipping a question or duplicating its history", async () => {
    const ui = setup(); let saves = 0;
    ui.plugin.store.setReview = async (id, state) => { if (++saves === 1) throw Error("disk full"); ui.reviews[id] = state; };
    await ui.button("정답 보기").click(); await ui.button("너무 쉬움").click();
    expect(ui.view.getState()).toMatchObject({ queueIndex: 0, answerVisible: true });
    expect(ui.reviews).toEqual({});
    await ui.button("암기").click();
    expect(ui.reviews.q.history.map(log => log.rating)).toEqual([Rating.Good]);
    expect(ui.content()).toContain("다음 복습 대기 중");
  });

  it("keeps undo available after a failed undo write, then restores the original state on retry", async () => {
    const ui = setup(); await ui.button("정답 보기").click(); await ui.button("너무 쉬움").click();
    let attempts = 0;
    ui.plugin.store.removeReview = async id => { if (++attempts === 1) throw Error("disk full"); delete ui.reviews[id]; };
    await ui.button("직전 평가 취소").click();
    await vi.waitFor(() => expect(ui.view.isMutatingReview).toBe(false));
    expect(ui.reviews.q.history).toHaveLength(1);
    expect(ui.view.getState().queueIndex).toBe(1);
    await ui.button("직전 평가 취소").click();
    await vi.waitFor(() => expect(ui.view.getState().queueIndex).toBe(0));
    expect(ui.reviews.q).toBeUndefined(); expect(ui.view.getState().answerVisible).toBe(true);
  });
  it("keeps a follow-up added after a rating when that rating is undone", async () => {
    const ui = setup({ linked: true });
    const related = ui.plugin.index.registered[1];
    related.followUpIds = ["third"];
    ui.plugin.index.registered.push({ ...related, id: "third", heading: "새 꼬리질문", followUpIds: [] });
    ui.view.startReview(["q", "related"]);
    await ui.button("정답 보기").click(); await ui.button("너무 쉬움").click();
    await ui.button("정답 보기").click(); await ui.button("다음 순서에 추가").click();
    expect(ui.view.getState().queue).toEqual(["q", "related", "third"]);
    await ui.button("직전 평가 취소").click();
    expect(ui.view.getState().queue).toEqual(["q", "related", "third"]);
    expect(ui.reviews.q).toBeUndefined();
    await ui.button("너무 쉬움").click();
    await ui.button("정답 보기").click(); await ui.button("너무 쉬움").click();
    expect(ui.content()).toContain("새 꼬리질문");
    expect(ui.view.getState().queueIndex).toBe(2);
  });

  it("keeps added follow-ups before the next existing question across undo without duplicates", async () => {
    const ui = setup({ linked: true });
    const related = ui.plugin.index.registered[1]; related.followUpIds = ["third"];
    ui.plugin.index.registered.push({ ...related, id: "third", heading: "추가 질문", followUpIds: ["fourth"] });
    ui.plugin.index.registered.push({ ...related, id: "fourth", heading: "두 번째 추가 질문", followUpIds: [] });
    ui.plugin.index.registered.push({ ...related, id: "last", heading: "마지막 질문", followUpIds: [] });
    ui.view.startReview(["q", "related", "last"]);
    await ui.button("정답 보기").click(); await ui.button("너무 쉬움").click();
    await ui.button("정답 보기").click(); await ui.button("다음 순서에 추가").click();
    await ui.button("다음 문제 →").click();
    await ui.button("정답 보기").click(); await ui.button("다음 순서에 추가").click();
    await ui.button("직전 평가 취소").click();
    expect(ui.view.getState().queue).toEqual(["q", "related", "third", "fourth", "last"]);
    expect(ui.reviews).toEqual({});
  });

  it.each([0, 60_000])("retains pending learning when the last remaining question is deleted after %s ms", async elapsed => {
    const ui = setup({ linked: true }); ui.view.startReview(["q", "related"]);
    await ui.button("정답 보기").click(); await ui.button("못 암기").click();
    vi.setSystemTime(Date.now() + elapsed);
    ui.plugin.index.registered.splice(1, 1);
    await ui.view.setState(ui.view.getState(), {});
    expect(ui.content()).not.toContain("학습 완료");
    if (!elapsed) {
      expect(ui.content()).toContain("다음 복습 대기 중");
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(ui.view.getState().queue.at(-1)).toBe("q");
    expect(ui.button("정답 보기")).toBeDefined();
    expect(ui.reviews.q.history).toHaveLength(1);
  });

  it("preserves a scheduled retry when moving forward through an already rated question", async () => {
    const ui = setup({ linked: true }); ui.view.startReview(["q", "related"]);
    await ui.button("정답 보기").click(); await ui.button("못 암기").click();
    await ui.button("← 이전 문제").click();
    expect(ui.view.getState().answerVisible).toBe(true);
    await ui.button("다음 문제 →").click();
    await ui.button("정답 보기").click(); await ui.button("너무 쉬움").click();
    expect(ui.content()).toContain("다음 복습 대기 중");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ui.content()).toContain("질문"); expect(ui.button("정답 보기")).toBeDefined();
    expect(ui.view.getState().queue.at(-1)).toBe("q");
  });

  it("can explicitly skip a new ungraded retry without deleting its stored review", async () => {
    const ui = setup(); await ui.button("정답 보기").click(); await ui.button("못 암기").click();
    await vi.advanceTimersByTimeAsync(60_000);
    await ui.button("다음 문제 →").click();
    expect(ui.content()).toContain("학습 완료");
    expect(ui.reviews.q.history.map(log => log.rating)).toEqual([Rating.Again]);
  });
  it("runs twenty mixed-grade questions, corrects mistakes, resumes after restart and reviews only due cards the next day", async () => {
    let persisted = {};
    const disk = { loadData: async () => structuredClone(persisted), saveData: async data => { persisted = structuredClone(data); } };
    const makeSession = async () => {
      const ui = setup({ start: false });
      const template = ui.plugin.index.registered[0];
      ui.plugin.index.registered.splice(0, 1, ...Array.from({ length: 20 }, (_, i) => ({ ...template, id: `routine-${i}`, heading: `질문 ${i + 1}` })));
      ui.plugin.store = new MiaDataStore(disk); await ui.plugin.store.load();
      return ui;
    };
    let ui = await makeSession(); ui.view.startReview();
    const expectedGrades = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];
    for (let i = 0; i < 20; i++) {
      if (i === 10) {
        await ui.plugin.studyUi.load(); await ui.view.onClose();
        const first = ui; ui = await makeSession();
        ui.plugin.studyUi = new StudyUiStore(first.studyApp, "ui-state.json"); await ui.plugin.studyUi.load();
        ui.view.showDashboard(); await ui.button("이어하기").click();
        expect(ui.view.getState().queueIndex).toBe(10);
      }
      expect(ui.view.getState().answerVisible).toBe(false);
      await ui.button("정답 보기").click();
      if (i === 5 || i === 11) {
        await ui.button("너무 쉬움").click(); await ui.button("직전 평가 취소").click();
        await vi.waitFor(() => expect(ui.view.getState().queueIndex).toBe(i));
        expect(ui.plugin.store.getReview(`routine-${i}`)).toBeUndefined();
      }
      const grade = expectedGrades[i % 4];
      const rating = ui.button({ 1: "못 암기", 2: "애매", 3: "암기", 4: "너무 쉬움" }[grade]);
      expect(rating, `step ${i}: ${ui.content()}`).toBeDefined();
      await rating.click();
      expect(ui.plugin.store.getReview(`routine-${i}`).history).toHaveLength(1);
    }
    expect(Object.keys(persisted.reviews)).toHaveLength(20);
    expect(calculateProgress(ui.plugin.index.registered, ui.plugin.store.reviews, ui.plugin.fsrs).today).toBe(20);
    await ui.view.onClose();
    vi.setSystemTime(new Date("2026-10-16T00:00:00Z"));
    ui = await makeSession();
    const due = buildReviewQueue(ui.plugin.index.registered, ui.plugin.store.reviews, ui.plugin.fsrs);
    expect(due).toHaveLength(15);
    expect(due.every(question => ui.plugin.store.getReview(question.id).lastRating !== Rating.Easy)).toBe(true);
    ui.view.startReview();
    for (const question of due) {
      const state = ui.view.getState(); expect(state.queue[state.queueIndex]).toBe(question.id);
      await ui.button("정답 보기").click(); await ui.button("암기").click();
      expect(ui.plugin.store.getReview(question.id).history).toHaveLength(2);
    }
    const counts = calculateProgress(ui.plugin.index.registered, ui.plugin.store.reviews, ui.plugin.fsrs);
    expect(counts.today).toBe(15);
    expect(Object.values(persisted.reviews).reduce((sum, review) => sum + review.history.length, 0)).toBe(35);
  });
  it("undoes with the physical U key while the Korean keyboard layout is active", async () => {
    const ui = setup({ linked: true }); ui.view.startReview(["q", "related"]);
    await ui.button("정답 보기").click(); await ui.button("너무 쉬움").click();
    const preventDefault = vi.fn();
    ui.view.handleStudyShortcut({ key: "ㅕ", code: "KeyU", target: null, preventDefault });
    await Promise.resolve();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(ui.reviews.q).toBeUndefined();
    expect(ui.view.getState().queueIndex).toBe(0);
  });
  it("does not apply another session's baseline when restoring a different queue", async () => {
    const ui = setup({ linked: true });
    ui.reviews.q = ui.plugin.fsrs.rate(undefined, Rating.Good, new Date(Date.now() - 86_400_000));
    ui.view.startReview(["q", "related"]);
    await ui.button("정답 보기").click(); await ui.button("너무 쉬움").click();
    await ui.view.setState({ route: "study", queue: ["related"], queueIndex: 0, answerVisible: true, sessionMode: "recall" }, {});
    expect(ui.button("직전 평가 취소")).toBeUndefined();
    await ui.button("암기").click();
    expect(ui.reviews.related.history).toHaveLength(1);
  });
  it("reveals keyword hints without grading or exposing the answer, then resets hints on the next card", async () => {
    const ui = setup({ linked: true });
    ui.plugin.index.registered[0].coreKeywords = [{ target: "키워드", label: "키워드", raw: "키워드" }];
    ui.view.startReview(["q", "related"]);
    await ui.button("키워드 힌트").click();
    expect(ui.content()).toContain("키워드"); expect(ui.button("정답 보기")).toBeDefined();
    expect(ui.view.getState().answerVisible).toBe(false); expect(ui.reviews).toEqual({});
    await ui.button("다음 →").click(); await ui.exactButton("← 이전").click();
    expect(ui.button("키워드 힌트 접기")).toBeUndefined();
    expect(ui.button("키워드 힌트")).toBeDefined();
  });
  it("offers resume on the dashboard and restores position and answer on a fresh device/view", async () => {
    const first = setup({ linked: true }); first.view.startReview(["q", "related"]);
    await first.button("다음 →").click(); await first.button("정답 보기").click();
    await first.plugin.studyUi.load();
    const next = setup({ linked: true, start: false });
    next.plugin.studyUi = new StudyUiStore(first.studyApp, "ui-state.json"); await next.plugin.studyUi.load();
    next.view.showDashboard();
    expect(next.content()).toContain("마지막 학습"); expect(next.content()).toContain("2 / 2");
    await next.button("이어하기").click();
    expect(next.view.getState()).toMatchObject({ route: "study", queue: ["q", "related"], queueIndex: 1, answerVisible: true });
    expect(next.reviews).toEqual({});
  });

  it("resumes the same in-memory session without losing undo", async () => {
    const ui = setup({ linked: true }); ui.view.startReview(["q", "related"]);
    await ui.button("정답 보기").click(); await ui.button("너무 쉬움").click();
    ui.view.showDashboard(); await ui.plugin.studyUi.load();
    await ui.button("이어하기").click(); await ui.button("직전 평가 취소").click();
    expect(ui.view.getState().queueIndex).toBe(0); expect(ui.reviews.q).toBeUndefined();
  });

  it("does not offer a completed session as resume", async () => {
    const ui = setup(); await ui.button("다음 문제 →").click();
    await ui.plugin.studyUi.load(); expect(ui.plugin.studyUi.resume).toBeNull();
    ui.view.showDashboard(); expect(ui.button("이어하기")).toBeUndefined();
  });

  it("reads a newer synced position before resuming instead of overwriting it with the current view", async () => {
    const ui = setup({ linked: true }); ui.view.startReview(["q", "related"]); await ui.plugin.studyUi.load();
    const remote = new StudyUiStore(ui.studyApp, "ui-state.json"); await remote.load();
    await remote.saveResume({ ...remote.resume, queueIndex: 1, answerVisible: true });
    ui.view.showDashboard(); await ui.button("이어하기").click();
    expect(ui.view.getState()).toMatchObject({ queueIndex: 1, answerVisible: true });
    expect(ui.reviews).toEqual({});
  });

  it("keeps reading preferences without resetting the current answer, queue or content tree", async () => {
    const ui = setup(); await ui.button("정답 보기").click();
    const before = ui.view.getState(), tree = ui.view.contentEl.children;
    ui.plugin.studyUi.updateAppearance({ size: "large", density: "compact" }); ui.view.refreshAppearance();
    expect(ui.view.contentEl.dataset).toMatchObject({ readingSize: "large", density: "compact" });
    expect(ui.view.contentEl.children).toBe(tree); expect(ui.view.getState()).toEqual(before); expect(ui.reviews).toEqual({});
  });

  it("offers the same ungraded movement through the thumb controls", async () => {
    const ui = setup({ linked: true }); ui.view.startReview(["q", "related"]);
    expect(ui.exactButton("← 이전").disabled).toBe(true);
    await ui.button("다음 →").click();
    expect(ui.view.getState().queueIndex).toBe(1);
    await ui.exactButton("← 이전").click();
    expect(ui.view.getState().queueIndex).toBe(0);
    expect(ui.reviews).toEqual({});
  });

  it.each([Rating.Again, Rating.Easy])("undoes by U from waiting/completed state for grade %s", async grade => {
    const ui = setup();
    await ui.button("정답 보기").click();
    ui.view.handleStudyShortcut({ key: String(grade), target: null, preventDefault() {} });
    await Promise.resolve();
    expect(ui.reviews.q.history).toHaveLength(1);
    ui.view.handleStudyShortcut({ key: "U", target: null, preventDefault() {} });
    await Promise.resolve();
    expect(ui.reviews.q).toBeUndefined();
    expect(ui.view.getState()).toMatchObject({ queueIndex: 0, answerVisible: true });
  });

  it.each([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy])("reveals with Space, then rates with keyboard %s exactly once", async grade => {
    const ui = setup();
    const key = value => ({ key: value, preventDefault: vi.fn(), target: null });
    ui.view.handleStudyShortcut(key(String(grade)));
    expect(ui.reviews).toEqual({});
    ui.view.handleStudyShortcut(key(" "));
    expect(ui.button("정답 보기")).toBeUndefined();
    const event = key(String(grade));
    ui.view.handleStudyShortcut({ ...event, repeat: true });
    expect(ui.reviews).toEqual({});
    ui.view.handleStudyShortcut(event);
    await Promise.resolve();
    expect(ui.reviews.q.history).toHaveLength(1);
    expect(ui.reviews.q.lastRating).toBe(grade);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("leaves typing, composition, modified keys and native button Space untouched", () => {
    const ui = setup();
    for (const options of [
      { target: { closest: () => ({}) } },
      { isComposing: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true },
      { target: { closest: selector => selector === "button, summary" ? {} : null } },
    ]) {
      const event = { key: " ", preventDefault: vi.fn(), target: null, ...options };
      ui.view.handleStudyShortcut(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(ui.button("정답 보기")).toBeDefined();
    }
    expect(ui.reviews).toEqual({});
  });

  it("navigates with arrows, resets reading position for the new card and keeps the answer hidden in recall mode", () => {
    const ui = setup({ linked: true });
    ui.view.startReview(["q", "related"]);
    ui.view.contentEl.scrollTop = 700;
    ui.view.handleStudyShortcut({ key: "ArrowRight", target: null, preventDefault() {} });
    expect(ui.view.getState()).toMatchObject({ queueIndex: 1, answerVisible: false });
    expect(ui.view.contentEl.scrollTop).toBe(0);
    ui.view.handleStudyShortcut({ key: "ArrowLeft", target: null, preventDefault() {} });
    expect(ui.view.getState().queueIndex).toBe(0);
    expect(ui.reviews).toEqual({});
  });

  it("opens an already queued follow-up in browse mode without changing the current session or review", async () => {
    const ui = setup({ linked: true });
    ui.view.startReview(["q", "related"], "browse");
    const before = ui.view.getState();
    expect(ui.button("이미 학습에 포함됨").disabled).toBe(true);
    expect(ui.button("꼬리질문").disabled).toBe(false);
    await ui.button("꼬리질문").click();
    expect(ui.plugin.openQuestionPreview).toHaveBeenCalledWith(expect.objectContaining({ id: "related" }), expect.any(Function));
    expect(ui.view.getState()).toEqual(before);
    expect(ui.reviews).toEqual({});
  });

  it("separates opening a follow-up from inserting it once into the next study position", async () => {
    const ui = setup({ linked: true });
    await ui.button("정답 보기").click();
    await ui.button("꼬리질문").click();
    expect(ui.view.getState().queue).toEqual(["q"]);
    await ui.button("다음 순서에 추가").click();
    expect(ui.view.getState().queue).toEqual(["q", "related"]);
    expect(ui.button("이미 학습에 포함됨").disabled).toBe(true);
    await ui.button("이미 학습에 포함됨").click();
    expect(ui.view.getState().queue).toEqual(["q", "related"]);
    await ui.button("다음 문제 →").click();
    expect(ui.content()).toContain("꼬리질문");
    expect(ui.view.getState().queueIndex).toBe(1);
    expect(ui.reviews).toEqual({});
  });

  it("does not open or insert a follow-up during a pending rating save", async () => {
    const ui = setup({ linked: true });
    let finish;
    ui.plugin.store.setReview = (id, state) => new Promise(resolve => { finish = () => { ui.reviews[id] = state; resolve(); }; });
    await ui.button("정답 보기").click();
    const pending = ui.button("너무 쉬움").click();
    await ui.button("꼬리질문").click();
    await ui.button("다음 순서에 추가").click();
    expect(ui.plugin.openQuestionPreview).not.toHaveBeenCalled();
    expect(ui.view.getState().queue).toEqual(["q"]);
    finish(); await pending;
  });

  it("appends a new follow-up while revisiting history so recorded positions stay attached to their questions", async () => {
    const ui = setup({ linked: true });
    ui.plugin.index.registered.push({ ...ui.plugin.index.registered[0], id: "third", heading: "기존 다음 질문" });
    ui.view.startReview(["q", "third"], "browse");
    await ui.button("너무 쉬움").click();
    await ui.button("너무 쉬움").click();
    await ui.view.setState({ ...ui.view.getState(), queueIndex: 0, answerVisible: true }, {});
    await ui.button("학습 끝에 추가").click();
    expect(ui.view.getState().queue).toEqual(["q", "third", "related"]);
    await ui.button("다음 문제 →").click();
    expect(ui.content()).toContain("기존 다음 질문");
    expect(ui.content()).toContain("이번 학습 평가: 너무 쉬움");
    expect(ui.reviews.third.history).toHaveLength(1);
  });

  it("keeps session navigation and restart from replacing a card while its rating is saving", async () => {
    const ui = setup();
    let finish;
    ui.plugin.store.setReview = (id, state) => new Promise(resolve => {
      finish = () => { ui.reviews[id] = state; resolve(); };
    });
    await ui.button("정답 보기").click();
    const pending = ui.button("너무 쉬움").click();
    await ui.button("대시보드").click();
    ui.view.startReview([], "browse");
    await ui.view.setState({ route: "dashboard", queue: [], queueIndex: 0 }, {});
    expect(ui.view.getState()).toMatchObject({ route: "study", queue: ["q"], queueIndex: 0, sessionMode: "recall" });
    finish(); await pending;
    expect(ui.view.getState().queueIndex).toBe(1);
    expect(ui.reviews.q.history).toHaveLength(1);
    await ui.button("직전 평가 취소").click();
    expect(ui.reviews.q).toBeUndefined();
    expect(ui.view.getState().queueIndex).toBe(0);
  });

  it.each(["navigate", "restart", "close"])("cancels a pending completion popup on %s", async (action) => {
    const ui = setup();
    await ui.button("다음 문제 →").click();
    expect(vi.getTimerCount()).toBe(1);
    if (action === "navigate") ui.view.showDashboard();
    if (action === "restart") ui.view.startReview(["q"]);
    if (action === "close") await ui.view.onClose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.runOnlyPendingTimersAsync();
    expect(ui.reviews).toEqual({});
  });

  it("marks the index ready only after its first load and retains it during a rebuild", async () => {
    let finishRead;
    const file = { path: "bank.md", extension: "md" };
    const app = { vault: {
      getMarkdownFiles: () => [file],
      cachedRead: () => new Promise(resolve => { finishRead = resolve; }),
    } };
    const bank = "### 질문\n\n> [!question] 문제\n> 질문입니다.\n\n^mia-q-ready\n\n#### 풀이\n\n정답입니다.";
    const index = new QuestionIndex(app, () => []);
    const first = index.rebuild();
    expect(index.isReady).toBe(false);
    finishRead(bank);
    await first;
    expect(index.isReady).toBe(true);
    expect(index.questionById("mia-q-ready")).toBeDefined();
    const second = index.rebuild();
    expect(index.questionById("mia-q-ready")).toBeDefined();
    finishRead(bank);
    await second;
    expect(index.questionById("mia-q-ready")).toBeDefined();
  });

  it("preserves a restored question while the initial index is loading", async () => {
    const ui = setup({ start: false });
    const loaded = ui.plugin.index;
    ui.plugin.index = { isReady: false, registered: [], questionById: () => undefined };
    const restored = { route: "study", queue: ["q"], queueIndex: 0, answerVisible: false, sessionMode: "recall" };
    await ui.view.setState(restored, {});
    expect(ui.content()).toContain("문제를 불러오는 중");
    expect(ui.content()).not.toContain("학습 완료");
    expect(ui.view.getState()).toEqual({ ...restored, reviewCheckpoint: { id: "q", version: null } });
    ui.plugin.index = loaded;
    await ui.view.setState(ui.view.getState(), {});
    expect(ui.content()).toContain("1 / 1");
    expect(ui.button("정답 보기")).toBeDefined();
    expect(ui.view.getState().queueIndex).toBe(0);
    expect(ui.reviews).toEqual({});
    await ui.button("다음 문제 →").click();
    await ui.button("같은 범위 다시 학습").click();
    expect(ui.view.getState().queue).toEqual(["q"]);
    expect(ui.view.getState().queueIndex).toBe(0);
    expect(ui.button("정답 보기")).toBeDefined();
  });

  it("waits after Again, automatically hides the answer on reappearance, accumulates Good and undoes just that attempt", async () => {
    const ui = setup();
    await ui.button("정답 보기").click();
    await ui.button("못 암기").click();
    expect(ui.content()).toContain("다음 복습 대기 중");
    expect(ui.reviews.q.history).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(ui.content()).toContain("다음 복습 대기 중");
    await vi.advanceTimersByTimeAsync(1);
    expect(ui.content()).toContain("2 / 2");
    expect(ui.button("정답 보기")).toBeDefined();
    await ui.button("정답 보기").click();
    await ui.button("암기").click();
    expect(ui.reviews.q.history.map(log => log.rating)).toEqual([Rating.Again, Rating.Good]);
    expect(ui.content()).toContain("다음 복습 대기 중");
    await ui.button("직전 평가 취소").click();
    expect(ui.reviews.q.history.map(log => log.rating)).toEqual([Rating.Again]);
    expect(ui.view.getState().queueIndex).toBe(1);
  });

  it("replacing the same appearance replaces its rating rather than adding another repetition", async () => {
    const ui = setup();
    await ui.button("정답 보기").click(); await ui.button("못 암기").click();
    await ui.button("직전 평가 취소").click();
    expect(ui.reviews.q).toBeUndefined();
    await ui.button("너무 쉬움").click();
    expect(ui.reviews.q.history).toHaveLength(1);
    expect(ui.reviews.q.lastRating).toBe(Rating.Easy);
    expect(ui.content()).toContain("학습 완료");
    expect(ui.content()).not.toContain("다음 복습 대기 중");
  });

  it("keeps the current card and enables retry when saving fails", async () => {
    const ui = setup({ failSave: true });
    await ui.button("정답 보기").click(); await ui.button("못 암기").click();
    expect(ui.view.getState().queueIndex).toBe(0);
    expect(ui.reviews.q).toBeUndefined();
    expect(ui.button("못 암기").disabled).toBe(false);
  });

  it("drops a stale repeat after undoing it and correcting the first grade", async () => {
    const ui = setup();
    await ui.button("정답 보기").click(); await ui.button("못 암기").click();
    await vi.advanceTimersByTimeAsync(60_000);
    await ui.button("정답 보기").click(); await ui.button("암기").click();
    await ui.button("직전 평가 취소").click();
    await ui.button("← 이전 문제").click(); await ui.button("너무 쉬움").click();
    expect(ui.reviews.q.history).toHaveLength(1);
    expect(ui.content()).toContain("학습 완료");
    expect(ui.view.getState().queue).toEqual(["q"]);
    await ui.button("직전 평가 취소").click();
    expect(ui.reviews.q).toBeUndefined();
  });
});


describe("return and quick recovery", () => {
  it.each(["dashboard", "study"])("keeps the pending tap target on unchanged %s focus", async route => {
    const ui = setup({ start: route === "study" });
    if (route === "dashboard") await ui.view.setState({ route, queue: [], queueIndex: 0, answerVisible: false, sessionMode: "recall" }, {});
    ui.plugin.store.synchronize = vi.fn().mockResolvedValue(undefined);
    const button = ui.exactButton(route === "study" ? "정답 보기" : "시험 모드 시작");
    await ui.view.refreshAfterReturn(false);
    expect(ui.exactButton(route === "study" ? "정답 보기" : "시험 모드 시작")).toBe(button);
    await button.click();
    expect(ui.view.getState().route).toBe("study");
    if (route === "study") expect(ui.view.getState().answerVisible).toBe(true);
  });

  it("does not replace the search form on an unchanged app return", async () => {
    const ui = setup({ start: false }); ui.plugin.store.synchronize = vi.fn().mockResolvedValue(undefined);
    await ui.view.setState({route:"questions",queue:[],queueIndex:0,answerVisible:false,sessionMode:"recall"},{});
    const form = ui.view.contentEl.children;
    await ui.view.refreshAfterReturn();
    expect(ui.plugin.store.synchronize).toHaveBeenCalledOnce(); expect(ui.view.contentEl.children).toBe(form);
  });
  it("shows immediate recovery, keeps undo after the banner expires, and restores the original rating", async () => {
    const ui = setup({ linked: true }); ui.view.startReview(["q", "related"]);
    await ui.button("정답 보기").click(); await ui.button("암기").click();
    expect(ui.content()).toContain("암기 평가 저장됨");
    expect(ui.reviews.q.history).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8000);
    expect(ui.view.undoFeedback).toBe(""); expect(ui.button("직전 평가 취소")).toBeDefined();
    await ui.button("직전 평가 취소").click();
    expect(ui.view.getState().queueIndex).toBe(0); expect(ui.reviews.q).toBeUndefined();
  });
});

// Real storage and synchronization; only the host persistence boundary is replaced.
async function persistentSession(){
  const ui=setup({start:false});let disk=null;
  const native={loadData:async()=>structuredClone(disk),saveData:async value=>{disk=structuredClone(value);}};
  const store=new MiaDataStore(native);await store.load();ui.plugin.store=store;
  const remote=new MiaDataStore(native);await remote.load();
  ui.view.startReview(["q"],"browse");
  return {...ui,store,remote,native,disk:()=>structuredClone(disk)};
}

describe("session synchronization boundaries",()=>{
  it("rejects a displayed grade after a synchronized review changed without rendering again",async()=>{
    const ui=await persistentSession();
    const remoteState=ui.plugin.fsrs.rate(undefined,Rating.Easy,new Date(),"q");
    await ui.remote.setReview("q",remoteState);await ui.store.synchronize();
    await ui.button("암기").click();
    expect(ui.store.getReview("q")).toEqual(remoteState);expect(ui.disk().reviews.q).toEqual(remoteState);
    expect(ui.view.getState().queueIndex).toBe(0);expect(ui.view.sessionBaselines.size).toBe(0);
  });
  it.each([false,true])("rejects replacing this session's grade after an external grade, with re-render %s",async rerender=>{
    const ui=await persistentSession();await ui.button("너무 쉬움").click();
    await ui.view.setState({...ui.view.getState(),queueIndex:0,answerVisible:true},{});
    const other=ui.plugin.fsrs.rate(ui.remote.getReview("q")??ui.store.getReview("q"),Rating.Good,new Date(),"q");
    await ui.remote.setReview("q",other);await ui.store.synchronize();if(rerender)ui.view.render();
    await ui.button("암기").click();
    expect(ui.disk().reviews.q).toEqual(other);expect(ui.view.getState().queueIndex).toBe(0);
  });
  it("refreshes the baseline after a failed first save and an intervening remote grade",async()=>{
    const ui=await persistentSession();const save=ui.native.saveData;
    ui.native.saveData=async()=>{throw Error("disk full");};await ui.button("암기").click();
    ui.native.saveData=save;
    const other=ui.plugin.fsrs.rate(undefined,Rating.Hard,new Date(),"q");await ui.remote.setReview("q",other);await ui.store.synchronize();ui.view.render();
    await ui.button("너무 쉬움").click();
    expect(ui.store.getReview("q").history).toHaveLength(2);expect(ui.store.getReview("q").history[0]).toEqual(other.history[0]);
  });
  it("retains an external grade when undoing this session's outdated grade",async()=>{
    const ui=await persistentSession();await ui.button("너무 쉬움").click();
    const other=ui.plugin.fsrs.rate(ui.store.getReview("q"),Rating.Good,new Date(),"q");
    await ui.remote.setReview("q",other);await ui.store.synchronize();
    await ui.button("직전 평가 취소").click();
    expect(ui.disk().reviews.q).toEqual(other);expect(ui.view.lastRated).not.toBeNull();
  });
  it("uses the click time and current settings after a long answer-reading pause",async()=>{
    const ui=await persistentSession();const button=ui.button("너무 쉬움");
    vi.setSystemTime(new Date(Date.now()+2*86400000));
    ui.plugin.fsrs=new FsrsService({targetRetention:.99,maximumIntervalDays:1});
    const expected=ui.plugin.fsrs.rate(undefined,Rating.Easy,new Date(),"q");await button.click();
    expect(ui.store.getReview("q")).toEqual(expected);
    expect(ui.store.getReview("q").card.last_review).toBe(new Date().toISOString());
  });
});

describe("late input and clock changes",()=>{
  it("ignores a queued click from the previous question after navigating",async()=>{
    const ui=await persistentSession();
    ui.plugin.index.registered.push({...ui.plugin.index.registered[0],id:"other",heading:"다음 질문"});
    ui.view.startReview(["q","other"],"browse");const stale=ui.button("너무 쉬움");
    await ui.button("다음 문제 →").click();await stale.handlers.get("click")();
    expect(ui.store.getReview("q")).toBeUndefined();expect(ui.store.getReview("other")).toBeUndefined();
    expect(ui.view.getState().queueIndex).toBe(1);
  });
  it("keeps the screen usable when the device clock goes behind the latest review",async()=>{
    const ui=await persistentSession();await ui.button("너무 쉬움").click();
    const original=structuredClone(ui.store.getReview("q"));vi.setSystemTime(new Date(Date.now()-86400000));
    await expect(ui.view.setState({...ui.view.getState(),queueIndex:0,answerVisible:true},{})).resolves.toBeUndefined();
    await ui.button("암기").click();
    expect(ui.store.getReview("q")).toEqual(original);expect(ui.view.getState().queueIndex).toBe(0);
    expect(ui.button("암기").disabled).toBe(false);
  });
});

describe("exact baseline undo for mature reviews",()=>{
 it.each([-86400000,0,3*86400000])("restores the exact original due and history when rated %s ms relative to due",async offset=>{
  const ui=await persistentSession();const original=ui.plugin.fsrs.rate(undefined,Rating.Easy,new Date("2026-09-01T00:00:00Z"),"q");
  await ui.store.setReview("q",original);vi.setSystemTime(new Date(Date.parse(original.card.due)+offset));
  await ui.view.setState({route:"study",queue:["q"],queueIndex:0,answerVisible:true,sessionMode:"browse"},{});
  await ui.button("못 암기").click();expect(ui.store.getReview("q").history).toHaveLength(2);
  await ui.button("직전 평가 취소").click();await vi.waitFor(()=>expect(ui.view.isMutatingReview).toBe(false));
  expect(ui.store.getReview("q")).toEqual(original);expect(ui.disk().reviews.q).toEqual(original);
 });
});


describe("pending save feedback and closed view lifetime",()=>{
 function pendingSave(ui){let finish;ui.plugin.store.setReview=vi.fn((id,state)=>new Promise(resolve=>{finish=()=>{ui.reviews[id]=state;resolve();};}));return()=>finish();}
 it("announces saving immediately and retains it across a render while accepting one grade",async()=>{
  const ui=setup();await ui.button("정답 보기").click();const finish=pendingSave(ui),button=ui.button("암기"),pending=button.click();
  expect(ui.content()).toContain("평가 저장 중");expect(ui.view.contentEl.attrs['aria-busy']).toBe('true');ui.view.render();
  expect(ui.content()).toContain("평가 저장 중");expect(ui.button("암기").disabled).toBe(true);
  await button.handlers.get("click")();expect(ui.plugin.store.setReview).toHaveBeenCalledOnce();finish();await pending;
  expect(ui.view.contentEl.attrs['aria-busy']).toBe('false');expect(ui.content()).not.toContain("평가 저장 중");
 });
 it("does not create a feedback timer or focus the closed view after a successful save",async()=>{
  const ui=setup();await ui.button("정답 보기").click();const finish=pendingSave(ui),pending=ui.button("암기").click();
  await ui.view.onClose();const focus=vi.spyOn(ui.view.contentEl,'focus'),timers=vi.getTimerCount();finish();await pending;
  expect(ui.reviews.q.history).toHaveLength(1);expect(vi.getTimerCount()).toBe(timers);expect(focus).not.toHaveBeenCalled();
 });
 it("retains an unchanged resume at the advanced position after closing during saving",async()=>{
  const ui=setup();await ui.button("정답 보기").click();const finish=pendingSave(ui),pending=ui.button("암기").click();
  await ui.view.onClose();finish();await pending;await ui.plugin.studyUi.load();
  expect(ui.plugin.studyUi.resume.queueIndex).toBe(1);expect(ui.reviews.q.history).toHaveLength(1);
 });
 it("does not overwrite a newer session started by another view while saving",async()=>{
  const ui=setup();await ui.button("정답 보기").click();const finish=pendingSave(ui),pending=ui.button("너무 쉬움").click();await ui.view.onClose();
  const newer={queue:['other'],seed:['other'],skipped:[],queueIndex:0,answerVisible:false,sessionMode:'recall',updatedAt:new Date().toISOString()};await ui.plugin.studyUi.saveResume(newer);
  finish();await pending;await ui.plugin.studyUi.load();expect(ui.plugin.studyUi.resume).toEqual(newer);expect(ui.reviews.q.history).toHaveLength(1);
 });
 it("clears reading/learning/feedback timers and unloads its component only once",async()=>{
  const ui=setup();await ui.button("정답 보기").click();await ui.button("못 암기").click();ui.view.scheduleReadingSave();
  const component=ui.view.renderComponent,unload=vi.spyOn(component,'unload'),unsubscribe=vi.fn();ui.view.unsubscribers=[unsubscribe];
  await ui.view.onClose();await ui.view.onClose();expect(vi.getTimerCount()).toBe(0);expect(unload).toHaveBeenCalledOnce();expect(unsubscribe).toHaveBeenCalledOnce();expect(ui.view.renderComponent).toBeNull();
 });
 it("does not focus a closed view after a pending undo completes",async()=>{
  const ui=setup();await ui.button("정답 보기").click();await ui.button("너무 쉬움").click();let finish;
  ui.plugin.store.removeReview=()=>new Promise(resolve=>{finish=()=>{delete ui.reviews.q;resolve();};});
  const undo=ui.view.undoLastRating();expect(ui.content()).toContain("평가 취소 중");await ui.view.onClose();const focus=vi.spyOn(ui.view.contentEl,'focus');finish();await undo;
  expect(ui.reviews.q).toBeUndefined();expect(focus).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
 });
});


describe("save feedback recovery and return cancellation",()=>{
 it("clears the status and restores input after a rejected save",async()=>{
  const ui=setup({failSave:true});await ui.button("정답 보기").click();const pending=ui.button("암기").click();
  expect(ui.view.contentEl.querySelector('.mia-save-status').attrs.role).toBe('status');await pending;
  expect(ui.view.contentEl.attrs['aria-busy']).toBe('false');expect(ui.view.contentEl.querySelector('.mia-save-status')).toBeNull();expect(ui.button("암기").disabled).toBe(false);expect(ui.reviews.q).toBeUndefined();
 });
 it("does not start another resume read after closing during return synchronization",async()=>{
  const ui=setup();let finish;ui.plugin.store.synchronize=()=>new Promise(resolve=>{finish=resolve;});const load=vi.spyOn(ui.plugin.studyUi,'load');
  const refresh=ui.view.refreshAfterReturn();await ui.view.onClose();finish();await refresh;expect(load).not.toHaveBeenCalled();expect(ui.view.refreshingAfterReturn).toBe(false);
 });
});

it.each(["grade", "undo"])("does not replace a reloaded instance's session after an old pending %s finishes", async action => {
  const ui = setup(); await ui.button("정답 보기").click();
  if (action === "undo") { await ui.button("너무 쉬움").click(); await ui.plugin.studyUi.load(); }
  let finish;
  if (action === "grade") ui.plugin.store.setReview = vi.fn((id, state) => new Promise(resolve => { finish = () => { ui.reviews[id] = state; resolve(); }; }));
  else ui.plugin.store.removeReview = vi.fn(id => new Promise(resolve => { finish = () => { delete ui.reviews[id]; resolve(); }; }));
  const pending = action === "grade" ? ui.button("암기").click() : ui.view.undoLastRating();
  await ui.view.onClose();
  const restarted = new StudyUiStore(ui.studyApp, "ui-state.json");
  const newer = { queue: ["other"], seed: ["other"], skipped: [], queueIndex: 0, answerVisible: false, sessionMode: "recall", updatedAt: new Date().toISOString() };
  await restarted.saveResume(newer); finish(); await pending; await ui.plugin.studyUi.load();
  expect(JSON.parse(ui.files.get("ui-state.json")).resume).toEqual(newer);
  expect(action === "grade" ? ui.reviews.q.history.length : ui.reviews.q).toBe(action === "grade" ? 1 : undefined);
});

it.each(["resume", "workspace"])("does not replay a committed rating from an older %s position", async source => {
  const first = await persistentSession(); await first.plugin.studyUi.load();
  const workspace = first.view.getState(), resume = first.plugin.studyUi.resume;
  // Primary commit succeeds; the process stops before the next UI checkpoint.
  const accepted = first.plugin.fsrs.rate(undefined, Rating.Good, new Date(), "q");
  await first.store.setReview("q", accepted);
  const restored = setup({ start: false }); restored.plugin.store = new MiaDataStore(first.native); await restored.plugin.store.load();
  // A different App and store reproduce a fresh process, with the old synced UI snapshot.
  const disk = new Map([["ui-state.json", JSON.stringify({ version: 1, resume })]]);
  const app = { loadLocalStorage: () => null, saveLocalStorage() {}, vault: { adapter: { exists: async p => disk.has(p), read: async p => disk.get(p), write: async (p,v) => { disk.set(p,v); } } } };
  restored.plugin.studyUi = new StudyUiStore(app, "ui-state.json");
  if (source === "resume") await restored.view.resumeStudy();
  else await restored.view.setState(workspace, {});
  expect(restored.view.getState().queueIndex).toBe(1);
  expect(restored.button("암기")).toBeUndefined();
  expect(restored.content()).toContain("다음 복습 대기 중");
  expect(restored.plugin.store.getReview("q")).toEqual(accepted);
});

it.each(["unchanged", "reset"])("keeps an uncommitted or reset question available on resume: %s", async action => {
  const first = await persistentSession();
  if (action === "reset") await first.store.setReview("q", first.plugin.fsrs.rate(undefined, Rating.Good, new Date(), "q"));
  // Use an old UI snapshot while the authoritative review is reset or unchanged.
  first.view.saveStudyPosition(); await first.plugin.studyUi.load(); const snapshot = first.plugin.studyUi.resume;
  if (action === "reset") await first.store.removeReview("q");
  const restored = setup({ start: false }); restored.plugin.store = new MiaDataStore(first.native); await restored.plugin.store.load();
  await restored.plugin.studyUi.saveResume(snapshot); await restored.view.resumeStudy();
  expect(restored.view.getState().queueIndex).toBe(0);
  expect(restored.button("암기")).toBeDefined();
});
it("keeps explicit history navigation available in an existing session", async () => {
  const ui = await persistentSession(); const before = ui.view.getState();
  await ui.button("암기").click(); await ui.view.setState(before, {});
  expect(ui.view.getState().queueIndex).toBe(0); expect(ui.button("암기")).toBeDefined();
});


it("keeps the pre-commit version in a workspace snapshot while the rating promise is pending", async () => {
  const ui = await persistentSession(); const original = ui.store.setReview.bind(ui.store);
  let release, committed;
  const commitReached = new Promise(resolve => { committed = resolve; });
  ui.store.setReview = async (...args) => { await original(...args); committed(); await new Promise(resolve => { release = resolve; }); };
  const pending = ui.button("암기").click(); await commitReached;
  expect(ui.store.getReview("q").history).toHaveLength(1);
  const snapshot = ui.view.getState();
  release(); await pending;
  expect(snapshot.queueIndex).toBe(0); expect(snapshot.reviewCheckpoint).toEqual({ id: "q", version: null });
});


describe("memorization ordering and back navigation", () => {
  it("preserves source order for eligible questions and keeps the chosen queue on resume", async () => {
    const ui = setup({ start: false }); const template = ui.plugin.index.registered[0];
    ui.plugin.index.registered.splice(0, 1, ...["new-b", "future", "due-z", "new-a", "due-a"].map(id => ({ ...template, id, heading: id })));
    for (const id of ["due-z", "due-a"]) ui.reviews[id] = ui.plugin.fsrs.rate(undefined, Rating.Easy, new Date(Date.now() - 30 * 86_400_000));
    ui.reviews.future = ui.plugin.fsrs.rate(undefined, Rating.Easy);
    ui.plugin.studyUi.updateAppearance({ memorizationOrder: "sequential" });
    ui.view.startReview(undefined, "browse");
    expect(ui.view.getState().queue).toEqual(["new-b", "due-z", "new-a", "due-a"]);
    ui.plugin.studyUi.updateAppearance({ memorizationOrder: "random" });
    ui.view.showDashboard(); await ui.button("이어하기").click();
    expect(ui.view.getState().queue).toEqual(["new-b", "due-z", "new-a", "due-a"]);
    ui.plugin.studyUi.updateAppearance({ memorizationOrder: "sequential" });
    Math.random.mockReturnValue(0);
    ui.view.startReview(undefined, "recall");
    expect(ui.view.getState().queue).toEqual(["due-z", "due-a", "new-a", "new-b"]);
  });
  it.each(["recall", "browse"])("backs out of %s while keeping the question and resume position", async mode => {
    const ui = setup({ start: false }); ui.view.startReview(undefined, mode);
    const before = ui.view.getState(); ui.view.returnToSessionOrigin();
    expect(ui.view.getState()).toMatchObject({ route: "dashboard", queueIndex: before.queueIndex, queue: before.queue });
    await ui.button("이어하기").click();
    expect(ui.view.getState()).toMatchObject(before);
  });
});

it.each([[90, "90분"], [36 * 60, "36시간"], [45 * 1440, "45일"], [36500 * 1440 - 1, "52559999분"], [1440, "1일"]])("shows a fixed interval of %s minutes exactly and saves that duration", async (minutes, label) => {
  const ui = setup({ start: false });
  ui.plugin.fsrs = new FsrsService({ targetRetention: .9, maximumIntervalDays: 36500, gradeIntervalsMinutes: { 3: minutes } });
  ui.view.startReview(["q"], "browse");
  expect(ui.button("암기").content).toContain(label);
  const now = Date.now();
  await ui.button("암기").click();
  expect(Date.parse(ui.reviews.q.card.due) - now).toBe(minutes * 60000);
});


describe("question-only markdown rendering", () => {
  it.each(["$E=mc^2$", "$\\frac{a}{b}$"])('renders a matching heading and prompt once: %s', text => {
    const ui = setup({ start: false });
    Object.assign(ui.plugin.index.registered[0], { heading: text, questionMarkdown: text });
    const render = vi.spyOn(MarkdownRenderer, "render");
    ui.view.startReview(["q"]);
    const calls = render.mock.calls.filter(call => call[1] === text);
    expect(calls).toHaveLength(1);
    expect(calls[0][2].tag).toBe("h2");
    expect(calls[0][3]).toBe("bank.md");
  });
});


describe("resume and related question math headings", () => {
  it("renders the saved question heading on the dashboard and after resuming", async () => {
    const ui = setup({ start: false });
    Object.assign(ui.plugin.index.registered[0], { heading: "$E=mc^2$", questionMarkdown: "Explain energy." });
    ui.view.startReview(["q"]); await ui.plugin.studyUi.load();
    const render = vi.spyOn(MarkdownRenderer, "render");
    ui.view.showDashboard();
    expect(render.mock.calls.some(c => c[1] === "$E=mc^2$" && c[2].tag === "h3" && c[3] === "bank.md")).toBe(true);
    render.mockClear(); await ui.button("이어하기").click();
    expect(render.mock.calls.some(c => c[1] === "$E=mc^2$" && c[2].tag === "h2")).toBe(true);
    expect(ui.view.getState()).toMatchObject({ route: "study", queue: ["q"], queueIndex: 0 });
  });
  it("renders related question button headings and retains the preview action", async () => {
    const ui = setup({ start: false, linked: true });
    Object.assign(ui.plugin.index.registered[1], { heading: "$F=qvB$", questionMarkdown: "Explain force." });
    const render = vi.spyOn(MarkdownRenderer, "render");
    ui.view.startReview(["q"]); await ui.button("정답 보기").click();
    expect(render.mock.calls.some(c => c[1] === "$F=qvB$" && c[2].tag === "strong" && c[3] === "bank.md")).toBe(true);
    await ui.button("$F=qvB$").click();
    expect(ui.plugin.openQuestionPreview).toHaveBeenCalledWith(expect.objectContaining({ id: "related" }), expect.any(Function));
  });
});


describe("running plugin version", () => {
  it("shows the loaded manifest version beside the brand on dashboard and study", () => {
    const ui = setup({ start: false });
    ui.plugin.manifest.version = "9.8.7-test";
    ui.view.showDashboard();
    expect(ui.content()).toContain("Major Study v9.8.7-test");
    ui.view.startReview(["q"]);
    expect(ui.content()).toContain("Major Study v9.8.7-test");
  });
});

describe("cross-device record refresh",()=>{
  it("loads another device's grades, study settings and resume together from home",async()=>{
    const ui=await persistentSession();ui.view.showDashboard();await ui.plugin.studyUi.load();
    const appearance=ui.plugin.studyUi.appearance;
    await ui.remote.updateSettings({studyManagement:{...structuredClone(DEFAULT_SETTINGS.studyManagement),newCardsPerDay:7}});
    const grade=ui.plugin.fsrs.rate(undefined,Rating.Easy,new Date(),"q");await ui.remote.setReview("q",grade);
    // A second device has its own local checkpoint and receives the same vault files.
    const otherApp={...ui.studyApp,loadLocalStorage:()=>null,saveLocalStorage(){}};
    const otherUi=new StudyUiStore(otherApp,"ui-state.json");await otherUi.load();
    await otherUi.saveResume({...ui.plugin.studyUi.resume,answerVisible:false,updatedAt:new Date(Date.now()+1000).toISOString()});
    expect(ui.store.getReview("q")).toBeUndefined();expect(ui.store.settings.studyManagement.newCardsPerDay).toBe(20);
    await ui.exactButton("기록 새로고침").click();
    expect(ui.store.getReview("q")).toEqual(grade);expect(ui.store.settings.studyManagement.newCardsPerDay).toBe(7);
    expect(ui.plugin.studyUi.resume.answerVisible).toBe(false);expect(ui.plugin.studyUi.appearance).toEqual(appearance);
  });
  it("allows retry after a read failure without changing existing reviews or resume",async()=>{
    const ui=await persistentSession();ui.view.showDashboard();await ui.plugin.studyUi.load();
    const original=ui.plugin.studyUi.resume;
    vi.spyOn(ui.native,"loadData").mockRejectedValueOnce(Error("unavailable"));
    await ui.exactButton("기록 새로고침").click();
    expect(ui.exactButton("기록 새로고침").disabled).toBe(false);expect(ui.plugin.studyUi.resume).toEqual(original);expect(ui.store.reviews).toEqual({});
    await ui.exactButton("기록 새로고침").click();expect(ui.plugin.studyUi.resume).toEqual(original);
  });
});

it.each(["recall", "browse"])("hides generated source attribution in %s without changing the stored answer", async mode => {
  const ui = setup({ start: false });
  const question = ui.plugin.index.registered[0];
  const stored = "답안 본문\n\n---\n원문: [[과목/원본|링크]] · &lt;09. 단원명&gt;";
  question.answerMarkdown = stored;
  await ui.view.setState({ route: "study", queue: ["q"], queueIndex: 0, answerVisible: true, sessionMode: mode }, {});
  expect(ui.content()).toContain("답안 본문");
  expect(ui.content()).not.toContain("원문:");
  expect(ui.exactButton("원문 열기")).toBeUndefined();
  expect(question.answerMarkdown).toBe(stored);
  expect(ui.button("암기")).toBeDefined();
});

describe("dashboard task guidance", () => {
  it("offers first-question entry instead of reporting a finished study day in an empty vault", async () => {
    const ui = setup({ start: false });
    ui.plugin.index.registered.splice(0);
    ui.plugin.openManagedQuestionEditor = vi.fn();
    ui.view.showDashboard();
    expect(ui.content()).toContain("첫 질문을 추가해 보세요");
    expect(ui.content()).not.toContain("오늘 학습을 마쳤습니다");
    await ui.exactButton("첫 질문 추가").click();
    expect(ui.plugin.openManagedQuestionEditor).toHaveBeenCalledOnce();
  });
  it("explains a daily limit and provides direct access to the existing learning settings", async () => {
    const ui = setup({ start: false });
    ui.plugin.store.settings.studyManagement.newCardsPerDay = 0;
    ui.view.showDashboard();
    expect(ui.content()).toContain("하루 학습량 제한");
    expect(ui.content()).not.toContain("오늘 학습을 마쳤습니다");
    expect(ui.exactButton("시험 모드 시작").disabled).toBe(true);
    const before = modalBoundary.instances.length;
    await ui.exactButton("학습량 확인").click();
    expect(modalBoundary.instances.length).toBe(before + 1);
    expect(modalBoundary.instances.at(-1)).toBeInstanceOf(StudyManagementModal);
  });
});


describe("edit the current saved question from an active session", () => {
  for (const mode of ["browse", "recall"]) {
    it(`${mode}: targets the ID despite duplicate text and hidden filters, returns without resetting the session`, async () => {
      const ui = setup({ linked: true });
      ui.plugin.index.registered[1].questionMarkdown = "질문";
      ui.view.startReview(["related", "q"], mode);
      ui.view.moveToQuestion(ui.view.queue.indexOf("related"));
      ui.view.questionText = "no matching question"; ui.view.questionSubject = "hidden";
      ui.view.questionSort = "updated";
      const state = structuredClone(ui.view.getState());
      const startedAt = ui.view.sessionStartedAt;
      expect(ui.content().includes("모범 답안")).toBe(mode === "browse");
      await ui.exactButton("문제 편집").click();
      const [original, closed, saved] = ui.plugin.openManagedQuestionEditor.mock.calls[0];
      expect(original.id).toBe("related");
      expect(ui.content()).toContain("현재 학습 문제");
      expect(ui.content()).toContain("기존 검색·필터·정렬은 유지");
      expect(ui.view.questionText).toBe("no matching question");
      ui.plugin.index.registered[1] = { ...original, questionMarkdown: "수정된 질문", answerMarkdown: "수정된 답변" };
      saved();
      await vi.advanceTimersByTimeAsync(75_000);
      closed();
      expect(ui.view.getState()).toMatchObject(state);
      expect(ui.view.sessionStartedAt).toBe(startedAt);
      expect(ui.content()).toContain("수정된 질문");
      if(mode === "recall") { expect(ui.content()).not.toContain("수정된 답변"); await ui.exactButton("정답 보기").click(); }
      expect(ui.content()).toContain("수정된 답변");
      expect(ui.view.questionSort).toBe("updated");
      expect(ui.plugin.index.registered[0].answerMarkdown).toBe("정답");
    });
    it(`${mode}: cancellation preserves content and prior ratings, changed answers explicitly retain grades`, async () => {
      const ui = setup(); ui.view.startReview(["q"], mode);
      ui.view.sessionAttempts.set(0, {id:"q",grade:Rating.Good});
      const attempts = structuredClone([...ui.view.sessionAttempts]);
      await ui.exactButton("문제 편집").click();
      ui.plugin.openManagedQuestionEditor.mock.calls[0][1]();
      expect(ui.plugin.index.questionById("q").answerMarkdown).toBe("정답");
      expect([...ui.view.sessionAttempts]).toEqual(attempts);
      await ui.exactButton("문제 편집").click();
      const [,closed,saved] = ui.plugin.openManagedQuestionEditor.mock.calls[1];
      ui.plugin.index.registered[0] = {...ui.plugin.index.registered[0],answerMarkdown:"새 정답"}; saved(); closed();
      expect([...ui.view.sessionAttempts]).toEqual(attempts);
      expect(ui.content()).toContain("자동 재채점되지 않습니다");
    });
    it(`${mode}: a deleted source never redirects to another question`, async () => {
      const ui = setup({linked:true}); ui.view.startReview(["q","related"], mode);
      await ui.exactButton("문제 편집").click();
      ui.plugin.index.registered.splice(0,1);
      ui.plugin.openManagedQuestionEditor.mock.calls[0][1]();
      expect(ui.view.queueIndex).toBe(0);
      expect(ui.content()).toContain("원본 문제가 삭제되었거나 찾을 수 없습니다");
      expect(ui.content()).not.toContain("꼬리질문");
    });
  }
  it("an editor load failure returns to the same question", async () => {
    const ui=setup(); const state=structuredClone(ui.view.getState());
    ui.plugin.openManagedQuestionEditor.mockRejectedValueOnce(Error("missing source"));
    await ui.view.editSessionQuestion("q");
    expect(ui.view.getState()).toMatchObject(state);
    expect(ui.view.editingSessionQuestion).toBeNull();
  });
});

it("warns about retained historical ratings when editing an answer before rating in this session",async()=>{
  const ui=setup();ui.reviews.q=ui.plugin.fsrs.rate(undefined,Rating.Good,new Date(),"q");
  const before=structuredClone(ui.reviews.q);
  await ui.exactButton("문제 편집").click();const [,closed,saved]=ui.plugin.openManagedQuestionEditor.mock.calls[0];
  ui.plugin.index.registered[0]={...ui.plugin.index.registered[0],answerMarkdown:"고친 정답"};saved();closed();
  expect(ui.reviews.q).toEqual(before);expect(ui.content()).toContain("자동 재채점되지 않습니다");
});


describe("session editor asynchronous lifetime",()=>{
  for(const mode of ["browse","recall"]) {
    it(`${mode}: late close of A must not return from a newer B edit`,async()=>{
      const ui=setup({linked:true});ui.view.startReview(["q","related"],mode);
      await ui.view.editSessionQuestion("q");const a=ui.plugin.openManagedQuestionEditor.mock.calls[0];
      ui.view.returnFromQuestionEditor();ui.view.moveToQuestion(ui.view.queue.indexOf("related"));
      await ui.view.editSessionQuestion("related");const b=ui.plugin.openManagedQuestionEditor.mock.calls[1];
      a[1]();expect(ui.view.route).toBe("questions");expect(ui.view.editingSessionQuestion).toBe("related");
      b[1]();expect(ui.view.route).toBe("study");expect(ui.view.queue[ui.view.queueIndex]).toBe("related");
    });
    it(`${mode}: old failure must not close a newer edit`,async()=>{
      const ui=setup({linked:true});ui.view.startReview(["q","related"],mode);let fail;
      ui.plugin.openManagedQuestionEditor.mockImplementationOnce(()=>new Promise((_resolve,reject)=>{fail=reject;}));
      const pending=ui.view.editSessionQuestion("q");ui.view.returnFromQuestionEditor();
      ui.view.moveToQuestion(ui.view.queue.indexOf("related"));await ui.view.editSessionQuestion("related");
      fail(Error("late A read failure"));await pending;
      expect(ui.view.route).toBe("questions");expect(ui.view.editingSessionQuestion).toBe("related");
    });
    it(`${mode}: workspace navigation while A loads must invalidate its return callback`,async()=>{
      const ui=setup({linked:true});ui.view.startReview(["q","related"],mode);
      await ui.view.editSessionQuestion("q");const a=ui.plugin.openManagedQuestionEditor.mock.calls[0];
      await ui.view.setState({...ui.view.getState(),route:"dashboard"},{});
      a[1]();expect(ui.view.route).toBe("dashboard");
    });
  }
});

describe("repeated session editing",()=>{
  for(const mode of ["browse","recall"]) {
    it(`${mode}: deduplicates repeated edit clicks during loading`,async()=>{
      const ui=setup();ui.view.startReview(["q"],mode);let resolve;
      ui.plugin.openManagedQuestionEditor.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
      const pending=ui.view.editSessionQuestion("q");await ui.view.editSessionQuestion("q");
      expect(ui.plugin.openManagedQuestionEditor).toHaveBeenCalledOnce();resolve();await pending;
    });
    it(`${mode}: twenty edit/cancel round trips preserve timer count and elapsed time`,async()=>{
      const ui=setup();ui.view.startReview(["q"],mode);await vi.advanceTimersByTimeAsync(1000);
      const started=ui.view.sessionStartedAt,before=vi.getTimerCount(),queue=[...ui.view.queue];
      for(let i=0;i<20;i++){await ui.view.editSessionQuestion("q");ui.plugin.openManagedQuestionEditor.mock.calls.at(-1)[1]();}
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ui.view.sessionStartedAt).toBe(started);expect(vi.getTimerCount()).toBe(before);expect(ui.view.queue).toEqual(queue);
      expect(ui.view.studyResult().durationSeconds).toBe(61);
    });
    it(`${mode}: a late save for A cannot change B's current view or answer visibility`,async()=>{
      const ui=setup({linked:true});ui.view.startReview(["q","related"],mode);ui.view.sessionAttempts.set(0,{id:"q",grade:Rating.Good});
      await ui.view.editSessionQuestion("q");const a=ui.plugin.openManagedQuestionEditor.mock.calls[0];
      ui.view.returnFromQuestionEditor();ui.view.moveToQuestion(ui.view.queue.indexOf("related"));const state=structuredClone(ui.view.getState());
      ui.plugin.index.registered[0]={...ui.plugin.index.registered[0],answerMarkdown:"지연 저장 A"};a[2]();a[1]();
      expect(ui.view.getState()).toMatchObject(state);expect(ui.content()).toContain("꼬리질문");expect(ui.content()).not.toContain("지연 저장 A");
    });
  }
});

it("retains the returned edit button focus when a later index notification rerenders the same question",()=>{
  const ui=setup();const button=ui.exactButton("문제 편집");ui.view.contentEl.ownerDocument={activeElement:button};
  ui.view.render();const replacement=ui.exactButton("문제 편집");expect(replacement).not.toBe(button);expect(replacement.focused).toBe(true);
});

// Literal workloads and hand-authored mixed records exercise the view and real
// storage/scheduler together; expected counts do not read production presets.
describe("simple settings real study flow", () => {
  async function mixed(settingsPatch = {}) {
    vi.setSystemTime(new Date(2026,9,27,12));
    const { simpleStudyFixture } = await import("./fixtures/simple-study-flow");
    const fixture = simpleStudyFixture(new Date());
    const ui = setup({start:false});
    const settings = structuredClone(DEFAULT_SETTINGS);
    Object.assign(settings.studyManagement, settingsPatch);
    let disk = {version:1,settings,reviews:fixture.reviews};
    const storage={loadData:async()=>structuredClone(disk),saveData:async data=>{disk=structuredClone(data);}};
    const store=new MiaDataStore(storage); await store.load(); ui.plugin.store=store; ui.plugin.fsrs=new FsrsService(store.settings);
    ui.plugin.index.registered=fixture.questions;
    ui.plugin.index.questionById=id=>fixture.questions.find(q=>q.id===id);
    const restartStore=async()=>{const next=new MiaDataStore(storage);await next.load();ui.plugin.store=next;ui.plugin.fsrs=new FsrsService(next.settings);return next;};
    return {...ui,fixture,store,restartStore,disk:()=>structuredClone(disk)};
  }
  it("partially deferred reviews remain visible instead of vanishing behind a smaller queue",async()=>{
    const ui=await mixed({newCardsPerDay:10,reviewsPerDay:100});ui.view.showDashboard();
    expect(ui.content()).toContain("오늘 출제: 복습 91개 · 새 문제 0개 · 전체 대기: 복습 121개 · 새 문제 60개");
    expect(ui.content()).toContain("하루 상한으로 복습 30개");
    expect(ui.content()).toContain("문제와 복습일은 유지");
    ui.view.startReview();expect(ui.view.getState().queue).toHaveLength(91);
  });
  it("grades, restarts, changes settings, resumes the old session, and applies fresh budgets only to new sessions",async()=>{
    const ui=await mixed({newCardsPerDay:10,reviewsPerDay:100});ui.view.startReview();
    await ui.exactButton("정답 보기").click();await ui.button("너무 쉬움").click();
    await ui.exactButton("정답 보기").click();await ui.button("너무 쉬움").click();
    expect(ui.view.getState().queueIndex).toBe(2);
    const savedQueue=ui.view.getState().queue;
    await ui.plugin.studyUi.saveResume({queue:savedQueue,seed:savedQueue,skipped:[],queueIndex:2,answerVisible:false,sessionMode:"recall",updatedAt:new Date().toISOString()});
    await ui.restartStore();
    await ui.plugin.store.updateSettings({studyManagement:{...ui.plugin.store.settings.studyManagement,newCardsPerDay:40,reviewsPerDay:400}});
    ui.plugin.fsrs=new FsrsService(ui.plugin.store.settings);
    const after=structuredClone(ui.plugin.store.reviews);
    await ui.view.resumeStudy();expect(ui.view.getState().queue).toEqual(savedQueue);expect(ui.view.getState().queueIndex).toBe(2);
    ui.view.showDashboard();expect(ui.content()).toContain("복습 119개 · 새 문제 37개");
    ui.view.startReview();expect(ui.view.getState().queue).toHaveLength(156);
    expect(ui.plugin.store.reviews).toEqual(after);
    expect(ui.disk().reviews["mia-q-overdue-0"].history).toHaveLength(2);
    expect(ui.disk().reviews["mia-q-introduced-0"].history).toHaveLength(2);
  });
  it("next grading uses a changed interval direction while the active queue remains untouched",async()=>{
    const ui=await mixed();ui.view.startReview(["mia-q-overdue-0"]);
    const before=structuredClone(ui.view.getState());
    const original=structuredClone(ui.store.getReview("mia-q-overdue-0"));
    await ui.store.updateSettings({targetRetention:.95});ui.plugin.fsrs=new FsrsService(ui.store.settings);ui.view.render();
    expect(ui.view.getState().queue).toEqual(before.queue);expect(ui.store.getReview("mia-q-overdue-0")).toEqual(original);
    await ui.exactButton("정답 보기").click();await ui.button("암기").click();
    const actualDue=Date.parse(ui.store.getReview("mia-q-overdue-0").card.due);
    const sparse=new FsrsService({...ui.store.settings,targetRetention:.85,studyManagement:{...ui.store.settings.studyManagement,enableFuzz:false}}).rate(original,Rating.Good,new Date());
    expect(actualDue).toBeLessThan(Date.parse(sparse.card.due));
  });
  it("shows a limit-reached state at zero, handles a genuinely empty bank, and never pads a small queue",async()=>{
    const ui=await mixed({newCardsPerDay:0,reviewsPerDay:0});
    // Only the short repeat remains at zero; after it is completed there is no scheduled budget.
    ui.view.startReview();expect(ui.view.getState().queue).toEqual(["mia-q-introduced-0"]);
    await ui.exactButton("정답 보기").click();await ui.button("너무 쉬움").click();ui.view.showDashboard();
    expect(ui.content()).toContain("오늘 출제할 문제가 없습니다");expect(ui.content()).toContain("복습 120개");
    expect(ui.exactButton("시험 모드 시작").disabled).toBe(true);
    expect(ui.exactButton("학습량 확인")).toBeDefined();
    ui.plugin.index.registered=[];ui.view.showDashboard();expect(ui.content()).toContain("첫 질문을 추가해 보세요");
    ui.plugin.index.registered=ui.fixture.questions.filter(q=>q.id==="mia-q-overdue-1"||q.id==="mia-q-fresh-0");
    await ui.store.updateSettings({studyManagement:{...ui.store.settings.studyManagement,newCardsPerDay:20,reviewsPerDay:200}});
    ui.view.startReview();expect(ui.view.getState().queue).toHaveLength(2);
  });
});

it("documents the existing policy that explicit follow-up insertion can exceed automatic selection limits",async()=>{
  const ui=setup({start:false,linked:true});ui.plugin.store.settings.studyManagement.newCardsPerDay=1;
  ui.view.startReview(["q"]);await ui.exactButton("정답 보기").click();
  await ui.exactButton("다음 순서에 추가").click();
  expect(ui.view.getState().queue).toEqual(["q","related"]);
});

describe("scheduler audit through rating buttons and durable storage",()=>{
  async function durable(mode="recall") {
    const ui=setup({start:false});let disk;let rejectWrite=false;
    const storage={loadData:async()=>structuredClone(disk),saveData:async value=>{if(rejectWrite)throw Error("audit disk full");disk=structuredClone(value);}};
    const reload=async()=>{ui.plugin.store=new MiaDataStore(storage);await ui.plugin.store.load();ui.plugin.fsrs=new FsrsService(ui.plugin.store.settings);};
    await reload();await ui.plugin.store.updateSettings({studyManagement:{...structuredClone(DEFAULT_SETTINGS.studyManagement),newCardsPerDay:9999,reviewsPerDay:9999,enableFuzz:false}});await reload();
    return {...ui,reload,disk:()=>structuredClone(disk),fail:value=>{rejectWrite=value;},start:()=>ui.view.startReview(["q"],mode)};
  }
  it.each(["always-good","always-again","mixed","long-absence","same-day","restart-next-day"])("%s: button -> scheduler -> store -> restart -> next session",async scenario=>{
    const {fsrs,createEmptyCard}=await import("ts-fsrs");
    const reference=fsrs({enable_fuzz:false,request_retention:.9,maximum_interval:36500,learning_steps:["1m","10m"],relearning_steps:["10m"]});
    const ui=await durable();let expected=createEmptyCard(new Date());
    for(let step=0;step<16;step++){
      if(step){let at=new Date(expected.due);if(scenario==="long-absence")at=new Date(at.getTime()+180*86400000);if(scenario==="same-day")at=new Date(expected.last_review.getTime()+60000);if(scenario==="restart-next-day")at=new Date(at.getTime()+86400000);vi.setSystemTime(at);}
      await ui.reload();ui.start();
      // Ordinary sessions must exclude future long-term reviews, even for same-day practice.
      if(!ui.view.getState().queue.includes("q")){
        expect(Date.parse(ui.plugin.store.getReview("q").card.due)).toBeGreaterThan(Date.now());
        vi.setSystemTime(new Date(expected.due));ui.start();
      }
      const grade=scenario==="always-again"?1:scenario==="mixed"?[1,2,3,4][step%4]:3;
      const before=JSON.stringify(ui.disk().reviews);
      await ui.exactButton("정답 보기").click();expect(JSON.stringify(ui.disk().reviews)).toBe(before);
      expected=reference.next(expected,new Date(),grade).card;
      if(expected.scheduled_days>36500)expected={...expected,scheduled_days:36500,due:new Date(Date.now()+36500*86400000)};
      const labels={1:"못 암기",2:"애매",3:"암기",4:"너무 쉬움"};
      const button=ui.button(labels[grade]);await Promise.all([button.click(),button.click()]);
      const actual=ui.plugin.store.getReview("q");
      expect(actual.card.state).toBe(expected.state);expect(actual.card.due).toBe(expected.due.toISOString());
      expect(actual.card.stability).toBe(expected.stability);expect(actual.card.difficulty).toBe(expected.difficulty);
      expect(actual.card.reps).toBe(step+1);expect(actual.history).toHaveLength(step+1);expect(ui.disk().reviews.q).toEqual(actual);
      await ui.reload();expect(ui.plugin.store.getReview("q")).toEqual(actual);
      ui.view.showDashboard();vi.setSystemTime(new Date(expected.due.getTime()-1));ui.start();expect(ui.view.getState().queue).toEqual([]);
      vi.setSystemTime(expected.due);ui.start();expect(ui.view.getState().queue).toEqual(["q"]);
    }
  });
  it.each(["recall","browse"])("%s: revealing and skipping never grade; rating does, with recoverable write failure",async mode=>{
    const ui=await durable(mode);ui.start();const before=JSON.stringify(ui.disk().reviews);
    if(mode==="recall")await ui.exactButton("정답 보기").click();
    expect(JSON.stringify(ui.disk().reviews)).toBe(before);
    await ui.exactButton("다음 →").click();expect(JSON.stringify(ui.disk().reviews)).toBe(before);
    ui.start();if(mode==="recall")await ui.exactButton("정답 보기").click();
    ui.fail(true);await ui.button("못 암기").click();expect(JSON.stringify(ui.disk().reviews)).toBe(before);expect(ui.view.getState().queueIndex).toBe(0);
    ui.fail(false);await ui.button("못 암기").click();await ui.reload();
    expect(ui.plugin.store.getReview("q").history).toHaveLength(1);expect(ui.plugin.store.getReview("q").card.state).toBe(1);
  });
  it("next-day fresh sessions apply the review limit to a step crossing 04:00",async()=>{
    const ui=await durable();vi.setSystemTime(new Date(2026,9,27,3,55));ui.start();
    await ui.exactButton("정답 보기").click();await ui.button("암기").click();
    expect(ui.plugin.store.getReview("q").card.due).toBe(new Date(2026,9,27,4,5).toISOString());
    await ui.plugin.store.updateSettings({studyManagement:{...ui.plugin.store.settings.studyManagement,reviewsPerDay:0}});
    vi.setSystemTime(new Date(2026,9,27,4,5));await ui.reload();ui.start();expect(ui.view.getState().queue).toEqual([]);
    await ui.plugin.store.updateSettings({studyManagement:{...ui.plugin.store.settings.studyManagement,reviewsPerDay:1}});ui.start();expect(ui.view.getState().queue).toEqual(["q"]);
    await ui.exactButton("정답 보기").click();await ui.button("못 암기").click();
    const {dailyStudyCounts}=await import("../src/core/study-management");
    expect(dailyStudyCounts(ui.plugin.store.reviews,ui.plugin.store.settings.studyManagement,new Date())).toEqual({fresh:0,review:1});
    vi.setSystemTime(new Date(2026,9,27,4,6));await ui.reload();ui.start();expect(ui.view.getState().queue).toEqual(["q"]);
  });
});

it("explains dashboard and progress counts without changing the selected queue or review state",async()=>{
 const ui=setup({start:false});ui.plugin.store.settings.studyManagement.dayStartsAt=7;
 const before=structuredClone(ui.reviews);ui.view.showDashboard();
 expect(ui.content()).toContain('통계와 출제량 안내');expect(ui.content()).toContain('기기 시간 7시');expect(ui.content()).toContain('한도 적용 전');
 await ui.view.setState({...ui.view.getState(),route:'progress'},{});
 expect(ui.content()).toContain('자정 기준');expect(ui.reviews).toEqual(before);
});

describe("bounded question results and Markdown resource lifetime", () => {
  function library() {
    const ui = setup({ start: false });
    const base = ui.plugin.index.registered[0];
    ui.plugin.index.registered = Array.from({ length: 121 }, (_, i) => ({
      ...base, id: `q-${i}`, heading: `문제 ${String(i).padStart(3, "0")}`,
      questionMarkdown: `내용 ${i}`, answerMarkdown: i === 120 ? "마지막 정답 검색" : "답변",
    }));
    ui.view.questionSort = "title";
    ui.view.navigate("questions");
    const rows = () => {
      const visit = node => node.children.flatMap(child => [child, ...visit(child)]);
      return visit(ui.view.contentEl).filter(node => node.cls === "mia-row");
    };
    const input = label => ui.view.contentEl.querySelectorAll("input").find(node => node.attrs["aria-label"] === label);
    const search = value => { const node = input("질문 검색"); node.value = value; node.handlers.get("input")(); };
    return { ...ui, rows, search };
  }
  it("paginates every result in order, searches the last page and selects the entire result set", async () => {
    const ui = library(), seen = [];
    for (const count of [50, 50, 21]) {
      expect(ui.rows()).toHaveLength(count);
      seen.push(...ui.rows().map(row => row.children[0].children[0].text));
      if (count === 50) await ui.exactButton("다음 50개").click();
    }
    expect(seen).toEqual(ui.plugin.index.registered.map(q => q.heading));
    expect(ui.exactButton("다음 50개").disabled).toBe(true);
    ui.search("마지막 정답 검색");
    expect(ui.rows()).toHaveLength(1);
    expect(ui.rows()[0].content).toContain("문제 120");
    expect(ui.view.questionPage).toBe(0);
    ui.search("");
    const start = vi.spyOn(ui.view, "startReview").mockImplementation(() => {});
    await ui.exactButton("검색 결과 암기").click();
    expect(start).toHaveBeenCalledWith(ui.plugin.index.registered.map(q => q.id), "browse");
  });
  it("releases replaced page renderers, bounds pending references, and unloads the final page on close", async () => {
    const unloaded = [];
    const render = vi.spyOn(MarkdownRenderer, "render").mockImplementation(async (_app, text, element, _path, owner) => {
      owner.addChild({ load() {}, unload() { unloaded.push(text); } });
      element.text = text;
    });
    try {
      const ui = library(), rootRenderer = ui.view.renderComponent;
      for (let i = 0; i < 12; i++) {
        ui.search(i % 2 ? "" : "내용");
        expect(ui.view.readingRenders).toHaveLength(100);
        expect(rootRenderer.children).toHaveLength(1);
      }
      expect(unloaded).toHaveLength(12 * 50);
      await ui.view.onClose();
      expect(unloaded).toHaveLength(13 * 50);
      expect(rootRenderer.children).toHaveLength(0);
      expect(ui.view.readingRenders).toHaveLength(0);
    } finally { render.mockRestore(); }
  });
  it("refreshes a narrowed last page after edits and keeps IME composition from publishing intermediate results", async () => {
    const ui = library();
    await ui.exactButton("다음 50개").click();
    await ui.exactButton("다음 50개").click();
    ui.plugin.index.registered[120] = { ...ui.plugin.index.registered[120], answerMarkdown: "새로운 정답" };
    ui.view.render();
    expect(ui.rows()).toHaveLength(21);
    const search = ui.view.contentEl.querySelectorAll("input").find(node => node.attrs["aria-label"] === "질문 검색");
    search.handlers.get("compositionstart")(); search.value = "새로운"; search.handlers.get("input")();
    expect(ui.rows()).toHaveLength(21);
    search.handlers.get("compositionend")();
    expect(ui.rows()).toHaveLength(1);
    expect(ui.rows()[0].content).toContain("문제 120");
    search.value = "마지막 정답 검색"; search.handlers.get("input")();
    expect(ui.rows()).toHaveLength(0);
  });
  it("keeps the newest result when older Markdown work finishes after a new search", async () => {
    const pending = [];
    const render = vi.spyOn(MarkdownRenderer, "render").mockImplementation((_app, text, element) =>
      new Promise(resolve => pending.push(() => { element.text = text; resolve(); })),
    );
    try {
      const ui = library();
      ui.search("마지막 정답 검색");
      expect(ui.view.readingRenders).toHaveLength(2);
      for (const finish of pending.reverse()) finish();
      await Promise.all(ui.view.readingRenders);
      expect(ui.rows()).toHaveLength(1);
      expect(ui.rows()[0].content).toContain("문제 120");
      expect(ui.rows()[0].content).not.toContain("내용 0");
      await ui.view.onClose();
    } finally { render.mockRestore(); }
  });

});

it("preserves elapsed session time and result counts across a fresh view without restoring an unsafe undo baseline", async () => {
  const first = setup({ linked: true });
  first.view.startReview(["q", "related"]);
  const startedAt = Date.now();
  await first.button("정답 보기").click();
  await first.button("너무 쉬움").click();
  await first.plugin.studyUi.load();
  const reviewBefore = structuredClone(first.reviews.q);
  vi.setSystemTime(startedAt + 90_000);
  const next = setup({ linked: true, start: false });
  Object.assign(next.reviews, structuredClone(first.reviews));
  next.plugin.studyUi = new StudyUiStore(first.studyApp, "ui-state.json");
  await next.plugin.studyUi.load();
  next.view.showDashboard();
  await next.button("이어하기").click();
  expect(next.view.getState()).toMatchObject({ queue: ["q", "related"], queueIndex: 1, answerVisible: false });
  expect(next.view.studyResult()).toMatchObject({ total: 2, easy: 1, durationSeconds: 90 });
  expect(next.button("직전 평가 취소")).toBeUndefined();
  expect(next.reviews.q).toEqual(reviewBefore);
  await next.button("정답 보기").click();
  await next.button("너무 쉬움").click();
  expect(next.view.studyResult()).toMatchObject({ total: 2, easy: 2, durationSeconds: 90 });
  expect(next.reviews.q).toEqual(reviewBefore);
  expect(next.reviews.related.history).toHaveLength(1);
});

it("restores a matching workspace session summary, and resets it when explicitly starting a new session", async () => {
  const first = setup({ linked: true }); first.view.startReview(["q", "related"]);
  await first.button("정답 보기").click(); await first.button("너무 쉬움").click();
  await first.plugin.studyUi.load(); const state = first.view.getState();
  vi.setSystemTime(Date.now() + 60_000);
  const next = setup({ linked: true, start: false }); Object.assign(next.reviews, structuredClone(first.reviews));
  next.plugin.studyUi = new StudyUiStore(first.studyApp, "ui-state.json"); await next.plugin.studyUi.load();
  await next.view.setState(state, {});
  expect(next.view.studyResult()).toMatchObject({ easy: 1, durationSeconds: 60 });
  next.view.startReview(["related"]);
  expect(next.view.studyResult()).toMatchObject({ easy: 0, durationSeconds: 0 });
});

describe('configured step duration is not rounded in rating buttons',()=>{
 it.each([['90m','1시간 30분',90],['1584m','1일 2시간 24분',1584]])('shows and saves %s exactly',async(step,label,minutes)=>{
  const ui=setup({start:false});
  ui.plugin.store.settings.studyManagement.learningSteps=[step];
  ui.plugin.store.settings.studyManagement.enableFuzz=false;
  ui.plugin.fsrs=new FsrsService(ui.plugin.store.settings);
  ui.view.startReview(['q']); await ui.button('정답 보기').click();
  expect(ui.button('못 암기').attrs['aria-label']).toContain(`다음 복습 ${label}`);
  await ui.button('못 암기').click();
  const saved=ui.reviews.q;
  expect(Date.parse(saved.card.due)-Date.parse(saved.history.at(-1).review)).toBe(minutes*60_000);
 });
 it('shows an independently specified two-day automatic interval for a fresh Good rating at 90% with no steps or fuzz',async()=>{
  const ui=setup({start:false});
  ui.plugin.store.settings.studyManagement.learningSteps=[];
  ui.plugin.store.settings.studyManagement.enableFuzz=false;
  ui.plugin.fsrs=new FsrsService(ui.plugin.store.settings);ui.view.startReview(['q']);
  await ui.button('정답 보기').click();expect(ui.button('암기').attrs['aria-label']).toContain('다음 복습 2일');
  await ui.button('암기').click();expect(ui.reviews.q.card.scheduled_days).toBe(2);
  expect(Date.parse(ui.reviews.q.card.due)-Date.parse(ui.reviews.q.card.last_review)).toBe(2*86_400_000);
 });
});
