import { Notice, TFile, TFolder, normalizePath } from "obsidian";
import { createSubjectBank, renameSubjectBank, validateSubjectName } from "../core/managed-question";
import { portableNameKey } from "../core/note-name";
import { isManagedSubjectNote, renderSubjectNote, subjectNoteFileName } from "../core/subject-note";
import { applyFileChanges, type FileChange } from "./file-change-batch";
import type { FollowUpLinks } from "./follow-up-links";
import type { MiaHost } from "./mia-host";
import type { SubjectNotes } from "./subject-notes";
import { assertPortablePath, ensureFolder, trashFileVerified } from "./vault-files";

/** Subject folders under the managed root: each holds `문제은행.md` and a generated subject note. */
export class SubjectOperations {
  constructor(
    private readonly host: MiaHost,
    private readonly notes: SubjectNotes,
    private readonly followUps: FollowUpLinks,
  ) {}

  list(): string[] {
    const root = this.host.app.vault.getAbstractFileByPath(this.host.managedRoot);
    if (!(root instanceof TFolder)) return [];
    const keywordRelative = this.keywordContainerName();
    return root.children
      .filter((child): child is TFolder => child instanceof TFolder)
      .map((folder) => folder.name)
      .filter((name) => name !== keywordRelative)
      .sort((left, right) => left.localeCompare(right, "ko"));
  }

  async create(value: string): Promise<void> {
    const { app } = this.host;
    const subject = validateSubjectName(value);
    const keywordContainer = this.keywordContainerName();
    if (keywordContainer && portableNameKey(subject) === portableNameKey(keywordContainer)) throw new Error("키워드 보관 폴더와 같은 이름은 사용할 수 없습니다.");
    await ensureFolder(app, this.host.managedRoot);
    const folderPath = normalizePath(`${this.host.managedRoot}/${subject}`);
    assertPortablePath(app, folderPath);
    if (app.vault.getAbstractFileByPath(folderPath)) throw new Error("이미 존재하는 과목입니다.");
    await app.vault.createFolder(folderPath);
    await app.vault.create(normalizePath(`${folderPath}/문제은행.md`), createSubjectBank(subject));
    await app.vault.create(this.notes.path(subject), renderSubjectNote(subject, []));
    new Notice(`${subject} 과목을 만들었습니다.`);
  }

  /** Renames the folder and its generated note, then rolls both back if any later step fails. */
  async rename(current: string, value: string): Promise<void> {
    const { app } = this.host;
    const next = validateSubjectName(value);
    if (next === current) return;
    const keywordContainer = this.keywordContainerName();
    if (keywordContainer && portableNameKey(next) === portableNameKey(keywordContainer)) throw new Error("키워드 보관 폴더와 같은 이름은 사용할 수 없습니다.");
    const currentPath = normalizePath(`${this.host.managedRoot}/${current}`);
    const nextPath = normalizePath(`${this.host.managedRoot}/${next}`);
    assertPortablePath(app, nextPath);
    const folder = app.vault.getAbstractFileByPath(currentPath);
    if (!(folder instanceof TFolder)) throw new Error("기존 과목 폴더를 찾지 못했습니다.");
    if (app.vault.getAbstractFileByPath(nextPath)) throw new Error("같은 이름의 과목이 이미 있습니다.");
    const oldNotePath = this.notes.path(current);
    assertPortablePath(app, normalizePath(`${currentPath}/${subjectNoteFileName(next)}`));
    const oldNote = app.vault.getAbstractFileByPath(oldNotePath);
    const renameGeneratedNote = oldNote instanceof TFile
      && isManagedSubjectNote(await app.vault.cachedRead(oldNote));
    const futureNote = app.vault.getAbstractFileByPath(normalizePath(`${currentPath}/${subjectNoteFileName(next)}`));
    if (futureNote && futureNote.path !== oldNotePath) throw new Error("변경할 과목 노트 이름과 같은 파일이 이미 있습니다.");
    let createdNote: { path: string; content: string } | undefined;
    try {
      await app.fileManager.renameFile(folder, nextPath);
      if (renameGeneratedNote) {
        const movedNote = app.vault.getAbstractFileByPath(normalizePath(`${nextPath}/${subjectNoteFileName(current)}`));
        if (!(movedNote instanceof TFile)) throw new Error("과목 폴더 변경 후 자동 노트를 찾지 못했습니다.");
        await app.fileManager.renameFile(movedNote, this.notes.path(next));
      }
      await this.host.index.rebuild();
      const bank = app.vault.getAbstractFileByPath(normalizePath(`${nextPath}/문제은행.md`));
      const writes: FileChange[] = [];
      if (bank instanceof TFile) writes.push({ file: bank, update: content => renameSubjectBank(content, current, next) });
      const generatedNote = app.vault.getAbstractFileByPath(this.notes.path(next));
      if (renameGeneratedNote && generatedNote instanceof TFile) {
        const questions = await this.notes.questions(next);
        writes.push({ file: generatedNote, update: content => {
          if (!isManagedSubjectNote(content)) throw new Error("과목 노트가 사용자 노트로 변경되어 덮어쓰지 않았습니다.");
          return renderSubjectNote(next, questions);
        } });
      }
      await applyFileChanges(app.vault, writes, async () => {
        if (!renameGeneratedNote) {
          const questions = await this.notes.questions(next);
          const path = this.notes.path(next);
          if (app.vault.getAbstractFileByPath(path)) throw new Error("새 과목 노트 경로에 다른 파일이 생겼습니다.");
          createdNote = { path, content: renderSubjectNote(next, questions) };
          await app.vault.create(path, createdNote.content);
        }
        await this.host.index.rebuild();
        await this.followUps.refreshIncoming(this.host.index.registered.filter(question => question.subject === next).map(question => question.id));
      });
    } catch (error) {
      try {
        if (createdNote) {
          const note = app.vault.getAbstractFileByPath(createdNote.path);
          if (note instanceof TFile) {
            if (await app.vault.read(note) !== createdNote.content) throw new Error("새 과목 노트가 다른 작업에서 변경되어 보존했습니다.");
            await trashFileVerified(app, note);
          } else if (note) throw new Error("새 과목 노트 경로가 변경되어 보존했습니다.");
        }
        if (oldNote instanceof TFile && oldNote.path === this.notes.path(next)) {
          const restoreNotePath = normalizePath(`${nextPath}/${subjectNoteFileName(current)}`);
          if (app.vault.getAbstractFileByPath(restoreNotePath)) throw new Error("원래 과목 노트 경로가 사용 중입니다.");
          await app.fileManager.renameFile(oldNote, restoreNotePath);
        }
        if (folder.path === nextPath) {
          if (app.vault.getAbstractFileByPath(currentPath)) throw new Error("원래 과목 폴더 경로가 사용 중입니다.");
          await app.fileManager.renameFile(folder, currentPath);
        }
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], "과목 이름 변경을 복구하지 못했습니다. 원래 폴더와 변경 폴더를 확인하세요.");
      } finally {
        await this.host.index.rebuild();
      }
      throw error;
    }
    await this.host.index.rebuild();
    new Notice(`${current} 과목을 ${next}(으)로 변경했습니다.`);
  }

  async delete(subject: string): Promise<void> {
    const { app } = this.host;
    const folderPath = normalizePath(`${this.host.managedRoot}/${subject}`);
    const folder = app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) throw new Error("과목 폴더를 찾지 못했습니다.");
    const ids = this.host.index.registered
      .filter((question) => question.filePath.startsWith(`${folderPath}/`))
      .map((question) => question.id);
    await trashFileVerified(app, folder);
    try {
      await this.host.index.rebuild();
      const writes = this.followUps.fileChanges(this.followUps.removedChanges(ids));
      await applyFileChanges(app.vault, writes, () => this.host.store.removeReviews(ids));
      await this.host.index.rebuild();
    } catch (error) {
      await this.host.index.rebuild();
      throw new Error("과목 폴더는 휴지통으로 이동했지만 평가 또는 연결 정리가 완료되지 않았습니다. 복구하려면 휴지통의 과목 폴더를 확인하세요.", { cause: error });
    }
    new Notice(`${subject} 과목을 휴지통으로 이동했습니다.`);
  }

  /** Top-level folder of the keyword folder when it sits inside the managed root; never a subject. */
  keywordContainerName(): string | null {
    return this.host.store.settings.keywordFolder.startsWith(`${this.host.managedRoot}/`)
      ? this.host.store.settings.keywordFolder.slice(this.host.managedRoot.length + 1).split("/")[0] ?? null
      : null;
  }
}
