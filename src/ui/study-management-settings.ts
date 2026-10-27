import { learningStepGuidance } from "./study-policy";
import { Notice, Setting } from "obsidian";
import type MiaStudyPlugin from "../main";
import { DEFAULT_STUDY_MANAGEMENT, type StudyManagementSettings } from "../core/models";
import { parseSteps, validParameters } from "../core/study-management";

import { WORKLOAD_PRESETS, RETENTION_PRESETS, workloadPreset, hasCustomAdvancedSettings, studySettingsPatch } from "../core/simple-study-settings";

type Save = (action: () => Promise<void>) => Promise<void>;

/** The dialog and Obsidian settings share validation and explicit saving. */
export function renderStudyManagementSettings(container: HTMLElement, plugin: MiaStudyPlugin, save: Save, cancel?: () => void): void {
  let baseline = structuredClone(plugin.store.settings);
  const render = (initial: StudyManagementSettings) => {
    container.empty();
    const draft = structuredClone(initial);
    let retention = baseline.targetRetention;
    const validators: Array<() => boolean> = [];
    if (!cancel) container.createEl("h3", { text: "학습 설정" });
    container.createEl("p", { text: "전체 과목에 적용됩니다. 공부량은 다음 학습 시작부터, 복습 간격은 저장 후 다음 평가부터 적용됩니다. 진행 중인 출제 목록과 기존 복습일·기록은 유지됩니다.", cls: "setting-item-description" });
    const status = container.createEl("p", { text: "현재 저장된 설정입니다.", cls: "mia-settings-status" });
    status.setAttribute("role", "status");
    const changed = () => { status.setText("아직 저장하지 않은 변경사항이 있습니다."); refresh(); };
    const modes = container.createDiv({ cls: "mia-settings-modes", attr: { role: "group", "aria-label": "학습 설정 화면" } });
    const simpleButton = modes.createEl("button", { text: "간편 설정", attr: { type: "button", "aria-pressed": "true" } });
    const advancedButton = modes.createEl("button", { text: "고급 설정", attr: { type: "button", "aria-pressed": "false" } });
    const summary = container.createEl("p", { cls: "mia-settings-summary", attr: { "aria-live": "polite" } });
    const simple = container.createDiv({ cls: "mia-settings-simple" });
    simple.createEl("h4", { text: "공부량" });
    let workloadSelect!: HTMLSelectElement;
    new Setting(simple).setName("공부량 프리셋").setDesc("새 문제와 복습 상한 두 값만 바꿉니다. 가볍게 10개/100회 · 보통 20개/200회 · 많이 40개/400회. 두 상한만 바꾸며, 실제 출제는 당일 기록과 대기 문제에 따라 줄어듭니다. 복습 간격은 바뀌지 않습니다.").addDropdown(control => {
      workloadSelect = control.selectEl;
      control.addOption("custom", "사용자 지정");
      for (const [id, preset] of Object.entries(WORKLOAD_PRESETS)) control.addOption(id, preset.label);
      control.selectEl.setAttribute("aria-label", "공부량 프리셋");
      control.onChange(value => {
        const preset = Object.entries(WORKLOAD_PRESETS).find(([id]) => id === value)?.[1];
        if (!preset) { refresh(); return; }
        draft.newCardsPerDay = preset.newCardsPerDay; draft.reviewsPerDay = preset.reviewsPerDay;
        for (const key of ["newCardsPerDay", "reviewsPerDay"] as const) countInputs.get(key)!.value = String(draft[key]);
        changed();
      });
    });
    const countInputs = new Map<string, HTMLInputElement>();
    const basic = container.createDiv({ cls: "mia-settings-basic" });
    const advanced = container.createDiv({ cls: "mia-settings-expert" });
    advanced.hidden = true;
    const extra = advanced.createDiv();
    const showAdvanced = (expert: boolean) => {
      simple.hidden = expert; advanced.hidden = !expert;
      if (expert) container.insertBefore(basic, advanced);
      else simple.insertBefore(basic, budgetNote);
      simpleButton.setAttribute("aria-pressed", String(!expert)); advancedButton.setAttribute("aria-pressed", String(expert));
    };
    simpleButton.addEventListener("click", () => showAdvanced(false));
    advancedButton.addEventListener("click", () => showAdvanced(true));
    const fail = (message: string, input: HTMLElement, expert = false) => {
      if (expert) showAdvanced(true);
      status.setText(message);
      input.focus();
      new Notice(message);
      return false;
    };
    const number = (root: HTMLElement, key: "newCardsPerDay" | "reviewsPerDay" | "dayStartsAt", name: string, desc: string, max: number) => {
      let input!: HTMLInputElement;
      new Setting(root).setName(name).setDesc(desc).addText(text => {
        input = text.inputEl;
        text.setValue(String(draft[key])).onChange(next => {
          const parsed = Number(next);
          if (next.trim() && Number.isInteger(parsed) && parsed >= 0 && parsed <= max && input.validity.valid) draft[key] = parsed;
          changed();
        });
        if (key !== "dayStartsAt") countInputs.set(key, input);
        input.type = "number"; input.min = "0"; input.max = String(max); input.step = "1";
        input.setAttribute("aria-label", name);
      });
      validators.push(() => {
        const parsed = Number(input.value);
        if (!input.validity.valid || !input.value.trim() || !Number.isInteger(parsed) || parsed < 0 || parsed > max) return fail(`${name}: 0–${max} 사이 정수를 입력하세요.`, input, root === extra);
        draft[key] = parsed; return true;
      });
    };
    number(basic, "newCardsPerDay", "하루에 새로 배울 문제 수", "0–9999 사이 정수입니다. 0이면 새 문제를 쉬며, 이미 공부한 양은 차감됩니다.", 9999);
    number(basic, "reviewsPerDay", "하루 복습량", "0–9999 사이 정수입니다. 0이면 예정 복습을 쉬지만 같은 날의 짧은 반복은 계속 나올 수 있습니다.", 9999);
    const budgetNote = container.createEl("p", { cls: "setting-item-description" });
    simple.append(basic, budgetNote);
    simple.createEl("h4", { text: "복습 간격 방향" });
    let retentionSelect!: HTMLSelectElement; let retentionInput!: HTMLInputElement;
    new Setting(simple).setName("다시 보는 빈도").setDesc("목표 기억률을 높이면 FSRS가 일반적으로 간격을 짧게 계산해 복습이 늘어납니다. 실제 기억률을 보장하거나 하루 상한을 늘리지는 않습니다.").addDropdown(control => {
      retentionSelect = control.selectEl; control.addOption("custom", "사용자 지정");
      for (const [value, label] of Object.entries(RETENTION_PRESETS)) control.addOption(value, label);
      control.selectEl.setAttribute("aria-label", "다시 보는 빈도");
      control.onChange(value => { if (value === "custom") { refresh(); return; } retention = Number(value); retentionInput.value = String(retention); changed(); });
    });
    new Setting(extra).setName("목표 기억률").setDesc("0.70–0.99. 간편 설정의 다시 보는 빈도와 같은 값입니다.").addText(control => {
      retentionInput = control.inputEl;
      control.setValue(String(retention)).onChange(value => { const parsed = Number(value); if (value.trim() && Number.isFinite(parsed) && parsed >= .7 && parsed <= .99) retention = parsed; changed(); });
      retentionInput.type = "number"; retentionInput.min = "0.7"; retentionInput.max = "0.99"; retentionInput.step = "any"; retentionInput.setAttribute("aria-label", "목표 기억률");
    });
    validators.push(() => retentionInput.value.trim() && retentionInput.validity.valid && Number(retentionInput.value) >= .7 && Number(retentionInput.value) <= .99 ? true : fail("목표 기억률: 0.70–0.99 사이 숫자를 입력하세요.", retentionInput, true));
    const retentionError = simple.createEl("p", { cls: "mia-warning", attr: { role: "status" } });
    const advancedNote = simple.createEl("p", { cls: "setting-item-description" });
    const changes = container.createEl("p", { cls: "mia-settings-changes", attr: { "aria-live": "polite" } });
    function refresh() {
      const invalid = [...countInputs.values()].some(input => !input.value.trim() || !input.validity.valid);
      summary.setText(invalid ? "공부량에 0–9999 사이 정수를 입력하세요. 올바른 값을 입력하면 요약이 표시됩니다." : `자동 출제 기준: 하루 새 문제 최대 ${draft.newCardsPerDay}개, 복습 최대 ${draft.reviewsPerDay}회`);
      workloadSelect.value = invalid ? "custom" : workloadPreset(draft);
      const invalidRetention = !retentionInput.value.trim() || !retentionInput.validity.valid || Number(retentionInput.value) < .7 || Number(retentionInput.value) > .99;
      retentionSelect.value = !invalidRetention && Object.hasOwn(RETENTION_PRESETS, String(retention)) ? String(retention) : "custom";
      retentionError.setText(invalidRetention ? "목표 기억률 입력을 확인하세요. 고급 설정에서 0.70–0.99를 입력하거나 여기서 빈도를 다시 선택하세요. 아직 저장되지 않았습니다." : "");
      retentionError.hidden = !invalidRetention;
      budgetNote.setText(`하루 제한은 기기 시간 기준 ${draft.dayStartsAt < 12 ? "오전" : "오후"} ${draft.dayStartsAt % 12 || 12}시에 새로 계산합니다. 세션을 다시 시작해도 당일 공부한 양은 차감됩니다. 같은 날의 짧은 반복은 상한에 포함되지 않습니다. 상한을 넘은 예정 복습은 이후 학습으로 밀려 쌓일 수 있습니다. ${draft.newCardsIgnoreReviewLimit ? "새 문제는 복습 상한과 별도로 셉니다." : "새 문제도 복습 상한을 함께 사용하므로, 복습이 상한을 채우면 새 문제는 나오지 않습니다."} 이 상한은 시험 모드를 새로 시작할 때의 자동 출제에 적용됩니다. 이어하기와 직접 추가한 문제는 기존 목록을 유지하며, 자유 암기에는 적용되지 않습니다.`);
      advancedNote.setText(`${hasCustomAdvancedSettings({ ...baseline, studyManagement: draft }) ? "고급 설정: 사용자 지정. 기존 세부 값을 유지합니다." : "고급 설정: 기본값."} ${Object.keys(baseline.gradeIntervalsMinutes).length ? "평가 버튼에 지정된 고정 간격이 우선하므로 해당 버튼에는 빈도 선택이 적용되지 않습니다." : "기존 복습일은 바뀌지 않고, 다음 평가에서 새 간격을 계산합니다."}`);
      const patch = studySettingsPatch(baseline, draft, retention, plugin.store.settings);
      const labels: Record<keyof StudyManagementSettings, string> = { newCardsPerDay: "새 문제 상한", reviewsPerDay: "복습 상한", newCardsIgnoreReviewLimit: "새 문제와 복습 상한의 관계", dayStartsAt: "하루 시작 시각", learningSteps: "처음 배우는 문제의 반복 간격", relearningSteps: "틀린 문제의 반복 간격", newCardOrder: "새 문제 순서", newReviewOrder: "새 문제와 복습 순서", reviewOrder: "복습 순서", enableFuzz: "복습일 분산", fsrsParameters: "FSRS 매개변수" };
      const fields = Object.keys(draft).filter(key => JSON.stringify(draft[key as keyof StudyManagementSettings]) !== JSON.stringify(baseline.studyManagement[key as keyof StudyManagementSettings])).map(key => labels[key as keyof StudyManagementSettings]);
      if (patch.targetRetention !== undefined) fields.push(`목표 기억률 ${Number((baseline.targetRetention * 100).toFixed(10))}% → ${Number((retention * 100).toFixed(10))}%`);
      changes.setText(fields.length ? `저장 시 변경: ${fields.join(", ")}. 그 외 설정과 학습 기록은 유지됩니다.` : "변경된 값이 없습니다. 화면 전환만으로 설정은 바뀌지 않습니다.");
    }
    extra.createEl("p", { text: "이 화면에서 수정한 세부 값도 학습 설정 저장 버튼으로 함께 저장합니다.", cls: "setting-item-description" });
    extra.createEl("h4", { text: "다시 보는 간격 · 학습 단계" });
    for (const [key, title] of [["learningSteps", "처음 배우는 문제"], ["relearningSteps", "틀린 문제"]] as const) {
      const section = extra.createDiv({ cls: "mia-step-editor" });
      section.createEl("h5", { text: title });
      const guidance = section.createEl("p", { text: learningStepGuidance(draft[key], baseline.gradeIntervalsMinutes[2] !== undefined), cls: "setting-item-description mia-step-guidance", attr: { "aria-live": "polite" } });
      let automatic = draft[key].length === 0;
      const list = section.createDiv({ cls: "mia-step-list" });
      const rows: Array<{ value: string; unit: string; input: HTMLInputElement; select: HTMLSelectElement; remove: HTMLButtonElement }> = [];
      const updateSteps = () => {
        const steps = automatic ? [] : parseSteps(rows.map(row => `${row.value}${row.unit}`).join(" "));
        if (steps) draft[key] = steps;
        guidance.setText(learningStepGuidance(steps, baseline.gradeIntervalsMinutes[2] !== undefined));
        changed();
      };
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
        input.addEventListener("input", () => { item.value = input.value; updateSteps(); });
        for (const [value, text] of [["m", "분 후"], ["h", "시간 후"], ["d", "일 후"]] as const) select.createEl("option", { value, text });
        select.value = unit;
        select.addEventListener("change", () => { item.unit = select.value; updateSteps(); });
        remove.addEventListener("click", () => { rows.splice(rows.indexOf(item), 1); row.remove(); labelRows(); updateSteps(); });
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
        control.onChange(value => { automatic = value === "auto"; list.hidden = automatic; addButton.hidden = automatic; updateSteps(); });
      });
      modeSelect.removeAttribute("aria-labelledby");
      mode.settingEl.addClass("mia-step-mode");
      list.hidden = automatic;
      const addButton = section.createEl("button", { text: "단계 추가", attr: { type: "button", "aria-label": `${title} 단계 추가` } });
      addButton.hidden = automatic;
      addButton.addEventListener("click", () => { add("10m"); updateSteps(); });
      section.createEl("p", { text: "24시간 미만 단계는 순서대로 진행합니다. 자동을 선택하면 간격을 자동 계산합니다.", cls: "setting-item-description" });
      validators.push(() => {
        if (automatic) { draft[key] = []; return true; }
        if (!rows.length) return fail(`${title}: 단계를 추가하거나 자동으로 정하기를 선택하세요.`, addButton);
        const steps: StudyManagementSettings[typeof key] = [];
        for (const row of rows) {
          const parsed = row.input.validity.valid && row.value.trim() ? parseSteps(`${row.value}${row.unit}`) : null;
          if (!parsed) return fail(`${title}: 간격은 1분 이상이어야 하고 분 단위로 나누어떨어져야 합니다.`, row.input, true);
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
      text.setValue(parameters).setPlaceholder("기본값 사용").onChange(value => {
        parameters = value;
        const parsed = value.trim() ? value.trim().replace(/^\[|\]$/g, "").split(/[\s,]+/).map(Number) : [];
        if (validParameters(parsed)) draft.fsrsParameters = parsed;
        changed();
      });
      text.inputEl.setAttribute("aria-label", "FSRS-6 매개변수");
    });
    validators.push(() => {
      const value = parameters.trim();
      const parsed = value ? value.replace(/^\[|\]$/g, "").split(/[\s,]+/).map(Number) : [];
      if (!validParameters(parsed)) return fail("FSRS-6 매개변수는 유효한 숫자 21개여야 합니다.", parameterInput, true);
      draft.fsrsParameters = parsed; return true;
    });
    extra.createEl("p", { text: "전체 과목에 같은 설정이 적용됩니다. 이미 예약된 복습일은 유지됩니다. 평가 버튼별 고정 간격을 설정했다면 그 값이 우선합니다.", cls: "setting-item-description" });
    container.createEl("p", { text: "기본값 불러오기는 새 문제 20개·복습 200회·목표 기억률 90%만 준비합니다. 저장 전에는 적용되지 않으며 고급 설정은 유지됩니다.", cls: "setting-item-description" });
    const actions = container.createDiv({ cls: "mia-learning-settings-actions mia-keyboard-actions" });
    actions.createEl("button", { text: "공부량·빈도만 기본값 불러오기", attr: { type: "button" } }).addEventListener("click", () => {
      draft.newCardsPerDay = DEFAULT_STUDY_MANAGEMENT.newCardsPerDay;
      draft.reviewsPerDay = DEFAULT_STUDY_MANAGEMENT.reviewsPerDay;
      retention = .9;
      for (const key of ["newCardsPerDay", "reviewsPerDay"] as const) countInputs.get(key)!.value = String(draft[key]);
      retentionInput.value = String(retention);
      changed();
    });
    if (cancel) actions.createEl("button", { text: "취소", attr: { type: "button" } }).addEventListener("click", cancel);
    const button = actions.createEl("button", { text: "학습 설정 저장", cls: "mod-cta", attr: { type: "button" } });
    button.addEventListener("click", async () => {
      if (!validators.every(validate => validate())) return;
      const controls = Array.from(container.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>("button, input, select, textarea"));
      const disabledBefore = controls.map(control => control.disabled);
      controls.forEach(control => { control.disabled = true; });
      container.setAttribute("aria-busy", "true");
      try {
        await save(async () => {
          const patch = studySettingsPatch(baseline, draft, retention, plugin.store.settings);
          if (Object.keys(patch).length) await plugin.updateSettings(patch, baseline);
          baseline = structuredClone(plugin.store.settings);
          render(baseline.studyManagement);

          new Notice("학습 설정을 저장했습니다.");
        });
      } finally {
        controls.forEach((control, index) => { control.disabled = disabledBefore[index]!; });
        container.removeAttribute("aria-busy");
      }
    });
    refresh();
  };
  render(baseline.studyManagement);
}
