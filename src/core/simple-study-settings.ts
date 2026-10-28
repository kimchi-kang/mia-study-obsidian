import { DEFAULT_SETTINGS, DEFAULT_STUDY_MANAGEMENT, type MiaSettings, type StudyManagementSettings, type SavedStudyProfile } from "./models";
import { parseSteps } from "./study-management";

// Presets are views over the existing settings; no preset ID is persisted.
export const WORKLOAD_PRESETS = {
  light: { label: "가볍게", newCardsPerDay: 10, reviewsPerDay: 100 },
  normal: { label: "보통", newCardsPerDay: 20, reviewsPerDay: 200 },
  more: { label: "많이", newCardsPerDay: 40, reviewsPerDay: 400 },
} as const;
export const RETENTION_PRESETS = {
  "0.85": "간격을 길게 · 목표 85%",
  "0.9": "기본 간격 · 목표 90%",
  "0.95": "더 자주 복습 · 목표 95%",
} as const;

export function workloadPreset(settings: StudyManagementSettings): string {
  return Object.entries(WORKLOAD_PRESETS).find(([, preset]) => preset.newCardsPerDay === settings.newCardsPerDay && preset.reviewsPerDay === settings.reviewsPerDay)?.[0] ?? "custom";
}

export function hasCustomAdvancedSettings(settings: MiaSettings): boolean {
  return Object.keys(DEFAULT_STUDY_MANAGEMENT).some(key => {
    if (key === "newCardsPerDay" || key === "reviewsPerDay") return false;
    const field = key as keyof StudyManagementSettings;
    return JSON.stringify(settings.studyManagement[field]) !== JSON.stringify(DEFAULT_STUDY_MANAGEMENT[field]);
  }) || settings.maximumIntervalDays !== DEFAULT_SETTINGS.maximumIntervalDays || Object.keys(settings.gradeIntervalsMinutes).length > 0;
}

/** Merge only edited fields into the latest settings, preserving unrelated advanced edits. */
export function studySettingsPatch(initial: MiaSettings, draft: StudyManagementSettings, retention: number, latest: MiaSettings): Partial<MiaSettings> {
  const changed = Object.fromEntries(Object.entries(draft).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(initial.studyManagement[key as keyof StudyManagementSettings])));
  return {
    ...(Object.keys(changed).length ? { studyManagement: { ...structuredClone(latest.studyManagement), ...changed } } : {}),
    ...(retention !== initial.targetRetention ? { targetRetention: retention } : {}),
  };
}

export function captureStudyProfile(name: string, draft: StudyManagementSettings, targetRetention: number): SavedStudyProfile {
  return { id: crypto.randomUUID(), name: name.trim(), newCardsPerDay: draft.newCardsPerDay, reviewsPerDay: draft.reviewsPerDay,
    learningSteps: [...draft.learningSteps], relearningSteps: [...draft.relearningSteps], targetRetention };
}

/** Do not silently replace damaged saved combinations with defaults. */
export function parseStudyProfiles(value: unknown): SavedStudyProfile[] {
  if (!Array.isArray(value)) throw new Error("내 설정 목록이 손상되었습니다. 원본을 보존하세요.");
  const ids = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== "object") throw new Error("내 설정 항목을 읽을 수 없습니다.");
    const raw: Record<string, unknown> = Object.fromEntries(Object.entries(item));
    const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 9999;
    const steps = (v: unknown) => Array.isArray(v) && v.every(s => typeof s === "string") ? parseSteps(v.join(" ")) : null;
    const learningSteps = steps(raw.learningSteps), relearningSteps = steps(raw.relearningSteps);
    if (typeof raw.id !== "string" || !raw.id || ids.has(raw.id) || typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 80
      || !count(raw.newCardsPerDay) || !count(raw.reviewsPerDay) || !learningSteps || !relearningSteps
      || typeof raw.targetRetention !== "number" || !Number.isFinite(raw.targetRetention) || raw.targetRetention < .7 || raw.targetRetention > .99) throw new Error("내 설정에 잘못된 이름·공부량·간격이 있습니다. 원본을 보존하세요.");
    ids.add(raw.id);
    return { id: raw.id, name: raw.name, newCardsPerDay: raw.newCardsPerDay, reviewsPerDay: raw.reviewsPerDay, learningSteps, relearningSteps, targetRetention: raw.targetRetention };
  });
}
