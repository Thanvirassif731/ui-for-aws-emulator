import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as s3 from './s3.js';
import { config, setDockerNames, NameError } from './config.js';
import * as docker from './docker.js';
import { health, readCredentials, send } from './emulator.js';
import { describeOperation, getIndex, listOperations, listServices } from './models.js';
import { BuildError, buildRequest } from './requests.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');

// This API can sign requests and run docker commands, so it only answers the local UI:
// the Host must be a loopback name on our ports (blocks DNS rebinding), the Origin (if sent)
// must be one of our own pages, and POST bodies must be JSON (blocks cross-site form posts).
const allowedHosts = new Set();
for (const h of ['localhost', '127.0.0.1']) {
  allowedHosts.add(`${h}:${config.apiPort}`);
  allowedHosts.add(`${h}:${config.webPort}`);
}
app.use((req, res, next) => {
  if (!allowedHosts.has(String(req.headers.host).toLowerCase())) return res.status(403).json({ error: 'Forbidden host' });
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host.toLowerCase(); } catch { host = ''; }
    if (!allowedHosts.has(host)) return res.status(403).json({ error: 'Forbidden origin' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
    return res.status(415).json({ error: 'Content-Type must be application/json' });
  }
  next();
});
app.use(express.json({ limit: '25mb' }));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  if (e instanceof s3.S3Error) return res.status(e.status >= 400 && e.status < 600 ? e.status : 400).json({ error: e.message });
  if (e instanceof NameError) return res.status(400).json({ error: e.message });
  if (e instanceof BuildError) return res.status(400).json({ error: e.message });
  console.error(e);
  res.status(500).json({ error: e.message || 'Internal error' });
});

// ----- emulator control -----
app.get('/api/emulator/status', wrap(async (_req, res) => {
  const [dock, h] = await Promise.all([docker.status(), health()]);
  res.json({
    port: config.emulatorPort,
    region: config.region,
    docker: dock,
    health: h,
    authCredentials: !!readCredentials(),
    build: docker.buildState(),
  });
}));
app.post('/api/emulator/settings', wrap(async (req, res) => {
  if (docker.buildState().running) return res.status(409).json({ error: 'Cannot change names while an image is building' });
  setDockerNames(req.body || {});
  res.json({ imageName: config.imageName, containerName: config.containerName });
}));
app.post('/api/emulator/build', wrap(async (_req, res) => res.json({ started: docker.buildImage() })));
app.post('/api/emulator/start', wrap(async (_req, res) => {
  const r = await docker.start();
  res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { error: r.stderr.trim() });
}));
for (const [name, fn] of [['resume', docker.resume], ['restart', docker.restart], ['remove', docker.remove]]) {
  app.post(`/api/emulator/${name}`, wrap(async (_req, res) => {
    const r = await fn();
    res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { error: r.stderr.trim() });
  }));
}
app.post('/api/emulator/stop', wrap(async (_req, res) => {
  const r = await docker.stop();
  res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { error: r.stderr.trim() });
}));
app.get('/api/emulator/logs', wrap(async (req, res) => res.json({ logs: await docker.logs(req.query.tail) })));

// ----- service catalog (from the Smithy models) -----
app.get('/api/services', wrap(async (req, res) => res.json(listServices(String(req.query.q || '')))));
app.get('/api/services/:id/operations', wrap(async (req, res) => {
  const ops = listOperations(req.params.id);
  if (!ops) return res.status(404).json({ error: 'Unknown service' });
  res.json(ops);
}));
app.get('/api/services/:id/operations/:op', wrap(async (req, res) => {
  const d = describeOperation(req.params.id, req.params.op);
  if (!d) return res.status(404).json({ error: 'Unknown operation' });
  res.json(d);
}));

// ----- S3 -----
app.get('/api/s3/buckets', wrap(async (_req, res) => res.json(await s3.listBuckets())));
app.post('/api/s3/buckets', wrap(async (req, res) => {
  await s3.createBucket(String(req.body?.name || ''), config.region);
  res.json({ ok: true });
}));
app.delete('/api/s3/buckets/:name', wrap(async (req, res) => { await s3.deleteBucket(req.params.name); res.json({ ok: true }); }));
app.get('/api/s3/buckets/:name/objects', wrap(async (req, res) => {
  res.json(await s3.listObjects(req.params.name, { prefix: String(req.query.prefix || ''), token: String(req.query.token || '') }));
}));
app.put('/api/s3/buckets/:name/object', wrap(async (req, res) => {
  const { key, contentType, dataBase64 = '' } = req.body || {};
  await s3.putObject(req.params.name, key, Buffer.from(String(dataBase64), 'base64'), contentType);
  res.json({ ok: true });
}));
app.get('/api/s3/buckets/:name/object', wrap(async (req, res) => {
  const key = String(req.query.key || '');
  const o = await s3.getObject(req.params.name, key);
  if (o.truncated) throw new s3.S3Error('Object is larger than 20 MB; the UI cannot download it', 413);
  const name = key.split('/').pop() || 'download';
  // Never serve stored content with its own content type from the UI origin (stored HTML would run as this page).
  res.set('Content-Type', req.query.download ? 'application/octet-stream' : 'text/plain; charset=utf-8');
  res.set('X-Content-Type-Options', 'nosniff');
  if (req.query.download) res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(o.buffer);
}));
app.delete('/api/s3/buckets/:name/object', wrap(async (req, res) => { await s3.deleteObject(req.params.name, String(req.query.key || '')); res.json({ ok: true }); }));
// ----- invoke -----
app.post('/api/invoke', wrap(async (req, res) => {
  const { serviceId, operation, input, bodyOverride } = req.body || {};
  const built = buildRequest({ serviceId, operation, input, bodyOverride });
  res.json({ ...(await sendOrError(built)), built: { method: built.method, path: built.path, query: built.query, headers: built.headers, body: built.body } });
}));

app.post('/api/raw', wrap(async (req, res) => {
  const { method, path: p, query, headers, body, signingName } = req.body || {};
  if (!/^[A-Z]+$/.test(String(method))) throw new BuildError('Invalid method');
  if (typeof p !== 'string' || !p.startsWith('/')) throw new BuildError('Path must start with "/"');
  res.json(await sendOrError({ method, path: p, query: query || {}, headers: headers || {}, body: body || '', signingName: signingName || null }));
}));

async function sendOrError(req) {
  try {
    return await send(req);
  } catch (e) {
    // Connection-level failures are reported as data so the UI can show them next to the request.
    return { status: 0, statusText: 'Connection error', headers: {}, body: '', bodyEncoding: 'utf8', durationMs: 0, error: e.code === 'ECONNREFUSED' ? 'Cannot connect to the emulator. Is it running?' : e.message };
  }
}

// ----- static UI (production build) -----
const dist = path.resolve(here, '..', 'web', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(config.apiPort, '127.0.0.1', () => {
  console.log(`UI API on http://127.0.0.1:${config.apiPort}  (emulator https://${config.emulatorHost}:${config.emulatorPort})`);
  setImmediate(() => console.log(`Indexed ${getIndex().size} services from ${config.repoRoot}`));
});
