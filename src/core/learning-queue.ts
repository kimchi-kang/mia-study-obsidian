import { State } from "ts-fsrs";
import { QuestionReviewState } from "./models";

/** Reinsert only learning steps, never a future long-term review. */
export function planLearningQueue(
  queue: readonly string[],
  index: number,
  scope: readonly string[],
  reviews: Readonly<Record<string, QuestionReviewState>>,
  skipped: ReadonlySet<string>,
  now = new Date(),
): { queue: string[]; nextDue: Date | null } {
  const learners = [...new Set(scope)].flatMap((id) => {
    const card = reviews[id]?.card;
    if (skipped.has(id) || !card || (card.state !== State.Learning && card.state !== State.Relearning)) return [];
    return [{ id, due: new Date(card.due) }];
  }).sort((left, right) => left.due.getTime() - right.due.getTime());
  const ready = learners.filter(({ due }) => due.getTime() <= now.getTime()).map(({ id }) => id);
  const readyIds = new Set(ready);
  const alreadySeen = new Set(queue.slice(0, index));
  return {
    queue: [...queue.slice(0, index), ...ready, ...queue.slice(index).filter((id) => !readyIds.has(id) && !alreadySeen.has(id))],
    nextDue: learners.find(({ due }) => due.getTime() > now.getTime())?.due ?? null,
  };
}
