/**
 * 상단 탭을 옮길 때 선택 표시가 이전 탭 자리에서 새 탭 자리로 미끄러지게 한다.
 * 화면은 탭마다 새로 그려지므로, 그리기 전 선택 탭 위치를 기억했다가
 * 새로 그린 뒤 그 자리에서 출발하는 표시 조각을 잠깐 띄우고 지운다.
 */
export interface NavTabRect { left: number; top: number; width: number; height: number; }

const GLIDE_MS = 220;
const GLIDE_EASING = "cubic-bezier(.2, .7, .2, 1)";

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

/** 다시 그린 뒤 호출한다. 위치가 같거나 동작 줄이기 설정이면 아무것도 하지 않는다. */
export function glideActiveTab(root: HTMLElement, from: NavTabRect | null): void {
  if (!from) return;
  const view = root.ownerDocument.defaultView;
  if (!view || view.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
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

  capture(root: HTMLElement): void {
    if (this.frame === null) this.from = snapshotActiveTab(root);
  }

  schedule(root: HTMLElement): void {
    const win = this.from ? root.ownerDocument?.defaultView : null;
    if (!this.from || !win || typeof win.requestAnimationFrame !== "function") { this.cancel(); return; }
    if (this.frame !== null) this.frameWindow?.cancelAnimationFrame(this.frame);
    this.frameWindow = win;
    this.frame = win.requestAnimationFrame(() => {
      this.frame = null;
      const from = this.from;
      this.from = null;
      glideActiveTab(root, from);
    });
  }

  cancel(): void {
    if (this.frame !== null) this.frameWindow?.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.frameWindow = null;
    this.from = null;
  }
}
