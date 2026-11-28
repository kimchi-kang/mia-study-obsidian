/**
 * 상단 탭을 옮길 때 선택 표시가 이전 탭 자리에서 새 탭 자리로 미끄러지게 한다.
 * 화면은 탭마다 새로 그려지므로, 그리기 전 선택 탭 위치를 기억했다가
 * 새로 그린 뒤 그 자리에서 출발하는 표시 조각을 잠깐 띄우고 지운다.
 */
export interface NavTabRect { left: number; top: number; width: number; height: number; }
export type RouteDirection = "next" | "prev" | "vertical";

// 천천히 출발해 가속했다가 부드럽게 멈춘다. 예전 곡선(.2,.7,.2,1)은 60ms에 거리의 3/4을 가고
// 나머지를 기어가서, 순간이동 뒤 질질 끌리는 것처럼 보였다.
const GLIDE_MS = 280;
const GLIDE_EASING = "cubic-bezier(.45, 0, .15, 1)";
const CONTENT_FADE_MS = 200;
const CONTENT_EASING = "cubic-bezier(.2, .7, .2, 1)";
const routeOffsets: Record<RouteDirection, string> = {
  next: "translateX(12px)", prev: "translateX(-12px)", vertical: "translateY(6px)",
};
const boundDetails = new WeakSet<HTMLDetailsElement>();

const reducedMotion = (view: Window | null): boolean => !view || Boolean(view.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

function activeTab(root: HTMLElement): { nav: HTMLElement; tab: HTMLElement } | null {
  const nav = root.querySelector<HTMLElement>(".mia-nav");
  const tab = nav?.querySelector<HTMLElement>(":scope > button.mod-cta");
  return nav && tab ? { nav, tab } : null;
}

function rectInNav(nav: HTMLElement, target: HTMLElement): NavTabRect | null {
  const outer = nav.getBoundingClientRect();
  const inner = target.getBoundingClientRect();
  if (!inner.width || !inner.height) return null;
  return { left: inner.left - outer.left - nav.clientLeft, top: inner.top - outer.top - nav.clientTop, width: inner.width, height: inner.height };
}

/**
 * 다시 그리기 전에 호출한다. 탭이 숨겨져 있으면 null.
 * 미끄러지는 중이면 표시 조각의 지금 위치를 돌려주어, 중간에 다시 그려도 그 자리에서 이어 간다.
 */
export function snapshotActiveTab(root: HTMLElement): NavTabRect | null {
  const found = activeTab(root);
  if (!found) return null;
  const moving = found.nav.querySelector<HTMLElement>(":scope > .mia-nav-glide");
  return rectInNav(found.nav, moving ?? found.tab);
}

/** 다시 그리기 전 선택 탭의 순서. 새로 그린 뒤 이전 탭 글자색을 함께 바꾸는 데 쓴다. */
export function activeTabIndex(root: HTMLElement): number | undefined {
  const found = activeTab(root);
  if (!found) return undefined;
  const index = Array.from(found.nav.querySelectorAll(":scope > button")).indexOf(found.tab);
  return index >= 0 ? index : undefined;
}

/** 다시 그린 뒤 호출한다. 위치가 같거나 동작 줄이기 설정이면 아무것도 하지 않는다. */
export function glideActiveTab(root: HTMLElement, from: NavTabRect | null, fromIndex?: number): void {
  if (!from) return;
  const view = root.ownerDocument.defaultView;
  if (!view || reducedMotion(view)) return;
  const found = activeTab(root);
  if (!found || !found.nav.isConnected || typeof found.tab.animate !== "function") return;
  const { nav, tab } = found;
  const to = rectInNav(nav, tab);
  if (!to || (Math.abs(to.left - from.left) < 1 && Math.abs(to.top - from.top) < 1)) return;
  for (const stale of Array.from(nav.querySelectorAll(":scope > .mia-nav-glide"))) stale.remove();
  const glide = root.ownerDocument.createElement("span");
  glide.className = "mia-nav-glide";
  glide.setAttribute("aria-hidden", "true");
  glide.style.setProperty("--mia-glide-left", `${to.left}px`);
  glide.style.setProperty("--mia-glide-top", `${to.top}px`);
  glide.style.setProperty("--mia-glide-width", `${to.width}px`);
  glide.style.setProperty("--mia-glide-height", `${to.height}px`);
  nav.prepend(glide);
  nav.classList.add("mia-nav-gliding");
  const animation = glide.animate([
    { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)`, width: `${from.width}px`, height: `${from.height}px` },
    { transform: "translate(0, 0)", width: `${to.width}px`, height: `${to.height}px` },
  ], { duration: GLIDE_MS, easing: GLIDE_EASING });
  const finish = () => {
    glide.remove();
    if (!nav.querySelector(":scope > .mia-nav-glide")) nav.classList.remove("mia-nav-gliding");
  };
  animation.onfinish = finish;
  animation.oncancel = finish;
  crossfadeLabels(view, nav, tab, fromIndex);
}

/**
 * 새로 그린 탭 글자는 처음부터 선택·비선택 색이라, 표시 조각이 도착하기 전에 새 탭 글자가 먼저 켜진다.
 * 조각과 같은 시간 동안 이전 탭은 선택 색에서, 새 탭은 비선택 색에서 출발해 서로 바뀌게 한다.
 */
function crossfadeLabels(view: Window, nav: HTMLElement, tab: HTMLElement, fromIndex: number | undefined): void {
  if (fromIndex === undefined) return;
  const previous = Array.from(nav.querySelectorAll<HTMLElement>(":scope > button"))[fromIndex];
  if (!previous || previous === tab || typeof previous.animate !== "function") return;
  const on = view.getComputedStyle(tab).color, off = view.getComputedStyle(previous).color;
  if (!on || !off || on === off) return;
  const timing = { duration: GLIDE_MS, easing: GLIDE_EASING };
  tab.animate([{ color: off }, { color: on }], timing);
  previous.animate([{ color: on }, { color: off }], timing);
}

/**
 * 다른 탭으로 옮겨 화면을 새로 그린 뒤 호출한다. 머리줄·탭 막대를 뺀 본문만 살짝 떠오르며 나타나,
 * 표시 조각이 미끄러지는 동안 내용이 한 번에 툭 바뀌지 않게 한다. 동작 줄이기 설정이면 하지 않는다.
 */
export function fadeInRouteContent(root: HTMLElement, direction: RouteDirection = "vertical"): void {
  if (reducedMotion(root.ownerDocument?.defaultView ?? null)) return;
  for (const child of Array.from(root.children) as HTMLElement[]) {
    if (typeof child.animate !== "function" || child.matches(".mia-header, .mia-sr-only") || child.querySelector(".mia-nav")) continue;
    child.animate([{ opacity: 0, transform: routeOffsets[direction] }, { opacity: 1, transform: "none" }],
      { duration: CONTENT_FADE_MS, easing: CONTENT_EASING, fill: "backwards" });
  }
}

export function routeDirection(fromIndex: number | undefined, toIndex: number | undefined): RouteDirection {
  if (fromIndex === undefined || toIndex === undefined || fromIndex === toIndex) return "vertical";
  return toIndex > fromIndex ? "next" : "prev";
}

export function studyCardDirection(last: { index: number; id: string } | null, index: number, id: string): "next" | "prev" | null {
  if (!last || (last.index === index && last.id === id)) return null;
  return index < last.index ? "prev" : "next";
}

export function animateProgressFill(fill: HTMLElement, fromRatio: number, toRatio: number): void {
  if (fromRatio === toRatio || !Number.isFinite(fromRatio) || !Number.isFinite(toRatio)) return;
  if (typeof fill.animate !== "function" || reducedMotion(fill.ownerDocument.defaultView)) return;
  fill.animate([{ width: `${fromRatio * 100}%` }, { width: `${toRatio * 100}%` }],
    { duration: 240, easing: "cubic-bezier(.22, 1, .36, 1)" });
}

function reveal(element: Element, transform: string, duration: number): void {
  if (typeof element.animate !== "function") return;
  element.animate([{ opacity: 0, transform }, { opacity: 1, transform: "none" }],
    { duration, fill: "backwards" });
}

export function fadeInElement(element: HTMLElement): void {
  if (reducedMotion(element.ownerDocument?.defaultView ?? null)) return;
  reveal(element, "translateY(5px)", 160);
}

export function bindDetailsReveal(root: HTMLElement): void {
  for (const details of root.querySelectorAll<HTMLDetailsElement>("details")) {
    const summary = details.querySelector(":scope > summary");
    if (!summary || boundDetails.has(details)) continue;
    boundDetails.add(details);
    let openingClick: Event | null = null;
    summary.addEventListener("click", event => {
      if (details.open || event.defaultPrevented) {
        openingClick = null;
        return;
      }
      openingClick = event;
      // 기본 동작으로 열리지 않은 클릭은 나중의 코드 복원에 영향을 주지 않는다.
      details.ownerDocument.defaultView?.setTimeout(() => {
        if (openingClick === event && (event.defaultPrevented || !details.open)) openingClick = null;
      }, 0);
    });
    details.addEventListener("toggle", event => {
      if (event.target !== details) return;
      const click = openingClick;
      openingClick = null;
      if (!click || click.defaultPrevented || !details.open || reducedMotion(details.ownerDocument.defaultView)) return;
      for (const child of details.children) {
        if (!child.matches("summary")) reveal(child, "translateY(-4px)", 150);
      }
    });
  }
}

/**
 * 한 화면(뷰)에 하나. 다시 그리기 전 capture, 그린 뒤 schedule을 부른다.
 * 한 프레임 안에 여러 번 다시 그려도 가장 처음 위치에서 한 번만 미끄러진다.
 * 분리 창에서도 맞도록 그 화면이 속한 창의 requestAnimationFrame을 쓴다.
 */
export class NavGlideScheduler {
  private frame: number | null = null;
  private frameWindow: Window | null = null;
  private from: NavTabRect | null = null;
  private fromIndex: number | undefined;

  capture(root: HTMLElement): void {
    if (this.frame !== null) return;
    this.from = snapshotActiveTab(root);
    this.fromIndex = activeTabIndex(root);
  }

  schedule(root: HTMLElement): void {
    const win = this.from ? root.ownerDocument?.defaultView : null;
    if (!this.from || !win || typeof win.requestAnimationFrame !== "function") { this.cancel(); return; }
    if (this.frame !== null) this.frameWindow?.cancelAnimationFrame(this.frame);
    this.frameWindow = win;
    this.frame = win.requestAnimationFrame(() => {
      this.frame = null;
      const from = this.from, fromIndex = this.fromIndex;
      this.from = null;
      this.fromIndex = undefined;
      glideActiveTab(root, from, fromIndex);
    });
  }

  cancel(): void {
    if (this.frame !== null) this.frameWindow?.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.frameWindow = null;
    this.from = null;
    this.fromIndex = undefined;
  }
}
