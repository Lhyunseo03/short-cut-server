// ─────────────────────────────────────────────────────────────
// routes/groupAlerts.js — 그룹 한도 초과 알림 · 넛지 (7주차, G7 · G8)
//
// POST /groups/:gid/alerts  { type | kind: "daily"|"hourly", count }
//   앱이 "내가 이 그룹 한도를 넘었다" 고 보고 → 나머지 멤버에게 FCM GROUP_ALERT
//   (넘은 본인은 앱이 G2 확인 팝업을 띄운다 — 서버는 본인에게 안 보낸다)
//
// POST /groups/:gid/nudge   { targetId | targetUserId }
//   지금 시간당 그룹 한도를 넘고 있는 멤버에게 FCM NUDGE
//
// Firestore
//   groups/{gid}/alerts/{uid}_{YYYY-MM-DD}_daily        ← 일간: 그룹당 하루 1번
//   groups/{gid}/alerts/{uid}_{YYYY-MM-DD}_hourly_{HH}  ← 시간당: 그룹당 시(clock hour)당 1번
//     문서 ID 를 이렇게 정해 두면 앱이 재전송해도 create() 가 "이미 있음" 으로 실패해서
//     **두 번째 푸시가 안 나간다** (NFR: 그룹 알림 중복 없음)
//   groups/{gid}/nudges/{from}_{to}  { lastAt }          ← 보낸 사람–받는 사람 쌍당 10분 1번
// ─────────────────────────────────────────────────────────────

const express = require("express");
const { db } = require("../utils/firebase");
const logger = require("../utils/logger");
const { verifyToken } = require("../middleware/auth");
const { resolveDisplayName } = require("../utils/nickname");
const { toKSTDateString } = require("../utils/time");
const { pushToGroup, pushToUsers } = require("../utils/groupPush");
const { liveCounts } = require("../utils/groupStats");
const groupStats = require("../utils/groupStats");
// 11/5 포인트 — 벌금 장부 (utils/points.js)
const points = require("../utils/points");
const { startOfKSTDay } = require("../utils/time");

const router = express.Router();

const NUDGE_INTERVAL_MS = 10 * 60 * 1000; // G7: 쌍당 10분
const KST_OFFSET = 9 * 60 * 60 * 1000;

function groupRef(gid) {
  return db.collection("groups").doc(gid);
}

// 그룹이 있고 내가 멤버인지. 문제면 { status, error }
async function loadAsMember(gid, userId) {
  if (typeof gid !== "string" || gid.length === 0 || gid.length > 128) {
    return { status: 400, error: "groupId 가 잘못되었습니다" };
  }
  const g = await groupRef(gid).get();
  if (!g.exists) return { status: 404, error: "존재하지 않는 그룹입니다" };
  const me = await groupRef(gid).collection("members").doc(userId).get();
  if (!me.exists) return { status: 403, error: "이 그룹의 멤버가 아닙니다" };
  return { g: g.data() };
}

// ═════════════════════════════════════════════════════════════
// POST /groups/:gid/alerts — 그룹 한도 팝업 1건 = 벌금 (G8 + 11/5 포인트, POINTS_API.md §1)
//   { alertId, type: "hourly"|"daily", count, stage, at }
//   → 200 { status, points, delta, sent, reason? }
//      points = 이 그룹에서 내 이번 주 점수(차감 후, 대기면 null) · delta = 이번 차감(0 = 안 깎음)
// ═════════════════════════════════════════════════════════════
// 차감 안 하는 경우 (delta 0)
//   below-limit     count < 그룹 한도 (진짜 초과가 아님 — 기록도 안 남김)
//   duplicate       같은 alertId 가 이미 있음 (앱 재전송)
//   duplicate-stage 기기 두 대가 같은 단계를 따로 보냄 — 같은 (사람, 종류, 단계)가
//                   시간당은 60분 안, 일간은 같은 날 (11/3 정은 추가)
//   waiting         주중 가입자 (그 주는 게임 밖)
// 차감은 alert 마다, 다른 멤버 푸시는 예전처럼 일간 하루 1번 · 시간당 시(時)마다 1번.
const ALERT_ID_RE = /^[A-Za-z0-9_-]{8,100}$/;
const MAX_AT_AGE_MS = 8 * 24 * 60 * 60 * 1000; // 앱은 7일 지난 alert 는 버린다

router.post("/groups/:gid/alerts", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { gid } = req.params;
    const kind = req.body.type ?? req.body.kind; // 앱 코드는 type, 편지엔 kind — 둘 다 받는다
    const count = req.body.count;

    if (kind !== "daily" && kind !== "hourly") {
      return res.status(400).json({ error: 'type 은 "daily" 또는 "hourly" 여야 합니다' });
    }
    if (!Number.isInteger(count) || count < 0) {
      return res.status(400).json({ error: "count 는 0 이상의 정수여야 합니다" });
    }
    const stage = Number.isInteger(req.body.stage) && req.body.stage >= 0 ? req.body.stage : null;
    if (req.body.alertId !== undefined && !(typeof req.body.alertId === "string" && ALERT_ID_RE.test(req.body.alertId))) {
      return res.status(400).json({ error: "alertId 형식이 잘못되었습니다" });
    }

    const m = await loadAsMember(gid, userId);
    if (m.error) return res.status(m.status).json({ error: m.error });

    const now = Date.now();
    // 팝업 시각 — 앱 TrustedClock. 이상한 값이면 지금으로 (미래 5분 이상 · 8일 이상 지난 값)
    const rawAt = req.body.at;
    const at =
      typeof rawAt === "number" && rawAt <= now + 5 * 60 * 1000 && rawAt >= now - MAX_AT_AGE_MS ? rawAt : now;
    const date = toKSTDateString(at);
    const hh = String(new Date(at + KST_OFFSET).getUTCHours()).padStart(2, "0");
    // alertId 를 안 보내는 옛 앱은 예전 규칙(일간 1/일 · 시간당 1/시)으로 묶는다
    const alertId =
      req.body.alertId ?? (kind === "daily" ? `legacy_${userId}_${date}_daily` : `legacy_${userId}_${date}_hourly_${hh}`);

    const limit = kind === "daily" ? m.g.goal?.dailyLimit : m.g.goal?.hourlyLimit;
    const curWeek = points.weekKey(now);
    // 앱은 count >= 한도 일 때 보낸다. 그 아래면 넘은 게 아니므로 아무것도 안 한다.
    // 서버 카운트로 다시 확인하지는 않는다 — 업로드가 1분 늦게 도착해 진짜 초과를 거절할 수 있어서.
    if (!Number.isInteger(limit) || count < limit) {
      const me = await groupRef(gid).collection("members").doc(userId).get();
      return res.json({
        status: "ok", sent: false, reason: "below-limit", limit: limit ?? null,
        points: points.pointsOf(me.data(), curWeek), delta: 0,
      });
    }

    const mRef = groupRef(gid).collection("members").doc(userId);
    const aRef = groupRef(gid).collection("alerts").doc(alertId);
    const kRef = stage === null ? null : groupRef(gid).collection("alertKeys").doc(`${userId}_${kind}_${stage}`);
    // 벌금이 들어갈 날: 팝업 날짜. 이미 정산된 날이면 다음 날 (돈이 사라지지 않게)
    const candidates = [...new Set([date, points.nextDate(date), toKSTDateString(now)])].sort();

    const result = await db.runTransaction(async (tx) => {
      // ── 읽기 전부 먼저 ──
      const aSnap = await tx.get(aRef);
      const mSnap = await tx.get(mRef);
      const kSnap = kRef ? await tx.get(kRef) : null;
      const pSnaps = [];
      for (const d of candidates) pSnaps.push(await tx.get(points.potRef(gid, d)));
      if (!mSnap.exists) return { status: 403, error: "이 그룹의 멤버가 아닙니다" };
      const member = mSnap.data();

      if (aSnap.exists) {
        return { reason: "duplicate", delta: 0, member, potDate: aSnap.data().potDate ?? date };
      }

      let i = candidates.findIndex((d, idx) => d >= date && !(pSnaps[idx].exists && pSnaps[idx].data().settled));
      if (i < 0) i = candidates.length - 1; // 셋 다 정산됐을 일은 없지만 — 그럼 오늘로
      const potDate = candidates[i];
      const wk = points.weekKey(startOfKSTDay(potDate));

      let reason = null;
      if (points.isWaiting(member, wk)) reason = "waiting";
      else if (kSnap && kSnap.exists) {
        const k = kSnap.data();
        if (kind === "hourly" && Math.abs(at - k.lastAt) < points.HOURLY_DUP_WINDOW_MS) reason = "duplicate-stage";
        if (kind === "daily" && k.date === date) reason = "duplicate-stage";
      }

      const fine = reason ? 0 : points.FINE[kind];
      tx.set(aRef, {
        alertId, userId, kind, type: kind, count, stage, at, date, limit,
        delta: -fine, potDate, reason, receivedAt: now,
      });
      let after = member;
      if (fine > 0) {
        const wp = points.addPoints(member, wk, -fine);
        tx.update(mRef, { weekPoints: wp });
        after = { ...member, weekPoints: wp };
        const pi = pSnaps[i];
        tx.set(points.potRef(gid, potDate), { date: potDate, fines: ((pi.exists && pi.data().fines) || 0) + fine }, { merge: true });
        if (kRef) tx.set(kRef, { userId, kind, stage, lastAt: at, date });
      }
      return { reason, delta: -fine, member: after, potDate };
    });

    if (result.error) return res.status(result.status).json({ error: result.error });
    if (result.delta !== 0) groupStats.invalidate(gid);
    const myPoints = points.pointsOf(result.member, curWeek);

    // ── 다른 멤버 푸시: 예전 규칙 그대로 (일간 하루 1번 · 시간당 시마다 1번) ──
    let sent = false;
    if (result.reason !== "duplicate") {
      const pushId = kind === "daily" ? `${userId}_${date}_daily` : `${userId}_${date}_hourly_${hh}`;
      try {
        await groupRef(gid).collection("pushKeys").doc(pushId).create({ userId, kind, date, sentAt: now });
        sent = true;
      } catch (e) {
        if (!(e.code === 6 || /already exists/i.test(e.message))) throw e;
      }
    }

    res.json({ status: "ok", points: myPoints, delta: result.delta, sent, reason: result.reason ?? undefined, alertId });

    logger.success(
      `그룹 한도 팝업 — gid: ${gid}, user: ${userId}, ${kind} ${count}/${limit} stage ${stage ?? "-"}, ` +
        `${result.delta}점${result.reason ? ` (${result.reason})` : ""} → ${myPoints ?? "대기"}, 벌금통 ${result.potDate}`,
    );
    if (sent) {
      const name = await resolveDisplayName(userId);
      const groupName = m.g.name || "그룹";
      pushToGroup(gid, userId, {
        type: "GROUP_ALERT",
        groupName,
        title: `${groupName} · 한도 초과`,
        body:
          kind === "daily"
            ? `${name} 님이 오늘 ${count}개로 일간 한도(${limit})를 넘었어요`
            : `${name} 님이 최근 1시간 ${count}개로 시간당 한도(${limit})를 넘었어요`,
        extra: { userId, kind },
      });
    }
  } catch (err) {
    logger.error(`그룹 한도 초과 보고 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
// POST /groups/:gid/nudge — 넛지 (G7)
// ═════════════════════════════════════════════════════════════
// 조건 ① 둘 다 이 그룹 멤버 ② 자기 자신 아님
//      ③ 대상이 **지금** 시간당 그룹 한도에 닿아 있음 (최근 1시간 ≥ 시간당 한도 — 앱의 종 표시와 같은 기준)
//         → 그만 보면 1시간 안에 저절로 대상에서 빠진다. 하루 종일 독촉당하지 않는다
//      ④ 같은 사람에게 10분 안에 또 못 보냄 (쌍마다 따로 — A→C 와 B→C 는 독립)
// ④는 트랜잭션: 두 번 빠르게 눌러도 한 번만 나간다.
router.post("/groups/:gid/nudge", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { gid } = req.params;
    const targetId = req.body.targetId ?? req.body.targetUserId;

    if (typeof targetId !== "string" || targetId.length === 0 || targetId.length > 128) {
      return res.status(400).json({ error: "targetId 가 필요합니다" });
    }
    if (targetId === userId) {
      return res.status(400).json({ error: "자기 자신에게는 보낼 수 없어요" });
    }

    const m = await loadAsMember(gid, userId);
    if (m.error) return res.status(m.status).json({ error: m.error });

    const target = await groupRef(gid).collection("members").doc(targetId).get();
    if (!target.exists) return res.status(404).json({ error: "이 그룹의 멤버가 아닙니다" });

    const now = Date.now();
    const hourlyLimit = m.g.goal?.hourlyLimit;
    const { lastHourCount } = await liveCounts(targetId, now);
    if (!Number.isInteger(hourlyLimit) || lastHourCount < hourlyLimit) {
      return res.status(409).json({
        error: "지금은 넛지를 보낼 수 없어요 (시간당 한도를 넘고 있을 때만)",
        lastHourCount,
        hourlyLimit: hourlyLimit ?? null,
      });
    }

    const pairRef = groupRef(gid).collection("nudges").doc(`${userId}_${targetId}`);
    const wait = await db.runTransaction(async (tx) => {
      const p = await tx.get(pairRef);
      const last = p.exists ? p.data().lastAt : 0;
      if (now - last < NUDGE_INTERVAL_MS) return NUDGE_INTERVAL_MS - (now - last);
      tx.set(pairRef, { from: userId, to: targetId, lastAt: now });
      return 0;
    });
    if (wait > 0) {
      const min = Math.ceil(wait / 60000);
      return res.status(429).json({ error: `${min}분 뒤에 다시 보낼 수 있어요`, retryAfterMs: wait });
    }

    const name = await resolveDisplayName(userId);
    const groupName = m.g.name || "그룹";
    res.json({ status: "ok" });

    logger.success(`넛지 — gid: ${gid}, ${userId} → ${targetId} (최근 1시간 ${lastHourCount}/${hourlyLimit})`);
    pushToUsers([targetId], {
      type: "NUDGE",
      groupId: gid,
      groupName,
      title: `${groupName} · 넛지`,
      body: `${name} 님이 넛지를 보냈어요. 최근 1시간 ${lastHourCount}개 — 잠깐 쉬어 볼까요?`,
      extra: { fromUserId: userId },
    });
  } catch (err) {
    logger.error(`넛지 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, NUDGE_INTERVAL_MS };
