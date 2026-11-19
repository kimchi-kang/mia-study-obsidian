import { Component, MarkdownRenderer, Modal, Notice, TFile, TFolder } from "obsidian";
import { keywordLinkPath, keywordNotePath } from "../core/keyword-path";
import { createKeywordNote, readKeywordMeaning } from "../core/keyword-note";
import { assertPortablePath, ensureFolder } from "../services/vault-files";
import { errorMessage } from "./error-message";

/** Shows only the keyword and its meaning; the note's link list and other sections stay in the note. */
export class KeywordMeaningModal extends Modal {
  private renderer: Component | null = null;
  private renderRevision = 0;

  constructor(
    app: ConstructorParameters<typeof Modal>[0],
    private readonly target: string,
    private readonly label: string,
    private readonly sourcePath: string,
    private readonly keywordFolder: string,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const revision = ++this.renderRevision;
    this.contentEl.empty();
    this.modalEl.addClass("mia-preview-modal", "mia-keyword-meaning-modal");
    this.titleEl.setText(this.label);
    const file = this.app.metadataCache.getFirstLinkpathDest(keywordLinkPath(this.target), this.sourcePath);
    if (file) {
      if (file.extension !== "md") {
        this.contentEl.createEl("p", { text: "이 링크는 노트가 아닌 파일을 가리킵니다.", cls: "mia-warning" });
        return;
      }
      const renderer = new Component();
      this.renderer = renderer;
      renderer.load();
      try {
        const markdown = await this.app.vault.cachedRead(file);
        if (revision !== this.renderRevision) return;
        // MIA notes keep the meaning under "## 의미"; a hand-written note without it shows its body without the title.
        const meaning = /^ {0,3}##\s+의미\s*$/m.test(markdown) ? readKeywordMeaning(markdown) : markdown.replace(/^\uFEFF?\s*# [^\n]*\n?/, "").trim();
        const section = this.contentEl.createDiv({ cls: "mia-keyword-meaning" });
        section.createDiv({ text: "의미", cls: "mia-card-label" });
        if (meaning) {
          const content = section.createDiv({ cls: "mia-markdown mia-answer" });
          await MarkdownRenderer.render(this.app, meaning, content, file.path, renderer);
          if (revision !== this.renderRevision) return;
        } else {
          section.createEl("p", { text: "아직 의미가 적혀 있지 않습니다. 편집에서 의미를 적으면 여기에 보입니다.", cls: "mia-muted" });
        }
        const actions = this.contentEl.createDiv({ cls: "mia-preview-actions" });
        actions.createEl("button", { text: "닫기", cls: "mod-cta" }).addEventListener("click", () => this.close());
        const open = actions.createEl("button", { text: "키워드 노트 열기" });
        open.addEventListener("click", async () => {
          try {
            await this.app.workspace.getLeaf("tab").openFile(file);
            this.close();
          } catch (error) {
            new Notice(`키워드 노트 열기 실패: ${errorMessage(error)}`);
          }
        });
      } catch (error) {
        if (revision !== this.renderRevision) return;
        this.contentEl.createEl("p", { text: `키워드 노트를 읽지 못했습니다: ${errorMessage(error)}`, cls: "mia-warning" });
      }
      return;
    }
    this.contentEl.createEl("p", { text: "아직 이 키워드의 의미 노트가 없습니다." });
    const create = this.contentEl.createEl("button", { text: "의미 노트 만들기", cls: "mod-cta" });
    create.addEventListener("click", async () => {
      create.disabled = true;
      try {
        const path = keywordNotePath(this.target, this.label, this.keywordFolder);
        assertPortablePath(this.app, path);
        const folder = path.split("/").slice(0, -1).join("/");
        if (folder) await ensureFolder(this.app, folder);
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFolder) throw new Error("키워드 노트 경로가 폴더와 겹칩니다.");
        const fileToOpen = existing instanceof TFile ? existing : await this.app.vault.create(path, createKeywordNote(this.label, ""));
        await this.app.workspace.getLeaf("tab").openFile(fileToOpen);
        new Notice("키워드 의미 노트를 만들었습니다.");
        this.close();
      } catch (error) {
        new Notice(`키워드 노트 생성 실패: ${errorMessage(error)}`);
        create.disabled = false;
      }
    });
  }

  onClose(): void {
    this.renderRevision++;
    this.renderer?.unload();
    this.renderer = null;
    this.contentEl.empty();
  }
}
