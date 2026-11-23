const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  sendVerificationCode,
  sendWelcomeEmail,
  sendSupportRequestReceivedEmail,
  sendSupportRequestUpdateEmail,
} = require("../src/mail");

function configureResend(t, fetchImplementation, overrides = {}) {
  const keys = [
    "EMAIL_PROVIDER",
    "RESEND_API_KEY",
    "RESEND_FROM",
    "BREVO_API_KEY",
    "BREVO_FROM_EMAIL",
    "BREVO_FROM_NAME",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SMTP_FROM",
  ];
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  const previousFetch = global.fetch;

  Object.assign(process.env, {
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "re_test_key",
    RESEND_FROM: "Save & Share <hello@example.com>",
    ...overrides,
  });
  global.fetch = fetchImplementation;

  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    global.fetch = previousFetch;
  });
}

test("sends OTP and a personalized welcome email through Resend", async (t) => {
  const requests = [];
  configureResend(
    t,
    async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ id: "email_test_id" }), {
        status: 200,
      });
    },
  );

  await sendVerificationCode("student@example.ac.th", "123456");
  await sendWelcomeEmail("student@example.ac.th", "<Student>");

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://api.resend.com/emails");
  assert.equal(requests[0].options.headers.Authorization, "Bearer re_test_key");
  assert.equal(requests[0].body.to[0], "student@example.ac.th");
  assert.match(requests[0].body.text, /123456/);
  assert.equal(
    requests[1].body.subject,
    "ขอบคุณที่สมัครสมาชิก Save & Share",
  );
  assert.match(requests[1].body.html, /&lt;Student&gt;/);
});

test("reports missing Resend credentials without making a request", async (t) => {
  let requestMade = false;
  configureResend(
    t,
    async () => {
      requestMade = true;
      return new Response("{}", { status: 200 });
    },
    { RESEND_API_KEY: "" },
  );

  await assert.rejects(
    sendVerificationCode("student@example.ac.th", "123456"),
    /RESEND_API_KEY/,
  );
  assert.equal(requestMade, false);
});

test("reports Resend API rejection", async (t) => {
  configureResend(t, async () =>
    new Response(JSON.stringify({ message: "domain is not verified" }), {
      status: 403,
    }),
  );

  await assert.rejects(
    sendWelcomeEmail("student@example.ac.th", "Student"),
    /HTTP 403.*domain is not verified/,
  );
});

test("emails admins when a member submits a support request", async (t) => {
  const requests = [];
  configureResend(
    t,
    async (url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ id: "email_support_id" }), {
        status: 200,
      });
    },
  );

  await sendSupportRequestReceivedEmail("admin@example.com", {
    id: 17,
    name: "<Member>",
    email: "member@example.com",
    category: "order",
    subject: "<Refund>\nIgnore",
    message: "Order <17> needs help",
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].to[0], "admin@example.com");
  assert.match(requests[0].subject, /#17: <Refund> Ignore/);
  assert.match(requests[0].html, /&lt;Member&gt;/);
  assert.match(requests[0].html, /Order &lt;17&gt; needs help/);
});

test("emails the requester when an admin updates a support request", async (t) => {
  const requests = [];
  configureResend(
    t,
    async (url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ id: "email_update_id" }), {
        status: 200,
      });
    },
  );

  await sendSupportRequestUpdateEmail("member@example.com", {
    id: 18,
    name: "<Member>",
    subject: "Can't order",
    status: "resolved",
    admin_note: "<Resolved safely>",
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].to[0], "member@example.com");
  assert.match(requests[0].text, /ดำเนินการแล้ว/);
  assert.match(requests[0].html, /&lt;Resolved safely&gt;/);
});

test("sends OTP and welcome emails through Brevo", async (t) => {
  const requests = [];
  configureResend(
    t,
    async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ messageId: "brevo_test_id" }), {
        status: 201,
      });
    },
    {
      EMAIL_PROVIDER: "brevo",
      BREVO_API_KEY: "test_brevo_key",
      BREVO_FROM_EMAIL: "verified@example.com",
      BREVO_FROM_NAME: "Save & Share",
    },
  );

  await sendVerificationCode("student@example.ac.th", "654321");
  await sendWelcomeEmail("student@example.ac.th", "Student");

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://api.brevo.com/v3/smtp/email");
  assert.equal(requests[0].options.headers["api-key"], "test_brevo_key");
  assert.equal(requests[0].body.sender.email, "verified@example.com");
  assert.equal(requests[0].body.to[0].email, "student@example.ac.th");
  assert.match(requests[0].body.textContent, /654321/);
  assert.equal(
    requests[1].body.subject,
    "ขอบคุณที่สมัครสมาชิก Save & Share",
  );
});

test("requires a Brevo API key and verified sender address", async (t) => {
  let requestMade = false;
  configureResend(
    t,
    async () => {
      requestMade = true;
      return new Response("{}", { status: 200 });
    },
    {
      EMAIL_PROVIDER: "brevo",
      BREVO_API_KEY: "",
      BREVO_FROM_EMAIL: "",
    },
  );

  await assert.rejects(
    sendVerificationCode("student@example.ac.th", "123456"),
    /BREVO_API_KEY.*BREVO_FROM_EMAIL/,
  );
  assert.equal(requestMade, false);
});
