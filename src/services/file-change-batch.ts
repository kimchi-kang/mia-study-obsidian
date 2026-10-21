import type { TFile, Vault } from "obsidian";

export interface FileChange {
  file: TFile;
  update(content: string): string;
}

/** Compensate completed writes only while their contents still belong to this operation. */
export async function applyFileChanges(
  vault: Pick<Vault, "read" | "process">,
  changes: readonly FileChange[],
  finish?: () => Promise<void>,
): Promise<void> {
  const written: Array<{ file: TFile; before: string; after: string }> = [];
  try {
    for (const change of changes) {
      let expected: string | undefined;
      await vault.process(change.file, content => {
        const after = change.update(content);
        expected = after;
        if (after !== content) written.push({ file: change.file, before: content, after });
        return after;
      });
      if (expected === undefined || await vault.read(change.file) !== expected) {
        throw new Error(`${change.file.path}: 파일 저장 결과를 확인하지 못했습니다.`);
      }
    }
    await finish?.();
  } catch (error) {
    const recoveryErrors: unknown[] = [];
    for (const change of written.reverse()) {
      try {
        if (await vault.read(change.file) === change.before) continue;
        await vault.process(change.file, content => {
          if (content === change.before) return content;
          if (content !== change.after) throw new Error(`${change.file.path}: 다른 작업에서 변경되어 덮어쓰지 않았습니다.`);
          return change.before;
        });
        if (await vault.read(change.file) !== change.before) throw new Error(`${change.file.path}: 복구 결과를 확인하지 못했습니다.`);
      } catch (recoveryError) {
        try {
          if (await vault.read(change.file) === change.before) continue;
        } catch (readError) {
          recoveryErrors.push(readError);
        }
        recoveryErrors.push(recoveryError);
      }
    }
    if (recoveryErrors.length) {
      throw new AggregateError([error, ...recoveryErrors], `일부 파일을 복구하지 못했습니다. 변경한 파일을 확인하세요: ${written.map(change => change.file.path).join(", ")}`);
    }
    throw error;
  }
}
