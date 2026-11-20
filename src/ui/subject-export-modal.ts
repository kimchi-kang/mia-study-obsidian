import { App, Modal, Notice } from "obsidian";
import { parseSubjectExportOptions, type SubjectExportOptions } from "../core/export-priority";
import type { StudyUiStore } from "../services/study-ui-store";
import { errorMessage } from "./error-message";

export interface ExportSubjectOption { name: string; count: number; weakCount: number }
import type { ExportReceipt } from "../services/export-file";
export type { ExportReceipt };

export class SubjectExportModal extends Modal {
  private busy = false;
  private closed = false;
  constructor(app: App, private readonly subjects: readonly ExportSubjectOption[],
    private readonly exportSubject: (subject: string, options: SubjectExportOptions) => Promise<ExportReceipt>,
    private readonly studyUi: Pick<StudyUiStore, "exportOptions" | "saveExportOptions">,
    private readonly destination = "보관함의 MIA 출력 폴더") {
    super(app);
    this.setTitle("어떤 과목을 출력할까요?");
  }
  onOpen(): void {
    this.modalEl.addClass("mia-export-modal");
    this.closed = false;
    let options = this.studyUi.exportOptions;
    this.contentEl.createEl("p", { text: `과목을 누르면 질문과 답변을 Word(.docx) 정리본으로 만듭니다. 저장 위치: ${this.destination}` });
    this.contentEl.createEl("p", { text: "수식은 원문 표기로 저장합니다. 이미지 누락 등 확인할 항목은 완료 후 안내합니다.", cls: "mia-muted" });
    if (!this.subjects.length) this.contentEl.createEl("p", { text: "등록된 질문이 없습니다. 먼저 과목과 질문을 추가해 주세요." });
    const controls = this.contentEl.createDiv({ cls: "mia-export-options" });
    const scope = exportDropdown(controls, "출력 범위", [["all", "전체 질문"], ["weak", "부족한 문제만"]], options.scope);
    const order = exportDropdown(controls, "순서", [["note", "노트 순서"], ["weak", "부족한 순서"]], options.order);
    const list = this.contentEl.createDiv({ cls: "mia-export-subjects" });
    const empty = this.contentEl.createDiv({ cls: "mia-muted", attr: { "aria-live": "polite" } });
    const status = this.contentEl.createDiv({ cls: "mia-export-status", attr: { "aria-live": "polite" } });
    const count = (subject: ExportSubjectOption) => options.scope === "weak" ? subject.weakCount : subject.count;
    const buttons = this.subjects.map((subject) => {
      const button = list.createEl("button", { attr: { type: "button" } });
      button.addEventListener("click", async () => {
        if (this.busy || !count(subject)) return;
        this.busy = true;
        refreshButtons();
        status.empty(); status.createEl("p", { text: `${subject.name} Word 정리본을 만드는 중입니다…` });
        try {
          const result = await this.exportSubject(subject.name, options);
          if (this.closed) { new Notice(`Word 정리본 저장 완료: ${result.path}${result.warnings.length ? ` · 확인할 항목 ${result.warnings.length}개` : ""}`); return; }
          status.empty();
          status.createEl("p", { text: `${result.count}문제 저장 완료: ${result.path}` });
          for (const warning of result.warnings) status.createEl("p", { text: warning, cls: "mia-muted" });
          status.createEl("button", { text: "파일 열기", attr: { type: "button" } }).addEventListener("click", () => {
            void (result.openFile ? result.openFile() : this.app.workspace.openLinkText(result.path, "", false)).catch((error: unknown) => new Notice(`파일 열기 실패: ${errorMessage(error)}`));
          });
          if (result.revealFile) status.createEl("button", { text: "저장 폴더에서 보기", attr: { type: "button" } }).addEventListener("click", () => {
            try { result.revealFile?.(); }
            catch (error) { new Notice(`저장 폴더 열기 실패: ${errorMessage(error)}`); }
          });
        } catch (error) {
          new Notice(`Word 출력 실패: ${errorMessage(error)}`);
          if (!this.closed) { status.empty(); status.createEl("p", { text: "저장하지 못했습니다. 다시 시도해 주세요." }); }
        } finally {
          this.busy = false;
          if (!this.closed) refreshButtons();
        }
      });
      return { button, subject };
    });
    const refreshButtons = () => {
      scope.disabled = order.disabled = this.busy;
      for (const { button, subject } of buttons) {
        button.setText(`${subject.name} · ${count(subject)}문제`);
        button.disabled = this.busy || count(subject) === 0;
      }
    };
    const refreshScope = () => {
      refreshButtons();
      empty.empty();
      if (options.scope === "weak" && this.subjects.every((subject) => count(subject) === 0)) {
        empty.createEl("p", { text: "부족한 문제가 없습니다. 전체 질문으로 출력해 보세요." });
      }
    };
    const saveSelection = () => {
      if (this.busy) return;
      options = parseSubjectExportOptions({ scope: scope.value, order: order.value });
      refreshScope();
      try { this.studyUi.saveExportOptions(options); }
      catch (error) { new Notice(`출력 선택 저장 실패: ${errorMessage(error)}`); }
    };
    scope.addEventListener("change", saveSelection);
    order.addEventListener("change", saveSelection);
    refreshScope();
  }
  onClose(): void { this.closed = true; this.contentEl.empty(); }
}

function exportDropdown(container: HTMLElement, name: string, choices: readonly (readonly [string, string])[], value: string): HTMLSelectElement {
  const label = container.createEl("label");
  label.createSpan({ text: name });
  const select = label.createEl("select", { cls: "dropdown" });
  for (const [key, text] of choices) select.createEl("option", { text, attr: { value: key } });
  select.value = value;
  return select;
}
