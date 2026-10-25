import { Notice, Setting } from "obsidian";
import type MiaStudyPlugin from "../main";
import { DEFAULT_STUDY_MANAGEMENT, type StudyManagementSettings } from "../core/models";
import { parseSteps, validParameters } from "../core/study-management";

type Save = (action: () => Promise<void>) => Promise<void>;

export function renderStudyManagementSettings(container: HTMLElement, plugin: MiaStudyPlugin, save: Save, refresh: () => void): void {
  container.createEl("h3", { text: "상세 학습관리 · Anki 방식" });
  container.createEl("p", { text: "시험 모드에 적용되는 전체 과목 공통 설정입니다. 암기 모드는 일일 상한 없이 훑어볼 수 있습니다. 설정 변경은 다음 학습·평가부터 적용하며 기존 복습일과 이력은 유지합니다.", cls: "setting-item-description" });
  const draft = structuredClone(plugin.store.settings.studyManagement);
  const validators: Array<() => boolean> = [];
  const number = (key: "newCardsPerDay" | "reviewsPerDay" | "dayStartsAt", label: string, desc: string, max: number) => {
    let value = String(draft[key]); let valid = true;
    new Setting(container).setName(label).setDesc(desc).addText(text => {
      text.setValue(value).onChange(input => { value = input; valid = text.inputEl.validity.valid; });
      text.inputEl.type = "number"; text.inputEl.min = "0"; text.inputEl.max = String(max); text.inputEl.step = "1";
      text.inputEl.setAttribute("aria-label", label);
    });
    validators.push(() => {
      const parsed = Number(value);
      if (!valid || !value.trim() || !Number.isInteger(parsed) || parsed < 0 || parsed > max) {
        new Notice(`${label}: 0–${max} 사이 정수를 입력하세요.`); return false;
      }
      draft[key] = parsed; return true;
    });
  };
  const toggle = (key: "newCardsIgnoreReviewLimit" | "enableFuzz", label: string, desc: string) => {
    new Setting(container).setName(label).setDesc(desc).addToggle(control => control.setValue(draft[key]).onChange(value => { draft[key] = value; }));
  };
  const choice = <K extends "newCardOrder" | "newReviewOrder" | "reviewOrder">(key: K, label: string, options: Record<StudyManagementSettings[K], string>) => {
    new Setting(container).setName(label).addDropdown(control => {
      for (const [value, text] of Object.entries(options)) if (typeof text === "string") control.addOption(value, text);
      control.setValue(draft[key]).onChange(value => {
        const selected = (Object.keys(options) as StudyManagementSettings[K][]).find(item => item === value);
        if (selected) draft[key] = selected;
      });
    });
  };
  container.createEl("h4", { text: "일일 상한" });
  number("newCardsPerDay", "하루 새 문제", "Anki 기본값 20개. 0이면 새 문제를 출제하지 않습니다. 하루를 쉬어도 다음 날 상한이 누적되지 않습니다.", 9999);
  number("reviewsPerDay", "하루 최대 복습", "Anki 기본값 200회. 당일 단기 학습·재학습 반복은 제외하며, 날짜를 넘긴 학습은 포함합니다. 전체 과목에서 사용한 양을 합산합니다.", 9999);
  toggle("newCardsIgnoreReviewLimit", "새 문제는 복습 상한 무시", "끄면 새 문제도 남은 복습 상한 안에서 출제합니다. 켜면 복습 상한에 도달해도 새 문제를 학습할 수 있습니다.");
  number("dayStartsAt", "다음 날 시작 시각", "기기 현지 시각 기준. Anki 기본값은 오전 4시입니다. 일일 상한을 이 시각에 초기화합니다.", 23);
  container.createEl("h4", { text: "새 문제 · 재학습" });
  for (const [key, label, example] of [["learningSteps", "학습 단계", "1m 10m"], ["relearningSteps", "재학습 단계", "10m"]] as const) {
    let value = draft[key].join(" ");
    new Setting(container).setName(label).setDesc(`공백으로 구분: ${example}. m=분, h=시간, d=일. FSRS는 1일 미만을 권장합니다. 비우면 FSRS가 단기 간격도 계산합니다.`).addText(text => {
      text.setValue(value).setPlaceholder(example).onChange(input => { value = input; });
      text.inputEl.setAttribute("aria-label", label);
    });
    validators.push(() => {
      const steps = parseSteps(value);
      if (!steps) { new Notice(`${label}: 1m 10m처럼 양수와 m/h/d 단위를 입력하세요.`); return false; }
      draft[key] = steps; return true;
    });
  }
  container.createEl("h4", { text: "출제 순서" });
  choice("newCardOrder", "새 문제 순서", { sequential: "문제 목록 순서", random: "무작위" });
  choice("newReviewOrder", "새 문제 / 복습 순서", { before: "새 문제 먼저", after: "복습 먼저", mix: "복습과 섞기" });
  choice("reviewOrder", "복습 정렬", { due: "복습일이 빠른 순", retrievability: "기억 확률이 낮은 순", random: "무작위", "interval-ascending": "짧은 간격 먼저", "interval-descending": "긴 간격 먼저" });
  container.createEl("p", { text: "기한이 된 당일 학습·재학습 단계는 출제 순서나 일일 상한보다 우선합니다.", cls: "setting-item-description" });
  container.createEl("h4", { text: "FSRS 고급 설정" });
  toggle("enableFuzz", "복습일 분산", "비슷한 간격의 문제가 같은 날 몰리지 않도록 FSRS 간격에 작은 변화를 줍니다.");
  let parameters = draft.fsrsParameters.join(", ");
  new Setting(container).setName("FSRS-6 매개변수").setDesc("Anki에서 복사한 FSRS-6 가중치 21개를 쉼표로 구분해 입력하세요. 비우면 기본값을 사용합니다. 자동 최적화는 제공하지 않습니다.").addTextArea(text => {
    text.setValue(parameters).setPlaceholder("기본 FSRS-6 매개변수").onChange(value => { parameters = value; });
    text.inputEl.setAttribute("aria-label", "FSRS-6 매개변수");
  });
  validators.push(() => {
    const value = parameters.trim();
    const parsed = value ? value.replace(/^\[|\]$/g, "").split(/[\s,]+/).map(Number) : [];
    if (!validParameters(parsed)) { new Notice("FSRS-6 매개변수는 유효한 가중치 21개여야 합니다."); return false; }
    draft.fsrsParameters = parsed; return true;
  });
  new Setting(container).addButton(button => button.setButtonText("학습관리 설정 저장").setCta().onClick(async () => {
    if (!validators.every(validate => validate())) return;
    button.setDisabled(true);
    try {
      await save(async () => {
        await plugin.updateSettings({ studyManagement: draft });
        new Notice("학습관리 설정을 저장했습니다. 다음 학습과 평가부터 적용됩니다.");
      });
    } finally { button.setDisabled(false); }
  })).addButton(button => button.setButtonText("Anki 기본값 복원").onClick(async () => {
    await save(async () => {
      await plugin.updateSettings({ studyManagement: structuredClone(DEFAULT_STUDY_MANAGEMENT) });
      refresh();
      new Notice("학습관리 설정을 Anki 기본값으로 복원했습니다.");
    });
  }));
  container.createEl("p", { text: "Anki와의 차이: MIA는 FSRS-6 전용이며 전체 과목에 공통 상한을 적용합니다. 덱별 프리셋·형제 카드 묻기·오디오·타이머·자동 넘김·쉬운 요일·반복 실패 카드 관리·매개변수 자동 최적화·SM-2 전용 설정은 포함하지 않습니다. 단계는 실제 예약 시각에 출제하며 Anki의 날짜 경계 변환과는 다릅니다. 아래 평가별 고정 간격을 지정하면 FSRS와 학습 단계보다 우선합니다.", cls: "setting-item-description" });
  container.createEl("a", { text: "Anki 공식 학습관리 설정 설명", href: "https://docs.ankiweb.net/deck-options.html" });
}
