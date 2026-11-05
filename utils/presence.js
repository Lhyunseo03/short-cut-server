// ─────────────────────────────────────────────────────────────
// utils/presence.js — 포인트 정산 "수상 제외" 판정용 기록 (11/5, POINTS_API.md §4-1)
//
// 그날 수상에서 빠지는 세 가지
//   ① 로그아웃 기록         users/{uid}.logoutDays.{YYYY-MM-DD} = true
//   ② 권한 꺼짐 ≥ 30분      users/{uid}/devices/{d}.permOffMs.{YYYY-MM-DD} = 그날 꺼져 있던 ms (기기별)
//   ③ 신호 공백 ≥ 3시간     users/{uid}.gapMs.{YYYY-MM-DD} = 그날 아무 기기에서도 신호가 없던 ms
//
// ③ 은 사람 단위다 — 기기 두 대 중 하나만 살아 있어도 공백이 아니다 ("전부가 동시에 끊긴 시간").
//   "신호" = heartbeat · /sync · 기기 등록. heartbeat 는 10분 간격이라 15분까지는 공백으로 안 친다.
//   (앱을 지우거나 폰을 끄면 신호가 끊긴다 → 안 그러면 0회로 매일 1등)
//
// 날짜 칸은 오래 쌓이지 않게 최근 14일만 남긴다.
// ─────────────────────────────────────────────────────────────

const { db, admin } = require("./firebase");
const { toKSTDateString, startOfKSTDay } = require("./time");

const DAY_MS = 24 * 60 * 60 * 1000;
const ALIVE_GRACE_MS = 15 * 60 * 1000; // heartbeat 10분 + 여유 5분
const KEEP_DAYS = 14;

// [from, to) 구간을 KST 날짜별로 나눠 { date: ms } 로
function splitByDay(from, to) {
  const out = {};
  let t = from;
  while (t < to) {
    const date = toKSTDateString(t);
    const end = Math.min(startOfKSTDay(date) + DAY_MS, to);
    out[date] = (out[date] || 0) + (end - t);
    t = end;
  }
  return out;
}

// 구간 [a, b) 와 그 날짜의 겹치는 ms
function overlapWithDay(a, b, date) {
  const s = startOfKSTDay(date);
  const e = s + DAY_MS;
  return Math.max(0, Math.min(b, e) - Math.max(a, s));
}

// 맵에 더하고 오래된 날짜는 지운 새 맵
function addToDayMap(map, add, now) {
  const out = { ...(map || {}) };
  for (const [d, ms] of Object.entries(add)) out[d] = (out[d] || 0) + ms;
  const cutoff = toKSTDateString(now - KEEP_DAYS * DAY_MS);
  for (const d of Object.keys(out)) if (d < cutoff) delete out[d];
  return out;
}

// ─────────────────────────────────────────────────────────────
// ③ 신호 — heartbeat · sync · register 가 부른다. 실패해도 본 요청엔 영향 없게 호출부에서 catch.
// ─────────────────────────────────────────────────────────────
async function noteAlive(userId, now = Date.now()) {
  const ref = db.collection("users").doc(userId);
  const snap = await ref.get();
  const u = snap.exists ? snap.data() : {};
  const last = typeof u.aliveAt === "number" ? u.aliveAt : null;
  const update = { aliveAt: now };
  if (last !== null && now - last > ALIVE_GRACE_MS) {
    update.gapMs = addToDayMap(u.gapMs, splitByDay(last + ALIVE_GRACE_MS, now), now);
  }
  await ref.set(update, { merge: true });
}

// 그날 공백 ms — 저장된 것 + (지금도 끊겨 있으면) 마지막 신호 뒤 그날 안쪽
function gapMsOnDate(userData, date, now) {
  const u = userData || {};
  // 신호가 한 번도 없었던 사람 (배포 뒤 앱을 한 번도 안 켬 · 이미 지운 사람) — 하루 전체를 공백으로
  if (typeof u.aliveAt !== "number") return DAY_MS;
  let ms = (u.gapMs || {})[date] || 0;
  if (typeof u.aliveAt === "number") {
    const from = u.aliveAt + ALIVE_GRACE_MS;
    if (now > from) ms += overlapWithDay(from, now, date);
  }
  return ms;
}

// ─────────────────────────────────────────────────────────────
// ② 권한 꺼짐 — heartbeat · register 가 기기 문서에 쓸 필드를 만든다
//   prev: 기기 문서의 지금 값, permissionsOk: 이번에 온 값(undefined 면 변화 없음)
//   permAccountedAt: 꺼짐 시간을 어디까지 permOffMs 에 넣었나
// ─────────────────────────────────────────────────────────────
function permissionUpdate(prev, permissionsOk, now) {
  const p = prev || {};
  const out = {};
  // 지금까지 꺼져 있었으면 그 구간을 먼저 쌓는다
  if (p.permissionsOk === false) {
    const from = Math.max(p.permAccountedAt ?? 0, p.permissionsOffSince ?? 0);
    if (from > 0 && now > from) out.permOffMs = addToDayMap(p.permOffMs, splitByDay(from, now), now);
    out.permAccountedAt = now;
  }
  if (permissionsOk === undefined) return out;
  out.permissionsOk = permissionsOk;
  if (permissionsOk === true) {
    out.permissionsOffSince = null;
  } else {
    // 켜짐 → 꺼짐: 지금부터. 꺼짐 유지: 처음 꺼진 시각 유지
    out.permissionsOffSince =
      p.permissionsOk === false && p.permissionsOffSince ? p.permissionsOffSince : now;
    out.permAccountedAt = now;
  }
  return out;
}

// 기기 하나의 그날 꺼짐 ms — 저장된 것 + (지금도 꺼져 있으면) 아직 안 쌓은 구간
function permOffMsOnDate(device, date, now) {
  const d = device || {};
  let ms = (d.permOffMs || {})[date] || 0;
  if (d.permissionsOk === false && !d.loggedOutAt) {
    const from = Math.max(d.permAccountedAt ?? 0, d.permissionsOffSince ?? 0);
    if (from > 0 && now > from) ms += overlapWithDay(from, now, date);
  }
  return ms;
}

// ─────────────────────────────────────────────────────────────
// ① 로그아웃 — POST /logout 이 부른다
// ─────────────────────────────────────────────────────────────
async function noteLogout(userId, now = Date.now()) {
  await db
    .collection("users")
    .doc(userId)
    .set({ logoutDays: { [toKSTDateString(now)]: true } }, { merge: true });
}

// ─────────────────────────────────────────────────────────────
// 판정 — 그날 수상 가능한가. 기준값은 상수로 (POINTS_API.md: 나중에 바꿀 수 있게)
// ─────────────────────────────────────────────────────────────
const PERM_OFF_LIMIT_MS = 30 * 60 * 1000;
const GAP_LIMIT_MS = 3 * 60 * 60 * 1000;

async function eligibility(userId, date, now = Date.now()) {
  const [uSnap, devSnap] = await Promise.all([
    db.collection("users").doc(userId).get(),
    db.collection("users").doc(userId).collection("devices").get(),
  ]);
  const u = uSnap.exists ? uSnap.data() : {};
  const reasons = [];
  if ((u.logoutDays || {})[date]) reasons.push("logout");
  devSnap.forEach((doc) => {
    if (permOffMsOnDate(doc.data(), date, now) >= PERM_OFF_LIMIT_MS) {
      if (!reasons.includes("permissions")) reasons.push("permissions");
    }
  });
  if (gapMsOnDate(u, date, now) >= GAP_LIMIT_MS) reasons.push("gap");
  return { eligible: reasons.length === 0, reasons };
}

module.exports = {
  noteAlive,
  noteLogout,
  permissionUpdate,
  permOffMsOnDate,
  gapMsOnDate,
  eligibility,
  splitByDay,
  PERM_OFF_LIMIT_MS,
  GAP_LIMIT_MS,
  ALIVE_GRACE_MS,
};
