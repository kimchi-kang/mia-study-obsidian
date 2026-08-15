export const QUESTION_TYPES = ["정의형", "원리형", "계산형", "비교형", "예외형", "응용형"] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];

export interface KeywordReference {
  target: string;
  label: string;
  raw: string;
}

export interface QuestionLocation {
  headingLine: number;
  questionStartLine: number;
  questionEndLine: number;
  answerHeadingLine: number | null;
  answerEndLine: number;
  metadataStartLine: number | null;
  metadataEndLine: number | null;
  anchorLine: number | null;
}

export interface QuestionRecord {
  id: string | null;
  filePath: string;
  heading: string;
  headingLevel: number;
  questionMarkdown: string;
  answerMarkdown: string;
  subject: string;
  deck: string;
  questionType: QuestionType;
  coreKeywords: KeywordReference[];
  subKeywords: KeywordReference[];
  followUpIds: string[];
  location: QuestionLocation;
}

export interface ParsedQuestionFile {
  filePath: string;
  questions: QuestionRecord[];
  diagnostics: QuestionDiagnostic[];
}

export interface QuestionDiagnostic {
  filePath: string;
  line: number;
  code: "missing-answer" | "duplicate-id" | "invalid-metadata" | "read-error";
  message: string;
}

export interface SerializedFsrsCard {
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;
  last_review?: string;
}

export interface SerializedReviewLog {
  rating: number;
  state: number;
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  last_elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  review: string;
}

export interface QuestionReviewState {
  card: SerializedFsrsCard;
  history: SerializedReviewLog[];
  lastRating: number | null;
}

export interface MiaSettings {
  sourceRoots: string[];
  targetRetention: number;
  maximumIntervalDays: number;
  keywordFolder: string;
}

export interface MiaPluginData {
  version: 1;
  settings: MiaSettings;
  reviews: Record<string, QuestionReviewState>;
  quarantinedReviews: Record<string, unknown>;
}

export const DEFAULT_SETTINGS: MiaSettings = {
  sourceRoots: [],
  targetRetention: 0.9,
  maximumIntervalDays: 36500,
  keywordFolder: "MIA/키워드",
};

export const DEFAULT_PLUGIN_DATA: MiaPluginData = {
  version: 1,
  settings: DEFAULT_SETTINGS,
  reviews: {},
  quarantinedReviews: {},
};
