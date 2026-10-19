import { App, Modal, Notice } from "obsidian";
import { errorMessage } from "./error-message";

export interface ExportSubjectOption { name: string; count: number }
export interface ExportReceipt { path: string; count: number; warnings: string[] }

export class SubjectExportModal extends Modal {
  private busy = false;
  private closed = false;
  constructor(app: App, private readonly subjects: readonly ExportSubjectOption[],
    private readonly exportSubject: (subject: string) => Promise<ExportReceipt>) {
    super(app);
    this.setTitle("어떤 과목을 출력할까요?");
  }
  onOpen(): void {
    this.closed = false;
    this.contentEl.createEl("p", { text: "과목을 누르면 질문과 답변만 담은 Word(.docx) 정리본을 만듭니다. 저장 위치: 보관함의 MIA 출력 폴더" });
    this.contentEl.createEl("p", { text: "수식은 원문 표기로 저장합니다. 이미지 누락 등 확인할 항목은 완료 후 안내합니다.", cls: "mia-muted" });
    if (!this.subjects.length) this.contentEl.createEl("p", { text: "등록된 질문이 없습니다. 먼저 과목과 질문을 추가해 주세요." });
    const list = this.contentEl.createDiv({ cls: "mia-export-subjects" });
    const buttons: HTMLButtonElement[] = [];
    const status = this.contentEl.createDiv({ cls: "mia-export-status", attr: { "aria-live": "polite" } });
    for (const subject of this.subjects) {
      const button = list.createEl("button", { text: `${subject.name} · ${subject.count}문제`, attr: { type: "button" } });
      buttons.push(button);
      button.disabled = subject.count === 0;
      button.addEventListener("click", async () => {
        if (this.busy || !subject.count) return;
        this.busy = true;
        buttons.forEach((item) => { item.disabled = true; });
        status.empty(); status.createEl("p", { text: `${subject.name} Word 정리본을 만드는 중입니다…` });
        try {
          const result = await this.exportSubject(subject.name);
          if (this.closed) { new Notice(`Word 정리본 저장 완료: ${result.path}${result.warnings.length ? ` · 확인할 항목 ${result.warnings.length}개` : ""}`); return; }
          status.empty();
          status.createEl("p", { text: `${result.count}문제 저장 완료: ${result.path}` });
          for (const warning of result.warnings) status.createEl("p", { text: warning, cls: "mia-muted" });
          status.createEl("button", { text: "파일 열기", attr: { type: "button" } }).addEventListener("click", () => {
            void this.app.workspace.openLinkText(result.path, "", false).catch((error: unknown) => new Notice(`파일 열기 실패: ${errorMessage(error)}`));
          });
        } catch (error) {
          new Notice(`Word 출력 실패: ${errorMessage(error)}`);
          if (!this.closed) { status.empty(); status.createEl("p", { text: "저장하지 못했습니다. 다시 시도해 주세요." }); }
        } finally {
          this.busy = false;
          if (!this.closed) buttons.forEach((item, index) => { item.disabled = this.subjects[index]?.count === 0; });
        }
      });
    }
  }
  onClose(): void { this.closed = true; this.contentEl.empty(); }
}
