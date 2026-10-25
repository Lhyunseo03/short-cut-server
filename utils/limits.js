// ─────────────────────────────────────────────────────────────
// utils/limits.js — 개인 한도 읽기 · 예약 승격 (6주차, 한도 예약 동기화)
//
// Firestore 경로: limits/{uid}
//   hourlyLimit · dailyLimit       지금 적용 중인 한도
//   pendingHourlyLimit             예약된 새 시간당 한도 (없으면 null)
//   pendingDailyLimit              예약된 새 일간 한도 (없으면 null)
//   pendingEffectiveAt             예약이 적용되는 시각(ms) — 보통 다음 주 월요일 00:00 KST
//   updatedAt · promotedAt         마지막 저장 / 마지막 승격 시각
//
// 왜 서버가 승격하나 —
//   "다음 주 월요일부터" 예약이 바꾼 기기 로컬에만 있으면, 다른 기기는 월요일이 돼도
//   옛 한도를 쓴다. 예약을 서버에 두고, 읽는 순간 시각이 지났으면 서버가 현재 한도로 올린다.
//
// 승격 규칙 (앱 UserLimitDao 와 같음 — 10/4 정은과 합의)
//   새 시간당 = pendingHourlyLimit ?? hourlyLimit
//   새 일간   = pendingDailyLimit  ?? dailyLimit
//   그리고 pending 세 필드를 전부 null 로.
//   앱이 먼저 승격해서 POST 하든 서버가 먼저 하든 결과가 같다.
// ─────────────────────────────────────────────────────────────

const { db } = require("./firebase");

const PENDING_KEYS = [
  "pendingHourlyLimit",
  "pendingDailyLimit",
  "pendingEffectiveAt",
];

function limitsRef(userId) {
  return db.collection("limits").doc(userId);
}

// 앱에 내려보낼 모양. 필드가 없던 옛 문서도 null 로 채워서 준다.
function shape(userId, d) {
  return {
    userId,
    hourlyLimit: d.hourlyLimit ?? null,
    dailyLimit: d.dailyLimit ?? null,
    pendingHourlyLimit: d.pendingHourlyLimit ?? null,
    pendingDailyLimit: d.pendingDailyLimit ?? null,
    pendingEffectiveAt: d.pendingEffectiveAt ?? null,
    updatedAt: d.updatedAt ?? null,
  };
}

// 예약 시각이 지났는가
function isDue(d, now) {
  return typeof d.pendingEffectiveAt === "number" && now >= d.pendingEffectiveAt;
}

// 승격 결과 (쓰기용 필드)
function promotedFields(d, now) {
  return {
    hourlyLimit: d.pendingHourlyLimit ?? d.hourlyLimit,
    dailyLimit: d.pendingDailyLimit ?? d.dailyLimit,
    pendingHourlyLimit: null,
    pendingDailyLimit: null,
    pendingEffectiveAt: null,
    updatedAt: now,
    promotedAt: now,
  };
}

// 한도 읽기. 문서가 없으면 null.
// 예약 시각이 지났으면 **트랜잭션으로** 승격해서 저장하고 승격된 값을 준다.
// (두 기기가 동시에 읽어도 승격은 한 번만 일어나고, 둘 다 같은 값을 받는다)
async function readLimits(userId, now = Date.now()) {
  const ref = limitsRef(userId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  if (!isDue(snap.data(), now)) return shape(userId, snap.data());

  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) return null;
    const d = s.data();
    if (!isDue(d, now)) return shape(userId, d); // 그사이 다른 요청이 이미 승격함
    const p = promotedFields(d, now);
    tx.update(ref, p);
    return shape(userId, { ...d, ...p });
  });
}

// POST /limits body 에서 예약 필드를 꺼낸다.
//   필드가 아예 없음 → 건드리지 않음
//   null            → 예약 해제
//   숫자            → 저장 (한도는 1 이상 정수, 시각은 양수 ms)
// 반환: { error } 또는 { fields }
function parsePending(body) {
  const fields = {};
  for (const k of PENDING_KEYS) {
    if (!(k in body)) continue;
    const v = body[k];
    if (v === null) {
      fields[k] = null;
      continue;
    }
    if (k === "pendingEffectiveAt") {
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
        return { error: "pendingEffectiveAt 은 양수(Unix ms) 또는 null 이어야 합니다" };
      }
    } else if (!Number.isInteger(v) || v < 1) {
      return { error: `${k} 는 1 이상의 정수 또는 null 이어야 합니다` };
    }
    fields[k] = v;
  }
  return { fields };
}

module.exports = { limitsRef, readLimits, parsePending, isDue, promotedFields, PENDING_KEYS };
