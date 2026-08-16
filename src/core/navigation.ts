export const MIA_ROUTES = ["dashboard", "progress", "questions", "weakness", "keywords", "study"] as const;
export type MiaRoute = typeof MIA_ROUTES[number];
export type MiaSessionMode = "recall" | "browse";

export interface MiaNavigationState {
  route: MiaRoute;
  queue: string[];
  queueIndex: number;
  answerVisible: boolean;
  sessionMode: MiaSessionMode;
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
  const queue = Array.isArray(state.queue)
    ? state.queue.filter((item): item is string => typeof item === "string")
    : [];
  const queueIndex = typeof state.queueIndex === "number" && Number.isInteger(state.queueIndex)
    ? Math.max(0, Math.min(state.queueIndex, Math.max(0, queue.length - 1)))
    : 0;
  return {
    route: isMiaRoute(state.route) ? state.route : "dashboard",
    queue,
    queueIndex,
    answerVisible: state.answerVisible === true,
    sessionMode: state.sessionMode === "browse" ? "browse" : "recall",
  };
}
