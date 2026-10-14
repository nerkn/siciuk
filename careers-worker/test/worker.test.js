import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const origin = "https://sici.uk";

function fakeEnv() {
  const applications = new Map();
  const limits = new Map();
  const objects = new Map();
  const env = {
    SITE_ORIGIN: origin,
    TURNSTILE_SECRET_KEY: "test-turnstile-secret",
    RESEND_API_KEY: "test-resend-key",
    NOTIFICATION_TO: "hello@sici.uk",
    NOTIFICATION_FROM: "SICI Careers <careers@sici.uk>",
    RATE_LIMIT_SECRET: "test-rate-secret",
    CV_BUCKET_NAME: "sici-careers-cv",
    CV_BUCKET: {
      async put(key, stream) { objects.set(key, new Uint8Array(await new Response(stream).arrayBuffer())); },
      async delete(key) { objects.delete(key); }
    },
    DB: {
      prepare(sql) {
        let values = [];
        const statement = {
          bind(...args) { values = args; return statement; },
          async run() {
            if (sql.includes("INSERT INTO rate_limits")) {
              const [key, now, windowStart] = values;
              const old = limits.get(key);
              limits.set(key, old && old.window_started >= windowStart
                ? { window_started: old.window_started, request_count: old.request_count + 1 }
                : { window_started: now, request_count: 1 });
            } else if (sql.includes("INSERT INTO applications")) applications.set(values[0], values);
            else if (sql.includes("UPDATE applications SET notification_sent")) {
              const row = applications.get(values[1]);
              if (row) row.notification_sent = values[0];
            }
            return { success: true };
          },
          async first() {
            if (sql.includes("SELECT request_count")) return { request_count: limits.get(values[0])?.request_count || 0 };
            return null;
          }
        };
        return statement;
      }
    }
  };
  return { env, applications, objects };
}

function validForm() {
  const form = new FormData();
  form.set("full_name", "Test Applicant");
  form.set("email", "applicant@example.org");
  form.set("country_of_residence", "United Kingdom");
  form.set("professional_expertise[]", "Policy Analysis");
  form.set("thematic_expertise[]", "Democracy & Civic Space");
  form.set("future_opportunities_consent", "yes");
  form.set("cf-turnstile-response", "test-token");
  form.set("cv", new File(["%PDF-test document"], "cv.pdf", { type: "application/pdf" }));
  return form;
}

test("valid application stores CV privately and emails notification without attachment", async t => {
  const originalFetch = globalThis.fetch;
  const emailPayloads = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("siteverify")) return Response.json({ success: true, hostname: "sici.uk" });
    emailPayloads.push(JSON.parse(options.body));
    return Response.json({ id: "email-test" });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { env, applications, objects } = fakeEnv();
  const request = new Request("https://sici-careers.test/", {
    method: "POST", headers: { Origin: origin, "CF-Connecting-IP": "203.0.113.10" }, body: validForm()
  });
  const response = await worker.fetch(request, env);
  const result = await response.json();
  assert.equal(response.status, 201);
  assert.deepEqual(result, { ok: true, notificationSent: true });
  assert.equal(applications.size, 1);
  assert.equal(objects.size, 1);
  assert.equal(emailPayloads.length, 1);
  assert.equal(emailPayloads[0].to[0], "hello@sici.uk");
  assert.equal("attachments" in emailPayloads[0], false);
});

test("rejects requests from origins other than SICI", async () => {
  const { env } = fakeEnv();
  const response = await worker.fetch(new Request("https://sici-careers.test/", {
    method: "POST", headers: { Origin: "https://attacker.example" }, body: validForm()
  }), env);
  assert.equal(response.status, 403);
});

test("does not accept applications while required provider secrets are missing", async () => {
  const { env } = fakeEnv();
  delete env.RESEND_API_KEY;
  const response = await worker.fetch(new Request("https://sici-careers.test/", {
    method: "POST", headers: { Origin: origin }, body: validForm()
  }), env);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "Application service is not configured.");
});

test("rejects a CV with mismatched file signature", async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ success: true, hostname: "sici.uk" });
  t.after(() => { globalThis.fetch = originalFetch; });
  const { env } = fakeEnv();
  const form = validForm();
  form.set("cv", new File(["not a PDF"], "cv.pdf", { type: "application/pdf" }));
  const response = await worker.fetch(new Request("https://sici-careers.test/", {
    method: "POST", headers: { Origin: origin }, body: form
  }), env);
  assert.equal(response.status, 400);
});
