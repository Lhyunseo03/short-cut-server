// ─────────────────────────────────────────────────────────────
// utils/nickname.js — 표시 이름 저장 / 조회 (G3)
//
// 저장 위치: users/{uid}.nickname
//
// 왜 users 문서에 두는가 —
//   멤버 문서(groups/{gid}/members/{uid})에 이름을 박아두면, 사용자가 닉네임을 바꿨을 때
//   이미 가입한 모든 그룹의 멤버 문서를 찾아다니며 고쳐야 한다. 그룹 수만큼 쓰기가 늘고,
//   중간에 실패하면 그룹마다 다른 이름이 보인다.
//   users 문서 한 곳에만 두고 **읽을 때 합치면** 쓰기는 한 번, 항상 일관된 이름이 된다.
//
// 우선순위: users/{uid}.nickname → 멤버 문서의 displayName(옛 데이터) → 구글 계정 이름
//           → 이메일 앞부분 → "이름 없음"
//
// 앱이 nickname 을 보내는 곳 (2026-09-28 정은 요청):
//   POST /devices/register · POST /groups · POST /groups/join(2단계)
// ─────────────────────────────────────────────────────────────

const { db, admin } = require("./firebase");
const logger = require("./logger");

const NICKNAME_MAX = 20;

// 앱이 보낸 nickname 이 쓸 만한 값인지 확인하고 다듬는다.
// 빈 문자열·공백만·너무 긴 값은 "안 보낸 것"으로 취급한다(400 을 내지 않는다).
// 닉네임 때문에 그룹 생성이 실패하면 사용자 입장에서 원인을 알기 어렵기 때문.
function normalizeNickname(value) {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (t.length === 0 || t.length > NICKNAME_MAX) return null;
  return t;
}

// users/{uid}.nickname 에 저장. merge 라서 blockUntil·groupIds 등 기존 필드는 그대로.
// 값이 없으면 아무것도 쓰지 않는다 (기존 닉네임을 null 로 덮지 않게).
async function saveNickname(userId, value) {
  const nickname = normalizeNickname(value);
  if (!nickname) return null;
  try {
    await db.collection("users").doc(userId).set({ nickname }, { merge: true });
  } catch (err) {
    // 닉네임 저장 실패로 본 요청(기기 등록·그룹 생성)까지 죽이지 않는다.
    logger.error(`nickname 저장 실패 — uid: ${userId}, ${err.message}`);
  }
  return nickname;
}

// 여러 사용자의 표시 이름을 한 번에 구한다. 반환: Map<uid, string>
//
// fallbacks: { uid: "멤버 문서에 저장돼 있던 이름" } — nickname 이 없을 때 쓸 값.
//            1단계에서 이미 만들어진 멤버 문서의 displayName 을 살리기 위한 것.
//
// 구글 계정 조회는 nickname 도 fallback 도 없는 사용자에 대해서만,
// getUsers 로 한 번에 묶어서 한다 (사람 수만큼 auth 왕복하면 느리다).
async function resolveDisplayNames(userIds, fallbacks = {}) {
  const out = new Map();
  if (userIds.length === 0) return out;

  const refs = userIds.map((uid) => db.collection("users").doc(uid));
  const docs = await db.getAll(...refs);

  const needAuth = [];
  docs.forEach((doc, i) => {
    const uid = userIds[i];
    const nickname = doc.exists ? normalizeNickname(doc.data().nickname) : null;
    if (nickname) {
      out.set(uid, nickname);
    } else if (fallbacks[uid]) {
      out.set(uid, fallbacks[uid]);
    } else {
      needAuth.push(uid);
    }
  });

  if (needAuth.length > 0) {
    try {
      const result = await admin
        .auth()
        .getUsers(needAuth.map((uid) => ({ uid })));
      for (const u of result.users) {
        out.set(
          u.uid,
          u.displayName || (u.email ? u.email.split("@")[0] : "이름 없음"),
        );
      }
    } catch (err) {
      logger.error(`구글 계정 이름 조회 실패 — ${err.message}`);
    }
    // 조회에 실패했거나 계정이 사라진 경우까지 채운다
    for (const uid of needAuth) if (!out.has(uid)) out.set(uid, "이름 없음");
  }

  return out;
}

// 한 사람용 편의 함수
async function resolveDisplayName(userId, fallback) {
  const map = await resolveDisplayNames(
    [userId],
    fallback ? { [userId]: fallback } : {},
  );
  return map.get(userId) || "이름 없음";
}

module.exports = {
  NICKNAME_MAX,
  normalizeNickname,
  saveNickname,
  resolveDisplayNames,
  resolveDisplayName,
};
