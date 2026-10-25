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
// POST /groups/:gid/alerts — 그룹 한도 초과 보고 (G8)
// ═════════════════════════════════════════════════════════════
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

    const m = await loadAsMember(gid, userId);
    if (m.error) return res.status(m.status).json({ error: m.error });

    const limit = kind === "daily" ? m.g.goal?.dailyLimit : m.g.goal?.hourlyLimit;
    // 앱은 count >= 한도 일 때 보낸다 (checkGroupLimits). 그 아래면 넘은 게 아니므로 안 보낸다.
    // 서버 카운트로 다시 확인하지는 않는다 — 업로드가 1분 늦게 도착해 진짜 초과를 거절할 수 있어서.
    if (!Number.isInteger(limit) || count < limit) {
      return res.json({ status: "ok", sent: false, reason: "below-limit", limit: limit ?? null });
    }

    const now = Date.now();
    const date = toKSTDateString(now);
    const hh = String(new Date(now + KST_OFFSET).getUTCHours()).padStart(2, "0");
    const alertId =
      kind === "daily" ? `${userId}_${date}_daily` : `${userId}_${date}_hourly_${hh}`;

    try {
      // create() — 이미 있으면 실패. 이게 중복 방지의 전부다 (트랜잭션 없이도 원자적)
      await groupRef(gid).collection("alerts").doc(alertId).create({
        userId, kind, count, limit, date, hour: kind === "hourly" ? hh : null, sentAt: now,
      });
    } catch (e) {
      if (e.code === 6 || /already exists/i.test(e.message)) {
        return res.json({ status: "ok", sent: false, reason: "duplicate", alertId });
      }
      throw e;
    }

    const name = await resolveDisplayName(userId);
    const groupName = m.g.name || "그룹";
    res.status(201).json({ status: "ok", sent: true, alertId });

    logger.success(`그룹 한도 초과 — gid: ${gid}, user: ${userId}, ${kind} ${count}/${limit}`);
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
