require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const db = require("./db");
const { auth, roles } = require("./auth");
const { decodeProductImage } = require("./product-images");
const {
  sendWelcomeEmail,
  sendSupportRequestReceivedEmail,
  sendSupportRequestUpdateEmail,
} = require("./mail");

const app = express();
const projectRoot = path.resolve(__dirname, "..", "..");
const profileUploadsDirectory = path.join(
  __dirname,
  "..",
  "uploads",
  "profiles",
);
const productUploadsDirectory = path.join(
  __dirname,
  "..",
  "uploads",
  "products",
);
const MAX_PRODUCT_IMAGES = 6;
const productImagesSelect = `COALESCE(
  (SELECT json_agg(pi.image_url ORDER BY pi.position)
   FROM product_images pi WHERE pi.product_id=p.id),
  CASE WHEN p.image_url IS NOT NULL
    THEN json_build_array(p.image_url)
    ELSE '[]'::json
  END
) AS images`;
app.use(helmet());
app.use(
  cors({
    origin: (
      process.env.FRONTEND_ORIGIN ||
      "http://127.0.0.1:5500,http://localhost:5500"
    )
      .split(",")
      .map((s) => s.trim()),
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  }),
);
app.use(express.json({ limit: "5mb" }));
app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }));
app.use(
  "/api/auth/register",
  rateLimit({ windowMs: 60 * 60 * 1000, max: 5 }),
);
const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const tokenFor = (u) =>
  jwt.sign({ id: u.id, email: u.email, role: u.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "2h",
  });
const userProfileQuery =
  "SELECT u.id,u.name,u.email,u.email_verified,u.bio,u.avatar_url,u.university_id,u.role,u.verification_status,un.university_name AS university FROM users u JOIN universities un ON un.id=u.university_id";
async function notifyUser(userId, type, title, message, data = {}) {
  await db.query(
    "INSERT INTO notifications(user_id,type,title,message,data) VALUES(?,?,?,?,?)",
    [userId, type, title, message, JSON.stringify(data)],
  );
}
async function emailAdminsAboutSupportRequest(request) {
  const [admins] = await db.query(
    "SELECT email FROM users WHERE role='admin' AND email IS NOT NULL AND email<>''",
  );
  const deliveries = await Promise.allSettled(
    admins.map(({ email }) =>
      sendSupportRequestReceivedEmail(email, request),
    ),
  );
  for (const delivery of deliveries) {
    if (delivery.status === "rejected")
      console.error(
        "Support request admin email failed:",
        delivery.reason instanceof Error
          ? delivery.reason.message
          : String(delivery.reason),
      );
  }
  return {
    total: admins.length,
    sent: deliveries.filter((delivery) => delivery.status === "fulfilled")
      .length,
  };
}
async function removeStoredProfileImage(avatarUrl, userId) {
  const match =
    /^\/uploads\/profiles\/(\d+)-[0-9a-f-]{36}\.(?:jpg|png|webp)$/i.exec(
      String(avatarUrl || ""),
    );
  if (!match || match[1] !== String(userId)) return;
  try {
    await fs.unlink(path.join(profileUploadsDirectory, path.basename(avatarUrl)));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
async function removeStoredProductImages(imageUrls) {
  for (const imageUrl of new Set(imageUrls)) {
    const match =
      /^\/uploads\/products\/([0-9a-f-]{36}\.jpg)$/i.exec(
        String(imageUrl || ""),
      );
    if (!match) continue;
    try {
      await fs.unlink(path.join(productUploadsDirectory, match[1]));
    } catch (error) {
      if (error.code !== "ENOENT")
        console.error("Could not remove deleted product image:", error.message);
    }
  }
}
const requireVerified = async (req, res, next) => {
  try {
    const [rows] = await db.query(
      "SELECT verification_status FROM users WHERE id=?",
      [req.user.id],
    );
    if (!rows.length)
      return res.status(401).json({ message: "ไม่พบบัญชีผู้ใช้" });
    if (rows[0].verification_status !== "verified")
      return res.status(403).json({
        code: "STUDENT_VERIFICATION_REQUIRED",
        message: "ต้องยืนยันสถานะนักศึกษากับแอดมินก่อนซื้อหรือขายสินค้า",
      });
    next();
  } catch (e) {
    next(e);
  }
};
app.get("/api/health", (req, res) =>
  res.json({ ok: true, service: "Save & Share REST API", version: "2.0" }),
);
app.get(
  "/api/universities",
  asyncRoute(async (req, res) => {
    const [universities] = await db.query(
      "SELECT id, university_name, province FROM universities WHERE is_active=TRUE ORDER BY university_name",
    );
    res.json({ universities });
  }),
);
app.get(
  "/api/me",
  auth,
  asyncRoute(async (req, res) => {
    const [[user]] = await db.query(
      "SELECT u.id,u.name,u.email,u.email_verified,u.bio,u.avatar_url,u.university_id,u.role,u.verification_status,un.university_name AS university,(SELECT COUNT(*)::int FROM products WHERE seller_id=u.id) AS product_count,(SELECT COUNT(*)::int FROM notifications WHERE user_id=u.id AND read_at IS NULL) AS unread_count FROM users u JOIN universities un ON un.id=u.university_id WHERE u.id=?",
      [req.user.id],
    );
    if (!user) return res.status(404).json({ message: "ไม่พบบัญชีผู้ใช้" });
    res.json({ user });
  }),
);
app.patch(
  "/api/me",
  auth,
  asyncRoute(async (req, res) => {
    const name = String(req.body.name || "").trim();
    const bio = String(req.body.bio || "").trim();
    const hasAvatarUrl = Object.prototype.hasOwnProperty.call(
      req.body,
      "avatar_url",
    );
    const requestedAvatarUrl =
      String(req.body.avatar_url || "").trim() || null;
    const avatarImage = String(req.body.avatar_image || "");
    if (!name || name.length > 120 || bio.length > 500)
      return res.status(400).json({
        message: "กรุณากรอกชื่อไม่เกิน 120 ตัวอักษร และแนะนำตัวไม่เกิน 500 ตัวอักษร",
      });
    if (avatarImage && requestedAvatarUrl)
      return res.status(400).json({
        message: "เลือกรูปไฟล์หรือใช้ลิงก์รูปอย่างใดอย่างหนึ่ง",
      });
    const [[currentUser]] = await db.query(
      "SELECT avatar_url FROM users WHERE id=?",
      [req.user.id],
    );
    if (!currentUser)
      return res.status(404).json({ message: "ไม่พบบัญชีผู้ใช้" });
    let avatarUrl = currentUser.avatar_url;
    if (!avatarImage && hasAvatarUrl) avatarUrl = requestedAvatarUrl;
    if (avatarUrl && avatarUrl !== currentUser.avatar_url) {
      try {
        if (!["http:", "https:"].includes(new URL(avatarUrl).protocol))
          throw new Error("invalid protocol");
      } catch {
        return res.status(400).json({ message: "ลิงก์รูปโปรไฟล์ไม่ถูกต้อง" });
      }
    }
    let imageFilePath = null;
    let avatarSaved = false;
    try {
      if (avatarImage) {
        const match =
          /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
            avatarImage,
          );
        if (!match)
          return res.status(400).json({ message: "ไฟล์รูปโปรไฟล์ไม่ถูกต้อง" });
        const imageType = match[1];
        const imageBytes = Buffer.from(match[2], "base64");
        const validImage =
          (imageType === "jpeg" &&
            imageBytes.length >= 3 &&
            imageBytes[0] === 0xff &&
            imageBytes[1] === 0xd8 &&
            imageBytes[2] === 0xff) ||
          (imageType === "png" &&
            imageBytes.length >= 8 &&
            imageBytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
          (imageType === "webp" &&
            imageBytes.length >= 12 &&
            imageBytes.toString("ascii", 0, 4) === "RIFF" &&
            imageBytes.toString("ascii", 8, 12) === "WEBP");
        if (
          imageBytes.length === 0 ||
          imageBytes.length > 600 * 1024 ||
          imageBytes.toString("base64") !== match[2] ||
          !validImage
        )
          return res.status(400).json({
            message: "รูปต้องเป็น JPG, PNG หรือ WEBP และมีขนาดไม่เกิน 600 KB",
          });

        const extension = imageType === "jpeg" ? "jpg" : imageType;
        const filename = `${req.user.id}-${randomUUID()}.${extension}`;
        imageFilePath = path.join(profileUploadsDirectory, filename);
        await fs.mkdir(profileUploadsDirectory, { recursive: true });
        await fs.writeFile(imageFilePath, imageBytes, { flag: "wx" });
        avatarUrl = `/uploads/profiles/${filename}`;
      }

      const [rows] = await db.query(
        "UPDATE users SET name=?,bio=?,avatar_url=? WHERE id=? RETURNING id",
        [name, bio, avatarUrl, req.user.id],
      );
      if (!rows.length) {
        if (imageFilePath) {
          await fs.unlink(imageFilePath);
          imageFilePath = null;
        }
        return res.status(404).json({ message: "ไม่พบบัญชีผู้ใช้" });
      }
      avatarSaved = true;
      const [[user]] = await db.query(`${userProfileQuery} WHERE u.id=?`, [
        req.user.id,
      ]);
      if (currentUser.avatar_url !== avatarUrl) {
        try {
          await removeStoredProfileImage(currentUser.avatar_url, req.user.id);
        } catch (error) {
          console.error("Could not remove old profile image:", error.message);
        }
      }
      res.json({ user, message: "บันทึกโปรไฟล์แล้ว" });
    } catch (error) {
      if (imageFilePath && !avatarSaved) {
        try {
          await fs.unlink(imageFilePath);
        } catch (cleanupError) {
          if (cleanupError.code !== "ENOENT")
            console.error(
              "Could not remove unsaved profile image:",
              cleanupError.message,
            );
        }
      }
      throw error;
    }
  }),
);
app.get(
  "/api/users/:id",
  asyncRoute(async (req, res) => {
    if (!/^\d+$/.test(req.params.id))
      return res.status(400).json({ message: "รหัสผู้ใช้ไม่ถูกต้อง" });
    const [[user]] = await db.query(
      "SELECT u.id,u.name,u.bio,u.avatar_url,u.created_at,un.university_name AS university,u.verification_status,(SELECT COUNT(*)::int FROM products p WHERE p.seller_id=u.id AND p.status='active') AS product_count FROM users u JOIN universities un ON un.id=u.university_id WHERE u.id=?",
      [req.params.id],
    );
    if (!user) return res.status(404).json({ message: "ไม่พบบัญชีผู้ใช้" });
    res.json({ user });
  }),
);
app.get(
  "/api/me/products",
  auth,
  asyncRoute(async (req, res) => {
    const [products] = await db.query(
      `SELECT p.id,p.name,p.description,p.category,p.price,p.condition_label AS "condition",p.image_url,${productImagesSelect},p.status,p.created_at FROM products p WHERE p.seller_id=? ORDER BY p.created_at DESC`,
      [req.user.id],
    );
    res.json({ products });
  }),
);
app.get(
  "/api/notifications",
  auth,
  asyncRoute(async (req, res) => {
    const [notifications] = await db.query(
      "SELECT id,type,title,message,data,created_at,read_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
      [req.user.id],
    );
    res.json({ notifications });
  }),
);
app.patch(
  "/api/notifications/read-all",
  auth,
  asyncRoute(async (req, res) => {
    await db.query(
      "UPDATE notifications SET read_at=NOW() WHERE user_id=? AND read_at IS NULL",
      [req.user.id],
    );
    res.json({ message: "อ่านการแจ้งเตือนแล้ว" });
  }),
);
app.patch(
  "/api/notifications/:id/read",
  auth,
  asyncRoute(async (req, res) => {
    const [rows] = await db.query(
      "UPDATE notifications SET read_at=NOW() WHERE id=? AND user_id=? AND read_at IS NULL RETURNING id",
      [req.params.id, req.user.id],
    );
    if (!rows.length)
      return res.status(404).json({ message: "ไม่พบการแจ้งเตือน" });
    res.json({ message: "อ่านการแจ้งเตือนแล้ว" });
  }),
);
app.delete(
  "/api/notifications",
  auth,
  asyncRoute(async (req, res) => {
    await db.query("DELETE FROM notifications WHERE user_id=?", [req.user.id]);
    res.json({ message: "ล้างการแจ้งเตือนแล้ว" });
  }),
);

app.post(
  "/api/auth/register",
  asyncRoute(async (req, res) => {
    const name = String(req.body.name || "").trim(),
      email = String(req.body.email || "")
        .trim()
        .toLowerCase(),
      password = String(req.body.password || ""),
      universityId = Number(req.body.universityId),
      role = req.body.role || "buyer";
    if (!name || !email || !password || !Number.isInteger(universityId))
      return res
        .status(400)
        .json({ message: "กรอกชื่อ อีเมล รหัสผ่าน และเลือกมหาวิทยาลัย" });
    if (!/^[^\s@]+@[^\s@]+\.ac\.th$/i.test(email))
      return res.status(400).json({
        message: "กรุณาใช้อีเมลมหาวิทยาลัยไทยที่ลงท้ายด้วย .ac.th",
      });
    if (password.length < 8)
      return res
        .status(400)
        .json({ message: "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร" });
    if (!["buyer", "seller"].includes(role))
      return res.status(400).json({ message: "ประเภทบัญชีไม่ถูกต้อง" });
    const [[existingUser]] = await db.query(
      "SELECT id FROM users WHERE email=?",
      [email],
    );
    if (existingUser)
      return res.status(409).json({ message: "อีเมลนี้มีบัญชีในระบบแล้ว" });
    const [[uni]] = await db.query(
      "SELECT id,university_name FROM universities WHERE id=? AND is_active=TRUE",
      [universityId],
    );
    if (!uni)
      return res.status(400).json({ message: "ไม่พบมหาวิทยาลัยที่เลือก" });
    const passwordHash = await bcrypt.hash(password, 12);
    const [users] = await db.query(
      "INSERT INTO users(name,email,email_verified,password_hash,university_id,role) VALUES(?,?,FALSE,?,?,?) RETURNING id",
      [name, email, passwordHash, universityId, role],
    );
    const [[user]] = await db.query(
      `${userProfileQuery} WHERE u.id=?`,
      [users[0].id],
    );
    let notificationCreated = true;
    try {
      await notifyUser(
        user.id,
        "welcome",
        "ยินดีต้อนรับสู่ Save & Share",
        "สมัครสมาชิกสำเร็จ คุณสามารถเริ่มซื้อ ขาย และแชทกับสมาชิกคนอื่นได้",
        { action: "registration" },
      );
    } catch (error) {
      notificationCreated = false;
      console.error("Welcome notification failed:", error.message);
    }
    let emailSent = true;
    try {
      await sendWelcomeEmail(email, name);
    } catch (error) {
      emailSent = false;
      console.error("Welcome email failed:", error.message);
    }
    res.status(201).json({
      user,
      token: tokenFor(user),
      emailSent,
      notificationCreated,
      message: emailSent
        ? "สมัครสมาชิกสำเร็จ ระบบส่งอีเมลแจ้งไปยังอีเมลที่สมัครแล้ว"
        : "สมัครสมาชิกสำเร็จ แต่ส่งอีเมลแจ้งไม่สำเร็จ",
    });
  }),
);
app.delete(
  "/api/products/:id",
  auth,
  requireVerified,
  asyncRoute(async (req, res) => {
    const conn = await db.getConnection();
    let transactionOpen = false;
    let productId;
    let imageUrls = [];
    try {
      await conn.beginTransaction();
      transactionOpen = true;
      const [[product]] = await conn.query(
        "SELECT id,status,image_url FROM products WHERE id=? AND seller_id=? FOR UPDATE",
        [req.params.id, req.user.id],
      );
      if (!product) {
        await conn.rollback();
        transactionOpen = false;
        return res.status(404).json({ message: "ไม่พบสินค้าของคุณ" });
      }
      if (product.status === "sold") {
        await conn.rollback();
        transactionOpen = false;
        return res.status(409).json({
          message: "สินค้านี้ขายแล้ว ไม่สามารถลบได้ และจะแสดงสถานะ SOLD OUT",
        });
      }
      const [orders] = await conn.query(
        "SELECT id FROM order_items WHERE product_id=? LIMIT 1",
        [product.id],
      );
      if (orders.length) {
        await conn.rollback();
        transactionOpen = false;
        return res.status(409).json({
          message: "สินค้านี้มีประวัติคำสั่งซื้อ จึงลบไม่ได้",
        });
      }
      const [conversations] = await conn.query(
        "SELECT id FROM conversations WHERE product_id=? LIMIT 1",
        [product.id],
      );
      if (conversations.length) {
        await conn.rollback();
        transactionOpen = false;
        return res.status(409).json({
          message: "สินค้านี้มีประวัติแชท ลบไม่ได้ กรุณาซ่อนประกาศแทน",
        });
      }
      const [images] = await conn.query(
        "SELECT image_url FROM product_images WHERE product_id=?",
        [product.id],
      );
      imageUrls = [product.image_url, ...images.map((image) => image.image_url)];
      const [deleted] = await conn.query(
        "DELETE FROM products WHERE id=? AND seller_id=? RETURNING id",
        [product.id, req.user.id],
      );
      if (!deleted.length) {
        await conn.rollback();
        transactionOpen = false;
        return res.status(404).json({ message: "ไม่พบสินค้าของคุณ" });
      }
      productId = deleted[0].id;
      await conn.commit();
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) {
        try {
          await conn.rollback();
        } catch (rollbackError) {
          console.error("Could not roll back product deletion:", rollbackError);
        }
      }
      if (error.code === "23503")
        return res.status(409).json({
          message: "สินค้านี้มีประวัติการซื้อขายหรือแชท จึงลบไม่ได้",
        });
      throw error;
    } finally {
      conn.release();
    }
    await removeStoredProductImages(imageUrls);
    res.json({ id: productId, message: "ลบประกาศแล้ว" });
  }),
);
app.post(
  "/api/auth/login",
  asyncRoute(async (req, res) => {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    const [rows] = await db.query(
      "SELECT u.id,u.name,u.email,u.email_verified,u.password_hash,u.bio,u.avatar_url,u.university_id,u.role,u.verification_status,un.university_name AS university FROM users u JOIN universities un ON un.id=u.university_id WHERE u.email=?",
      [email],
    );
    if (
      !rows.length ||
      !(await bcrypt.compare(
        String(req.body.password || ""),
        rows[0].password_hash,
      ))
    )
      return res.status(401).json({ message: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" });
    const u = rows[0];
    const user = {
      id: u.id,
      name: u.name,
      email: u.email,
      email_verified: u.email_verified,
      bio: u.bio,
      avatar_url: u.avatar_url,
      university_id: u.university_id,
      university: u.university,
      role: u.role,
      verification_status: u.verification_status,
    };
    res.json({ user, token: tokenFor(user) });
  }),
);

app.get(
  "/api/products",
  asyncRoute(async (req, res) => {
    const {
      q = "",
      category = "",
      condition = "",
      minPrice = "",
      maxPrice = "",
      sort = "new",
      universityId = "",
    } = req.query;
    let sql =
      `SELECT p.id,p.name,p.description,p.category,p.price,p.condition_label AS "condition",p.image_url,${productImagesSelect},p.status,p.seller_id,u.name AS seller_name,u.avatar_url AS seller_avatar_url,u.verification_status,un.university_name AS university FROM products p JOIN users u ON u.id=p.seller_id JOIN universities un ON un.id=u.university_id WHERE p.status IN ('active','sold')`;
    const vals = [];
    if (q) {
      sql += " AND (p.name ILIKE ? OR p.description ILIKE ? OR u.name ILIKE ?)";
      vals.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (category) {
      sql += " AND p.category=?";
      vals.push(category);
    }
    if (condition) {
      sql += " AND p.condition_label=?";
      vals.push(condition);
    }
    if (minPrice !== "" && Number.isFinite(Number(minPrice))) {
      sql += " AND p.price>=?";
      vals.push(Number(minPrice));
    }
    if (maxPrice !== "" && Number.isFinite(Number(maxPrice))) {
      sql += " AND p.price<=?";
      vals.push(Number(maxPrice));
    }
    if (universityId && Number.isInteger(Number(universityId))) {
      sql += " AND u.university_id=?";
      vals.push(Number(universityId));
    }
    sql +=
      " ORDER BY " +
      (sort === "low"
        ? "p.price ASC"
        : sort === "high"
          ? "p.price DESC"
          : "p.created_at DESC") +
      " LIMIT 100";
    const [products] = await db.query(sql, vals);
    res.json({ products });
  }),
);
app.get(
  "/api/products/:id",
  asyncRoute(async (req, res) => {
    const [rows] = await db.query(
      `SELECT p.id,p.name,p.description,p.category,p.price,p.condition_label AS "condition",p.image_url,${productImagesSelect},p.status,p.seller_id,u.name AS seller_name,u.avatar_url AS seller_avatar_url,u.university_id,un.university_name AS university,u.verification_status FROM products p JOIN users u ON u.id=p.seller_id JOIN universities un ON un.id=u.university_id WHERE p.id=? AND p.status IN ('active','sold') LIMIT 1`,
      [req.params.id],
    );
    if (!rows.length)
      return res.status(404).json({ message: "ไม่พบสินค้านี้" });
    res.json({ product: rows[0] });
  }),
);
app.post(
  "/api/products",
  auth,
  requireVerified,
  asyncRoute(async (req, res) => {
    const name = String(req.body.name || "").trim(),
      description = String(req.body.description || "").trim(),
      category = String(req.body.category || "").trim(),
      price = Number(req.body.price),
      condition = req.body.condition || "ใช้งานดี",
      imageUrl = String(req.body.image_url || "").trim() || null,
      imageDataUrls = req.body.images ?? [];
    if (
      !name ||
      !category ||
      !Number.isFinite(price) ||
      price < 0 ||
      !["เหมือนใหม่", "ใช้งานดี", "มีตำหนิ"].includes(condition)
    )
      return res
        .status(400)
        .json({ message: "กรอกชื่อ หมวดหมู่ ราคา และสภาพสินค้าให้ถูกต้อง" });
    if (!Array.isArray(imageDataUrls))
      return res.status(400).json({ message: "รายการรูปสินค้าไม่ถูกต้อง" });
    if (
      imageDataUrls.length > MAX_PRODUCT_IMAGES ||
      imageDataUrls.length + (imageUrl ? 1 : 0) > MAX_PRODUCT_IMAGES
    )
      return res.status(400).json({
        message: `เลือกได้ไม่เกิน ${MAX_PRODUCT_IMAGES} รูป รวมลิงก์รูปภาพ`,
      });
    if (imageUrl) {
      try {
        if (
          imageUrl.length > 500 ||
          !["http:", "https:"].includes(new URL(imageUrl).protocol)
        )
          throw new Error("invalid image URL");
      } catch {
        return res.status(400).json({
          message: "ลิงก์รูปภาพต้องเป็น HTTP หรือ HTTPS และไม่เกิน 500 ตัวอักษร",
        });
      }
    }
    const imageBytes = imageDataUrls.map((dataUrl) =>
      typeof dataUrl === "string" ? decodeProductImage(dataUrl) : null,
    );
    if (imageBytes.some((image) => !image))
      return res.status(400).json({
        message: "รูปต้องเป็น JPEG ที่ถูกต้อง ขนาดไม่เกิน 500 KB และไม่เกิน 1600 × 1600 พิกเซล",
      });

    const storedFiles = [];
    let conn;
    let committed = false;
    try {
      await fs.mkdir(productUploadsDirectory, { recursive: true });
      const imageUrls = [];
      for (const image of imageBytes) {
        const filename = `${randomUUID()}.jpg`;
        const filePath = path.join(productUploadsDirectory, filename);
        await fs.writeFile(filePath, image, { flag: "wx" });
        storedFiles.push(filePath);
        imageUrls.push(`/uploads/products/${filename}`);
      }
      if (imageUrl) imageUrls.push(imageUrl);

      conn = await db.getConnection();
      await conn.beginTransaction();
      const [rows] = await conn.query(
        "INSERT INTO products(seller_id,name,description,category,price,condition_label,image_url) VALUES(?,?,?,?,?,?,?) RETURNING id",
        [
          req.user.id,
          name,
          description,
          category,
          price,
          condition,
          imageUrls[0] || null,
        ],
      );
      const productId = rows[0].id;
      for (const [position, url] of imageUrls.entries()) {
        await conn.query(
          "INSERT INTO product_images(product_id,position,image_url) VALUES(?,?,?)",
          [productId, position, url],
        );
      }
      await conn.commit();
      committed = true;
      res.status(201).json({
        id: productId,
        images: imageUrls,
        message: "ลงขายสินค้าแล้ว",
      });
    } catch (error) {
      if (conn && !committed) {
        try {
          await conn.rollback();
        } catch (rollbackError) {
          console.error("Could not roll back product creation:", rollbackError);
        }
      }
      if (!committed) {
        for (const filePath of storedFiles) {
          try {
            await fs.unlink(filePath);
          } catch (cleanupError) {
            if (cleanupError.code !== "ENOENT")
              console.error(
                "Could not remove unsaved product image:",
                cleanupError.message,
              );
          }
        }
      }
      throw error;
    } finally {
      if (conn) conn.release();
    }
  }),
);
app.patch(
  "/api/products/:id",
  auth,
  requireVerified,
  asyncRoute(async (req, res) => {
    const status = String(req.body.status || "");
    if (!["active", "hidden"].includes(status))
      return res.status(400).json({ message: "สถานะสินค้าไม่ถูกต้อง" });
    const [rows] = await db.query(
      "UPDATE products SET status=? WHERE id=? AND seller_id=? AND status<>'sold' RETURNING id",
      [status, req.params.id, req.user.id],
    );
    if (!rows.length)
      return res.status(404).json({
        message: "ไม่พบสินค้าของคุณ หรือสินค้าถูกขายไปแล้ว",
      });
    res.json({ id: rows[0].id, status, message: "อัปเดตสถานะสินค้าแล้ว" });
  }),
);
app.post(
  "/api/chats",
  auth,
  asyncRoute(async (req, res) => {
    const productId = Number(req.body.productId);
    if (!Number.isInteger(productId) || productId < 1)
      return res.status(400).json({ message: "รหัสสินค้าไม่ถูกต้อง" });
    const [[product]] = await db.query(
      "SELECT id,name,seller_id,status FROM products WHERE id=?",
      [productId],
    );
    if (!product || product.status !== "active")
      return res.status(404).json({ message: "ไม่พบสินค้าที่กำลังขาย" });
    if (Number(product.seller_id) === Number(req.user.id))
      return res.status(400).json({ message: "ไม่สามารถเริ่มแชทกับตัวเองได้" });
    const [rows] = await db.query(
      "INSERT INTO conversations(product_id,buyer_id,seller_id) VALUES(?,?,?) ON CONFLICT (product_id,buyer_id) DO UPDATE SET product_id=EXCLUDED.product_id RETURNING id",
      [product.id, req.user.id, product.seller_id],
    );
    res.status(201).json({ conversationId: rows[0].id });
  }),
);
app.get(
  "/api/chats",
  auth,
  asyncRoute(async (req, res) => {
    const [conversations] = await db.query(
      "SELECT c.id,c.product_id,p.name AS product_name,c.created_at,peer.id AS peer_id,peer.name AS peer_name,peer.avatar_url AS peer_avatar,un.university_name AS peer_university,last_message.message AS last_message,last_message.created_at AS last_message_at,COALESCE(unread.count,0)::int AS unread_count FROM conversations c JOIN products p ON p.id=c.product_id JOIN users peer ON peer.id=CASE WHEN c.buyer_id=? THEN c.seller_id ELSE c.buyer_id END JOIN universities un ON un.id=peer.university_id LEFT JOIN LATERAL (SELECT message,created_at FROM chat_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_message ON TRUE LEFT JOIN LATERAL (SELECT COUNT(*) AS count FROM chat_messages WHERE conversation_id=c.id AND sender_id<>? AND read_at IS NULL) AS unread ON TRUE WHERE c.buyer_id=? OR c.seller_id=? ORDER BY COALESCE(last_message.created_at,c.created_at) DESC",
      [req.user.id, req.user.id, req.user.id, req.user.id],
    );
    res.json({ conversations });
  }),
);
app.get(
  "/api/chats/:id/messages",
  auth,
  asyncRoute(async (req, res) => {
    const [[conversation]] = await db.query(
      "SELECT id FROM conversations WHERE id=? AND (buyer_id=? OR seller_id=?)",
      [req.params.id, req.user.id, req.user.id],
    );
    if (!conversation)
      return res.status(404).json({ message: "ไม่พบห้องสนทนา" });
    await db.query(
      "UPDATE chat_messages SET read_at=NOW() WHERE conversation_id=? AND sender_id<>? AND read_at IS NULL",
      [conversation.id, req.user.id],
    );
    await db.query(
      "UPDATE notifications SET read_at=NOW() WHERE user_id=? AND type='chat_message' AND data->>'conversation_id'=? AND read_at IS NULL",
      [req.user.id, String(conversation.id)],
    );
    const [messages] = await db.query(
      "SELECT id,conversation_id,sender_id,message,created_at,read_at FROM (SELECT id,conversation_id,sender_id,message,created_at,read_at FROM chat_messages WHERE conversation_id=? ORDER BY id DESC LIMIT 500) latest_messages ORDER BY id ASC",
      [conversation.id],
    );
    res.json({ messages });
  }),
);
app.post(
  "/api/chats/:id/messages",
  auth,
  asyncRoute(async (req, res) => {
    const message = String(req.body.message || "").trim();
    if (!message || message.length > 2000)
      return res.status(400).json({ message: "ข้อความต้องมี 1–2000 ตัวอักษร" });
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [[conversation]] = await conn.query(
        "SELECT id,product_id,buyer_id,seller_id FROM conversations WHERE id=? AND (buyer_id=? OR seller_id=?) FOR UPDATE",
        [req.params.id, req.user.id, req.user.id],
      );
      if (!conversation) {
        await conn.rollback();
        return res.status(404).json({ message: "ไม่พบห้องสนทนา" });
      }
      const recipientId =
        Number(conversation.buyer_id) === Number(req.user.id)
          ? conversation.seller_id
          : conversation.buyer_id;
      const [[product]] = await conn.query(
        "SELECT name FROM products WHERE id=?",
        [conversation.product_id],
      );
      const [rows] = await conn.query(
        "INSERT INTO chat_messages(conversation_id,sender_id,message) VALUES(?,?,?)",
        [conversation.id, req.user.id, message],
      );
      await conn.query(
        "INSERT INTO notifications(user_id,type,title,message,data) VALUES(?,'chat_message','ข้อความใหม่',?,?)",
        [
          recipientId,
          `${req.user.name || req.user.email} ส่งข้อความเกี่ยวกับ ${product.name}`,
          JSON.stringify({ conversation_id: String(conversation.id) }),
        ],
      );
      await conn.commit();
      res.status(201).json({ id: rows.insertId, message });
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }),
);

app.post(
  "/api/orders",
  auth,
  requireVerified,
  roles("buyer", "seller"),
  asyncRoute(async (req, res) => {
    const items = req.body.items,
      fulfillment = req.body.fulfillment || "delivery";
    if (!Array.isArray(items) || !items.length)
      return res
        .status(400)
        .json({ message: "ต้องมีสินค้าอย่างน้อย 1 รายการ" });
    if (!["delivery", "pickup"].includes(fulfillment))
      return res.status(400).json({ message: "วิธีรับสินค้าไม่ถูกต้อง" });
    if (
      fulfillment === "delivery" &&
      !String(req.body.deliveryAddress || "").trim()
    )
      return res.status(400).json({ message: "กรุณาระบุที่อยู่จัดส่ง" });
    const ids = [
      ...new Set(
        items
          .map((i) => Number(i.productId))
          .filter((n) => Number.isInteger(n) && n > 0),
      ),
    ];
    if (!ids.length || ids.length !== items.length)
      return res
        .status(400)
        .json({ message: "รหัสสินค้าไม่ถูกต้องหรือมีรายการซ้ำ" });
    const qtyMap = new Map(
      items.map((i) => [Number(i.productId), Number(i.quantity) || 1]),
    );
    if (
      [...qtyMap.values()].some((q) => !Number.isInteger(q) || q < 1 || q > 20)
    )
      return res
        .status(400)
        .json({ message: "จำนวนสินค้าต้องอยู่ระหว่าง 1–20 ชิ้น" });
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [products] = await conn.query(
        `SELECT id,name,price,seller_id,status FROM products WHERE id IN (${ids.map(() => "?").join(",")}) FOR UPDATE`,
        ids,
      );
      if (
        products.length !== ids.length ||
        products.some((p) => p.status !== "active")
      )
        throw Object.assign(
          new Error("สินค้าบางรายการไม่มีอยู่หรือขายไปแล้ว"),
          { status: 409 },
        );
      if (products.some((p) => Number(p.seller_id) === Number(req.user.id)))
        throw Object.assign(new Error("ไม่สามารถซื้อสินค้าของบัญชีตัวเองได้"), {
          status: 400,
        });
      if (new Set(products.map((p) => Number(p.seller_id))).size !== 1)
        throw Object.assign(
          new Error(
            "หนึ่งคำสั่งซื้อต้องเป็นสินค้าจากผู้ขายรายเดียว กรุณาแยกสั่งซื้อ",
          ),
          { status: 400 },
        );
      const total =
        products.reduce(
          (sum, p) => sum + Number(p.price) * qtyMap.get(Number(p.id)),
          0,
        ) + (fulfillment === "delivery" ? 40 : 0);
      const [order] = await conn.query(
        "INSERT INTO orders(buyer_id,total_amount,fulfillment,delivery_address,pickup_note) VALUES(?,?,?,?,?)",
        [
          req.user.id,
          total,
          fulfillment,
          fulfillment === "delivery"
            ? String(req.body.deliveryAddress).trim()
            : null,
          fulfillment === "pickup"
            ? String(req.body.pickupNote || "").trim()
            : null,
        ],
      );
      for (const p of products) {
        await conn.query(
          "INSERT INTO order_items(order_id,product_id,product_name,unit_price,quantity) VALUES(?,?,?,?,?)",
          [order.insertId, p.id, p.name, p.price, qtyMap.get(Number(p.id))],
        );
        await conn.query("UPDATE products SET status='sold' WHERE id=?", [
          p.id,
        ]);
      }
      await conn.query(
        "INSERT INTO notifications(user_id,type,title,message,data) VALUES(?,'new_order','มีคำสั่งซื้อใหม่',?,?)",
        [
          products[0].seller_id,
          `มีคำสั่งซื้อ #${order.insertId} เข้ามา`,
          JSON.stringify({ order_id: String(order.insertId) }),
        ],
      );
      await conn.commit();
      res.status(201).json({
        id: order.insertId,
        total_amount: total,
        status: "pending",
        fulfillment,
      });
    } catch (e) {
      await conn.rollback();
      if (e.status) return res.status(e.status).json({ message: e.message });
      throw e;
    } finally {
      conn.release();
    }
  }),
);
app.get(
  "/api/orders",
  auth,
  asyncRoute(async (req, res) => {
    let sql =
      "SELECT o.id,o.buyer_id,o.total_amount,o.status,o.fulfillment,o.delivery_address,o.pickup_note,o.created_at,oi.product_id,oi.product_name AS name,oi.quantity,p.seller_id FROM orders o JOIN order_items oi ON oi.order_id=o.id JOIN products p ON p.id=oi.product_id";
    const vals = [];
    if (req.user.role !== "admin") {
      sql += " WHERE p.seller_id=? OR o.buyer_id=?";
      vals.push(req.user.id, req.user.id);
    }
    sql += " ORDER BY o.created_at DESC";
    const [rows] = await db.query(sql, vals);
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.id))
        map.set(r.id, {
          id: r.id,
          buyer_id: r.buyer_id,
          total_amount: r.total_amount,
          status: r.status,
          fulfillment: r.fulfillment,
          delivery_address: r.delivery_address,
          pickup_note: r.pickup_note,
          created_at: r.created_at,
          items: [],
        });
      map.get(r.id).items.push({
        product_id: r.product_id,
        name: r.name,
        quantity: r.quantity,
        seller_id: r.seller_id,
      });
    }
    res.json({ orders: [...map.values()] });
  }),
);
app.patch(
  "/api/orders/:id/status",
  auth,
  asyncRoute(async (req, res) => {
    const status = req.body.status,
      allowed = [
        "confirmed",
        "preparing",
        "shipped",
        "ready_pickup",
        "completed",
        "cancelled",
      ];
    if (!allowed.includes(status))
      return res.status(400).json({ message: "สถานะไม่ถูกต้อง" });
    const [rows] = await db.query(
      "SELECT o.id,o.buyer_id,o.status AS old_status,o.fulfillment,p.seller_id,oi.product_id FROM orders o JOIN order_items oi ON oi.order_id=o.id JOIN products p ON p.id=oi.product_id WHERE o.id=?",
      [req.params.id],
    );
    if (!rows.length)
      return res.status(404).json({ message: "ไม่พบคำสั่งซื้อ" });
    if (
      req.user.role !== "admin" &&
      rows.some((r) => Number(r.seller_id) !== Number(req.user.id))
    )
      return res
        .status(403)
        .json({ message: "ไม่มีสิทธิ์จัดการคำสั่งซื้อนี้" });
    if (status === "shipped" && rows[0].fulfillment !== "delivery")
      return res
        .status(400)
        .json({ message: "คำสั่งซื้อนัดรับไม่สามารถเปลี่ยนเป็นจัดส่ง" });
    if (status === "ready_pickup" && rows[0].fulfillment !== "pickup")
      return res
        .status(400)
        .json({ message: "คำสั่งซื้อจัดส่งไม่สามารถเปลี่ยนเป็นพร้อมนัดรับ" });
    await db.query("UPDATE orders SET status=? WHERE id=?", [
      status,
      req.params.id,
    ]);
    const buyerId = rows[0].buyer_id;
    if (Number(buyerId) !== Number(req.user.id)) {
      await notifyUser(
        buyerId,
        "order_status",
        "อัปเดตสถานะคำสั่งซื้อ",
        `คำสั่งซื้อ #${req.params.id} เปลี่ยนเป็น ${status}`,
        { order_id: String(req.params.id) },
      );
    }
    if (status === "cancelled")
      await db.query(
        "UPDATE products SET status='active' WHERE id IN (SELECT product_id FROM order_items WHERE order_id=?)",
        [req.params.id],
      );
    res.json({ message: "อัปเดตสถานะแล้ว", id: req.params.id, status });
  }),
);
app.get(
  "/api/reviews",
  asyncRoute(async (req, res) => {
    let sql =
      "SELECT r.id,r.order_id,r.seller_id,r.reviewer_id,r.rating,r.comment,r.created_at,u.name AS reviewer_name FROM reviews r JOIN users u ON u.id=r.reviewer_id";
    const vals = [];
    if (req.query.sellerId) {
      sql += " WHERE r.seller_id=?";
      vals.push(Number(req.query.sellerId));
    }
    sql += " ORDER BY r.created_at DESC LIMIT 100";
    const [reviews] = await db.query(sql, vals);
    res.json({ reviews });
  }),
);
app.post(
  "/api/reviews",
  auth,
  requireVerified,
  asyncRoute(async (req, res) => {
    const sellerId = Number(req.body.sellerId),
      rating = Number(req.body.rating),
      comment = String(req.body.comment || "").trim();
    if (
      !sellerId ||
      !Number.isInteger(rating) ||
      rating < 1 ||
      rating > 5 ||
      !comment ||
      comment.length > 1000
    )
      return res.status(400).json({
        message: "กรอกผู้ขาย คะแนน 1–5 และข้อความรีวิวไม่เกิน 1000 ตัวอักษร",
      });
    const [orders] = await db.query(
      "SELECT o.id FROM orders o JOIN order_items oi ON oi.order_id=o.id JOIN products p ON p.id=oi.product_id WHERE o.buyer_id=? AND p.seller_id=? AND o.status='completed' LIMIT 1",
      [req.user.id, sellerId],
    );
    if (!orders.length)
      return res.status(403).json({
        message: "รีวิวได้หลังมีคำสั่งซื้อสำเร็จกับผู้ขายรายนี้เท่านั้น",
      });
    await db.query(
      "INSERT INTO reviews(order_id,reviewer_id,seller_id,rating,comment) VALUES(?,?,?,?,?)",
      [orders[0].id, req.user.id, sellerId, rating, comment],
    );
    res.status(201).json({ message: "บันทึกรีวิวแล้ว" });
  }),
);
app.post(
  "/api/verification",
  auth,
  asyncRoute(async (req, res) => {
    const studentCode = String(req.body.studentCode || "").trim(),
      studentEmail = String(req.body.studentEmail || "")
        .trim()
        .toLowerCase();
    if (!studentCode)
      return res.status(400).json({ message: "กรอกรหัสนักศึกษา" });
    const [[u]] = await db.query(
      "SELECT university_id,verification_status FROM users WHERE id=?",
      [req.user.id],
    );
    if (!u) return res.status(404).json({ message: "ไม่พบบัญชีผู้ใช้" });
    if (u.verification_status === "verified")
      return res.status(409).json({ message: "บัญชีนี้ยืนยันแล้ว" });
    const [[pending]] = await db.query(
      "SELECT id FROM student_verifications WHERE user_id=? AND status='pending' LIMIT 1",
      [req.user.id],
    );
    if (pending)
      return res.status(409).json({ message: "มีคำขอตรวจสอบที่รอผลอยู่แล้ว" });
    const [r] = await db.query(
      "INSERT INTO student_verifications(user_id,university_id,student_code,student_email,status) VALUES(?,?,?,?,'pending')",
      [req.user.id, u.university_id, studentCode, studentEmail || null],
    );
    await db.query(
      "UPDATE users SET verification_status='pending',student_code=?,student_email=? WHERE id=?",
      [studentCode, studentEmail || null, req.user.id],
    );
    res.status(201).json({
      id: r.insertId,
      message: "ส่งคำขอแล้ว รอแอดมินตรวจสอบก่อนซื้อหรือขายสินค้า",
    });
  }),
);
app.post(
  "/api/support-requests",
  auth,
  asyncRoute(async (req, res) => {
    const category = String(req.body.category || "").trim();
    const subject = String(req.body.subject || "").trim();
    const message = String(req.body.message || "").trim();
    if (
      !["account", "order", "product", "other"].includes(category) ||
      !subject ||
      subject.length > 160 ||
      !message ||
      message.length > 2000
    )
      return res.status(400).json({
        message: "เลือกหมวดหมู่ กรอกหัวข้อไม่เกิน 160 ตัว และรายละเอียดไม่เกิน 2000 ตัวอักษร",
      });
    const [requests] = await db.query(
      "INSERT INTO support_requests(user_id,category,subject,message) VALUES(?,?,?,?) RETURNING id",
      [req.user.id, category, subject, message],
    );
    const request = {
      id: requests[0].id,
      name: String(req.body.name || "สมาชิก"),
      email: String(req.user.email || ""),
      category,
      subject,
      message,
    };
    let delivery = { total: 0, sent: 0 };
    let deliveryLookupFailed = false;
    try {
      const [[submitter]] = await db.query(
        "SELECT name,email FROM users WHERE id=?",
        [req.user.id],
      );
      if (submitter) {
        request.name = submitter.name;
        request.email = submitter.email;
      }
      delivery = await emailAdminsAboutSupportRequest(request);
    } catch (error) {
      deliveryLookupFailed = true;
      console.error(
        "Could not notify admins about support request:",
        error.message,
      );
    }
    const emailSent = delivery.total > 0 && delivery.sent === delivery.total;
    let emailMessage;
    if (deliveryLookupFailed)
      emailMessage = "ระบบส่งอีเมลแจ้งแอดมินไม่สำเร็จ";
    else if (!delivery.total)
      emailMessage = "ไม่พบบัญชีแอดมินสำหรับแจ้งทางอีเมล";
    else if (emailSent) emailMessage = "แจ้งแอดมินทางอีเมลแล้ว";
    else if (delivery.sent)
      emailMessage = "ส่งอีเมลแจ้งแอดมินได้บางบัญชี";
    else emailMessage = "ส่งอีเมลแจ้งแอดมินไม่สำเร็จ";
    res.status(201).json({
      id: requests[0].id,
      emailSent,
      message: `ส่งคำร้องให้ทีมงานแล้ว · ${emailMessage}`,
    });
  }),
);
app.get(
  "/api/support-requests",
  auth,
  asyncRoute(async (req, res) => {
    const [requests] = await db.query(
      "SELECT id,category,subject,message,status,admin_note,created_at,updated_at FROM support_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 50",
      [req.user.id],
    );
    res.json({ requests });
  }),
);
app.get(
  "/api/admin/products",
  auth,
  roles("admin"),
  asyncRoute(async (req, res) => {
    const search = String(req.query.q || "").trim();
    const values = search ? [`%${search}%`, `%${search}%`] : [];
    const searchClause = search
      ? "WHERE p.name ILIKE ? OR u.name ILIKE ?"
      : "";
    const [products] = await db.query(
      `SELECT p.id,p.name,p.category,p.price,p.condition_label AS "condition",p.status,p.created_at,u.id AS seller_id,u.name AS seller_name FROM products p JOIN users u ON u.id=p.seller_id ${searchClause} ORDER BY p.created_at DESC`,
      values,
    );
    res.json({ products });
  }),
);
app.patch(
  "/api/admin/products/:id",
  auth,
  roles("admin"),
  asyncRoute(async (req, res) => {
    const status = String(req.body.status || "");
    if (!["active", "hidden"].includes(status))
      return res.status(400).json({ message: "สถานะสินค้าไม่ถูกต้อง" });
    const [rows] = await db.query(
      "UPDATE products SET status=? WHERE id=? AND status<>'sold' RETURNING id",
      [status, req.params.id],
    );
    if (!rows.length)
      return res.status(404).json({
        message: "ไม่พบสินค้า หรือสินค้าถูกขายไปแล้ว",
      });
    res.json({ id: rows[0].id, status, message: "อัปเดตสถานะสินค้าแล้ว" });
  }),
);
app.get(
  "/api/admin/stats",
  auth,
  roles("admin"),
  asyncRoute(async (req, res) => {
    const [[u]] = await db.query("SELECT COUNT(*) AS n FROM users");
    const [[p]] = await db.query(
      "SELECT COUNT(*) AS n FROM products WHERE status!='hidden'",
    );
    const [[o]] = await db.query("SELECT COUNT(*) AS n FROM orders");
    const [[rev]] = await db.query(
      "SELECT COALESCE(SUM(total_amount),0) AS n FROM orders WHERE status='completed'",
    );
    const [[pending]] = await db.query(
      "SELECT COUNT(*) AS n FROM student_verifications WHERE status='pending'",
    );
    const [[pendingSupport]] = await db.query(
      "SELECT COUNT(*) AS n FROM support_requests WHERE status='pending'",
    );
    const [[uni]] = await db.query(
      "SELECT COUNT(*) AS n FROM universities WHERE is_active=TRUE",
    );
    res.json({
      users: u.n,
      products: p.n,
      orders: o.n,
      completedRevenue: rev.n,
      pendingVerifications: pending.n,
      pendingSupportRequests: pendingSupport.n,
      universities: uni.n,
    });
  }),
);
app.get(
  "/api/admin/users",
  auth,
  roles("admin"),
  asyncRoute(async (req, res) => {
    const search = String(req.query.q || "").trim();
    const values = search ? [`%${search}%`, `%${search}%`] : [];
    const searchClause = search
      ? "WHERE u.name ILIKE ? OR u.email ILIKE ?"
      : "";
    const [users] = await db.query(
      `SELECT u.id,u.name,u.email,u.role,u.verification_status,u.created_at,un.university_name AS university,(SELECT COUNT(*)::int FROM products p WHERE p.seller_id=u.id) AS product_count,(SELECT COUNT(*)::int FROM orders o WHERE o.buyer_id=u.id) AS order_count FROM users u JOIN universities un ON un.id=u.university_id ${searchClause} ORDER BY u.created_at DESC`,
      values,
    );
    res.json({ users });
  }),
);
app.delete(
  "/api/admin/users/:id",
  auth,
  roles("admin"),
  asyncRoute(async (req, res) => {
    const userId = req.params.id;
    if (
      userId.length > 19 ||
      !/^[1-9]\d*$/.test(userId) ||
      BigInt(userId) > 9223372036854775807n
    )
      return res.status(400).json({ message: "รหัสสมาชิกไม่ถูกต้อง" });
    if (String(req.user.id) === userId)
      return res
        .status(409)
        .json({ message: "ไม่สามารถลบบัญชีแอดมินที่กำลังใช้งานได้" });

    const conn = await db.getConnection();
    let transactionOpen = false;
    let avatarUrl;
    let productImageUrls = [];
    try {
      await conn.beginTransaction();
      transactionOpen = true;
      const [[target]] = await conn.query(
        "SELECT id,role,avatar_url FROM users WHERE id=? FOR UPDATE",
        [userId],
      );
      if (!target) {
        await conn.rollback();
        transactionOpen = false;
        return res.status(404).json({ message: "ไม่พบสมาชิกที่ต้องการลบ" });
      }
      if (target.role === "admin") {
        await conn.rollback();
        transactionOpen = false;
        return res
          .status(409)
          .json({ message: "ไม่สามารถลบบัญชีแอดมินจากหน้านี้ได้" });
      }
      avatarUrl = target.avatar_url;

      const [products] = await conn.query(
        "SELECT id FROM products WHERE seller_id=? FOR UPDATE",
        [userId],
      );
      const productIds = products.map((product) => product.id);
      const [productImages] = await conn.query(
        "SELECT p.image_url,pi.image_url AS extra_image_url FROM products p LEFT JOIN product_images pi ON pi.product_id=p.id WHERE p.seller_id=?",
        [userId],
      );
      productImageUrls = productImages.flatMap((image) => [
        image.image_url,
        image.extra_image_url,
      ]);

      const productPlaceholders = productIds.map(() => "?").join(",");
      const affectedProductOrders = productIds.length
        ? ` OR oi.product_id IN (${productPlaceholders})`
        : "";
      const [orders] = await conn.query(
        `SELECT DISTINCT o.id FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id WHERE o.buyer_id=?${affectedProductOrders}`,
        [userId, ...productIds],
      );
      const orderIds = orders.map((order) => order.id);
      if (orderIds.length) {
        const orderPlaceholders = orderIds.map(() => "?").join(",");
        await conn.query(
          `DELETE FROM reviews WHERE reviewer_id=? OR seller_id=? OR order_id IN (${orderPlaceholders})`,
          [userId, userId, ...orderIds],
        );
        await conn.query(
          `DELETE FROM orders WHERE id IN (${orderPlaceholders})`,
          orderIds,
        );
      } else {
        await conn.query(
          "DELETE FROM reviews WHERE reviewer_id=? OR seller_id=?",
          [userId, userId],
        );
      }

      const productConversationClause = productIds.length
        ? ` OR product_id IN (${productPlaceholders})`
        : "";
      await conn.query(
        `DELETE FROM chat_messages WHERE sender_id=? OR conversation_id IN (SELECT id FROM conversations WHERE buyer_id=? OR seller_id=?${productConversationClause})`,
        [userId, userId, userId, ...productIds],
      );
      await conn.query(
        `DELETE FROM conversations WHERE buyer_id=? OR seller_id=?${productConversationClause}`,
        [userId, userId, ...productIds],
      );
      await conn.query("DELETE FROM student_verifications WHERE user_id=?", [
        userId,
      ]);
      await conn.query("DELETE FROM support_requests WHERE user_id=?", [
        userId,
      ]);
      await conn.query("DELETE FROM notifications WHERE user_id=?", [userId]);
      await conn.query("DELETE FROM products WHERE seller_id=?", [userId]);
      await conn.query("DELETE FROM users WHERE id=?", [userId]);
      await conn.commit();
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) {
        try {
          await conn.rollback();
        } catch (rollbackError) {
          console.error("Could not roll back member deletion:", rollbackError);
        }
      }
      if (error.code === "23503")
        return res.status(409).json({
          message: "ลบสมาชิกไม่ได้ เนื่องจากยังมีข้อมูลอื่นอ้างอิงบัญชีนี้",
        });
      throw error;
    } finally {
      conn.release();
    }

    try {
      await removeStoredProfileImage(avatarUrl, userId);
    } catch (error) {
      console.error("Could not remove deleted member profile image:", error);
    }
    await removeStoredProductImages(productImageUrls);
    res.json({
      id: userId,
      message: "ลบสมาชิกและข้อมูลที่เกี่ยวข้องทั้งหมดแล้ว",
    });
  }),
);
app.get(
  "/api/admin/verifications",
  auth,
  roles("admin"),
  asyncRoute(async (req, res) => {
    const [verifications] = await db.query(
      "SELECT sv.id,sv.user_id,sv.university_id,un.university_name AS university,sv.student_code,sv.student_email,sv.status,sv.created_at,u.name,u.email FROM student_verifications sv JOIN users u ON u.id=sv.user_id JOIN universities un ON un.id=sv.university_id WHERE sv.status='pending' ORDER BY sv.created_at ASC",
    );
    res.json({ verifications });
  }),
);
app.get(
  "/api/admin/support-requests",
  auth,
  roles("admin"),
  asyncRoute(async (req, res) => {
    const [requests] = await db.query(
      "SELECT sr.id,sr.category,sr.subject,sr.message,sr.status,sr.admin_note,sr.created_at,sr.updated_at,u.id AS user_id,u.name,u.email,un.university_name AS university FROM support_requests sr JOIN users u ON u.id=sr.user_id JOIN universities un ON un.id=u.university_id ORDER BY CASE sr.status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,sr.created_at DESC",
    );
    res.json({ requests });
  }),
);
app.patch(
  "/api/admin/support-requests/:id",
  auth,
  roles("admin"),
  asyncRoute(async (req, res) => {
    const status = String(req.body.status || "");
    const note = String(req.body.note || "").trim();
    if (!["in_progress", "resolved", "rejected"].includes(status))
      return res.status(400).json({ message: "สถานะคำร้องไม่ถูกต้อง" });
    if (note.length > 400)
      return res.status(400).json({ message: "หมายเหตุต้องไม่เกิน 400 ตัวอักษร" });

    const messages = {
      in_progress: "แอดมินกำลังตรวจสอบคำร้องของคุณ",
      resolved: "ดำเนินการคำร้องของคุณเรียบร้อยแล้ว",
      rejected: "คำร้องของคุณไม่สามารถดำเนินการได้",
    };
    const notificationMessage = note
      ? `${messages[status]} หมายเหตุ: ${note}`
      : messages[status];
    const conn = await db.getConnection();
    let request;
    try {
      await conn.beginTransaction();
      const [requests] = await conn.query(
        "SELECT sr.user_id,sr.subject,u.name,u.email FROM support_requests sr JOIN users u ON u.id=sr.user_id WHERE sr.id=? FOR UPDATE OF sr",
        [req.params.id],
      );
      if (!requests.length) {
        await conn.rollback();
        return res.status(404).json({ message: "ไม่พบคำร้องนี้" });
      }
      request = requests[0];
      await conn.query(
        "UPDATE support_requests SET status=?,admin_note=?,reviewed_by=?,updated_at=NOW() WHERE id=?",
        [status, note || null, req.user.id, req.params.id],
      );
      await conn.query(
        "INSERT INTO notifications(user_id,type,title,message,data) VALUES(?,'support_request','อัปเดตคำร้อง',?,?)",
        [
          request.user_id,
          notificationMessage,
          JSON.stringify({ request_id: String(req.params.id), status }),
        ],
      );
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
    let emailSent = true;
    try {
      await sendSupportRequestUpdateEmail(request.email, {
        id: req.params.id,
        name: request.name,
        subject: request.subject,
        status,
        admin_note: note,
      });
    } catch (error) {
      emailSent = false;
      console.error("Support request update email failed:", error.message);
    }
    res.json({
      message: emailSent
        ? "อัปเดตสถานะและส่งอีเมลแจ้งสมาชิกแล้ว"
        : "อัปเดตสถานะแล้ว แต่ส่งอีเมลแจ้งสมาชิกไม่สำเร็จ",
      emailSent,
      status,
    });
  }),
);
app.patch(
  "/api/admin/verifications/:id",
  auth,
  roles("admin"),
  asyncRoute(async (req, res) => {
    const status = req.body.status;
    if (!["verified", "rejected"].includes(status))
      return res
        .status(400)
        .json({ message: "สถานะต้องเป็น verified หรือ rejected" });
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [v] = await conn.query(
        "SELECT user_id FROM student_verifications WHERE id=? AND status='pending' FOR UPDATE",
        [req.params.id],
      );
      if (!v.length) {
        await conn.rollback();
        return res.status(404).json({ message: "ไม่พบคำขอที่รอตรวจสอบ" });
      }
      await conn.query(
        "UPDATE student_verifications SET status=?,reviewed_at=NOW(),reviewed_by=?,admin_note=? WHERE id=?",
        [status, req.user.id, String(req.body.note || ""), req.params.id],
      );
      await conn.query("UPDATE users SET verification_status=? WHERE id=?", [
        status,
        v[0].user_id,
      ]);
      await conn.query(
        "INSERT INTO notifications(user_id,type,title,message) VALUES(?,'student_verification','ผลการยืนยันนักศึกษา',?)",
        [
          v[0].user_id,
          status === "verified"
            ? "บัญชีนักศึกษาของคุณได้รับการยืนยันแล้ว"
            : "คำขอยืนยันนักศึกษาของคุณไม่ได้รับอนุมัติ กรุณาติดต่อผู้ดูแล",
        ],
      );
      await conn.commit();
      res.json({ message: "บันทึกผลตรวจสอบแล้ว", status });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }),
);
app.get("/", (req, res) => res.sendFile(path.join(projectRoot, "index.html")));
app.get("/index.html", (req, res) =>
  res.sendFile(path.join(projectRoot, "index.html")),
);
app.get("/style.css", (req, res) =>
  res.sendFile(path.join(projectRoot, "style.css")),
);
app.get("/app.js", (req, res) =>
  res.sendFile(path.join(projectRoot, "app.js")),
);
app.get("/market-header.html", (req, res) =>
  res.sendFile(path.join(projectRoot, "market-header.html")),
);
app.use("/css", express.static(path.join(projectRoot, "css")));
app.use("/js", express.static(path.join(projectRoot, "js")));
app.use("/pages", express.static(path.join(projectRoot, "pages")));
app.use(
  "/uploads",
  helmet.crossOriginResourcePolicy({ policy: "cross-origin" }),
  express.static(path.join(__dirname, "..", "uploads")),
);
app.use((err, req, res, next) => {
  console.error(err);
  if (err.code === "23505")
    return res.status(409).json({ message: "ข้อมูลซ้ำในระบบ" });
  res.status(err.status || 500).json({
    message:
      process.env.NODE_ENV === "production"
        ? "เกิดข้อผิดพลาดในเซิร์ฟเวอร์"
        : err.message || "เกิดข้อผิดพลาด",
  });
});
const port = Number(process.env.PORT || 3000);
app.listen(port, () =>
  console.log(`Save & Share API running at http://localhost:${port}`),
);
