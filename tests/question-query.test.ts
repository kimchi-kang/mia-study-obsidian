import { describe, expect, it } from "vitest";
import { Rating } from "ts-fsrs";
import { FsrsService } from "../src/core/fsrs-service";
import { QuestionRecord } from "../src/core/models";
import { queryQuestions } from "../src/core/question-query";

const fsrs = new FsrsService({ targetRetention: 0.9, maximumIntervalDays: 36500 });

function question(id: string, overrides: Partial<Omit<QuestionRecord, "id">> = {}): QuestionRecord & { id: string } {
  return {
    id,
    filePath: `지리학/${id}.md`,
    heading: `${id} 제목`,
    headingLevel: 3,
    questionMarkdown: `${id} 질문`,
    answerMarkdown: `${id} 정답`,
    subject: "지리학",
    deck: "지형학",
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
    ...overrides,
  };
}

describe("question query", () => {
  it("searches answers and sub-keywords, not only headings", () => {
    const target = question("target", {
      answerMarkdown: "경계조건으로 계산한다",
      subKeywords: [{ target: "MIA/키워드/폐곡면", label: "폐곡면", raw: "[[MIA/키워드/폐곡면|폐곡면]]" }],
    });
    const other = question("other");
    const base = { subject: "all", questionType: "all" as const, review: "all" as const, keyword: "", sort: "title" as const };
    expect(queryQuestions([other, target], {}, fsrs, { ...base, text: "경계조건" }).map((item) => item.id)).toEqual(["target"]);
    expect(queryQuestions([other, target], {}, fsrs, { ...base, text: "", keyword: "폐곡면" }).map((item) => item.id)).toEqual(["target"]);
  });

  it("filters by FSRS rating and puts due cards before new cards", () => {
    const now = new Date("2026-08-16T00:00:00.000Z");
    const due = question("due");
    const fresh = question("fresh");
    let review = fsrs.rate(undefined, Rating.Hard, new Date("2026-07-01T00:00:00.000Z"));
    review = { ...review, card: { ...review.card, due: "2026-08-01T00:00:00.000Z" } };
    const base = { text: "", subject: "all", questionType: "all" as const, keyword: "", sort: "review" as const, now };
    expect(queryQuestions([fresh, due], { due: review }, fsrs, { ...base, review: "all" }).map((item) => item.id))
      .toEqual(["due", "fresh"]);
    expect(queryQuestions([fresh, due], { due: review }, fsrs, { ...base, review: "hard" }).map((item) => item.id))
      .toEqual(["due"]);
  });
});

it("selects leeches independently of last grade, without changing other review filters", () => {
  const leech = fsrs.rate(undefined, Rating.Easy);leech.card.lapses=8;
  const weak = fsrs.rate(undefined, Rating.Again);weak.card.lapses=7;
  const questions=[question("leech"),question("weak"),question("new")];
  const base={text:"",subject:"all",questionType:"all" as const,keyword:"",sort:"title" as const};
  expect(queryQuestions(questions,{leech,weak},fsrs,{...base,review:"leech"}).map(q=>q.id)).toEqual(["leech"]);
  expect(queryQuestions(questions,{leech,weak},fsrs,{...base,review:"weak"}).map(q=>q.id)).toEqual(["weak"]);
});
