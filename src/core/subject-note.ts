import { QuestionRecord } from "./models";

export const SUBJECT_NOTE_MARKER = "<!-- mia-study-subject-note:v1 -->";

type SummaryQuestion = Pick<QuestionRecord, "questionMarkdown" | "answerMarkdown">;

function oneLine(markdown: string): string {
  return markdown.replaceAll("\r\n", "\n").replace(/\s+/gu, " ").trim();
}

export function subjectNoteFileName(subject: string): string {
  return `${subject} 노트.md`;
}

export function isManagedSubjectNote(content: string): boolean {
  return content.includes(SUBJECT_NOTE_MARKER);
}

export function renderSubjectNote(subject: string, questions: readonly SummaryQuestion[]): string {
  const entries = questions.map((question) => [
    `질문: ${oneLine(question.questionMarkdown)}`,
    `대답: ${oneLine(question.answerMarkdown)}`,
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
