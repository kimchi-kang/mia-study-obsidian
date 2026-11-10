import { Notice, TFile, TFolder, normalizePath } from "obsidian";
import {
  assertMergeableKeywordNote,
  createKeywordNote,
  readKeywordMeaning,
  updateKeywordMeaning,
  validateKeywordMeaning,
  validateKeywordName,
} from "../core/keyword-note";
import { keywordLinkPath, keywordNotePath } from "../core/keyword-path";
import { keywordReferenceMatches, keywordTargetMatcher, removeKeywordReferences, renameKeywordReferences } from "../core/keyword-reference";
import { followUpLinksIn } from "../core/managed-question";
import { assertSingleLine } from "../core/markdown-structure";
import type { KeywordReference, QuestionRecord } from "../core/models";
import { parseQuestionFile } from "../core/question-parser";
import { findCurrentQuestion, updateQuestionMetadata } from "../core/question-writer";
import { isManagedSubjectNote } from "../core/subject-note";
import { applyFileChanges, type FileChange } from "./file-change-batch";
import type { MiaHost } from "./mia-host";
import { assertPortablePath, ensureFolder, trashFileVerified } from "./vault-files";

export interface KeywordNoteEntry {
  name: string;
  target: string;
  filePath: string;
}

type RegisteredQuestion = QuestionRecord & { id: string };

function assertKeywordNoteEditable(filePath: string, content: string, operation: string): void {
  if (isManagedSubjectNote(content)) {
    throw new Error(`자동 생성 과목 노트에 대한 ${operation} 작업을 중단했습니다. 별도의 키워드 노트를 사용하세요.`);
  }
  if (parseQuestionFile(filePath, content).questions.length > 0) {
    throw new Error(`문제은행에 대한 ${operation} 작업을 중단했습니다. 별도의 키워드 노트를 사용하세요.`);
  }
}

function updateExistingKeywordMeaning(filePath: string, content: string, name: string, meaning: string): string {
  assertKeywordNoteEditable(filePath, content, "키워드 뜻 저장");
  return updateKeywordMeaning(content, name, meaning);
}

/** A link or path's file name without folder, heading or extension, lower-cased. */
function fileName(path: string): string {
  const hash = path.indexOf("#");
  const end = hash < 0 ? path.length : hash;
  const name = path.slice(Math.max(path.lastIndexOf("/", end - 1), path.lastIndexOf("\\", end - 1)) + 1, end).trim().toLowerCase();
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

/** Which notes a keyword operation removes, and which note its links move to. */
interface ReferenceScope {
  /** Notes this operation trashes; their links in any form must be updated. */
  removed: readonly string[];
  /** The note a merge moves links to; also unified within the questions it touches. */
  merged?: readonly string[];
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
      const file = this.resolveReferenceFile(keyword.target, question.filePath);
      output.set(keyword.target, file?.extension === "md" ? readKeywordMeaning(await app.vault.cachedRead(file)) : "");
    }
    return output;
  }

  private resolveReferenceFile(target: string, sourcePath: string): TFile | null {
    return this.host.app.metadataCache.getFirstLinkpathDest(keywordLinkPath(target), sourcePath);
  }

  referenceMeaningDestination(target: string, label: string, sourcePath: string): TFile | string {
    assertSingleLine(target, "키워드 경로");
    assertSingleLine(label, "키워드 이름");
    const file = this.resolveReferenceFile(target, sourcePath);
    if (file && file.extension !== "md") {
      throw new Error("키워드 뜻은 마크다운(.md) 노트에만 저장할 수 있습니다. 연결할 노트를 바꿔 주세요.");
    }
    return file ?? keywordNotePath(target, label, this.host.store.settings.keywordFolder);
  }

  async saveReferenceMeaning(target: string, label: string, meaning: string, sourcePath: string, preserveExistingWhenEmpty = false): Promise<void> {
    const { app } = this.host;
    validateKeywordMeaning(meaning);
    const destination = this.referenceMeaningDestination(target, label, sourcePath);
    const path = typeof destination === "string" ? destination : destination.path;
    if (typeof destination === "string") {
      assertPortablePath(app, path);
      const folder = path.split("/").slice(0, -1).join("/");
      if (folder) await ensureFolder(app, folder);
    }
    const existing = typeof destination === "string" ? app.vault.getAbstractFileByPath(path) : destination;
    if (existing instanceof TFolder) throw new Error("키워드 노트 경로가 폴더와 겹칩니다.");
    if (existing instanceof TFile) {
      if (preserveExistingWhenEmpty && !meaning.trim()) return;
      await app.vault.process(existing, (content) => updateExistingKeywordMeaning(existing.path, content, label, meaning));
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
      await app.vault.process(existing, (content) => updateExistingKeywordMeaning(existing.path, content, safeName, meaning));
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
      await app.vault.process(file, content => updateExistingKeywordMeaning(file.path, content, name, meaning));
      new Notice(`${name} 키워드를 저장했습니다.`);
      return;
    }
    const source = app.vault.getAbstractFileByPath(current.filePath);
    if (!(source instanceof TFile)) throw new Error("기존 키워드 노트를 찾지 못했습니다.");
    const nextPath = keywordNotePath(name, name, this.host.store.settings.keywordFolder);
    assertPortablePath(app, nextPath);
    const destination = app.vault.getAbstractFileByPath(nextPath);
    if (destination instanceof TFolder) throw new Error("변경할 키워드 경로가 폴더와 겹칩니다.");
    const sourceContent = await app.vault.read(source);
    assertKeywordNoteEditable(source.path, sourceContent, destination instanceof TFile ? "키워드 병합" : "키워드 이름 변경");
    const nextTarget = nextPath.replace(/\.md$/i, "");
    // Only a merge removes the source note. A rename keeps it, and Obsidian has
    // already pointed short links at its new path in the vault's link format.
    const references = (scope: ReferenceScope) => this.referenceChanges(
      [current.target, nextTarget],
      (items, spellings) => renameKeywordReferences(items, spellings, nextTarget, name),
      scope,
    );
    if (destination instanceof TFile) {
      assertMergeableKeywordNote(sourceContent);
      const sourceMeaning = readKeywordMeaning(sourceContent);
      await applyFileChanges(app.vault, [{ file: destination, update: content => {
        const destinationMeaning = readKeywordMeaning(content);
        const mergedMeaning = [...new Set([destinationMeaning, sourceMeaning, meaning].map(item => item.trim()).filter(Boolean))].join("\n\n");
        return updateExistingKeywordMeaning(destination.path, content, name, mergedMeaning);
      } }, ...references({ removed: [current.target], merged: [nextTarget] })], async () => {
        if (await app.vault.read(source) !== sourceContent) throw new Error("병합 중 원본 키워드가 변경되어 삭제하지 않았습니다.");
        await trashFileVerified(app, source);
      });
    } else {
      try {
        await app.fileManager.renameFile(source, nextPath);
        const renamed = app.vault.getAbstractFileByPath(nextPath);
        if (!(renamed instanceof TFile) || renamed !== source) throw new Error("키워드 이름을 바꾼 뒤 노트를 확인하지 못했습니다.");
        await applyFileChanges(app.vault, [
          { file: renamed, update: content => updateExistingKeywordMeaning(renamed.path, content, name, meaning) }, ...references({ removed: [] }),
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
    assertKeywordNoteEditable(file.path, await app.vault.read(file), "키워드 삭제");
    const writes = this.referenceChanges([entry.target], (references, spellings) => removeKeywordReferences(references, spellings), { removed: [entry.target] });
    await applyFileChanges(app.vault, writes, async () => {
      assertKeywordNoteEditable(file.path, await app.vault.read(file), "키워드 삭제");
      await trashFileVerified(app, file);
    });
    await this.host.index.rebuild();
    new Notice(`${entry.name} 키워드를 삭제하고 연결된 문제를 갱신했습니다.`);
  }

  /** Questions linking to the targets. `removed` are notes about to be trashed; see `linkMatcher`. */
  questionsUsing(targets: readonly string[], removed: readonly string[] = targets): RegisteredQuestion[] {
    const matches = this.linkMatcher(targets, removed);
    return this.host.index.registered.filter((question) =>
      [...question.coreKeywords, ...question.subKeywords].some((reference) => matches(reference, question.filePath)),
    );
  }

  /**
   * Decides whether keyword links point at the targets. A link that spells a
   * target's path always does. A link in another form — after a rename
   * Obsidian writes the vault's link format, by default the shortest unique
   * form such as [[A2]] — is resolved to the note it opens, but only against
   * `resolvable`. Links to notes outside it already open them and are left as
   * written. Built once per operation; a link costs one name comparison unless
   * it carries a resolvable note's file name.
   */
  private linkMatcher(targets: readonly string[], resolvable: readonly string[]): (reference: KeywordReference, sourcePath: string) => boolean {
    const spelled = keywordTargetMatcher(targets);
    const names = new Set(resolvable.flatMap((target) => [fileName(target).normalize("NFC"), fileName(target).normalize("NFD")]));
    return (reference, sourcePath) => {
      if (spelled(reference)) return true;
      if (!names.has(fileName(reference.target))) return false;
      // Obsidian compares link text to file names exactly, so a link typed in the
      // other Unicode form (decomposed Hangul from macOS) opens nothing though it
      // reads the same. It still names this note: try both forms so the link is
      // updated with the note instead of being left behind.
      const linkpath = reference.target.split("#")[0] ?? "";
      return [...new Set([linkpath, linkpath.normalize("NFC"), linkpath.normalize("NFD")])].some((form) => {
        const file = this.host.app.metadataCache.getFirstLinkpathDest(form, sourcePath);
        return file !== null && keywordReferenceMatches({ ...reference, target: file.path }, resolvable);
      });
    };
  }

  private referenceChanges(
    targets: readonly string[],
    transform: (references: readonly KeywordReference[], spellings: readonly string[]) => KeywordReference[],
    { removed, merged = [] }: ReferenceScope,
  ): FileChange[] {
    const spelled = keywordTargetMatcher(targets);
    const matchesRemoved = this.linkMatcher(removed, removed);
    const matchesTargets = this.linkMatcher(targets, removed);
    // A merged question may already hold a short link to the destination; resolve
    // it too so both collapse into one link. Other questions keep theirs as written.
    const matchesMerged = merged.length ? this.linkMatcher(targets, [...removed, ...merged]) : matchesTargets;
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
          const matches = [...current.coreKeywords, ...current.subKeywords].some((reference) => matchesRemoved(reference, filePath))
            ? matchesMerged : matchesTargets;
          const spellingsOf = (references: readonly KeywordReference[]): string[] => [...targets, ...references
            .filter((reference) => !spelled(reference) && matches(reference, filePath))
            .map((reference) => reference.target)];
          const coreKeywords = transform(current.coreKeywords, spellingsOf(current.coreKeywords));
          const subKeywords = transform(current.subKeywords, spellingsOf(current.subKeywords))
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
