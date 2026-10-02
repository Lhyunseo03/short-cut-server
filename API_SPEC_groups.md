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
| 닉네임 | **앱이 `nickname` 을 보냄** → `users/{uid}.nickname` 에 저장. 없을 때만 구글 이름으로 폴백 (9/28 변경) |
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
  nickname  string     표시 이름 1~20자. POST /devices/register · POST /groups ·
                       POST /groups/join 이 받아서 저장 (9/28 추가)
```

**닉네임을 `users` 문서에 두는 이유** — 멤버 문서에 이름을 박아두면 닉네임을 바꿨을 때 가입한 모든 그룹의 멤버 문서를 고쳐야 한다. 그룹 수만큼 쓰기가 늘고, 중간에 실패하면 그룹마다 다른 이름이 보인다. `users` 한 곳에만 두고 **읽을 때 합치면** 쓰기는 한 번이고 항상 일관된다. 상세 응답의 `displayName` 은 매 요청마다 이렇게 계산된다.

**표시 이름 우선순위**
`users/{uid}.nickname` → 멤버 문서의 `displayName`(1단계에 만들어진 옛 데이터) → 구글 계정 이름 → 이메일 앞부분 → `"이름 없음"`

`nickname` 이 빈 문자열·공백뿐·20자 초과면 **무시하고 기존 값을 유지한다. 400 을 내지 않는다** — 닉네임 때문에 그룹 생성이 실패하면 사용자가 원인을 알기 어렵기 때문.

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
  "maxMembers": 10,
  "nickname": "현서"
}
```
`description`, `maxMembers`, `nickname` 은 선택. `maxMembers` 기본값 10.

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
      "lastScrollAt": null,
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

**`todayCount` · `lastHourCount` · `lastScrollAt` 는 3단계(10/13~)에 채운다.** 1단계·2단계 동안은 각각 `0` · `0` · `null` 로 고정이다. 필드 자체는 지금부터 내려보내므로 앱이 null 을 만나 터지지 않는다. 그때까지 앱은 **자기 행만 로컬 값으로** 표시하면 된다.

이 값들을 지금 실시간으로 계산하지 않는 이유 — 10명 × 30초 폴링이면 분당 20회 집계가 되고, `userLogs` 를 매번 스캔하면 NFR 의 "응답 2초 이내"를 못 지킨다. 3단계에서 `/userlogs` 가 들어올 때 `members/{userId}` 에 카운트를 **써 두고**, 조회는 읽기만 하게 바꾼다.

| 상태 | 언제 |
|---|---|
| `400` | `gid` 가 비었거나 128자 초과 |
| `403` | 그 그룹의 멤버가 아님 |
| `404` | 존재하지 않는 그룹 |

> 초대 링크로 들어온 사람에게 보여줄 "가입 전 미리보기"는 여기가 아니라 2단계의 `GET /invites/{code}` 가 담당한다 (인원수·설명만 보여줌).

---

## 5. 2단계 — 초대 · 가입 · 탈퇴 (10/2 추가)

### Firestore

```
invites/{code}
  code       6자 대문자+숫자 (O·0·I·1 제외). 문서 ID 와 같음
  groupId    어느 그룹 초대인가
  createdBy  만든 사람 uid
  createdAt  ms
  expiresAt  ms (생성 +24시간)
```

코드가 문서 ID 라 같은 코드가 두 번 생기는 걸 Firestore 가 막는다(`create()` 는 이미 있으면 실패 → 다시 뽑음).

### `POST /invites` — 초대 코드 만들기

**요청** `{ "groupId": "..." }`
**201** `{ "code": "A3F9K2", "groupId": "...", "expiresAt": 1759000000000 }`

멤버 누구나 만들 수 있다(관리자 없음). 부를 때마다 **새 코드**를 준다 — 한 그룹에 코드가 여럿 살아 있어도 된다.

| 상태 | 언제 |
|---|---|
| 400 | `groupId` 없음 |
| 403 | 그 그룹 멤버가 아님 |
| 404 | 없는 그룹 |

### `GET /invites/{code}` — 가입 전 미리보기 (앱용)

```json
{
  "code": "A3F9K2",
  "expiresAt": 1759000000000,
  "alreadyMember": false,
  "group": {
    "groupId": "...", "name": "...", "description": "...",
    "goal": { "dailyLimit": 200, "hourlyLimit": 60 }, "approvalRate": 60,
    "memberCount": 3, "maxMembers": 10, "isFull": false
  }
}
```

**멤버 목록·카운트는 주지 않는다** — 아직 멤버가 아닌 사람이 부르는 경로라서.
`alreadyMember: true` 면 "가입하기" 대신 "열기" 를 보여주면 된다.
코드는 소문자·공백·하이픈이 섞여 와도 받아준다 (`a3f-9k2` → `A3F9K2`).

| 상태 | 언제 |
|---|---|
| 400 | 형식이 6자가 아님 |
| 404 | 없는 코드, 또는 그룹이 사라짐 |
| **410** | 만료된 코드 — "없음" 과 구분해서 "링크가 늦었구나" 를 알 수 있게 |

### `POST /groups/join` — 코드로 가입

**요청** `{ "code": "A3F9K2", "nickname": "현서" }` (`nickname` 선택 — `users/{uid}.nickname` 에 저장)

| 상태 | 응답 |
|---|---|
| **201** | `{ "status": "ok", "groupId": "...", "memberCount": 4 }` |
| 200 | `{ "status": "ok", "groupId": "...", "alreadyMember": true }` — 이미 멤버. 인원 안 늘어남 |
| 400 / 404 / 410 | 미리보기와 같음 |
| **409** | 정원 찼음 |

**트랜잭션으로 처리한다.** 마지막 한 자리에 두 사람이 동시에 들어오면 둘 다 "9/10 이니까 된다" 를 읽고 둘 다 추가해 11명이 될 수 있다. "정원 확인 → 멤버 추가 → memberCount 증가" 를 한 덩어리로 묶었다.
개발 중 3명이 동시에 마지막 1자리에 요청하는 상황을 재현해서, 정확히 1명만 들어가고 2명은 409 를 받는 것을 확인했다.

### `DELETE /groups/{gid}/members/me` — 탈퇴

**200** `{ "status": "ok", "groupId": "...", "memberCount": 2, "groupDeleted": false }`

자기 자신만 뺄 수 있다. **남을 내보내는 기능은 없다**(관리자 없음 — G9).
**마지막 한 명이 나가면 그룹을 지운다** (`groupDeleted: true`). 초대를 만들려면 멤버여야 하므로, 빈 그룹은 아무도 다시 들어갈 수 없는 껍데기가 되기 때문.
트랜잭션이라 인원수가 어긋나지 않는다. `users/{uid}.groupIds` 에서도 빠진다.

| 상태 | 언제 |
|---|---|
| 404 | 그 그룹 멤버가 아님 |

### `GET /invite/{code}` — 초대 랜딩 페이지 (HTML, **토큰 없음**)

카톡 등으로 받은 링크를 브라우저로 여는 경로. 받은 사람은 아직 로그인 전일 수 있어서 **이 경로만 `verifyToken` 을 지나지 않는다.**

```
https://short-cut-server-production.up.railway.app/invite/A3F9K2
```

보여주는 것은 그룹 이름·설명·인원수·코드뿐이다. **멤버 이름·uid·스크롤 수는 절대 넣지 않는다.**
그룹 이름과 설명은 HTML 이스케이프한다 — 그룹 이름에 `<script>` 를 넣어도 실행되지 않는다.
정원이 찼으면 코드를 숨기고 "정원이 가득 찼어요" 를 보여준다. 없는·만료된 코드도 HTML 로 응답한다(404 / 410).

앱에서 공유할 때는 이 URL 을 그대로 보내면 된다.

---

## 6. 다음 단계 예고

**3단계 (10/13~)** — `GET /groups/{gid}/status`. `members` 의 `todayCount`·`lastHourCount`·`lastScrollAt` 캐시를 읽기만 한다. 30초 폴링이라 매번 집계하지 않는다.
