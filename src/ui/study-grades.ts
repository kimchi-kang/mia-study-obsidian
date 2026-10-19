import { Rating } from "ts-fsrs";
import { StudyGrade } from "../core/fsrs-service";

export const GRADE_HINTS: Record<StudyGrade, string> = {
  [Rating.Again]: "답을 떠올리지 못했거나 틀렸습니다.",
  [Rating.Hard]: "정답을 떠올렸지만 오래 걸리거나 어려웠습니다.",
  [Rating.Good]: "정답을 무리 없이 떠올렸습니다.",
  [Rating.Easy]: "정답을 망설임 없이 바로 떠올렸습니다.",
};

export const GRADE_GUIDANCE = "틀리거나 기억나지 않으면 ‘못 암기’, 정답을 떠올렸지만 어려웠으면 ‘애매’를 선택하세요.";
