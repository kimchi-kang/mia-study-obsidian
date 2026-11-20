import { expect, it, vi } from "vitest";
import { Rating } from "ts-fsrs";
import { FsrsService } from "../src/core/fsrs-service";
import { groupKeywordQuestions, rankKeywordWeakness } from "../src/core/keyword-radar";
import { DEFAULT_SETTINGS, type QuestionRecord } from "../src/core/models";

function question(id: string, core: string[], sub: string[]): QuestionRecord & { id: string } {
  const link = (target: string) => ({ target, label: target, raw: target });
  return {
    id, heading: "표본을 어떻게 해석하는가?", filePath: "통계이론.md", headingLevel: 2,
    questionMarkdown: "질문", answerMarkdown: "답", subject: "통계이론", deck: "기초",
    questionType: "정의형", coreKeywords: core.map(link), subKeywords: sub.map(link), followUpIds: [],
    location: { headingLine: 0, questionStartLine: 1, questionEndLine: 2, answerHeadingLine: 3, answerEndLine: 4, metadataStartLine: null, metadataEndLine: null, anchorLine: null },
  };
}

it("groups aliases and duplicate links, aggregates latest weak ratings and lapses, and reuses each recall", () => {
  const questions = [
    question("one", ["키워드/표본.md#의미", "표본", "가중"], ["표본", "보조"]),
    question("two", [], ["키워드\\표본", "분포"]),
    question("fresh", ["표본", "학습 전"], []),
  ];
  const fsrs = new FsrsService(DEFAULT_SETTINGS);
  const now = new Date(2026, 10, 20, 4);
  const one = fsrs.rate(undefined, Rating.Again, new Date(2026, 10, 18, 4));
  const two = fsrs.rate(undefined, Rating.Hard, new Date(2026, 10, 19, 4));
  one.card.lapses = 2;
  two.card.lapses = 1;
  const first = fsrs.retrievability(one, now)!;
  const second = fsrs.retrievability(two, now)!;
  const recall = vi.spyOn(fsrs, "retrievability");
  const groups = groupKeywordQuestions(questions);
  const ranked = rankKeywordWeakness(groups, { one, two }, fsrs, new Map([["표본", "표본의 의미"]]), now);
  expect(recall).toHaveBeenCalledTimes(3);
  expect(ranked.map(item => item.key)).not.toContain("학습 전");
  const row = ranked.find(item => item.key === "표본")!;
  expect(row).toMatchObject({ label: "표본의 의미", total: 3, studied: 2, lapses: 3, again: 1, hard: 1, questionIds: ["one", "two", "fresh"] });
  expect(row.averageRecall).toBeCloseTo((first + second) / 2);
  expect(row.score).toBeCloseTo(((1 - first) * 1.2 + (1 - second)) / Math.sqrt(2.2) + .1 * Math.log1p(3));
  expect(ranked.find(item => item.key === "가중")!.score).toBeGreaterThan(ranked.find(item => item.key === "보조")!.score);
  expect(ranked.map(item => item.score)).toEqual([...ranked.map(item => item.score)].sort((a, b) => b - a));
});

it("breaks equal scores by display name and omits concepts with no evaluated problems", () => {
  const fsrs = new FsrsService(DEFAULT_SETTINGS);
  const now = new Date(2026, 10, 20, 4);
  const review = fsrs.rate(undefined, Rating.Good, new Date(2026, 10, 18, 4));
  const groups = groupKeywordQuestions([question("known", ["표본", "도수"], []), question("fresh", [], ["분포"])]);
  const names = new Map([["표본", "가나다"], ["도수", "나무"]]);
  expect(rankKeywordWeakness(groups, {}, fsrs, names, now)).toEqual([]);
  expect(rankKeywordWeakness(groups, { known: review }, fsrs, names, now).map(item => [item.label, item.again, item.hard])).toEqual([["가나다", 0, 0], ["나무", 0, 0]]);
});
