import { Component, MarkdownRenderer, Modal, Notice, TFile } from "obsidian";
import { keywordNotePath } from "../core/keyword-path";
import { errorMessage } from "./error-message";

export class KeywordMeaningModal extends Modal {
  private renderer: Component | null = null;

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
    this.titleEl.setText(this.label);
    this.renderer = new Component();
    this.renderer.load();
    const file = this.app.metadataCache.getFirstLinkpathDest(this.target, this.sourcePath);
    if (file) {
      try {
        const markdown = await this.app.vault.cachedRead(file);
        await MarkdownRenderer.render(this.app, markdown, this.contentEl, file.path, this.renderer);
        const open = this.contentEl.createEl("button", { text: "키워드 노트 열기" });
        open.addEventListener("click", async () => {
          try {
            await this.app.workspace.getLeaf("tab").openFile(file);
            this.close();
          } catch (error) {
            new Notice(`키워드 노트 열기 실패: ${errorMessage(error)}`);
          }
        });
      } catch (error) {
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
        const folder = path.split("/").slice(0, -1).join("/");
        if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
        const existing = this.app.vault.getAbstractFileByPath(path);
        const fileToOpen = existing instanceof TFile ? existing : await this.app.vault.create(path, `# ${this.label}\n\n## 의미\n\n\n## 연결\n`);
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
    this.renderer?.unload();
    this.contentEl.empty();
  }
}
