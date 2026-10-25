import { Notice, Setting } from "obsidian";
import type MiaStudyPlugin from "../main";
import { DEFAULT_STUDY_MANAGEMENT, type StudyManagementSettings } from "../core/models";
import { parseSteps, validParameters } from "../core/study-management";

type Save = (action: () => Promise<void>) => Promise<void>;

/** The dashboard and Obsidian settings share the same draft, validation and save. */
export function renderStudyManagementSettings(container: HTMLElement, plugin: MiaStudyPlugin, save: Save): void {
  const render = (initial: StudyManagementSettings, defaultsLoaded = false) => {
    container.empty();
    const draft = structuredClone(initial);
    const validators: Array<() => boolean> = [];
    container.createEl("h3", { text: "학습 설정" });
    container.createEl("p", { text: "하루 학습량과 다시 볼 간격을 정하세요. 저장하면 다음 학습부터 적용됩니다.", cls: "setting-item-description" });
    const status = container.createEl("p", { text: defaultsLoaded ? "기본값을 불러왔습니다. 저장하면 적용됩니다." : "현재 저장된 설정입니다.", cls: "mia-settings-status" });
    status.setAttribute("role", "status");
    const changed = () => status.setText("아직 저장하지 않은 변경사항이 있습니다.");
    const basic = container.createDiv({ cls: "mia-settings-basic" });
    const advanced = container.createEl("details", { cls: "mia-settings-advanced" });
    advanced.createEl("summary", { text: "세부 설정 · 출제 순서와 FSRS" });
    const extra = advanced.createDiv();
    const fail = (message: string, input: HTMLElement, expert = false) => {
      if (expert) advanced.open = true;
      status.setText(message);
      input.focus();
      new Notice(message);
      return false;
    };
    const number = (root: HTMLElement, key: "newCardsPerDay" | "reviewsPerDay" | "dayStartsAt", name: string, desc: string, max: number) => {
      let value = String(draft[key]); let input!: HTMLInputElement;
      new Setting(root).setName(name).setDesc(desc).addText(text => {
        input = text.inputEl;
        text.setValue(value).onChange(next => { value = next; changed(); });
        input.type = "number"; input.min = "0"; input.max = String(max); input.step = "1";
        input.setAttribute("aria-label", name);
      });
      validators.push(() => {
        const parsed = Number(value);
        if (!input.validity.valid || !value.trim() || !Number.isInteger(parsed) || parsed < 0 || parsed > max) return fail(`${name}: 0–${max} 사이 정수를 입력하세요.`, input, root === extra);
        draft[key] = parsed; return true;
      });
    };
    number(basic, "newCardsPerDay", "하루 새 문제", "처음 배우는 문제 수입니다. 기본 20개 · 0이면 새 문제를 쉽니다.", 9999);
    number(basic, "reviewsPerDay", "하루 최대 복습", "기본 200회. 같은 날의 짧은 반복은 이 횟수에서 빠집니다.", 9999);
    basic.createEl("h4", { text: "다시 보는 간격" });
    for (const [key, title] of [["learningSteps", "처음 배우는 문제"], ["relearningSteps", "틀린 문제"]] as const) {
      const section = basic.createDiv({ cls: "mia-step-editor" });
      section.createEl("h5", { text: title });
      let automatic = draft[key].length === 0;
      const list = section.createDiv({ cls: "mia-step-list" });
      const rows: Array<{ value: string; unit: string; input: HTMLInputElement; select: HTMLSelectElement; remove: HTMLButtonElement }> = [];
      const labelRows = () => rows.forEach((row, index) => {
        row.input.setAttribute("aria-label", `${title} ${index + 1}단계 간격`);
        row.select.setAttribute("aria-label", `${title} ${index + 1}단계 단위`);
        row.remove.setAttribute("aria-label", `${title} ${index + 1}단계 삭제`);
      });
      const add = (step: string) => {
        const value = step.slice(0, -1); const unit = step.slice(-1);
        const row = list.createDiv({ cls: "mia-step-row" });
        const input = row.createEl("input", { attr: { type: "number", min: "0", step: "any", inputmode: "decimal" } });
        const select = row.createEl("select");
        const remove = row.createEl("button", { text: "삭제", attr: { type: "button" } });
        const item = { value, unit, input, select, remove };
        input.value = value;
        input.addEventListener("input", () => { item.value = input.value; changed(); });
        for (const [value, text] of [["m", "분 후"], ["h", "시간 후"], ["d", "일 후"]] as const) select.createEl("option", { value, text });
        select.value = unit;
        select.addEventListener("change", () => { item.unit = select.value; changed(); });
        remove.addEventListener("click", () => { rows.splice(rows.indexOf(item), 1); row.remove(); labelRows(); changed(); });
        rows.push(item);
        labelRows();
      };
      for (const step of draft[key]) add(step);
      if (!draft[key].length) add(key === "learningSteps" ? "1m" : "10m");
      let modeSelect!: HTMLSelectElement;
      const mode = new Setting(section).setName("간격 결정").addDropdown(control => {
        modeSelect = control.selectEl;
        control.addOption("manual", "직접 정하기").addOption("auto", "자동으로 정하기").setValue(automatic ? "auto" : "manual");
        control.selectEl.setAttribute("aria-label", `${title} 간격 결정`);
        control.onChange(value => { automatic = value === "auto"; list.hidden = automatic; addButton.hidden = automatic; changed(); });
      });
      modeSelect.removeAttribute("aria-labelledby");
      mode.settingEl.addClass("mia-step-mode");
      list.hidden = automatic;
      const addButton = section.createEl("button", { text: "단계 추가", attr: { type: "button", "aria-label": `${title} 단계 추가` } });
      addButton.hidden = automatic;
      addButton.addEventListener("click", () => { add("10m"); changed(); });
      section.createEl("p", { text: "순서대로 간격을 거쳐 학습합니다. 자동을 선택하면 FSRS가 간격을 계산합니다.", cls: "setting-item-description" });
      validators.push(() => {
        if (automatic) { draft[key] = []; return true; }
        if (!rows.length) return fail(`${title}: 단계를 추가하거나 자동으로 정하기를 선택하세요.`, addButton);
        const steps: StudyManagementSettings[typeof key] = [];
        for (const row of rows) {
          const parsed = row.input.validity.valid && row.value.trim() ? parseSteps(`${row.value}${row.unit}`) : null;
          if (!parsed) return fail(`${title}: 간격은 1분 이상이어야 하고 분 단위로 나누어떨어져야 합니다.`, row.input);
          steps.push(...parsed);
        }
        draft[key] = steps; return true;
      });
    }
    const choice = <K extends "newCardOrder" | "newReviewOrder" | "reviewOrder">(key: K, name: string, options: Record<StudyManagementSettings[K], string>) => {
      new Setting(extra).setName(name).addDropdown(control => {
        for (const [value, label] of Object.entries(options)) if (typeof label === "string") control.addOption(value, label);
        control.setValue(draft[key]).onChange(value => {
          const selected = (Object.keys(options) as StudyManagementSettings[K][]).find(item => item === value);
          if (selected) { draft[key] = selected; changed(); }
        });
      });
    };
    const toggle = (key: "newCardsIgnoreReviewLimit" | "enableFuzz", name: string, desc: string) => {
      const row = new Setting(extra).setName(name).setDesc(desc);
      const state = row.controlEl.createSpan({ text: draft[key] ? "켜짐" : "꺼짐", cls: "mia-toggle-state" });
      state.setAttribute("aria-hidden", "true");
      row.addToggle(control => control.setValue(draft[key]).onChange(value => { draft[key] = value; state.setText(value ? "켜짐" : "꺼짐"); changed(); }));
    };
    number(extra, "dayStartsAt", "하루를 새로 시작하는 시각", "기기 시간 기준 · 기본 오전 4시", 23);
    toggle("newCardsIgnoreReviewLimit", "복습 상한과 별개로 새 문제 학습", "켜면 복습 횟수를 다 채워도 새 문제를 배울 수 있습니다.");
    choice("newCardOrder", "새 문제 순서", { sequential: "문제 목록 순서", random: "무작위" });
    choice("newReviewOrder", "새 문제와 복습", { before: "새 문제 먼저", after: "복습 먼저", mix: "섞어서" });
    choice("reviewOrder", "복습 순서", { due: "복습일이 빠른 순", retrievability: "잊었을 가능성이 높은 순", random: "무작위", "interval-ascending": "짧은 간격 먼저", "interval-descending": "긴 간격 먼저" });
    toggle("enableFuzz", "복습일 나누기", "비슷한 문제의 복습이 같은 날에 몰리지 않게 분산합니다.");
    let parameters = draft.fsrsParameters.join(", "); let parameterInput!: HTMLTextAreaElement;
    new Setting(extra).setName("FSRS-6 매개변수").setDesc("Anki에서 복사한 가중치 21개입니다. 잘 모르면 비워 두세요.").addTextArea(text => {
      parameterInput = text.inputEl;
      text.setValue(parameters).setPlaceholder("기본값 사용").onChange(value => { parameters = value; changed(); });
      text.inputEl.setAttribute("aria-label", "FSRS-6 매개변수");
    });
    validators.push(() => {
      const value = parameters.trim();
      const parsed = value ? value.replace(/^\[|\]$/g, "").split(/[\s,]+/).map(Number) : [];
      if (!validParameters(parsed)) return fail("FSRS-6 매개변수는 유효한 숫자 21개여야 합니다.", parameterInput, true);
      draft.fsrsParameters = parsed; return true;
    });
    extra.createEl("p", { text: "전체 과목에 같은 설정이 적용됩니다. 이미 예약된 복습일은 유지됩니다. 평가 버튼별 고정 간격을 설정했다면 그 값이 우선합니다.", cls: "setting-item-description" });
    const actions = container.createDiv({ cls: "mia-learning-settings-actions" });
    actions.createEl("button", { text: "기본값 불러오기", attr: { type: "button" } }).addEventListener("click", () => render(structuredClone(DEFAULT_STUDY_MANAGEMENT), true));
    const button = actions.createEl("button", { text: "학습 설정 저장", cls: "mod-cta", attr: { type: "button" } });
    button.addEventListener("click", async () => {
      if (!validators.every(validate => validate())) return;
      button.disabled = true;
      try {
        await save(async () => {
          await plugin.updateSettings({ studyManagement: draft });
          status.setText("저장했습니다. 다음 학습부터 적용됩니다.");
          new Notice("학습 설정을 저장했습니다.");
        });
      } finally { button.disabled = false; }
    });
  };
  render(plugin.store.settings.studyManagement);
}
