import { KeywordReference, QuestionRecord, QuestionType } from "./models";
import { findCurrentQuestion } from "./question-writer";

export interface ManagedQuestionInput {
  questionMarkdown: string;
  answerMarkdown: string;
  questionType: QuestionType;
  coreKeywords: KeywordReference[];
  subKeywords: KeywordReference[];
  followUpLinks?: string[];
}

function newlineFor(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function cleanHeading(markdown: string): string {
  const firstLine = markdown.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "새 질문";
  const plain = firstLine
    .replace(/^#+\s*/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, label?: string) => label || target)
    .replace(/[*_`~]/g, "")
    .trim();
  return (plain || "새 질문").slice(0, 90);
}

function quoteCallout(markdown: string): string[] {
  return markdown.replaceAll("\r\n", "\n").trim().split("\n").map((line) => line ? `> ${line}` : ">");
}

function metadataLines(input: ManagedQuestionInput): string[] {
  const values = (items: KeywordReference[]) => items.map((item) => item.raw).join(", ");
  const lines = [
    "> [!mia]- 학습 정보",
    `> 유형: ${input.questionType}`,
    `> 핵심: ${values(input.coreKeywords)}`,
    `> 보조: ${values(input.subKeywords)}`,
  ];
  if (input.followUpLinks?.length) lines.push(`> 이어보기: ${input.followUpLinks.join(", ")}`);
  return lines;
}

export function renderManagedQuestion(input: ManagedQuestionInput, id: string): string {
  return [
    `### ${cleanHeading(input.questionMarkdown)}`,
    "",
    "> [!question] 문제",
    ...quoteCallout(input.questionMarkdown),
    `^${id}`,
    "",
    ...metadataLines(input),
    "",
    "#### 정답",
    "",
    input.answerMarkdown.trim(),
  ].join("\n");
}

export function createSubjectBank(subject: string): string {
  return `# ${subject} 문제은행\n`;
}

export function appendManagedQuestion(content: string, input: ManagedQuestionInput, id: string): string {
  const newline = newlineFor(content);
  const base = content.replaceAll("\r\n", "\n").trimEnd();
  return `${base}${base ? "\n\n" : ""}${renderManagedQuestion(input, id)}\n`.replaceAll("\n", newline);
}

export function replaceManagedQuestion(
  content: string,
  original: QuestionRecord,
  input: ManagedQuestionInput,
): string {
  if (!original.id) throw new Error("등록되지 않은 문제는 전체 편집할 수 없습니다.");
  const newline = newlineFor(content);
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const start = original.location.headingLine;
  const end = original.location.answerEndLine;
  lines.splice(start, end - start, ...renderManagedQuestion(input, original.id).split("\n"));
  return lines.join(newline);
}

function followUpLinksIn(content: string, question: QuestionRecord): string[] | undefined {
  if (question.location.metadataStartLine === null || question.location.metadataEndLine === null) return undefined;
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  for (let index = question.location.metadataStartLine; index < question.location.metadataEndLine; index += 1) {
    const match = lines[index]?.match(/^>\s*이어보기\s*:\s*(.+?)\s*$/);
    if (match?.[1]) return [match[1]];
  }
  return undefined;
}

export function replaceCurrentManagedQuestion(
  content: string,
  original: QuestionRecord,
  parse: (content: string) => QuestionRecord[],
  input: ManagedQuestionInput,
): string {
  const current = findCurrentQuestion(parse(content), original);
  if (!current) throw new Error("원문이 바뀌어 문제 위치를 안전하게 찾지 못했습니다. 다시 열어 주세요.");
  const preserved = input.followUpLinks === undefined ? followUpLinksIn(content, current) : input.followUpLinks;
  return replaceManagedQuestion(content, current, { ...input, ...(preserved ? { followUpLinks: preserved } : {}) });
}

export function validateSubjectName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("과목 이름을 입력하세요.");
  if (name === "." || name === ".." || /[\\/:*?"<>|#\[\]^]/u.test(name)) {
    throw new Error("과목 이름에 경로 또는 링크 특수문자를 사용할 수 없습니다.");
  }
  return name;
}

export const ManagedQuestionInternals = { cleanHeading, followUpLinksIn, quoteCallout };
