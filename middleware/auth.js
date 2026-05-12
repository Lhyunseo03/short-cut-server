// middleware/auth.js — Firebase Auth 토큰 검증 미들웨어
// 클라이언트에서 보낸 Firebase ID 토큰을 검증하고 userId를 req에 추가

//firebase.js에서 admin 가져옴 
const { admin } = require('../utils/firebase');

// 토큰 검증 미들웨어
// Authorization: Bearer <token> 헤더에서 토큰 추출 후 Firebase로 검증
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  // Authorization 헤더 없거나 형식이 잘못된 경우
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '인증 토큰이 없습니다' });
  }

  const token = authHeader.split('Bearer ')[1];

  try {
    // Firebase Admin으로 토큰 검증 — 위조된 토큰이면 에러 발생
    const decodedToken = await admin.auth().verifyIdToken(token);

    // 검증 성공 — Firebase UID를 req.userId에 저장해서 다음 핸들러에서 사용 가능
    req.userId = decodedToken.uid;
    next();
  } catch (err) {
    return res.status(401).json({ error: '유효하지 않은 토큰입니다' });
  }
};

module.exports = { verifyToken };