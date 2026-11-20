import type { NightPreference } from "../services/study-ui-store";

/** Obsidian 전체 적색 야간 모드일 때 `document.body`에 붙는 클래스. 화면 덮개와 어두운 색은 styles.css가 맡는다. */
export const NIGHT_GLOBAL_CLASS = "mia-night-global";

/** 저장된 야간 설정을 body 클래스에 반영한다. Obsidian의 테마 클래스는 건드리지 않는다. */
export class NightModeController {
  constructor(private readonly body: HTMLElement | null, private readonly read: () => NightPreference) {}

  apply(): NightPreference {
    const preference = this.read();
    this.body?.classList.toggle(NIGHT_GLOBAL_CLASS, preference.nightMode && preference.nightScope === "app");
    return preference;
  }

  destroy(): void {
    this.body?.classList.remove(NIGHT_GLOBAL_CLASS);
  }
}
