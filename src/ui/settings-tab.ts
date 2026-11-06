import { renderDeviceSyncSettings } from "./device-sync-settings";
import { renderStudyManagementSettings } from "./study-management-settings";
import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type MiaStudyPlugin from "../main";
import { errorMessage } from "./error-message";
import { bindKeyboardViewport, KeyboardViewportBinding } from "./mobile-keyboard";

export class MiaSettingTab extends PluginSettingTab {
  private settingsWrites: Promise<void> = Promise.resolve();
  private keyboardViewport: KeyboardViewportBinding | null = null;

  constructor(app: App, private readonly miaPlugin: MiaStudyPlugin) {
    super(app, miaPlugin);
  }

  display(): void {
    const { containerEl } = this;
    let settings = structuredClone(this.miaPlugin.store.settings);
    this.keyboardViewport?.destroy();
    this.keyboardViewport = null;
    containerEl.empty();
    containerEl.addClass("mia-keyboard-settings");
    containerEl.createEl("h2", { text: "Major Study" });
    containerEl.createEl("p", { text: "노트 내용과 FSRS 복습 기록은 분리됩니다. 등록 명령을 실행하기 전에는 원문을 수정하지 않습니다.", cls: "setting-item-description" });

    new Setting(containerEl).setName("문제 폴더").setDesc("한 줄에 하나. 비워 두면 보관함 전체에서 [!question]을 찾습니다.").addTextArea((text) => {
      text.setPlaceholder("전자기학\n회로이론").setValue(settings.sourceRoots.join("\n")).onChange(async (value) => {
        await this.save(async () => {
          await this.miaPlugin.store.updateSettings({ sourceRoots: value.split("\n").map((item) => item.trim()).filter(Boolean) }, settings);
          await this.miaPlugin.index.rebuild();
          settings = structuredClone(this.miaPlugin.store.settings);
        });
      });
    });
    renderStudyManagementSettings(containerEl.createDiv({ cls: "mia-study-management-settings" }), this.miaPlugin, action => this.save(action, false));
    renderDeviceSyncSettings(containerEl, this.miaPlugin);
    new Setting(containerEl).setName("키워드 노트 폴더").setDesc("키워드 링크를 만들 때 기준으로 표시할 폴더입니다.").addText((text) => {
      text.setValue(settings.keywordFolder).onChange(async (value) => this.save(async () => { await this.miaPlugin.store.updateSettings({ keywordFolder: value }, settings); settings = structuredClone(this.miaPlugin.store.settings); }));
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

  private save(action: () => Promise<void>, refreshOnFailure = true): Promise<void> {
    const write = this.settingsWrites.then(async () => {
      try { await action(); }
      catch (error) {
        new Notice(`MIA 설정 저장 실패: ${errorMessage(error)}`);
        if (refreshOnFailure) this.display();
      }
    });
    this.settingsWrites = write.catch(() => undefined);
    return write;
  }
}
