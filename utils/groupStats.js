// ─────────────────────────────────────────────────────────────
// utils/groupStats.js — 그룹 화면용 숫자 계산 (6주차, G4 · G5 · G6 · G11)
//
// 서버는 **숫자만** 준다. 순위 · 빨강/초록 · "3분 전" 같은 표시는 앱이 한다 (9/25 합의).
//
// 왜 캐시(멤버 문서의 todayCount)를 안 쓰고 매번 계산하나 —
//   lastHourCount 는 "지금부터 1시간 전까지" 라서 업로드가 없어도 시간이 지나면 줄어든다.
//   업로드 때 저장해 둔 값은 그 순간에만 맞고, 자정이 지나도 todayCount 가 남는다.
//   그래서 읽을 때 userLogs 를 직접 센다. 구성원마다 쿼리 1번씩 **동시에** 보내므로
//   10명이어도 쿼리 1번 시간과 비슷하다 (NFR: 10명 그룹 2초 안).
//   같은 그룹을 여러 명이 30초마다 열어도 읽기가 몰리지 않게 15초 메모리 캐시를 둔다.
// ─────────────────────────────────────────────────────────────

const { db } = require("./firebase");
const { toKSTDateString, startOfKSTDay } = require("./time");
// 11/5 포인트 — 점수 · 대기 · 오늘 수상 가능 여부
const points = require("./points");
const presence = require("./presence");

// 멤버 행에 이번 주 점수 · 대기를 붙인다. 점수는 캐시하지 않는다 — 멤버 문서를 매번 새로 읽으므로
// 벌금이 깎이면 다음 새로고침에 바로 보인다.
function withPoints(row, m, now) {
  const wk = points.weekKey(now);
  return { ...row, points: points.pointsOf(m.member, wk), waiting: points.isWaiting(m.member, wk) };
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const CACHE_TTL_MS = 15 * 1000;

// 한 사람의 오늘 합계 · 최근 1시간 합계 · 마지막 스크롤 시각 (기기 구분 없이 합산)
//   perDevice: { deviceId: 그 기기의 마지막 업로드 시각 } — 구성원 상세의 기기별 줄에 씀
async function liveCounts(userId, now) {
  const dayStart = startOfKSTDay(toKSTDateString(now));
  const hourStart = now - ONE_HOUR_MS;
  // 자정 직후엔 1시간 전이 어제라서 둘 중 이른 쪽부터 읽는다 (sync.js 와 같은 이유)
  const from = Math.min(dayStart, hourStart);

  const snap = await db
    .collection("userLogs")
    .where("userId", "==", userId)
    .where("timestamp", ">=", from)
    .get();

  let todayCount = 0;
  let lastHourCount = 0;
  let latest = null;
  const perDevice = {};
  snap.forEach((doc) => {
    const l = doc.data();
    const n = Number(l.scrollCount) || 0;
    const ts = Number(l.timestamp) || 0;
    if (ts >= dayStart) todayCount += n;
    if (ts >= hourStart) lastHourCount += n;
    if (latest === null || ts > latest) latest = ts;
    const dev = l.deviceId || "legacy";
    if (!(perDevice[dev] >= ts)) perDevice[dev] = ts;
  });
  return { todayCount, lastHourCount, latestLogAt: latest, perDevice };
}

// 한 사람의 기기 목록 요약 (G11)
//   lastSeenAt    기기들 중 가장 최근 신호 (heartbeat · sync · register)
//   permissionsOk 로그인 중인 기기 중 하나라도 false 면 false, 전부 true 면 true, 모르면 null
//   loggedOut     기기가 있고 전부 로그아웃이면 true
async function deviceSummary(userId, snapIn = null) {
  // [11/12] 이미 읽은 기기 목록이 있으면 그걸 쓴다 (그룹 현황에서 수상 판정과 같이 쓰려고)
  const snap =
    snapIn ||
    (await db.collection("users").doc(userId).collection("devices").get());
  const devices = [];
  snap.forEach((doc) => {
    const d = doc.data();
    devices.push({
      deviceId: doc.id,
      deviceName: d.deviceName || null,
      registeredAt: d.registeredAt ?? null,
      lastSeenAt: d.lastSeenAt ?? null,
      lastScrollAt: d.lastScrollAt ?? null,
      loggedOutAt: d.loggedOutAt ?? null,
      permissionsOk: d.permissionsOk ?? null,
      permissionsOffSince: d.permissionsOffSince ?? null, // 권한이 꺼진 시각 (G11 "권한 꺼짐(… 이후)")
    });
  });
  devices.sort((a, b) => (a.registeredAt ?? 0) - (b.registeredAt ?? 0));

  let lastSeenAt = null;
  let permissionsOk = null;
  for (const d of devices) {
    if (
      d.lastSeenAt !== null &&
      (lastSeenAt === null || d.lastSeenAt > lastSeenAt)
    )
      lastSeenAt = d.lastSeenAt;
    if (d.loggedOutAt) continue; // 로그아웃한 기기의 권한 상태는 보지 않는다
    if (d.permissionsOk === false) permissionsOk = false;
    else if (d.permissionsOk === true && permissionsOk === null)
      permissionsOk = true;
  }
  const loggedOut = devices.length > 0 && devices.every((d) => d.loggedOutAt);
  const loggedOutAt = loggedOut
    ? Math.max(...devices.map((d) => d.loggedOutAt))
    : null;
  return { devices, lastSeenAt, permissionsOk, loggedOut, loggedOutAt };
}

function maxOrNull(a, b) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return Math.max(a, b);
}

// 그룹 구성원 전부의 숫자. 15초 캐시.
//   members: [{ userId, displayName, joinedAt }]  (이름은 호출하는 쪽에서 합쳐 넘긴다)
const cache = new Map(); // gid → { at, key, rows }
// [11/12 부하 테스트] 캐시가 비었을 때 10명이 동시에 부르면 10명 다 따로 계산했다 (10배 읽기 → 3~4초).
//   같은 그룹 · 같은 멤버 계산이 이미 돌고 있으면 그 결과를 같이 기다린다.
const inflight = new Map(); // gid → { key, promise }
async function memberRows(gid, members, now = Date.now()) {
  const key = members
    .map((m) => m.userId)
    .sort()
    .join(",");
  const byId = new Map(members.map((m) => [m.userId, m]));
  const hit = cache.get(gid);
  let raw;
  if (hit && hit.key === key && now - hit.at < CACHE_TTL_MS) {
    raw = hit.rows;
  } else {
    const run = inflight.get(gid);
    if (run && run.key === key) {
      raw = await run.promise;
    } else {
      const promise = computeRows(members, now);
      inflight.set(gid, { key, promise });
      try {
        raw = await promise;
        cache.set(gid, { at: now, key, rows: raw });
      } finally {
        if (inflight.get(gid)?.promise === promise) inflight.delete(gid);
      }
    }
  }
  // 캐시는 숫자만 재사용한다. 이름 · 점수는 매번 지금 값으로 — 닉네임을 바꾸면 15초 기다리지 않고 바로 보이게
  return raw.map((r) =>
    withPoints(
      {
        ...r,
        displayName: byId.get(r.userId).displayName,
        nickname: byId.get(r.userId).displayName,
        joinedAt: byId.get(r.userId).joinedAt ?? null,
      },
      byId.get(r.userId),
      now,
    ),
  );
}

async function computeRows(members, now) {
  const date = toKSTDateString(now);
  return Promise.all(
    members.map(async (m) => {
      // 멤버마다 읽기 3개를 한꺼번에: 오늘 기록 · 사용자 문서 · 기기 목록 (예전엔 사용자 문서 · 기기 목록을 두 번씩 읽었다)
      const uRef = db.collection("users").doc(m.userId);
      const [c, uSnap, devSnap] = await Promise.all([
        liveCounts(m.userId, now),
        uRef.get(),
        uRef.collection("devices").get(),
      ]);
      const u = uSnap.exists ? uSnap.data() : {};
      const dv = await deviceSummary(m.userId, devSnap);
      const el = presence.eligibilityFrom(u, devSnap.docs.map((d) => d.data()), date, now);
      return {
        userId: m.userId,
        displayName: m.displayName,
        nickname: m.displayName, // 앱 GroupApi 는 nickname 을 먼저 읽는다
        joinedAt: m.joinedAt ?? null,
        todayCount: c.todayCount,
        lastHourCount: c.lastHourCount,
        // 오늘 로그가 없으면 users 문서의 마지막 업로드 시각(/userlogs 가 갱신)으로
        lastScrollAt: maxOrNull(c.latestLogAt, u.lastScrollAt ?? null),
        lastSeenAt: dv.lastSeenAt,
        permissionsOk: dv.permissionsOk,
        loggedOut: dv.loggedOut,
        loggedOutAt: dv.loggedOutAt,
        // 오늘(지금까지) 수상 가능한가 — false 면 앱이 "오늘 제외" 뱃지 (로그아웃 · 권한 꺼짐 30분 · 공백 3시간)
        eligible: el.eligible,
        ineligibleReasons: el.reasons,
        countsUpdatedAt: now,
      };
    }),
  );
}

// 테스트·탈퇴 직후 등에서 캐시를 비울 때
function invalidate(gid) {
  cache.delete(gid);
  inflight.delete(gid);
}

// 한 사람의 오늘 팝업 수 (violations = 팝업에 답한 기록)
async function todayPopupCount(userId, now) {
  const dayStart = startOfKSTDay(toKSTDateString(now));
  const snap = await db
    .collection("violations")
    .where("userId", "==", userId)
    .where("timestamp", ">=", dayStart)
    .get();
  return snap.size;
}

// 그룹 한도가 그날 얼마였나 (9주차 — 투표로 한도가 바뀐 뒤에도 지난 날짜는 그때 한도로 칠하게)
//   goalHistory: [{ from, dailyLimit, hourlyLimit, prevDailyLimit, prevHourlyLimit }] (적용 순)
function goalOnDate(group, date) {
  const hist = (group.goalHistory || [])
    .slice()
    .sort((a, b) => a.from - b.from);
  const current = group.goal || {};
  if (hist.length === 0)
    return {
      dailyLimit: current.dailyLimit ?? null,
      hourlyLimit: current.hourlyLimit ?? null,
    };
  const dayStart = startOfKSTDay(date);
  let g = {
    dailyLimit: hist[0].prevDailyLimit,
    hourlyLimit: hist[0].prevHourlyLimit,
  };
  for (const h of hist)
    if (h.from <= dayStart)
      g = { dailyLimit: h.dailyLimit, hourlyLimit: h.hourlyLimit };
  return g;
}

// 최근 n일(오늘 포함) 날짜별 합계 — 구성원 상세의 last7Days
async function lastNDaysCounts(userId, n, now) {
  const today = toKSTDateString(now);
  const start = startOfKSTDay(today) - (n - 1) * 24 * 60 * 60 * 1000;
  const snap = await db
    .collection("userLogs")
    .where("userId", "==", userId)
    .where("timestamp", ">=", start)
    .get();
  const byDate = {};
  snap.forEach((doc) => {
    const l = doc.data();
    const date = toKSTDateString(Number(l.timestamp) || 0);
    byDate[date] = (byDate[date] || 0) + (Number(l.scrollCount) || 0);
  });
  const out = [];
  for (let i = 0; i < n; i++) {
    const date = toKSTDateString(start + i * 24 * 60 * 60 * 1000);
    out.push({ date, count: byDate[date] || 0 });
  }
  return out;
}

// 한 사람의 한 달 날짜별 합계 (G6 — 그룹 한도 기준 일간 통계 달력)
//   month: "YYYY-MM". 미래 날짜는 넣지 않는다.
async function monthlyDailyCounts(userId, month, now) {
  const start = startOfKSTDay(`${month}-01`);
  const [y, m] = month.split("-").map(Number);
  const next =
    m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const end = Math.min(startOfKSTDay(`${next}-01`), now + 1);
  const days = [];
  if (start > now) return days;

  const snap = await db
    .collection("userLogs")
    .where("userId", "==", userId)
    .where("timestamp", ">=", start)
    .where("timestamp", "<", end)
    .get();
  const byDate = {};
  snap.forEach((doc) => {
    const l = doc.data();
    const date = toKSTDateString(Number(l.timestamp) || 0);
    byDate[date] = (byDate[date] || 0) + (Number(l.scrollCount) || 0);
  });

  const today = toKSTDateString(now);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // 그 달의 마지막 날 (28~31)
  for (let d = 1; d <= lastDay; d++) {
    const date = `${month}-${String(d).padStart(2, "0")}`;
    if (date > today) break;
    days.push({ date, count: byDate[date] || 0 });
  }
  return days;
}

// 11/5 — 한 사람의 하루 (개인 /stats/{uid}/daily 와 같은 모양, POINTS_API.md §10)
//   totalScroll · hourlyGraph [{hour, scrollCount}] 24칸 · byPlatform
async function dayStats(userId, date) {
  const start = startOfKSTDay(date);
  const end = start + 24 * 60 * 60 * 1000;
  const snap = await db
    .collection("userLogs")
    .where("userId", "==", userId)
    .where("timestamp", ">=", start)
    .where("timestamp", "<", end)
    .get();
  const hourly = new Array(24).fill(0);
  const byPlatform = {};
  let total = 0;
  snap.forEach((doc) => {
    const l = doc.data();
    const n = Number(l.scrollCount) || 0;
    const h = new Date((Number(l.timestamp) || 0) + 9 * 60 * 60 * 1000).getUTCHours();
    hourly[h] += n;
    total += n;
    const p = l.platform || "youtube";
    byPlatform[p] = (byPlatform[p] || 0) + n;
  });
  return {
    totalScroll: total,
    hourlyGraph: hourly.map((scrollCount, hour) => ({ hour, scrollCount })),
    byPlatform,
  };
}

module.exports = {
  dayStats,
  liveCounts,
  deviceSummary,
  memberRows,
  invalidate,
  todayPopupCount,
  monthlyDailyCounts,
  lastNDaysCounts,
  goalOnDate,
  CACHE_TTL_MS,
};
