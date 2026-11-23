require("dotenv").config();
const bcrypt = require("bcryptjs");
const readline = require("node:readline");
const db = require("../src/db");

function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY || typeof input.setRawMode !== "function") {
      reject(new Error("กรุณารันคำสั่งนี้ใน Terminal แบบโต้ตอบ"));
      return;
    }

    let value = "";
    const onKeypress = (character, key) => {
      if (key.ctrl && key.name === "c") {
        finish(new Error("ยกเลิกการสร้างบัญชีแอดมิน"));
      } else if (key.name === "return" || key.name === "enter") {
        finish(null, value);
      } else if (key.name === "backspace") {
        if (value.length) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (character && !key.ctrl && !key.meta) {
        value += character;
        process.stdout.write("*");
      }
    };

    function finish(error, result) {
      input.off("keypress", onKeypress);
      input.setRawMode(false);
      input.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(result);
    }

    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
    process.stdout.write(prompt);
  });
}

async function main() {
  const email = String(process.argv[2] || "")
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("วิธีใช้: npm run admin:create -- อีเมล");

  const [[existingUser]] = await db.query(
    "SELECT id FROM users WHERE email=?",
    [email],
  );
  if (existingUser)
    throw new Error(
      "อีเมลนี้มีบัญชีแล้ว หากต้องการเลื่อนบัญชีเดิมเป็นแอดมิน ให้ใช้คำสั่ง UPDATE ในคู่มือ",
    );

  const [[university]] = await db.query(
    "SELECT id FROM universities WHERE is_active=TRUE ORDER BY id LIMIT 1",
  );
  if (!university)
    throw new Error("ไม่พบมหาวิทยาลัยที่เปิดใช้งาน กรุณาตรวจฐานข้อมูลก่อน");

  const password = await readSecret("ตั้งรหัสผ่านแอดมิน (อย่างน้อย 12 ตัว): ");
  if (password.length < 12)
    throw new Error("รหัสผ่านต้องมีอย่างน้อย 12 ตัวอักษร");
  const confirmation = await readSecret("พิมพ์รหัสผ่านอีกครั้ง: ");
  if (password !== confirmation)
    throw new Error("รหัสผ่านทั้งสองครั้งไม่ตรงกัน");

  const passwordHash = await bcrypt.hash(password, 12);
  await db.query(
    "INSERT INTO users(name,email,email_verified,password_hash,university_id,role) VALUES(?,?,FALSE,?,?,'admin')",
    ["ผู้ดูแลระบบ", email, passwordHash, university.id],
  );
  console.log(`สร้างบัญชีแอดมิน ${email} สำเร็จ`);
  console.log("เข้าสู่ระบบแล้วเปิด pages/admin.html เพื่อจัดการระบบ");
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
