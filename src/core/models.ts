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
  createdAt?: string;
  updatedAt?: string;
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

export type GradeIntervalsMinutes = Partial<Record<1 | 2 | 3 | 4, number>>;
export const MAX_GRADE_INTERVAL_MINUTES = 36500 * 24 * 60;

export interface StudyManagementSettings {
  newCardsPerDay: number;
  reviewsPerDay: number;
  newCardsIgnoreReviewLimit: boolean;
  dayStartsAt: number;
  learningSteps: import("ts-fsrs").StepUnit[];
  relearningSteps: import("ts-fsrs").StepUnit[];
  newCardOrder: "sequential" | "random";
  newReviewOrder: "before" | "after" | "mix";
  reviewOrder: "due" | "retrievability" | "random" | "interval-ascending" | "interval-descending";
  enableFuzz: boolean;
  fsrsParameters: number[];
}

export const DEFAULT_STUDY_MANAGEMENT: StudyManagementSettings = {
  newCardsPerDay: 20,
  reviewsPerDay: 200,
  newCardsIgnoreReviewLimit: false,
  dayStartsAt: 4,
  learningSteps: ["1m", "10m"],
  relearningSteps: ["10m"],
  newCardOrder: "sequential",
  newReviewOrder: "mix",
  reviewOrder: "due",
  enableFuzz: true,
  fsrsParameters: [],
};

export interface MiaSettings {
  studyManagement: StudyManagementSettings;
  sourceRoots: string[];
  targetRetention: number;
  maximumIntervalDays: number;
  gradeIntervalsMinutes: GradeIntervalsMinutes;
  keywordFolder: string;
}

export interface SettingsSnapshot {
  id: string;
  ancestors: string[];
  settings: MiaSettings;
}

export interface SettingsSync {
  id: string;
  ancestors: string[];
  conflicts: SettingsSnapshot[];
}

export interface MiaPluginData {
  version: 1;
  settings: MiaSettings;
  settingsSync?: SettingsSync;
  reviews: Record<string, QuestionReviewState>;
  quarantinedReviews: Record<string, unknown>;
  reviewVersions: Record<string, string>;
  reviewConflicts: Record<string, QuestionReviewState[]>;
}

export const DEFAULT_SETTINGS: MiaSettings = {
  studyManagement: DEFAULT_STUDY_MANAGEMENT,
  sourceRoots: ["MIA"],
  targetRetention: 0.9,
  maximumIntervalDays: 36500,
  gradeIntervalsMinutes: {},
  keywordFolder: "MIA/키워드",
};

export const DEFAULT_PLUGIN_DATA: MiaPluginData = {
  version: 1,
  settings: DEFAULT_SETTINGS,
  reviews: {},
  quarantinedReviews: {},
  reviewVersions: {},
  reviewConflicts: {},
};
