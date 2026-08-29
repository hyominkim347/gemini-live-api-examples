export function translationStatusView(availability) {
  if (availability === "available") return null;
  if (availability === "reconnecting") {
    return {
      healthLabel: "통역 재연결 중",
      message: "통역 재연결 중입니다. 잠시 원음을 정상 크기로 들려드립니다.",
    };
  }
  throw new Error(`unsupported translation availability: ${availability}`);
}
