import { KeywordReference, QuestionRecord, QuestionType } from "./models";
import { assertQuestionUnchanged, findCurrentQuestion, questionMetadataLines } from "./question-writer";
import { assertSingleLine, hasHeadingAtOrAbove } from "./markdown-structure";
import { validateNoteName } from "./note-name";

export interface ManagedQuestionInput {
  questionMarkdown: string;
  answerMarkdown: string;
  questionType: QuestionType;
  coreKeywords: KeywordReference[];
  subKeywords: KeywordReference[];
  followUpLinks?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export function validateManagedQuestionInput(input: ManagedQuestionInput): void {
  if (hasHeadingAtOrAbove(input.answerMarkdown, 3)) {
    throw new Error("정답에서는 #### 이하의 제목만 사용할 수 있습니다. #~### 제목은 문제 구역을 분리합니다.");
  }
  for (const keyword of [...input.coreKeywords, ...input.subKeywords]) {
    assertSingleLine(keyword.raw, "키워드");
  }
  for (const link of input.followUpLinks ?? []) assertSingleLine(link, "이어보기 링크");
  if (input.createdAt) assertSingleLine(input.createdAt, "생성 시각");
  if (input.updatedAt) assertSingleLine(input.updatedAt, "수정 시각");
}

function newlineFor(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function cleanHeading(markdown: string): string {
  const firstLine = markdown.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "새 질문";
  // Keep TeX operators, subscripts and paired delimiters intact in generated titles.
  if (firstLine === "$$") return "수식 질문";
  if (firstLine.includes("$")) return firstLine.replace(/^#+\s*/, "");
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

export function renderManagedQuestion(input: ManagedQuestionInput, id: string): string {
  validateManagedQuestionInput(input);
  if (!/^mia-q-[A-Za-z0-9-]+$/.test(id)) throw new Error("유효하지 않은 MIA 문제 ID입니다.");
  return [
    `### ${cleanHeading(input.questionMarkdown)}`,
    "",
    "> [!question] 문제",
    ...quoteCallout(input.questionMarkdown),
    `^${id}`,
    "",
    ...questionMetadataLines(input),
    "",
    "#### 정답",
    "",
    input.answerMarkdown.trim(),
  ].join("\n");
}

export function createSubjectBank(subject: string): string {
  return `# ${subject} 문제은행\n`;
}

export function renameSubjectBank(content: string, current: string, next: string): string {
  const newline = newlineFor(content);
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  if (lines[0]?.trim() === `# ${current} 문제은행`) lines[0] = `# ${next} 문제은행`;
  return lines.join(newline);
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
  validateManagedQuestionInput(input);
  const newline = newlineFor(content);
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const location = original.location;
  if (location.answerHeadingLine === null) throw new Error("정답 구역을 찾지 못해 안전하게 편집할 수 없습니다. 원문을 확인하세요.");
  const edits: Array<{ start: number; end: number; replacement: string[] }> = [];
  if (input.questionMarkdown !== original.questionMarkdown) {
    let end = location.questionStartLine + 1;
    while (end < lines.length && /^>/.test(lines[end] ?? "")) end += 1;
    const quoted = lines.slice(location.questionStartLine + 1, end).map(line => line.replace(/^>\s?/, "")).join("\n").trim();
    if (quoted !== original.questionMarkdown) throw new Error("질문 구역에 별도 사용자 내용이 있어 자동 편집을 중단했습니다. 원문을 확인하세요.");
    edits.push({ start: location.questionStartLine + 1, end, replacement: quoteCallout(input.questionMarkdown) });
    edits.push({ start: location.headingLine, end: location.headingLine + 1, replacement: [`${"#".repeat(original.headingLevel)} ${cleanHeading(input.questionMarkdown)}`] });
  }
  if (input.answerMarkdown !== original.answerMarkdown) {
    let start = location.answerHeadingLine + 1;
    let end = location.answerEndLine;
    while (start < end && !lines[start]?.trim()) start += 1;
    while (end > start && !lines[end - 1]?.trim()) end -= 1;
    edits.push({ start, end, replacement: input.answerMarkdown.trim().split(/\r?\n/) });
  }
  if (location.metadataStartLine !== null && location.metadataEndLine !== null) {
    edits.push({ start: location.metadataStartLine, end: location.metadataEndLine,
      replacement: questionMetadataLines(input, lines.slice(location.metadataStartLine, location.metadataEndLine)) });
  } else {
    if (location.anchorLine === null) throw new Error("문제 ID 위치를 찾지 못해 편집을 중단했습니다.");
    edits.push({ start: location.anchorLine + 1, end: location.anchorLine + 1, replacement: ["", ...questionMetadataLines(input)] });
  }
  for (const edit of edits.sort((a,b) => b.start - a.start)) lines.splice(edit.start, edit.end - edit.start, ...edit.replacement);
  return lines.join(newline);
}

export function followUpLinksIn(content: string, question: QuestionRecord): string[] | undefined {
  if (question.location.metadataStartLine === null || question.location.metadataEndLine === null) return undefined;
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  for (let index = question.location.metadataStartLine; index < question.location.metadataEndLine; index += 1) {
    const match = lines[index]?.match(/^>\s*이어보기\s*:\s*(.+?)\s*$/);
    if (match?.[1]) return [match[1]];
  }
  return undefined;
}

export function timestampsIn(content: string, question: QuestionRecord): Pick<ManagedQuestionInput, "createdAt" | "updatedAt"> {
  if (question.location.metadataStartLine === null || question.location.metadataEndLine === null) return {};
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  for (let index = question.location.metadataStartLine; index < question.location.metadataEndLine; index += 1) {
    const created = lines[index]?.match(/^>\s*생성\s*:\s*(.+?)\s*$/)?.[1];
    const updated = lines[index]?.match(/^>\s*수정\s*:\s*(.+?)\s*$/)?.[1];
    if (created) createdAt = created;
    if (updated) updatedAt = updated;
  }
  return { ...(createdAt ? { createdAt } : {}), ...(updatedAt ? { updatedAt } : {}) };
}

export function deleteManagedQuestion(content: string, question: QuestionRecord): string {
  if (!question.id) throw new Error("등록되지 않은 문제는 삭제할 수 없습니다.");
  const newline = newlineFor(content);
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const start = question.location.headingLine;
  let end = question.location.answerEndLine;
  while (end < lines.length && lines[end]?.trim() === "") end += 1;
  lines.splice(start, end - start);
  return `${lines.join("\n").trimEnd()}\n`.replaceAll("\n", newline);
}

export function deleteCurrentManagedQuestion(
  content: string,
  original: QuestionRecord,
  parse: (content: string) => QuestionRecord[],
): string {
  const current = findCurrentQuestion(parse(content), original);
  if (!current) throw new Error("원문이 바뀌어 삭제할 문제를 안전하게 찾지 못했습니다. 다시 열어 주세요.");
  assertQuestionUnchanged(original, current);
  return deleteManagedQuestion(content, current);
}

export function replaceCurrentManagedQuestion(
  content: string,
  original: QuestionRecord,
  parse: (content: string) => QuestionRecord[],
  input: ManagedQuestionInput,
): string {
  const current = findCurrentQuestion(parse(content), original);
  if (!current) throw new Error("원문이 바뀌어 문제 위치를 안전하게 찾지 못했습니다. 다시 열어 주세요.");
  assertQuestionUnchanged(original, current);
  const preserved = input.followUpLinks === undefined ? followUpLinksIn(content, current) : input.followUpLinks;
  const timestamps = timestampsIn(content, current);
  return replaceManagedQuestion(content, current, {
    ...input,
    ...timestamps,
    ...(preserved ? { followUpLinks: preserved } : {}),
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
  });
}

export function validateSubjectName(value: string): string {
  return validateNoteName(value, "과목");
}

export const ManagedQuestionInternals = { cleanHeading, followUpLinksIn, timestampsIn, quoteCallout };
