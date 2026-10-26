import { App, Notice } from "obsidian";
import type MiaStudyPlugin from "../main";
import { renderDeviceSyncSettings } from "./device-sync-settings";
import { errorMessage } from "./error-message";
import { KeyboardAwareModal } from "./mobile-keyboard";
import { renderStudyManagementSettings } from "./study-management-settings";

export class StudyManagementModal extends KeyboardAwareModal {
  constructor(app: App, private readonly plugin: MiaStudyPlugin, private readonly onSaved: () => void) {
    super(app, "long");
  }

  open(): void {
    super.open();
    this.modalEl.tabIndex = -1;
    this.modalEl.focus({ preventScroll: true });
  }

  onOpen(): void {
    this.setTitle("학습 설정");
    this.modalEl.addClass("mia-study-management-modal");
    this.contentEl.empty();
    this.contentEl.addClass("mia-keyboard-settings");
    const panel = this.contentEl.createDiv({ cls: "mia-study-management-settings" });
    renderStudyManagementSettings(panel, this.plugin, async action => {
      try {
        await action();
        this.onSaved();
        this.close();
      } catch (error) {
        new Notice(`학습 설정 저장 실패: ${errorMessage(error)}`);
      }
    }, () => this.close());
    renderDeviceSyncSettings(this.contentEl, this.plugin);
  }

  onClose(): void { this.contentEl.empty(); }
}
