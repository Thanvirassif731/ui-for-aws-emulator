// Talks to the running emulator over HTTPS: reads its generated credentials/CA, signs (SigV4) and sends requests.
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import aws4 from 'aws4';
import { config, emulatorDir } from './config.js';

const MAX_BODY = 20 * 1024 * 1024;

export function readCredentials() {
  const file = path.join(emulatorDir(), 'emulator_credentials');
  if (!fs.existsSync(file)) return null;
  const sections = {};
  let current = null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || s.startsWith(';')) continue;
    const sec = s.match(/^\[(.+)\]$/);
    if (sec) { current = sections[sec[1]] = {}; continue; }
    const kv = s.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (kv && current) current[kv[1].toLowerCase()] = kv[2];
  }
  const c = sections.default || Object.values(sections)[0];
  if (!c || !c.aws_access_key_id) return null;
  return {
    accessKeyId: c.aws_access_key_id,
    secretAccessKey: c.aws_secret_access_key,
    sessionToken: c.aws_session_token || undefined,
  };
}

function readCa() {
  const file = path.join(emulatorDir(), 'ca.pem');
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

function queryString(query) {
  const parts = [];
  for (const [k, v] of Object.entries(query || {})) {
    for (const item of Array.isArray(v) ? v : [v]) {
      parts.push(`${encodeURIComponent(k)}${item === '' || item === undefined ? '' : '=' + encodeURIComponent(item)}`);
    }
  }
  return parts.join('&');
}

function isTextual(contentType = '') {
  return /json|xml|text|javascript|x-www-form-urlencoded|html/i.test(contentType) || contentType === '';
}

/** Send one request to the emulator. `signingName` null means: do not sign. */
export function send({ method, path: reqPath, query, headers = {}, body = '', signingName, binary = false }) {
  return new Promise((resolve, reject) => {
    const ca = readCa();
    if (!ca) return reject(Object.assign(new Error('Emulator certificate not found. Start the emulator first.'), { code: 'NO_CA' }));
    const qs = queryString(query);
    const fullPath = qs ? `${reqPath}?${qs}` : reqPath;
    const opts = {
      host: config.emulatorHost,
      port: config.emulatorPort,
      method,
      path: fullPath,
      headers: { ...headers },
      body: body || undefined,
      service: signingName || undefined,
      region: config.region,
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const creds = readCredentials();
    if (signingName && creds) aws4.sign(opts, creds);

    const started = Date.now();
    const req = https.request(
      { host: opts.host, port: opts.port, method, path: fullPath, headers: opts.headers, ca, timeout: 60_000 },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size <= MAX_BODY) chunks.push(c);
        });
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const contentType = String(res.headers['content-type'] || '');
          const textual = !binary && isTextual(contentType);
          resolve({
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: res.headers,
            durationMs: Date.now() - started,
            truncated: size > MAX_BODY,
            bodyEncoding: textual ? 'utf8' : 'base64',
            body: buf.toString(textual ? 'utf8' : 'base64'),
            request: {
              method,
              url: `https://${config.emulatorHost}:${config.emulatorPort}${fullPath}`,
              signed: !!(signingName && creds),
            },
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Request to emulator timed out')));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

export async function health() {
  try {
    const r = await send({ method: 'GET', path: '/__admin/health', signingName: null });
    return { ok: r.status === 200 && r.body.trim() === 'ok', status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
