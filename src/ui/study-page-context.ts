import type { App, Component } from "obsidian";
import type MiaStudyPlugin from "../main";
import type { MiaRoute, MiaSessionMode } from "../core/navigation";
import type { ReviewFilter } from "../core/question-query";

/**
 * What the read-only pages (dashboard, progress, questions, weakness,
 * keywords) need from the study view. Every member reads the view's current
 * state when used, so a page never holds a stale component or render list.
 */
export interface StudyPageContext {
  readonly app: App;
  readonly plugin: MiaStudyPlugin;
  /** Owner of this render's Markdown resources. */
  readonly component: Component;
  /** Markdown renders the view waits for before restoring the reading position. */
  readonly renders: Promise<void>[];
  startReview(questionIds?: string[], mode?: MiaSessionMode): void;
  resumeStudy(): Promise<void>;
  navigate(route: MiaRoute): void;
  showDashboard(): void;
  showQuestions(review: ReviewFilter, subject?: string): void;
  openStudySettings(): void;
  /** Pull review records and the resume point that other devices synced into this vault. */
  refreshRecords(): Promise<void>;
}
