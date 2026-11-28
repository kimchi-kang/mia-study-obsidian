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
import { activeTabIndex, animateProgressFill, bindDetailsReveal, ENTER_EASING, fadeInElement, fadeInRouteContent, glideActiveTab, NavGlideScheduler, routeDirection, slideInList, snapshotActiveTab, staggerRouteItems, studyCardDirection } from "../src/ui/nav-glide";

const css = postcss.parse(readFileSync(new URL("../styles.css", import.meta.url), "utf8"));
let dom;
afterEach(() => { dom?.window.close(); dom = undefined; vi.unstubAllGlobals(); platform.isPhone = true; });

/** 4칸 탭 막대. 칸 폭 100px, 막대 왼쪽 0. 선택 칸은 mod-cta. */
function navDom({ reduced = false } = {}) {
  dom = new JSDOM(`<div class="mia-view"><div class="mia-nav">${["오늘", "학습현황", "문제", "키워드"].map(text => `<button>${text}</button>`).join("")}</div></div>`);
  const { window } = dom;
  window.matchMedia = query => ({ matches: reduced && query.includes("reduce") });
  const animations = [];
  window.HTMLElement.prototype.animate = function (keyframes, options) { const animation = { keyframes, options, element: this }; animations.push(animation); return animation; };
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

  it("표시 조각과 같은 시간 동안 이전 탭 글자는 선택 색에서, 새 탭 글자는 비선택 색에서 출발해 바뀐다", () => {
    const { window, root, buttons, select, animations } = navDom();
    window.getComputedStyle = element => ({ color: element.classList.contains("mod-cta") ? "rgb(0, 0, 255)" : "rgb(128, 128, 128)" });
    select(0);
    const from = snapshotActiveTab(root), index = activeTabIndex(root);
    expect(index).toBe(0);
    select(2);
    glideActiveTab(root, from, index);
    const glide = animations[0];
    const label = element => animations.find(animation => animation.element === element)?.keyframes.map(frame => frame.color);
    expect(label(buttons[2])).toEqual(["rgb(128, 128, 128)", "rgb(0, 0, 255)"]);
    expect(label(buttons[0])).toEqual(["rgb(0, 0, 255)", "rgb(128, 128, 128)"]);
    expect(glide.element.classList.contains("mia-nav-glide")).toBe(true);
  });

  it("탭을 옮긴 뒤 본문만 살짝 떠오르며 나타나고, 머리줄·탭 막대는 그대로 둔다", () => {
    const { window, root, animations } = navDom();
    const header = window.document.createElement("div"); header.className = "mia-header"; header.append(root.querySelector(".mia-nav"));
    const body = window.document.createElement("section");
    root.append(header, body);
    fadeInRouteContent(root);
    expect(animations.map(animation => animation.element)).toEqual([body]);
    expect(animations[0].keyframes[0].opacity).toBe(0);
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

describe("화면과 카드의 진입 모션", () => {
  it.each([
    [0, 2, "next", "translateX(28px)"],
    [2, 0, "prev", "translateX(-28px)"],
    [undefined, 0, "vertical", "translateY(16px)"],
  ])("탭 %s → %s의 본문은 %s 방향으로 나타난다", (from, to, direction, transform) => {
    const { root, animations } = navDom();
    root.innerHTML = '<header class="mia-header"></header><div><nav class="mia-nav"></nav></div><span class="mia-sr-only"></span><section></section>';
    expect(routeDirection(from, to)).toBe(direction);
    fadeInRouteContent(root, direction);
    expect(animations).toHaveLength(1);
    expect(animations[0]).toMatchObject({
      element: root.querySelector("section"),
      keyframes: [{ opacity: 0, transform }, { opacity: 1, transform: "none" }],
      options: { duration: 260, fill: "backwards" },
    });
  });

  it("동작 줄이기 설정이면 본문 진입 모션을 실행하지 않는다", () => {
    const { root, animations } = navDom({ reduced: true });
    root.innerHTML = "<section></section>";
    fadeInRouteContent(root, "next");
    expect(animations).toHaveLength(0);
  });

  it("첫 카드와 같은 카드에서는 방향이 없고 인덱스나 ID 변경으로 방향을 고른다", () => {
    const last = { index: 1, id: "a" };
    expect(studyCardDirection(null, 1, "a")).toBeNull();
    expect(studyCardDirection(last, 1, "a")).toBeNull();
    expect(studyCardDirection(last, 0, "a")).toBe("prev");
    expect(studyCardDirection(last, 2, "b")).toBe("next");
    expect(studyCardDirection(last, 1, "b")).toBe("next");
  });

  it("details는 코드로 연 경우를 무시하고 summary로 열 때만 본문을 한 번 움직인다", async () => {
    const { root, animations } = navDom();
    root.innerHTML = "<details><summary>열기</summary><p>본문</p><div>부록</div></details>";
    const details = root.querySelector("details");
    const summary = details.querySelector("summary");
    const toggle = action => new Promise(resolve => {
      details.addEventListener("toggle", resolve, { once: true });
      action();
    });

    details.open = true;
    bindDetailsReveal(root);
    bindDetailsReveal(root);
    await toggle(() => {});
    expect(animations).toHaveLength(0);
    await toggle(() => summary.click());
    expect(animations).toHaveLength(0);
    summary.addEventListener("click", event => event.preventDefault(), { once: true });
    summary.click();
    await toggle(() => { details.open = true; });
    expect(animations).toHaveLength(0);
    await toggle(() => { details.open = false; });
    await toggle(() => summary.click());
    expect(animations.map(animation => animation.element)).toEqual([...details.children].slice(1));
    for (const animation of animations) {
      expect(animation).toMatchObject({
        keyframes: [{ opacity: 0, transform: "translateY(-10px)" }, { opacity: 1, transform: "none" }],
        options: { duration: 210, fill: "backwards" },
      });
    }
    await toggle(() => summary.click());
    await toggle(() => { details.open = true; });
    expect(animations).toHaveLength(2);
  });
});

describe("공통 진입 곡선과 목록 모션", () => {
  it("본문, 진행 막대, 상세 요소와 접이식 본문에 공통 진입 곡선을 쓴다", () => {
    const { window, root, animations } = navDom();
    root.innerHTML = "<section><div></div><details><summary>열기</summary><p>본문</p></details></section>";
    const fill = root.querySelector("section > div");
    fadeInRouteContent(root);
    animateProgressFill(fill, .25, .5);
    fadeInElement(fill);
    bindDetailsReveal(root);
    root.querySelector("summary").click();
    root.querySelector("details").dispatchEvent(new window.Event("toggle"));
    const easing = "cubic-bezier(.22, 1, .36, 1)";
    expect(ENTER_EASING).toBe(easing);
    expect(animations.map(({ options }) => options.easing)).toEqual(Array(4).fill(easing));
    expect(animations[1]).toMatchObject({
      keyframes: [{ width: "25%" }, { width: "50%" }],
      options: { duration: 300 },
    });
    expect(animations[2]).toMatchObject({
      keyframes: [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }],
      options: { duration: 200, fill: "backwards" },
    });
  });

  it("여러 구역에 걸쳐 문서 순서대로 처음 8개만 18ms 간격으로 나타난다", () => {
    const { root, animations } = navDom();
    root.innerHTML = `
      <section class="mia-keyword-grid"><button></button></section>
      <section class="mia-stats"><button></button><button></button></section>
      <section class="mia-list"><p></p>${'<div class="mia-row"></div>'.repeat(6)}</section>
      <section class="mia-subject-grid"><article></article></section>
    `;
    staggerRouteItems(root);
    const rows = [...root.querySelectorAll(".mia-row")];
    expect(animations.map(({ element }) => element)).toEqual([...root.querySelectorAll("button"), ...rows.slice(0, 5)]);
    for (const [index, animation] of animations.entries()) {
      expect(animation).toMatchObject({
        keyframes: [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }],
        options: { duration: 260, delay: index * 18, easing: ENTER_EASING, fill: "backwards" },
      });
    }
    expect(animations[7].options.delay).toBe(126);
  });

  it.each([
    ["next", "translateX(22px)", 220],
    ["prev", "translateX(-22px)", 220],
    ["filter", "translateY(8px)", 190],
  ])("목록의 %s 전환은 목록 전체를 한 번 움직인다", (motion, transform, duration) => {
    const { root, animations } = navDom();
    root.innerHTML = '<div class="mia-list"><div class="mia-row"></div></div>';
    const list = root.firstElementChild;
    slideInList(list, motion);
    expect(animations).toEqual([{
      element: list,
      keyframes: [{ opacity: 0, transform }, { opacity: 1, transform: "none" }],
      options: { duration, easing: ENTER_EASING, fill: "backwards" },
    }]);
  });

  it.each([true, false])("동작 줄이기 설정(%s) 또는 animate 미지원이면 진입 모션을 건너뛴다", reduced => {
    const { window, root, animations } = navDom({ reduced });
    if (!reduced) delete window.HTMLElement.prototype.animate;
    root.innerHTML = '<div class="mia-list"><div class="mia-row"></div></div><details><summary>열기</summary><div></div></details>';
    const list = root.firstElementChild;
    fadeInRouteContent(root);
    staggerRouteItems(root);
    for (const motion of ["next", "prev", "filter"]) slideInList(list, motion);
    animateProgressFill(list, .25, .5);
    fadeInElement(list);
    bindDetailsReveal(root);
    root.querySelector("summary").click();
    root.querySelector("details").dispatchEvent(new window.Event("toggle"));
    expect(animations).toEqual([]);
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

  it("학습 화면(휴대폰·태블릿·데스크톱)의 평가 저장 중 문구는 줄을 차지하지 않고, 저장됨 배너는 자리를 남긴 채 숨는다", () => {
    const status = rules.find(rule => rule.selector === ".mia-view.mia-route-study:has(.mia-study-layout) > .mia-save-status");
    expect(status.toString()).toMatch(/position: absolute/);
    expect(status.toString()).toMatch(/pointer-events: none/);
    const expired = rules.find(rule => rule.selector.includes("mia-undo-feedback-expired"));
    expect(expired.toString()).toMatch(/visibility: hidden/);
    expect(expired.toString()).not.toMatch(/display: none/);
  });

  it("보기 설정 모달도 학습 설정 모달처럼 하단 버튼 위에 흐림 경계를 둔다", () => {
    expect(rules.some(rule => rule.selector.includes(".mia-appearance-modal .mia-appearance-actions") && rule.selector.endsWith("::before"))).toBe(true);
  });

  it("휴대폰 검색·필터·정렬 제목 줄은 카드 안의 솟은 버튼이 아니라 카드 머리줄이고, 접으면 아래 빈 여백이 없다", () => {
    const summary = rules.find(rule => rule.selector === ".mia-view .mia-filter-panel > summary");
    expect(summary.toString()).toMatch(/background: transparent/);
    expect(summary.toString()).toMatch(/box-shadow: none/);
    expect(summary.toString()).toMatch(/padding-inline: 16px/);
    const closed = rules.find(rule => rule.selector === ".is-mobile .mia-view .mia-filter-panel");
    expect(closed.toString()).toMatch(/padding: 0 16px;/);
    expect(rules.some(rule => rule.selector.includes(":not([open]) > summary::after"))).toBe(true);
  });

  it("휴대폰 문제 목록의 페이지 넘김은 하단 탭 막대 위에 떠서 가려지지 않는다", () => {
    const rule = rules.find(rule => rule.selector.includes('[data-device="phone"]') && rule.selector.endsWith(".mia-pagination"));
    const bottom = rule.nodes.find(node => node.prop === "bottom")?.value ?? "";
    expect(Number(bottom.match(/(\d+)px/)?.[1])).toBeGreaterThanOrEqual(60);
  });

  it("정답 펼침은 끝난 뒤 clip-path를 남기지 않는다", () => {
    const answer = rules.filter(rule => rule.selector.includes("mia-answer-enter"));
    expect(answer.length).toBe(2);
    for (const rule of answer) expect(rule.toString()).not.toMatch(/\b(both|forwards)\b/);
  });

  it("배너 만료는 자리를 유지하며 페이드하고 동작 줄이기에서는 즉시 숨는다", () => {
    const expired = rules.find(rule => rule.selector === ".mia-undo-feedback.mia-undo-feedback-expired");
    expect(Object.fromEntries(expired.nodes.map(({ prop, value }) => [prop, value]))).toEqual({
      opacity: "0",
      visibility: "hidden",
      transition: "opacity 240ms ease-out, visibility 0s linear 240ms",
    });
    const reduce = rules.find(rule => rule.selector.startsWith(".mia-view *,") && rule.parent.params === "(prefers-reduced-motion: reduce)");
    expect(reduce.nodes).toContainEqual(expect.objectContaining({ prop: "transition", value: "none", important: true }));
  });
});
