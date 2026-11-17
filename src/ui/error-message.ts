export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : "알 수 없는 오류";
}

/** Observe tasks launched by synchronous host/DOM callbacks without changing their UI. */
export function reportUiFailure(task: Promise<unknown> | void): void {
  void Promise.resolve(task).catch((error: unknown) => console.error(error));
}
