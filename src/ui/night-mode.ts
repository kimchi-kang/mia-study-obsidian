import type { NightPreference } from "../services/study-ui-store";

/** Obsidian 전체 적색 야간 모드일 때 `body`에 붙는 클래스. 화면 덮개와 어두운 색은 styles.css가 맡는다. */
export const NIGHT_GLOBAL_CLASS = "mia-night-global";
/** 범위가 MIA 화면뿐일 때 `body`에 붙는 클래스. MIA 창(모달)도 MIA 화면과 같이 적색으로 보이게 한다. */
export const NIGHT_LOCAL_CLASS = "mia-night-local";

/**
 * 저장된 야간 설정을 창마다의 body 클래스에 반영한다. Obsidian의 테마 클래스는 건드리지 않는다.
 * 데스크톱에서 떼어 낸 별도 창(popout)도 `attach`로 같은 상태를 받는다.
 */
export class NightModeController {
  private readonly bodies = new Set<HTMLElement>();

  constructor(body: HTMLElement | null, private readonly read: () => NightPreference) {
    if (body) this.bodies.add(body);
  }

  apply(): NightPreference {
    const preference = this.read();
    for (const body of this.bodies) this.paint(body, preference);
    return preference;
  }

  attach(body: HTMLElement): void {
    this.bodies.add(body);
    this.paint(body, this.read());
  }

  detach(body: HTMLElement): void {
    this.bodies.delete(body);
    body.classList.remove(NIGHT_GLOBAL_CLASS, NIGHT_LOCAL_CLASS);
  }

  destroy(): void {
    for (const body of this.bodies) body.classList.remove(NIGHT_GLOBAL_CLASS, NIGHT_LOCAL_CLASS);
    this.bodies.clear();
  }

  private paint(body: HTMLElement, { nightMode, nightScope }: NightPreference): void {
    body.classList.toggle(NIGHT_GLOBAL_CLASS, nightMode && nightScope === "app");
    body.classList.toggle(NIGHT_LOCAL_CLASS, nightMode && nightScope === "plugin");
  }
}
