import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = 30000 + Math.floor(Math.random() * 20000);
const origin = `http://127.0.0.1:${port}`;
const adminUser = 'reviewer';
const adminPassword = randomBytes(24).toString('base64url');
const auth = `Basic ${Buffer.from(`${adminUser}:${adminPassword}`).toString('base64')}`;
let dataDir;
let child;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sici-careers-test-'));
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATA_DIR: dataDir,
      CAREERS_ADMIN_USER: adminUser,
      CAREERS_ADMIN_PASSWORD: adminPassword,
      CAREERS_RATE_LIMIT_SECRET: randomBytes(32).toString('base64url'),
      CAREERS_ENCRYPTION_KEY: randomBytes(32).toString('base64')
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Test server exited: ${stderr}`);
    try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Test server did not start: ${stderr}`);
});

after(async () => {
  if (child && child.exitCode === null) child.kill();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

function form({ signature = '%PDF-test document', filename = 'cv.pdf', type = 'application/pdf' } = {}) {
  const data = new FormData();
  data.set('full_name', 'Test Applicant');
  data.set('email', 'applicant@example.org');
  data.set('country_of_residence', 'United Kingdom');
  data.append('professional_expertise[]', 'Policy Analysis');
  data.append('thematic_expertise[]', 'Democracy & Civic Space');
  data.set('future_opportunities_consent', 'yes');
  data.set('cv', new File([signature], filename, { type }));
  return data;
}

test('stores an application and encrypted CV and exposes them only after admin authentication', async () => {
  const response = await fetch(`${origin}/api/careers`, { method: 'POST', headers: { origin: 'https://sici.uk' }, body: form() });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true, notificationSent: false });

  const denied = await fetch(`${origin}/api/admin/applications`);
  assert.equal(denied.status, 401);
  const listing = await fetch(`${origin}/api/admin/applications`, { headers: { authorization: auth } });
  assert.equal(listing.status, 200);
  const [application] = await listing.json();
  assert.equal(application.full_name, 'Test Applicant');
  assert.equal(application.email, 'applicant@example.org');

  const deniedCv = await fetch(`${origin}/api/admin/applications/${application.id}/cv`);
  assert.equal(deniedCv.status, 401);
  const cv = await fetch(`${origin}/api/admin/applications/${application.id}/cv`, { headers: { authorization: auth } });
  assert.equal(cv.status, 200);
  assert.equal(await cv.text(), '%PDF-test document');

  const deleted = await fetch(`${origin}/api/admin/applications/${application.id}`, {
    method: 'DELETE', headers: { authorization: auth, origin: 'https://sici.uk', 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: application.id })
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true });
  assert.deepEqual(await (await fetch(`${origin}/api/admin/applications`, { headers: { authorization: auth } })).json(), []);
});

test('rejects foreign origins and invalid CV signatures', async () => {
  const foreign = await fetch(`${origin}/api/careers`, { method: 'POST', headers: { origin: 'https://attacker.example' }, body: form() });
  assert.equal(foreign.status, 403);

  const invalid = await fetch(`${origin}/api/careers`, { method: 'POST', headers: { origin: 'https://sici.uk' }, body: form({ signature: 'not a PDF' }) });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /valid PDF or DOCX/i);
});

test('serves the careers page through the application server', async () => {
  const response = await fetch(`${origin}/careers`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Join Our Expert Network/);
});
