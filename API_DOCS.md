# Short-Cut Server API 문서

**Base URL:** `https://short-cut-server-production.up.railway.app`

---

## 목차

1. [헬스체크](#1-헬스체크)
2. [Limit 설정](#2-limit-설정)
3. [Violation 이벤트](#3-violation-이벤트)
4. [통계](#4-통계)
5. [로그 조회 (개발용)](#5-로그-조회-개발용)

---

## 1. 헬스체크

### `GET /health`

서버가 살아있는지 확인해요.

**요청 예시:**
```
GET /health
```

**응답 예시:**
```json
{
  "status": "ok",
  "uptime": 123.45,
  "time": 1234567890000
}
```

---

## 2. Limit 설정

### `POST /limits/:userId`

사용자의 hourly / daily limit을 저장해요. 이미 있으면 덮어써요.

**요청 예시:**
```
POST /limits/user123
```

**Body:**
```json
{
  "hourlyLimit": 50,
  "dailyLimit": 100
}
```

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| hourlyLimit | number | ✅ | 1시간 스크롤 한도 |
| dailyLimit | number | ✅ | 하루 스크롤 한도 |

**응답 예시:**
```json
{
  "status": "ok"
}
```

---

### `GET /limits/:userId`

사용자의 limit 설정을 가져와요. 설정이 없으면 기본값(hourly: 50, daily: 100)을 반환해요.

**요청 예시:**
```
GET /limits/user123
```

**응답 예시:**
```json
{
  "userId": "user123",
  "hourlyLimit": 50,
  "dailyLimit": 100,
  "updatedAt": 1234567890000
}
```

---

## 3. Violation 이벤트

### `POST /violations`

Android 앱에서 violation이 발생하면 서버로 전송해요.

**요청 예시:**
```
POST /violations
```

**Body:**
```json
{
  "userId": "user123",
  "timestamp": 1234567890000,
  "limitType": "hourly",
  "scrollCount": 55,
  "action": "stop"
}
```

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| userId | string | ✅ | 유저 아이디 |
| timestamp | number | ✅ | 발생 시각 (Unix ms) |
| limitType | string | ✅ | `"hourly"` 또는 `"daily"` |
| scrollCount | number | ✅ | 그 시점 최근 1시간 스크롤 수 |
| action | string | ✅ | `"stop"` 또는 `"ignore"` |

**응답 예시:**
```json
{
  "status": "ok"
}
```

---

## 4. 통계

### `GET /stats/:userId/daily`

특정 날짜의 일간 통계를 가져와요.

**요청 예시:**
```
GET /stats/user123/daily?date=2026-05-03
```

| 파라미터 | 위치 | 필수 | 설명 |
|----------|------|------|------|
| userId | 주소 | ✅ | 유저 아이디 |
| date | 쿼리 | ✅ | 날짜 (예: `2026-05-03`) |

**응답 예시:**
```json
{
  "userId": "user123",
  "date": "2026-05-03",
  "totalScroll": 47,
  "dailyLimit": 100,
  "dailyViolation": true,
  "dailyViolationTime": "2026-05-03T14:20:00.000Z",
  "hourlyLimitExceeded": true,
  "hourlyViolations": [
    {
      "time": "2026-05-03T10:30:00.000Z",
      "recentHourCount": 55,
      "hourlyLimit": 50
    }
  ],
  "stopCount": 1,
  "ignoreCount": 3,
  "peakHour": {
    "time": "2026-05-03T10:30:00.000Z",
    "recentHourCount": 55,
    "hourlyLimit": 50
  },
  "hourlyGraph": [
    { "hour": 10, "scrollCount": 23, "exceeded": true },
    { "hour": 14, "scrollCount": 47, "exceeded": false }
  ]
}
```

| 필드 | 설명 |
|------|------|
| totalScroll | 그날 총 스크롤 횟수 |
| dailyLimit | 하루 limit |
| dailyViolation | daily limit 넘었는지 여부 |
| dailyViolationTime | daily limit 넘은 시각 (없으면 null) |
| hourlyLimitExceeded | hourly limit 넘은 적 있는지 여부 |
| hourlyViolations | hourly violation 목록 |
| stopCount | stop 버튼 누른 횟수 |
| ignoreCount | ignore 버튼 누른 횟수 |
| peakHour | recentHourCount/hourlyLimit 비율이 가장 높은 시각 |
| hourlyGraph | 시간대별 스크롤 횟수 (exceeded = hourly violation 발생 여부) |

---

### `GET /stats/:userId/weekly`

이번 주 (월요일 ~ 오늘) 주간 통계를 가져와요.

**요청 예시:**
```
GET /stats/user123/weekly?date=2026-05-03
```

| 파라미터 | 위치 | 필수 | 설명 |
|----------|------|------|------|
| userId | 주소 | ✅ | 유저 아이디 |
| date | 쿼리 | ✅ | 기준 날짜 (예: `2026-05-03`) |

**응답 예시:**
```json
{
  "userId": "user123",
  "weekStart": "2026-04-27",
  "weekEnd": "2026-05-03",
  "totalScroll": 320,
  "avgScrollPerDay": 45,
  "daysPassed": 7,
  "peakDay": {
    "date": "2026-05-01",
    "scrollCount": 89
  }
}
```

| 필드 | 설명 |
|------|------|
| weekStart | 이번 주 월요일 |
| weekEnd | 오늘 |
| totalScroll | 이번 주 총 스크롤 횟수 |
| avgScrollPerDay | 하루 평균 (총 횟수 / 지난 일수) |
| daysPassed | 월요일부터 오늘까지 일수 |
| peakDay | 가장 많이 스크롤한 날 |

---

### `GET /stats/:userId/monthly`

이번 달 월간 통계를 가져와요.

**요청 예시:**
```
GET /stats/user123/monthly?date=2026-05
```

| 파라미터 | 위치 | 필수 | 설명 |
|----------|------|------|------|
| userId | 주소 | ✅ | 유저 아이디 |
| date | 쿼리 | ✅ | 연월 (예: `2026-05`) |

**응답 예시:**
```json
{
  "userId": "user123",
  "month": "2026-05",
  "totalScroll": 1200,
  "avgScrollPerDay": 40,
  "daysPassed": 3,
  "peakDay": {
    "date": "2026-05-01",
    "scrollCount": 89
  }
}
```

| 필드 | 설명 |
|------|------|
| month | 조회 연월 |
| totalScroll | 이번 달 총 스크롤 횟수 |
| avgScrollPerDay | 하루 평균 (총 횟수 / 지난 일수) |
| daysPassed | 1일부터 오늘까지 일수 |
| peakDay | 가장 많이 스크롤한 날 |

---

## 5. 로그 조회 (개발용)

### `GET /logs/:userId`

특정 유저의 최근 50개 스크롤 로그를 가져와요. 개발/디버깅 용도예요.

**요청 예시:**
```
GET /logs/user123
```

**응답 예시:**
```json
{
  "userId": "user123",
  "count": 3,
  "logs": [
    {
      "id": "abc123",
      "userId": "user123",
      "appPkg": "com.google.android.youtube",
      "eventType": "scroll_event",
      "scrollCount": 10,
      "timestamp": 1234567890000,
      "createdAt": 1234567890000
    }
  ]
}
```

---

### `GET /logs/:userId/range`

시간 범위로 스크롤 로그를 가져와요. 개발/디버깅 용도예요.

**요청 예시:**
```
GET /logs/user123/range?start=1700000000000&end=1700999999999
```

| 파라미터 | 위치 | 필수 | 설명 |
|----------|------|------|------|
| userId | 주소 | ✅ | 유저 아이디 |
| start | 쿼리 | ❌ | 시작 시각 (Unix ms) |
| end | 쿼리 | ❌ | 끝 시각 (Unix ms) |

---

## 에러 코드

| 코드 | 설명 |
|------|------|
| 400 | 잘못된 요청 (필수 필드 누락, 잘못된 값) |
| 500 | 서버 내부 오류 |
