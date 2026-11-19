import { TFile } from "obsidian";
import { followUpBlockLinks, questionBlockLink } from "../core/follow-up";
import type { QuestionRecord } from "../core/models";
import { parseQuestionFile } from "../core/question-parser";
import { findCurrentQuestion, updateQuestionMetadata } from "../core/question-writer";
import { applyFileChanges, validateFileChanges, type FileChange } from "./file-change-batch";
import type { MiaHost } from "./mia-host";

type RegisteredQuestion = QuestionRecord & { id: string };

/** Keep the original spelling of every link outside the automatic operation. */
function rewriteFollowUpLines(
  content: string,
  start: number | null,
  replacements: ReadonlyMap<string, string | null>,
): string {
  if (start === null) return content;
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(newline);
  for (let index = start + 1; lines[index]?.startsWith(">"); index += 1) {
    const line = lines[index]!;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(1, separator).replaceAll("*", "").trim();
    if (key !== "이어보기" && key !== "이어볼 질문") continue;
    let value = line.slice(separator + 1);
    let shift = 0;
    for (const { id, raw, offset } of [...followUpBlockLinks(value)]) {
      const replacement = replacements.get(id);
      if (replacement === undefined) continue;
      const position = offset + shift;
      let before = value.slice(0, position);
      let after = value.slice(position + raw.length);
      if (replacement === null) {
        if (/^\s*,\s*/u.test(after)) after = after.replace(/^\s*,\s*/u, "");
        else before = before.replace(/\s*,\s*$/u, "");
      }
      const next = before + (replacement ?? "") + after;
      shift += next.length - value.length;
      value = next;
    }
    if (value === line.slice(separator + 1)) continue;
    if (value.trim()) lines[index] = line.slice(0, separator + 1) + value;
    else {
      lines.splice(index, 1);
      index -= 1;
    }
  }
  return lines.join(newline);
}

/** Follow-up links between questions, stored as block links in question metadata. */
export class FollowUpLinks {
  constructor(private readonly host: MiaHost) {}

  removalFileChanges(removedIds: readonly string[]): FileChange[] {
    return this.automaticFileChanges(new Map(removedIds.map(id => [id, null])), new Set(removedIds));
  }

  async validateIncoming(targetIds: readonly string[]): Promise<void> {
    await validateFileChanges(this.host.app.vault, this.incomingFileChanges(targetIds));
  }

  /** Rewrites links that point at the targets, after they moved or changed heading. */
  async refreshIncoming(targetIds: readonly string[]): Promise<void> {
    await this.applyWrites(this.incomingFileChanges(targetIds));
  }

  private incomingFileChanges(targetIds: readonly string[]): FileChange[] {
    const replacements = new Map<string, string>();
    for (const id of targetIds) {
      const target = this.host.index.questionById(id);
      if (target) replacements.set(id, questionBlockLink(target));
    }
    return this.automaticFileChanges(replacements);
  }

  private automaticFileChanges(replacements: ReadonlyMap<string, string | null>, excluded = new Set<string>()): FileChange[] {
    const changes = new Map<string, string[]>();
    for (const question of this.host.index.registered) {
      if (!excluded.has(question.id) && question.followUpIds.some(id => replacements.has(id))) {
        changes.set(question.id, question.followUpIds);
      }
    }
    return this.fileChanges(changes, undefined, replacements);
  }

  fileChanges(
    changes: ReadonlyMap<string, readonly string[]>,
    expected?: ReadonlyMap<string, RegisteredQuestion>,
    automatic?: ReadonlyMap<string, string | null>,
  ): FileChange[] {
    const { app } = this.host;
    const snapshot = new Map(this.host.index.registered.map((question) => [question.id, question]));
    const baselines = expected ?? snapshot;
    const byFile = new Map<string, string[]>();
    for (const id of changes.keys()) {
      const question = snapshot.get(id);
      if (!question || !baselines.has(id)) throw new Error("연결을 편집할 질문이 변경 또는 삭제되었습니다. 최신 화면을 다시 열어 주세요.");
      for (const targetId of automatic ? [] : changes.get(id) ?? []) {
        if (!snapshot.has(targetId)) throw new Error("연결할 질문이 변경 또는 삭제되었습니다. 최신 목록을 다시 확인하세요.");
      }
      const ids = byFile.get(question.filePath) ?? [];
      ids.push(id);
      byFile.set(question.filePath, ids);
    }
    const updatedAt = new Date().toISOString();
    const writes: FileChange[] = [];
    for (const [filePath, ids] of byFile) {
      const file = app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) throw new Error(`${filePath} 문제 파일을 찾지 못했습니다.`);
      writes.push({ file, update: (content) => {
        let updated = content;
        for (const id of ids) {
          const original = snapshot.get(id);
          if (!original) continue;
          const current = findCurrentQuestion(parseQuestionFile(filePath, updated).questions, original);
          if (!current) throw new Error(`연결을 수정할 질문을 찾지 못했습니다: ${original.heading}`);
          const baseline = baselines.get(id);
          if (!baseline || JSON.stringify(current.followUpIds) !== JSON.stringify(baseline.followUpIds)) {
            throw new Error("질문 연결이 다른 작업에서 변경되었습니다. 최신 화면을 다시 열어 주세요.");
          }
          const metadata = {
            questionType: current.questionType,
            coreKeywords: current.coreKeywords,
            subKeywords: current.subKeywords,
            createdAt: current.createdAt ?? updatedAt,
            updatedAt,
          };
          if (automatic) {
            const rewritten = updateQuestionMetadata(updated, current, metadata);
            updated = rewriteFollowUpLines(rewritten, current.location.metadataStartLine, automatic);
          } else {
            const links = (changes.get(id) ?? []).map(targetId => questionBlockLink(snapshot.get(targetId)!));
            updated = updateQuestionMetadata(updated, current, { ...metadata, followUpLinks: links });
          }
        }
        return updated;
      } });
    }
    return writes;
  }

  async apply(
    changes: ReadonlyMap<string, readonly string[]>,
    expected?: ReadonlyMap<string, RegisteredQuestion>,
  ): Promise<void> {
    await this.applyWrites(this.fileChanges(changes, expected));
  }

  private async applyWrites(writes: readonly FileChange[]): Promise<void> {
    await applyFileChanges(this.host.app.vault, writes);
    for (const { file } of writes) await this.host.index.refreshFile(file);
  }
}
