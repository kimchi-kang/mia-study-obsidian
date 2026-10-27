// Synthetic records are authored independently of the scheduler/preset constants.
// At noon: 60 unseen, 120 scheduled (70 today + 50 overdue), 5 future,
// 3 introduced today (one awaiting an intraday repeat), 7 reviews done today.
export function simpleStudyFixture(now = new Date(2026, 9, 27, 12)) {
  const at = (days, hour = 8) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d.toISOString(); };
  const questions = [], reviews = {};
  const add = (id, review) => {
    questions.push({ id, filePath: "MIA/검증/문제은행.md", heading: id, headingLevel: 3, questionMarkdown: `${id}의 답은?`, answerMarkdown: "검증 정답", subject: "검증", deck: "검증", questionType: "정의형", coreKeywords: [], subKeywords: [], followUpIds: [], location: { headingLine: 0, questionStartLine: 1, questionEndLine: 2, answerHeadingLine: 3, answerEndLine: 4, metadataStartLine: null, metadataEndLine: null, anchorLine: 2 } });
    if (review) reviews[id] = review;
  };
  const record = (state, due, history = [], lastReview = at(-10)) => ({ card: { due, stability: 10, difficulty: 5, elapsed_days: 10, scheduled_days: 10, learning_steps: 0, reps: 3, lapses: 0, state, last_review: lastReview }, history: history.length ? history : [log(2, at(-20), at(-10))], lastRating: 3 });
  const log = (state, due, review) => ({ rating: 3, state, due, review, stability: 10, difficulty: 5, elapsed_days: 10, last_elapsed_days: 10, scheduled_days: 10, learning_steps: 0 });
  for (let i = 0; i < 60; i++) add(`mia-q-fresh-${i}`);
  for (let i = 0; i < 70; i++) add(`mia-q-today-${i}`, record(2, at(0)));
  for (let i = 0; i < 50; i++) add(`mia-q-overdue-${i}`, record(2, at(-2)));
  for (let i = 0; i < 5; i++) add(`mia-q-future-${i}`, record(2, at(3)));
  for (let i = 0; i < 3; i++) add(`mia-q-introduced-${i}`, record(i === 0 ? 1 : 2, i === 0 ? at(0, 9) : at(5), [log(0, at(0, 7), at(0, 8))], at(0, 8)));
  for (let i = 0; i < 7; i++) add(`mia-q-done-${i}`, record(2, at(5), [log(2, at(-1), at(0, 8))], at(0, 8)));
  const markdown = "# 검증 문제은행\n\n" + questions.map(q => `### ${q.heading}\n\n> [!question] 문제\n> ${q.questionMarkdown}\n^${q.id}\n\n> [!mia]- 학습 정보\n> 유형: 정의형\n> 핵심:\n> 보조:\n> 생성: 2026-10-01T00:00:00.000Z\n\n#### 정답\n\n${q.answerMarkdown}\n`).join("\n");
  return { questions, reviews, markdown };
}
