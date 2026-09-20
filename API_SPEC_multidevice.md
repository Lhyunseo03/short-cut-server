# Short-Cut 다중 기기 동기화 API 스펙 (2학기 Track A, D1~D6)

**Base URL:** `https://short-cut-server-production.up.railway.app`
**브랜치:** 서버 `feat/multi-device` · 앱 `feat/multi-device`
**작성:** 이현서 (서버) — 2026-09-15. 앱(박정은)과 합의된 계약. 바꿀 때는 이 파일부터 고치고 알리기.

모든 엔드포인트는 1학기와 같이 `Authorization: Bearer <Firebase ID 토큰>` 필요. userId는 body가 아니라 **토큰에서** 꺼낸다(`req.userId`). 시각은 전부 Unix ms.

---

## 0. 공통 규칙

### deviceId
- 앱이 **최초 실행 시 UUID 하나 생성**해 SharedPreferences에 저장. 로그인/로그아웃과 무관하게 유지.
- 앱 데이터 삭제 · 재설치 시 새로 발급됨 (= 새 기기로 취급, 옛 문서는 설정 > Devices에서 삭제 가능).
- 형식: 영문/숫자/`-`/`_` 8~64자. (`UUID.randomUUID().toString()` 그대로 OK)

### 테스트 기기
- 갤럭시 폰 + 갤럭시 탭, 같은 구글 계정. 에뮬레이터 2개도 가능하나 FCM 지연은 실기기로 확인.

### 에러 코드
| 코드 | 의미 |
|---|---|
| 400 | 필수 필드 누락 / 형식 오류 (`{ "error": "..." }`) |
| 401 | 토큰 없음 / 무효 |
| 404 | 없는 deviceId |
| 500 | 서버 오류 |

### FCM data message (서버 → 앱)
notification 없이 `data`만 있는 무음 메시지. 앱은 `FirebaseMessagingService.onMessageReceived()`에서 `data["type"]`으로 분기.

| type | 뜻 | 앱이 할 일 |
|---|---|---|
| `FLUSH` | 다른 기기가 `/sync`를 불렀다 | 미전송 스크롤이 있으면 **즉시** `POST /userlogs` (없으면 아무것도 안 함) |
| `COUNT_UPDATED` | 서버 합계가 바뀌었다 | `GET /sync` 다시 호출해 재적용 |

payload 예: `{ "type": "FLUSH", "sentAt": "1758000000000" }` (FCM data 값은 전부 문자열)
`android.priority = high`로 발송.

**COUNT_UPDATED 발송 대상**: 그 사용자의 기기 중 **최근 2분 안에 `GET /sync`를 부른 기기**만 (= 지금 타겟 앱을 보고 있는 기기). 놀고 있는 기기는 안 깨움.
**FLUSH 발송 대상**: 요청 기기를 제외한, 로그아웃 안 한, 토큰 있는 모든 기기.

---

## 1. 기기 (2주차)

### `POST /devices/register`
로그인 성공 시 + FCM `onNewToken` 시 + 앱 시작 시 호출. 같은 deviceId면 갱신(토큰 교체). 로그아웃 상태였다면 다시 로그인 상태로.

```json
{
  "deviceId": "3f2a9c1e-...",
  "deviceName": "Galaxy S23",
  "fcmToken": "dXk3...",
  "permissionsOk": true
}
```
| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| deviceId | string | ✅ | 위 규칙 |
| deviceName | string | ❌ | `Build.MODEL` 등. 설정 > Devices 표시용 |
| fcmToken | string | ❌ | 없으면 이 기기는 FCM 대상에서 제외 |
| permissionsOk | boolean | ❌ | 접근성 · 사용통계 · 오버레이 3개 모두 ON 이면 true |

응답:
```json
{ "status": "ok", "deviceId": "3f2a9c1e-...", "deviceCount": 2, "serverTime": 1758000000000 }
```
`deviceCount` = 이 계정의 **로그인 상태** 기기 수. **2 이상이면 타겟 앱 포그라운드 동안 배치 주기 1분** (D2).

### `GET /devices`
설정 > Devices 화면용.
```json
{ "userId": "uid", "count": 2, "devices": [
  { "deviceId": "...", "deviceName": "Galaxy S23", "permissionsOk": true,
    "registeredAt": 1758000000000, "lastSeenAt": 1758000600000, "loggedOutAt": null, "hasToken": true }
] }
```

### `DELETE /devices/:deviceId`
설정 > Devices에서 삭제. 문서 삭제 → FCM 대상 · 기기 수에서 빠짐. 그 기기가 올린 userLogs는 그대로 둠.
응답: `{ "status": "ok", "deviceId": "...", "deviceCount": 1 }` / 없으면 404.

---

## 2. 스크롤 업로드 (2주차 — 기존 + deviceId)

### `POST /userlogs` (기존 형식 유지 + `deviceId` 추가)
```json
{
  "userId": "uid",
  "logId": "uuid-per-batch",
  "timestamp": 1758000000000,
  "scrollCount": 10,
  "platform": "youtube",
  "deviceId": "3f2a9c1e-..."
}
```
- `deviceId` 없으면 서버가 `"legacy"`로 저장 (1학기 앱 호환).
- 나머지는 1학기와 동일: `logId`가 문서 ID라 재전송해도 중복 집계 없음, `timestamp`는 배치 첫 스크롤 시각.
- 저장 후 서버가 **최근 2분 안에 `/sync` 부른 다른 기기**에 `COUNT_UPDATED` 발송.

**업로드 트리거 (앱, D2)**: 10회마다 · 5분마다 · 타겟 앱 이탈(홈/앱 전환/Stop) · 화면 꺼짐 · FCM `FLUSH` 수신. 미전송분 0이면 보내지 않음. 기기 2대 이상이면 타겟 앱 포그라운드 동안 1분마다.

---

## 3. 동기화 (2주차 1단계 → 3주차 완성)

### `GET /sync?deviceId=<내 deviceId>`
타겟 앱 진입 시(미전송분 flush 후), `COUNT_UPDATED` 수신 시, 타겟 앱 포그라운드 동안 1분마다 호출.

응답:
```json
{
  "serverTime": 1758000000000,
  "date": "2026-09-15",
  "dailyTotal": 60,
  "otherDevicesLastHour": 12,
  "deviceCount": 2,
  "blockUntil": null,
  "lastShownMilestone": { "hourly": -1, "daily": -1 }
}
```
| 필드 | 설명 | 앱이 할 일 |
|---|---|---|
| dailyTotal | 오늘(KST) 이 계정 **모든 기기** userLogs 합 | 로컬 일간 카운트를 이 값으로 **덮어쓰기** (D4). 이후 스크롤은 로컬 +1, 서버엔 증분만 |
| otherDevicesLastHour | `serverTime − 1h` 이후 **요청 기기가 아닌** 기기들의 userLogs 합 | 로컬 1시간 윈도우 카운트에 **더하기** (D4) |
| deviceCount | 로그인 상태 기기 수 | 2 이상이면 1분 배치 |
| blockUntil | Stop 차단 종료 절대 시각, 없으면 null (3주차) | `now < blockUntil`이면 남은 시간만큼 차단 (D6) |
| lastShownMilestone | 마지막으로 표시된 마일스톤 hourly/daily, 미발생 -1 (3주차) | 로컬 값보다 크면 로컬을 올려서 같은 팝업 생략 (D6) |

부수 효과: 요청 기기의 `lastSyncAt` 갱신 + 다른 기기에 `FLUSH` 발송.
2주차 배포판에서는 `blockUntil: null`, `lastShownMilestone: {-1,-1}` 고정 → 3주차에 실제 값.

**한도 검사(앱, D5)**: 값을 적용한 직후에도 `≥`로 한도 검사. 여러 마일스톤을 건너뛰면 팝업 1번 + 마일스톤을 현재 단계로.

---

## 4. 개입 상태 (3주차)

### `POST /block`
Stop 누른 직후.
```json
{ "deviceId": "...", "blockUntil": 1758000300000 }
```
`users/{uid}.blockUntil` 저장. 응답 `{ "status": "ok", "blockUntil": ... }`. 다른 기기(최근 2분 sync)에 `COUNT_UPDATED` 발송 → 그 기기가 `/sync`로 blockUntil 받음.

### `POST /milestone`
팝업 표시 직후(Stop/Ignore 무관).
```json
{ "deviceId": "...", "hourly": 60, "daily": -1 }
```
서버는 **더 큰 값으로만** 갱신(`max`). 응답 `{ "status": "ok", "lastShownMilestone": { "hourly": 60, "daily": -1 } }`.
※ 자정 롤오버 시 daily는 서버가 날짜 바뀌면 -1로 리셋. hourly는 앱이 슬라이딩 윈도우로 한도 아래로 내려가 -1로 리셋하면 `POST /milestone {hourly:-1}`로 알려 줌 → 서버는 -1 요청은 그대로 받아들임(리셋 허용).

---

## 5. 생존 신호 · 로그아웃 (3주차 서버 / 4주차 앱)

### `POST /heartbeat`
GuardService에서 **기기별 10분마다**.
```json
{ "deviceId": "...", "permissionsOk": false }
```
`devices/{id}.lastSeenAt = now`, `permissionsOk` 갱신. 응답 `{ "status": "ok", "serverTime": ... }`.

### `POST /logout`
로그아웃 버튼 직후, `auth.signOut()` **전에** (토큰 필요).
```json
{ "deviceId": "..." }
```
`devices/{id}.loggedOutAt = now`. 이후 이 기기는 FCM 대상 · deviceCount에서 제외. 다시 로그인하면 `/devices/register`가 `loggedOutAt = null`로 되돌림.
응답 `{ "status": "ok" }`.

---

## 6. Firestore 구조 (신규 부분만)

```
users/{uid}
  blockUntil: number|null
  lastShownMilestone: { hourly: number, daily: number }   // -1 = 미발생
  milestoneDate: "YYYY-MM-DD"                             // daily 리셋 판단용
  devices/{deviceId}
    deviceId, deviceName, fcmToken|null, permissionsOk,
    registeredAt, lastSeenAt, lastSyncAt, loggedOutAt|null

userLogs/{logId}   (기존) + deviceId: string   // 없으면 "legacy"
```

---

## 7. 주차별 서버 배포 상태

| 주차 | 배포되는 것 |
|---|---|
| 2 | §1 기기 3개 · §2 deviceId · §3 `/sync`(dailyTotal, otherDevicesLastHour, deviceCount) · FLUSH / COUNT_UPDATED |
| 3 | §3 `/sync`에 blockUntil, lastShownMilestone · §4 · §5 |
