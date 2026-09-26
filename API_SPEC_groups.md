# 그룹 API 스펙 — 1단계 (G1~G3)

작성 2026-09-26 · 서버 이현서
대상 `short-cut-server` main · 기준 URL `https://short-cut-server-production.up.railway.app`

모든 요청에 `Authorization: Bearer <Firebase ID 토큰>` 이 필요하다. 없으면 `401 {"error":"인증 토큰이 없습니다"}`.

> **1단계 범위** — 그룹의 뼈대만. 초대·가입·탈퇴는 2단계, 랭킹·현황(`/status`)은 3단계.

---

## 0. 합의된 설계 (9/25 정은과 확정)

| 항목 | 결정 |
|---|---|
| 목표 필드명 | `goal { dailyLimit, hourlyLimit }` (`daily`/`hourly` 아님) |
| 계산 위치 | **서버는 숫자만.** `rank`·`isOverDaily`·`isOverHourly`·`lastSeenText` 는 앱이 계산 |
| 닉네임 | 서버가 Firebase 계정의 구글 이름에서 꺼냄. **앱은 아무것도 안 보냄** |
| 관리자 | **없음** (G9). 권한 검사는 "그 그룹의 멤버인가" 하나뿐 |

---

## 1. Firestore 구조

```
groups/{gid}
  name          string   1~30자
  description   string   0~200자 (초대받은 사람이 가입 전에 보는 글)
  goal          { dailyLimit: int, hourlyLimit: int }
  approvalRate  int      1~100. 안건 통과에 필요한 찬성률 % (G9)
  maxMembers    int      기본 10, 최대 20
  memberCount   int      캐시. members 를 매번 세지 않으려고
  createdBy     string   만든 사람 uid — **관리자가 아니라 표시용**
  createdAt     number   ms

groups/{gid}/members/{userId}
  userId          string  문서 ID 와 동일
  displayName     string  가입 시점의 구글 계정 이름
  joinedAt        number  ms
  todayCount      int  \
  lastHourCount   int   |  3단계 랭킹용 캐시. 1단계에서는 0 으로 만들어만 둔다
  countsUpdatedAt num   |  (10명 × 30초마다 userLogs 집계는 NFR 2초를 못 지킴)
  lastSeenAt      num  /
  permissionsOk   bool?   G11 표시용. 아직 안 채움

users/{uid}
  groupIds  string[]   내가 속한 그룹 ID. arrayUnion/arrayRemove 로만 변경
```

**`groupIds` 를 쓰는 이유** — `collectionGroup('members').where('userId','==',uid)` 로도 되지만 복합 색인을 따로 등록해야 한다. 한 사람이 드는 그룹은 많아야 몇 개라 배열 하나로 충분하고, 색인이 필요 없다.

---

## 2. `POST /groups` — 그룹 만들기

만든 사람이 그 자리에서 첫 멤버가 된다. 그룹 문서·멤버 문서·`users.groupIds` 세 개를 **배치 하나로** 쓴다 — 셋 중 하나만 성공해서 "목록엔 뜨는데 못 들어가는 그룹"이 생기는 걸 막는다.

**요청**
```json
{
  "name": "쇼츠 끊기",
  "description": "같이 줄여봐요",
  "goal": { "dailyLimit": 200, "hourlyLimit": 60 },
  "approvalRate": 60,
  "maxMembers": 10
}
```
`description`, `maxMembers` 는 선택. `maxMembers` 기본값 10.

**201 응답**
```json
{
  "status": "ok",
  "group": {
    "groupId": "AbC123...",
    "name": "쇼츠 끊기",
    "description": "같이 줄여봐요",
    "goal": { "dailyLimit": 200, "hourlyLimit": 60 },
    "approvalRate": 60,
    "memberCount": 1,
    "maxMembers": 10,
    "createdAt": 1758800000000
  }
}
```

**400 이 나는 경우**

| 조건 | 메시지 |
|---|---|
| `name` 이 빈 값이거나 30자 초과 | `name 은 1~30자 문자열이어야 합니다` |
| `description` 200자 초과 | `description 은 200자 이하 문자열이어야 합니다` |
| `goal` 없음 | `goal { dailyLimit, hourlyLimit } 이 필요합니다` |
| 한도가 1 미만 정수 아님 | `goal.dailyLimit 은 1 이상의 정수여야 합니다` |
| `hourlyLimit > dailyLimit` | `goal.hourlyLimit 은 dailyLimit 보다 클 수 없습니다` |
| `approvalRate` 가 1~100 밖 | `approvalRate 는 1~100 사이의 정수여야 합니다` |
| `maxMembers` 가 2~20 밖 | `maxMembers 는 2~20 사이의 정수여야 합니다` |

`name` 은 앞뒤 공백을 제거해서 저장한다.

---

## 3. `GET /groups` — 내가 속한 그룹 목록

**200 응답**
```json
{
  "count": 2,
  "groups": [ { "groupId": "...", "name": "...", "...": "POST 응답의 group 과 같은 형태" } ]
}
```

최근 만든 것부터 내려간다. 속한 그룹이 없으면 `{"count":0,"groups":[]}`.
이미 사라진 그룹 ID 가 `groupIds` 에 남아 있으면 목록에서 조용히 빠진다(배열 정리는 2단계 탈퇴에서).

---

## 4. `GET /groups/{gid}` — 그룹 상세 + 멤버 목록

**200 응답**
```json
{
  "group": { "groupId": "...", "name": "...", "goal": {...}, "memberCount": 3, "..." : "" },
  "memberCount": 3,
  "members": [
    {
      "userId": "abc",
      "displayName": "이현서",
      "joinedAt": 1758800000000,
      "todayCount": 0,
      "lastHourCount": 0,
      "countsUpdatedAt": 1758800000000,
      "lastSeenAt": 1758800000000,
      "permissionsOk": null,
      "isMe": true
    }
  ],
  "serverTime": 1758800001234
}
```

멤버는 **가입순**으로 내려간다. 순위 정렬은 앱이 한다.

| 상태 | 언제 |
|---|---|
| `400` | `gid` 가 비었거나 128자 초과 |
| `403` | 그 그룹의 멤버가 아님 |
| `404` | 존재하지 않는 그룹 |

> 초대 링크로 들어온 사람에게 보여줄 "가입 전 미리보기"는 여기가 아니라 2단계의 `GET /invites/{code}` 가 담당한다 (인원수·설명만 보여줌).

---

## 5. 다음 단계 예고 (앱에서 미리 알아둘 것)

**2단계 (10/6~12)** — `POST /invites`(24시간짜리 6자 코드), `GET /invites/{code}`(가입 전 미리보기), `POST /groups/join`, `DELETE /groups/{gid}/members/me`, 초대 랜딩 페이지 `GET /invite/{code}`(HTML)

**3단계 (10/13~)** — `GET /groups/{gid}/status`. `members` 의 `todayCount`·`lastHourCount` 캐시를 읽기만 한다. 30초 폴링이라 매번 집계하지 않는다.
