import { App, Notice, Setting } from "obsidian";
import { QUESTION_TYPES, QuestionRecord, QuestionType } from "../core/models";
import { keywordReferencesFromInput } from "../core/keyword-path";
import { QuestionMetadataInput } from "../core/question-writer";
import { errorMessage } from "./error-message";
import { KeyboardAwareModal } from "./mobile-keyboard";
import { MAX_FOLLOW_UPS } from "../core/follow-up";

export class QuestionMetadataModal extends KeyboardAwareModal {
  private type: QuestionType;
  private core: string;
  private sub: string;
  private followUps: string;

  constructor(
    app: App,
    private readonly question: QuestionRecord,
    private readonly keywordFolder: string,
    private readonly onSubmit: (metadata: QuestionMetadataInput) => Promise<void>,
  ) {
    super(app);
    this.type = question.questionType;
    this.core = question.coreKeywords.map((item) => item.raw).join(", ");
    this.sub = question.subKeywords.map((item) => item.raw).join(", ");
    this.followUps = question.followUpIds.map((id) => `[[${question.filePath}#^${id}]]`).join(", ");
  }

  onOpen(): void {
    this.titleEl.setText(this.question.id ? "문제 학습 정보 편집" : "MIA 문제로 등록");
    this.contentEl.createEl("p", { text: this.question.heading, cls: "mia-muted" });
    new Setting(this.contentEl).setName("문제 유형").addDropdown((dropdown) => {
      QUESTION_TYPES.forEach((type) => dropdown.addOption(type, type));
      dropdown.setValue(this.type).onChange((value) => { this.type = value as QuestionType; });
    });
    new Setting(this.contentEl).setName("핵심 키워드").setDesc("쉼표로 구분. 위키링크 형식도 지원합니다.").addText((text) => {
      text.setPlaceholder("가우스 법칙, 전기 선속").setValue(this.core).onChange((value) => { this.core = value; });
    });
    new Setting(this.contentEl).setName("보조 키워드").addText((text) => {
      text.setPlaceholder("대칭성, 폐곡면").setValue(this.sub).onChange((value) => { this.sub = value; });
    });
    new Setting(this.contentEl).setName("이어볼 문제").setDesc("문제 블록 링크를 쉼표로 구분합니다.").addText((text) => {
      text.setPlaceholder("[[노트#^mia-q-...]]").setValue(this.followUps).onChange((value) => { this.followUps = value; });
    });
    new Setting(this.contentEl).addButton((button) => button.setButtonText(this.question.id ? "저장" : "등록").setCta().onClick(async () => {
      button.setDisabled(true);
      try {
        const coreKeywords = keywordReferencesFromInput(this.core, this.keywordFolder);
        if (coreKeywords.length === 0) {
          new Notice("핵심 키워드를 하나 이상 입력하세요.");
          button.setDisabled(false);
          return;
        }
        const followUpLinks = this.followUps.split(",").map((item) => item.trim()).filter(Boolean);
        if (followUpLinks.length > MAX_FOLLOW_UPS) {
          new Notice(`이어볼 문제는 최대 ${MAX_FOLLOW_UPS}개까지 연결할 수 있습니다.`);
          button.setDisabled(false);
          return;
        }
        await this.onSubmit({
          questionType: this.type,
          coreKeywords,
          subKeywords: keywordReferencesFromInput(this.sub, this.keywordFolder),
          followUpLinks,
        });
        this.close();
      } catch (error) {
        new Notice(`MIA 학습 정보 저장 실패: ${errorMessage(error)}`);
        button.setDisabled(false);
      }
    }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
