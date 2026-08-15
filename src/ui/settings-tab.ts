import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type MiaStudyPlugin from "../main";
import { errorMessage } from "./error-message";

export class MiaSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly miaPlugin: MiaStudyPlugin) {
    super(app, miaPlugin);
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.miaPlugin.store.settings;
    containerEl.empty();
    containerEl.createEl("h2", { text: "MIA Study" });
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
    new Setting(containerEl).setName("키워드 노트 폴더").setDesc("키워드 링크를 만들 때 기준으로 표시할 폴더입니다.").addText((text) => {
      text.setValue(settings.keywordFolder).onChange(async (value) => this.save(() => this.miaPlugin.store.updateSettings({ keywordFolder: value })));
    });
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
