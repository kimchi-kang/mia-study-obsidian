import { renderQuestionTitle } from "./question-title";
import { App, Component, Modal, Notice, Setting, type TextComponent } from "obsidian";
import { keywordReferencesFromInput } from "../core/keyword-path";
import type { ManagedQuestionDraft } from "../core/managed-question";
import { QUESTION_TYPES, KeywordReference, QuestionRecord, QuestionType } from "../core/models";
import { MAX_FOLLOW_UPS, questionBlockLink } from "../core/follow-up";
import { errorMessage } from "./error-message";
import { KeyboardAwareModal } from "./mobile-keyboard";

export type { ManagedQuestionDraft };

export class ConfirmDeleteModal extends Modal {
  private confirming = false;

  constructor(
    app: App,
    title: string,
    private readonly description: string,
    private readonly confirmLabel: string,
    private readonly onConfirm: () => Promise<void>,
    private readonly failureLabel = "삭제 실패",
  ) {
    super(app);
    this.setTitle(title);
  }

  onOpen(): void {
    this.modalEl.classList.add("mia-preview-modal", "mia-confirm-modal");
    this.contentEl.createEl("p", { text: this.description });
    const actions = new Setting(this.contentEl);
    actions.addButton((button) => button.setButtonText("취소").onClick(() => this.close()));
    actions.addButton((button) => button.setButtonText(this.confirmLabel).setWarning().onClick(async () => {
      if (this.confirming) return;
      this.confirming = true;
      button.setDisabled(true);
      try {
        await this.onConfirm();
        this.close();
      } catch (error) {
        new Notice(`${this.failureLabel}: ${errorMessage(error)}`);
        this.confirming = false;
        button.setDisabled(false);
      }
    }));
  }

  onClose(): void { this.contentEl.empty(); }
}

interface MeaningEdit {
  original: string;
  value?: string;
  loading?: Promise<void>;
}

export class SubjectEditorModal extends KeyboardAwareModal {
  private value: string;

  constructor(
    app: App,
    current: string | null,
    private readonly onSubmit: (name: string) => Promise<void>,
  ) {
    super(app, "compact");
    this.value = current ?? "";
    this.setTitle(current ? "과목 이름 수정" : "과목 추가");
  }

  onOpen(): void {
    new Setting(this.contentEl).setName("과목 이름").addText((text) => {
      text.setPlaceholder("지리학").setValue(this.value).onChange((value) => { this.value = value; });
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
  private readonly titleRenderer = new Component();
  private saving = false;
  private questionInput: HTMLTextAreaElement | null = null;
  private subject: string;
  private newSubject = "";
  private question: string;
  private answer: string;
  private type: QuestionType;
  private coreNames: string;
  private subNames: string;
  private readonly originalMeanings: ReadonlyMap<string, string>;
  private readonly meaningEdits = new Map<string, MeaningEdit>();
  private readonly selectedFollowUps = new Map<string, QuestionRecord & { id: string }>();

  constructor(
    app: App,
    private readonly subjects: string[],
    private readonly keywordFolder: string,
    private readonly existing: QuestionRecord | null,
    meanings: ReadonlyMap<string, string>,
    private readonly onSubmit: (draft: ManagedQuestionDraft) => Promise<void>,
    private readonly availableQuestions: ReadonlyArray<QuestionRecord & { id: string }> = [],
    private readonly onClosed?: () => void,
    private readonly loadMeaning?: (keyword: KeywordReference, subject: string) => Promise<string>,
  ) {
    super(app, "long");
    this.subject = existing?.subject ?? subjects[0] ?? "";
    this.question = existing?.questionMarkdown ?? "";
    this.answer = existing?.answerMarkdown ?? "";
    this.type = existing?.questionType ?? "정의형";
    this.coreNames = existing?.coreKeywords.map((item) => item.raw).join(", ") ?? "";
    this.subNames = existing?.subKeywords.map((item) => item.raw).join(", ") ?? "";
    this.originalMeanings = new Map(meanings);
    this.setTitle(existing ? "질문 수정" : "질문 추가");
  }

  onOpen(): void {
    this.titleRenderer.load();
    if (this.subjects.length) new Setting(this.contentEl).setName("과목").addDropdown((dropdown) => {
      this.subjects.forEach((subject) => dropdown.addOption(subject, subject));
      dropdown.setValue(this.subject).onChange((value) => { this.subject = value; });
      dropdown.setDisabled(this.subjects.length <= 1);
    });
    new Setting(this.contentEl).setName(this.subjects.length ? "새 과목 이름" : "과목 이름")
      .setDesc(this.subjects.length ? "입력하면 위에서 선택한 과목 대신 새 과목을 만들고 질문을 저장합니다." : "질문과 함께 새 과목을 만듭니다. 과목을 따로 추가할 필요가 없습니다.").addText((text) => {
      text.setPlaceholder(this.subjects.length ? "새 과목을 바로 추가할 때만 입력" : "예: 지리학").onChange((value) => { this.newSubject = value; });
    });
    new Setting(this.contentEl).setName("질문").setDesc("Markdown과 수식을 사용할 수 있습니다.").addTextArea((text) => {
      this.questionInput = text.inputEl;
      text.setPlaceholder("질문을 입력하세요.").setValue(this.question).onChange((value) => { this.question = value; });
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
    const meaningFields: Array<{ parent: HTMLElement; names: () => string }> = [];
    const keywordSetting = (name: string, description: string, configure: (text: TextComponent) => void, names: () => string) => {
      const setting = new Setting(this.contentEl).setName(name).setDesc(description);
      const parent = this.contentEl.createDiv({ cls: "mia-keyword-meanings" });
      meaningFields.push({ parent, names });
      setting.addText(text => {
        configure(text);
        let renderedNames = names();
        text.inputEl.addEventListener("blur", () => {
          if (names() === renderedNames) return;
          renderedNames = names();
          this.renderMeaningFields(meaningFields);
        });
      });
    };
    keywordSetting("핵심 키워드", "쉼표로 구분합니다. 하나 이상 필요합니다.", text => {
      text.setPlaceholder("레시피 원칙, 인구 분석").setValue(this.coreNames).onChange(value => { this.coreNames = value; });
    }, () => this.coreNames);
    keywordSetting("보조 키워드", "쉼표로 구분합니다.", text => {
      text.setPlaceholder("중앙값, 분포").setValue(this.subNames).onChange(value => { this.subNames = value; });
    }, () => this.subNames);
    this.renderMeaningFields(meaningFields);
    if (!this.existing && this.availableQuestions.length) this.renderFollowUpPicker();
    new Setting(this.contentEl).addButton((button) => button.setButtonText(this.onClosed ? "취소하고 학습으로 돌아가기" : "취소").onClick(() => this.close()));
    const status = this.contentEl.createEl("p", { cls: "mia-muted", attr: { role: "status", "aria-live": "polite" } });
    new Setting(this.contentEl).addButton((button) => button.setButtonText("저장").setCta().onClick(async () => {
      if (this.saving) return;
      status.removeClass("mia-warning");
      status.setText("");
      let controls: Array<{ element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement; disabled: boolean }> = [];
      try {
        const question = this.question.trim();
        const answer = this.answer.trim();
        const coreKeywords = keywordReferencesFromInput(this.coreNames, this.keywordFolder);
        const subKeywords = keywordReferencesFromInput(this.subNames, this.keywordFolder);
        const subject = this.newSubject.trim() || this.subject;
        const missing = !subject ? "과목 이름을 입력하세요." : !question ? "질문을 입력하세요." : !answer ? "정답을 입력하세요." : coreKeywords.length === 0 ? "핵심 키워드를 하나 이상 입력하세요." : "";
        if (missing) {
          status.addClass("mia-warning");
          status.setText(`${missing} 입력 내용은 유지됩니다.`);
          return;
        }
        this.saving = true;
        controls = [...this.contentEl.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>("input, textarea, select, button")]
          .map((element) => ({ element, disabled: element.disabled }));
        for (const { element } of controls) element.disabled = true;
        button.setDisabled(true).setButtonText("저장 중…");
        status.setText("질문을 저장하고 있습니다…");
        button.buttonEl.scrollIntoView({ block: "nearest" });
        const keywords = [...coreKeywords, ...subKeywords];
        const pending = keywords.flatMap(({ target }) => {
          const edit = this.meaningEdits.get(target);
          return edit?.value !== undefined && edit.loading ? [edit.loading] : [];
        });
        if (pending.length) await Promise.all(pending);
        await this.onSubmit({
          subject,
          questionMarkdown: question,
          answerMarkdown: answer,
          questionType: this.type,
          coreKeywords,
          subKeywords,
          ...(!this.existing ? { followUpLinks: [...this.selectedFollowUps.values()].map(questionBlockLink) } : {}),
          keywordMeanings: this.meaningChanges(keywords),
        });
        this.saving = false;
        this.close();
      } catch (error) {
        status.addClass("mia-warning");
        status.setText(`저장하지 못했습니다: ${errorMessage(error).replace(/[.!?。]+$/u, "")}. 입력 내용은 유지되었습니다. 원인을 확인한 뒤 다시 저장해 주세요.`);
      } finally {
        this.saving = false;
        for (const { element, disabled } of controls) element.disabled = disabled;
        button.setDisabled(false).setButtonText("저장");
        button.buttonEl.scrollIntoView({ block: "nearest" });
      }
    }));
  }

  open(): void {
    super.open();
    // Obsidian focuses the first control after onOpen; focus the question afterwards.
    if (this.onClosed && this.questionInput) {
      this.questionInput.focus({ preventScroll: true });
      this.questionInput.scrollIntoView({ block: "nearest" });
    }
  }

  private renderMeaningFields(groups: ReadonlyArray<{ parent: HTMLElement; names: () => string }>): void {
    const rendered = new Set<string>();
    for (const { parent, names } of groups) {
      let keywords: KeywordReference[];
      try {
        keywords = keywordReferencesFromInput(names(), this.keywordFolder);
      } catch {
        // Invalid input is reported at save, while the meaning drafts stay intact.
        keywords = [];
      }
      parent.empty();
      for (const keyword of keywords) {
        if (rendered.has(keyword.target)) continue;
        rendered.add(keyword.target);
        let edit = this.meaningEdits.get(keyword.target);
        if (!edit) {
          edit = { original: this.originalMeanings.get(keyword.target) ?? "" };
          this.meaningEdits.set(keyword.target, edit);
          if (!this.originalMeanings.has(keyword.target) && this.loadMeaning) {
            const field = edit;
            field.loading = this.loadMeaning(keyword, this.newSubject.trim() || this.subject)
              .then(value => { field.original = value; })
              .catch(error => { new Notice(`키워드 의미를 불러오지 못했습니다: ${errorMessage(error)}`); })
              .finally(() => { delete field.loading; });
          }
        }
        const field = edit;
        new Setting(parent).setName(keyword.label).addTextArea(text => {
          text.inputEl.rows = 4;
          text.inputEl.setAttribute("aria-label", `${keyword.label} 의미`);
          text.setValue(field.value ?? field.original).onChange(value => { field.value = value; });
          void field.loading?.then(() => {
            if (field.value === undefined) text.setValue(field.original);
          });
        });
      }
    }
  }

  private meaningChanges(keywords: readonly KeywordReference[]): ManagedQuestionDraft["keywordMeanings"] {
    const changes = new Map<string, ManagedQuestionDraft["keywordMeanings"][number]>();
    for (const { target, label } of keywords) {
      const edit = this.meaningEdits.get(target);
      if (edit?.value === undefined || changes.has(target)) continue;
      const meaning = edit.value.trim();
      if (meaning === edit.original.trim() && (meaning || this.originalMeanings.has(target))) continue;
      changes.set(target, !meaning && !this.originalMeanings.has(target)
        ? { target, label, meaning, preserveExistingWhenEmpty: true }
        : { target, label, meaning });
    }
    return [...changes.values()];
  }

  private renderFollowUpPicker(): void {
    this.contentEl.createEl("h3", { text: "꼬리질문 선택" });
    this.contentEl.createEl("p", { text: `기존 문제를 최대 ${MAX_FOLLOW_UPS}개까지 연결할 수 있습니다.`, cls: "mia-muted" });
    const searchSetting = new Setting(this.contentEl).setName("꼬리질문 검색");
    const selected = this.contentEl.createDiv({ cls: "mia-follow-up-selected" });
    const results = this.contentEl.createDiv({ cls: "mia-follow-up-picker" });
    let query = "";
    const render = () => {
      selected.empty();
      selected.createEl("p", { text: `선택 ${this.selectedFollowUps.size} / ${MAX_FOLLOW_UPS}` });
      for (const question of this.selectedFollowUps.values()) {
        const button = selected.createEl("button");
        void renderQuestionTitle(this.app, `${question.subject} · ${question.heading} · 선택 해제`, button, question.filePath, this.titleRenderer);
        button.addEventListener("click", () => {
          this.selectedFollowUps.delete(question.id); render();
        });
      }
      results.empty();
      const matches = this.availableQuestions.filter((question) => !this.selectedFollowUps.has(question.id)
        && `${question.subject} ${question.heading} ${question.questionMarkdown}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
      if (!matches.length) results.createEl("p", { text: "선택할 문제가 없습니다.", cls: "mia-muted" });
      for (const question of matches.slice(0, 50)) {
        const button = results.createEl("button");
        void renderQuestionTitle(this.app, `${question.subject} · ${question.heading}`, button, question.filePath, this.titleRenderer);
        button.disabled = this.selectedFollowUps.size >= MAX_FOLLOW_UPS;
        button.addEventListener("click", () => {
          if (this.selectedFollowUps.size >= MAX_FOLLOW_UPS) return;
          this.selectedFollowUps.set(question.id, question); render();
        });
      }
      if (matches.length > 50) results.createEl("p", { text: "검색어를 입력해 더 좁혀보세요. 처음 50개를 표시합니다.", cls: "mia-muted" });
    };
    searchSetting.addSearch((search) => {
      search.setPlaceholder("과목, 제목, 질문 내용").onChange((value) => { query = value.trim(); render(); });
    });
    render();
  }

  close(): void { if (!this.saving) super.close(); }

  onClose(): void {
    this.titleRenderer.unload();
    this.contentEl.empty();
    this.questionInput = null;
    // Return after Obsidian finishes restoring the old modal focus.
    if (this.onClosed) queueMicrotask(this.onClosed);
  }
}

export class KeywordEditorModal extends KeyboardAwareModal {
  private name: string;
  private meaning: string;

  constructor(
    app: App,
    current: { name: string; meaning: string } | null,
    private readonly onSubmit: (name: string, meaning: string) => Promise<void>,
  ) {
    super(app, "medium");
    this.name = current?.name ?? "";
    this.meaning = current?.meaning ?? "";
    this.setTitle(current ? "키워드 수정" : "키워드 추가");
  }

  onOpen(): void {
    new Setting(this.contentEl).setName("키워드").setDesc("이름을 바꾸면 연결된 위키링크도 Obsidian이 갱신합니다.").addText((text) => {
      text.setPlaceholder("레시피 원칙").setValue(this.name).onChange((value) => { this.name = value; });
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
