// ─────────────────────────────────────────────────────────────
// utils/week.js — KST 주(월요일 시작) 계산 (8~9주차, G9)
//
// 그룹 한도는 주 단위다. 투표로 통과한 한도는 "다음 주 월요일 00:00 KST" 에 적용되고,
// 구성원당 제안은 "이번 주에 한 번" 이다. 둘 다 같은 주 경계를 써야 해서 한곳에 둔다.
// ─────────────────────────────────────────────────────────────

const { toKSTDateString, startOfKSTDay } = require("./time");

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET = 9 * 60 * 60 * 1000;

// 이번 주 월요일 00:00 KST (ms)
function startOfKSTWeek(now) {
  const today = startOfKSTDay(toKSTDateString(now));
  // KST 기준 요일 (0=일 ~ 6=토). 월요일 시작이 되게 (요일+6)%7 일만큼 뒤로.
  const dow = new Date(now + KST_OFFSET).getUTCDay();
  return today - ((dow + 6) % 7) * DAY_MS;
}

// 다음 주 월요일 00:00 KST (ms) — 통과한 한도가 적용되는 시각
function nextMondayKST(now) {
  return startOfKSTWeek(now) + 7 * DAY_MS;
}

// 이번 주를 가리키는 문자열 — 그 주 월요일 날짜 "2026-10-19"
function weekKey(now) {
  return toKSTDateString(startOfKSTWeek(now));
}

module.exports = { startOfKSTWeek, nextMondayKST, weekKey, DAY_MS };
