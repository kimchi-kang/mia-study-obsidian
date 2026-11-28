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
  const tab = nav?.querySelector<HTMLElement>("button.mod-cta");
  return nav && tab ? { nav, tab } : null;
}

function rectInNav(nav: HTMLElement, tab: HTMLElement): NavTabRect | null {
  const outer = nav.getBoundingClientRect();
  const inner = tab.getBoundingClientRect();
  if (!inner.width || !inner.height) return null;
  return { left: inner.left - outer.left - nav.clientLeft, top: inner.top - outer.top - nav.clientTop, width: inner.width, height: inner.height };
}

/** 다시 그리기 전에 호출한다. 탭이 숨겨져 있으면 null. */
export function snapshotActiveTab(root: HTMLElement): NavTabRect | null {
  const found = activeTab(root);
  return found ? rectInNav(found.nav, found.tab) : null;
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
  const glide = root.ownerDocument.createElement("span");
  glide.className = "mia-nav-glide";
  glide.setAttribute("aria-hidden", "true");
  glide.style.setProperty("--mia-glide-left", `${to.left}px`);
  glide.style.setProperty("--mia-glide-top", `${to.top}px`);
  glide.style.setProperty("--mia-glide-width", `${to.width}px`);
  glide.style.setProperty("--mia-glide-height", `${to.height}px`);
  nav.prepend(glide);
  nav.classList.add("mia-nav-gliding");
  const finish = () => { glide.remove(); nav.classList.remove("mia-nav-gliding"); };
  const animation = glide.animate([
    { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)`, width: `${from.width}px`, height: `${from.height}px` },
    { transform: "translate(0, 0)", width: `${to.width}px`, height: `${to.height}px` },
  ], { duration: GLIDE_MS, easing: GLIDE_EASING });
  animation.onfinish = finish;
  animation.oncancel = finish;
}
