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
// [11/14 정산 수정] "공백" = 그 사이에 앱을 지웠다 깔았을 때만 센다.
//   ① 처음 보는 기기(newDevice)에서 온 신호 — 앱을 지웠다 깔면(또는 앱 데이터 삭제) deviceId 가 새로 생긴다
//   ② 기기가 보낸 앱 설치 시각(installedAt)이 직전 신호보다 뒤 — 백업 복원으로 deviceId 가 그대로여도 잡힌다 (11/6 규칙)
//   그 밖의 신호 끊김(밤 절전 · 폰 꺼짐 · 오래 오프라인)은 공백이 아니다 — 그동안은 어차피 스크롤도 못 한다.
//   11/9~11/12 정산에서 전원이 "공백"으로 빠진 원인: 밤 절전으로 신호가 몇 시간씩 끊기는 걸 전부 공백으로 셌다.
//   (11/11 의 installedAt 보정은 설치 시각을 보내는 최신 앱에만 먹었다 → 옛 앱 사용자는 계속 빠짐)
// opts: { installedAt: 그 기기의 설치 시각(모르면 null), newDevice: 이번 신호가 새 기기 등록인가 }
async function noteAlive(userId, now = Date.now(), opts = {}) {
  const { installedAt = null, newDevice = false } = opts || {};
  const ref = db.collection("users").doc(userId);
  const snap = await ref.get();
  const u = snap.exists ? snap.data() : {};
  const last = typeof u.aliveAt === "number" ? u.aliveAt : null;
  const update = { aliveAt: now };
  const reinstalled =
    newDevice || (typeof installedAt === "number" && installedAt > 0 && last !== null && last < installedAt);
  if (last !== null && now - last > ALIVE_GRACE_MS && reinstalled) {
    update.gapMs = addToDayMap(u.gapMs, splitByDay(last + ALIVE_GRACE_MS, now), now);
  }
  await ref.set(update, { merge: true });
}

// 그날 공백 ms — 저장된 것(재설치로 생긴 공백) + 아직 신호가 끊겨 있는 구간
// [11/14] 아직 끊겨 있는 구간은 **그날 신호가 한 번도 없었을 때만** 센다 (= 하루 종일 공백).
//   그날 신호가 있었으면 마지막 신호 뒤는 봐준다 — 저녁에 폰을 두고 자면 00:05 정산 때까지 신호가 없어서
//   전원이 빠지던 문제. 앱을 지우고 다시 안 깔면 다음 날은 신호가 0 이라 하루 전체 공백 → 그날부터 제외.
function gapMsOnDate(userData, date, now) {
  const u = userData || {};
  // 신호가 한 번도 없었던 사람 (배포 뒤 앱을 한 번도 안 켬 · 이미 지운 사람) — 하루 전체를 공백으로
  if (typeof u.aliveAt !== "number") return DAY_MS;
  let ms = (u.gapMs || {})[date] || 0;
  if (u.aliveAt < startOfKSTDay(date)) {
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
  return eligibilityFrom(uSnap.exists ? uSnap.data() : {}, devSnap.docs.map((d) => d.data()), date, now);
}

// [11/12] 사용자 문서 · 기기 목록을 이미 읽었으면 다시 안 읽고 판정 (그룹 현황 계산용)
function eligibilityFrom(userData, devices, date, now = Date.now()) {
  const u = userData || {};
  const reasons = [];
  if ((u.logoutDays || {})[date]) reasons.push("logout");
  for (const d of devices || []) {
    if (permOffMsOnDate(d, date, now) >= PERM_OFF_LIMIT_MS) {
      if (!reasons.includes("permissions")) reasons.push("permissions");
    }
  }
  const gapMs = gapMsOnDate(u, date, now);
  if (gapMs >= GAP_LIMIT_MS) reasons.push("gap");
  return { eligible: reasons.length === 0, reasons, gapMs }; // gapMs: 정산 로그에 몇 시간이었는지 찍으려고
}

module.exports = {
  noteAlive,
  noteLogout,
  permissionUpdate,
  permOffMsOnDate,
  gapMsOnDate,
  eligibility,
  eligibilityFrom,
  splitByDay,
  PERM_OFF_LIMIT_MS,
  GAP_LIMIT_MS,
  ALIVE_GRACE_MS,
};
