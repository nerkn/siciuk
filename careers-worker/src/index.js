const MAX_CV_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_CV_BYTES + 100 * 1024;
const MAX_REQUESTS_PER_DAY = 5;

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "vary": "Origin"
    }
  });
}

function plain(status, text) {
  return new Response(text, { status, headers: { "cache-control": "no-store" } });
}

function text(form, key, max) {
  const value = form.get(key);
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function checked(form, key) {
  return form.get(key) === "yes";
}

function list(form, key, maxItems = 40) {
  return form.getAll(key).filter(value => typeof value === "string").slice(0, maxItems).map(value => value.trim().slice(0, 100));
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

async function verifyTurnstile(token, ip, env) {
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
  if (ip) body.set("remoteip", ip);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  if (!response.ok) return false;
  const result = await response.json();
  return result.success === true && (!result.hostname || result.hostname === new URL(env.SITE_ORIGIN).hostname);
}

async function digest(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function rateLimit(ip, env) {
  const hash = await digest(`${env.RATE_LIMIT_SECRET}:${ip || "unknown"}`);
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - 86400;
  await env.DB.prepare(`INSERT INTO rate_limits (ip_hash, window_started, request_count)
    VALUES (?, ?, 1)
    ON CONFLICT(ip_hash) DO UPDATE SET
      request_count = CASE WHEN window_started < ? THEN 1 ELSE request_count + 1 END,
      window_started = CASE WHEN window_started < ? THEN ? ELSE window_started END`)
    .bind(hash, now, windowStart, windowStart, now).run();
  const row = await env.DB.prepare("SELECT request_count FROM rate_limits WHERE ip_hash = ?").bind(hash).first();
  return Number(row?.request_count || 0) <= MAX_REQUESTS_PER_DAY;
}

function validCv(file) {
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_CV_BYTES) return false;
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf") && file.type === "application/pdf") return file.slice(0, 5).text().then(value => value === "%PDF-");
  if (name.endsWith(".docx") && file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return file.slice(0, 4).arrayBuffer().then(buffer => {
      const bytes = new Uint8Array(buffer);
      return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    });
  }
  return false;
}

async function sendNotification(application, env) {
  const apiResponse = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.NOTIFICATION_FROM,
      to: [env.NOTIFICATION_TO],
      subject: `New SICI Expert Network application — ${application.full_name}`,
      text: [
        `Application reference: ${application.id}`,
        `Name: ${application.full_name}`,
        `Email: ${application.email}`,
        `Country: ${application.country_of_residence}`,
        `Professional expertise: ${application.professional_expertise.join(", ")}`,
        `Themes: ${application.thematic_expertise.join(", ") || "None"}`,
        `CV: Cloudflare Dashboard → R2 → ${env.CV_BUCKET_NAME} → applications/${application.id}/`,
        `Submitted: ${application.created_at}`,
        "The CV is deliberately not attached to this email; it remains in the private R2 bucket."
      ].join("\n"),
      html: `<h2>New SICI Expert Network application</h2><p><b>Reference:</b> ${application.id}</p><p><b>Name:</b> ${escapeHtml(application.full_name)}</p><p><b>Email:</b> ${escapeHtml(application.email)}</p><p><b>Country:</b> ${escapeHtml(application.country_of_residence)}</p><p><b>Professional expertise:</b> ${escapeHtml(application.professional_expertise.join(", "))}</p><p><b>Themes:</b> ${escapeHtml(application.thematic_expertise.join(", ") || "None")}</p><p><b>CV location:</b> Cloudflare Dashboard → R2 → ${escapeHtml(env.CV_BUCKET_NAME)} → applications/${application.id}/</p><p>The CV is not attached to this email. It remains in the private R2 bucket.</p>`
    })
  });
  return apiResponse.ok;
}

async function handlePost(request, env, origin) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_REQUEST_BYTES) return json({ error: "Request is too large." }, 413, origin);
  if (!env.TURNSTILE_SECRET_KEY || !env.RESEND_API_KEY || !env.NOTIFICATION_TO || !env.NOTIFICATION_FROM || !env.RATE_LIMIT_SECRET) {
    return json({ error: "Application service is not configured." }, 503, origin);
  }
  const form = await request.formData();
  const file = form.get("cv");
  if (!(await validCv(file))) return json({ error: "Attach a PDF or DOCX CV up to 10 MB." }, 400, origin);
  const fullName = text(form, "full_name", 150);
  const email = text(form, "email", 240).toLowerCase();
  const country = text(form, "country_of_residence", 90);
  const privacyConsent = checked(form, "future_opportunities_consent");
  const professional = list(form, "professional_expertise[]");
  if (!fullName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !country || !privacyConsent || !professional.length) {
    return json({ error: "Complete the required fields and consent." }, 400, origin);
  }
  const token = text(form, "cf-turnstile-response", 2048);
  if (!token || !(await verifyTurnstile(token, request.headers.get("CF-Connecting-IP"), env))) {
    return json({ error: "Complete the security check and try again." }, 400, origin);
  }
  if (!(await rateLimit(request.headers.get("CF-Connecting-IP"), env))) return json({ error: "Too many applications from this connection. Try again tomorrow." }, 429, origin);

  const id = crypto.randomUUID();
  const extension = file.name.toLowerCase().endsWith(".pdf") ? "pdf" : "docx";
  const createdAt = new Date().toISOString();
  const objectKey = `applications/${id}/cv.${extension}`;
  const application = {
    id,
    created_at: createdAt,
    full_name: fullName,
    email,
    country_of_residence: country,
    linkedin: text(form, "linkedin", 500),
    phone: text(form, "phone", 40),
    whatsapp: checked(form, "whatsapp"),
    signal: checked(form, "signal"),
    professional_expertise: professional,
    thematic_expertise: list(form, "thematic_expertise[]"),
    additional_information: text(form, "additional_information", 1500),
    associate_interest: checked(form, "associate_interest"),
    cv_object_key: objectKey,
    cv_filename: `cv.${extension}`
  };
  try {
    await env.CV_BUCKET.put(objectKey, file.stream(), { httpMetadata: { contentType: file.type } });
    await env.DB.prepare(`INSERT INTO applications (
      id, created_at, full_name, email, country_of_residence, linkedin, phone, whatsapp, signal,
      professional_expertise, thematic_expertise, additional_information, associate_interest,
      privacy_consent, cv_object_key, cv_filename
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .bind(id, createdAt, fullName, email, country, application.linkedin, application.phone,
        Number(application.whatsapp), Number(application.signal), JSON.stringify(professional),
        JSON.stringify(application.thematic_expertise), application.additional_information,
        Number(application.associate_interest), objectKey, application.cv_filename).run();
  } catch {
    await env.CV_BUCKET.delete(objectKey).catch(() => {});
    return json({ error: "We could not save your application. Please try again later." }, 503, origin);
  }
  let notificationSent = false;
  try { notificationSent = await sendNotification(application, env); } catch { notificationSent = false; }
  await env.DB.prepare("UPDATE applications SET notification_sent = ? WHERE id = ?").bind(Number(notificationSent), id).run();
  if (!notificationSent) console.error("Application saved; email notification failed", id);
  return json({ ok: true, notificationSent }, 201, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (origin !== env.SITE_ORIGIN) return plain(403, "Forbidden");
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
        "vary": "Origin"
      } });
    }
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, origin);
    try { return await handlePost(request, env, origin); }
    catch { return json({ error: "We could not process your application. Please try again later." }, 500, origin); }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      const retentionDays = Math.max(30, Number(env.RETENTION_DAYS) || 180);
      const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
      const rows = await env.DB.prepare("SELECT id, cv_object_key FROM applications WHERE created_at < ?").bind(cutoff).all();
      for (const row of rows.results || []) {
        await env.CV_BUCKET.delete(row.cv_object_key);
        await env.DB.prepare("DELETE FROM applications WHERE id = ?").bind(row.id).run();
      }
      await env.DB.prepare("DELETE FROM rate_limits WHERE window_started < ?").bind(Math.floor(Date.now() / 1000) - 86400).run();
    })());
  }
};
