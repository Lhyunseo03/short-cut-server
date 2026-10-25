// ─────────────────────────────────────────────────────────────
// utils/groupPush.js — 그룹 알림 FCM 발송 (7~9주차, G7 · G8 · G9 · G10 · G11)
//
// utils/fcm.js 와 다른 점
//   fcm.js     : "같은 사람의 다른 기기" 에 FLUSH / COUNT_UPDATED (동기화 신호)
//   groupPush  : "그룹의 다른 사람들" 에게 사람이 읽는 알림 (한도 초과 · 넛지 · 투표 · 가입/탈퇴)
//
// 형식 (정은 GroupApi.kt 계약): data message { type, groupId, groupName, title, body }
//   알림 모양(채널 · 아이콘)은 앱(GroupNotifications.kt)이 만든다. 서버는 글자만 준다.
//   notification 이 아니라 data 로 보내는 이유: 앱이 꺼져 있어도 onMessageReceived 가 불려서
//   종류별 채널 · 누르면 그 그룹 상세로 가기를 앱이 정할 수 있다.
//
// 받는 기기: 그 사람의 **로그인 중 + 토큰 있는** 기기 전부 (최근 sync 여부는 안 본다 —
//   쇼츠를 안 보고 있어도 알림은 와야 하므로)
// ─────────────────────────────────────────────────────────────

const { db, admin } = require("./firebase");
const logger = require("./logger");

// 여러 사람의 로그인 기기 토큰 모으기
async function tokensOf(userIds) {
  const lists = await Promise.all(
    userIds.map(async (uid) => {
      const snap = await db.collection("users").doc(uid).collection("devices").get();
      const out = [];
      snap.forEach((doc) => {
        const d = doc.data();
        if (d.fcmToken && !d.loggedOutAt) out.push({ uid, deviceId: doc.id, token: d.fcmToken });
      });
      return out;
    }),
  );
  return lists.flat();
}

// 사람들에게 알림. 실패해도 예외를 던지지 않는다 (API 응답은 이미 나갔거나 영향이 없어야 함).
async function pushToUsers(userIds, { type, groupId, groupName, title, body, extra = {} }) {
  try {
    if (!userIds || userIds.length === 0) return { sent: 0, failed: 0 };
    const targets = await tokensOf(userIds);
    if (targets.length === 0) return { sent: 0, failed: 0 };

    // FCM data 값은 전부 문자열이어야 한다
    const data = {
      type,
      groupId: String(groupId || ""),
      groupName: String(groupName || ""),
      title: String(title || ""),
      body: String(body || ""),
      sentAt: String(Date.now()),
    };
    for (const [k, v] of Object.entries(extra)) data[k] = String(v);

    const resp = await admin.messaging().sendEachForMulticast({
      tokens: targets.map((t) => t.token),
      data,
      android: { priority: "high" },
    });

    // 죽은 토큰 정리 (fcm.js 와 같은 규칙)
    const cleanups = [];
    resp.responses.forEach((r, i) => {
      if (r.success) return;
      const code = r.error?.code || "";
      if (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token"
      ) {
        cleanups.push(
          db.collection("users").doc(targets[i].uid).collection("devices")
            .doc(targets[i].deviceId).update({ fcmToken: null }),
        );
      }
    });
    if (cleanups.length) await Promise.all(cleanups);

    logger.info(
      `그룹 알림 ${type} — gid: ${groupId}, 대상 ${userIds.length}명 · 기기 ${targets.length}대, 성공 ${resp.successCount} / 실패 ${resp.failureCount}`,
    );
    return { sent: resp.successCount, failed: resp.failureCount };
  } catch (err) {
    logger.error(`그룹 알림 ${type} 발송 실패 — gid: ${groupId}, ${err.message}`);
    return { sent: 0, failed: 0 };
  }
}

// 그룹의 멤버 전원(또는 한 명 빼고)에게
async function pushToGroup(gid, exceptUserId, msg) {
  try {
    const snap = await db.collection("groups").doc(gid).collection("members").get();
    const ids = snap.docs.map((d) => d.id).filter((u) => u !== exceptUserId);
    return pushToUsers(ids, { groupId: gid, ...msg });
  } catch (err) {
    logger.error(`그룹 멤버 조회 실패 — gid: ${gid}, ${err.message}`);
    return { sent: 0, failed: 0 };
  }
}

module.exports = { pushToUsers, pushToGroup };
