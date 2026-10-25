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
async function deviceSummary(userId) {
  const snap = await db
    .collection("users")
    .doc(userId)
    .collection("devices")
    .get();
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
async function memberRows(gid, members, now = Date.now()) {
  const key = members
    .map((m) => m.userId)
    .sort()
    .join(",");
  const hit = cache.get(gid);
  if (hit && hit.key === key && now - hit.at < CACHE_TTL_MS) {
    // 캐시는 숫자만 재사용한다. 이름은 매번 지금 값으로 — 닉네임을 바꾸면 15초 기다리지 않고 바로 보이게
    const byId = new Map(members.map((m) => [m.userId, m]));
    return hit.rows.map((r) => ({
      ...r,
      displayName: byId.get(r.userId).displayName,
      nickname: byId.get(r.userId).displayName,
      joinedAt: byId.get(r.userId).joinedAt ?? null,
    }));
  }

  const ids = members.map((m) => m.userId);
  const userDocs = ids.length
    ? await db.getAll(...ids.map((u) => db.collection("users").doc(u)))
    : [];

  const rows = await Promise.all(
    members.map(async (m, i) => {
      const [c, dv] = await Promise.all([
        liveCounts(m.userId, now),
        deviceSummary(m.userId),
      ]);
      const u = userDocs[i] && userDocs[i].exists ? userDocs[i].data() : {};
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
        countsUpdatedAt: now,
      };
    }),
  );
  cache.set(gid, { at: now, key, rows });
  return rows;
}

// 테스트·탈퇴 직후 등에서 캐시를 비울 때
function invalidate(gid) {
  cache.delete(gid);
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

module.exports = {
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
