/** Keep new names usable when a vault moves between supported file systems. */
export function assertPortablePathSegment(segment: string, label: string): void {
  if (!segment || segment === "." || segment === ".." || /[\u0000-\u001f\u007f\\/:*?"<>|]/u.test(segment)) {
    throw new Error(`${label}에 사용할 수 없는 경로 문자가 있습니다.`);
  }
  if (/[. ]$/u.test(segment) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(segment)) {
    throw new Error(`${label}에 Windows 예약 이름이나 끝의 마침표·공백을 사용할 수 없습니다.`);
  }
}

export function validateNoteName(value: string, kind: "과목" | "키워드"): string {
  const name = value.trim();
  if (!name) throw new Error(`${kind} 이름을 입력하세요.`);
  if (/[#\[\]^]/u.test(name)) throw new Error(`${kind} 이름에 링크 특수문자를 사용할 수 없습니다.`);
  assertPortablePathSegment(name, `${kind} 이름`);
  return name;
}

export function portableNameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}
