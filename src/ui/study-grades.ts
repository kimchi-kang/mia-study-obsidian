import { Rating } from "ts-fsrs";
import { StudyGrade } from "../core/fsrs-service";

export const GRADE_HINTS: Record<StudyGrade, string> = {
  [Rating.Again]: "답을 떠올리지 못했거나 틀렸습니다.",
  [Rating.Hard]: "정답을 떠올렸지만 오래 걸리거나 어려웠습니다.",
  [Rating.Good]: "정답을 무리 없이 떠올렸습니다.",
  [Rating.Easy]: "정답을 망설임 없이 바로 떠올렸습니다.",
};

export const GRADE_LABELS: Record<StudyGrade, string> = {
  [Rating.Again]: "못 암기",
  [Rating.Hard]: "애매",
  [Rating.Good]: "암기",
  [Rating.Easy]: "너무 쉬움",
};
