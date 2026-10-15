import { createServer } from 'node:http';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const DATA_DIR = resolve(process.env.DATA_DIR || join(ROOT, '.careers-data'));
const PORT = Number(process.env.PORT || 3000);
const MAX_CV_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_CV_BYTES + 128 * 1024;
const RATE_LIMIT = 5;
const RETENTION_DAYS = Math.max(30, Number(process.env.RETENTION_DAYS || 180));
const SITE_ORIGIN = 'https://sici.uk';
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.ico': 'image/x-icon' };
const ADMIN_HTML = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Careers applications · SICI</title><style>body{font:15px/1.5 system-ui,sans-serif;margin:40px auto;padding:0 20px;max-width:1050px;color:#191919}h1{font-size:28px}p{color:#5a5a5a}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{text-align:left;padding:12px 9px;border-bottom:1px solid #ddd;vertical-align:top}th{font-size:12px;text-transform:uppercase;color:#555}a{color:#125b93}small{color:#666}@media(max-width:700px){table,tbody,tr,td{display:block}thead{display:none}td{border:0;padding:5px 0}tr{border-bottom:1px solid #ddd;padding:12px 0}}</style><h1>SICI Expert Network applications</h1><p>Applicant details and CV files are stored encrypted on the SICI Dokploy server. CVs are kept for ${RETENTION_DAYS} days.</p><p id="state">Loading applications…</p><table><thead><tr><th>Submitted</th><th>Applicant</th><th>Country</th><th>Expertise</th><th>CV</th></tr></thead><tbody id="rows"></tbody></table><script>fetch('/api/admin/applications').then(async r=>{if(!r.ok)throw Error('Could not load applications');return r.json()}).then(items=>{document.querySelector('#state').textContent=items.length+' application'+(items.length===1?'':'s');for(const a of items){const tr=document.createElement('tr');const date=new Date(a.created_at).toLocaleString();tr.innerHTML='<td></td><td></td><td></td><td></td><td></td>';tr.children[0].textContent=date;tr.children[1].textContent=a.full_name+' · '+a.email;tr.children[2].textContent=a.country_of_residence;tr.children[3].textContent=a.professional_expertise.join(', ');const link=document.createElement('a');link.href='/api/admin/applications/'+encodeURIComponent(a.id)+'/cv';link.textContent='Download CV';tr.children[4].append(link);document.querySelector('#rows').append(tr)}}).catch(()=>{document.querySelector('#state').textContent='Unable to load applications. Sign in again and refresh.'})</script></html>`;

let rateLimitQueue = Promise.resolve();

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
}

function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(body);
}

function getEncryptionKey() {
  const key = Buffer.from(process.env.CAREERS_ENCRYPTION_KEY || '', 'base64');
  if (key.length !== 32) throw new Error('CAREERS_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  return key;
}

function encrypt(value) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), nonce);
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), encrypted]);
}

function decrypt(value) {
  if (value.length < 30 || value[0] !== 1) throw new Error('Invalid encrypted record');
  const decipher = createDecipheriv('aes-256-gcm', getEncryptionKey(), value.subarray(1, 13));
  decipher.setAuthTag(value.subarray(13, 29));
  return Buffer.concat([decipher.update(value.subarray(29)), decipher.final()]);
}

async function atomicWrite(path, bytes, mode = 0o600) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { mode, flag: 'wx' });
  await rename(temporary, path);
}

function text(form, key, max) {
  const value = form.get(key);
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function values(form, key, maxItems = 40) {
  return form.getAll(key).filter(value => typeof value === 'string').slice(0, maxItems).map(value => value.trim().replace(/\s+/g, ' ').slice(0, 100)).filter(Boolean);
}

function checked(form, key) { return form.get(key) === 'yes'; }

function ipFor(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',').at(-1).trim().slice(0, 100);
  return req.socket.remoteAddress || 'unknown';
}

async function allowSubmission(ip) {
  const operation = rateLimitQueue.then(async () => {
    const secret = process.env.CAREERS_RATE_LIMIT_SECRET || '';
    if (secret.length < 32) throw new Error('CAREERS_RATE_LIMIT_SECRET is not configured');
    const ipHash = createHmac('sha256', secret).update(ip).digest('hex');
    const path = join(DATA_DIR, 'rate-limits.json');
    let limits = {};
    try { limits = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const now = Date.now();
    const prior = limits[ipHash];
    const record = !prior || now - prior.startedAt >= 86400000 ? { startedAt: now, count: 1 } : { startedAt: prior.startedAt, count: prior.count + 1 };
    limits[ipHash] = record;
    for (const [hash, item] of Object.entries(limits)) if (now - item.startedAt >= 86400000) delete limits[hash];
    await atomicWrite(path, JSON.stringify(limits));
    return record.count <= RATE_LIMIT;
  });
  rateLimitQueue = operation.catch(() => {});
  return operation;
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }

async function sendNotification(application) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;
  const to = process.env.NOTIFICATION_TO || 'hello@sici.uk';
  const from = process.env.NOTIFICATION_FROM || 'SICI Careers <careers@sici.uk>';
  const result = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from, to: [to], subject: `New SICI Expert Network application — ${application.full_name}`,
      text: [`Application reference: ${application.id}`, `Name: ${application.full_name}`, `Email: ${application.email}`, `Country: ${application.country_of_residence}`, `Professional expertise: ${application.professional_expertise.join(', ')}`, `Themes: ${application.thematic_expertise.join(', ') || 'None'}`, `Review applications: https://sici.uk/careers/admin`, `The CV is stored encrypted on the private SICI server and is not attached to this email.`].join('\n'),
      html: `<h2>New SICI Expert Network application</h2><p><b>Reference:</b> ${application.id}</p><p><b>Name:</b> ${escapeHtml(application.full_name)}</p><p><b>Email:</b> ${escapeHtml(application.email)}</p><p><b>Country:</b> ${escapeHtml(application.country_of_residence)}</p><p><b>Professional expertise:</b> ${escapeHtml(application.professional_expertise.join(', '))}</p><p><b>Themes:</b> ${escapeHtml(application.thematic_expertise.join(', ') || 'None')}</p><p><a href="https://sici.uk/careers/admin">Review securely stored application and CV</a></p><p>The CV is encrypted on the private SICI server and is not attached to this email.</p>`
    })
  });
  return result.ok;
}

function authorized(req) {
  const username = process.env.CAREERS_ADMIN_USER || '';
  const password = process.env.CAREERS_ADMIN_PASSWORD || '';
  if (!username || password.length < 20) return false;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  let supplied;
  try { supplied = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const expected = Buffer.from(`${username}:${password}`);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function requireAdmin(req, res) {
  if (authorized(req)) return true;
  res.writeHead(401, { 'www-authenticate': 'Basic realm="SICI Careers", charset="UTF-8"', 'cache-control': 'no-store' });
  res.end('Authentication required');
  return false;
}

async function listApplications() {
  const entries = await readdir(DATA_DIR, { withFileTypes: true });
  const applications = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const record = JSON.parse(decrypt(await readFile(join(DATA_DIR, entry.name, 'application.enc'))).toString('utf8'));
      applications.push(record);
    } catch (error) { if (error.code !== 'ENOENT') console.error('Skipping unreadable application record', entry.name); }
  }
  return applications.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

async function cleanupExpired() {
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  const entries = await readdir(DATA_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(DATA_DIR, entry.name);
    try {
      const details = JSON.parse(decrypt(await readFile(join(path, 'application.enc'))).toString('utf8'));
      if (Date.parse(details.created_at) < cutoff) await rm(path, { recursive: true, force: true });
    } catch (error) { if (error.code !== 'ENOENT') console.error('Retention cleanup skipped an unreadable record', entry.name); }
  }
}

async function submit(req, res) {
  if (req.headers.origin !== SITE_ORIGIN) return json(res, 403, { error: 'Submission origin is not allowed.' });
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength > MAX_REQUEST_BYTES) return json(res, 413, { error: 'The application is too large.' });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) { req.destroy(); return; }
    chunks.push(chunk);
  }
  let form;
  try {
    const request = new Request('https://sici.uk/api/careers', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: Buffer.concat(chunks) });
    form = await request.formData();
  } catch { return json(res, 400, { error: 'The application form could not be read.' }); }
  if (text(form, 'company_website', 200)) return json(res, 201, { ok: true });
  const fullName = text(form, 'full_name', 150);
  const email = text(form, 'email', 240).toLowerCase();
  const country = text(form, 'country_of_residence', 90);
  const professional = values(form, 'professional_expertise[]');
  const themes = values(form, 'thematic_expertise[]');
  const phone = text(form, 'phone', 40);
  const whatsapp = checked(form, 'whatsapp');
  const signal = checked(form, 'signal');
  const file = form.get('cv');
  if (!fullName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !country || !professional.length || form.get('future_opportunities_consent') !== 'yes') {
    return json(res, 400, { error: 'Complete the required fields and consent.' });
  }
  if ((whatsapp || signal) && !phone) return json(res, 400, { error: 'Add a phone number when selecting WhatsApp or Signal.' });
  if (!(file instanceof File) || !file.size || file.size > MAX_CV_BYTES) return json(res, 400, { error: 'Attach a PDF or DOCX CV up to 10 MB.' });
  const lowerName = file.name.toLowerCase();
  const cv = Buffer.from(await file.arrayBuffer());
  const pdf = lowerName.endsWith('.pdf') && file.type === 'application/pdf' && cv.subarray(0, 5).toString() === '%PDF-';
  const docx = lowerName.endsWith('.docx') && file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' && cv.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (!pdf && !docx) return json(res, 400, { error: 'Attach a valid PDF or DOCX CV up to 10 MB.' });
  if (!(await allowSubmission(ipFor(req)))) return json(res, 429, { error: 'Too many applications from this connection. Try again tomorrow.' });

  const application = {
    id: randomUUID(), created_at: new Date().toISOString(), full_name: fullName, email,
    country_of_residence: country, linkedin: text(form, 'linkedin', 500), phone,
    whatsapp, signal, professional_expertise: professional, thematic_expertise: themes,
    additional_information: text(form, 'additional_information', 1500),
    associate_interest: checked(form, 'associate_interest'), privacy_consent: true,
    cv_filename: pdf ? 'cv.pdf' : 'cv.docx'
  };
  const appDir = join(DATA_DIR, application.id);
  try {
    await mkdir(appDir, { recursive: false, mode: 0o700 });
    await atomicWrite(join(appDir, 'cv.enc'), encrypt(cv));
    await atomicWrite(join(appDir, 'application.enc'), encrypt(Buffer.from(JSON.stringify(application))));
  } catch (error) {
    await rm(appDir, { recursive: true, force: true }).catch(() => {});
    console.error('Application save failed', error.message);
    return json(res, 503, { error: 'We could not save your application. Please try again later.' });
  }
  let notificationSent = false;
  try { notificationSent = await sendNotification(application); } catch (error) { console.error('Application saved; notification failed', application.id, error.message); }
  return json(res, 201, { ok: true, notificationSent });
}

async function serveStatic(pathname, res) {
  let path;
  try { path = decodeURIComponent(pathname); } catch { return json(res, 400, { error: 'Invalid path.' }); }
  if (path === '/') path = '/index.html';
  if (path === '/careers' || path === '/careers/') path = '/careers/index.html';
  if (path === '/about') path = '/about.html';
  if (path === '/contact') path = '/contact.html';
  const filePath = resolve(ROOT, `.${path}`);
  if (!filePath.startsWith(`${ROOT}${sep}`)) return json(res, 404, { error: 'Not found.' });
  try {
    const details = await stat(filePath);
    if (!details.isFile()) return json(res, 404, { error: 'Not found.' });
    res.writeHead(200, { 'content-type': TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream', 'content-length': details.size, 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' });
    createReadStream(filePath).pipe(res);
  } catch { json(res, 404, { error: 'Not found.' }); }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });
    if (url.pathname === '/api/careers' && req.method === 'POST') return await submit(req, res);
    if (url.pathname === '/careers/admin' || url.pathname === '/careers/admin/') {
      if (!requireAdmin(req, res)) return;
      return html(res, 200, ADMIN_HTML);
    }
    if (url.pathname === '/api/admin/applications') {
      if (!requireAdmin(req, res)) return;
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
      return json(res, 200, await listApplications());
    }
    const cvMatch = url.pathname.match(/^\/api\/admin\/applications\/([0-9a-f-]{36})\/cv$/i);
    if (cvMatch) {
      if (!requireAdmin(req, res)) return;
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
      const appDir = join(DATA_DIR, cvMatch[1]);
      try {
        const record = JSON.parse(decrypt(await readFile(join(appDir, 'application.enc'))).toString('utf8'));
        const cv = decrypt(await readFile(join(appDir, 'cv.enc')));
        res.writeHead(200, { 'content-type': record.cv_filename.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'content-length': cv.length, 'content-disposition': `attachment; filename="${record.cv_filename}"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
        return res.end(cv);
      } catch { return json(res, 404, { error: 'Application or CV not found.' }); }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
    return await serveStatic(url.pathname, res);
  } catch (error) {
    console.error('Request failed', error.message);
    if (!res.headersSent) json(res, 500, { error: 'Internal server error.' });
    else res.destroy();
  }
});

await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
if (process.env.NODE_ENV === 'production') {
  if (!process.env.CAREERS_ADMIN_USER || (process.env.CAREERS_ADMIN_PASSWORD || '').length < 20) throw new Error('Set CAREERS_ADMIN_USER and a CAREERS_ADMIN_PASSWORD with at least 20 characters');
  if ((process.env.CAREERS_RATE_LIMIT_SECRET || '').length < 32) throw new Error('Set CAREERS_RATE_LIMIT_SECRET to a random value with at least 32 characters');
  getEncryptionKey();
}
await cleanupExpired();
setInterval(() => cleanupExpired().catch(error => console.error('Retention cleanup failed', error.message)), 86400000).unref();
server.listen(PORT, '0.0.0.0', () => console.log(`SICI site and careers service listening on ${PORT}`));

export { server, encrypt, decrypt, getEncryptionKey };
