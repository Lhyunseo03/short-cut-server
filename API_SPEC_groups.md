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

## 6. 3단계 — 그룹 페이지 · 구성원 상세 · 구성원 일간 통계 (6주차, 10/18)

숫자만 준다. 순위 · 빨강/초록 · 종 표시 · "3분 전" 은 앱이 계산한다 (9/25 합의 그대로).
**숫자는 캐시가 아니라 읽을 때 userLogs 로 센다** — `lastHourCount` 는 업로드가 없어도 시간이 지나면 줄어야 해서.
같은 그룹을 15초 안에 다시 부르면 서버 메모리 캐시를 준다 (여러 명이 30초마다 열어도 읽기가 몰리지 않게).

### 멤버 행 (아래 세 API 공통)

| 필드 | 뜻 |
|---|---|
| `userId` · `nickname` · `displayName` | `nickname` 과 `displayName` 은 같은 값 (앱이 어느 쪽을 읽든 되게) |
| `todayCount` | 오늘(KST) 모든 기기 합계 |
| `lastHourCount` | 지금부터 1시간 전까지 모든 기기 합계 — **종(독촉) 판단용** (시간당 그룹 한도와 비교) |
| `lastScrollAt` | 마지막 스크롤 업로드 시각(ms). 없으면 null |
| `lastSeenAt` | 기기들 중 가장 최근 신호(heartbeat · sync · 등록) 시각(ms) |
| `permissionsOk` | 로그인 중인 기기 중 하나라도 권한 꺼짐이면 false, 전부 켜짐이면 true, 모르면 null |
| `loggedOut` · `loggedOutAt` | 기기가 전부 로그아웃이면 true + 마지막 로그아웃 시각 |
| `isMe` | 요청한 사람이면 true |

### `GET /groups/{gid}/status` — 그룹 페이지 30초 새로고침

```json
{ "groupId": "...", "goal": { "dailyLimit": 200, "hourlyLimit": 50 }, "date": "2026-10-18",
  "members": [ 멤버 행, ... ], "serverTime": 1792303099597 }
```
가입순. 멤버 아님 403 · 없는 그룹 404.
`GET /groups/{gid}` 의 `members` 도 **같은 실제 숫자**로 바뀌었다 (예전엔 0 이었음).

### `GET /groups/{gid}/members/{uid}` — 구성원 상세 (G5 · G11)

```json
{ "groupId": "...", "goal": {...}, "date": "2026-10-18", "serverTime": ...,
  "member": { 멤버 행 + "todayPopupCount": 3, "joinedAt": ...,
              "devices": [ { "deviceId": "...", "deviceName": "SM-X710", "lastSeenAt": ..., "lastScrollAt": ...,
                             "loggedOutAt": null, "permissionsOk": true }, ... ] } }
```
- `todayPopupCount` = 오늘 팝업에 답한 횟수 (violations)
- `devices` = 기기당 한 줄, 등록순. fcmToken 은 절대 안 나간다
- 보는 사람이 멤버가 아니면 403, 보이는 사람이 멤버가 아니면 404

### `GET /groups/{gid}/members/{uid}/daily?month=YYYY-MM` — 구성원 일간 통계 (G6)

```json
{ "groupId": "...", "userId": "...", "month": "2026-10", "goal": { "dailyLimit": 200, "hourlyLimit": 50 },
  "days": [ { "date": "2026-10-01", "count": 37 }, ..., { "date": "2026-10-18", "count": 12 } ] }
```
- `month` 생략 → 이번 달. 형식 틀리면 400. 미래 날짜는 안 준다
- 앱: `count > goal.dailyLimit` → 빨강, 아니면 초록
- `goal` 은 **지금** 그룹 한도 (투표로 한도가 바뀐 뒤 지난 날짜도 지금 한도로 비교됨 — 9주차에 이력 추가 예정)

---

## 6-1. 6주차에 같이 바뀐 것 (10/23, 정은 GroupApi.kt 계약에 맞춤)

- `GET /groups` → `{ count, maxGroups: 5, groups: [ GroupSummary + myTodayCount ] }` — `myTodayCount` = 내 오늘 합계(모든 기기)
- GroupSummary 에 `pendingGoal`(통과 후 월요일 대기 한도, 없으면 null) · `lockedUntil` 추가
- 멤버 행 `lastSeenAt` = 그 사람 **기기들의 최신 신호**(heartbeat · sync · 등록). 예전 "가입 시각" 버그 해결
- 구성원 상세 `member` 에 `todayPopups`(= todayPopupCount) · `last7Days: [{ date, count, dailyLimit }]` · 기기마다 `permissionsOffSince`
- 구성원 일간 통계 `days[]` 에 그날 그룹 일간 한도 `dailyLimit` (투표로 바뀌기 전 날짜는 옛 한도)
- **그룹 5개 제한**(G1): `POST /groups` · `POST /groups/join` → 409 `"그룹은 5개까지 참여할 수 있어요"`

## 7. FCM 그룹 알림 (7~9주차)

data message: `{ type, groupId, groupName, title, body, sentAt, ...extra }` — 알림 모양은 앱이 만든다.
받는 기기 = 대상 사람의 **로그인 중 + 토큰 있는 기기 전부** (쇼츠 안 보고 있어도 옴).

| type | 언제 | 누구에게 | extra |
|---|---|---|---|
| `GROUP_ALERT` | `POST /alerts` 가 새로 기록됐을 때 | 넘은 사람 **빼고** 전원 | userId, kind |
| `NUDGE` | 넛지 성공 | 대상 1명 | fromUserId |
| `PROPOSAL` | 제안 등록 | 제안자 빼고 전원 | proposalId |
| `VOTE_RESULT` | 투표 마감 (통과 / 부결) | 전원 | passed |
| `LIMIT_APPLIED` | 통과한 한도가 **월요일 00:00 KST** 에 적용 | 전원 | — |
| `MEMBER_JOINED` · `MEMBER_LEFT` | 새로 가입 / 탈퇴 (이미 멤버 재가입은 없음) | 본인 빼고 전원 | userId |
| `MEMBER_LOGOUT` | `POST /logout` | 그 사람이 든 모든 그룹, 본인 빼고 | userId |

## 8. 한도 초과 알림 · 넛지 (7주차, G7 · G8)

### `POST /groups/{gid}/alerts  { type: "daily"|"hourly", count }`  (`kind` 로 보내도 됨)
- `count < 그룹 한도` → 200 `{ sent: false, reason: "below-limit" }` (앱은 `count >= 한도` 일 때 보냄)
- 처음 → **201** `{ sent: true, alertId }` + GROUP_ALERT
- 같은 사람 · 같은 날(일간) / 같은 시(시간당, KST) 두 번째 → 200 `{ sent: false, reason: "duplicate" }` — **푸시 안 나감**
  - 문서 `groups/{gid}/alerts/{uid}_{date}_daily` · `{uid}_{date}_hourly_{HH}` 를 `create()` — 이미 있으면 실패하는 걸로 중복을 막는다
- type 이상 400 · 멤버 아님 403 · 없는 그룹 404

### `POST /groups/{gid}/nudge  { targetId }`  (`targetUserId` 도 됨)
- 대상의 **최근 1시간 ≥ 시간당 그룹 한도** 일 때만 (앱 종 표시와 같은 기준). 아니면 409 `"지금은 넛지를 보낼 수 없어요 …"` + `lastHourCount`
- **보낸 사람–받는 사람 쌍당 10분 1회** (제안서 G7) → 429 `"N분 뒤에 다시 보낼 수 있어요"` + `retryAfterMs`. 쌍마다 따로(A→C, B→C 독립)
- 자기 자신 400 · 대상이 멤버 아님 404 · 내가 멤버 아님 403

## 9. 한도 변경 제안 · 투표 (8~9주차, G9)

### `GET /groups/{gid}/proposal`
```json
{ "state": "none"|"open"|"passed"|"used",
  "proposal": { "proposalId", "proposedBy", "proposedByName", "dailyLimit", "hourlyLimit", "goal": {...},
                "createdAt", "closesAt", "yes", "no", "electorate", "required", "myVote": "yes"|"no"|null, "canVote" } | null,
  "lockedUntil": ms|null, "pendingGoal": { "dailyLimit", "hourlyLimit", "effectiveAt" }|null,
  "goal": {...}, "approvalRate": 60 }
```
- 우선순위 `open` > `passed`(이번 주 통과, 월요일 대기) > `used`(내가 이번 주 제안함) > `none`. 제안이 없어도 **200** (404 아님)
- `no` = 반대를 누른 수 (미투표는 마감 때 반대로 센다) · `required` = ⌈유권자 × 찬성률⌉
- `canVote: false` = 투표 중 가입한 사람

### `POST /groups/{gid}/proposals  { dailyLimit, hourlyLimit }` → 201 `{ proposalId }`
- 409: `"진행 중인 투표가 있어요"` / `"다음 주 한도 투표가 이미 끝났습니다"` / `"이번 주 제안을 이미 사용했습니다"`
- 400: 한도 형식 · 시간당 > 일간 · `"지금 한도와 같아요"`
- 그룹 문서 **트랜잭션** — 동시에 눌러도 열린 제안은 하나. 제안자는 찬성으로 들어감. 혼자인 그룹은 바로 통과

### `POST /proposals/{proposalId}/vote  { vote: "yes"|"no" }` → 200
- 409 `"이미 투표했어요"`(바꾸기 없음) / `"투표가 마감됐어요"` · 403 `"이번 투표의 투표권이 없어요"`
- 유권자 전원이 투표하면 **그 자리에서 마감** → VOTE_RESULT

### 마감 · 적용
- 24시간 또는 전원 투표 → 찬성 ≥ required 면 **통과** → `pendingGoal`, `lockedUntil` = **다음 주 월요일 00:00 KST**
- 월요일 00:00 이 지나면 그룹 한도가 바뀌고 `LIMIT_APPLIED`. 서버가 1분마다 확인 + 그룹을 읽을 때도 확인
- **투표 중 탈퇴** → 표와 분모에서 모두 빠짐 (남은 사람이 다 투표한 상태가 되면 바로 마감)

> 편지에 적힌 `POST /groups/{gid}/proposal`, `POST /groups/{gid}/proposal/vote { agree }` 도 같은 동작으로 받는다.
