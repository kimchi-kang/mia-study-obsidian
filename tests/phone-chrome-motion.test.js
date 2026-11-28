import { readFileSync } from "node:fs";
import postcss from "postcss";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ isMobile: true, isPhone: true }));
vi.mock("obsidian", () => ({
  Plugin: class {}, Modal: class {}, ItemView: class {}, PluginSettingTab: class {}, MarkdownView: class {}, TFile: class {}, TFolder: class {},
  Component: class {}, Setting: class {}, Notice: class {}, Menu: class {}, Platform: platform, normalizePath: p => p, setIcon() {},
}));
import MiaStudyPlugin from "../src/main";
import { glideActiveTab, NavGlideScheduler, snapshotActiveTab } from "../src/ui/nav-glide";

const css = postcss.parse(readFileSync(new URL("../styles.css", import.meta.url), "utf8"));
let dom;
afterEach(() => { dom?.window.close(); dom = undefined; vi.unstubAllGlobals(); platform.isPhone = true; });

/** 4칸 탭 막대. 칸 폭 100px, 막대 왼쪽 0. 선택 칸은 mod-cta. */
function navDom({ reduced = false } = {}) {
  dom = new JSDOM(`<div class="mia-view"><div class="mia-nav">${["오늘", "학습현황", "문제", "키워드"].map(text => `<button>${text}</button>`).join("")}</div></div>`);
  const { window } = dom;
  window.matchMedia = query => ({ matches: reduced && query.includes("reduce") });
  const animations = [];
  window.HTMLElement.prototype.animate = function (keyframes) { const animation = { keyframes, element: this }; animations.push(animation); return animation; };
  const root = window.document.querySelector(".mia-view");
  const nav = root.querySelector(".mia-nav");
  const buttons = [...nav.querySelectorAll("button")];
  nav.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 52 });
  buttons.forEach((button, index) => { button.getBoundingClientRect = () => ({ left: index * 100, top: 4, width: 100, height: 44 }); });
  const select = index => buttons.forEach((button, at) => button.classList.toggle("mod-cta", at === index));
  return { window, root, nav, buttons, select, animations };
}

describe("탭 선택 표시 미끄러짐", () => {
  it("이전 탭 자리에서 새 탭 자리로 표시 조각을 옮기고, 끝나면 지운다", () => {
    const { root, nav, select, animations } = navDom();
    select(0);
    const from = snapshotActiveTab(root);
    select(3);
    glideActiveTab(root, from);
    const glide = nav.querySelector(":scope > .mia-nav-glide");
    expect(glide).not.toBeNull();
    expect(nav.classList.contains("mia-nav-gliding")).toBe(true);
    expect(animations[0].keyframes[0].transform).toBe("translate(-300px, 0px)");
    animations[0].onfinish();
    expect(nav.querySelector(".mia-nav-glide")).toBeNull();
    expect(nav.classList.contains("mia-nav-gliding")).toBe(false);
  });

  it("동작 줄이기 설정이나 같은 자리면 아무것도 만들지 않는다", () => {
    const reduced = navDom({ reduced: true });
    reduced.select(0);
    const from = snapshotActiveTab(reduced.root);
    reduced.select(2);
    glideActiveTab(reduced.root, from);
    expect(reduced.nav.querySelector(".mia-nav-glide")).toBeNull();
    dom.window.close();
    const same = navDom();
    same.select(1);
    glideActiveTab(same.root, snapshotActiveTab(same.root));
    expect(same.nav.querySelector(".mia-nav-glide")).toBeNull();
  });

  it("미끄러지는 중에 다시 그리면 표시 조각의 지금 위치에서 이어 간다", () => {
    const { root, nav, select } = navDom();
    select(0);
    const from = snapshotActiveTab(root);
    select(3);
    glideActiveTab(root, from);
    nav.querySelector(".mia-nav-glide").getBoundingClientRect = () => ({ left: 150, top: 4, width: 100, height: 44 });
    expect(snapshotActiveTab(root)).toEqual({ left: 150, top: 4, width: 100, height: 44 });
  });

  it("한 프레임 안에 여러 번 다시 그려도 가장 처음 위치에서 한 번만 미끄러진다", () => {
    const { window, root, nav, select, animations } = navDom();
    const frames = new Map();
    let next = 0;
    window.requestAnimationFrame = callback => { next += 1; frames.set(next, callback); return next; };
    window.cancelAnimationFrame = id => frames.delete(id);
    const scheduler = new NavGlideScheduler();
    select(0); scheduler.capture(root); select(1); scheduler.schedule(root);
    scheduler.capture(root); select(3); scheduler.schedule(root);
    expect(frames.size).toBe(1);
    for (const callback of frames.values()) callback();
    expect(nav.querySelectorAll(".mia-nav-glide")).toHaveLength(1);
    expect(animations[0].keyframes[0].transform).toBe("translate(-300px, 0px)");
  });

  it("닫을 때 예약을 지운다", () => {
    const { window, root, select } = navDom();
    const cancel = vi.fn();
    window.requestAnimationFrame = () => 7;
    window.cancelAnimationFrame = cancel;
    const scheduler = new NavGlideScheduler();
    select(0); scheduler.capture(root); select(2); scheduler.schedule(root);
    scheduler.cancel();
    expect(cancel).toHaveBeenCalledWith(7);
  });
});

describe("휴대폰 하단 막대 숨김", () => {
  const host = (viewType, unloadRequested = false) => ({
    unloadRequested,
    app: { workspace: { rootSplit: {}, getMostRecentLeaf: () => (viewType ? { view: { getViewType: () => viewType } } : null) } },
  });
  const run = (self) => {
    dom = new JSDOM("<body></body>");
    vi.stubGlobal("document", dom.window.document);
    MiaStudyPlugin.prototype.syncPhoneNavbar.call(self);
    return dom.window.document.body.classList.contains("mia-phone-navbar-hidden");
  };

  it("본문에서 마지막으로 쓴 탭이 Major Study면 숨기고, 아니면 보인다 (지연 로딩 뷰도 종류로 판단)", () => {
    expect(run(host("mia-study-view"))).toBe(true);
    expect(run(host("markdown"))).toBe(false);
    expect(run(host(null))).toBe(false);
  });

  it("휴대폰이 아니거나 플러그인이 꺼진 뒤에는 클래스를 붙이지 않는다", () => {
    platform.isPhone = false;
    expect(run(host("mia-study-view"))).toBe(false);
    platform.isPhone = true;
    expect(run(host("mia-study-view", true))).toBe(false);
  });
});

describe("휴대폰 막대·모션 CSS 계약", () => {
  const rules = [];
  css.walkRules(rule => rules.push(rule));
  const inMedia = rule => { for (let node = rule.parent; node && node.type !== "root"; node = node.parent) if (node.type === "atrule" && node.name === "media") return true; return false; };

  it("탭 막대 양 끝 여백은 끼어드는 표시 조각에 흔들리지 않는 -of-type으로 고른다", () => {
    const navEdges = rules.filter(rule => /\.mia-nav button:(first|last)-/.test(rule.selector));
    expect(navEdges.length).toBeGreaterThan(0);
    for (const rule of navEdges) expect(rule.selector).toMatch(/-of-type/);
  });

  it("막대 숨김과 머리줄 버튼 규칙은 버튼을 만드는 JS처럼 화면 크기와 무관하게 적용된다", () => {
    const chrome = rules.filter(rule => /mia-phone-navbar-hidden|\.mia-host-button|\[data-type="mia-study-view"\] > \.view-header/.test(rule.selector));
    expect(chrome.length).toBeGreaterThan(3);
    for (const rule of chrome) expect(inMedia(rule), rule.selector).toBe(false);
  });

  it("머리줄 버튼은 기본 44px 터치 크기를 지킨다", () => {
    const base = rules.find(rule => rule.selector.endsWith("> .mia-host-button") && rule.parent.type === "root");
    expect(base.toString()).toMatch(/min-width: 44px/);
    expect(base.toString()).toMatch(/min-height: 44px/);
  });

  it("머리줄 버튼은 음수 여백으로 줄 밖에 삐져나오지 않고, 좁은 화면에서는 이름 글자를 줄여 한 줄을 지킨다", () => {
    const host = rules.filter(rule => /\.mia-host-(button|more|menu)$/.test(rule.selector));
    expect(host.length).toBeGreaterThan(2);
    for (const rule of host) rule.walkDecls(/^margin/, decl => expect(decl.value, rule.selector).not.toMatch(/(^|\s)-\d/));
    const narrowBrand = rules.find(rule => rule.parent.type === "atrule" && rule.parent.name === "container" && rule.selector.includes(".mia-brand") && rule.selector.includes("mia-host-button"));
    expect(narrowBrand?.toString()).toMatch(/font-size/);
  });

  it("평가 버튼 글자는 한 줄이어도 세로 가운데에 놓인다", () => {
    const base = rules.find(rule => rule.selector === ".mia-ratings button" && rule.toString().includes("flex-direction: column"));
    expect(base.toString()).toMatch(/justify-content: center/);
  });

  it("탭 버튼은 배경·그림자를 전환하지 않아, 미끄러짐 시작·끝에 선택 탭이 꺼졌다 켜지지 않는다", () => {
    const tab = rules.find(rule => rule.selector === ".mia-view .mia-nav > button");
    const transition = tab.nodes.find(node => node.prop === "transition")?.value ?? "";
    expect(transition).not.toMatch(/background|box-shadow|\ball\b/);
    expect(transition).toMatch(/color/);
  });

  it("학습 화면의 평가 저장 중 문구는 줄을 차지하지 않고, 저장됨 배너는 자리를 남긴 채 숨는다", () => {
    const status = rules.find(rule => rule.selector.endsWith("> .mia-save-status") && rule.selector.includes("mia-study-layout"));
    expect(status.toString()).toMatch(/position: absolute/);
    expect(status.toString()).toMatch(/pointer-events: none/);
    const expired = rules.find(rule => rule.selector.includes("mia-undo-feedback-expired"));
    expect(expired.toString()).toMatch(/visibility: hidden/);
    expect(expired.toString()).not.toMatch(/display: none/);
  });

  it("보기 설정 모달도 학습 설정 모달처럼 하단 버튼 위에 흐림 경계를 둔다", () => {
    expect(rules.some(rule => rule.selector.includes(".mia-appearance-modal .mia-appearance-actions") && rule.selector.endsWith("::before"))).toBe(true);
  });

  it("하단 버튼 줄이 없는 화면에서 떠 있는 키보드 닫기만큼 스크롤 여백을 둔다", () => {
    const rule = rules.find(rule => rule.selector.includes(":has(> .mia-keyboard-dismiss)"));
    expect(rule.toString()).toMatch(/scroll-padding-bottom: \d+px/);
  });

  it("정답 펼침은 끝난 뒤 clip-path를 남기지 않는다", () => {
    const answer = rules.filter(rule => rule.selector.includes("mia-answer-enter"));
    expect(answer.length).toBe(2);
    for (const rule of answer) expect(rule.toString()).not.toMatch(/\b(both|forwards)\b/);
  });
});
