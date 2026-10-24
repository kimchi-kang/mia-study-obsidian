import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type MiaStudyPlugin from "../main";
import { GradeIntervalsMinutes, MAX_GRADE_INTERVAL_MINUTES, MiaSettings } from "../core/models";
import { GRADE_HINTS, GRADE_LABELS } from "./study-grades";
import { errorMessage } from "./error-message";
import { bindKeyboardViewport, KeyboardViewportBinding } from "./mobile-keyboard";

export class MiaSettingTab extends PluginSettingTab {
  private keyboardViewport: KeyboardViewportBinding | null = null;

  constructor(app: App, private readonly miaPlugin: MiaStudyPlugin) {
    super(app, miaPlugin);
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.miaPlugin.store.settings;
    this.keyboardViewport?.destroy();
    this.keyboardViewport = null;
    containerEl.empty();
    containerEl.addClass("mia-keyboard-settings");
    containerEl.createEl("h2", { text: "Major Study" });
    containerEl.createEl("p", { text: "노트 내용과 FSRS 복습 기록은 분리됩니다. 등록 명령을 실행하기 전에는 원문을 수정하지 않습니다.", cls: "setting-item-description" });

    new Setting(containerEl).setName("문제 폴더").setDesc("한 줄에 하나. 비워 두면 보관함 전체에서 [!question]을 찾습니다.").addTextArea((text) => {
      text.setPlaceholder("전자기학\n회로이론").setValue(settings.sourceRoots.join("\n")).onChange(async (value) => {
        await this.save(async () => {
          await this.miaPlugin.store.updateSettings({ sourceRoots: value.split("\n").map((item) => item.trim()).filter(Boolean) });
          await this.miaPlugin.index.rebuild();
        });
      });
    });
    new Setting(containerEl).setName("목표 기억률").setDesc("FSRS-6 권장 범위 0.70–0.99").addText((text) => {
      text.setValue(String(settings.targetRetention)).onChange(async (value) => {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) await this.save(() => this.miaPlugin.updateSettings({ targetRetention: parsed }));
      });
    });
    new Setting(containerEl).setName("최대 복습 간격(일)").addText((text) => {
      text.setValue(String(settings.maximumIntervalDays)).onChange(async (value) => {
        const parsed = Number(value);
        if (Number.isInteger(parsed) && parsed > 0) await this.save(() => this.miaPlugin.updateSettings({ maximumIntervalDays: parsed }));
      });
    });
    this.renderGradeIntervals(containerEl, settings);
    new Setting(containerEl).setName("키워드 노트 폴더").setDesc("키워드 링크를 만들 때 기준으로 표시할 폴더입니다.").addText((text) => {
      text.setValue(settings.keywordFolder).onChange(async (value) => this.save(() => this.miaPlugin.store.updateSettings({ keywordFolder: value })));
    });
    new Setting(containerEl).setName("암기 모드 순서").setDesc("이 기기에 저장하며 새 암기 학습부터 적용합니다. 순서대로는 문제 목록 순서를 따릅니다.").addDropdown((dropdown) => {
      dropdown.addOption("sequential", "순서대로").addOption("random", "랜덤").setValue(this.miaPlugin.studyUi.appearance.memorizationOrder);
      dropdown.onChange(async (value) => {
        if (value === "sequential" || value === "random") await this.save(async () => { this.miaPlugin.studyUi.updateAppearance({ memorizationOrder: value }); });
      });
    });
    this.keyboardViewport = bindKeyboardViewport(containerEl);
  }

  hide(): void {
    this.keyboardViewport?.destroy();
    this.keyboardViewport = null;
    this.containerEl.removeClass("mia-keyboard-settings");
    super.hide();
  }

  private renderGradeIntervals(container: HTMLElement, settings: MiaSettings): void {
    container.createEl("h3", { text: "평가 버튼별 복습 간격" });
    container.createEl("p", { text: "비워 두면 FSRS 자동 간격을 사용합니다. 지정한 값은 저장 후 해당 버튼으로 평가할 때부터 적용하며, 이미 예약된 복습일은 바꾸지 않습니다. 최대 복습 간격을 넘으면 최대값을 적용합니다.", cls: "setting-item-description" });
    const drafts = ([1, 2, 3, 4] as const).map((grade) => {
      const minutes = settings.gradeIntervalsMinutes[grade];
      const unit = minutes !== undefined && minutes % 1440 === 0 ? 1440 : minutes !== undefined && minutes % 60 === 0 ? 60 : 1;
      const draft = { grade, amount: minutes === undefined ? "" : String(minutes / unit), unit, invalidInput: false };
      const row = new Setting(container).setName(GRADE_LABELS[grade]).setDesc(GRADE_HINTS[grade]);
      row.settingEl.addClass("mia-grade-interval-setting");
      row.addText((text) => {
        text.setPlaceholder("자동").setValue(draft.amount).onChange((value) => { draft.amount = value; draft.invalidInput = !text.inputEl.validity.valid; });
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        text.inputEl.step = "any";
        text.inputEl.setAttribute("aria-label", `${GRADE_LABELS[grade]} 복습 간격`);
        text.inputEl.removeAttribute("aria-labelledby");
      }).addDropdown((dropdown) => {
        dropdown.addOption("1", "분").addOption("60", "시간").addOption("1440", "일").setValue(String(unit));
        dropdown.selectEl.setAttribute("aria-label", `${GRADE_LABELS[grade]} 복습 간격 단위`);
        dropdown.selectEl.removeAttribute("aria-labelledby");
        dropdown.onChange((value) => { draft.unit = Number(value); });
      });
      return draft;
    });
    new Setting(container).addButton((button) => button.setButtonText("복습 간격 저장").setCta().onClick(async () => {
      const intervals: GradeIntervalsMinutes = {};
      for (const draft of drafts) {
        if (draft.invalidInput) {
          new Notice(`${GRADE_LABELS[draft.grade]}: 올바른 숫자를 입력하세요.`);
          return;
        }
        if (!draft.amount.trim()) continue;
        const minutes = Number(draft.amount) * draft.unit;
        if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_GRADE_INTERVAL_MINUTES) {
          new Notice(`${GRADE_LABELS[draft.grade]}: 1분 이상 36500일 이하의 간격을 입력하세요. 분 단위로 나누어떨어져야 합니다.`);
          return;
        }
        intervals[draft.grade] = minutes;
      }
      button.setDisabled(true);
      try {
        await this.save(async () => {
          await this.miaPlugin.updateSettings({ gradeIntervalsMinutes: intervals });
          new Notice("복습 간격을 저장했습니다. 다음 평가부터 적용됩니다.");
          this.display();
        });
      } finally { button.setDisabled(false); }
    }));
  }

  private async save(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      new Notice(`MIA 설정 저장 실패: ${errorMessage(error)}`);
      this.display();
    }
  }
}
