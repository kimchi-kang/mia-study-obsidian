import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { State } from "ts-fsrs";

const modalBoundary = vi.hoisted(() => ({ instances: [] }));


// Only Obsidian's UI boundary is replaced; the view, timers and FSRS are real.
vi.mock("obsidian", () => {
  class Element {
    children = []; handlers = new Map(); text = ""; disabled = false; scrollTop = 0; open = false;
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
    getAttribute(name) { return this.attrs[name] ?? null; }
    get parentElement() { return this.parent ?? null; }
    get tagName() { return this.tag?.toUpperCase(); }
    removeAttribute(name) { delete this.attrs[name]; }
    setText(text) { this.text = text; }
    addClass() {} removeClass() {} setAttr(name,value) { this.attrs[name]=value; } focus() { this.focused=true; }
    contains(element) { return this===element || this.children.some(child=>child.contains(element)); }
    querySelectorAll(selector) { const tags=selector.split(",").map(tag=>tag.trim()); return this.children.flatMap(child=>[...(tags.includes(child.tag)?[child]:[]),...child.querySelectorAll(selector)]); }
    querySelector(selector) {
      if([".mia-learning-button", ".mia-appearance-button", ".mia-study-layout", ".mia-study-concepts"].includes(selector)) { const visit=el=>el.cls.split(" ").includes(selector.slice(1))?el:el.children.map(visit).find(Boolean);return visit(this)??null; }
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
    Modal: class { constructor(app) { this.app=app; this.contentEl=new Element(); this.modalEl=new Element(); this.containerEl=new Element(); this.close=vi.fn(this.close.bind(this)); modalBoundary.instances.push(this); } setTitle() {} open = vi.fn(); close() {} }, Notice: class {}, Platform: { isMobile: false },
    MarkdownRenderer: { render: async (_app, text, element) => { element.text = text; } },
  };
});
import { FsrsService } from "../src/core/fsrs-service";
import { StudyUiStore } from "../src/services/study-ui-store";
import { MiaStudyView } from "../src/ui/study-view";
import { DEFAULT_SETTINGS } from "../src/core/models";
import { studyDayStart } from "../src/core/study-management";

// Multi-day study through the real view, scheduler and queue code. Only the
// Obsidian UI boundary and storage are replaced. An independent FsrsService
// instance is the oracle for every saved rating.
function mulberry32(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

function environment({ count = 40, settingsPatch = {} } = {}) {
  const questions = Array.from({ length: count }, (_, index) => ({
    id: `mia-q-sim-${String(index).padStart(3, "0")}`, heading: `문제 ${index}`, questionMarkdown: `질문 ${index}`, answerMarkdown: `정답 ${index}`,
    subject: index % 2 ? "전자기학" : "회로이론", questionType: "정의형", filePath: "bank.md", coreKeywords: [], subKeywords: [], followUpIds: [],
  }));
  const reviews = {};
  const files = new Map();
  const settings = { ...structuredClone(DEFAULT_SETTINGS), ...settingsPatch };
  const studyApp = { loadLocalStorage: () => null, saveLocalStorage() {}, vault: { adapter: { exists: async path => files.has(path), read: async path => files.get(path), write: async (path, data) => { files.set(path, data); } } } };
  const plugin = {
    manifest: { version: "sim" },
    studyUi: new StudyUiStore(studyApp, "ui-state.json"),
    openQuestionPreview: vi.fn(), openManagedQuestionEditor: vi.fn(), listSubjects: () => [],
    fsrs: new FsrsService(settings),
    index: { diagnostics: [], candidates: [], isReady: true, registered: questions, questionById: id => questions.find(item => item.id === id) },
    store: {
      settings, reviews, getReview: id => reviews[id],
      getReviewVersion: id => reviews[id] ? JSON.stringify(reviews[id]) : null,
      setReview: async (id, state) => { reviews[id] = state; },
      removeReview: async id => { delete reviews[id]; },
    },
  };
  let view;
  const leaf = { app: { workspace: { requestSaveLayout() {} } }, setViewState: async ({ state }) => view.setState(state, {}) };
  view = new MiaStudyView(leaf, plugin);
  return { view, plugin, questions, reviews, oracle: new FsrsService(settings), settings };
}

const ratingButton = (view, grade) => {
  const visit = element => element.tag === "button" && element.dataset?.grade === String(grade) ? element : element.children.map(visit).find(Boolean);
  return visit(view.contentEl);
};

/**
 * Study once at `start`, answering every presented card, waiting through learning
 * steps like a user who keeps the session open. Returns what was presented.
 */
async function studySession(env, start, pickGrade, { secondsPerCard = 20, maxCards = 2000 } = {}) {
  const { view, reviews, oracle } = env;
  vi.setSystemTime(start);
  view.startReview();
  const initialQueue = [...view.queue];
  const presented = [];
  for (let step = 0; step < maxCards; step += 1) {
    const content = view.contentEl.content;
    if (content.includes("다음 복습 대기 중")) {
      const waiting = Object.values(reviews).filter(state => state.card.state === State.Learning || state.card.state === State.Relearning)
        .map(state => Date.parse(state.card.due)).filter(due => due > Date.now());
      expect(waiting.length, "waiting screen without a pending learning step").toBeGreaterThan(0);
      vi.setSystemTime(Math.min(...waiting) + 1000);
      view.render();
      continue;
    }
    if (content.includes("학습 완료") || content.includes("학습할 문제가 없습니다")) return { initialQueue, presented, end: Date.now() };
    const id = view.queue[view.queueIndex];
    const reveal = view.contentEl.find("정답 보기", true);
    if (reveal) await reveal.click();
    const before = reviews[id] ? structuredClone(reviews[id]) : undefined;
    vi.setSystemTime(Date.now() + secondsPerCard * 1000);
    const grade = pickGrade(id, before);
    const now = new Date();
    presented.push({ id, at: now.getTime(), before });
    await ratingButton(view, grade).click();
    // The saved state must be exactly what the scheduler computes for this click.
    expect(reviews[id], `rating ${id}`).toEqual(oracle.rate(before, grade, now, id));
  }
  throw new Error("session did not finish");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const DAY_START = DEFAULT_SETTINGS.studyManagement.dayStartsAt;
const schedules = {
  "every day at 09:00": () => [[9, 0]],
  "morning and evening": () => [[9, 0], [21, 30]],
  "a random morning hour": random => [[8 + Math.floor(random() * 3), Math.floor(random() * 60)]],
};

describe("multi-day study simulation through the real view", () => {
  it.each(Object.keys(schedules).flatMap(name => [1, 2].map(seed => [name, seed])))("%s (seed %i): no omission, no late review, exact FSRS results", async (name, seed) => {
    const random = mulberry32(seed);
    vi.spyOn(Math, "random").mockImplementation(random);
    const env = environment();
    const isDueAt = (state, time) => env.plugin.fsrs.isDue(state, new Date(time));
    const pick = () => { const r = random(); return r < 0.15 ? 1 : r < 0.3 ? 2 : r < 0.9 ? 3 : 4; };
    let reviewsSeen = 0;
    for (let day = 0; day < 45; day += 1) {
      for (const [hour, minute] of schedules[name](random)) {
        const start = new Date(2026, 9, 15 + day, hour, minute, 0).getTime();
        const dueAtStart = env.questions.filter(q => isDueAt(env.reviews[q.id], start)).map(q => q.id);
        const unseen = env.questions.filter(q => !env.reviews[q.id]).map(q => q.id);
        const introducedToday = env.questions.filter(q => env.reviews[q.id]?.history.some(log => log.state === State.New && Date.parse(log.review) >= studyDayStart(new Date(start), DAY_START).getTime())).length;
        const { initialQueue, presented, end } = await studySession(env, start, pick);
        // 1. Every card due at session start is queued and actually presented.
        expect(initialQueue).toEqual(expect.arrayContaining(dueAtStart));
        expect(new Set(presented.map(p => p.id))).toEqual(new Set(initialQueue));
        // 2. New cards fill exactly the remaining daily budget.
        expect(initialQueue.filter(id => unseen.includes(id))).toHaveLength(Math.min(20 - introducedToday, unseen.length));
        // 3. No duplicates in the initial queue.
        expect(new Set(initialQueue).size).toBe(initialQueue.length);
        // 4. Nothing that was due at the start is still due when the session ends.
        for (const id of dueAtStart) expect(isDueAt(env.reviews[id], end), `${id} left due on day ${day}`).toBe(false);
        // 5. No learning step is left overdue inside the session's scope.
        for (const id of initialQueue) {
          const state = env.reviews[id].card.state;
          if (state === State.Learning || state === State.Relearning) expect(Date.parse(env.reviews[id].card.due)).toBeGreaterThan(end);
        }
        // 6. Like Anki, an interday review is shown on its due study day, never a day later.
        for (const p of presented) if (p.before?.card.state === State.Review && p.before.card.scheduled_days >= 1) {
          reviewsSeen += 1;
          expect(studyDayStart(new Date(p.at), DAY_START).getTime(), `${p.id} shown after its due day`)
            .toBe(studyDayStart(new Date(p.before.card.due), DAY_START).getTime());
        }
      }
    }
    // 7. Every registered question has been introduced, and reviews were actually exercised.
    expect(env.questions.every(q => env.reviews[q.id] && env.reviews[q.id].card.state !== State.New)).toBe(true);
    expect(reviewsSeen).toBeGreaterThan(50);
  }, 120_000);
});
