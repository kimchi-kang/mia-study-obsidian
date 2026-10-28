import { learningStepGuidance } from "./study-policy";
import { Notice, Setting } from "obsidian";
import type MiaStudyPlugin from "../main";
import { DEFAULT_SETTINGS, DEFAULT_STUDY_MANAGEMENT, type StudyManagementSettings, type SavedStudyProfile } from "../core/models";
import { parseSteps, validParameters } from "../core/study-management";

import { WORKLOAD_PRESETS, RETENTION_PRESETS, workloadPreset, hasCustomAdvancedSettings, studySettingsPatch, captureStudyProfile } from "../core/simple-study-settings";

type Save = (action: () => Promise<void>) => Promise<void>;

/** The dialog and Obsidian settings share validation and explicit saving. */
export function renderStudyManagementSettings(container: HTMLElement, plugin: MiaStudyPlugin, save: Save, cancel?: () => void): void {
  let baseline = structuredClone(plugin.store.settings);
  const render = (initial: StudyManagementSettings) => {
    container.empty();
    const draft = structuredClone(initial);
    let retention = baseline.targetRetention;
    let profiles = structuredClone(baseline.savedStudyProfiles ?? []);
    const stepSetters = new Map<string, () => void>();
    let loadPreview = "";
    const stepText = (steps: readonly string[]) => steps.map(step => step.replace("m", "분").replace("h", "시간").replace("d", "일")).join(" → ") || "자동";
    const percent = (value: number) => `${Number((value * 100).toFixed(10))}%`;
    const help = (root: HTMLElement, title: string, text: string) => {
      const detail = root.createEl("details", { cls: "mia-settings-help" });
      detail.createEl("summary", { text: title });
      detail.createEl("p", { text, cls: "setting-item-description" });
      return detail;
    };
    const validators: Array<() => boolean> = [];
    if (!cancel) container.createEl("h3", { text: "학습 설정" });
    container.createEl("p", { text: "전체 과목에 적용됩니다. 공부량은 다음 학습 시작부터, 복습 간격은 저장 후 다음 평가부터 적용됩니다. 진행 중인 출제 목록과 기존 복습일·기록은 유지됩니다.", cls: "setting-item-description" });
    const status = container.createEl("p", { text: "현재 저장된 설정입니다.", cls: "mia-settings-status" });
    status.setAttribute("role", "status");
    status.id = `mia-settings-status-${crypto.randomUUID()}`;
    const clearInvalid = (event: Event) => {
      if (event.target instanceof container.ownerDocument.defaultView!.HTMLElement) event.target.removeAttribute("aria-invalid");
    };
    container.oninput = clearInvalid;
    container.onchange = clearInvalid;
    const changed = (keepPreview = false) => { if (!keepPreview) loadPreview = ""; status.setText("아직 저장하지 않은 변경사항이 있습니다."); refresh(); };
    const modes = container.createDiv({ cls: "mia-settings-modes", attr: { role: "group", "aria-label": "학습 설정 화면" } });
    const simpleButton = modes.createEl("button", { text: "간편 설정", attr: { type: "button", "aria-pressed": "true" } });
    const advancedButton = modes.createEl("button", { text: "고급 설정", attr: { type: "button", "aria-pressed": "false" } });
    const summary = container.createEl("p", { cls: "mia-settings-summary", attr: { "aria-live": "polite" } });
    const simple = container.createDiv({ cls: "mia-settings-simple" });
    simple.createEl("h4", { text: "하루에 얼마나 공부할지" });
    let workloadSelect!: HTMLSelectElement;
    new Setting(simple).setName("공부량 프리셋").setDesc("하루 새 문제와 복습 상한만 준비합니다. 저장 전 아래 변경값을 확인하세요.").addDropdown(control => {
      workloadSelect = control.selectEl;
      control.addOption("custom", "사용자 지정");
      for (const [id, preset] of Object.entries(WORKLOAD_PRESETS)) control.addOption(id, preset.label);
      control.selectEl.setAttribute("aria-label", "공부량 프리셋");
      control.onChange(value => {
        const preset = Object.entries(WORKLOAD_PRESETS).find(([id]) => id === value)?.[1];
        if (!preset) { refresh(); return; }
        loadPreview = `${preset.label}: 새 문제 ${draft.newCardsPerDay}개 → ${preset.newCardsPerDay}개, 복습 ${draft.reviewsPerDay}회 → ${preset.reviewsPerDay}회. 공부량 두 값만 변경합니다.`;
        draft.newCardsPerDay = preset.newCardsPerDay; draft.reviewsPerDay = preset.reviewsPerDay;
        for (const key of ["newCardsPerDay", "reviewsPerDay"] as const) countInputs.get(key)!.value = String(draft[key]);
        changed(true);
      });
    });
    help(simple, "프리셋 선택 안내", "가볍게: 적은 양으로 시작할 때(10개/100회). 보통: 기본 공부량(20개/200회). 많이: 더 많은 새 문제를 시작하려 할 때(40개/400회). 하루 상한만 바꾸므로 기억력이나 학습 효과를 보장하지 않습니다. 실제 출제는 당일 기록과 대기 문제에 따라 줄어듭니다.");
    const countInputs = new Map<string, HTMLInputElement>();
    const basic = container.createDiv({ cls: "mia-settings-basic" });
    const advanced = container.createDiv({ cls: "mia-settings-expert" });
    advanced.hidden = true;
    const extra = advanced.createDiv();
    const stepGroups = container.createDiv({ cls: "mia-settings-step-groups" });
    const retentionGroup = simple.createDiv();
    retentionGroup.createEl("h4", { text: "복습을 얼마나 자주 할지" });
    const retentionDetails = retentionGroup.createEl("details", { cls: "mia-settings-help" });
    retentionDetails.createEl("summary", { text: "세부 조정 · 복습 목표 직접 입력" });
    const showAdvanced = (expert: boolean) => {
      simple.hidden = expert; advanced.hidden = !expert;
      if (expert) { container.insertBefore(basic, advanced); advanced.insertBefore(stepGroups, extra); advanced.append(retentionGroup); }
      else { simple.append(basic, budgetHelp, stepGroups, retentionGroup, advancedNote); }
      simpleButton.setAttribute("aria-pressed", String(!expert)); advancedButton.setAttribute("aria-pressed", String(expert));
    };
    simpleButton.addEventListener("click", () => showAdvanced(false));
    advancedButton.addEventListener("click", () => showAdvanced(true));
    const fail = (message: string, input: HTMLElement, expert = false) => {
      if (expert) showAdvanced(true);
      let parent = input.parentElement;
      while (parent && parent !== container) { if (parent.tagName === "DETAILS") parent.setAttribute("open", ""); parent = parent.parentElement; }
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", status.id);
      status.setText(message);
      input.focus();
      new Notice(message);
      return false;
    };
    const number = (root: HTMLElement, key: "newCardsPerDay" | "reviewsPerDay" | "dayStartsAt", name: string, desc: string, max: number) => {
      let input!: HTMLInputElement;
      const setting = new Setting(root).setName(name).setDesc(desc).addText(text => {
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
      setting.controlEl.addClass("mia-settings-number-control");
      setting.controlEl.createEl("button", { text: `기본값 ${DEFAULT_STUDY_MANAGEMENT[key]}`, attr: { type: "button", "aria-label": `${name}만 기본값 복원` } }).addEventListener("click", () => {
        draft[key] = DEFAULT_STUDY_MANAGEMENT[key]; input.value = String(draft[key]); changed(); input.focus();
      });
      validators.push(() => {
        const parsed = Number(input.value);
        if (!input.validity.valid || !input.value.trim() || !Number.isInteger(parsed) || parsed < 0 || parsed > max) return fail(`${name}: 0–${max} 사이 정수를 입력하세요.`, input, root === extra);
        draft[key] = parsed; return true;
      });
    };
    number(basic, "newCardsPerDay", "하루에 새로 배울 문제 수", "처음 시작할 문제의 하루 상한. 0–9999개 · 0이면 새 문제를 쉽니다.", 9999);
    number(basic, "reviewsPerDay", "하루 복습량", "예정 복습의 하루 상한. 0–9999회 · 0이면 예정 복습을 쉬지만 같은 날의 짧은 반복은 계속 나올 수 있습니다.", 9999);
    const budgetHelp = help(simple, "공부량을 늘리거나 줄이면? · 적용 범위", "상한을 높이면 대기 중인 문제가 더 나올 수 있고, 낮추면 남은 문제가 이후 학습으로 밀립니다. 예: 새 문제 10개 중 오늘 3개를 배웠다면 최대 7개를 더 시작합니다. 다음 학습 시작부터 적용합니다.");
    const budgetNote = budgetHelp.createEl("p", { cls: "setting-item-description" });
    simple.insertBefore(basic, budgetHelp);

    let retentionSelect!: HTMLSelectElement; let retentionInput!: HTMLInputElement;
    new Setting(retentionGroup).setName("다시 보는 빈도").setDesc("문제별 장기 복습 간격을 계산할 때 쓰는 목표입니다. 높일수록 대체로 더 자주 복습합니다.").addDropdown(control => {
      retentionSelect = control.selectEl; control.addOption("custom", "사용자 지정");
      for (const [value, label] of Object.entries(RETENTION_PRESETS)) control.addOption(value, label);
      control.selectEl.setAttribute("aria-label", "다시 보는 빈도");
      control.onChange(value => { if (value === "custom") { refresh(); return; } retention = Number(value); retentionInput.value = String(retention); changed(); });
    });
    new Setting(retentionDetails).setName("목표 기억률").setDesc("0.70–0.99(70–99%). 예: 0.923은 92.3% 목표. 실제 시험 정답률이나 기억을 보장하지 않습니다. 낮추면 대체로 복습 간격이 길어집니다. 고정 단계와 별개이며 기존 예약일은 다시 계산하지 않고 다음 평가부터 적용합니다.").addText(control => {
      retentionInput = control.inputEl;
      control.setValue(String(retention)).onChange(value => { const parsed = Number(value); if (value.trim() && Number.isFinite(parsed) && parsed >= .7 && parsed <= .99) retention = parsed; changed(); });
      retentionInput.type = "number"; retentionInput.min = "0.7"; retentionInput.max = "0.99"; retentionInput.step = "any"; retentionInput.setAttribute("aria-label", "목표 기억률");
    });
    validators.push(() => retentionInput.value.trim() && retentionInput.validity.valid && Number(retentionInput.value) >= .7 && Number(retentionInput.value) <= .99 ? true : fail("목표 기억률: 0.70–0.99 사이 숫자를 입력하세요.", retentionInput));
    retentionDetails.createEl("button", { text: "복습 목표만 기본값 90%로 복원", attr: { type: "button", "aria-label": "복습 목표만 기본값 복원" } }).addEventListener("click", () => {
      retention = DEFAULT_SETTINGS.targetRetention; retentionInput.value = String(retention); changed(); retentionInput.focus();
    });
    const retentionError = simple.createEl("p", { cls: "mia-warning", attr: { role: "status" } });
    const advancedNote = simple.createEl("p", { cls: "setting-item-description" });
    const changes = container.createEl("p", { cls: "mia-settings-changes", attr: { "aria-live": "polite" } });
    function refresh() {
      const invalid = [...countInputs.values()].some(input => !input.value.trim() || !input.validity.valid);
      summary.setText(invalid ? "공부량에 0–9999 사이 정수를 입력하세요. 올바른 값을 입력하면 요약이 표시됩니다." : `자동 출제 기준: 하루 새 문제 최대 ${draft.newCardsPerDay}개, 복습 최대 ${draft.reviewsPerDay}회 · 장기 복습 목표 ${Number((retention * 100).toFixed(10))}%`);
      workloadSelect.value = invalid ? "custom" : workloadPreset(draft);
      const invalidRetention = !retentionInput.value.trim() || !retentionInput.validity.valid || Number(retentionInput.value) < .7 || Number(retentionInput.value) > .99;
      retentionSelect.value = !invalidRetention && Object.hasOwn(RETENTION_PRESETS, String(retention)) ? String(retention) : "custom";
      retentionError.setText(invalidRetention ? "목표 기억률 입력을 확인하세요. 세부 조정에서 0.70–0.99를 입력하거나 여기서 빈도를 다시 선택하세요. 아직 저장되지 않았습니다." : "");
      retentionError.hidden = !invalidRetention;
      budgetNote.setText(`하루 제한은 기기 시간 기준 ${draft.dayStartsAt < 12 ? "오전" : "오후"} ${draft.dayStartsAt % 12 || 12}시에 새로 계산합니다. 세션을 다시 시작해도 당일 공부한 양은 차감됩니다. 같은 날의 짧은 반복은 상한에 포함되지 않습니다. 상한을 넘은 예정 복습은 이후 학습으로 밀려 쌓일 수 있습니다. ${draft.newCardsIgnoreReviewLimit ? "새 문제는 복습 상한과 별도로 셉니다." : "새 문제도 복습 상한을 함께 사용하므로, 복습이 상한을 채우면 새 문제는 나오지 않습니다."} 이 상한은 시험 모드를 새로 시작할 때의 자동 출제에 적용됩니다. 이어하기와 직접 추가한 문제는 기존 목록을 유지하며, 자유 암기에는 적용되지 않습니다.`);
      advancedNote.setText(`${hasCustomAdvancedSettings({ ...baseline, studyManagement: draft }) ? "고급 설정: 사용자 지정. 기존 세부 값을 유지합니다." : "고급 설정: 기본값."} ${Object.keys(baseline.gradeIntervalsMinutes).length ? "평가 버튼에 지정된 고정 간격이 우선하므로 해당 버튼에는 빈도 선택이 적용되지 않습니다." : "기존 복습일은 바뀌지 않고, 다음 평가에서 새 간격을 계산합니다."}`);
      const patch = studySettingsPatch(baseline, draft, retention, plugin.store.settings);
      const labels: Record<keyof StudyManagementSettings, string> = { newCardsPerDay: "새 문제 상한", reviewsPerDay: "복습 상한", newCardsIgnoreReviewLimit: "새 문제와 복습 상한의 관계", dayStartsAt: "하루 시작 시각", learningSteps: "처음 배우는 문제의 반복 간격", relearningSteps: "틀린 문제의 반복 간격", newCardOrder: "새 문제 순서", newReviewOrder: "새 문제와 복습 순서", reviewOrder: "복습 순서", enableFuzz: "복습일 분산", fsrsParameters: "FSRS 매개변수" };
      const display = (value: StudyManagementSettings[keyof StudyManagementSettings]) => Array.isArray(value) ? value.join(" / ") || "자동·기본" : typeof value === "boolean" ? value ? "켜짐" : "꺼짐" : String(value);
      const fields = Object.keys(draft).filter(key => JSON.stringify(draft[key as keyof StudyManagementSettings]) !== JSON.stringify(baseline.studyManagement[key as keyof StudyManagementSettings])).map(key => { const field = key as keyof StudyManagementSettings; return `${labels[field]} ${display(baseline.studyManagement[field])} → ${display(draft[field])}`; });
      if (patch.targetRetention !== undefined) fields.push(`목표 기억률 ${Number((baseline.targetRetention * 100).toFixed(10))}% → ${Number((retention * 100).toFixed(10))}%`);
      if (JSON.stringify(profiles) !== JSON.stringify(baseline.savedStudyProfiles ?? [])) fields.push("내 설정 목록");
      changes.setText((loadPreview ? `불러오기 미리보기: ${loadPreview} ` : "") + (fields.length ? `저장 시 변경: ${fields.join(", ")}. 그 외 설정과 학습 기록은 유지됩니다.` : "변경된 값이 없습니다. 화면 전환만으로 설정은 바뀌지 않습니다."));
    }
    extra.createEl("p", { text: "이 화면에서 수정한 세부 값도 학습 설정 저장 버튼으로 함께 저장합니다.", cls: "setting-item-description" });

    for (const [key, title] of [["learningSteps", "처음 배우는 문제"], ["relearningSteps", "틀린 문제"]] as const) {
      const section = stepGroups.createDiv({ cls: "mia-step-editor" });
      section.createEl("h4", { text: key === "learningSteps" ? "새 문제를 어떻게 익힐지" : "틀린 문제를 언제 다시 볼지" });
      const stepSummary = section.createEl("p", { cls: "setting-item-description", attr: { "aria-live": "polite" } });
      const stepDetails = section.createEl("details", { cls: "mia-settings-help" });
      stepDetails.createEl("summary", { text: `세부 조정 · ${title} 단계` });
      const guidance = stepDetails.createEl("p", { text: learningStepGuidance(draft[key], baseline.gradeIntervalsMinutes[2] !== undefined), cls: "setting-item-description mia-step-guidance", attr: { "aria-live": "polite" } });
      let automatic = draft[key].length === 0;
      const list = stepDetails.createDiv({ cls: "mia-step-list" });
      const rows: Array<{ value: string; unit: string; input: HTMLInputElement; select: HTMLSelectElement; remove: HTMLButtonElement; element: HTMLElement; up: HTMLButtonElement; down: HTMLButtonElement }> = [];
      const updateSteps = () => {
        const steps = automatic ? [] : parseSteps(rows.map(row => `${row.value}${row.unit}`).join(" "));
        if (steps) draft[key] = steps;
        stepSummary.setText(steps === null || (!automatic && !rows.length) ? "단계 입력을 확인하세요. 아직 적용되지 않았습니다." : steps.length ? `고정 단계: ${stepText(steps)}. 평가에 따라 다음 단계로 진행하거나 자동 복습으로 넘어갑니다.` : "고정 단계 없이 FSRS가 문제별 간격을 계산합니다.");
        guidance.setText(learningStepGuidance(steps, baseline.gradeIntervalsMinutes[2] !== undefined));
        changed();
      };
      const labelRows = () => rows.forEach((row, index) => {
        row.input.setAttribute("aria-label", `${title} ${index + 1}단계 간격`);
        row.select.setAttribute("aria-label", `${title} ${index + 1}단계 단위`);
        row.remove.setAttribute("aria-label", `${title} ${index + 1}단계 삭제`);
        row.up.setAttribute("aria-label", `${title} ${index + 1}단계 위로`);
        row.down.setAttribute("aria-label", `${title} ${index + 1}단계 아래로`);
        row.up.disabled = index === 0; row.down.disabled = index === rows.length - 1;
      });
      const add = (step: string) => {
        const value = step.slice(0, -1); const unit = step.slice(-1);
        const row = list.createDiv({ cls: "mia-step-row" });
        const input = row.createEl("input", { attr: { type: "number", min: "0", step: "any", inputmode: "decimal" } });
        const select = row.createEl("select");
        const remove = row.createEl("button", { text: "삭제", attr: { type: "button" } });
        const up = row.createEl("button", { text: "위로", attr: { type: "button" } });
        const down = row.createEl("button", { text: "아래로", attr: { type: "button" } });
        const item = { value, unit, input, select, remove, element: row, up, down };
        const move = (offset: number) => {
          const index = rows.indexOf(item), next = index + offset;
          if (next < 0 || next >= rows.length) return;
          rows.splice(index, 1); rows.splice(next, 0, item);
          rows.forEach(row => list.append(row.element)); labelRows(); updateSteps();
          input.focus();
        };
        up.addEventListener("click", () => move(-1)); down.addEventListener("click", () => move(1));
        input.value = value;
        input.addEventListener("input", () => { item.value = input.value; updateSteps(); });
        for (const [value, text] of [["m", "분 후"], ["h", "시간 후"], ["d", "일 후"]] as const) select.createEl("option", { value, text });
        select.value = unit;
        select.addEventListener("change", () => { item.unit = select.value; updateSteps(); });
        remove.addEventListener("click", () => {
          const index = rows.indexOf(item);
          rows.splice(index, 1); row.remove(); labelRows(); updateSteps();
          (rows[index]?.input ?? rows[index - 1]?.input ?? addButton).focus();
        });
        rows.push(item);
        labelRows();
      };
      for (const step of draft[key]) add(step);
      if (!draft[key].length) add(key === "learningSteps" ? "1m" : "10m");
      let modeSelect!: HTMLSelectElement;
      const mode = new Setting(stepDetails).setName("간격 결정").addDropdown(control => {
        modeSelect = control.selectEl;
        control.addOption("manual", "직접 정하기").addOption("auto", "자동으로 정하기").setValue(automatic ? "auto" : "manual");
        control.selectEl.setAttribute("aria-label", `${title} 간격 결정`);
        control.onChange(value => { automatic = value === "auto"; list.hidden = automatic; addButton.hidden = automatic; updateSteps(); });
      });
      modeSelect.removeAttribute("aria-labelledby");
      mode.settingEl.addClass("mia-step-mode");
      list.hidden = automatic;
      const addButton = stepDetails.createEl("button", { text: "단계 추가", attr: { type: "button", "aria-label": `${title} 단계 추가` } });
      addButton.hidden = automatic;
      addButton.addEventListener("click", () => { add("10m"); updateSteps(); rows.at(-1)?.input.focus(); });
      stepDetails.createEl("p", { text: "1분–36500일, 정확한 분 단위만 저장됩니다. 예: 1.5시간 = 90분. 1.5분은 저장할 수 없어 거부하며 반올림하지 않습니다. 0·빈 값은 사용할 수 없습니다. 중복이나 짧아지는 순서도 허용하며 입력한 순서대로 사용합니다. 단계를 모두 없애려면 자동을 선택하세요. 늘리면 해당 단계에서 더 늦게, 줄이면 더 빨리 다시 봅니다. 다음 평가부터 적용합니다.", cls: "setting-item-description" });
      stepSetters.set(key, () => {
        automatic = draft[key].length === 0; rows.splice(0); list.empty();
        for (const step of draft[key]) add(step);
        if (automatic) add(key === "learningSteps" ? "1m" : "10m");
        modeSelect.value = automatic ? "auto" : "manual"; list.hidden = automatic; addButton.hidden = automatic;
        updateSteps();
      });
      stepDetails.createEl("button", { text: `${title} 단계만 기본값 복원`, attr: { type: "button", "aria-label": `${title} 단계만 기본값 복원` } }).addEventListener("click", () => {
        draft[key] = [...DEFAULT_STUDY_MANAGEMENT[key]]; stepSetters.get(key)!(); (rows[0]?.input ?? modeSelect).focus();
      });
      stepSummary.setText(draft[key].length ? `고정 단계: ${stepText(draft[key])}. 평가에 따라 다음 단계로 진행하거나 자동 복습으로 넘어갑니다.` : "고정 단계 없이 FSRS가 문제별 간격을 계산합니다.");
      validators.push(() => {
        if (automatic) { draft[key] = []; return true; }
        if (!rows.length) return fail(`${title}: 단계를 추가하거나 자동으로 정하기를 선택하세요.`, addButton);
        const steps: StudyManagementSettings[typeof key] = [];
        for (const row of rows) {
          const parsed = row.input.validity.valid && row.value.trim() ? parseSteps(`${row.value}${row.unit}`) : null;
          if (!parsed) return fail(`${title}: 간격은 1분–36500일 범위에서 정확한 분 단위여야 합니다. 빈 값·0·분 미만 나머지는 저장할 수 없습니다.`, row.input);
          steps.push(...parsed);
        }
        draft[key] = steps; return true;
      });
    }
    simple.insertBefore(stepGroups, retentionGroup);
    simple.append(retentionGroup);
    retentionGroup.append(retentionDetails);
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
    simple.append(basic, budgetHelp, stepGroups, retentionGroup, advancedNote);
    const library = container.createEl("details", { cls: "mia-settings-help mia-study-profiles" });
    library.createEl("summary", { text: "내 설정 · 저장한 조합 관리" });
    library.createEl("p", { text: "공부량 두 값·새 문제 단계·틀린 문제 단계·복습 목표만 저장합니다. 출제 순서·고정 평가 간격 등 고급 값은 유지합니다. 이름 변경·삭제는 현재 학습 설정을 바꾸지 않습니다. 아래 작업도 마지막에 학습 설정 저장을 눌러야 보관됩니다.", cls: "setting-item-description" });
    const name = library.createEl("input", { attr: { type: "text", maxlength: "80", "aria-label": "내 설정 이름", placeholder: "예: 평일 짧게 공부" } });
    const libraryStatus = library.createEl("p", { attr: { role: "status" }, cls: "setting-item-description" });
    const profileList = library.createDiv();
    const nameValue = () => {
      const value = name.value.trim();
      if (!value || value.length > 80) { libraryStatus.setText("이름은 공백을 제외하고 1–80자로 입력하세요."); name.focus(); return null; }
      return value;
    };
    let renameDraft: { profile: SavedStudyProfile; input: HTMLInputElement } | undefined;
    const renameButtons = new Map<string, HTMLButtonElement>();
    const finishRename = () => {
      if (!renameDraft) return true;
      const value = renameDraft.input.value.trim();
      if (!value || value.length > 80) return fail("이름은 공백을 제외하고 1–80자로 입력하세요.", renameDraft.input);
      const id = renameDraft.profile.id;
      renameDraft.profile.name = value; renameDraft = undefined; showProfiles(); changed();
      libraryStatus.setText("이름 변경을 준비했습니다. 현재 학습값은 유지됩니다.");
      renameButtons.get(id)?.focus(); return true;
    };
    validators.push(finishRename);
    const showProfiles = () => {
      profileList.empty();
      renameButtons.clear();
      for (const profile of profiles) {
        const sameNames = profiles.filter(item => item.name === profile.name);
        const label = sameNames.length > 1 ? `${profile.name} (같은 이름 ${sameNames.indexOf(profile) + 1}/${sameNames.length})` : profile.name;
        const row = profileList.createDiv({ cls: "mia-profile-row" });
        row.createEl("strong", { text: label });
        const persisted = baseline.savedStudyProfiles?.some(item => JSON.stringify(item) === JSON.stringify(profile));
        const current = plugin.store.settings;
        const matchesCurrent = profile.newCardsPerDay === current.studyManagement.newCardsPerDay && profile.reviewsPerDay === current.studyManagement.reviewsPerDay
          && profile.targetRetention === current.targetRetention && JSON.stringify(profile.learningSteps) === JSON.stringify(current.studyManagement.learningSteps)
          && JSON.stringify(profile.relearningSteps) === JSON.stringify(current.studyManagement.relearningSteps);
        row.createEl("p", { text: `${persisted ? "저장된 내 설정" : "보관·수정 준비(미저장)"} · ${matchesCurrent ? "현재 적용된 다섯 값과 같음" : "현재 적용된 값과 다름"}` });
        row.createEl("p", { text: `조합 내용: 새 문제 ${profile.newCardsPerDay}개 · 복습 ${profile.reviewsPerDay}회 · 목표 ${Number((profile.targetRetention * 100).toFixed(10))}% · 새 단계 ${stepText(profile.learningSteps)} · 틀린 단계 ${stepText(profile.relearningSteps)}` });
        const action = (text: string, run: () => void) => {
          const button = row.createEl("button", { text, attr: { type: "button", "aria-label": `${label} ${text}` } });
          button.addEventListener("click", run); return button;
        };
        action("불러오기", () => {
          if (!finishRename()) return;
          const preview = `${profile.name}: 새 문제 ${countInputs.get("newCardsPerDay")!.value} → ${profile.newCardsPerDay}, 복습 ${countInputs.get("reviewsPerDay")!.value} → ${profile.reviewsPerDay}, 목표 ${percent(retention)} → ${percent(profile.targetRetention)}, 새 단계 [${stepText(draft.learningSteps)}] → [${stepText(profile.learningSteps)}], 틀린 단계 [${stepText(draft.relearningSteps)}] → [${stepText(profile.relearningSteps)}]. 이 다섯 항목만 준비했습니다. 저장 전에는 현재 학습에 적용되지 않습니다.`;
          draft.newCardsPerDay = profile.newCardsPerDay; draft.reviewsPerDay = profile.reviewsPerDay;
          draft.learningSteps = [...profile.learningSteps]; draft.relearningSteps = [...profile.relearningSteps];
          retention = profile.targetRetention; retentionInput.value = String(retention);
          for (const key of ["newCardsPerDay", "reviewsPerDay"] as const) countInputs.get(key)!.value = String(draft[key]);
          stepSetters.forEach(set => set()); loadPreview = preview; changed(true);
          libraryStatus.setText(`「${profile.name}」을 편집 중인 값으로 불러왔습니다. 적용하려면 학습 설정 저장을 누르세요.`);
        });
        renameButtons.set(profile.id, action("이름 변경", () => {
          if (!finishRename()) return;
          // finishRename can refresh the list; append the editor to the current row.
          const host = renameButtons.get(profile.id)!.parentElement!;
          const editor = host.createDiv({ cls: "mia-profile-rename" });
          const input = editor.createEl("input", { attr: { type: "text", maxlength: "80", "aria-label": `${label} 새 이름` } });
          input.value = profile.name; renameDraft = { profile, input };
          input.addEventListener("input", () => changed());
          input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); finishRename(); } });
          editor.createEl("button", { text: "변경 완료", attr: { type: "button" } }).addEventListener("click", finishRename);
          editor.createEl("button", { text: "이름 변경 취소", attr: { type: "button" } }).addEventListener("click", () => {
            renameDraft = undefined; showProfiles(); renameButtons.get(profile.id)?.focus();
          });
          input.focus(); input.select();
        }));
        action("삭제", () => {
          if (renameDraft?.profile.id === profile.id) renameDraft = undefined;
          if (!finishRename()) return;
          const index = profiles.indexOf(profile); profiles = profiles.filter(item => item.id !== profile.id);
          showProfiles(); changed(); libraryStatus.setText("목록에서 삭제를 준비했습니다. 현재 학습값은 유지됩니다. 취소하면 되돌립니다.");
          (renameButtons.get(profiles[index]?.id ?? profiles[index - 1]?.id ?? "") ?? name).focus();
        });
      }
      if (!profiles.length) profileList.createEl("p", { text: "아직 보관한 조합이 없습니다." });
    };
    library.createEl("button", { text: "현재 입력을 내 설정으로 보관", attr: { type: "button" } }).addEventListener("click", () => {
      const value = nameValue(); if (!value || !validators.every(validate => validate())) return;
      profiles.push(captureStudyProfile(value, draft, retention)); showProfiles(); changed();
      libraryStatus.setText(`「${value}」 보관을 준비했습니다. 학습 설정 저장을 눌러 완료하세요.`);
    });
    showProfiles();
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
      status.setText("저장 중입니다. 완료될 때까지 기다려 주세요.");
      try {
        await save(async () => {
          try {
            const patch = studySettingsPatch(baseline, draft, retention, plugin.store.settings);
            if (JSON.stringify(profiles) !== JSON.stringify(baseline.savedStudyProfiles ?? [])) patch.savedStudyProfiles = structuredClone(profiles);
            if (Object.keys(patch).length) await plugin.updateSettings(patch, baseline);
            baseline = structuredClone(plugin.store.settings);
            render(baseline.studyManagement);

            new Notice("학습 설정을 저장했습니다.");
          } catch (error) {
            status.setText(`저장에 실패했습니다. 입력을 유지했습니다. 저장하지 않은 변경사항을 확인하고 다시 시도하세요. ${error instanceof Error ? error.message : String(error)}`);
            throw error;
          }
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
