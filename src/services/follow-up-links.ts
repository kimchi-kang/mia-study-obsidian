import { TFile } from "obsidian";
import { questionBlockLink } from "../core/follow-up";
import type { QuestionRecord } from "../core/models";
import { parseQuestionFile } from "../core/question-parser";
import { findCurrentQuestion, updateQuestionMetadata } from "../core/question-writer";
import { applyFileChanges, type FileChange } from "./file-change-batch";
import type { MiaHost } from "./mia-host";

type RegisteredQuestion = QuestionRecord & { id: string };

/** Follow-up links between questions, stored as block links in question metadata. */
export class FollowUpLinks {
  constructor(private readonly host: MiaHost) {}

  /** New link lists for questions that point at any of the removed questions. */
  removedChanges(removedIds: readonly string[]): Map<string, string[]> {
    const removed = new Set(removedIds);
    const changes = new Map<string, string[]>();
    for (const question of this.host.index.registered) {
      if (removed.has(question.id) || !question.followUpIds.some((id) => removed.has(id))) continue;
      changes.set(question.id, question.followUpIds.filter((id) => !removed.has(id)));
    }
    return changes;
  }

  /** Rewrites links that point at the targets, after they moved or changed heading. */
  async refreshIncoming(targetIds: readonly string[]): Promise<void> {
    const targets = new Set(targetIds);
    const changes = new Map<string, string[]>();
    for (const question of this.host.index.registered) {
      if (question.followUpIds.some((id) => targets.has(id))) changes.set(question.id, question.followUpIds);
    }
    if (changes.size) await this.apply(changes);
  }

  fileChanges(
    changes: ReadonlyMap<string, readonly string[]>,
    expected?: ReadonlyMap<string, RegisteredQuestion>,
  ): FileChange[] {
    const { app, index } = this.host;
    const snapshot = new Map(index.registered.map((question) => [question.id, question]));
    const baselines = expected ?? snapshot;
    const byFile = new Map<string, string[]>();
    for (const id of changes.keys()) {
      const question = snapshot.get(id);
      if (!question || !baselines.has(id)) throw new Error("연결을 편집할 질문이 변경 또는 삭제되었습니다. 최신 화면을 다시 열어 주세요.");
      for (const targetId of changes.get(id) ?? []) {
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
          const links = (changes.get(id) ?? [])
            .map((targetId) => snapshot.get(targetId) ?? index.questionById(targetId))
            .filter((target): target is RegisteredQuestion => Boolean(target))
            .map(questionBlockLink);
          updated = updateQuestionMetadata(updated, current, {
            questionType: current.questionType,
            coreKeywords: current.coreKeywords,
            subKeywords: current.subKeywords,
            followUpLinks: links,
            createdAt: current.createdAt ?? updatedAt,
            updatedAt,
          });
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
    const writes = this.fileChanges(changes, expected);
    await applyFileChanges(this.host.app.vault, writes);
    for (const { file } of writes) await this.host.index.refreshFile(file);
  }
}
