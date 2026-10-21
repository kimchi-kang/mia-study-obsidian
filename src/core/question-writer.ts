import { KeywordReference, QuestionRecord, QuestionType } from "./models";
import { assertSingleLine } from "./markdown-structure";

export interface QuestionMetadataInput {
  questionType: QuestionType;
  coreKeywords: KeywordReference[];
  subKeywords: KeywordReference[];
  followUpLinks?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export function questionMetadataLines(metadata: QuestionMetadataInput, existing: readonly string[] = []): string[] {
  const line = (label: string, values: string[]) =>
    `> ${label}: ${values.map((value) => assertSingleLine(value, label)).join(", ")}`;
  const output = [
    existing[0] ?? "> [!mia]- 학습 정보",
    `> 유형: ${assertSingleLine(metadata.questionType, "문제 유형")}`,
    line("핵심", metadata.coreKeywords.map((item) => item.raw)),
    line("보조", metadata.subKeywords.map((item) => item.raw)),
  ];
  if (metadata.followUpLinks?.length) output.push(line("이어보기", metadata.followUpLinks));
  if (metadata.createdAt) output.push(`> 생성: ${assertSingleLine(metadata.createdAt, "생성 시각")}`);
  if (metadata.updatedAt) output.push(`> 수정: ${assertSingleLine(metadata.updatedAt, "수정 시각")}`);
  const replaced = new Set(["유형", "핵심", "핵심 키워드", "보조", "보조 키워드"]);
  if (metadata.followUpLinks !== undefined) { replaced.add("이어보기"); replaced.add("이어볼 질문"); }
  if (metadata.createdAt !== undefined) replaced.add("생성");
  if (metadata.updatedAt !== undefined) replaced.add("수정");
  for (const source of existing.slice(1)) {
    const key = source.replace(/^>\s?/, "").split(":")[0]?.replaceAll("*", "").trim() ?? "";
    if (!replaced.has(key)) output.push(source);
  }
  return output;
}

function calloutEnd(lines: string[], questionStartLine: number): number {
  let line = questionStartLine + 1;
  while (line < lines.length && /^>/.test(lines[line] ?? "")) line += 1;
  return line;
}

export function createQuestionId(now = Date.now(), random = Math.random()): string {
  const time = Math.max(0, Math.floor(now)).toString(36);
  const entropy = Math.floor(Math.max(0, Math.min(random, 0.999999999)) * 0x100000000)
    .toString(36)
    .padStart(7, "0");
  return `mia-q-${time}-${entropy}`;
}

export function registerQuestion(
  content: string,
  question: QuestionRecord,
  metadata: QuestionMetadataInput,
  id = createQuestionId(),
): string {
  if (question.id) return updateQuestionMetadata(content, question, metadata);
  if (!/^mia-q-[A-Za-z0-9-]+$/.test(id)) throw new Error("유효하지 않은 MIA 문제 ID입니다.");
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const insertion = Math.min(calloutEnd(lines, question.location.questionStartLine), question.location.metadataStartLine ?? Infinity);
  if (question.location.metadataStartLine !== null && question.location.metadataEndLine !== null) {
    lines.splice(insertion, 0, `^${id}`, "");
    return updateQuestionMetadata(lines.join(newline), {
      ...question,
      id,
      location: {
        ...question.location,
        metadataStartLine: question.location.metadataStartLine + 2,
        metadataEndLine: question.location.metadataEndLine + 2,
      },
    }, metadata);
  }
  const block = [`^${id}`, "", ...questionMetadataLines(metadata)];
  lines.splice(insertion, 0, ...block);
  return lines.join(newline);
}

export function updateQuestionMetadata(
  content: string,
  question: QuestionRecord,
  metadata: QuestionMetadataInput,
): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const replacement = questionMetadataLines(metadata,
    question.location.metadataStartLine !== null && question.location.metadataEndLine !== null
      ? lines.slice(question.location.metadataStartLine, question.location.metadataEndLine) : []);

  if (question.location.metadataStartLine !== null && question.location.metadataEndLine !== null) {
    lines.splice(
      question.location.metadataStartLine,
      question.location.metadataEndLine - question.location.metadataStartLine,
      ...replacement,
    );
    return lines.join(newline);
  }

  const insertion = question.location.anchorLine !== null
    ? question.location.anchorLine + 1
    : calloutEnd(lines, question.location.questionStartLine);
  lines.splice(insertion, 0, "", ...replacement);
  return lines.join(newline);
}

export function findCurrentQuestion(
  questions: QuestionRecord[],
  original: QuestionRecord,
): QuestionRecord | undefined {
  if (original.id) {
    const matchingId = questions.filter((candidate) => candidate.id === original.id);
    return matchingId.length === 1 ? matchingId[0] : undefined;
  }

  const exact = questions.find((candidate) =>
    candidate.id === null
    && candidate.location.questionStartLine === original.location.questionStartLine
    && candidate.heading === original.heading
    && candidate.questionMarkdown === original.questionMarkdown,
  );
  if (exact) return exact;

  const matchingContent = questions.filter((candidate) =>
    candidate.id === null
    && candidate.heading === original.heading
    && candidate.questionMarkdown === original.questionMarkdown,
  );
  return matchingContent.length === 1 ? matchingContent[0] : undefined;
}

/** Position changes are harmless; changing the displayed question requires a fresh edit. */
export function assertQuestionUnchanged(original: QuestionRecord, current: QuestionRecord): void {
  const snapshot = (question: QuestionRecord) => [
    question.heading, question.headingLevel, question.questionMarkdown, question.answerMarkdown,
    question.questionType, question.coreKeywords, question.subKeywords, question.followUpIds,
    question.createdAt, question.updatedAt,
  ];
  if (JSON.stringify(snapshot(original)) !== JSON.stringify(snapshot(current))) {
    throw new Error("문제 내용이 다른 작업에서 변경되었습니다. 최신 문제를 다시 연 뒤 수정하거나 삭제하세요.");
  }
}
