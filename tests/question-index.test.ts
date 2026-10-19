import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionIndex, QuestionIndexInternals } from "../src/services/question-index";
import type { App, TAbstractFile, TFile } from "obsidian";
import type { QuestionRecord } from "../src/core/models";

function question(id: string, filePath: string): QuestionRecord {
  return {
    id,
    filePath,
    heading: filePath,
    headingLevel: 3,
    questionMarkdown: "질문",
    answerMarkdown: "정답",
    subject: "전자기학",
    deck: "더미",
    questionType: "정의형",
    coreKeywords: [],
    subKeywords: [],
    followUpIds: [],
    location: {
      headingLine: 0,
      questionStartLine: 1,
      questionEndLine: 2,
      answerHeadingLine: 3,
      answerEndLine: 4,
      metadataStartLine: null,
      metadataEndLine: null,
      anchorLine: 2,
    },
  };
}

describe("source root filtering", () => {
  it("matches exact roots and descendants only", () => {
    expect(QuestionIndexInternals.inSourceRoots("전자기학/a.md", ["전자기학"])).toBe(true);
    expect(QuestionIndexInternals.inSourceRoots("전자기학.md", ["전자기학"])).toBe(false);
    expect(QuestionIndexInternals.inSourceRoots("회로/a.md", ["전자기학"])).toBe(false);
    expect(QuestionIndexInternals.inSourceRoots("anything.md", [])).toBe(true);
  });

  it("uses the first folder below a configured root as the subject", () => {
    expect(QuestionIndexInternals.subjectForPath("전공면접대비/전자기학/문제은행.md", ["전공면접대비"]))
      .toBe("전자기학");
    expect(QuestionIndexInternals.subjectForPath("전공면접대비/직접문제.md", ["전공면접대비"]))
      .toBe("미분류");
    expect(QuestionIndexInternals.subjectForPath("전자기학/문제.md", [])).toBeUndefined();
  });
});

describe("duplicate IDs", () => {
  it("excludes every ambiguous question instead of sharing one review state", () => {
    const unique = question("mia-q-unique", "unique.md");
    const duplicateA = question("mia-q-duplicate", "a.md");
    const duplicateB = question("mia-q-duplicate", "b.md");
    expect(QuestionIndexInternals.uniqueRegisteredQuestions([unique, duplicateA, duplicateB]))
      .toEqual([unique]);
  });
});


function indexHarness() {
  const events = new Map<string, (file: TAbstractFile, oldPath?: string) => void>();
  const files: TFile[] = [];
  const reads: Array<(text: string) => void> = [];
  const app = { vault: {
    getMarkdownFiles: () => [...files],
    cachedRead: () => new Promise<string>(resolve => reads.push(resolve)),
    on: (name: string, callback: (file: TAbstractFile, oldPath?: string) => void) => { events.set(name, callback); return { name }; },
    offref: () => {},
  } };
  return { index: new QuestionIndex(app as unknown as App, () => []), files, reads, events };
}
const bank = (title: string) => `### ${title}\n\n> [!question] 문제\n> 질문\n\n^mia-q-test\n\n#### 정답\n\n정답`;
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("index asynchronous updates", () => {
  it("keeps the newer file content when an older read finishes last", async () => {
    const { index, reads } = indexHarness(); const file = { path: "a.md", extension: "md" } as TFile;
    const old = index.refreshFile(file), latest = index.refreshFile(file);
    reads[1]!(bank("최신")); await latest;
    reads[0]!(bank("이전")); await old;
    expect(index.registered[0]?.heading).toBe("최신");
  });
  it("does not resurrect a deleted note from an in-flight read", async () => {
    const { index, reads, events } = indexHarness(); await index.start();
    const file = { path: "a.md", extension: "md" } as TFile;
    const pending = index.refreshFile(file); events.get("delete")!(file);
    reads[0]!(bank("삭제됨")); await pending;
    expect(index.registered).toEqual([]); index.stop();
  });
  it("does not reinsert a renamed file under its old path", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const { index, reads, events } = indexHarness(); await index.start();
    const file = { path: "a.md", extension: "md" } as TFile;
    const pending = index.refreshFile(file); file.path = "b.md"; events.get("rename")!(file, "a.md");
    reads[0]!(bank("이동됨")); await pending;
    expect(index.questionsInFile("a.md")).toEqual([]); expect(index.questionsInFile("b.md")).toEqual([]); index.stop();
  });
  it("preserves a file refreshed during a full rebuild", async () => {
    const { index, files, reads } = indexHarness(); const file = { path: "a.md", extension: "md" } as TFile;
    files.push(file); const rebuild = index.rebuild(), refresh = index.refreshFile(file);
    reads[1]!(bank("최신")); await refresh; reads[0]!(bank("이전")); await rebuild;
    expect(index.registered[0]?.heading).toBe("최신");
  });
  it("keeps the newest full rebuild when earlier work completes later", async () => {
    const { index, files, reads } = indexHarness();
    const file = { path: "a.md", extension: "md" } as TFile;
    files.push(file);
    const refresh = index.refreshFile(file), old = index.rebuild(), latest = index.rebuild();
    reads[2]!(bank("최신")); await latest;
    reads[1]!(bank("이전")); await old; reads[0]!(bank("가장 이전")); await refresh;
    expect(index.registered[0]?.heading).toBe("최신");
  });
  it("reindexes descendants after a folder rename without requiring child rename events", async () => {
    vi.useFakeTimers(); vi.stubGlobal("window", { setTimeout, clearTimeout });
    const { index, files, reads, events } = indexHarness(); await index.start();
    const file = { path: "이전/a.md", extension: "md" } as TFile;
    const pending = index.refreshFile(file); reads[0]!(bank("문제")); await pending;
    file.path = "새과목/a.md"; files.push(file); events.get("rename")!({ path: "새과목" } as TAbstractFile, "이전");
    expect(index.registered).toEqual([]);
    await vi.advanceTimersByTimeAsync(150); reads[1]!(bank("문제"));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(index.registered[0]?.filePath).toBe("새과목/a.md"); index.stop();
  });
  it("ignores reads completing after the index has stopped", async () => {
    const { index, reads } = indexHarness();
    const pending = index.refreshFile({ path: "a.md", extension: "md" } as TFile);
    index.stop(); reads[0]!(bank("닫힘")); await pending;
    expect(index.registered).toEqual([]);
  });
  it("removes indexed descendants when a folder is deleted", async () => {
    const { index, reads, events } = indexHarness(); await index.start();
    const pending = index.refreshFile({ path: "과목/a.md", extension: "md" } as TFile);
    reads[0]!(bank("삭제됨")); await pending; events.get("delete")!({ path: "과목" } as TAbstractFile);
    expect(index.registered).toEqual([]); index.stop();
  });
});
