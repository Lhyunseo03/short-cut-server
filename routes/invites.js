// ─────────────────────────────────────────────────────────────
// routes/invites.js — 초대 / 가입 / 탈퇴 (제안서 G4~G7)
//
// 그룹 2단계. 1단계(groups.js)가 만든 그룹에 사람을 들이고 내보낸다.
//
// Firestore 경로
//   invites/{code}
//     code        6자 대문자+숫자. 헷갈리는 글자(O/0, I/1) 제외
//     groupId     어느 그룹 초대인가
//     createdBy   만든 사람 uid
//     createdAt   생성 시각(ms)
//     expiresAt   만료 시각(ms). 생성 +24시간
//
//   ※ 코드가 문서 ID 다. 같은 코드가 두 번 만들어지는 것을 Firestore 가 막아 준다
//     (create() 는 이미 있으면 ALREADY_EXISTS 로 실패).
//
// 설계 요점
//   · **가입은 트랜잭션이다.** 마지막 한 자리에 두 사람이 동시에 들어오면
//     "정원 확인 → 멤버 추가 → memberCount 증가" 사이에 끼어들어 11명이 된다.
//   · **탈퇴도 트랜잭션이다.** memberCount 를 내리는 것과 멤버 문서를 지우는 것이
//     따로 놀면 인원수가 영영 어긋난다.
//   · 마지막 한 명이 나가면 그룹을 지운다. 관리자가 없으므로(G9) 빈 그룹을
//     정리할 사람이 없고, 아무도 못 들어가는 껍데기만 남는다.
//   · `GET /invite/{code}` (HTML 랜딩)만 **토큰 없이** 열린다. 링크를 받은 사람은
//     아직 로그인 전일 수 있기 때문. 그래서 그 경로는 코드로 알 수 있는 최소한만 보여준다.
// ─────────────────────────────────────────────────────────────

const express = require("express");
const { db, admin } = require("../utils/firebase");
const logger = require("../utils/logger");
const { verifyToken } = require("../middleware/auth");
const { saveNickname, resolveDisplayName } = require("../utils/nickname");
const { groupsRef, membersRef, MAX_MEMBERS_DEFAULT } = require("./groups");

const router = express.Router();

const INVITE_TTL_MS = 24 * 60 * 60 * 1000; // 24시간
const CODE_LENGTH = 6;
// O/0, I/1 을 뺀 글자만. 사람이 코드를 불러 주거나 받아 적을 때 틀리지 않게.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

function invitesRef() {
  return db.collection("invites");
}
function userRef(uid) {
  return db.collection("users").doc(uid);
}

function randomCode() {
  let s = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return s;
}

// 앱이 보낸 코드를 다듬는다. 사용자가 소문자로 치거나 공백·하이픈을 넣을 수 있다.
function normalizeCode(raw) {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toUpperCase().replace(/[\s-]/g, "");
  return CODE_RE.test(t) ? t : null;
}

// ═════════════════════════════════════════════════════════════
// POST /invites   { groupId }
// ═════════════════════════════════════════════════════════════
// 멤버 누구나 만들 수 있다 (관리자 개념이 없으므로).
// 초대마다 새 코드를 발급한다 — 한 그룹에 코드가 여럿 살아 있어도 된다.
// 그래야 "누가 뿌린 코드인지" 가 남고, 하나를 못 쓰게 해도 나머지는 살아 있다.
router.post("/invites", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { groupId } = req.body;

    if (
      typeof groupId !== "string" ||
      groupId.length === 0 ||
      groupId.length > 128
    ) {
      return res.status(400).json({ error: "groupId 가 필요합니다" });
    }

    const gDoc = await groupsRef().doc(groupId).get();
    if (!gDoc.exists) {
      return res.status(404).json({ error: "존재하지 않는 그룹입니다" });
    }

    const me = await membersRef(groupId).doc(userId).get();
    if (!me.exists) {
      return res.status(403).json({ error: "이 그룹의 멤버가 아닙니다" });
    }

    const now = Date.now();
    const expiresAt = now + INVITE_TTL_MS;

    // 코드 충돌은 사실상 안 나지만(32^6 ≈ 10억), 나면 조용히 틀린 그룹에
    // 넣어 버리는 사고가 되므로 create() 로 막고 몇 번 다시 뽑는다.
    let code = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = randomCode();
      try {
        await invitesRef().doc(candidate).create({
          code: candidate,
          groupId,
          createdBy: userId,
          createdAt: now,
          expiresAt,
        });
        code = candidate;
        break;
      } catch (err) {
        // ALREADY_EXISTS(6) 면 다시 뽑는다. 다른 오류는 그대로 올린다.
        if (err.code !== 6) throw err;
      }
    }
    if (!code) {
      return res
        .status(500)
        .json({ error: "초대 코드 생성에 실패했습니다. 다시 시도해주세요" });
    }

    logger.success(`초대 생성 — code: ${code}, gid: ${groupId}, by: ${userId}`);
    res.status(201).json({ code, groupId, expiresAt });
  } catch (err) {
    logger.error(`초대 생성 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// 코드로 초대와 그룹을 읽어 온다. 만료·삭제를 한 곳에서 판단하려고 분리.
// 반환: { ok: true, invite, group } 또는 { ok: false, status, error }
async function loadInvite(rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) {
    return {
      ok: false,
      status: 400,
      error: "코드 형식이 잘못되었습니다 (6자리)",
    };
  }

  const iDoc = await invitesRef().doc(code).get();
  if (!iDoc.exists) {
    return { ok: false, status: 404, error: "없는 초대 코드입니다" };
  }

  const invite = iDoc.data();
  if (invite.expiresAt <= Date.now()) {
    // 문서를 지우지는 않는다 — "만료됨" 과 "애초에 없음" 을 구분해 보여줘야
    // 받은 사람이 "링크가 늦었구나" 를 알 수 있다. 정리는 나중에 일괄로.
    return { ok: false, status: 410, error: "만료된 초대 코드입니다" };
  }

  const gDoc = await groupsRef().doc(invite.groupId).get();
  if (!gDoc.exists) {
    return { ok: false, status: 404, error: "그룹이 사라졌습니다" };
  }

  return { ok: true, code, invite, group: gDoc };
}

// ═════════════════════════════════════════════════════════════
// GET /invites/:code — 가입 전 미리보기 (앱용)
// ═════════════════════════════════════════════════════════════
// 아직 멤버가 아닌 사람이 부른다. 그래서 멤버 목록·카운트는 주지 않고,
// 들어갈지 말지 정하는 데 필요한 것만 준다.
router.get("/invites/:code", verifyToken, async (req, res) => {
  try {
    const loaded = await loadInvite(req.params.code);
    if (!loaded.ok) {
      return res.status(loaded.status).json({ error: loaded.error });
    }

    const g = loaded.group.data();
    const already = (await membersRef(loaded.group.id).doc(req.userId).get())
      .exists;

    res.json({
      code: loaded.code,
      expiresAt: loaded.invite.expiresAt,
      alreadyMember: already, // 앱: true 면 "가입하기" 대신 "열기" 를 보여주면 된다
      group: {
        groupId: loaded.group.id,
        name: g.name,
        description: g.description || "",
        goal: g.goal,
        approvalRate: g.approvalRate,
        memberCount: g.memberCount ?? 0,
        maxMembers: g.maxMembers ?? MAX_MEMBERS_DEFAULT,
        isFull: (g.memberCount ?? 0) >= (g.maxMembers ?? MAX_MEMBERS_DEFAULT),
      },
    });
  } catch (err) {
    logger.error(`초대 조회 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
// POST /groups/join   { code, nickname? }
// ═════════════════════════════════════════════════════════════
// **트랜잭션이 꼭 필요한 곳.**
// 마지막 한 자리에 두 사람이 동시에 들어오면, 둘 다 "9/10 이니까 들어갈 수 있다"
// 를 읽고 둘 다 추가해 11명이 된다. 읽기와 쓰기를 한 덩어리로 묶어야 한다.
router.post("/groups/join", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;
    const loaded = await loadInvite(req.body.code);
    if (!loaded.ok) {
      return res.status(loaded.status).json({ error: loaded.error });
    }

    const gid = loaded.group.id;

    // 닉네임은 트랜잭션 밖에서 미리 정한다 — 트랜잭션 안에서 외부 호출(auth)을
    // 하면 재시도될 때마다 다시 불려서 느려진다.
    const displayName =
      (await saveNickname(userId, req.body.nickname)) ||
      (await resolveDisplayName(userId));

    const now = Date.now();

    const result = await db.runTransaction(async (tx) => {
      // ── 읽기는 전부 먼저. Firestore 트랜잭션은 쓰기 뒤의 읽기를 허용하지 않는다 ──
      const gRef = groupsRef().doc(gid);
      const mRef = membersRef(gid).doc(userId);
      const gSnap = await tx.get(gRef);
      const mSnap = await tx.get(mRef);

      if (!gSnap.exists)
        return { status: 404, body: { error: "그룹이 사라졌습니다" } };
      if (mSnap.exists) {
        return {
          status: 200,
          body: { status: "ok", groupId: gid, alreadyMember: true },
        };
      }

      const g = gSnap.data();
      const count = g.memberCount ?? 0;
      const max = g.maxMembers ?? MAX_MEMBERS_DEFAULT;
      if (count >= max) {
        return { status: 409, body: { error: `정원이 찼습니다 (${max}명)` } };
      }

      // ── 여기서부터 쓰기 ──
      tx.set(mRef, {
        userId,
        displayName,
        joinedAt: now,
        todayCount: 0,
        lastHourCount: 0,
        lastScrollAt: null,
        countsUpdatedAt: now,
        lastSeenAt: now,
      });
      tx.update(gRef, { memberCount: count + 1 });
      tx.set(
        userRef(userId),
        { groupIds: admin.firestore.FieldValue.arrayUnion(gid) },
        { merge: true },
      );

      return {
        status: 201,
        body: { status: "ok", groupId: gid, memberCount: count + 1 },
      };
    });

    if (result.status >= 400) {
      return res.status(result.status).json(result.body);
    }

    logger.success(
      `그룹 가입 — gid: ${gid}, user: ${userId}, code: ${loaded.code}`,
    );
    res.status(result.status).json(result.body);
  } catch (err) {
    logger.error(`그룹 가입 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
// DELETE /groups/:gid/members/me — 탈퇴
// ═════════════════════════════════════════════════════════════
// 자기 자신만 뺄 수 있다. 남을 내보내는 기능은 없다 (관리자가 없으므로 — G9).
// 마지막 한 명이 나가면 그룹 문서도 지운다. 안 그러면 아무도 못 들어가는
// 빈 그룹이 영원히 남는다(초대를 만들려면 멤버여야 하므로).
router.delete("/groups/:gid/members/me", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { gid } = req.params;

    if (typeof gid !== "string" || gid.length === 0 || gid.length > 128) {
      return res.status(400).json({ error: "groupId 가 잘못되었습니다" });
    }

    const result = await db.runTransaction(async (tx) => {
      const gRef = groupsRef().doc(gid);
      const mRef = membersRef(gid).doc(userId);
      const gSnap = await tx.get(gRef);
      const mSnap = await tx.get(mRef);

      if (!mSnap.exists) {
        return { status: 404, body: { error: "이 그룹의 멤버가 아닙니다" } };
      }

      const count = gSnap.exists ? (gSnap.data().memberCount ?? 1) : 1;
      const left = Math.max(0, count - 1);

      tx.delete(mRef);
      if (gSnap.exists) {
        if (left === 0)
          tx.delete(gRef); // 마지막 한 명 → 그룹도 정리
        else tx.update(gRef, { memberCount: left });
      }

      // 그룹이 사라졌든 아니든 내 목록에서는 뺀다
      tx.set(
        userRef(userId),
        { groupIds: admin.firestore.FieldValue.arrayRemove(gid) },
        { merge: true },
      );

      return {
        status: 200,
        body: {
          status: "ok",
          groupId: gid,
          memberCount: left,
          groupDeleted: left === 0,
        },
      };
    });

    if (result.status >= 400) {
      return res.status(result.status).json(result.body);
    }

    logger.info(
      `그룹 탈퇴 — gid: ${gid}, user: ${userId}` +
        (result.body.groupDeleted ? " (마지막 멤버 — 그룹 삭제)" : ""),
    );
    res.json(result.body);
  } catch (err) {
    logger.error(`그룹 탈퇴 실패 — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
// GET /invite/:code — 초대 랜딩 페이지 (HTML, 토큰 없음)
// ═════════════════════════════════════════════════════════════
// 카톡 등으로 링크를 받은 사람이 브라우저로 연다. 아직 로그인 전일 수 있으므로
// **이 경로만 verifyToken 을 지나지 않는다.**
//
// 그래서 코드를 아는 사람에게만 의미 있는 최소한만 보여준다 —
// 그룹 이름, 설명, 인원수. 멤버 이름·스크롤 수는 절대 넣지 않는다.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function landingPage({ title, body, code }) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Short-Cut 그룹 초대</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;
         background:#f5f5f7; color:#1d1d1f; padding:24px; }
  @media (prefers-color-scheme: dark) { body { background:#1c1c1e; color:#f5f5f7; } .card { background:#2c2c2e !important; } }
  .card { background:#fff; border-radius:16px; padding:32px 24px; max-width:360px; width:100%;
          box-shadow:0 2px 16px rgba(0,0,0,.08); text-align:center; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { font-size:15px; line-height:1.6; margin:8px 0; opacity:.8; }
  .code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:28px; letter-spacing:4px;
          margin:20px 0; padding:12px; background:rgba(127,127,127,.12); border-radius:10px; }
  .muted { font-size:13px; opacity:.6; margin-top:20px; }
</style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    ${body}
    ${
      code
        ? `<div class="code">${escapeHtml(code)}</div>
    <p>Short-Cut 앱 &gt; 그룹 &gt; 코드로 참여 에서 이 코드를 입력하세요.</p>`
        : ""
    }
    <p class="muted">Short-Cut — 숏폼 사용을 함께 줄이는 앱</p>
  </div>
</body>
</html>`;
}

router.get("/invite/:code", async (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  // 초대 내용은 사람마다 다르지 않지만 만료가 있으므로 캐시하지 않는다
  res.set("Cache-Control", "no-store");

  try {
    const loaded = await loadInvite(req.params.code);

    if (!loaded.ok) {
      return res.status(loaded.status).send(
        landingPage({
          title: "초대를 열 수 없어요",
          body: `<p>${escapeHtml(loaded.error)}</p><p>초대한 사람에게 새 링크를 받아 주세요.</p>`,
          code: null,
        }),
      );
    }

    const g = loaded.group.data();
    const max = g.maxMembers ?? MAX_MEMBERS_DEFAULT;
    const count = g.memberCount ?? 0;
    const full = count >= max;

    res.send(
      landingPage({
        title: `${escapeHtml(g.name)} 그룹에 초대받았어요`,
        body:
          (g.description ? `<p>${escapeHtml(g.description)}</p>` : "") +
          `<p>현재 ${count}명 / 최대 ${max}명</p>` +
          (full ? `<p><strong>정원이 가득 찼어요.</strong></p>` : ""),
        code: full ? null : loaded.code,
      }),
    );
  } catch (err) {
    logger.error(`초대 랜딩 실패 — ${err.message}`);
    res
      .status(500)
      .send(
        landingPage({
          title: "잠시 후 다시 시도해 주세요",
          body: "",
          code: null,
        }),
      );
  }
});

module.exports = { router, INVITE_TTL_MS, CODE_RE, normalizeCode };
