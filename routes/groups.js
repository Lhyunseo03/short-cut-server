// ─────────────────────────────────────────────────────────────
// routes/groups.js — 그룹 만들기 / 내 그룹 목록 / 그룹 상세 (제안서 G1~G3)
//
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

const router = express.Router();

const MAX_MEMBERS_DEFAULT = 10;
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

// 구글 계정 이름을 서버가 직접 꺼낸다 (앱 변경 없음 — 9/22 합의).
// 이름이 없는 계정도 있어서 이메일 앞부분 → "이름 없음" 순으로 대체한다.
async function resolveDisplayName(uid) {
  try {
    const user = await admin.auth().getUser(uid);
    if (user.displayName) return user.displayName;
    if (user.email) return user.email.split("@")[0];
  } catch (err) {
    logger.error(`displayName 조회 실패 — uid: ${uid}, ${err.message}`);
  }
  return "이름 없음";
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

    const { name, description, goal, approvalRate, maxMembers } = req.body;
    const now = Date.now();
    const displayName = await resolveDisplayName(userId);

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
      return res.json({ count: 0, groups: [] });
    }

    const docs = await db.getAll(...ids.map((id) => groupsRef().doc(id)));

    // 이미 사라진 그룹 ID 가 배열에 남아 있을 수 있다 (탈퇴·해체 경합).
    // 목록에서 조용히 빼고, 배열 정리는 2단계 탈퇴 로직에서 한다.
    const groups = docs.filter((d) => d.exists).map(toGroupSummary);
    groups.sort((a, b) => b.createdAt - a.createdAt); // 최근 만든 것부터

    res.json({ count: groups.length, groups });
  } catch (err) {
    logger.error(`그룹 목록 조회 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
// GET /groups/:gid — 그룹 상세 + 멤버 목록
// ═════════════════════════════════════════════════════════════
// 멤버가 아니면 403. 초대 링크로 들어온 사람에게 보여줄 "가입 전 미리보기"는
// 2단계의 GET /invites/{code} 가 따로 담당한다 (거기선 인원수·설명만 보여준다).
//
// 숫자만 내려보낸다 — rank · isOverDaily · lastSeenText 는 앱이 계산한다 (9/25 합의).
router.get("/groups/:gid", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { gid } = req.params;

    if (typeof gid !== "string" || gid.length === 0 || gid.length > 128) {
      return res.status(400).json({ error: "groupId 가 잘못되었습니다" });
    }

    const gDoc = await groupsRef().doc(gid).get();
    if (!gDoc.exists) {
      return res.status(404).json({ error: "존재하지 않는 그룹입니다" });
    }

    // 멤버 여부 확인 — 관리자 개념이 없으므로 검사는 이것 하나뿐
    const meDoc = await membersRef(gid).doc(userId).get();
    if (!meDoc.exists) {
      return res.status(403).json({ error: "이 그룹의 멤버가 아닙니다" });
    }

    const snap = await membersRef(gid).get();
    const members = [];
    snap.forEach((doc) => {
      const m = doc.data();
      members.push({
        userId: doc.id,
        displayName: m.displayName || "이름 없음",
        joinedAt: m.joinedAt ?? null,
        todayCount: m.todayCount ?? 0,
        lastHourCount: m.lastHourCount ?? 0,
        countsUpdatedAt: m.countsUpdatedAt ?? null,
        lastSeenAt: m.lastSeenAt ?? null,
        permissionsOk: m.permissionsOk ?? null,
        isMe: doc.id === userId,
      });
    });

    // 정렬도 앱이 바꿀 수 있게 가입순으로만 내려보낸다 (순위는 앱이 매김)
    members.sort((a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0));

    res.json({
      group: toGroupSummary(gDoc),
      memberCount: members.length,
      members,
      serverTime: Date.now(),
    });
  } catch (err) {
    logger.error(`그룹 상세 조회 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, groupsRef, membersRef, MAX_MEMBERS_DEFAULT };
