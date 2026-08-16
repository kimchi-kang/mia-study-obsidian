interface FenceState {
  marker: "`" | "~";
  length: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export function fencedCodeLines(lines: readonly string[]): boolean[] {
  const masked = Array.from({ length: lines.length }, () => false);
  let open: FenceState | null = null;

  lines.forEach((line, index) => {
    const match = line.match(FENCE);
    if (!open) {
      if (!match?.[1]) return;
      open = { marker: match[1][0] as "`" | "~", length: match[1].length };
      masked[index] = true;
      return;
    }

    masked[index] = true;
    const closing = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/)?.[1];
    if (closing?.[0] === open.marker && closing.length >= open.length) open = null;
  });

  return masked;
}

export function assertSingleLine(value: string, label: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label}에는 줄바꿈이나 제어 문자를 사용할 수 없습니다.`);
  }
  return value;
}

export function hasHeadingAtOrAbove(markdown: string, maximumLevel: number): boolean {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const masked = fencedCodeLines(lines);
  return lines.some((line, index) => {
    if (masked[index]) return false;
    const heading = line.match(/^(#{1,6})\s+/);
    return Boolean(heading && (heading[1]?.length ?? 7) <= maximumLevel);
  });
}
