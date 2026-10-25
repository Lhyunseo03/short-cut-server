// ─────────────────────────────────────────────────────────────
// routes/proposals.js — 그룹 한도 변경 제안 · 투표 · 월요일 적용 (8~9주차, G9)
//
// 규칙 (제안서 G9)
//   · 누구나 새 일간 / 시간당 한도를 제안할 수 있다. **구성원당 주 1회**
//   · 그룹당 **열린 제안은 하나만**. 등록은 그룹 문서 트랜잭션 → 동시에 눌러도 하나만 생긴다
//   · 투표는 최대 24시간, **유권자 전원이 투표하면 조기 마감**
//   · 제안자 = 찬성, 미투표 = 반대. **찬성 ≥ ⌈유권자 수 × 찬성률⌉ 이면 통과**
//   · 유권자는 제안 시점 구성원으로 고정. 투표 중 나간 사람은 표와 분모에서 모두 빠진다.
//     투표 중 들어온 사람은 이번엔 투표권 없음 (canVote: false)
//   · 통과한 한도는 **다음 주 월요일 00:00 KST** 에 적용. 그때까지 그 그룹은 새 제안 잠금
//
// Firestore
//   proposals/{pid}
//     groupId · proposedBy · dailyLimit · hourlyLimit · createdAt · closesAt
//     electorate [uid]       제안 시점 구성원 (나가면 여기서 빠짐)
//     votes { uid: "yes"|"no" }
//     status "open" | "passed" | "rejected" · closedAt · result { yes, no, electorate, required }
//   groups/{gid} 에 추가
//     openProposalId         지금 열린 제안 (없으면 null)
//     pendingGoal            { dailyLimit, hourlyLimit, effectiveAt } 통과 후 적용 대기
//     lockedUntil            통과한 주의 잠금 끝 (= pendingGoal.effectiveAt)
//     goalHistory            [{ from, dailyLimit, hourlyLimit, prevDailyLimit, prevHourlyLimit }] — 일간 통계 달력용
//   groups/{gid}/members/{uid}.lastProposalWeek   이번 주 제안 사용 여부 ("2026-10-19" = 그 주 월요일)
//
// 마감 · 적용은 "누가 읽을 때" (settle) + 1분마다 도는 sweeper 가 처리한다.
// 서버가 마감 시각에 정확히 깨어날 방법이 없어서(Railway 에 예약 작업 없음) 둘을 같이 쓴다.
// ─────────────────────────────────────────────────────────────

const express = require("express");
const { db, admin } = require("../utils/firebase");
const logger = require("../utils/logger");
const { verifyToken } = require("../middleware/auth");
const { resolveDisplayName } = require("../utils/nickname");
const { pushToGroup } = require("../utils/groupPush");
const { nextMondayKST, weekKey } = require("../utils/week");
const groupStats = require("../utils/groupStats");

const router = express.Router();

const VOTE_WINDOW_MS = 24 * 60 * 60 * 1000;

const groupRef = (gid) => db.collection("groups").doc(gid);
const memberRef = (gid, uid) => groupRef(gid).collection("members").doc(uid);
const proposalsRef = () => db.collection("proposals");

// 집계 — 지금 유권자 기준
function tally(p, approvalRate) {
  const electorate = p.electorate || [];
  const votes = p.votes || {};
  let yes = 0;
  let no = 0;
  for (const u of electorate) {
    if (votes[u] === "yes") yes++;
    else if (votes[u] === "no") no++;
  }
  const n = electorate.length;
  const required = Math.ceil((n * (approvalRate ?? 100)) / 100);
  return { yes, no, electorate: n, required, allVoted: yes + no === n };
}

// ─────────────────────────────────────────────────────────────
// settle — 이 그룹의 시간이 지난 일을 처리한다. 트랜잭션 하나.
//   ① pendingGoal 적용 시각이 지났으면 → goal 교체 · 잠금 해제     → LIMIT_APPLIED
//   ② 열린 제안이 24시간 지났거나 전원 투표했으면 → 마감 · 집계     → VOTE_RESULT
// 반환: 트랜잭션 뒤에 보낼 알림 목록
// ─────────────────────────────────────────────────────────────
async function settle(gid, now = Date.now()) {
  const events = await db.runTransaction(async (tx) => {
    const gSnap = await tx.get(groupRef(gid));
    if (!gSnap.exists) return [];
    const g = gSnap.data();
    let pSnap = null;
    if (g.openProposalId) pSnap = await tx.get(proposalsRef().doc(g.openProposalId));
    // ── 읽기 끝. 여기부터 쓰기 ──

    const out = [];
    const gUpdate = {};
    let goal = g.goal;

    // ① 월요일 적용
    if (g.pendingGoal && now >= g.pendingGoal.effectiveAt) {
      const pg = g.pendingGoal;
      const newGoal = { dailyLimit: pg.dailyLimit, hourlyLimit: pg.hourlyLimit };
      gUpdate.goal = newGoal;
      gUpdate.pendingGoal = null;
      gUpdate.lockedUntil = null;
      gUpdate.goalHistory = admin.firestore.FieldValue.arrayUnion({
        from: pg.effectiveAt,
        dailyLimit: newGoal.dailyLimit,
        hourlyLimit: newGoal.hourlyLimit,
        prevDailyLimit: goal?.dailyLimit ?? null,
        prevHourlyLimit: goal?.hourlyLimit ?? null,
      });
      goal = newGoal;
      out.push({ kind: "applied", goal: newGoal });
    }

    // ② 투표 마감
    if (pSnap && pSnap.exists && pSnap.data().status === "open") {
      const p = pSnap.data();
      const t = tally(p, g.approvalRate);
      if (now >= p.closesAt || t.allVoted || t.electorate === 0) {
        const passed = t.electorate > 0 && t.yes >= t.required;
        // 마감 시각 = 전원 투표면 지금, 시간 만료면 원래 마감 시각 (늦게 처리돼도 같은 주로 계산)
        const closedAt = t.allVoted ? now : Math.min(now, p.closesAt);
        tx.update(pSnap.ref, {
          status: passed ? "passed" : "rejected",
          closedAt,
          result: { yes: t.yes, no: t.no, electorate: t.electorate, required: t.required },
        });
        gUpdate.openProposalId = null;
        if (passed) {
          const effectiveAt = nextMondayKST(closedAt);
          gUpdate.pendingGoal = {
            dailyLimit: p.dailyLimit,
            hourlyLimit: p.hourlyLimit,
            effectiveAt,
          };
          gUpdate.lockedUntil = effectiveAt;
        }
        out.push({ kind: "result", passed, p, t });
      }
    } else if (g.openProposalId && (!pSnap || !pSnap.exists || pSnap.data().status !== "open")) {
      gUpdate.openProposalId = null; // 가리키는 제안이 이미 닫혔으면 정리
    }

    if (Object.keys(gUpdate).length) tx.update(groupRef(gid), gUpdate);
    return out.map((e) => ({ ...e, groupName: g.name || "그룹" }));
  });

  // ── 알림은 트랜잭션 밖에서 (트랜잭션이 재시도되면 두 번 나가므로) ──
  for (const e of events) {
    if (e.kind === "applied") {
      logger.success(`그룹 한도 적용 — gid: ${gid}, 일 ${e.goal.dailyLimit} / 시 ${e.goal.hourlyLimit}`);
      pushToGroup(gid, null, {
        type: "LIMIT_APPLIED",
        groupName: e.groupName,
        title: `${e.groupName} · 새 한도 적용`,
        body: `이번 주부터 그룹 한도가 일 ${e.goal.dailyLimit} / 시 ${e.goal.hourlyLimit} 로 바뀌었어요`,
      });
    } else if (e.kind === "result") {
      logger.success(
        `투표 마감 — gid: ${gid}, ${e.passed ? "통과" : "부결"} (찬성 ${e.t.yes}/${e.t.electorate}, 필요 ${e.t.required})`,
      );
      pushToGroup(gid, null, {
        type: "VOTE_RESULT",
        groupName: e.groupName,
        title: `${e.groupName} · 투표 ${e.passed ? "통과" : "부결"}`,
        body: e.passed
          ? `일 ${e.p.dailyLimit} / 시 ${e.p.hourlyLimit} 이 통과했어요 (찬성 ${e.t.yes}/${e.t.electorate}). 다음 주 월요일부터 적용돼요`
          : `일 ${e.p.dailyLimit} / 시 ${e.p.hourlyLimit} 제안이 부결됐어요 (찬성 ${e.t.yes}명, 필요 ${e.t.required}명)`,
        extra: { passed: e.passed },
      });
    }
  }
  if (events.length) groupStats.invalidate(gid);
  return events;
}

// 그룹 있고 내가 멤버인지
async function loadAsMember(gid, userId) {
  if (typeof gid !== "string" || gid.length === 0 || gid.length > 128) {
    return { status: 400, error: "groupId 가 잘못되었습니다" };
  }
  const g = await groupRef(gid).get();
  if (!g.exists) return { status: 404, error: "존재하지 않는 그룹입니다" };
  const me = await memberRef(gid, userId).get();
  if (!me.exists) return { status: 403, error: "이 그룹의 멤버가 아닙니다" };
  return { g: g.data(), me: me.data() };
}

function validLimits(daily, hourly) {
  for (const [k, v] of [["dailyLimit", daily], ["hourlyLimit", hourly]]) {
    if (!Number.isInteger(v) || v < 1 || v > 100000) return `${k} 은 1 이상의 정수여야 합니다`;
  }
  if (hourly > daily) return "hourlyLimit 은 dailyLimit 보다 클 수 없습니다";
  return null;
}

// ═════════════════════════════════════════════════════════════
// GET /groups/:gid/proposal — 제안 버튼 상태 + 열린 제안
// ═════════════════════════════════════════════════════════════
// state: "open"(투표 중) > "passed"(이번 주 통과, 월요일 대기) > "used"(내가 이번 주 제안함) > "none"
async function proposalStatus(gid, userId, now) {
  await settle(gid, now);
  const m = await loadAsMember(gid, userId);
  if (m.error) return m;
  const g = m.g;

  let proposal = null;
  if (g.openProposalId) {
    const pSnap = await proposalsRef().doc(g.openProposalId).get();
    if (pSnap.exists && pSnap.data().status === "open") {
      const p = pSnap.data();
      const t = tally(p, g.approvalRate);
      const inElectorate = (p.electorate || []).includes(userId);
      proposal = {
        proposalId: pSnap.id,
        proposedBy: p.proposedBy,
        proposedByName: await resolveDisplayName(p.proposedBy),
        dailyLimit: p.dailyLimit,
        hourlyLimit: p.hourlyLimit,
        goal: { dailyLimit: p.dailyLimit, hourlyLimit: p.hourlyLimit },
        createdAt: p.createdAt,
        closesAt: p.closesAt,
        yes: t.yes,
        no: t.no,
        electorate: t.electorate,
        required: t.required,
        myVote: inElectorate ? (p.votes || {})[userId] ?? null : null,
        canVote: inElectorate,
      };
    }
  }

  let state = "none";
  if (proposal) state = "open";
  else if (g.lockedUntil && g.lockedUntil > now) state = "passed";
  else if (m.me.lastProposalWeek === weekKey(now)) state = "used";

  return {
    body: {
      groupId: gid,
      state,
      proposal,
      lockedUntil: g.lockedUntil && g.lockedUntil > now ? g.lockedUntil : null,
      pendingGoal: g.pendingGoal || null,
      goal: g.goal || null,
      approvalRate: g.approvalRate ?? null,
      serverTime: now,
    },
  };
}

router.get("/groups/:gid/proposal", verifyToken, async (req, res) => {
  try {
    const r = await proposalStatus(req.params.gid, req.userId, Date.now());
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json(r.body);
  } catch (err) {
    logger.error(`제안 상태 조회 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
// POST /groups/:gid/proposals  { dailyLimit, hourlyLimit }  — 제안 등록
// ═════════════════════════════════════════════════════════════
async function createProposal(req, res) {
  try {
    const userId = req.userId;
    const { gid } = req.params;
    const daily = req.body.dailyLimit ?? req.body.goal?.dailyLimit;
    const hourly = req.body.hourlyLimit ?? req.body.goal?.hourlyLimit;
    const bad = validLimits(daily, hourly);
    if (bad) return res.status(400).json({ error: bad });

    const now = Date.now();
    await settle(gid, now); // 끝난 투표 · 지난 잠금부터 정리하고 판단

    const m = await loadAsMember(gid, userId);
    if (m.error) return res.status(m.status).json({ error: m.error });

    const wk = weekKey(now);
    const pRef = proposalsRef().doc();

    const result = await db.runTransaction(async (tx) => {
      const gSnap = await tx.get(groupRef(gid));
      const meSnap = await tx.get(memberRef(gid, userId));
      const membersSnap = await tx.get(groupRef(gid).collection("members"));
      if (!gSnap.exists) return { status: 404, error: "존재하지 않는 그룹입니다" };
      if (!meSnap.exists) return { status: 403, error: "이 그룹의 멤버가 아닙니다" };
      const g = gSnap.data();

      // 순서: 진행 중 → 이번 주 통과 잠금 → 내 주간 할당 → 같은 한도
      if (g.openProposalId) return { status: 409, error: "진행 중인 투표가 있어요" };
      if (g.lockedUntil && g.lockedUntil > now) {
        return { status: 409, error: "다음 주 한도 투표가 이미 끝났습니다" };
      }
      if (meSnap.data().lastProposalWeek === wk) {
        return { status: 409, error: "이번 주 제안을 이미 사용했습니다" };
      }
      if (g.goal && g.goal.dailyLimit === daily && g.goal.hourlyLimit === hourly) {
        return { status: 400, error: "지금 한도와 같아요" };
      }

      const electorate = membersSnap.docs.map((d) => d.id);
      tx.set(pRef, {
        groupId: gid,
        proposedBy: userId,
        dailyLimit: daily,
        hourlyLimit: hourly,
        createdAt: now,
        closesAt: now + VOTE_WINDOW_MS,
        electorate,
        votes: { [userId]: "yes" }, // 제안자는 찬성으로 센다
        status: "open",
      });
      tx.update(groupRef(gid), { openProposalId: pRef.id });
      tx.update(memberRef(gid, userId), { lastProposalWeek: wk });
      return { status: 201, groupName: g.name || "그룹", electorate: electorate.length };
    });

    if (result.error) return res.status(result.status).json({ error: result.error });

    logger.success(`한도 제안 — gid: ${gid}, by: ${userId}, 일 ${daily} / 시 ${hourly}, 유권자 ${result.electorate}명`);
    res.status(201).json({ status: "ok", proposalId: pRef.id });

    const name = await resolveDisplayName(userId);
    pushToGroup(gid, userId, {
      type: "PROPOSAL",
      groupName: result.groupName,
      title: `${result.groupName} · 한도 변경 제안`,
      body: `${name} 님이 일 ${daily} / 시 ${hourly} 로 바꾸자고 제안했어요. 24시간 안에 투표해 주세요`,
      extra: { proposalId: pRef.id },
    });
    // 혼자인 그룹이면 제안자 표만으로 전원 투표 → 바로 마감
    if (result.electorate === 1) await settle(gid);
  } catch (err) {
    logger.error(`제안 등록 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}
router.post("/groups/:gid/proposals", verifyToken, createProposal);
router.post("/groups/:gid/proposal", verifyToken, createProposal); // 편지에 적힌 주소도 받는다

// ═════════════════════════════════════════════════════════════
// POST /proposals/:pid/vote  { vote: "yes"|"no" }  (또는 { agree: true|false })
// ═════════════════════════════════════════════════════════════
async function vote(userId, pid, approve, res) {
  const now = Date.now();
  const pRef = proposalsRef().doc(pid);

  const result = await db.runTransaction(async (tx) => {
    const pSnap = await tx.get(pRef);
    if (!pSnap.exists) return { status: 404, error: "없는 제안입니다" };
    const p = pSnap.data();
    const meSnap = await tx.get(memberRef(p.groupId, userId));

    if (p.status !== "open" || now >= p.closesAt) {
      return { status: 409, error: "투표가 마감됐어요" };
    }
    if (!meSnap.exists || !(p.electorate || []).includes(userId)) {
      return { status: 403, error: "이번 투표의 투표권이 없어요" };
    }
    if ((p.votes || {})[userId]) return { status: 409, error: "이미 투표했어요" };

    tx.update(pRef, { [`votes.${userId}`]: approve ? "yes" : "no" });
    return { status: 200, gid: p.groupId };
  });

  if (result.error) return res.status(result.status).json({ error: result.error });
  logger.success(`투표 — proposal: ${pid}, user: ${userId}, ${approve ? "찬성" : "반대"}`);
  await settle(result.gid, now); // 전원 투표면 여기서 마감
  res.json({ status: "ok" });
}

function parseApprove(body) {
  if (body.vote === "yes" || body.vote === "no") return body.vote === "yes";
  if (typeof body.agree === "boolean") return body.agree;
  return null;
}

router.post("/proposals/:pid/vote", verifyToken, async (req, res) => {
  try {
    const approve = parseApprove(req.body);
    if (approve === null) return res.status(400).json({ error: 'vote 는 "yes" 또는 "no" 여야 합니다' });
    const pid = req.params.pid;
    if (typeof pid !== "string" || pid.length === 0 || pid.length > 128) {
      return res.status(400).json({ error: "proposalId 가 잘못되었습니다" });
    }
    await vote(req.userId, pid, approve, res);
  } catch (err) {
    logger.error(`투표 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// 편지에 적힌 주소: POST /groups/:gid/proposal/vote { agree } — 그 그룹의 열린 제안에 투표
router.post("/groups/:gid/proposal/vote", verifyToken, async (req, res) => {
  try {
    const approve = parseApprove(req.body);
    if (approve === null) return res.status(400).json({ error: "agree 는 true 또는 false 여야 합니다" });
    await settle(req.params.gid);
    const m = await loadAsMember(req.params.gid, req.userId);
    if (m.error) return res.status(m.status).json({ error: m.error });
    if (!m.g.openProposalId) return res.status(404).json({ error: "진행 중인 투표가 없어요" });
    await vote(req.userId, m.g.openProposalId, approve, res);
  } catch (err) {
    logger.error(`투표 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 탈퇴 처리 — invites.js 의 탈퇴가 끝난 뒤 부른다 (G9 "투표 중 구성원 변동")
// 나간 사람은 이미 투표했어도 표와 분모에서 모두 뺀다 (5명 중 1명 탈퇴 → 분모 4).
// 그 결과 남은 사람이 전부 투표한 상태가 되면 settle 이 바로 마감한다.
// ─────────────────────────────────────────────────────────────
async function onMemberLeft(gid, userId) {
  try {
    const g = await groupRef(gid).get();
    if (!g.exists || !g.data().openProposalId) return;
    const pRef = proposalsRef().doc(g.data().openProposalId);
    await db.runTransaction(async (tx) => {
      const p = await tx.get(pRef);
      if (!p.exists || p.data().status !== "open") return;
      tx.update(pRef, {
        electorate: admin.firestore.FieldValue.arrayRemove(userId),
        [`votes.${userId}`]: admin.firestore.FieldValue.delete(),
      });
    });
    await settle(gid);
  } catch (err) {
    logger.error(`탈퇴자 투표 정리 실패 — gid: ${gid}, ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// sweeper — 1분마다. 아무도 그룹을 안 열어도 마감 · 월요일 적용이 제때 일어나게.
// 단일 필드 조건 두 개라 Firestore 기본 색인으로 된다 (복합 색인 등록 불필요).
// ─────────────────────────────────────────────────────────────
let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const now = Date.now();
    const [open, due] = await Promise.all([
      db.collection("groups").where("openProposalId", "!=", null).get(),
      db.collection("groups").where("pendingGoal.effectiveAt", "<=", now).get(),
    ]);
    const ids = new Set([...open.docs.map((d) => d.id), ...due.docs.map((d) => d.id)]);
    for (const gid of ids) {
      const g = open.docs.concat(due.docs).find((d) => d.id === gid).data();
      // 열린 제안이 아직 안 끝났고 적용할 것도 없으면 건너뛴다 (트랜잭션 아끼기)
      const p = g.openProposalId ? await proposalsRef().doc(g.openProposalId).get() : null;
      const pDue = p && p.exists && (now >= p.data().closesAt || p.data().status !== "open");
      const gDue = g.pendingGoal && now >= g.pendingGoal.effectiveAt;
      if (pDue || gDue || (g.openProposalId && (!p || !p.exists))) await settle(gid, now);
    }
  } catch (err) {
    logger.error(`투표 sweeper 실패 — ${err.message}`);
  } finally {
    sweeping = false;
  }
}
function startSweeper(intervalMs = 60 * 1000) {
  const t = setInterval(sweep, intervalMs);
  if (t.unref) t.unref();
  return t;
}

module.exports = { router, settle, onMemberLeft, startSweeper, sweep, tally };
