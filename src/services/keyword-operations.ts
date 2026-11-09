import { Notice, TFile, TFolder, normalizePath } from "obsidian";
import {
  assertMergeableKeywordNote,
  createKeywordNote,
  readKeywordMeaning,
  updateKeywordMeaning,
  validateKeywordMeaning,
  validateKeywordName,
} from "../core/keyword-note";
import { keywordNotePath } from "../core/keyword-path";
import { keywordReferenceMatches, removeKeywordReferences, renameKeywordReferences } from "../core/keyword-reference";
import { followUpLinksIn } from "../core/managed-question";
import { portableNameKey } from "../core/note-name";
import type { KeywordReference, QuestionRecord } from "../core/models";
import { parseQuestionFile } from "../core/question-parser";
import { findCurrentQuestion, updateQuestionMetadata } from "../core/question-writer";
import { applyFileChanges, type FileChange } from "./file-change-batch";
import type { MiaHost } from "./mia-host";
import { assertPortablePath, ensureFolder, trashFileVerified } from "./vault-files";

export interface KeywordNoteEntry {
  name: string;
  target: string;
  filePath: string;
}

type RegisteredQuestion = QuestionRecord & { id: string };

/** A note's file name as Obsidian compares it when resolving a link: no folder, no extension, any case or Unicode form. */
function fileNameKey(path: string): string {
  const name = path.replaceAll("\\", "/").split("/").at(-1) ?? "";
  return portableNameKey(name.replace(/\.md$/i, "").trim());
}

/** Keyword notes and the keyword references that questions hold to them. */
export class KeywordOperations {
  constructor(private readonly host: MiaHost) {}

  list(): KeywordNoteEntry[] {
    const folder = normalizePath(this.host.store.settings.keywordFolder);
    return this.host.app.vault.getMarkdownFiles()
      .filter((file) => file.path.startsWith(`${folder}/`))
      .map((file) => ({
        name: file.basename,
        target: file.path.replace(/\.md$/i, ""),
        filePath: file.path,
      }))
      .sort((left, right) => left.name.localeCompare(right.name, "ko"));
  }

  async readMeaning(path: string): Promise<string> {
    const { app } = this.host;
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return "";
    return readKeywordMeaning(await app.vault.cachedRead(file));
  }

  async loadMeanings(question: QuestionRecord): Promise<Map<string, string>> {
    const { app } = this.host;
    const output = new Map<string, string>();
    for (const keyword of [...question.coreKeywords, ...question.subKeywords]) {
      const file = app.metadataCache.getFirstLinkpathDest(keyword.target, question.filePath);
      output.set(keyword.target, file ? readKeywordMeaning(await app.vault.cachedRead(file)) : "");
    }
    return output;
  }

  async saveReferenceMeaning(target: string, label: string, meaning: string, preserveExistingWhenEmpty = false): Promise<void> {
    const { app } = this.host;
    validateKeywordMeaning(meaning);
    const path = keywordNotePath(target, label, this.host.store.settings.keywordFolder);
    assertPortablePath(app, path);
    const folder = path.split("/").slice(0, -1).join("/");
    if (folder) await ensureFolder(app, folder);
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) throw new Error("키워드 노트 경로가 폴더와 겹칩니다.");
    if (existing instanceof TFile) {
      if (preserveExistingWhenEmpty && !meaning.trim()) return;
      await app.vault.process(existing, (content) => updateKeywordMeaning(content, label, meaning));
    } else {
      await app.vault.create(path, createKeywordNote(label, meaning));
    }
  }

  async saveMeaning(name: string, meaning: string, notify = true): Promise<void> {
    const { app } = this.host;
    const safeName = validateKeywordName(name);
    validateKeywordMeaning(meaning);
    const path = keywordNotePath(safeName, safeName, this.host.store.settings.keywordFolder);
    assertPortablePath(app, path);
    const folder = path.split("/").slice(0, -1).join("/");
    if (folder) await ensureFolder(app, folder);
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) throw new Error("키워드 노트 경로가 폴더와 겹칩니다.");
    if (existing instanceof TFile) {
      await app.vault.process(existing, (content) => updateKeywordMeaning(content, safeName, meaning));
    } else {
      await app.vault.create(path, createKeywordNote(safeName, meaning));
    }
    if (notify) new Notice(`${safeName} 키워드를 저장했습니다.`);
  }

  /** Creates, edits, renames, or merges into an existing keyword, updating every question that references it. */
  async save(current: KeywordNoteEntry | null, value: string, meaning: string): Promise<void> {
    const { app } = this.host;
    const name = validateKeywordName(value);
    if (!current) {
      await this.saveMeaning(name, meaning);
      return;
    }
    if (current.name === name) {
      validateKeywordMeaning(meaning);
      const file = app.vault.getAbstractFileByPath(current.filePath);
      if (!(file instanceof TFile)) throw new Error("기존 키워드 노트를 찾지 못했습니다.");
      await app.vault.process(file, content => updateKeywordMeaning(content, name, meaning));
      new Notice(`${name} 키워드를 저장했습니다.`);
      return;
    }
    const source = app.vault.getAbstractFileByPath(current.filePath);
    if (!(source instanceof TFile)) throw new Error("기존 키워드 노트를 찾지 못했습니다.");
    const nextPath = keywordNotePath(name, name, this.host.store.settings.keywordFolder);
    assertPortablePath(app, nextPath);
    const destination = app.vault.getAbstractFileByPath(nextPath);
    if (destination instanceof TFolder) throw new Error("변경할 키워드 경로가 폴더와 겹칩니다.");
    const nextTarget = nextPath.replace(/\.md$/i, "");
    // Only a merge removes the source note. A rename keeps it, and Obsidian has
    // already pointed short links at its new path in the vault's link format.
    const references = (removed: readonly string[]) => this.referenceChanges(
      [current.target, nextTarget],
      (items, spellings) => renameKeywordReferences(items, spellings, nextTarget, name),
      removed,
    );
    if (destination instanceof TFile) {
      const sourceContent = await app.vault.read(source);
      assertMergeableKeywordNote(sourceContent);
      const sourceMeaning = readKeywordMeaning(sourceContent);
      await applyFileChanges(app.vault, [{ file: destination, update: content => {
        const destinationMeaning = readKeywordMeaning(content);
        const mergedMeaning = [...new Set([destinationMeaning, sourceMeaning, meaning].map(item => item.trim()).filter(Boolean))].join("\n\n");
        return updateKeywordMeaning(content, name, mergedMeaning);
      } }, ...references([current.target])], async () => {
        if (await app.vault.read(source) !== sourceContent) throw new Error("병합 중 원본 키워드가 변경되어 삭제하지 않았습니다.");
        await trashFileVerified(app, source);
      });
    } else {
      try {
        await app.fileManager.renameFile(source, nextPath);
        const renamed = app.vault.getAbstractFileByPath(nextPath);
        if (!(renamed instanceof TFile) || renamed !== source) throw new Error("키워드 이름을 바꾼 뒤 노트를 확인하지 못했습니다.");
        await applyFileChanges(app.vault, [
          { file: renamed, update: content => updateKeywordMeaning(content, name, meaning) }, ...references([]),
        ]);
      } catch (error) {
        try {
          if (source.path === nextPath) {
            if (app.vault.getAbstractFileByPath(current.filePath)) throw new Error("원래 경로에 다른 파일이 생겨 덮어쓰지 않았습니다.");
            await app.fileManager.renameFile(source, current.filePath);
          }
        } catch (recoveryError) {
          throw new AggregateError([error, recoveryError], "키워드 이름 변경을 복구하지 못했습니다. 원래 경로와 변경 경로를 확인하세요.");
        } finally {
          await this.host.index.rebuild();
        }
        throw error;
      }
    }
    await this.host.index.rebuild();
    new Notice(`${current.name} 키워드를 ${name}(으)로 변경했습니다.`);
  }

  async delete(entry: KeywordNoteEntry): Promise<void> {
    const { app } = this.host;
    const file = app.vault.getAbstractFileByPath(entry.filePath);
    if (!(file instanceof TFile)) throw new Error("삭제할 키워드 노트를 찾지 못했습니다.");
    const writes = this.referenceChanges([entry.target], (references, spellings) => removeKeywordReferences(references, spellings), [entry.target]);
    await applyFileChanges(app.vault, writes, () => trashFileVerified(app, file));
    await this.host.index.rebuild();
    new Notice(`${entry.name} 키워드를 삭제하고 연결된 문제를 갱신했습니다.`);
  }

  /** Questions linking to the targets. `removed` are notes about to be trashed; see `refersTo`. */
  questionsUsing(targets: readonly string[], removed: readonly string[] = targets): RegisteredQuestion[] {
    return this.host.index.registered.filter((question) =>
      [...question.coreKeywords, ...question.subKeywords]
        .some((reference) => this.refersTo(reference, question.filePath, targets, removed)),
    );
  }

  /**
   * Whether a keyword link points at one of the targets. A link that spells a
   * target's path always does. A link in another form — Obsidian writes the
   * vault's link format after a rename, by default the shortest unique form
   * such as [[A2]] — is resolved, but only against `removed`: those links
   * would break when the note is trashed. Links to a note that stays already
   * open it and are left as written.
   */
  private refersTo(reference: KeywordReference, sourcePath: string, targets: readonly string[], removed: readonly string[]): boolean {
    if (keywordReferenceMatches(reference, targets)) return true;
    const linkpath = reference.target.split("#")[0] ?? "";
    // A link opens only a note with its file name, so most links need no lookup.
    const candidates = removed.filter((target) => fileNameKey(target) === fileNameKey(linkpath));
    if (!linkpath || !candidates.length) return false;
    const file = this.host.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
    return file !== null && keywordReferenceMatches({ ...reference, target: file.path }, candidates);
  }

  /** The targets plus every other spelling in `references` that points at one of them. */
  private spellingsOf(references: readonly KeywordReference[], sourcePath: string, targets: readonly string[], removed: readonly string[]): string[] {
    const aliases = references
      .filter((reference) => !keywordReferenceMatches(reference, targets) && this.refersTo(reference, sourcePath, targets, removed))
      .map((reference) => reference.target);
    return [...targets, ...aliases];
  }

  private referenceChanges(
    targets: readonly string[],
    transform: (references: readonly KeywordReference[], spellings: readonly string[]) => KeywordReference[],
    removed: readonly string[],
  ): FileChange[] {
    const byFile = new Map<string, RegisteredQuestion[]>();
    for (const question of this.questionsUsing(targets, removed)) {
      const questions = byFile.get(question.filePath) ?? [];
      questions.push(question);
      byFile.set(question.filePath, questions);
    }
    const writes: FileChange[] = [];
    for (const [filePath, questions] of byFile) {
      const file = this.host.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) throw new Error(`${filePath} 문제 파일을 찾지 못했습니다.`);
      writes.push({ file, update: (content) => {
        let updated = content;
        for (const original of questions) {
          const current = findCurrentQuestion(parseQuestionFile(filePath, updated).questions, original);
          if (!current) throw new Error("키워드가 연결된 문제를 최신 원문에서 찾지 못했습니다.");
          const followUpLinks = followUpLinksIn(updated, current);
          const coreKeywords = transform(current.coreKeywords, this.spellingsOf(current.coreKeywords, filePath, targets, removed));
          const subKeywords = transform(current.subKeywords, this.spellingsOf(current.subKeywords, filePath, targets, removed))
            .filter((reference) => !keywordReferenceMatches(reference, coreKeywords.map((keyword) => keyword.target)));
          updated = updateQuestionMetadata(updated, current, {
            questionType: current.questionType,
            coreKeywords,
            subKeywords,
            ...(followUpLinks ? { followUpLinks } : {}),
            createdAt: current.createdAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
        return updated;
      } });
    }
    return writes;
  }
}
