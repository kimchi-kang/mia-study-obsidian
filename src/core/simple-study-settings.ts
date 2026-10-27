import { DEFAULT_SETTINGS, DEFAULT_STUDY_MANAGEMENT, type MiaSettings, type StudyManagementSettings } from "./models";

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
