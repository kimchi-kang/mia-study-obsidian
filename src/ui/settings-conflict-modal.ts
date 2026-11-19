import { App, Modal, Notice } from "obsidian";
import type { MiaSettings, SettingsSnapshot } from "../core/models";
import { confirmConflictDeletion } from "./conflict-delete-confirmation";

export class SettingsConflictModal extends Modal {
  private busy = false;

  constructor(
    app: App, private readonly active: MiaSettings, private readonly alternatives: readonly SettingsSnapshot[],
    private readonly apply: (id: string) => Promise<void>, private readonly dismiss: (expected: SettingsSnapshot) => Promise<void>,
  ) { super(app); }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    for (const button of this.contentEl.querySelectorAll("button")) button.disabled = busy;
  }
  onOpen(): void {
    this.setTitle("보관된 설정 확인");
    this.modalEl.classList.add("mia-preview-modal", "mia-recovery-modal");
    this.contentEl.createEl("p", { text: "서로 다른 변경의 순서를 확인할 수 없어 설정을 자동으로 섞지 않았습니다. 현재 값과 보관 사본을 비교하세요. 선택한 사본은 전체 학습 설정에 적용되며 평가 기록과 이미 예약된 복습일은 바꾸지 않습니다. 적용 전 현재 설정도 보관합니다." });
    this.showSettings("현재 설정", this.active);
    let remaining = this.alternatives.length;
    for (const [index, item] of this.alternatives.entries()) {
      const detail = this.contentEl.createEl("details");
      detail.createEl("summary", { text: `보관 사본 ${index + 1}` });
      this.showSettings("보관된 값", item.settings, detail);
      const actions = detail.createEl("div", { cls: "mia-inline-actions" });
      actions.createEl("button", { text: "이 설정 전체 적용" }).addEventListener("click", async () => {
        if (this.busy) return;
        this.setBusy(true);
        try { await this.apply(item.id); new Notice("선택한 설정을 적용하고 이전 설정도 보관했습니다."); this.close(); }
        catch (error) { new Notice(`설정 적용 실패: ${error instanceof Error ? error.message : String(error)}`); this.setBusy(false); }
      });
      const label = "이 보관 사본 지우기";
      actions.createEl("button", { text: label, cls: "mod-warning" }).addEventListener("click", () => {
        if (this.busy) return;
        confirmConflictDeletion(this.app, label, "현재 설정은 그대로 두고, 선택한 보관 사본만 지웁니다. 되돌릴 수 없습니다.", async () => {
          await this.dismiss(item);
          detail.remove();
          if (--remaining === 0) this.close();
        }, busy => this.setBusy(busy));
      });
    }
    this.contentEl.createEl("button", { text: "닫기" }).addEventListener("click", () => this.close());
  }
  private showSettings(title: string, settings: MiaSettings, root = this.contentEl): void {
    root.createEl("h3", { text: title });
    root.createEl("p", { text: `목표 기억률 ${Math.round(settings.targetRetention * 100)}% · 최대 복습 간격 ${settings.maximumIntervalDays}일 · 하루 새 문제 ${settings.studyManagement.newCardsPerDay}개 / 복습 ${settings.studyManagement.reviewsPerDay}회 · 문제 폴더 ${settings.sourceRoots.join(", ")}` });
    const data = root.createEl("textarea", { attr: { "aria-label": `${title} 복구용 JSON`, readonly: "true", rows: "6" } });
    data.value = JSON.stringify(settings, null, 2);
    data.style.width = "100%";
  }
  onClose(): void { this.contentEl.empty(); }
}
