const jwt = require("jsonwebtoken");
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer "))
    return res.status(401).json({ message: "กรุณาเข้าสู่ระบบ" });
  try {
    req.user = jwt.verify(h.slice(7), process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: "Token ไม่ถูกต้องหรือหมดอายุ" });
  }
}
function roles(...allowed) {
  return (req, res, next) => {
    if (!req.user || !allowed.includes(req.user.role))
      return res.status(403).json({ message: "ไม่มีสิทธิ์เข้าถึง" });
    next();
  };
}
module.exports = { auth, roles };
