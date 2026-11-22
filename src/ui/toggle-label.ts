import type { ToggleComponent } from "obsidian";

/**
 * Obsidian 스위치는 설정 이름과 연결되지 않아 화면 읽기 프로그램에 "체크박스"로만 읽힌다.
 * 스위치 자체와 안쪽 체크박스에 설정 이름을 붙여, 이름과 켜짐·꺼짐 상태가 함께 읽히게 한다.
 */
export function labelToggle(toggle: ToggleComponent, name: string): ToggleComponent {
  const el = toggle.toggleEl as HTMLElement | undefined;
  el?.setAttribute("aria-label", name);
  el?.querySelector?.("input")?.setAttribute("aria-label", name);
  return toggle;
}
