const nodemailer = require("nodemailer");

function configError(message) {
  const error = new Error(message);
  error.status = 503;
  return error;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

async function postEmailApi(provider, url, headers, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  let result;
  try {
    result = await response.json();
  } catch (error) {
    throw new Error(
      `${provider} ตอบกลับข้อมูลไม่ถูกต้อง (HTTP ${response.status})`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw configError(
      `${provider} ส่งอีเมลไม่สำเร็จ (HTTP ${response.status}): ${result?.message || result?.name || "ตรวจ API key และอีเมลผู้ส่ง"}`,
    );
  }
  return result;
}

async function sendEmail({ to, subject, text, html }) {
  const provider = (process.env.EMAIL_PROVIDER || "smtp").trim().toLowerCase();

  if (provider === "brevo") {
    const apiKey = process.env.BREVO_API_KEY?.trim();
    const fromEmail = process.env.BREVO_FROM_EMAIL?.trim();
    const fromName = process.env.BREVO_FROM_NAME?.trim() || "Save & Share";
    if (!apiKey || !fromEmail) {
      throw configError(
        "ตั้งค่า BREVO_API_KEY และ BREVO_FROM_EMAIL ใน backend/.env ก่อนส่งอีเมล",
      );
    }

    return postEmailApi(
      "Brevo",
      "https://api.brevo.com/v3/smtp/email",
      {
        accept: "application/json",
        "api-key": apiKey,
        "Content-Type": "application/json",
      },
      {
        sender: { name: fromName, email: fromEmail },
        to: [{ email: to }],
        subject,
        textContent: text,
        htmlContent: html,
      },
    );
  }

  if (provider === "resend") {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    const from = process.env.RESEND_FROM?.trim();
    if (!apiKey || !from) {
      throw configError(
        "ตั้งค่า RESEND_API_KEY และ RESEND_FROM ใน backend/.env ก่อนส่งอีเมล",
      );
    }

    return postEmailApi(
      "Resend",
      "https://api.resend.com/emails",
      {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      { from, to: [to], subject, text, html },
    );
  }

  if (provider !== "smtp") {
    throw configError(
      `ไม่รู้จัก EMAIL_PROVIDER "${provider}" ตั้งเป็น brevo, resend หรือ smtp`,
    );
  }

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM } =
    process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) {
    throw configError(
      "ตั้งค่า SMTP_HOST, SMTP_USER และ SMTP_PASSWORD ใน backend/.env ก่อนส่งอีเมล",
    );
  }

  const host = SMTP_HOST.trim();
  const isGmail = host.toLowerCase() === "smtp.gmail.com";
  const password = isGmail ? SMTP_PASSWORD.replace(/\s/g, "") : SMTP_PASSWORD;
  if (isGmail && password.length !== 16) {
    throw configError(
      "SMTP_PASSWORD ของ Gmail ต้องเป็น Google App Password 16 ตัวอักษร ไม่ใช่รหัสผ่าน Gmail ปกติ",
    );
  }

  const transport = nodemailer.createTransport({
    host,
    port: Number(SMTP_PORT || 587),
    secure: Number(SMTP_PORT || 587) === 465,
    auth: { user: SMTP_USER, pass: password },
  });
  return transport.sendMail({
    from: SMTP_FROM || SMTP_USER,
    to,
    subject,
    text,
    html,
  });
}

function sendVerificationCode(email, code) {
  return sendEmail({
    to: email,
    subject: "รหัสยืนยันอีเมล Save & Share",
    text: `รหัสยืนยันอีเมลของคุณคือ ${code} รหัสนี้ใช้ได้ 10 นาที`,
    html: `<p>รหัสยืนยันอีเมล Save &amp; Share</p><p style="font-size:28px;font-weight:bold;letter-spacing:8px">${code}</p><p>รหัสนี้ใช้ได้ 10 นาที หากคุณไม่ได้สมัครสมาชิก สามารถละเว้นอีเมลฉบับนี้ได้</p>`,
  });
}

function sendWelcomeEmail(email, name) {
  const greeting = String(name || "สมาชิกใหม่");
  return sendEmail({
    to: email,
    subject: "ขอบคุณที่สมัครสมาชิก Save & Share",
    text: `สวัสดี ${greeting}\n\nขอบคุณที่สมัครสมาชิก Save & Share ตลาดซื้อขายของมือสองสำหรับนักศึกษาทั่วประเทศไทย`,
    html: `<p>สวัสดี ${escapeHtml(greeting)}</p><p>ขอบคุณที่สมัครสมาชิก <strong>Save &amp; Share</strong></p><p>ขอให้สนุกกับการค้นหา ซื้อขาย และส่งต่อของดี ๆ ในชุมชนนักศึกษา</p>`,
  });
}

function sendSupportRequestReceivedEmail(email, request) {
  const categoryLabels = {
    account: "บัญชีและโปรไฟล์",
    order: "คำสั่งซื้อ",
    product: "สินค้า",
    other: "เรื่องอื่น ๆ",
  };
  const subject = String(request.subject || "").replace(/[\r\n]+/g, " ");
  const category = categoryLabels[request.category] || request.category;
  return sendEmail({
    to: email,
    subject: `มีคำร้องใหม่ #${request.id}: ${subject}`.slice(0, 180),
    text: [
      `มีคำร้องใหม่จาก ${request.name} (${request.email})`,
      `หมวดหมู่: ${category}`,
      `หัวข้อ: ${subject}`,
      "",
      request.message,
      "",
      "เข้าสู่ระบบ Save & Share แล้วเปิดหน้าคำร้องจากสมาชิกเพื่อดำเนินการ",
    ].join("\n"),
    html: `<h2>มีคำร้องใหม่จากสมาชิก</h2><p><strong>ผู้ส่ง:</strong> ${escapeHtml(request.name)} (${escapeHtml(request.email)})</p><p><strong>หมวดหมู่:</strong> ${escapeHtml(category)}</p><p><strong>หัวข้อ:</strong> ${escapeHtml(subject)}</p><p style="white-space:pre-wrap">${escapeHtml(request.message)}</p><p>เข้าสู่ระบบ Save &amp; Share แล้วเปิดหน้าคำร้องจากสมาชิกเพื่อดำเนินการ</p>`,
  });
}

function sendSupportRequestUpdateEmail(email, request) {
  const statusLabels = {
    in_progress: "กำลังดำเนินการ",
    resolved: "ดำเนินการแล้ว",
    rejected: "ปิดคำร้อง",
  };
  const status = statusLabels[request.status] || request.status;
  const subject = String(request.subject || "").replace(/[\r\n]+/g, " ");
  const note = String(request.admin_note || "").trim();
  return sendEmail({
    to: email,
    subject: `อัปเดตคำร้อง #${request.id} | Save & Share`,
    text: [
      `สวัสดี ${request.name}`,
      `คำร้อง "${subject}" ได้รับการอัปเดตสถานะ: ${status}`,
      note ? `หมายเหตุจากแอดมิน: ${note}` : "",
      "",
      "คุณสามารถติดตามคำร้องได้ที่หน้า ศูนย์ช่วยเหลือ ใน Save & Share",
    ]
      .filter(Boolean)
      .join("\n"),
    html: `<h2>อัปเดตคำร้องของคุณ</h2><p>สวัสดี ${escapeHtml(request.name)}</p><p>คำร้อง <strong>#${escapeHtml(request.id)} ${escapeHtml(subject)}</strong></p><p>สถานะล่าสุด: <strong>${escapeHtml(status)}</strong></p>${note ? `<p><strong>หมายเหตุจากแอดมิน:</strong><br>${escapeHtml(note)}</p>` : ""}<p>คุณสามารถติดตามคำร้องได้ที่หน้า ศูนย์ช่วยเหลือ ใน Save &amp; Share</p>`,
  });
}

module.exports = {
  sendVerificationCode,
  sendWelcomeEmail,
  sendSupportRequestReceivedEmail,
  sendSupportRequestUpdateEmail,
};
