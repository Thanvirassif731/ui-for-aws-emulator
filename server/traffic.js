// Loopback HTTP pass-through proxy that records SDK calls before forwarding them to the HTTPS emulator.
import http from 'node:http';
import https from 'node:https';
import { config } from './config.js';
import { readCa } from './emulator.js';

const MAX_ENTRIES = 200;
const CAPTURE_BYTES = 256 * 1024;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
let nextId = 1;
const entries = [];

function filteredHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())));
}

function safeHeaders(headers) {
  const result = { ...headers };
  for (const name of Object.keys(result)) {
    if (/^(authorization|x-amz-security-token|cookie|set-cookie)$/i.test(name)) result[name] = '[redacted]';
  }
  return result;
}

function textBody(chunks, contentType = '') {
  const body = Buffer.concat(chunks);
  const textual = /json|xml|text|javascript|x-www-form-urlencoded|html/i.test(contentType);
  return { body: body.toString(textual ? 'utf8' : 'base64'), bodyEncoding: textual ? 'utf8' : 'base64' };
}

function inferService(headers) {
  const target = String(headers['x-amz-target'] || '');
  if (target) return target.split('.')[0];
  const auth = String(headers.authorization || '');
  const match = auth.match(/Credential=[^,\s]+\/\d{8}\/[^/]+\/([^/]+)\/aws4_request/i);
  return match?.[1] || '';
}

function capture(chunks, chunk, state) {
  if (state.size >= CAPTURE_BYTES) { state.truncated = true; return; }
  const remaining = CAPTURE_BYTES - state.size;
  chunks.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
  state.size += Math.min(chunk.length, remaining);
  if (chunk.length > remaining) state.truncated = true;
}

export function listTraffic(after = 0) {
  return entries.filter((entry) => entry.id > Number(after || 0)).map((entry) => ({ ...entry }));
}

export function clearTraffic() {
  entries.length = 0;
}

export function createTrafficProxy() {
  return http.createServer((req, res) => {
    const started = Date.now();
    const requestChunks = [];
    const requestCapture = { size: 0, truncated: false };
    const entry = {
      id: nextId++,
      startedAt: new Date(started).toISOString(),
      method: req.method,
      path: req.url,
      service: inferService(req.headers),
      requestHeaders: safeHeaders(req.headers),
      requestBody: '',
      requestBodyEncoding: 'utf8',
      requestTruncated: false,
      status: null,
      durationMs: null,
      responseHeaders: {},
      responseBody: '',
      responseBodyEncoding: 'utf8',
      responseTruncated: false,
      error: '',
    };
    entries.unshift(entry);
    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;

    const ca = readCa();
    if (!ca) {
      entry.status = 502;
      entry.durationMs = Date.now() - started;
      entry.error = 'Emulator certificate not found. Start the emulator first.';
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: entry.error }));
      req.resume();
      return;
    }

    const upstream = https.request({
      host: config.emulatorHost,
      port: config.emulatorPort,
      method: req.method,
      path: req.url,
      headers: filteredHeaders(req.headers),
      ca,
      timeout: 60_000,
    }, (upstreamRes) => {
      entry.status = upstreamRes.statusCode;
      entry.responseHeaders = safeHeaders(upstreamRes.headers);
      res.writeHead(upstreamRes.statusCode || 502, filteredHeaders(upstreamRes.headers));
      const responseChunks = [];
      const responseCapture = { size: 0, truncated: false };
      upstreamRes.on('data', (chunk) => {
        capture(responseChunks, chunk, responseCapture);
        res.write(chunk);
      });
      upstreamRes.on('end', () => {
        const body = textBody(responseChunks, String(upstreamRes.headers['content-type'] || ''));
        entry.responseBody = body.body;
        entry.responseBodyEncoding = body.bodyEncoding;
        entry.responseTruncated = responseCapture.truncated;
        entry.durationMs = Date.now() - started;
        res.end();
      });
    });

    req.on('data', (chunk) => {
      capture(requestChunks, chunk, requestCapture);
      upstream.write(chunk);
    });
    req.on('end', () => {
      const body = textBody(requestChunks, String(req.headers['content-type'] || ''));
      entry.requestBody = body.body;
      entry.requestBodyEncoding = body.bodyEncoding;
      entry.requestTruncated = requestCapture.truncated;
      upstream.end();
    });
    req.on('aborted', () => upstream.destroy());
    upstream.on('timeout', () => upstream.destroy(new Error('Request to emulator timed out')));
    upstream.on('error', (error) => {
      entry.error = error.message;
      entry.status ||= 502;
      entry.durationMs = Date.now() - started;
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ error: error.message }));
    });
  });
}
