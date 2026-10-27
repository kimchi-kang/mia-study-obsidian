import { ConvertStepUnitToMinutes, type StepUnit } from "ts-fsrs";

/** Explain the configured short-term strategy without changing scheduling. */
export function learningStepGuidance(steps: readonly StepUnit[] | null, fixedHard: boolean): string {
  if (steps === null) return "간격을 올바르게 입력하면 단계 안내가 표시됩니다.";
  if (!steps.length) return "고정 학습 단계 없이 다음 간격을 자동으로 계산합니다.";
  const minutes = steps.map(ConvertStepUnitToMinutes);
  const hard = Math.round(minutes.length === 1 ? minutes[0]! * 1.5 : (minutes[0]! + minutes[1]!) / 2);
  const hardNote = fixedHard
    ? "애매의 다음 간격은 평가 버튼에 지정한 고정 간격이 우선합니다."
    : hard < 1440
      ? `이 단계 설정에서 애매는 ${hard}분 후 다시 나옵니다. 학습 단계 안에서는 다음 단계로 진행하지 않으며, 뒤 단계에서도 같은 간격을 사용합니다.`
      : "이 단계 설정에서는 애매로 선택되는 간격도 24시간 이상입니다.";
  const longNote = minutes.some(value => value >= 1440) || hard >= 1440
    ? " 24시간 이상인 단계가 평가로 선택되면 학습 중에 머무르지 않고 복습 상태로 전환됩니다. 이후에는 일반 복습 한도를 적용합니다."
    : "";
  return hardNote + longNote;
}

export function progressGuidance(dayStartsAt: number): string {
  return `오늘 평가는 마지막 평가일이 오늘인 문제 수이며, 기기의 자정 기준입니다. 오늘 복습은 한도 적용 전 기한이 된 전체 문제 수입니다. 위 숫자는 하루 예산의 사용 횟수가 아닙니다. 자동 출제 예산은 기기 시간 ${dayStartsAt}시부터 계산하며, 실제 출제량은 학습 시작 안내에서 확인하세요.`;
}
