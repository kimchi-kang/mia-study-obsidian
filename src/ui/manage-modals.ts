import { App, Modal, Notice, Setting } from "obsidian";
import { keywordReferencesFromInput } from "../core/keyword-path";
import { ManagedQuestionInput } from "../core/managed-question";
import { QUESTION_TYPES, QuestionRecord, QuestionType } from "../core/models";
import { errorMessage } from "./error-message";
import { KeyboardAwareModal } from "./mobile-keyboard";

export interface ManagedQuestionDraft extends ManagedQuestionInput {
  subject: string;
  keywordMeanings: Array<{ target: string; label: string; meaning: string }>;
}

export class ConfirmDeleteModal extends Modal {
  constructor(
    app: App,
    title: string,
    private readonly description: string,
    private readonly confirmLabel: string,
    private readonly onConfirm: () => Promise<void>,
  ) {
    super(app);
    this.setTitle(title);
  }

  onOpen(): void {
    this.contentEl.createEl("p", { text: this.description });
    const actions = new Setting(this.contentEl);
    actions.addButton((button) => button.setButtonText("취소").onClick(() => this.close()));
    actions.addButton((button) => button.setButtonText(this.confirmLabel).setWarning().onClick(async () => {
      button.setDisabled(true);
      try {
        await this.onConfirm();
        this.close();
      } catch (error) {
        new Notice(`삭제 실패: ${errorMessage(error)}`);
        button.setDisabled(false);
      }
    }));
  }

  onClose(): void { this.contentEl.empty(); }
}

function keywordMeanings(
  keywords: ReturnType<typeof keywordReferencesFromInput>,
  value: string,
): Array<{ target: string; label: string; meaning: string }> {
  const meanings = value.replaceAll("\r\n", "\n").split("\n");
  return keywords.map((keyword, index) => ({
    target: keyword.target,
    label: keyword.label,
    meaning: meanings[index]?.trim() ?? "",
  }));
}

export class SubjectEditorModal extends KeyboardAwareModal {
  private value: string;

  constructor(
    app: App,
    current: string | null,
    private readonly onSubmit: (name: string) => Promise<void>,
  ) {
    super(app);
    this.value = current ?? "";
    this.setTitle(current ? "과목 이름 수정" : "과목 추가");
  }

  onOpen(): void {
    new Setting(this.contentEl).setName("과목 이름").addText((text) => {
      text.setPlaceholder("전자기학").setValue(this.value).onChange((value) => { this.value = value; });
      window.setTimeout(() => text.inputEl.focus(), 0);
    });
    new Setting(this.contentEl).addButton((button) => button.setButtonText("저장").setCta().onClick(async () => {
      button.setDisabled(true);
      try {
        await this.onSubmit(this.value);
        this.close();
      } catch (error) {
        new Notice(`과목 저장 실패: ${errorMessage(error)}`);
        button.setDisabled(false);
      }
    }));
  }

  onClose(): void { this.contentEl.empty(); }
}

export class ManagedQuestionModal extends KeyboardAwareModal {
  private subject: string;
  private newSubject = "";
  private question: string;
  private answer: string;
  private type: QuestionType;
  private coreNames: string;
  private coreMeanings: string;
  private subNames: string;
  private subMeanings: string;

  constructor(
    app: App,
    private readonly subjects: string[],
    private readonly keywordFolder: string,
    existing: QuestionRecord | null,
    meanings: ReadonlyMap<string, string>,
    private readonly onSubmit: (draft: ManagedQuestionDraft) => Promise<void>,
  ) {
    super(app);
    this.subject = existing?.subject ?? subjects[0] ?? "";
    this.question = existing?.questionMarkdown ?? "";
    this.answer = existing?.answerMarkdown ?? "";
    this.type = existing?.questionType ?? "정의형";
    this.coreNames = existing?.coreKeywords.map((item) => item.raw).join(", ") ?? "";
    this.coreMeanings = existing?.coreKeywords.map((item) => meanings.get(item.target) ?? "").join("\n") ?? "";
    this.subNames = existing?.subKeywords.map((item) => item.raw).join(", ") ?? "";
    this.subMeanings = existing?.subKeywords.map((item) => meanings.get(item.target) ?? "").join("\n") ?? "";
    this.setTitle(existing ? "질문 수정" : "질문 추가");
  }

  onOpen(): void {
    new Setting(this.contentEl).setName("과목").addDropdown((dropdown) => {
      this.subjects.forEach((subject) => dropdown.addOption(subject, subject));
      dropdown.setValue(this.subject).onChange((value) => { this.subject = value; });
      dropdown.setDisabled(this.subjects.length <= 1);
    });
    new Setting(this.contentEl).setName("새 과목 이름").setDesc("입력하면 위에서 선택한 과목 대신 새 과목을 만들고 질문을 저장합니다.").addText((text) => {
      text.setPlaceholder("새 과목을 바로 추가할 때만 입력").onChange((value) => { this.newSubject = value; });
    });
    new Setting(this.contentEl).setName("질문").setDesc("Markdown과 수식을 사용할 수 있습니다.").addTextArea((text) => {
      text.setPlaceholder("면접 질문을 입력하세요.").setValue(this.question).onChange((value) => { this.question = value; });
      text.inputEl.rows = 5;
    });
    new Setting(this.contentEl).setName("정답").addTextArea((text) => {
      text.setPlaceholder("정답과 설명을 입력하세요.").setValue(this.answer).onChange((value) => { this.answer = value; });
      text.inputEl.rows = 8;
    });
    new Setting(this.contentEl).setName("질문 유형").addDropdown((dropdown) => {
      QUESTION_TYPES.forEach((type) => dropdown.addOption(type, type));
      dropdown.setValue(this.type).onChange((value) => { this.type = value as QuestionType; });
    });
    new Setting(this.contentEl).setName("핵심 키워드").setDesc("쉼표로 구분합니다. 하나 이상 필요합니다.").addText((text) => {
      text.setPlaceholder("가우스 법칙, 전기 선속").setValue(this.coreNames).onChange((value) => { this.coreNames = value; });
    });
    new Setting(this.contentEl).setName("핵심 키워드 의미").setDesc("키워드 순서대로 한 줄에 하나씩 입력합니다.").addTextArea((text) => {
      text.setValue(this.coreMeanings).onChange((value) => { this.coreMeanings = value; });
      text.inputEl.rows = 4;
    });
    new Setting(this.contentEl).setName("보조 키워드").setDesc("쉼표로 구분합니다.").addText((text) => {
      text.setPlaceholder("대칭성, 폐곡면").setValue(this.subNames).onChange((value) => { this.subNames = value; });
    });
    new Setting(this.contentEl).setName("보조 키워드 의미").setDesc("키워드 순서대로 한 줄에 하나씩 입력합니다.").addTextArea((text) => {
      text.setValue(this.subMeanings).onChange((value) => { this.subMeanings = value; });
      text.inputEl.rows = 4;
    });
    new Setting(this.contentEl).addButton((button) => button.setButtonText("저장").setCta().onClick(async () => {
      const question = this.question.trim();
      const answer = this.answer.trim();
      const coreKeywords = keywordReferencesFromInput(this.coreNames, this.keywordFolder);
      const subKeywords = keywordReferencesFromInput(this.subNames, this.keywordFolder);
      const subject = this.newSubject.trim() || this.subject;
      if (!subject || !question || !answer || coreKeywords.length === 0) {
        new Notice("과목, 질문, 정답, 핵심 키워드를 모두 입력하세요.");
        return;
      }
      button.setDisabled(true);
      try {
        await this.onSubmit({
          subject,
          questionMarkdown: question,
          answerMarkdown: answer,
          questionType: this.type,
          coreKeywords,
          subKeywords,
          keywordMeanings: [
            ...keywordMeanings(coreKeywords, this.coreMeanings),
            ...keywordMeanings(subKeywords, this.subMeanings),
          ],
        });
        this.close();
      } catch (error) {
        new Notice(`질문 저장 실패: ${errorMessage(error)}`);
        button.setDisabled(false);
      }
    }));
  }

  onClose(): void { this.contentEl.empty(); }
}

export class KeywordEditorModal extends KeyboardAwareModal {
  private name: string;
  private meaning: string;

  constructor(
    app: App,
    current: { name: string; meaning: string } | null,
    private readonly onSubmit: (name: string, meaning: string) => Promise<void>,
  ) {
    super(app);
    this.name = current?.name ?? "";
    this.meaning = current?.meaning ?? "";
    this.setTitle(current ? "키워드 수정" : "키워드 추가");
  }

  onOpen(): void {
    new Setting(this.contentEl).setName("키워드").setDesc("이름을 바꾸면 연결된 위키링크도 Obsidian이 갱신합니다.").addText((text) => {
      text.setPlaceholder("가우스 법칙").setValue(this.name).onChange((value) => { this.name = value; });
    });
    new Setting(this.contentEl).setName("의미").addTextArea((text) => {
      text.setPlaceholder("키워드의 의미를 입력하세요.").setValue(this.meaning).onChange((value) => { this.meaning = value; });
      text.inputEl.rows = 8;
    });
    new Setting(this.contentEl).addButton((button) => button.setButtonText("저장").setCta().onClick(async () => {
      if (!this.name.trim()) {
        new Notice("키워드 이름을 입력하세요.");
        return;
      }
      button.setDisabled(true);
      try {
        await this.onSubmit(this.name.trim(), this.meaning.trim());
        this.close();
      } catch (error) {
        new Notice(`키워드 저장 실패: ${errorMessage(error)}`);
        button.setDisabled(false);
      }
    }));
  }

  onClose(): void { this.contentEl.empty(); }
}

export const ManageModalInternals = { keywordMeanings };
