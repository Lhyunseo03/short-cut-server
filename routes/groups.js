// ─────────────────────────────────────────────────────────────
// routes/groups.js — 그룹 만들기 / 내 그룹 목록 / 그룹 상세 (제안서 G1~G3)
//s
// 1단계 범위: 그룹의 "뼈대"만. 초대·가입·탈퇴는 2단계, 랭킹·현황은 3단계.
//
// Firestore 경로
//   groups/{gid}
//     name          그룹 이름 (1~30자)
//     description   그룹 설명 — 초대받은 사람이 가입 전에 보는 글 (0~200자)
//     goal          { dailyLimit, hourlyLimit }  ← 이름 확정 (9/25 정은과 합의)
//     approvalRate  안건 통과에 필요한 찬성률 % (G9. 생성 시 정하고 이후 투표로만 변경)
//     maxMembers    정원 (기본 10 — NFR 상 status 집계 비용 때문에 상한을 둠)
//     memberCount   현재 인원. members 를 매번 세지 않으려고 캐시해 둔 값
//     createdBy     만든 사람 uid. **관리자가 아니다** — 표시용일 뿐 (G9 무관리자 모델)
//     createdAt     생성 시각(ms)
//
//   groups/{gid}/members/{userId}
//     userId        문서 ID 와 같음 (나중에 collectionGroup 질의를 쓸 때를 대비해 필드로도 둠)
//     displayName   가입 시점의 구글 계정 이름 (앱은 아무것도 안 보냄 — 서버가 꺼냄)
//     joinedAt      가입 시각(ms)
//     todayCount      \
//     lastHourCount   |  3단계에서 채우는 캐시. 지금은 0 으로 만들어만 둔다.
//     countsUpdatedAt |  (10명 × 30초마다 userLogs 집계는 NFR 2초를 못 지킴)
//     lastSeenAt      /
//
//   users/{uid}.groupIds : [gid, ...]
//     "내가 속한 그룹"을 찾기 위한 역방향 색인.
//     collectionGroup('members') 질의를 쓰면 복합 색인을 따로 등록해야 하는데,
//     한 사람이 드는 그룹 수가 많아야 몇 개라서 배열 하나로 충분하다.
//     arrayUnion / arrayRemove 로만 건드린다 (동시 수정에도 안전).
//
// ※ 관리자 개념이 없다 (G9). 그래서 이 파일에는 "권한 검사"가 없고,
//   대신 "그 그룹의 멤버인가?" 만 본다. 규칙 변경은 5~6주차의 투표로 처리한다.
// ─────────────────────────────────────────────────────────────

const express = require("express");
const { db, admin } = require("../utils/firebase");
const logger = require("../utils/logger");
const { verifyToken } = require("../middleware/auth");
// 표시 이름은 users/{uid}.nickname 한 곳에만 저장하고 읽을 때 합친다.
// (멤버 문서에 박아두면 닉네임 변경 시 가입한 그룹 수만큼 고쳐야 함)
const {
  saveNickname,
  resolveDisplayName,
  resolveDisplayNames,
} = require("../utils/nickname");
// 6주차 — 그룹 화면 숫자 (오늘 합계 · 최근 1시간 · 마지막 스크롤 · 마지막 접속)
const groupStats = require("../utils/groupStats");
const { toKSTDateString } = require("../utils/time");
// 9주차 — 월요일 한도 적용이 지났으면 읽기 전에 처리 (routes/proposals.js)
const { settle } = require("./proposals");

// 그룹 문서에 적용 시각이 지난 pendingGoal 이 있으면 적용하고 다시 읽는다.
// sweeper(1분)를 기다리지 않고 월요일 0시 직후 첫 조회부터 새 한도가 보이게.
async function freshGroupDoc(gDoc) {
  const g = gDoc.data();
  if (g && g.pendingGoal && Date.now() >= g.pendingGoal.effectiveAt) {
    await settle(gDoc.id);
    return gDoc.ref.get();
  }
  return gDoc;
}

const router = express.Router();

const MAX_MEMBERS_DEFAULT = 10;
const MAX_GROUPS_PER_USER = 5; // G1: 한 사람은 그룹 5개까지 (랭킹 집계 비용 상한 — NFR)
const MAX_MEMBERS_LIMIT = 20;

function groupsRef() {
  return db.collection("groups");
}
function membersRef(gid) {
  return groupsRef().doc(gid).collection("members");
}
function userRef(uid) {
  return db.collection("users").doc(uid);
}

// ─────────────────────────────────────────────────────────────
// 입력 검증 — 앱이 보낸 값을 그대로 믿지 않는다.
// 길이 상한을 두는 이유: 문서 크기·화면 깨짐 방지, 그리고 장난 입력 차단.
// ─────────────────────────────────────────────────────────────
function validateCreate(body) {
  const { name, description, goal, approvalRate, maxMembers } = body;

  if (
    typeof name !== "string" ||
    name.trim().length === 0 ||
    name.trim().length > 30
  ) {
    return { error: "name 은 1~30자 문자열이어야 합니다" };
  }
  if (
    description !== undefined &&
    (typeof description !== "string" || description.length > 200)
  ) {
    return { error: "description 은 200자 이하 문자열이어야 합니다" };
  }
  if (!goal || typeof goal !== "object") {
    return { error: "goal { dailyLimit, hourlyLimit } 이 필요합니다" };
  }

  const { dailyLimit, hourlyLimit } = goal;
  for (const [k, v] of [
    ["dailyLimit", dailyLimit],
    ["hourlyLimit", hourlyLimit],
  ]) {
    if (!Number.isInteger(v) || v < 1 || v > 100000) {
      return { error: `goal.${k} 은 1 이상의 정수여야 합니다` };
    }
  }
  // 시간당 한도가 하루 한도보다 크면 시간당 한도가 영원히 안 걸린다 → 사용자 실수일 가능성이 높다
  if (hourlyLimit > dailyLimit) {
    return { error: "goal.hourlyLimit 은 dailyLimit 보다 클 수 없습니다" };
  }

  if (
    !Number.isInteger(approvalRate) ||
    approvalRate < 1 ||
    approvalRate > 100
  ) {
    return { error: "approvalRate 는 1~100 사이의 정수여야 합니다" };
  }

  if (maxMembers !== undefined) {
    if (
      !Number.isInteger(maxMembers) ||
      maxMembers < 2 ||
      maxMembers > MAX_MEMBERS_LIMIT
    ) {
      return {
        error: `maxMembers 는 2~${MAX_MEMBERS_LIMIT} 사이의 정수여야 합니다`,
      };
    }
  }
  return null;
}

// 앱에 내려보낼 그룹 요약 형태
function toGroupSummary(doc) {
  const d = doc.data();
  return {
    groupId: doc.id,
    name: d.name,
    description: d.description || "",
    goal: d.goal,
    approvalRate: d.approvalRate,
    memberCount: d.memberCount ?? 0,
    maxMembers: d.maxMembers ?? MAX_MEMBERS_DEFAULT,
    createdAt: d.createdAt,
    // 9주차 — 투표로 통과해 다음 주 월요일에 적용될 한도 (없으면 null)
    pendingGoal: d.pendingGoal ?? null,
    lockedUntil: d.lockedUntil ?? null,
  };
}

// ═════════════════════════════════════════════════════════════
// POST /groups   { name, description?, goal:{dailyLimit,hourlyLimit}, approvalRate, maxMembers? }
// ═════════════════════════════════════════════════════════════
// 만든 사람은 그 자리에서 첫 멤버가 된다. 그룹만 있고 멤버가 0명인 상태를 만들지 않으려고
// 그룹 문서 · 멤버 문서 · users.groupIds 세 개를 **배치 하나로** 쓴다.
// (셋 중 하나만 성공해서 "목록에는 뜨는데 못 들어가는 그룹" 이 생기는 걸 막는다)
router.post("/groups", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;

    const bad = validateCreate(req.body);
    if (bad) return res.status(400).json(bad);

    const { name, description, goal, approvalRate, maxMembers, nickname } =
      req.body;
    const now = Date.now();

    // 앱이 nickname 을 보내면 users/{uid}.nickname 에 저장하고 그 값을 쓴다.
    // 안 보냈거나 형식이 이상하면 저장된 닉네임 → 구글 이름 → 이메일 앞부분 순.
    // 닉네임이 이상하다고 그룹 생성을 400 으로 막지는 않는다.
    // [9주차] 한 사람은 그룹 5개까지 (G1)
    const uSnap = await userRef(userId).get();
    const myGroups = (uSnap.exists ? uSnap.data().groupIds : null) || [];
    if (myGroups.length >= MAX_GROUPS_PER_USER) {
      return res
        .status(409)
        .json({
          error: `그룹은 ${MAX_GROUPS_PER_USER}개까지 참여할 수 있어요`,
        });
    }

    const displayName =
      (await saveNickname(userId, nickname)) ||
      (await resolveDisplayName(userId));

    const gRef = groupsRef().doc(); // 문서 ID 자동 생성
    const batch = db.batch();

    batch.set(gRef, {
      name: name.trim(),
      description: (description || "").trim(),
      goal: {
        dailyLimit: goal.dailyLimit,
        hourlyLimit: goal.hourlyLimit,
      },
      approvalRate,
      maxMembers: maxMembers ?? MAX_MEMBERS_DEFAULT,
      memberCount: 1,
      createdBy: userId, // 관리자가 아님. 표시용
      createdAt: now,
    });

    batch.set(membersRef(gRef.id).doc(userId), {
      userId,
      displayName,
      joinedAt: now,
      // 3단계 랭킹용 캐시 자리. 지금은 0 — 앱이 null 을 만나 터지지 않게 미리 만들어 둔다.
      todayCount: 0,
      lastHourCount: 0,
      lastScrollAt: null,
      countsUpdatedAt: now,
      lastSeenAt: now,
    });

    // merge: true — users/{uid} 문서에는 blockUntil · lastShownMilestone 등이 이미 있다.
    batch.set(
      userRef(userId),
      { groupIds: admin.firestore.FieldValue.arrayUnion(gRef.id) },
      { merge: true },
    );

    await batch.commit();

    logger.success(
      `그룹 생성 — gid: ${gRef.id}, name: ${name.trim()}, by: ${userId}`,
    );
    const created = await gRef.get();
    res.status(201).json({ status: "ok", group: toGroupSummary(created) });
  } catch (err) {
    logger.error(`그룹 생성 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
// GET /groups — 내가 속한 그룹 목록
// ═════════════════════════════════════════════════════════════
// users/{uid}.groupIds 를 읽고 그 문서들만 가져온다.
// getAll 로 한 번에 읽어서 왕복 횟수를 줄인다 (그룹 수만큼 순차 get 하면 느리다).
router.get("/groups", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;

    const uDoc = await userRef(userId).get();
    const ids = (uDoc.exists ? uDoc.data().groupIds : null) || [];

    if (ids.length === 0) {
      return res.json({ count: 0, maxGroups: MAX_GROUPS_PER_USER, groups: [] });
    }

    const rawDocs = await db.getAll(...ids.map((id) => groupsRef().doc(id)));
    // [9주차] 월요일 적용이 지난 그룹은 적용 후 다시 읽는다 — 앱이 여기서 그룹 한도를 받아 저장하므로
    const docs = await Promise.all(
      rawDocs.map((d) => (d.exists ? freshGroupDoc(d) : d)),
    );

    // [6주차] 그룹 카드의 "내 오늘 카운트" — 모든 기기 합계. 그룹마다 같은 값이라 한 번만 센다
    const { todayCount } = await groupStats.liveCounts(userId, Date.now());

    // 이미 사라진 그룹 ID 가 배열에 남아 있을 수 있다 (탈퇴·해체 경합).
    // 목록에서 조용히 뺀다.
    const groups = docs
      .filter((d) => d.exists)
      .map((d) => ({ ...toGroupSummary(d), myTodayCount: todayCount }));
    groups.sort((a, b) => b.createdAt - a.createdAt); // 최근 만든 것부터

    res.json({ count: groups.length, maxGroups: MAX_GROUPS_PER_USER, groups });
  } catch (err) {
    logger.error(`그룹 목록 조회 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 공통 — 그룹이 있고 내가 멤버인지 확인. 문제가 있으면 { status, error }
// ─────────────────────────────────────────────────────────────
async function loadGroupAsMember(gid, userId) {
  if (typeof gid !== "string" || gid.length === 0 || gid.length > 128) {
    return { status: 400, error: "groupId 가 잘못되었습니다" };
  }
  const raw = await groupsRef().doc(gid).get();
  if (!raw.exists) return { status: 404, error: "존재하지 않는 그룹입니다" };
  // 멤버 여부 확인 — 관리자 개념이 없으므로 검사는 이것 하나뿐
  const meDoc = await membersRef(gid).doc(userId).get();
  if (!meDoc.exists) return { status: 403, error: "이 그룹의 멤버가 아닙니다" };
  const gDoc = await freshGroupDoc(raw); // 9주차: 월요일 적용이 지났으면 반영
  return { gDoc };
}

// 멤버 목록 + 표시 이름. 가입순.
// 표시 이름은 읽는 시점에 users/{uid}.nickname 에서 합친다.
// 멤버 문서의 displayName 은 nickname 이 없을 때 쓰는 예비값 (1단계에 만들어진 옛 데이터).
async function namedMembers(gid) {
  const snap = await membersRef(gid).get();
  const ids = [];
  const fallbacks = {};
  const joined = {};
  snap.forEach((doc) => {
    ids.push(doc.id);
    const m = doc.data();
    if (m.displayName && m.displayName !== "이름 없음")
      fallbacks[doc.id] = m.displayName;
    joined[doc.id] = m.joinedAt ?? null;
  });
  const names = await resolveDisplayNames(ids, fallbacks);
  return ids
    .map((uid) => ({
      userId: uid,
      displayName: names.get(uid) || "이름 없음",
      joinedAt: joined[uid],
    }))
    .sort((a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0));
}

// 멤버 행에 isMe 를 붙인다 (캐시된 행은 여러 사람이 같이 쓰므로 복사해서 붙인다)
function withIsMe(rows, userId) {
  return rows.map((r) => ({ ...r, isMe: r.userId === userId }));
}

// ═════════════════════════════════════════════════════════════
// GET /groups/:gid — 그룹 상세 + 멤버 목록
// ═════════════════════════════════════════════════════════════
// 멤버가 아니면 403. 초대 링크로 들어온 사람에게 보여줄 "가입 전 미리보기"는
// GET /invites/{code} 가 따로 담당한다 (거기선 인원수·설명만 보여준다).
//
// 숫자만 내려보낸다 — rank · isOverDaily · lastSeenText 는 앱이 계산한다 (9/25 합의).
// 6주차부터 todayCount · lastHourCount · lastScrollAt · lastSeenAt 이 **실제 값**이다
// (예전엔 멤버 문서에 0 으로 만들어 둔 자리였다). 계산은 utils/groupStats.js.
router.get("/groups/:gid", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { gid } = req.params;
    const g = await loadGroupAsMember(gid, userId);
    if (g.error) return res.status(g.status).json({ error: g.error });

    const now = Date.now();
    const members = await namedMembers(gid);
    const rows = await groupStats.memberRows(gid, members, now);

    res.json({
      group: toGroupSummary(g.gDoc),
      memberCount: rows.length,
      members: withIsMe(rows, userId),
      serverTime: now,
    });
  } catch (err) {
    logger.error(`그룹 상세 조회 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
// GET /groups/:gid/status — 그룹 페이지(랭킹) 30초 새로고침용 (G4 · G11)
// ═════════════════════════════════════════════════════════════
// 앱 GroupApi.fetchGroupStatus 가 30초마다 부른다. 그룹 요약 없이 숫자만.
// 같은 그룹을 여러 명이 동시에 열어도 15초 안에는 계산을 다시 하지 않는다.
router.get("/groups/:gid/status", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { gid } = req.params;
    const g = await loadGroupAsMember(gid, userId);
    if (g.error) return res.status(g.status).json({ error: g.error });

    const now = Date.now();
    const members = await namedMembers(gid);
    const rows = await groupStats.memberRows(gid, members, now);
    const goal = g.gDoc.data().goal || null;

    res.json({
      groupId: gid,
      goal, // 앱이 빨강/초록(일간) · 종(시간당) 판단에 쓴다
      date: toKSTDateString(now),
      members: withIsMe(rows, userId),
      serverTime: now,
    });
  } catch (err) {
    logger.error(`그룹 현황 조회 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
// GET /groups/:gid/members/:uid — 구성원 상세 (G5 · G11)
// ═════════════════════════════════════════════════════════════
// 오늘 스크롤 수 · 팝업 수 · 최근 1시간, 그리고 기기당 한 줄
// (마지막 접속 / 마지막 스크롤 / 로그아웃 / 권한 꺼짐).
// 보는 사람도, 보이는 사람도 이 그룹의 멤버여야 한다.
router.get("/groups/:gid/members/:uid", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { gid, uid } = req.params;
    const g = await loadGroupAsMember(gid, userId);
    if (g.error) return res.status(g.status).json({ error: g.error });

    if (typeof uid !== "string" || uid.length === 0 || uid.length > 128) {
      return res.status(400).json({ error: "userId 가 잘못되었습니다" });
    }
    const target = await membersRef(gid).doc(uid).get();
    if (!target.exists) {
      return res.status(404).json({ error: "이 그룹의 멤버가 아닙니다" });
    }

    const now = Date.now();
    const fallback = target.data().displayName;
    const [name, counts, dev, popups, uDoc, week] = await Promise.all([
      resolveDisplayName(
        uid,
        fallback && fallback !== "이름 없음" ? fallback : undefined,
      ),
      groupStats.liveCounts(uid, now),
      groupStats.deviceSummary(uid),
      groupStats.todayPopupCount(uid, now),
      userRef(uid).get(),
      groupStats.lastNDaysCounts(uid, 7, now), // 정은 계약: last7Days
    ]);
    const gData = g.gDoc.data();
    const u = uDoc.exists ? uDoc.data() : {};

    // 기기별 마지막 스크롤: 기기 문서(/userlogs 가 갱신) 와 오늘 로그 중 더 최근 값
    const devices = dev.devices.map((d) => {
      const fromLogs = counts.perDevice[d.deviceId] ?? null;
      const lastScrollAt =
        d.lastScrollAt === null
          ? fromLogs
          : fromLogs === null
            ? d.lastScrollAt
            : Math.max(d.lastScrollAt, fromLogs);
      return {
        deviceId: d.deviceId,
        deviceName: d.deviceName,
        lastSeenAt: d.lastSeenAt,
        lastScrollAt,
        loggedOutAt: d.loggedOutAt,
        permissionsOk: d.permissionsOk,
        permissionsOffSince: d.permissionsOffSince,
      };
    });

    const lastScrollAt = [counts.latestLogAt, u.lastScrollAt ?? null]
      .filter((v) => v !== null && v !== undefined)
      .reduce((a, b) => Math.max(a, b), -Infinity);

    res.json({
      groupId: gid,
      goal: g.gDoc.data().goal || null,
      member: {
        userId: uid,
        displayName: name,
        nickname: name,
        joinedAt: target.data().joinedAt ?? null,
        isMe: uid === userId,
        todayCount: counts.todayCount,
        lastHourCount: counts.lastHourCount,
        todayPopupCount: popups,
        todayPopups: popups, // 앱 GroupApi 가 읽는 이름
        lastScrollAt: lastScrollAt === -Infinity ? null : lastScrollAt,
        lastSeenAt: dev.lastSeenAt,
        permissionsOk: dev.permissionsOk,
        loggedOut: dev.loggedOut,
        loggedOutAt: dev.loggedOutAt,
        devices,
        // 최근 7일 (오늘 포함) + 그날 그룹 일간 한도 — 상세 화면 막대 7개
        last7Days: week.map((d) => ({
          ...d,
          dailyLimit: groupStats.goalOnDate(gData, d.date).dailyLimit,
        })),
      },
      date: toKSTDateString(now),
      serverTime: now,
    });
  } catch (err) {
    logger.error(`구성원 상세 조회 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
// GET /groups/:gid/members/:uid/daily?month=YYYY-MM — 구성원 일간 통계 (G6)
// ═════════════════════════════════════════════════════════════
// 한 달 날짜별 스크롤 합계 + 그룹 한도. 앱이 그룹 일간 한도와 비교해
// 이하 = 초록 / 초과 = 빨강 으로 칠한다. month 를 안 주면 이번 달(KST).
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
router.get("/groups/:gid/members/:uid/daily", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { gid, uid } = req.params;
    const g = await loadGroupAsMember(gid, userId);
    if (g.error) return res.status(g.status).json({ error: g.error });

    if (typeof uid !== "string" || uid.length === 0 || uid.length > 128) {
      return res.status(400).json({ error: "userId 가 잘못되었습니다" });
    }
    const target = await membersRef(gid).doc(uid).get();
    if (!target.exists) {
      return res.status(404).json({ error: "이 그룹의 멤버가 아닙니다" });
    }

    const now = Date.now();
    const month = req.query.month ?? toKSTDateString(now).slice(0, 7);
    if (!MONTH_RE.test(month)) {
      return res
        .status(400)
        .json({ error: "month 는 YYYY-MM 형식이어야 합니다" });
    }

    const gData = g.gDoc.data();
    const days = (await groupStats.monthlyDailyCounts(uid, month, now)).map(
      (d) => ({
        ...d,
        // 9주차: 그날 적용 중이던 그룹 일간 한도 (투표로 바뀌기 전 날짜는 옛 한도)
        dailyLimit: groupStats.goalOnDate(gData, d.date).dailyLimit,
      }),
    );
    const goal = gData.goal || null;
    res.json({
      groupId: gid,
      userId: uid,
      month,
      goal, // 지금 그룹 한도
      days, // [{ date: "2026-10-01", count: 37, dailyLimit: 200 }, ...] 오늘까지 — 색은 그날 dailyLimit 과 비교
      serverTime: now,
    });
  } catch (err) {
    logger.error(`구성원 일간 통계 조회 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = {
  router,
  groupsRef,
  membersRef,
  MAX_MEMBERS_DEFAULT,
  MAX_GROUPS_PER_USER,
};
