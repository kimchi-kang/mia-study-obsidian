import { createHash } from "node:crypto";
import JSZip from "jszip";
import { mkdir, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Rating, State } from "ts-fsrs";
import { DEFAULT_SETTINGS } from "../src/core/models";
import { FsrsService } from "../src/core/fsrs-service";
import { isWeakForExport, prepareSubjectExport } from "../src/core/export-priority";
import { exportSubjectWord, subjectExportFilename } from "../src/services/subject-word-export";

vi.mock("obsidian", () => ({
  Platform: { isDesktopApp: false }, TFile: class {}, TFolder: class {}, normalizePath: (path) => path,
}));
import { renderManagedQuestion } from "../src/core/managed-question";
import { parseQuestionFile } from "../src/core/question-parser";
import { exportSubjectDocx } from "../src/core/subject-export";

const subject = "지리학";
function question(key, prompt, answer, file = "노트 1", line = 0, topic = subject) {
  const id = `mia-q-${key}`;
  const parsed = parseQuestionFile(`MIA/${topic}/${file}.md`, renderManagedQuestion({
    questionMarkdown: prompt, answerMarkdown: answer, questionType: "정의형", coreKeywords: [], subKeywords: [],
  }, id), { subject: topic }).questions[0];
  return { ...parsed, id, location: { ...parsed.location, headingLine: line } };
}

const baselineQuestions = [
  question("delta", "삼각주란?", "하천 퇴적물이 쌓여 형성된 지형이다.", "노트 10"),
  question("island", "섬이란?", "물로 둘러싸인 땅이다.", "노트 2", 8),
  question("coast", "해안이란?", "육지와 바다가 만나는 곳이다.", "노트 2", 2),
  question("other", "중앙값이란?", "자료를 순서대로 놓았을 때 가운데 값이다.", "노트 2", 0, "통계이론"),
];

async function documentXml(data) {
  const zip = await JSZip.loadAsync(data);
  return zip.file("word/document.xml").async("string");
}

it("keeps the original document XML byte-for-byte", async () => {
  const host = exportHost(baselineQuestions, {});
  const receipt = await exportSubjectWord(host, subject, { scope: "all", order: "note" });
  const [, buffer] = host.app.vault.createBinary.mock.calls[0];
  expect(receipt.count).toBe(3);
  // Captured from the pre-change renderer using the same input.
  expect(createHash("sha256").update(await documentXml(buffer)).digest("hex"))
    .toBe("f6fa523e88d7f4262639e69865d832cf2e2f379db045d42aac42b53bf25bf799");
  expect(await documentXml((await exportSubjectDocx(subject, baselineQuestions)).data))
    .toBe(await documentXml(buffer));
});

const now = new Date(2026, 10, 19, 14, 30);
const fsrs = new FsrsService(DEFAULT_SETTINGS);
const future = new Date(now.getTime() + 1);
const past = new Date(now.getTime() - 1);

function review(rating, due = future, lapses = 0, lastReview = new Date(2026, 10, 13, 14, 30)) {
  const state = fsrs.rate(undefined, rating, lastReview);
  return { ...state, card: { ...state.card, state: State.Review, due: due.toISOString(), scheduled_days: 0, lapses } };
}

function exportHost(questions, reviews) {
  return {
    fsrs, store: { reviews }, index: { registered: questions, rebuild: vi.fn(async () => {}) },
    app: { vault: {
      getRoot: () => ({ children: [] }), getAbstractFileByPath: () => null,
      createFolder: vi.fn(async () => {}), createBinary: vi.fn(async () => {}),
    } },
  };
}

afterEach(() => vi.useRealTimers());

it("classifies new, due, low-rated and leech questions using the FSRS due boundary", () => {
  expect(isWeakForExport(undefined, fsrs, now)).toBe(true);
  expect(isWeakForExport(fsrs.createState(now), fsrs, now)).toBe(true);
  for (const rating of [Rating.Good, Rating.Easy]) {
    expect(isWeakForExport(review(rating, future), fsrs, now)).toBe(false);
    expect(isWeakForExport(review(rating, now), fsrs, now)).toBe(true);
    expect(isWeakForExport(review(rating, past), fsrs, now)).toBe(true);
  }
  for (const rating of [Rating.Again, Rating.Hard]) {
    expect(isWeakForExport(review(rating, future), fsrs, now)).toBe(true);
  }
  expect(isWeakForExport(review(Rating.Good, future, 7), fsrs, now)).toBe(false);
  expect(isWeakForExport(review(Rating.Good, future, 8), fsrs, now)).toBe(true);
  const interday = review(Rating.Good, new Date(2026, 10, 19, 22));
  interday.card.scheduled_days = 1;
  expect(isWeakForExport(interday, fsrs, now)).toBe(true);
});

it("sorts by the strongest group, then lapses, recall and numeric note order without mutating input", () => {
  const cases = [
    ["known", Rating.Easy, future, 0, .2, "노트 1", 1],
    ["new-late", null, null, 0, null, "노트 1", 8],
    ["leech-low", Rating.Again, past, 8, .05, "노트 1", 2],
    ["due", Rating.Good, past, 0, .01, "노트 1", 3],
    ["hard", Rating.Hard, past, 0, .05, "노트 1", 4],
    ["again-late", Rating.Again, past, 0, .5, "노트 10", 1],
    ["again-mid", Rating.Again, future, 0, .5, "노트 2", 5],
    ["again-early", Rating.Again, future, 0, .5, "노트 2", 2],
    ["again-low", Rating.Again, future, 0, .3, "노트 10", 3],
    ["leech-many", Rating.Good, future, 9, .9, "노트 10", 1],
    ["leech-high", Rating.Hard, future, 8, .8, "노트 1", 1],
    ["new-early", null, null, 0, null, "노트 1", 7],
    ["known-high", Rating.Good, future, 0, .95, "노트 1", 0],
  ];
  const reviews = {}, probabilities = new Map();
  const questions = cases.map(([key, rating, due, lapses, recall, file, line]) => {
    const item = question(key, key, "예시 답변", file, line);
    if (rating !== null) {
      const state = review(rating, due, lapses);
      reviews[item.id] = state;
      probabilities.set(state, recall);
    }
    return item;
  });
  const original = structuredClone(questions);
  const checks = {
    isNew: fsrs.isNew.bind(fsrs),
    isDue: vi.fn(fsrs.isDue.bind(fsrs)),
    retrievability: vi.fn((state) => probabilities.get(state) ?? null),
  };
  const result = prepareSubjectExport(questions, reviews, checks, { scope: "all", order: "weak" }, now);
  expect(result.questions.map(item => item.questionMarkdown)).toEqual([
    "leech-many", "leech-low", "leech-high", "again-low", "again-early", "again-mid",
    "again-late", "hard", "due", "new-early", "new-late", "known", "known-high",
  ]);
  expect(questions).toEqual(original);
  for (const check of [checks.isDue, checks.retrievability]) {
    expect(check).toHaveBeenCalledTimes(questions.length);
    expect(check.mock.calls.every(([, time]) => time === now)).toBe(true);
  }
});

const sampleQuestions = [
  question("coast", "해안이란?", "육지와 바다가 만나는 곳이다.", "노트 1", 1),
  question("island", "섬이란?", "물로 둘러싸인 땅이다.", "노트 1", 2),
  question("delta", "삼각주란?", "하천 퇴적물이 쌓여 형성된 지형이다.", "노트 1", 3),
  question("basin", "분지란?", "주변이 높은 지형으로 둘러싸인 낮은 곳이다.", "노트 2", 1),
  question("contour", "등고선이란?", "높이가 같은 지점을 연결한 선이다.", "노트 2", 2),
  question("cape", "곶이란?", "육지가 바다 쪽으로 돌출된 곳이다.", "노트 2", 3),
];
const sampleReviews = {
  "mia-q-coast": review(Rating.Easy),
  "mia-q-delta": review(Rating.Good, past),
  "mia-q-basin": review(Rating.Hard),
  "mia-q-contour": review(Rating.Again),
  "mia-q-cape": review(Rating.Again, future, 9),
};

it.each([
  { scope: "all", order: "note", title: "", orderOfQuestions: [0, 1, 2, 3, 4, 5], sample: true },
  { scope: "weak", order: "note", title: " (부족한 문제)", orderOfQuestions: [1, 2, 3, 4, 5], sample: false },
  { scope: "all", order: "weak", title: " (부족한 순서)", orderOfQuestions: [5, 4, 3, 2, 1, 0], sample: true },
  { scope: "weak", order: "weak", title: " (부족한 문제 · 부족한 순서)", orderOfQuestions: [5, 4, 3, 2, 1], sample: true },
])("renders the Word XML for $scope / $order", async ({ scope, order, title, orderOfQuestions, sample }) => {
  vi.setSystemTime(now);
  const host = exportHost(sampleQuestions, sampleReviews);
  const result = await exportSubjectWord(host, subject, { scope, order });
  const [path, buffer] = host.app.vault.createBinary.mock.calls[0];
  expect(path).toBe(`MIA 출력/${subjectExportFilename(subject, { scope, order }, now)}`);
  const xml = await documentXml(buffer);
  const texts = [...xml.matchAll(/<w:t(?: [^>]*)?>(.*?)<\/w:t>/gu)].map(match => match[1]);
  const expected = [`지리학 질문 답변 정리${title}`];
  if (title) expected.push(`출력 기준 2026-11-19 14:30 · ${scope === "weak" ? "부족한 문제 5개 / " : ""}전체 6개`);
  const status = [
    "마지막 평가 너무 쉬움", "학습 전", "복습할 차례 · 마지막 평가 암기", "마지막 평가 애매",
    "마지막 평가 못 암기", "자주 틀림 · 마지막 평가 못 암기 · 잊은 횟수 9회",
  ];
  for (const [index, position] of orderOfQuestions.entries()) {
    const item = sampleQuestions[position];
    expected.push(`질문 ${index + 1}`);
    if (title) {
      const recall = fsrs.retrievability(sampleReviews[item.id], now);
      expected.push(status[position] + (recall === null ? "" : ` · 기억 확률 ${Math.round(recall * 100)}%`));
    }
    expected.push(item.questionMarkdown, "답변", item.answerMarkdown);
  }
  expect(texts).toEqual(expected);
  expect(result.count).toBe(orderOfQuestions.length);
  if (sample && process.env.MIA_GENERATE_EXPORT_SAMPLES === "1") {
    const folder = ".claude/export-samples";
    await mkdir(folder, { recursive: true });
    await writeFile(`${folder}/${basename(path)}`, Buffer.from(buffer));
  }
});

it.each([
  ["all", "note", ""], ["weak", "note", " 부족한 문제"],
  ["all", "weak", " 부족한 순"], ["weak", "weak", " 부족한 문제 부족한 순"],
])("uses safe filenames for %s / %s", (scope, order, suffix) => {
  expect(subjectExportFilename('지리학/통계:이론?', { scope, order }, new Date("2026-11-19T05:30:00.000Z")))
    .toBe(`지리학_통계_이론_ 질문 답변${suffix} 2026-11-19T05-30-00-000Z.docx`);
});
