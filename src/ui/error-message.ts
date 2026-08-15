export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : "알 수 없는 오류";
}
