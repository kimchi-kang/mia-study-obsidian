import { QuestionRecord } from "./models";
import { fencedCodeLines } from "./markdown-structure";

export const SUBJECT_NOTE_MARKER = "<!-- mia-study-subject-note:v1 -->";

type SummaryQuestion = Pick<QuestionRecord, "questionMarkdown" | "answerMarkdown">;

function oneLine(markdown: string): string {
  return markdown.replaceAll("\r\n", "\n").replace(/\s+/gu, " ").trim();
}

function summaryMarkdown(label: string, markdown: string): string {
  const normalized = markdown.replaceAll("\r\n", "\n").trim();
  const lines = normalized.split("\n");
  const fenced = fencedCodeLines(lines);
  // Display-math delimiters and TeX comments depend on line boundaries.
  const displayMath = lines.some((line, index) => !fenced[index] && /^ {0,3}\$\$(?!\$)/u.test(line));
  return displayMath ? `${label}:\n\n${normalized}` : `${label}: ${oneLine(markdown)}`;
}

export function subjectNoteFileName(subject: string): string {
  return `${subject} 노트.md`;
}

export function isManagedSubjectNote(content: string): boolean {
  return content.includes(SUBJECT_NOTE_MARKER);
}

export function renderSubjectNote(subject: string, questions: readonly SummaryQuestion[]): string {
  const entries = questions.map((question) => [
    summaryMarkdown("질문", question.questionMarkdown),
    summaryMarkdown("대답", question.answerMarkdown),
  ].join("\n"));
  return [
    `# ${subject} 노트`,
    SUBJECT_NOTE_MARKER,
    "",
    ...entries.flatMap((entry, index) => index === 0 ? [entry] : ["", entry]),
    "",
  ].join("\n");
}

export const SubjectNoteInternals = { oneLine };
