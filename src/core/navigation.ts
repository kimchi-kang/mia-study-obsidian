export const MIA_ROUTES = ["dashboard", "progress", "questions", "weakness", "keywords", "study"] as const;
export type MiaRoute = typeof MIA_ROUTES[number];
export type MiaSessionMode = "recall" | "browse";

export interface ReviewCheckpoint { id: string; version: string | null }
export function parseReviewCheckpoint(value: unknown): ReviewCheckpoint | null {
  if (!value || typeof value !== "object" || !("id" in value) || !("version" in value)) return null;
  if (typeof value.id !== "string" || !value.id) return null;
  if (value.version !== null && (typeof value.version !== "string" || !value.version)) return null;
  return { id: value.id, version: value.version };
}

export interface MiaNavigationState {
  route: MiaRoute;
  queue: string[];
  queueIndex: number;
  answerVisible: boolean;
  sessionMode: MiaSessionMode;
  reviewCheckpoint?: ReviewCheckpoint;
}

export const DEFAULT_MIA_NAVIGATION_STATE: MiaNavigationState = {
  route: "dashboard",
  queue: [],
  queueIndex: 0,
  answerVisible: false,
  sessionMode: "recall",
};

export function isMiaRoute(value: unknown): value is MiaRoute {
  return typeof value === "string" && MIA_ROUTES.some((route) => route === value);
}

export function parseMiaNavigationState(value: unknown): MiaNavigationState {
  if (!value || typeof value !== "object") return { ...DEFAULT_MIA_NAVIGATION_STATE };
  const state = value as Record<string, unknown>;
  const checkpoint = state.reviewCheckpoint === undefined ? undefined : parseReviewCheckpoint(state.reviewCheckpoint);
  if (checkpoint === null) return { ...DEFAULT_MIA_NAVIGATION_STATE };
  const queue = Array.isArray(state.queue)
    ? state.queue.filter((item): item is string => typeof item === "string")
    : [];
  const queueIndex = typeof state.queueIndex === "number" && Number.isInteger(state.queueIndex)
    ? Math.max(0, Math.min(state.queueIndex, queue.length))
    : 0;
  return {
    route: isMiaRoute(state.route) ? state.route : "dashboard",
    queue,
    queueIndex,
    answerVisible: state.answerVisible === true,
    sessionMode: state.sessionMode === "browse" ? "browse" : "recall",
    ...(checkpoint ? { reviewCheckpoint: checkpoint } : {}),
  };
}
