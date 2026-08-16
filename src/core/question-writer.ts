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

function metadataLines(metadata: QuestionMetadataInput): string[] {
  const line = (label: string, values: string[]) =>
    `> ${label}: ${values.map((value) => assertSingleLine(value, label)).join(", ")}`;
  const output = [
    "> [!mia]- 학습 정보",
    `> 유형: ${assertSingleLine(metadata.questionType, "문제 유형")}`,
    line("핵심", metadata.coreKeywords.map((item) => item.raw)),
    line("보조", metadata.subKeywords.map((item) => item.raw)),
  ];
  if (metadata.followUpLinks?.length) output.push(line("이어보기", metadata.followUpLinks));
  if (metadata.createdAt) output.push(`> 생성: ${assertSingleLine(metadata.createdAt, "생성 시각")}`);
  if (metadata.updatedAt) output.push(`> 수정: ${assertSingleLine(metadata.updatedAt, "수정 시각")}`);
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
  const insertion = calloutEnd(lines, question.location.questionStartLine);
  const block = [`^${id}`, "", ...metadataLines(metadata)];
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
  const replacement = metadataLines(metadata);

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
