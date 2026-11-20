// S3 helpers on top of the emulator: path-style, SigV4-signed requests, with small XML readers for the responses.
import { send } from './emulator.js';

export class S3Error extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const BUCKET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/;

export function checkBucket(name) {
  if (!BUCKET_RE.test(String(name))) throw new S3Error('Invalid bucket name (3-63 characters: letters, digits, . _ -)');
  return name;
}

export function checkKey(key) {
  if (typeof key !== 'string' || !key || Buffer.byteLength(key) > 1024) throw new S3Error('Invalid object key (1-1024 bytes)');
  return key;
}

const encodeSegment = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const objectPath = (bucket, key) => `/${bucket}/${key.split('/').map(encodeSegment).join('/')}`;

const decodeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');

/** First <tag>value</tag> inside xml, or null. */
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decodeXml(m[1]) : null;
}

/** Every <tag>...</tag> block inside xml. */
function blocks(xml, name) {
  return [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]);
}

async function call(opts) {
  let res;
  try {
    res = await send({ signingName: 's3', ...opts });
  } catch (e) {
    throw new S3Error(e.code === 'ECONNREFUSED' ? 'Cannot connect to the emulator. Is it running?' : e.message, 502);
  }
  if (res.status >= 400) {
    const text = res.bodyEncoding === 'utf8' ? res.body : Buffer.from(res.body, 'base64').toString('utf8');
    throw new S3Error(tag(text, 'Message') || tag(text, 'Code') || `S3 returned ${res.status}`, res.status);
  }
  return res;
}

export async function listBuckets() {
  const res = await call({ method: 'GET', path: '/' });
  return blocks(res.body, 'Bucket')
    .map((b) => ({ name: tag(b, 'Name'), created: tag(b, 'CreationDate') }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function createBucket(name, region) {
  checkBucket(name);
  const needsLocation = region && region !== 'us-east-1';
  await call({
    method: 'PUT',
    path: `/${name}`,
    headers: needsLocation ? { 'Content-Type': 'application/xml' } : {},
    body: needsLocation ? `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${region}</LocationConstraint></CreateBucketConfiguration>` : '',
  });
}

export async function deleteBucket(name) {
  checkBucket(name);
  await call({ method: 'DELETE', path: `/${name}` });
}

export async function listObjects(bucket, { prefix = '', token = '' } = {}) {
  checkBucket(bucket);
  const query = { 'list-type': '2', delimiter: '/', 'max-keys': '200' };
  if (prefix) query.prefix = prefix;
  if (token) query['continuation-token'] = token;
  const res = await call({ method: 'GET', path: `/${bucket}`, query });
  return {
    prefix,
    prefixes: blocks(res.body, 'CommonPrefixes').map((b) => tag(b, 'Prefix')),
    objects: blocks(res.body, 'Contents')
      .map((b) => ({ key: tag(b, 'Key'), size: Number(tag(b, 'Size') || 0), modified: tag(b, 'LastModified'), storageClass: tag(b, 'StorageClass') }))
      .filter((o) => o.key !== prefix || !prefix.endsWith('/')),
    truncated: tag(res.body, 'IsTruncated') === 'true',
    nextToken: tag(res.body, 'NextContinuationToken'),
  };
}

export async function putObject(bucket, key, data, contentType) {
  checkBucket(bucket);
  checkKey(key);
  await call({
    method: 'PUT',
    path: objectPath(bucket, key),
    headers: { 'Content-Type': contentType || 'application/octet-stream' },
    body: data,
  });
}

export async function getObject(bucket, key) {
  checkBucket(bucket);
  checkKey(key);
  const res = await call({ method: 'GET', path: objectPath(bucket, key), binary: true });
  return { buffer: Buffer.from(res.body, 'base64'), contentType: res.headers['content-type'] || 'application/octet-stream', truncated: res.truncated };
}

export async function deleteObject(bucket, key) {
  checkBucket(bucket);
  checkKey(key);
  await call({ method: 'DELETE', path: objectPath(bucket, key) });
}
