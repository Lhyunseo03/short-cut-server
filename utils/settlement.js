// ─────────────────────────────────────────────────────────────
// utils/settlement.js — 매일 00:05 KST 벌금통 정산 · 월요일 주간 마감 (11/5, POINTS_API.md §4)
//
// 1분마다 도는 sweeper(routes/proposals.js 의 것과 같은 타이머)가 runDue() 를 부른다.
//   그룹마다 lastSettledDate 를 보고, "D+1 일 00:05" 가 지난 날짜 D 를 순서대로 정산한다.
//   서버가 재시작돼서 00:05 를 놓쳐도 다음에 켜졌을 때 못 한 날부터 차례로 따라잡는다.
//
// 정산 D (그룹 하나)
//   1. 벌금통 = potDays/D 의 fines + carriedIn
//   2. 후보 = D 에 참가 중(대기 아님)인 멤버 중 수상 가능(presence.eligibility)한 사람
//   3. 후보 중 D 스크롤 최소 → 지급. 동점 n빵 · 나머지 이월. 후보 없으면 전액 이월. 0 이면 아무 일 없음
//   4. D 가 일요일이면: 이월분은 버림 + 그 주 순위 저장(lastWeek) + WEEK_RESULT
//   5. potDays/D settled, 다음 날 carriedIn, groups.lastSettledDate = D — 한 트랜잭션
// 정산 뒤에 늦게 온 기록은 결과를 바꾸지 않는다.
// ─────────────────────────────────────────────────────────────

const { db } = require("./firebase");
const logger = require("./logger");
const { toKSTDateString, startOfKSTDay } = require("./time");
const { DAY_MS } = require("./week");
const points = require("./points");
const presence = require("./presence");
const { resolveDisplayNames } = require("./nickname");
const { pushToUsers } = require("./groupPush");

const SETTLE_DELAY_MS = 5 * 60 * 1000; // 00:05

// 한 사람의 [from, to) 스크롤 합 (모든 기기)
async function scrollsBetween(userId, from, to) {
  const snap = await db
    .collection("userLogs")
    .where("userId", "==", userId)
    .where("timestamp", ">=", from)
    .where("timestamp", "<", to)
    .get();
  let n = 0;
  snap.forEach((d) => (n += Number(d.data().scrollCount) || 0));
  return n;
}

// 지금 기준으로 정산이 끝났어야 하는 마지막 날짜
function lastDueDate(now) {
  return toKSTDateString(now - SETTLE_DELAY_MS - DAY_MS);
}

function isSunday(date) {
  return new Date(startOfKSTDay(date) + 9 * 60 * 60 * 1000).getUTCDay() === 0;
}

// ─────────────────────────────────────────────────────────────
// 한 그룹의 날짜 D 정산
// ─────────────────────────────────────────────────────────────
async function settleDay(gid, D, now = Date.now()) {
  const gRef = points.groupRef(gid);
  const dayStart = startOfKSTDay(D);
  const dayEnd = dayStart + DAY_MS;
  const wk = points.weekKey(dayStart);
  const sunday = isSunday(D);

  // ── 트랜잭션 밖: 후보 계산 (쿼리가 많아서) ──
  const memSnap = await gRef.collection("members").get();
  const members = memSnap.docs.map((d) => ({ userId: d.id, ...d.data() }));
  const active = members.filter((m) => !points.isWaiting(m, wk));
  const info = await Promise.all(
    active.map(async (m) => {
      const [scrolls, el] = await Promise.all([
        scrollsBetween(m.userId, dayStart, dayEnd),
        presence.eligibility(m.userId, D, Math.min(now, dayEnd)),
      ]);
      return { userId: m.userId, scrolls, ...el };
    }),
  );
  const candidates = info.filter((x) => x.eligible);
  const minScroll = candidates.length ? Math.min(...candidates.map((c) => c.scrolls)) : null;
  const winnerIds = candidates.filter((c) => c.scrolls === minScroll).map((c) => c.userId);

  // 일요일이면 주간 순위용 그 주 스크롤 합 (동점 정렬 — 적게 본 사람 앞)
  let weekScrolls = {};
  if (sunday) {
    const wkStart = startOfKSTDay(wk);
    const list = await Promise.all(active.map((m) => scrollsBetween(m.userId, wkStart, dayEnd)));
    active.forEach((m, i) => (weekScrolls[m.userId] = list[i]));
  }
  const names = await resolveDisplayNames(
    members.map((m) => m.userId),
    Object.fromEntries(members.filter((m) => m.displayName && m.displayName !== "이름 없음").map((m) => [m.userId, m.displayName])),
  );

  // ── 트랜잭션: 벌금통 다시 읽고 지급 ──
  const out = await db.runTransaction(async (tx) => {
    const gSnap = await tx.get(gRef);
    if (!gSnap.exists) return null;
    const g = gSnap.data();
    if (g.lastSettledDate && g.lastSettledDate >= D) return null; // 이미 함
    const pSnap = await tx.get(points.potRef(gid, D));
    if (pSnap.exists && pSnap.data().settled) {
      // 이미 정산된 날 (기준점이 뒤로 밀린 경우 등) — 두 번 지급하지 않는다
      tx.update(gRef, { lastSettledDate: D });
      return null;
    }
    const next = points.nextDate(D);
    const nSnap = await tx.get(points.potRef(gid, next));
    const mSnaps = [];
    for (const id of winnerIds) mSnaps.push(await tx.get(gRef.collection("members").doc(id)));
    let curMembers = null;
    if (sunday) curMembers = await tx.get(gRef.collection("members"));
    // ── 쓰기 ──
    const p = pSnap.exists ? pSnap.data() : {};
    const pot = (p.fines || 0) + (p.carriedIn || 0);
    const alive = mSnaps.filter((s) => s.exists); // 계산하는 사이 탈퇴한 사람 제외
    const n = alive.length;
    const share = n > 0 ? Math.floor(pot / n) : 0;
    const leftover = n > 0 ? pot - share * n : pot;
    const winners = [];
    const after = {};
    if (pot > 0 && n > 0 && share > 0) {
      for (const s of alive) {
        const wp = points.addPoints(s.data(), wk, share);
        tx.update(s.ref, { weekPoints: wp });
        after[s.id] = wp;
        winners.push({
          userId: s.id,
          nickname: names.get(s.id) || "이름 없음",
          scrolls: minScroll,
          received: share,
        });
      }
    }
    const carriedOut = sunday ? 0 : leftover; // 일요일 남은 몫은 버림 (11/4 확정)
    tx.set(
      points.potRef(gid, D),
      { date: D, fines: p.fines || 0, carriedIn: p.carriedIn || 0, pot, settled: true, settledAt: now, winners, carriedOut, discarded: sunday ? leftover : 0 },
      { merge: true },
    );
    if (carriedOut > 0) {
      const nd = nSnap.exists ? nSnap.data() : {};
      tx.set(points.potRef(gid, next), { date: next, carriedIn: (nd.carriedIn || 0) + carriedOut }, { merge: true });
    }
    const gUpdate = { lastSettledDate: D };

    let ranking = null;
    if (sunday) {
      // 그 주 참가자 점수 (방금 지급한 것까지)
      const rows = [];
      curMembers.forEach((d) => {
        const m = d.data();
        if (points.isWaiting(m, wk)) return;
        const wp = after[d.id] || m.weekPoints;
        rows.push({ userId: d.id, nickname: names.get(d.id) || "이름 없음", points: points.pointsOf({ ...m, weekPoints: wp }, wk) });
      });
      rows.sort((a, b) => b.points - a.points || (weekScrolls[a.userId] ?? 0) - (weekScrolls[b.userId] ?? 0));
      // 1등 연속 주 수 — 공동 1등이면 각자 계산
      const prevTop = new Map(((g.lastWeek && g.lastWeek.ranking) || []).filter((r) => r.streak).map((r) => [r.userId, r.streak]));
      const top = rows.length ? rows[0].points : null;
      for (const r of rows) if (r.points === top) r.streak = (prevTop.get(r.userId) || 0) + 1;
      // [11/11] 그 주 참가자가 없으면(새 그룹의 첫 주 = 전원 대기) 주간 결과도 없다 — lastWeek 를 덮지 않고 WEEK_RESULT 도 안 보낸다
      if (rows.length > 0) {
        ranking = rows;
        gUpdate.lastWeek = { weekStart: wk, ranking, closedAt: now };
      }
    }
    tx.update(gRef, gUpdate);
    return { pot, winners, carriedOut, discarded: sunday ? leftover : 0, ranking, groupName: g.name || "그룹" };
  });
  if (!out) return null;

  logger.success(
    `포인트 정산 — gid: ${gid}, ${D}, 벌금통 ${out.pot}` +
      (out.winners.length ? ` → ${out.winners.map((w) => `${w.nickname}+${w.received}`).join(", ")}` : " → 수상자 없음") +
      (out.carriedOut ? `, 이월 ${out.carriedOut}` : "") + (out.discarded ? `, 버림 ${out.discarded}` : ""),
  );
  for (const w of out.winners) {
    pushToUsers([w.userId], {
      type: "POINTS_AWARDED", groupId: gid, groupName: out.groupName,
      title: `${out.groupName} · 포인트`,
      body: `어제 가장 적게 봤어요 · +${w.received}점`,
      extra: { delta: w.received, date: D },
    });
  }
  if (out.ranking) {
    const first = out.ranking[0];
    const ids = (await points.groupRef(gid).collection("members").get()).docs.map((d) => d.id);
    for (const uid of ids) {
      const idx = out.ranking.findIndex((r) => r.userId === uid);
      pushToUsers([uid], {
        type: "WEEK_RESULT", groupId: gid, groupName: out.groupName,
        title: `${out.groupName} · 지난주 결과`,
        body: first
          ? `지난주 1등 ${first.nickname} (${first.points.toLocaleString("en-US")}점) · 새 주 시작, 1,000점`
          : "새 주 시작, 1,000점",
        extra: idx >= 0 ? { myRank: idx + 1, myPoints: out.ranking[idx].points } : {},
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 1분마다 — 정산할 날이 남은 그룹을 찾아 차례로
// ─────────────────────────────────────────────────────────────
let running = false;
// 그룹 전체를 훑는 건 "정산할 날짜가 바뀌었을 때"(하루 한 번, 00:05 직후)와 서버가 켜졌을 때만.
// 1분마다 groups 전체를 읽으면 Firestore 읽기가 하루 1,440 × 그룹 수로 늘어난다.
let lastDueChecked = null;
async function runDue(now = Date.now(), { force = false } = {}) {
  if (running) return;
  const due = lastDueDate(now);
  if (!force && due === lastDueChecked) return;
  running = true;
  try {
    const snap = await db.collection("groups").get();
    for (const doc of snap.docs) {
      const g = doc.data();
      let d = g.lastSettledDate;
      if (!d) {
        // 처음 보는 그룹 — 기준점(이 날까지는 정산 끝)을 찍는다.
        //   어제·오늘 만든 그룹: 만든 날 전날 → 만든 날부터 정산
        //   배포 전부터 있던 그룹: 지금 정산할 날 → 지난 날짜를 거슬러 정산하지 않는다
        const base = toKSTDateString((g.createdAt && g.createdAt > 0 ? g.createdAt : now) - DAY_MS);
        const prevDue = toKSTDateString(startOfKSTDay(due) - DAY_MS);
        d = base >= prevDue ? base : due;
        await doc.ref.update({ lastSettledDate: d });
      }
      let guard = 0;
      while (d < due && guard++ < 14) {
        d = points.nextDate(d);
        await settleDay(doc.id, d, now);
      }
    }
    lastDueChecked = due; // 끝까지 성공했을 때만 — 실패하면 1분 뒤 다시 시도
  } catch (err) {
    logger.error(`포인트 정산 실패 — ${err.message}`);
  } finally {
    running = false;
  }
}

module.exports = { settleDay, runDue, lastDueDate, scrollsBetween, SETTLE_DELAY_MS };
