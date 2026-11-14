import { State } from "ts-fsrs";
import { isInterdayReview } from "./fsrs-service";
import { QuestionReviewState } from "./models";

/** Reinsert only learning steps, never a future long-term review. */
export function planLearningQueue(
  queue: readonly string[],
  index: number,
  scope: readonly string[],
  reviews: Readonly<Record<string, QuestionReviewState>>,
  skipped: ReadonlySet<string>,
  now = new Date(),
  learnAheadLimitMs = 0,
): { queue: string[]; nextDue: Date | null } {
  const learners = [...new Set(scope)].flatMap((id) => {
    const card = reviews[id]?.card;
    if (skipped.has(id) || !card || isInterdayReview(card)
      || (card.state !== State.Learning && card.state !== State.Relearning)) return [];
    return [{ id, due: new Date(card.due) }];
  }).sort((left, right) => left.due.getTime() - right.due.getTime());
  const alreadySeen = new Set(queue.slice(0, index));
  const learnerIds = new Set(learners.map(({ id }) => id));
  // Learn ahead (Anki) only once nothing else is left to show in this session.
  const othersLeft = queue.slice(index).some(id => !alreadySeen.has(id) && !learnerIds.has(id));
  const hasDue = learners.some(({ due }) => due.getTime() <= now.getTime());
  const cutoff = now.getTime() + (!othersLeft && !hasDue ? Math.max(0, learnAheadLimitMs) : 0);
  const ready = learners.filter(({ due }) => due.getTime() <= cutoff).map(({ id }) => id);
  const readyIds = new Set(ready);
  return {
    queue: [...queue.slice(0, index), ...ready, ...queue.slice(index).filter((id) => !readyIds.has(id) && !alreadySeen.has(id))],
    nextDue: learners.find(({ due }) => due.getTime() > cutoff)?.due ?? null,
  };
}
