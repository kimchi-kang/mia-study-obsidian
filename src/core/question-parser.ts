import {
  ParsedQuestionFile,
  QUESTION_TYPES,
  QuestionDiagnostic,
  QuestionRecord,
  QuestionType,
  KeywordReference,
} from "./models";
import { fencedCodeLines } from "./markdown-structure";

const QUESTION_CALLOUT = /^>\s*\[!question\](?:[+-])?(?:\s+.*)?$/i;
const MIA_CALLOUT = /^>\s*\[!mia\](?:[+-])?(?:\s+.*)?$/i;
const BLOCK_ID = /^\^(mia-q-[A-Za-z0-9-]+)\s*$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const WIKI_LINK = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g;

interface HeadingLine {
  level: number;
  text: string;
  line: number;
}

interface MetadataBlock {
  startLine: number;
  endLine: number;
  questionType: QuestionType;
  coreKeywords: KeywordReference[];
  subKeywords: KeywordReference[];
  followUpIds: string[];
  createdAt?: string;
  updatedAt?: string;
  issues: string[];
}

function normalizeCalloutLine(line: string): string {
  return line.replace(/^>\s?/, "");
}

function stripTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]?.trim() === "") end -= 1;
  return lines.slice(0, end);
}

function parseKeywordReferences(value: string): KeywordReference[] {
  const references: KeywordReference[] = [];
  WIKI_LINK.lastIndex = 0;
  for (const match of value.matchAll(WIKI_LINK)) {
    const raw = match[0];
    const target = match[1]?.trim() ?? "";
    if (!target) continue;
    const label = match[2]?.trim() || target.split("#").at(-1) || target;
    references.push({ target, label, raw });
  }

  if (references.length > 0) return references;

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => ({ target: item, label: item, raw: item }));
}

function parseFollowUpIds(value: string): string[] {
  const ids = [...value.matchAll(/#\^(mia-q-[A-Za-z0-9-]+)/g)]
    .map((match) => match[1])
    .filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}

function parseMetadataBlock(lines: string[], startLine: number): MetadataBlock {
  let endLine = startLine + 1;
  while (endLine < lines.length && /^>/.test(lines[endLine] ?? "")) endLine += 1;

  let questionType: QuestionType = "정의형";
  let coreKeywords: KeywordReference[] = [];
  let subKeywords: KeywordReference[] = [];
  let followUpIds: string[] = [];
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  const issues: string[] = [];

  for (let line = startLine + 1; line < endLine; line += 1) {
    const content = normalizeCalloutLine(lines[line] ?? "").trim();
    const separator = content.indexOf(":");
    if (separator < 0) continue;
    const key = content.slice(0, separator).replaceAll("*", "").trim();
    const value = content.slice(separator + 1).trim();
    if (key === "유형") {
      if (QUESTION_TYPES.includes(value as QuestionType)) questionType = value as QuestionType;
      else issues.push(`지원하지 않는 문제 유형: ${value || "(비어 있음)"}`);
    }
    if (key === "핵심" || key === "핵심 키워드") coreKeywords = parseKeywordReferences(value);
    if (key === "보조" || key === "보조 키워드") subKeywords = parseKeywordReferences(value);
    if (key === "이어보기" || key === "이어볼 질문") {
      followUpIds = parseFollowUpIds(value);
      if (value && followUpIds.length === 0) issues.push("이어보기에서 유효한 MIA 문제 블록 ID를 찾지 못했습니다.");
    }
    if (key === "생성" && Number.isFinite(Date.parse(value))) createdAt = new Date(value).toISOString();
    if (key === "수정" && Number.isFinite(Date.parse(value))) updatedAt = new Date(value).toISOString();
  }

  return {
    startLine,
    endLine,
    questionType,
    coreKeywords,
    subKeywords,
    followUpIds,
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    issues,
  };
}

function isAnswerHeading(text: string): boolean {
  return /^(풀이|해설|정답)(?:\s|$|[:：])/u.test(text);
}

function inferSubject(filePath: string, fallback = "미분류"): string {
  const first = filePath.split("/").filter(Boolean)[0];
  return first || fallback;
}

function inferDeck(filePath: string): string {
  const fileName = filePath.split("/").at(-1) ?? filePath;
  return fileName.replace(/\.md$/i, "");
}

function collectHeadings(lines: string[], fenced: readonly boolean[]): HeadingLine[] {
  const headings: HeadingLine[] = [];
  lines.forEach((line, index) => {
    if (fenced[index]) return;
    const match = line.match(HEADING);
    if (!match) return;
    headings.push({ level: match[1]?.length ?? 1, text: match[2]?.trim() ?? "", line: index });
  });
  return headings;
}

function previousHeading(headings: HeadingLine[], line: number): HeadingLine | null {
  for (let index = headings.length - 1; index >= 0; index -= 1) {
    const heading = headings[index];
    if (heading && heading.line < line) return heading;
  }
  return null;
}

function findSectionEnd(lines: string[], fenced: readonly boolean[], startLine: number, headingLevel: number): number {
  for (let line = startLine + 1; line < lines.length; line += 1) {
    if (fenced[line]) continue;
    const match = lines[line]?.match(HEADING);
    if (match && (match[1]?.length ?? 7) <= headingLevel) return line;
  }
  return lines.length;
}

function findAnswerHeading(
  lines: string[],
  fenced: readonly boolean[],
  startLine: number,
  sectionEnd: number,
  headingLevel: number,
): number | null {
  for (let line = startLine + 1; line < sectionEnd; line += 1) {
    if (fenced[line]) continue;
    const match = lines[line]?.match(HEADING);
    if (!match) continue;
    const level = match[1]?.length ?? 1;
    const text = match[2]?.trim() ?? "";
    if (level > headingLevel && isAnswerHeading(text)) return line;
  }
  return null;
}

function findCalloutEnd(lines: string[], startLine: number): number {
  let line = startLine + 1;
  while (line < lines.length && /^>/.test(lines[line] ?? "")) line += 1;
  return line;
}

function promptMarkdown(
  lines: string[],
  questionStart: number,
  answerHeadingLine: number | null,
  metadata: MetadataBlock | null,
  anchorLine: number | null,
): string {
  const end = answerHeadingLine ?? findCalloutEnd(lines, questionStart);
  const output: string[] = [];
  for (let line = questionStart + 1; line < end; line += 1) {
    if (metadata && line >= (anchorLine ?? metadata.startLine) && line < metadata.endLine) continue;
    if (BLOCK_ID.test((lines[line] ?? "").trim())) continue;
    const source = lines[line] ?? "";
    output.push(/^>/.test(source) ? normalizeCalloutLine(source) : source);
  }
  return stripTrailingEmptyLines(output).join("\n").trim();
}

export function parseQuestionFile(
  filePath: string,
  content: string,
  overrides: { subject?: string; deck?: string } = {},
): ParsedQuestionFile {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const fenced = fencedCodeLines(lines);
  const headings = collectHeadings(lines, fenced);
  const questions: QuestionRecord[] = [];
  const diagnostics: QuestionDiagnostic[] = [];
  const seenIds = new Set<string>();

  for (let questionStart = 0; questionStart < lines.length; questionStart += 1) {
    if (fenced[questionStart]) continue;
    if (!QUESTION_CALLOUT.test(lines[questionStart] ?? "")) continue;
    const heading = previousHeading(headings, questionStart);
    if (!heading) continue;
    const sectionEnd = findSectionEnd(lines, fenced, heading.line, heading.level);
    const answerHeadingLine = findAnswerHeading(lines, fenced, questionStart, sectionEnd, heading.level);
    if (answerHeadingLine === null) {
      diagnostics.push({
        filePath,
        line: questionStart,
        code: "missing-answer",
        message: `“${heading.text}”에서 풀이/해설/정답 제목을 찾지 못했습니다.`,
      });
    }

    let id: string | null = null;
    let anchorLine: number | null = null;
    let metadata: MetadataBlock | null = null;
    const scanEnd = answerHeadingLine ?? sectionEnd;
    for (let line = questionStart + 1; line < scanEnd; line += 1) {
      if (fenced[line]) continue;
      const anchor = lines[line]?.trim().match(BLOCK_ID);
      if (anchor?.[1]) {
        id = anchor[1];
        anchorLine = line;
      }
      if (MIA_CALLOUT.test(lines[line] ?? "")) {
        metadata = parseMetadataBlock(lines, line);
        for (const issue of metadata.issues) {
          diagnostics.push({
            filePath,
            line,
            code: "invalid-metadata",
            message: `“${heading.text}” 학습 정보 오류: ${issue}`,
          });
        }
      }
    }

    if (id && seenIds.has(id)) {
      diagnostics.push({ filePath, line: anchorLine ?? questionStart, code: "duplicate-id", message: `중복 문제 ID: ${id}` });
    }
    if (id) seenIds.add(id);

    const answerStart = answerHeadingLine === null ? sectionEnd : answerHeadingLine + 1;
    const answerMarkdown = stripTrailingEmptyLines(lines.slice(answerStart, sectionEnd)).join("\n").trim();
    questions.push({
      id,
      filePath,
      heading: heading.text,
      headingLevel: heading.level,
      questionMarkdown: promptMarkdown(lines, questionStart, answerHeadingLine, metadata, anchorLine),
      answerMarkdown,
      subject: overrides.subject?.trim() || inferSubject(filePath),
      deck: overrides.deck?.trim() || inferDeck(filePath),
      questionType: metadata?.questionType ?? "정의형",
      coreKeywords: metadata?.coreKeywords ?? [],
      subKeywords: metadata?.subKeywords ?? [],
      followUpIds: metadata?.followUpIds ?? [],
      ...(metadata?.createdAt ? { createdAt: metadata.createdAt } : {}),
      ...(metadata?.updatedAt ? { updatedAt: metadata.updatedAt } : {}),
      location: {
        headingLine: heading.line,
        questionStartLine: questionStart,
        questionEndLine: answerHeadingLine ?? findCalloutEnd(lines, questionStart),
        answerHeadingLine,
        answerEndLine: sectionEnd,
        metadataStartLine: metadata?.startLine ?? null,
        metadataEndLine: metadata?.endLine ?? null,
        anchorLine,
      },
    });
  }

  return { filePath, questions, diagnostics };
}

export const QuestionParserInternals = {
  parseKeywordReferences,
  parseFollowUpIds,
};
