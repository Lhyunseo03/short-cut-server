// middleware/auth.js — Firebase Auth 토큰 검증 미들웨어
// 클라이언트에서 보낸 Firebase ID 토큰을 검증하고 userId를 req에 추가

//firebase.js에서 admin 가져옴
const { admin } = require("../utils/firebase");

// 토큰 검증 미들웨어
// Authorization: Bearer <token> 헤더에서 토큰 추출 후 Firebase로 검증
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  // Authorization 헤더 없거나 형식이 잘못된 경우
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "인증 토큰이 없습니다" });
  }

  const token = authHeader.split("Bearer ")[1];

  try {
    // Firebase Admin으로 토큰 검증 — 위조된 토큰이면 에러 발생
    const decodedToken = await admin.auth().verifyIdToken(token);

    // 검증 성공 — Firebase UID를 req.userId에 저장해서 다음 핸들러에서 사용 가능
    req.userId = decodedToken.uid;
    next();
  } catch (err) {
    return res.status(401).json({ error: "유효하지 않은 토큰입니다" });
  }
};

// 경로의 :userId 가 토큰 주인과 같은지 확인하는 미들웨어
//
// 왜 필요한가 —
//   verifyToken 은 "로그인한 사람인가" 만 본다. "그 데이터의 주인인가" 는 안 본다.
//   /stats/:userId/daily 같은 라우트는 URL 의 userId 를 그대로 써서 조회하므로,
//   로그인만 했으면 남의 uid 를 넣어 다른 사람의 스크롤 기록·통계를 읽거나
//   한도를 바꿀 수 있었다. (2026-09-29 발견)
//
//   반드시 verifyToken 뒤에 놓아야 한다 — req.userId 를 verifyToken 이 채우기 때문.
const verifySelf = (req, res, next) => {
  if (req.params.userId !== req.userId) {
    return res
      .status(403)
      .json({ error: "다른 사용자의 데이터에 접근할 수 없습니다" });
  }
  next();
};

module.exports = { verifyToken, verifySelf };
