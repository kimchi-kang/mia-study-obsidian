import { App, Notice } from "obsidian";
import type MiaStudyPlugin from "../main";
import { renderDeviceSyncSettings } from "./device-sync-settings";
import { errorMessage } from "./error-message";
import { KeyboardAwareModal } from "./mobile-keyboard";
import { renderStudyManagementSettings } from "./study-management-settings";

export class StudyManagementModal extends KeyboardAwareModal {
  private stopOptimization: (() => void) | undefined;
  private closeHandled = false;

  constructor(app: App, private readonly plugin: MiaStudyPlugin, private readonly onSaved: () => void, private readonly onClosed?: () => void) {
    super(app, "long");
  }

  open(): void {
    this.closeHandled = false;
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
    this.stopOptimization = renderStudyManagementSettings(panel, this.plugin, async action => {
      try {
        await action();
        this.onSaved();
        this.close();
      } catch (error) {
        new Notice(`학습 설정 저장 실패: ${errorMessage(error)}`);
      }
    }, () => this.close(), parent => renderDeviceSyncSettings(parent, this.plugin));
  }

  onClose(): void {
    this.stopOptimization?.();
    this.stopOptimization = undefined;
    this.contentEl.empty();
  }

  close(): void {
    // 저장을 기다리는 동안 먼저 닫혔으면, 저장이 끝난 뒤의 닫기는 건너뛴다(닫힘 처리를 두 번 하지 않게).
    if (this.closeHandled) return;
    this.closeHandled = true;
    super.close();
    this.onClosed?.();
  }
}
