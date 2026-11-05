// ─────────────────────────────────────────────────────────────
// utils/points.js — 그룹 포인트 장부 (11/5, POINTS_API.md)
//
// 점수는 주(월요일 시작)마다 따로 센다. 멤버 문서에 주별로 저장한다.
//   groups/{gid}/members/{uid}
//     weekPoints   { "2026-11-02": 880, ... }   그 주 점수. 키가 없으면 1,000 (그 주에 아직 변화 없음)
//     waitingWeek  "2026-11-02"                가입한 주. 그 주 동안은 대기(점수 없음). 만든 사람 · 옛 멤버는 없음
//   → 월요일 리셋을 따로 "쓰지" 않아도 새 주 키가 없으니 저절로 1,000 이 된다.
//   → 대기도 따로 풀지 않아도 다음 주엔 waitingWeek 가 지난 주라 저절로 참가.
//   주별로 나눈 이유: 일요일 정산(월요일 00:05)이 지난주 점수에 지급해야 하는데, 그 사이 월요일 00:01 에
//   온 벌금은 이번 주에서 빠져야 한다. 점수가 칸 하나면 둘이 섞인다.
//
//   groups/{gid}/potDays/{YYYY-MM-DD}
//     fines       그날 벌금 합계
//     carriedIn   전날 정산에서 넘어온 몫
//     settled     정산 끝났나 · settledAt · winners [{userId, nickname, scrolls, received}] · carriedOut
//   groups/{gid}  lastSettledDate · lastWeek { weekStart, ranking[] }
//
//   groups/{gid}/alerts/{alertId}            앱이 보낸 alert 1건 (재전송 중복 막기 + 그룹원 일간 통계의 팝업 시각)
//   groups/{gid}/alertKeys/{uid}_{type}_{stage}   기기 두 대 중복 막기 — 마지막으로 센 시각 · 날짜
//   groups/{gid}/pushKeys/{uid}_{date}_daily | _hourly_{HH}   다른 멤버 푸시는 일간 1/일 · 시간당 1/시
// ─────────────────────────────────────────────────────────────

const { db } = require("./firebase");
const { toKSTDateString, startOfKSTDay } = require("./time");
const { weekKey, DAY_MS } = require("./week");

const START_POINTS = 1000;
const FINE = { hourly: 10, daily: 100 };
const HOURLY_DUP_WINDOW_MS = 60 * 60 * 1000;
const KEEP_WEEKS = 3;

const groupRef = (gid) => db.collection("groups").doc(gid);
const potRef = (gid, date) => groupRef(gid).collection("potDays").doc(date);

// 그 주에 대기 중인가 (가입한 주 = 대기)
function isWaiting(member, wk) {
  return !!member && member.waitingWeek === wk;
}

// 그 주 점수. 대기면 null
function pointsOf(member, wk) {
  if (!member || isWaiting(member, wk)) return null;
  const v = (member.weekPoints || {})[wk];
  return typeof v === "number" ? v : START_POINTS;
}

// weekPoints 에 delta 를 더한 새 맵 (오래된 주는 정리)
function addPoints(member, wk, delta) {
  const wp = { ...((member && member.weekPoints) || {}) };
  wp[wk] = (typeof wp[wk] === "number" ? wp[wk] : START_POINTS) + delta;
  const keys = Object.keys(wp).sort();
  while (keys.length > KEEP_WEEKS) delete wp[keys.shift()];
  return wp;
}

function nextDate(date) {
  return toKSTDateString(startOfKSTDay(date) + DAY_MS);
}

// 월요일인가 (KST)
function isMonday(date) {
  return new Date(startOfKSTDay(date) + 9 * 60 * 60 * 1000).getUTCDay() === 1;
}

// 오늘 벌금통 { today, carried, settlesAt }
async function potToday(gid, now = Date.now()) {
  const date = toKSTDateString(now);
  const s = await potRef(gid, date).get();
  const p = s.exists ? s.data() : {};
  const carried = p.carriedIn || 0;
  return {
    today: (p.fines || 0) + carried,
    carried,
    settlesAt: startOfKSTDay(date) + DAY_MS, // 오늘 24:00 (실제 정산은 5분 뒤)
  };
}

module.exports = {
  START_POINTS,
  FINE,
  HOURLY_DUP_WINDOW_MS,
  groupRef,
  potRef,
  isWaiting,
  pointsOf,
  addPoints,
  nextDate,
  isMonday,
  potToday,
  weekKey,
};
