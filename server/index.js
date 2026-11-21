import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as s3 from './s3.js';
import * as dynamodb from './dynamodb.js';
import * as sqs from './sqs.js';
import * as ec2 from './ec2.js';
import { ServiceError } from './aws-json.js';
import { config, setDockerNames, NameError } from './config.js';
import * as docker from './docker.js';
import * as native from './native.js';
import { createTrafficProxy, clearTraffic, listTraffic } from './traffic.js';
import { health, readCredentials, send } from './emulator.js';
import { describeOperation, getIndex, listOperations, listServices } from './models.js';
import { BuildError, buildRequest } from './requests.js';
import { exportSnapshot, importSnapshot, SnapshotValidationError } from './snapshots.js';

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
  if (e instanceof s3.S3Error || e instanceof ServiceError || e instanceof ec2.Ec2Error) return res.status(e.status >= 400 && e.status < 600 ? e.status : 400).json({ error: e.message });
  if (e instanceof NameError) return res.status(400).json({ error: e.message });
  if (e instanceof BuildError || e instanceof SnapshotValidationError) return res.status(400).json({ error: e.message });
  console.error(e);
  res.status(500).json({ error: e.message || 'Internal error' });
});

// ----- emulator control -----
app.get('/api/emulator/status', wrap(async (_req, res) => {
  const [dock, h] = await Promise.all([
    config.mode === 'docker' ? docker.status() : Promise.resolve(null),
    health(),
  ]);
  res.json({
    mode: config.mode,
    port: config.emulatorPort,
    host: config.emulatorHost,
    region: config.region,
    proxy: { host: '127.0.0.1', port: config.proxyPort },
    docker: dock,
    native: native.status(),
    health: h,
    authCredentials: !!readCredentials(),
    build: config.mode === 'docker' ? docker.buildState() : { running: false, exitCode: null, log: '' },
    names: { imageName: config.imageName, containerName: config.containerName },
  });
}));
app.post('/api/emulator/settings', wrap(async (req, res) => {
  if (config.mode !== 'docker') return res.status(409).json({ error: 'Docker settings are available only in docker mode' });
  if (docker.buildState().running) return res.status(409).json({ error: 'Cannot change names while an image is building' });
  setDockerNames(req.body || {});
  res.json({ imageName: config.imageName, containerName: config.containerName });
}));
app.post('/api/emulator/build', wrap(async (_req, res) => {
  if (config.mode !== 'docker') return res.status(409).json({ error: 'Image builds are available only in docker mode' });
  res.json({ started: docker.buildImage() });
}));
app.post('/api/emulator/start', wrap(async (_req, res) => {
  if (config.mode === 'native') {
    const result = native.start();
    return res.status(result.ok ? 200 : 500).json(result.ok ? { ok: true } : { error: result.error });
  }
  if (config.mode !== 'docker') return res.status(409).json({ error: 'External mode observes an emulator started outside this UI' });
  const r = await docker.start();
  res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { error: r.stderr.trim() });
}));
for (const [name, fn] of [['resume', docker.resume], ['restart', docker.restart], ['remove', docker.remove]]) {
  app.post(`/api/emulator/${name}`, wrap(async (_req, res) => {
    if (config.mode !== 'docker') return res.status(409).json({ error: `${name} is available only in docker mode` });
    const r = await fn();
    res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { error: r.stderr.trim() });
  }));
}
app.post('/api/emulator/stop', wrap(async (_req, res) => {
  if (config.mode === 'native') {
    const result = await native.stop();
    return res.status(result.ok ? 200 : 500).json(result.ok ? { ok: true } : { error: result.error });
  }
  if (config.mode !== 'docker') return res.status(409).json({ error: 'External mode cannot stop a process it did not start' });
  const r = await docker.stop();
  res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { error: r.stderr.trim() });
}));
app.get('/api/emulator/logs', wrap(async (req, res) => {
  if (config.mode === 'native') return res.json({ logs: native.logs(req.query.tail) });
  if (config.mode === 'external') return res.json({ logs: 'External mode does not own the emulator process. Read logs where you started it.' });
  res.json({ logs: await docker.logs(req.query.tail) });
}));

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

// ----- DynamoDB -----
app.get('/api/dynamodb/tables', wrap(async (_req, res) => res.json(await dynamodb.listTables())));
app.post('/api/dynamodb/scan', wrap(async (req, res) => {
  res.json(await dynamodb.scanTable(String(req.body?.tableName || ''), req.body?.exclusiveStartKey || null));
}));

// ----- SQS -----
app.get('/api/sqs/queues', wrap(async (_req, res) => res.json(await sqs.listQueues())));
app.post('/api/sqs/inspect', wrap(async (req, res) => {
  const queueUrl = String(req.body?.queueUrl || '');
  const [attributes, messages] = await Promise.all([sqs.queueAttributes(queueUrl), sqs.receiveMessages(queueUrl)]);
  res.json({ attributes, messages });
}));
app.post('/api/sqs/send', wrap(async (req, res) => res.json(await sqs.sendMessage(String(req.body?.queueUrl || ''), req.body?.body))));
app.post('/api/sqs/delete-message', wrap(async (req, res) => {
  await sqs.deleteMessage(String(req.body?.queueUrl || ''), String(req.body?.receiptHandle || ''));
  res.json({ ok: true });
}));
app.post('/api/sqs/purge', wrap(async (req, res) => {
  await sqs.purgeQueue(String(req.body?.queueUrl || ''));
  res.json({ ok: true });
}));

// ----- EC2 -----
app.get('/api/ec2/instances', wrap(async (req, res) => res.json(await ec2.listInstances(String(req.query.token || '')))));
app.post('/api/ec2/instances/describe', wrap(async (req, res) => res.json(await ec2.describeInstances(req.body?.instanceIds))));
app.get('/api/ec2/images', wrap(async (req, res) => res.json(await ec2.listImages(String(req.query.token || '')))));
app.post('/api/ec2/instances', wrap(async (req, res) => res.json(await ec2.runInstances(req.body || {}))));
app.post('/api/ec2/instances/action', wrap(async (req, res) => {
  res.json(await ec2.instanceAction(req.body?.action, req.body?.instanceIds));
}));

// ----- ephemeral state snapshots -----
app.get('/api/snapshots/export', wrap(async (req, res) => {
  const snapshot = await exportSnapshot({ includeMessages: String(req.query.includeMessages).toLowerCase() === 'true' });
  res.set('Content-Disposition', 'attachment; filename="emulator-seed.json"');
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(snapshot, null, 2));
}));
app.post('/api/snapshots/import', wrap(async (req, res) => {
  const { snapshot, cleanFirst = false } = req.body || {};
  const summary = await importSnapshot(snapshot, { cleanFirst: cleanFirst === true });
  res.json({ ok: true, summary });
}));

// ----- intercepted SDK traffic -----
app.get('/api/traffic', wrap(async (req, res) => res.json(listTraffic(req.query.after))));
app.delete('/api/traffic', wrap(async (_req, res) => { clearTraffic(); res.json({ ok: true }); }));

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
  console.log(`UI API on http://127.0.0.1:${config.apiPort}  (emulator https://${config.emulatorHost}:${config.emulatorPort}, mode ${config.mode})`);
  setImmediate(() => console.log(`Indexed ${getIndex().size} services from ${config.repoRoot}`));
});

createTrafficProxy().listen(config.proxyPort, '127.0.0.1', () => {
  console.log(`Traffic proxy on http://127.0.0.1:${config.proxyPort}`);
});

if (config.seedFile) {
  let wasHealthy = false;
  let attempted = false;
  let checking = false;
  const applySeedOnHealthyTransition = async () => {
    if (checking || attempted) return;
    checking = true;
    try {
      const state = await health();
      if (state.ok && !wasHealthy) {
        attempted = true;
        const seedPath = path.resolve(config.seedFile);
        try {
          const snapshot = JSON.parse(await fs.promises.readFile(seedPath, 'utf8'));
          const summary = await importSnapshot(snapshot);
          console.log(`Applied emulator seed ${seedPath}: ${summary.s3.buckets} S3 buckets, ${summary.dynamodb.tables} DynamoDB tables, ${summary.sqs.queues} SQS queues`);
          if (summary.errors.length) console.error(`Emulator seed completed with ${summary.errors.length} partial errors`, summary.errors);
        } catch (error) {
          console.error(`Could not apply EMULATOR_SEED_FILE ${seedPath}: ${error.message}`);
        }
      }
      wasHealthy = state.ok;
    } finally {
      checking = false;
    }
  };
  applySeedOnHealthyTransition();
  setInterval(applySeedOnHealthyTransition, 2000).unref();
}
