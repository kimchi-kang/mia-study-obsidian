import { TFile, TFolder, normalizePath } from "obsidian";
import type { QuestionRecord } from "../core/models";
import { parseQuestionFile } from "../core/question-parser";
import { isManagedSubjectNote, renderSubjectNote, subjectNoteFileName } from "../core/subject-note";
import type { MiaHost } from "./mia-host";
import { assertPortablePath, ensureFolder } from "./vault-files";

/** The generated note that lists every question in a subject folder. */
export class SubjectNotes {
  constructor(private readonly host: MiaHost) {}

  path(subject: string): string {
    return normalizePath(`${this.host.managedRoot}/${subject}/${subjectNoteFileName(subject)}`);
  }

  async assertWritable(subject: string): Promise<void> {
    const { app } = this.host;
    assertPortablePath(app, this.path(subject));
    const existing = app.vault.getAbstractFileByPath(this.path(subject));
    if (existing instanceof TFolder) throw new Error("과목 노트 경로가 폴더와 겹칩니다.");
    if (existing instanceof TFile && !isManagedSubjectNote(await app.vault.cachedRead(existing))) {
      throw new Error(`${subjectNoteFileName(subject)} 파일이 이미 있으며 자동 생성 노트가 아닙니다.`);
    }
  }

  /**
   * Every question file in the subject folder, not just `문제은행.md`: imported
   * files live beside the bank. `written` supplies contents this operation just
   * persisted so the note never reflects a stale read.
   */
  async questions(subject: string, written: ReadonlyMap<string, string> = new Map()): Promise<QuestionRecord[]> {
    const { app } = this.host;
    const folder = app.vault.getAbstractFileByPath(normalizePath(`${this.host.managedRoot}/${subject}`));
    if (!(folder instanceof TFolder)) return [];
    const notePath = this.path(subject);
    const bankPath = normalizePath(`${folder.path}/문제은행.md`);
    const files: TFile[] = [];
    const collect = (entry: TFolder): void => {
      for (const child of entry.children) {
        if (child instanceof TFolder) collect(child);
        else if (child instanceof TFile && child.extension === "md" && child.path !== notePath) files.push(child);
      }
    };
    collect(folder);
    files.sort((left, right) => Number(right.path === bankPath) - Number(left.path === bankPath) || left.path.localeCompare(right.path, "ko"));
    const questions: QuestionRecord[] = [];
    for (const file of files) {
      const content = written.get(file.path) ?? await app.vault.read(file);
      questions.push(...parseQuestionFile(file.path, content, { subject }).questions);
    }
    return questions;
  }

  async sync(subject: string, questions: QuestionRecord[]): Promise<void> {
    const { app } = this.host;
    await this.assertWritable(subject);
    const folderPath = normalizePath(`${this.host.managedRoot}/${subject}`);
    await ensureFolder(app, folderPath);
    const path = this.path(subject);
    const content = renderSubjectNote(subject, questions);
    const existing = app.vault.getAbstractFileByPath(path);
    // Startup re-syncs every note; do not touch (and re-sync) files that already match.
    if (existing instanceof TFile && await app.vault.read(existing) === content) return;
    if (existing instanceof TFile) await app.vault.process(existing, latest => {
      if (!isManagedSubjectNote(latest)) throw new Error(`${subjectNoteFileName(subject)} 파일이 사용자 노트로 변경되어 덮어쓰지 않았습니다.`);
      return content;
    });
    else await app.vault.create(path, content);
  }
}
