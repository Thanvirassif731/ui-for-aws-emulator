// S3 Learning Sandbox: learner-facing behavior layered on top of the emulator's S3 state.
//
// The emulator stores website configs, Block Public Access settings, bucket policies, object
// versions, and lifecycle rules. It does not serve websites over HTTP, enforce bucket policies for
// anonymous website visitors, or run lifecycle expiration. This module adds those three things,
// plus a bucket policy simulator, while the emulator stays the single source of truth for data.
import {
  DeleteBucketLifecycleCommand,
  DeleteBucketPolicyCommand,
  DeleteBucketWebsiteCommand,
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  GetBucketWebsiteCommand,
  GetObjectCommand,
  GetPublicAccessBlockCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  PutBucketWebsiteCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import crypto from 'node:crypto';
import { Readable, pipeline } from 'node:stream';
import express from 'express';
import mime from 'mime-types';
import { config } from './config.js';
import { readCredentials, send } from './emulator.js';
import { checkBucket, checkKey } from './s3.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_VERSIONS_SCANNED = 10_000;
const MAX_POLICY_BYTES = 20 * 1024;
const MAX_ADVANCE_DAYS = 3650;
const DEFAULT_STUDENT_ARN = 'arn:aws:iam::123456789012:user/student';

export class S3SandboxError extends Error {
  constructor(message, status = 400, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// SDK client. The SDK owns serialization, SigV4 signing, and parsing; the bytes travel over the
// application's certificate-verified transport (emulator.js), exactly like the EC2 client.
// ---------------------------------------------------------------------------------------------

async function bodyBuffer(body) {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  throw new S3SandboxError('Unsupported S3 request body', 500);
}

function normalizeQuery(query = {}) {
  const result = {};
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined) continue;
    result[name] = Array.isArray(value) ? value.map((item) => item ?? '') : (value ?? '');
  }
  return result;
}

export const sdkTransport = {
  handle: async (request) => {
    const body = await bodyBuffer(request.body);
    const result = await send({
      method: request.method,
      path: request.path,
      query: normalizeQuery(request.query),
      headers: request.headers,
      body: body.length ? body : '',
      signingName: null,
      binary: true,
    });
    if (result.truncated) throw new S3SandboxError('The object is larger than 20 MB, which is more than the sandbox transport can relay', 413, 'ObjectTooLarge');
    const payload = Buffer.from(result.body || '', result.bodyEncoding === 'base64' ? 'base64' : 'utf8');
    return { response: { statusCode: result.status, reason: result.statusText, headers: result.headers, body: Readable.from([payload]) } };
  },
};

const client = new S3Client({
  region: config.region,
  endpoint: `https://${config.emulatorHost}:${config.emulatorPort}`,
  forcePathStyle: true,
  maxAttempts: 1,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
  credentials: async () => readCredentials() || { accessKeyId: 'aws-emulator', secretAccessKey: 'aws-emulator' },
  requestHandler: sdkTransport,
});

const FRIENDLY_ERRORS = {
  NoSuchBucket: 'This bucket does not exist anymore. Refresh the bucket list.',
  NoSuchKey: 'That object key does not exist in this bucket.',
  NoSuchVersion: 'That version no longer exists. Refresh the version list.',
  InvalidArgument: 'S3 rejected one of the values. Check the form fields and try again.',
};

async function call(command) {
  try {
    return await client.send(command);
  } catch (error) {
    if (error instanceof S3SandboxError) throw error;
    if (error?.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(error?.message || '')) {
      throw new S3SandboxError('Cannot connect to the emulator. Is it running?', 502, 'EmulatorUnavailable');
    }
    if (error?.code === 'NO_CA') throw new S3SandboxError(error.message, 502, 'EmulatorUnavailable');
    const code = error?.Code || error?.name || '';
    const status = Number(error?.$metadata?.httpStatusCode) || 502;
    const detail = error?.message && error.message !== code && error.message !== 'UnknownError' ? error.message : '';
    throw new S3SandboxError(FRIENDLY_ERRORS[code] || detail || code || `S3 returned ${status}`, status, code);
  }
}

const iso = (value) => (value instanceof Date ? value.toISOString() : value ? String(value) : null);

function checkVersionId(versionId) {
  if (typeof versionId !== 'string' || !versionId || versionId.length > 1024) throw new S3SandboxError('A version ID is required');
  return versionId;
}

// ---------------------------------------------------------------------------------------------
// Bucket policy evaluation (pure; no I/O). Mirrors the order S3 uses: an explicit Deny in any
// statement wins, otherwise any matching Allow grants access, otherwise access is implicitly denied.
// ---------------------------------------------------------------------------------------------

const asList = (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);

function globRegex(pattern, ignoreCase = false) {
  const source = String(pattern).split('').map((ch) => {
    if (ch === '*') return '.*';
    if (ch === '?') return '.';
    return ch.replace(/[.+^${}()|[\]\\/]/g, '\\$&');
  }).join('');
  return new RegExp(`^${source}$`, ignoreCase ? 'is' : 's');
}

const globMatch = (pattern, value, ignoreCase = false) => globRegex(pattern, ignoreCase).test(String(value));

/** Parse and minimally validate a policy document supplied as JSON text or an object. */
export function parsePolicy(input) {
  let document = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input) > MAX_POLICY_BYTES) throw new S3SandboxError('Bucket policies are limited to 20 KB');
    try { document = JSON.parse(input); } catch (error) {
      throw new S3SandboxError(`The bucket policy is not valid JSON: ${error.message}`);
    }
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new S3SandboxError('A bucket policy must be a JSON object such as { "Version": "2012-10-17", "Statement": [...] }');
  const statements = asList(document.Statement);
  if (!statements.length) throw new S3SandboxError('A bucket policy needs at least one entry in "Statement"');
  statements.forEach((statement, index) => {
    if (!statement || typeof statement !== 'object' || Array.isArray(statement)) throw new S3SandboxError(`Statement ${index + 1} must be a JSON object`);
    if (statement.Effect !== 'Allow' && statement.Effect !== 'Deny') throw new S3SandboxError(`Statement ${index + 1} needs "Effect": "Allow" or "Effect": "Deny" (case-sensitive)`);
    if (statement.Action === undefined && statement.NotAction === undefined) throw new S3SandboxError(`Statement ${index + 1} needs an "Action", such as "s3:GetObject"`);
    if (statement.Resource === undefined && statement.NotResource === undefined) throw new S3SandboxError(`Statement ${index + 1} needs a "Resource", such as "arn:aws:s3:::my-bucket/*"`);
  });
  return { ...document, Statement: statements };
}

const statementName = (statement, index) => (typeof statement.Sid === 'string' && statement.Sid ? statement.Sid : `Statement[${index}]`);

function principalMatches(principal, caller) {
  if (principal === '*') return true;
  if (!principal || typeof principal !== 'object') return false;
  const aws = asList(principal.AWS).map(String);
  if (aws.includes('*')) return true;
  if (caller.anonymous) return false;
  return aws.some((entry) => entry === caller.arn || entry === caller.accountId || entry === `arn:aws:iam::${caller.accountId}:root`);
}

const STRING_TESTS = {
  StringEquals: (actual, expected) => actual === expected,
  StringEqualsIgnoreCase: (actual, expected) => actual.toLowerCase() === expected.toLowerCase(),
  StringLike: (actual, expected) => globMatch(expected, actual),
  ArnEquals: (actual, expected) => globMatch(expected, actual),
  ArnLike: (actual, expected) => globMatch(expected, actual),
  Bool: (actual, expected) => actual.toLowerCase() === expected.toLowerCase(),
  NumericEquals: (actual, expected) => Number(actual) === Number(expected),
  NumericLessThan: (actual, expected) => Number(actual) < Number(expected),
  NumericLessThanEquals: (actual, expected) => Number(actual) <= Number(expected),
  NumericGreaterThan: (actual, expected) => Number(actual) > Number(expected),
  NumericGreaterThanEquals: (actual, expected) => Number(actual) >= Number(expected),
};
const NEGATED_TESTS = {
  StringNotEquals: 'StringEquals',
  StringNotEqualsIgnoreCase: 'StringEqualsIgnoreCase',
  StringNotLike: 'StringLike',
  ArnNotEquals: 'ArnEquals',
  ArnNotLike: 'ArnLike',
  NumericNotEquals: 'NumericEquals',
};

function conditionContext(request, caller) {
  const context = new Map();
  for (const [name, value] of Object.entries(request.headers || {})) {
    const header = String(name).trim().toLowerCase();
    if (header.startsWith('x-amz-') && value !== undefined && value !== null && String(value) !== '') context.set(`s3:${header}`, String(value));
  }
  context.set('aws:securetransport', 'true');
  context.set('aws:principaltype', caller.anonymous ? 'Anonymous' : 'User');
  if (!caller.anonymous) {
    context.set('aws:principalarn', caller.arn);
    context.set('aws:principalaccount', caller.accountId);
  }
  return context;
}

/** Evaluate one Condition block. Every operator and every key inside it must hold (logical AND). */
function evaluateCondition(condition, context) {
  const details = [];
  const unsupported = [];
  if (condition === undefined) return { matched: true, details, unsupported };
  if (!condition || typeof condition !== 'object') return { matched: false, details: ['the Condition block is not an object'], unsupported };
  let matched = true;
  for (const [rawOperator, keys] of Object.entries(condition)) {
    if (rawOperator.includes(':')) { unsupported.push(rawOperator); matched = false; continue; }
    const ifExists = rawOperator.endsWith('IfExists');
    const operator = ifExists ? rawOperator.slice(0, -'IfExists'.length) : rawOperator;
    for (const [rawKey, expectedValues] of Object.entries(keys || {})) {
      const key = rawKey.toLowerCase();
      const expected = asList(expectedValues).map(String);
      const actual = context.get(key);
      const shown = actual === undefined ? '(missing)' : `"${actual}"`;
      let holds;
      if (operator === 'Null') {
        holds = expected.some((value) => (value.toLowerCase() === 'true') === (actual === undefined));
      } else if (STRING_TESTS[operator] || NEGATED_TESTS[operator]) {
        const negated = !!NEGATED_TESTS[operator];
        const test = STRING_TESTS[NEGATED_TESTS[operator] || operator];
        if (actual === undefined) holds = ifExists || negated;
        else {
          const any = expected.some((value) => test(actual, value));
          holds = negated ? !any : any;
        }
      } else {
        unsupported.push(rawOperator);
        matched = false;
        continue;
      }
      details.push(`${rawOperator} ${rawKey}: request value ${shown} vs ${expected.map((value) => `"${value}"`).join(' or ')} -> ${holds ? 'true' : 'false'}`);
      if (!holds) matched = false;
    }
  }
  return { matched, details, unsupported };
}

/**
 * Evaluate a bucket policy for one request.
 * request: { bucket, action, key, isAnonymous, headers, principalArn }
 * Returns { allowed, decision, matchedStatementId?, explanation, trace, warnings }.
 */
export function evaluateBucketPolicy(policyInput, request) {
  const bucket = String(request?.bucket || '');
  const action = String(request?.action || '').trim();
  const key = request?.key ? String(request.key) : '';
  if (!/^[A-Za-z0-9-]+:[A-Za-z0-9*?]+$/.test(action)) throw new S3SandboxError('Action must look like "s3:GetObject"');
  const anonymous = request?.isAnonymous !== false;
  const arn = String(request?.principalArn || DEFAULT_STUDENT_ARN);
  const caller = { anonymous, arn, accountId: arn.split(':')[4] || '' };
  const callerLabel = anonymous ? 'an anonymous public user (Principal "*")' : `the authenticated student (${arn})`;
  const resource = key ? `arn:aws:s3:::${bucket}/${key}` : `arn:aws:s3:::${bucket}`;

  if (policyInput === null || policyInput === undefined || policyInput === '') {
    return {
      allowed: false,
      decision: 'IMPLICIT_DENY',
      explanation: `This bucket has no bucket policy, so nothing grants ${callerLabel} ${action} on ${resource}. S3 denies every request that is not explicitly allowed (implicit deny).${anonymous ? '' : ' This simulator checks only the bucket policy; in real AWS an IAM identity policy in the bucket owner\'s account could also grant access.'}`,
      resource,
      trace: [],
      warnings: [],
    };
  }

  const policy = parsePolicy(policyInput);
  const context = conditionContext(request || {}, caller);
  const warnings = [];
  const trace = policy.Statement.map((statement, index) => {
    const sid = statementName(statement, index);
    const entry = { sid, effect: statement.Effect, matched: false, reason: '' };
    if (statement.Principal === undefined && statement.NotPrincipal === undefined) {
      entry.reason = 'No "Principal" element. Bucket policies must name who the statement applies to.';
      warnings.push(`${sid} has no Principal, so it never applies.`);
      return entry;
    }
    const principalOk = statement.Principal !== undefined
      ? principalMatches(statement.Principal, caller)
      : !principalMatches(statement.NotPrincipal, caller);
    if (!principalOk) { entry.reason = `Principal does not include ${anonymous ? 'anonymous users' : 'this caller'}.`; return entry; }

    const actions = asList(statement.Action ?? statement.NotAction).map(String);
    const actionListed = actions.some((pattern) => globMatch(pattern, action, true));
    if (statement.Action !== undefined ? !actionListed : actionListed) { entry.reason = `Action ${JSON.stringify(statement.Action ?? { NotAction: statement.NotAction })} does not cover ${action}.`; return entry; }

    const resources = asList(statement.Resource ?? statement.NotResource).map(String);
    const resourceListed = resources.some((pattern) => globMatch(pattern, resource));
    if (statement.Resource !== undefined ? !resourceListed : resourceListed) { entry.reason = `Resource ${JSON.stringify(statement.Resource ?? { NotResource: statement.NotResource })} does not cover ${resource}.`; return entry; }

    const condition = evaluateCondition(statement.Condition, context);
    if (condition.unsupported.length) warnings.push(`${sid} uses condition operators this simulator does not evaluate (${condition.unsupported.join(', ')}); it was treated as not matching.`);
    entry.conditions = condition.details;
    if (!condition.matched) { entry.reason = `Condition not met: ${condition.details.filter((line) => line.endsWith('false')).join('; ') || 'unsupported operator'}.`; return entry; }
    entry.matched = true;
    entry.reason = statement.Condition ? `Principal, Action, Resource, and Condition all match (${condition.details.join('; ')}).` : 'Principal, Action, and Resource all match.';
    return entry;
  });

  const deny = trace.find((entry) => entry.matched && entry.effect === 'Deny');
  if (deny) {
    return {
      allowed: false,
      decision: 'EXPLICIT_DENY',
      matchedStatementId: deny.sid,
      explanation: `Statement "${deny.sid}" explicitly denies ${action} on ${resource} for ${callerLabel}. ${deny.conditions?.length ? `Its Condition matched: ${deny.conditions.join('; ')}. ` : ''}An explicit Deny always wins, even when another statement allows the request.`,
      resource,
      trace,
      warnings,
    };
  }
  const allow = trace.find((entry) => entry.matched && entry.effect === 'Allow');
  if (allow) {
    return {
      allowed: true,
      decision: 'ALLOWED',
      matchedStatementId: allow.sid,
      explanation: `Statement "${allow.sid}" allows ${callerLabel} to perform ${action} on ${resource}, and no statement denies it.`,
      resource,
      trace,
      warnings,
    };
  }
  return {
    allowed: false,
    decision: 'IMPLICIT_DENY',
    explanation: `No statement allows ${callerLabel} to perform ${action} on ${resource}, so S3 denies it by default (implicit deny).${anonymous ? '' : ' This simulator checks only the bucket policy; in real AWS an IAM identity policy in the bucket owner\'s account could also grant access.'}`,
    resource,
    trace,
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// Bucket settings: website, Block Public Access, policy, versioning.
// ---------------------------------------------------------------------------------------------

const PAB_FIELDS = ['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets'];

export async function getPublicAccessBlock(bucket) {
  checkBucket(bucket);
  try {
    const output = await call(new GetPublicAccessBlockCommand({ Bucket: bucket }));
    const stored = output.PublicAccessBlockConfiguration || {};
    return { configured: true, ...Object.fromEntries(PAB_FIELDS.map((field) => [field, stored[field] === true])) };
  } catch (error) {
    if (error.code === 'NoSuchPublicAccessBlockConfiguration') return { configured: false, ...Object.fromEntries(PAB_FIELDS.map((field) => [field, false])) };
    throw error;
  }
}

export async function putPublicAccessBlock(bucket, input = {}) {
  checkBucket(bucket);
  const settings = Object.fromEntries(PAB_FIELDS.map((field) => [field, input[field] === true]));
  await call(new PutPublicAccessBlockCommand({ Bucket: bucket, PublicAccessBlockConfiguration: settings }));
  return getPublicAccessBlock(bucket);
}

/** Why Block Public Access keeps anonymous visitors out, or '' when it does not. */
export function publicAccessBlockReason(settings) {
  if (settings?.BlockPublicPolicy) return 'Block Public Access is enabled (BlockPublicPolicy = true), so this bucket cannot be made public by a bucket policy';
  if (settings?.RestrictPublicBuckets) return 'Block Public Access is enabled (RestrictPublicBuckets = true), so anonymous requests are refused even if the bucket policy is public';
  return '';
}

export async function getPolicy(bucket) {
  checkBucket(bucket);
  try {
    const output = await call(new GetBucketPolicyCommand({ Bucket: bucket }));
    return output.Policy || null;
  } catch (error) {
    if (error.code === 'NoSuchBucketPolicy') return null;
    throw error;
  }
}

export async function putPolicy(bucket, policyText) {
  checkBucket(bucket);
  if (typeof policyText !== 'string' || !policyText.trim()) throw new S3SandboxError('Paste or load a bucket policy before saving');
  parsePolicy(policyText);
  try {
    await call(new PutBucketPolicyCommand({ Bucket: bucket, Policy: policyText.trim() }));
  } catch (error) {
    if (error.code === 'AccessDenied' && (await getPublicAccessBlock(bucket).catch(() => ({}))).BlockPublicPolicy) {
      throw new S3SandboxError('S3 refused this policy because it would make the bucket public while Block Public Access (BlockPublicPolicy) is on. Turn off Block Public Access first, then save the policy again.', 403, 'AccessDenied');
    }
    if (error.code === 'MalformedPolicy') {
      throw new S3SandboxError(`S3 rejected the policy as malformed: ${error.message}. Check that "Version" is "2012-10-17" and that every Resource ARN names this bucket, for example arn:aws:s3:::${bucket}/*.`, 400, 'MalformedPolicy');
    }
    throw error;
  }
  return getPolicy(bucket);
}

export async function deletePolicy(bucket) {
  checkBucket(bucket);
  await call(new DeleteBucketPolicyCommand({ Bucket: bucket }));
}

export async function getWebsiteConfig(bucket) {
  checkBucket(bucket);
  try {
    const output = await call(new GetBucketWebsiteCommand({ Bucket: bucket }));
    return { enabled: true, indexDocument: output.IndexDocument?.Suffix || 'index.html', errorDocument: output.ErrorDocument?.Key || '' };
  } catch (error) {
    if (error.code === 'NoSuchWebsiteConfiguration') return { enabled: false, indexDocument: 'index.html', errorDocument: '' };
    throw error;
  }
}

export async function putWebsiteConfig(bucket, input = {}) {
  checkBucket(bucket);
  if (input.enabled === false) {
    await call(new DeleteBucketWebsiteCommand({ Bucket: bucket }));
    return getWebsiteConfig(bucket);
  }
  const indexDocument = String(input.indexDocument ?? 'index.html').trim();
  const errorDocument = String(input.errorDocument ?? '').trim();
  if (!indexDocument || indexDocument.includes('/') || Buffer.byteLength(indexDocument) > 1024) {
    throw new S3SandboxError('The index document must be a file name without "/", such as index.html. S3 appends it to every folder path.');
  }
  if (errorDocument) checkKey(errorDocument);
  await call(new PutBucketWebsiteCommand({
    Bucket: bucket,
    WebsiteConfiguration: { IndexDocument: { Suffix: indexDocument }, ...(errorDocument ? { ErrorDocument: { Key: errorDocument } } : {}) },
  }));
  return getWebsiteConfig(bucket);
}

export function websiteEndpoint(bucket) {
  return `http://localhost:${config.websitePort}/s3-web/${encodeURIComponent(bucket)}/`;
}

export async function websiteStatus(bucket) {
  checkBucket(bucket);
  const [site, publicAccess, policy] = await Promise.all([getWebsiteConfig(bucket), getPublicAccessBlock(bucket), getPolicy(bucket)]);
  const blockReason = publicAccessBlockReason(publicAccess);
  let decision = null;
  let policyError = '';
  if (policy) {
    try { decision = evaluateBucketPolicy(policy, { bucket, action: 's3:GetObject', key: site.indexDocument, isAnonymous: true }); }
    catch (error) { policyError = error.message; }
  }
  const checklist = [
    {
      id: 'website',
      label: 'Static Website Hosting Enabled',
      ok: site.enabled,
      hint: site.enabled ? `S3 serves "${site.indexDocument}" for folder paths.` : 'Turn on Static Website Hosting so the website endpoint answers requests.',
    },
    {
      id: 'publicAccess',
      label: 'Block Public Access Disabled',
      ok: !blockReason,
      hint: blockReason ? `${blockReason}. Turn it off in the Permissions tab.` : 'Block Public Access is not stopping anonymous visitors.',
    },
    {
      id: 'policy',
      label: 'Public Read Bucket Policy Attached',
      ok: !!decision?.allowed,
      hint: policyError || (decision ? decision.explanation : 'No bucket policy is attached. Load the "Public Read-Only" preset in the Permissions tab.'),
    },
  ];
  return { ...site, endpoint: websiteEndpoint(bucket), publicAccessBlock: publicAccess, checklist, ready: checklist.every((item) => item.ok) };
}

export async function getVersioning(bucket) {
  checkBucket(bucket);
  const output = await call(new GetBucketVersioningCommand({ Bucket: bucket }));
  return { status: output.Status || 'Unversioned' };
}

export async function putVersioning(bucket, status) {
  checkBucket(bucket);
  if (status !== 'Enabled' && status !== 'Suspended') throw new S3SandboxError('Versioning status must be "Enabled" or "Suspended". Once enabled, a bucket can never return to unversioned.');
  await call(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: status } }));
  return getVersioning(bucket);
}

// ---------------------------------------------------------------------------------------------
// Object versions and delete markers.
// ---------------------------------------------------------------------------------------------

async function listVersionEntries(bucket, { prefix = '', delimiter, limit = MAX_VERSIONS_SCANNED } = {}) {
  const entries = [];
  const prefixes = new Set();
  let keyMarker;
  let versionIdMarker;
  let truncated = false;
  do {
    const output = await call(new ListObjectVersionsCommand({
      Bucket: bucket,
      MaxKeys: 1000,
      ...(prefix ? { Prefix: prefix } : {}),
      ...(delimiter ? { Delimiter: delimiter } : {}),
      ...(keyMarker ? { KeyMarker: keyMarker } : {}),
      ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
    }));
    for (const version of output.Versions || []) {
      entries.push({ key: version.Key, versionId: version.VersionId || 'null', isLatest: !!version.IsLatest, isDeleteMarker: false, lastModified: iso(version.LastModified), size: Number(version.Size || 0), etag: version.ETag || '' });
    }
    for (const marker of output.DeleteMarkers || []) {
      entries.push({ key: marker.Key, versionId: marker.VersionId || 'null', isLatest: !!marker.IsLatest, isDeleteMarker: true, lastModified: iso(marker.LastModified), size: 0, etag: '' });
    }
    for (const common of output.CommonPrefixes || []) if (common.Prefix) prefixes.add(common.Prefix);
    truncated = !!output.IsTruncated;
    keyMarker = output.NextKeyMarker;
    versionIdMarker = output.NextVersionIdMarker;
  } while (truncated && keyMarker && entries.length < limit);
  return { entries, prefixes: [...prefixes], truncated };
}

/** Group version entries by key, newest first (the current version always leads). */
export function groupVersions(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.key)) groups.set(entry.key, []);
    groups.get(entry.key).push(entry);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, versions]) => {
      versions.sort((a, b) => (Number(b.isLatest) - Number(a.isLatest)) || (Date.parse(b.lastModified || 0) - Date.parse(a.lastModified || 0)));
      return { key, versions, deleted: !!versions[0]?.isDeleteMarker };
    });
}

export async function listVersions(bucket, prefix = '') {
  checkBucket(bucket);
  const { entries, prefixes, truncated } = await listVersionEntries(bucket, { prefix, delimiter: '/', limit: 2000 });
  return { prefix, prefixes, objects: groupVersions(entries).filter((group) => group.key !== prefix || !prefix.endsWith('/')), truncated };
}

/** Restore an object by removing its delete marker. Refuses anything that is not a delete marker. */
export async function restoreObject(bucket, key, versionId) {
  checkBucket(bucket);
  checkKey(key);
  checkVersionId(versionId);
  const { entries } = await listVersionEntries(bucket, { prefix: key, limit: 5000 });
  const target = entries.find((entry) => entry.key === key && entry.versionId === versionId);
  if (!target) throw new S3SandboxError('That delete marker no longer exists. Refresh the version list.', 404, 'NoSuchVersion');
  if (!target.isDeleteMarker) throw new S3SandboxError('Restore removes delete markers only. This version holds object data, so it was left untouched.', 409);
  await call(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
  const remaining = entries.filter((entry) => entry.key === key && entry.versionId !== versionId);
  const restored = groupVersions(remaining)[0]?.versions[0] || null;
  return { key, removedDeleteMarker: versionId, currentVersion: restored && !restored.isDeleteMarker ? restored.versionId : null };
}

// ---------------------------------------------------------------------------------------------
// Sample static website.
// ---------------------------------------------------------------------------------------------

function sampleSite(bucket) {
  const index = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>My S3 Portfolio</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header>
    <p class="eyebrow">Hosted on Amazon S3 (AWS Emulator sandbox)</p>
    <h1>Hi, I'm a cloud learner.</h1>
    <p>This page is the bucket's <code>index.html</code>. S3 returns it for the website root because it is the configured index document.</p>
  </header>
  <main>
    <section class="card">
      <h2>What just happened?</h2>
      <ol>
        <li>Static Website Hosting is enabled on bucket <code>${bucket}</code>.</li>
        <li>Block Public Access is off, so a public policy is allowed to take effect.</li>
        <li>A bucket policy grants <code>s3:GetObject</code> to <code>Principal: "*"</code>.</li>
      </ol>
    </section>
    <section class="card">
      <h2>Try these</h2>
      <ul>
        <li><a href="this-page-does-not-exist.html">Open a missing page</a> to see the error document (404.html).</li>
        <li>Turn Block Public Access back on, then reload this page to see 403 AccessDenied.</li>
      </ul>
    </section>
  </main>
</body>
</html>
`;
  const error = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>404 - Page not found</title>
  <!-- Absolute path so the stylesheet also loads from nested missing paths. -->
  <link rel="stylesheet" href="/s3-web/${bucket}/style.css">
</head>
<body>
  <header>
    <p class="eyebrow">HTTP 404</p>
    <h1>That page is not in the bucket.</h1>
    <p>S3 could not find the requested key, so it returned the configured error document <code>404.html</code> with status 404.</p>
    <p><a href="/s3-web/${bucket}/">Back to the home page</a></p>
  </header>
</body>
</html>
`;
  const style = `:root { color-scheme: light; font-family: system-ui, sans-serif; }
body { max-width: 760px; margin: 0 auto; padding: 48px 20px; background: #f5f7fa; color: #1f2933; line-height: 1.55; }
header { margin-bottom: 28px; }
h1 { margin: 4px 0 12px; font-size: 2rem; }
.eyebrow { margin: 0; color: #c46d00; font-size: .8rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.card { margin-bottom: 16px; padding: 18px 22px; background: #fff; border: 1px solid #d9e2ec; border-radius: 10px; }
code { padding: 1px 5px; background: #eef2f7; border-radius: 4px; }
a { color: #0b69c7; }
`;
  return [
    { key: 'index.html', body: index },
    { key: 'style.css', body: style },
    { key: '404.html', body: error },
  ];
}

export async function uploadSampleSite(bucket) {
  checkBucket(bucket);
  const uploaded = [];
  for (const file of sampleSite(bucket)) {
    // SSE-S3 headers keep the upload valid under the "Deny Unencrypted Object Uploads" preset.
    await call(new PutObjectCommand({
      Bucket: bucket,
      Key: file.key,
      Body: Buffer.from(file.body, 'utf8'),
      ContentType: mime.contentType(file.key) || 'application/octet-stream',
      ServerSideEncryption: 'AES256',
    }));
    uploaded.push(file.key);
  }
  return { uploaded };
}

// ---------------------------------------------------------------------------------------------
// Policy simulator endpoint logic.
// ---------------------------------------------------------------------------------------------

const SIMULATOR_ACTIONS = new Set(['s3:GetObject', 's3:PutObject', 's3:DeleteObject']);

export async function simulatePolicy(bucket, input = {}) {
  checkBucket(bucket);
  const action = String(input.action || 's3:GetObject');
  if (!SIMULATOR_ACTIONS.has(action)) throw new S3SandboxError('Choose s3:GetObject, s3:PutObject, or s3:DeleteObject');
  const key = String(input.key ?? '').trim();
  if (!key) throw new S3SandboxError('Enter an object key to test, such as index.html or public/photo.jpg');
  checkKey(key);
  const headers = input.headers && typeof input.headers === 'object' && !Array.isArray(input.headers) ? input.headers : {};
  const isAnonymous = input.isAnonymous !== false;
  const usingDraft = Object.prototype.hasOwnProperty.call(input, 'policy');
  const policy = usingDraft ? (input.policy || null) : await getPolicy(bucket);
  const result = evaluateBucketPolicy(policy, { bucket, action, key, isAnonymous, headers, principalArn: input.principalArn });
  const outcome = { ...result, policySource: usingDraft ? 'draft' : 'saved' };
  if (isAnonymous && result.allowed) {
    const reason = publicAccessBlockReason(await getPublicAccessBlock(bucket));
    if (reason) {
      return {
        ...outcome,
        allowed: false,
        decision: 'IMPLICIT_DENY',
        blockedBy: 'BlockPublicAccess',
        explanation: `The policy alone would allow this (statement "${result.matchedStatementId}"), but ${reason}. Block Public Access overrides public bucket policies for anonymous callers.`,
      };
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// Lifecycle rules and the accelerated "time-travel" engine.
// ---------------------------------------------------------------------------------------------

/** Simulated days added to the real clock, per bucket. */
export const simulatedDaysOffset = new Map();
// Each jump is recorded as { at: real ms, offsetDays } so objects written mid-simulation (including
// delete markers this engine creates) age from the simulated moment they appeared, not from day 0.
const offsetHistory = new Map();
// Delete markers created by this engine, keyed by "<key>\0<versionId>", with the offset in force
// when they were written. Recorded exactly because several jumps can land in the same second.
const engineMarkerOffsets = new Map();

const versionRef = (key, versionId) => `${key}\u0000${versionId}`;

function offsetAt(bucket, realMs, entry) {
  const known = entry && engineMarkerOffsets.get(bucket)?.get(versionRef(entry.key, entry.versionId));
  if (known !== undefined) return known;
  let offset = 0;
  for (const jump of offsetHistory.get(bucket) || []) if (jump.at <= realMs) offset = jump.offsetDays;
  return offset;
}

/** Whole simulated days between when `entry` was written and the simulated "now". */
function simulatedAge(bucket, entry, nowMs) {
  const eventMs = Date.parse(entry?.lastModified || '');
  if (!Number.isFinite(eventMs)) return 0;
  const simulatedNow = nowMs + (simulatedDaysOffset.get(bucket) || 0) * DAY_MS;
  const simulatedEvent = eventMs + offsetAt(bucket, eventMs, entry) * DAY_MS;
  return Math.max(0, Math.floor((simulatedNow - simulatedEvent) / DAY_MS));
}

export function clockState(bucket, nowMs = Date.now()) {
  const offset = simulatedDaysOffset.get(bucket) || 0;
  return { simulatedDaysOffset: offset, simulatedNow: new Date(nowMs + offset * DAY_MS).toISOString() };
}

export function resetClock(bucket) {
  checkBucket(bucket);
  forgetBucket(bucket);
  return clockState(bucket);
}

export function forgetBucket(bucket) {
  simulatedDaysOffset.delete(bucket);
  offsetHistory.delete(bucket);
  engineMarkerOffsets.delete(bucket);
}

function ruleFilter(rule) {
  const filter = rule.Filter || {};
  const and = filter.And || {};
  return {
    prefix: typeof filter.Prefix === 'string' ? filter.Prefix : typeof and.Prefix === 'string' ? and.Prefix : (rule.Prefix || ''),
    tags: filter.Tag ? [filter.Tag] : (and.Tags || []),
    sizeGreaterThan: filter.ObjectSizeGreaterThan ?? and.ObjectSizeGreaterThan,
    sizeLessThan: filter.ObjectSizeLessThan ?? and.ObjectSizeLessThan,
  };
}

export function describeRule(rule) {
  const filter = ruleFilter(rule);
  return {
    id: rule.ID || '',
    status: rule.Status || 'Disabled',
    prefix: filter.prefix,
    hasTagFilter: filter.tags.length > 0,
    expirationDays: rule.Expiration?.Days ?? null,
    expirationDate: iso(rule.Expiration?.Date),
    noncurrentDays: rule.NoncurrentVersionExpiration?.NoncurrentDays ?? null,
    newerNoncurrentVersions: rule.NoncurrentVersionExpiration?.NewerNoncurrentVersions ?? null,
  };
}

async function getLifecycleRules(bucket) {
  try {
    const output = await call(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
    return output.Rules || [];
  } catch (error) {
    if (error.code === 'NoSuchLifecycleConfiguration') return [];
    throw error;
  }
}

export async function listLifecycle(bucket) {
  checkBucket(bucket);
  return { rules: (await getLifecycleRules(bucket)).map(describeRule), clock: clockState(bucket) };
}

function optionalDays(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 36500) throw new S3SandboxError(`${label} must be a whole number of days from 1 to 36500`);
  return days;
}

export async function saveLifecycleRule(bucket, input = {}) {
  checkBucket(bucket);
  const id = String(input.id ?? '').trim();
  if (!id || id.length > 255) throw new S3SandboxError('Give the rule an ID of 1-255 characters, such as expire-logs');
  const prefix = String(input.prefix ?? '');
  if (Buffer.byteLength(prefix) > 1024) throw new S3SandboxError('The prefix filter must be 1024 bytes or fewer');
  const expirationDays = optionalDays(input.expirationDays, 'Expire current objects after');
  const noncurrentDays = optionalDays(input.noncurrentDays, 'Permanently delete noncurrent versions after');
  if (!expirationDays && !noncurrentDays) throw new S3SandboxError('Set at least one action: expire current objects, or delete noncurrent versions');
  const rule = {
    ID: id,
    Status: 'Enabled',
    Filter: { Prefix: prefix },
    ...(expirationDays ? { Expiration: { Days: expirationDays } } : {}),
    ...(noncurrentDays ? { NoncurrentVersionExpiration: { NoncurrentDays: noncurrentDays } } : {}),
  };
  const rules = (await getLifecycleRules(bucket)).filter((existing) => existing.ID !== id);
  rules.push(rule);
  await call(new PutBucketLifecycleConfigurationCommand({ Bucket: bucket, LifecycleConfiguration: { Rules: rules } }));
  return listLifecycle(bucket);
}

export async function deleteLifecycleRule(bucket, id) {
  checkBucket(bucket);
  const rules = await getLifecycleRules(bucket);
  const remaining = rules.filter((rule) => rule.ID !== id);
  if (remaining.length === rules.length) throw new S3SandboxError(`No lifecycle rule has the ID "${id}"`, 404);
  if (remaining.length) await call(new PutBucketLifecycleConfigurationCommand({ Bucket: bucket, LifecycleConfiguration: { Rules: remaining } }));
  else await call(new DeleteBucketLifecycleCommand({ Bucket: bucket }));
  return listLifecycle(bucket);
}

function ruleApplies(rule, entry) {
  const filter = ruleFilter(rule);
  if (!entry.key.startsWith(filter.prefix)) return false;
  if (filter.sizeGreaterThan !== undefined && !(entry.size > Number(filter.sizeGreaterThan))) return false;
  if (filter.sizeLessThan !== undefined && !(entry.size < Number(filter.sizeLessThan))) return false;
  return true;
}

/**
 * Advance a bucket's simulated clock and apply its Enabled lifecycle rules to every version.
 * Current versions expire when Expiration.Days <= their simulated age. Noncurrent versions are purged
 * when NoncurrentVersionExpiration.NoncurrentDays <= the simulated days since they became noncurrent
 * (that is, since the next newer version or delete marker was written, which is how S3 counts it).
 */
export async function simulateTime(bucket, advanceDays) {
  checkBucket(bucket);
  const days = Number(advanceDays);
  if (!Number.isInteger(days) || days < 0 || days > MAX_ADVANCE_DAYS) throw new S3SandboxError(`advanceDays must be a whole number from 0 to ${MAX_ADVANCE_DAYS}`);

  const rules = await getLifecycleRules(bucket);
  // LastModified has one-second precision, so a write in the same second as a jump counts as written
  // before it. Delete markers created below are tracked exactly in engineMarkerOffsets instead.
  const now = Date.now();
  const offset = (simulatedDaysOffset.get(bucket) || 0) + days;
  if (days > 0) {
    simulatedDaysOffset.set(bucket, offset);
    if (!offsetHistory.has(bucket)) offsetHistory.set(bucket, []);
    offsetHistory.get(bucket).push({ at: now, offsetDays: offset });
  }

  const log = [];
  const notes = [];
  const enabled = rules.filter((rule) => rule.Status === 'Enabled');
  for (const rule of rules) {
    if (rule.Status !== 'Enabled') notes.push(`Rule "${rule.ID}" is ${rule.Status || 'Disabled'}, so it was skipped.`);
    else if (ruleFilter(rule).tags.length) notes.push(`Rule "${rule.ID}" filters on object tags; the time-travel demo evaluates prefix and size filters only, so it was skipped.`);
    if (rule.Transitions?.length || rule.NoncurrentVersionTransitions?.length) notes.push(`Rule "${rule.ID}" has storage-class transitions; the demo simulates expirations only.`);
  }
  const active = enabled.filter((rule) => !ruleFilter(rule).tags.length);
  if (!rules.length) notes.push('This bucket has no lifecycle rules, so nothing expires. Create a rule first.');

  let scanned = 0;
  if (active.length) {
    const { entries, truncated } = await listVersionEntries(bucket);
    scanned = entries.length;
    if (truncated) notes.push(`Only the first ${MAX_VERSIONS_SCANNED} versions were evaluated.`);
    for (const group of groupVersions(entries)) {
      const [current] = group.versions;
      if (current?.isLatest && !current.isDeleteMarker) {
        const age = simulatedAge(bucket, current, now);
        const rule = active.find((candidate) => ruleApplies(candidate, current) && (
          (candidate.Expiration?.Days && candidate.Expiration.Days <= age)
          || (candidate.Expiration?.Date && Date.parse(iso(candidate.Expiration.Date)) <= now + offset * DAY_MS)
        ));
        if (rule) {
          try {
            const output = await call(new DeleteObjectCommand({ Bucket: bucket, Key: current.key }));
            if (output.DeleteMarker) {
              if (!engineMarkerOffsets.has(bucket)) engineMarkerOffsets.set(bucket, new Map());
              engineMarkerOffsets.get(bucket).set(versionRef(current.key, output.VersionId || 'null'), offset);
            }
            log.push({
              ruleId: rule.ID,
              key: current.key,
              versionId: output.DeleteMarker ? (output.VersionId || 'null') : current.versionId,
              action: output.DeleteMarker ? 'DELETE_MARKER_CREATED' : 'DELETED',
              simulatedAgeDays: age,
              thresholdDays: rule.Expiration?.Days ?? null,
            });
          } catch (error) {
            notes.push(`Could not expire ${current.key}: ${error.message}`);
          }
        }
      }

      let noncurrentRank = 0;
      for (let index = 1; index < group.versions.length; index += 1) {
        const version = group.versions[index];
        if (version.isDeleteMarker) continue;
        const rank = noncurrentRank;
        noncurrentRank += 1;
        // A version becomes noncurrent when the next newer version (or delete marker) is written.
        const age = simulatedAge(bucket, group.versions[index - 1], now);
        const rule = active.find((candidate) => {
          const expiration = candidate.NoncurrentVersionExpiration;
          if (!expiration?.NoncurrentDays || !ruleApplies(candidate, version)) return false;
          if (expiration.NewerNoncurrentVersions && rank < expiration.NewerNoncurrentVersions) return false;
          return expiration.NoncurrentDays <= age;
        });
        if (!rule) continue;
        try {
          await call(new DeleteObjectCommand({ Bucket: bucket, Key: version.key, VersionId: version.versionId }));
          log.push({
            ruleId: rule.ID,
            key: version.key,
            versionId: version.versionId,
            action: 'NONCURRENT_PURGED',
            simulatedAgeDays: age,
            thresholdDays: rule.NoncurrentVersionExpiration.NoncurrentDays,
          });
        } catch (error) {
          notes.push(`Could not purge ${version.key} (${version.versionId}): ${error.message}`);
        }
      }
    }
  }
  return { bucket, advancedDays: days, ...clockState(bucket, now), rulesEvaluated: active.length, versionsScanned: scanned, log, notes };
}

// ---------------------------------------------------------------------------------------------
// Static website endpoint: GET /s3-web/:bucketName/*
// ---------------------------------------------------------------------------------------------

const escapeXml = (value) => String(value).replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch]));

function sendXmlError(res, status, code, message, extra = {}, hint = '') {
  const fields = Object.entries(extra).map(([name, value]) => `<${name}>${escapeXml(value)}</${name}>`).join('');
  const requestId = res.getHeader('x-amz-request-id') || '';
  res.status(status);
  res.set('Content-Type', 'application/xml');
  // Header values must be plain ASCII; hints are written that way on purpose.
  if (hint) res.set('X-Learner-Hint', hint.replace(/[^\x20-\x7e]/g, '?'));
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${escapeXml(message)}</Message>${fields}<RequestId>${requestId}</RequestId><HostId>${crypto.randomBytes(24).toString('base64')}</HostId></Error>`);
}

function responseContentType(key, stored) {
  const generic = !stored || /^(application|binary)\/octet-stream$/i.test(stored);
  if (!generic) return stored;
  return mime.contentType(key.split('/').pop() || '') || 'application/octet-stream';
}

async function streamObject(req, res, bucket, key, status) {
  const object = await call(new GetObjectCommand({ Bucket: bucket, Key: key }));
  res.status(status);
  res.set('Content-Type', responseContentType(key, object.ContentType));
  if (object.ContentLength !== undefined) res.set('Content-Length', String(object.ContentLength));
  if (object.ETag) res.set('ETag', object.ETag);
  if (object.LastModified) res.set('Last-Modified', new Date(object.LastModified).toUTCString());
  if (req.method === 'HEAD') {
    object.Body?.destroy?.();
    res.end();
    return;
  }
  pipeline(object.Body, res, () => { /* client disconnects are not errors */ });
}

async function keyExists(bucket, key) {
  try {
    await call(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

function anonymousReadDenial(policy, bucket, key) {
  if (!policy) return `No Bucket Policy grants s3:GetObject to Principal '*'`;
  let decision;
  try { decision = evaluateBucketPolicy(policy, { bucket, action: 's3:GetObject', key, isAnonymous: true }); }
  catch (error) { return `The bucket policy could not be evaluated: ${error.message}`; }
  if (decision.decision === 'EXPLICIT_DENY') return `Bucket policy statement '${decision.matchedStatementId}' explicitly denies s3:GetObject on ${decision.resource}`;
  if (!decision.allowed) return `No Bucket Policy statement grants s3:GetObject to Principal '*' on ${decision.resource}`;
  return '';
}

export async function serveWebsite(req, res) {
  const bucket = req.params.bucketName;
  const rest = req.params[0] || '';
  res.set('x-amz-request-id', crypto.randomBytes(8).toString('hex').toUpperCase());
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.set('Allow', 'GET, HEAD');
    return sendXmlError(res, 405, 'MethodNotAllowed', 'The specified method is not allowed against this resource.', { Method: req.method, ResourceType: 'OBJECT' }, 'Static website endpoints answer only GET and HEAD requests.');
  }
  try { checkBucket(bucket); } catch {
    return sendXmlError(res, 400, 'InvalidBucketName', 'The specified bucket is not valid.', { BucketName: bucket }, 'Bucket names are 3-63 characters: letters, digits, dots, hyphens, and underscores.');
  }

  try {
    let site;
    try { site = await getWebsiteConfig(bucket); } catch (error) {
      if (error.code === 'NoSuchBucket') return sendXmlError(res, 404, 'NoSuchBucket', 'The specified bucket does not exist', { BucketName: bucket }, `No bucket named ${bucket} exists in the emulator.`);
      throw error;
    }
    if (!site.enabled) {
      return sendXmlError(res, 404, 'NoSuchWebsiteConfiguration', 'The specified bucket does not have a website configuration', { BucketName: bucket }, 'Static Website Hosting is disabled for this bucket. Enable it in the Static Website tab.');
    }

    const [publicAccess, policy] = await Promise.all([getPublicAccessBlock(bucket), getPolicy(bucket)]);
    const blockReason = publicAccessBlockReason(publicAccess);
    if (blockReason) return sendXmlError(res, 403, 'AccessDenied', 'Access Denied', {}, blockReason);

    const key = rest === '' || rest.endsWith('/') ? `${rest}${site.indexDocument}` : rest;
    if (Buffer.byteLength(key) > 1024) return sendXmlError(res, 400, 'KeyTooLongError', 'Your key is too long', {}, 'S3 object keys are limited to 1024 bytes.');
    const denial = anonymousReadDenial(policy, bucket, key);
    if (denial) return sendXmlError(res, 403, 'AccessDenied', 'Access Denied', {}, denial);

    try {
      return await streamObject(req, res, bucket, key, 200);
    } catch (error) {
      if (error.code !== 'NoSuchKey' && error.status !== 404) throw error;
    }

    // Like S3, "/about" redirects to "/about/" when "about/<index document>" exists.
    if (rest && !rest.endsWith('/') && await keyExists(bucket, `${rest}/${site.indexDocument}`)) {
      return res.redirect(302, `/s3-web/${encodeURIComponent(bucket)}/${rest.split('/').map(encodeURIComponent).join('/')}/`);
    }
    if (site.errorDocument && !anonymousReadDenial(policy, bucket, site.errorDocument) && await keyExists(bucket, site.errorDocument)) {
      return await streamObject(req, res, bucket, site.errorDocument, 404);
    }
    const hint = site.errorDocument
      ? `The key does not exist, and the error document ${site.errorDocument} is missing or not publicly readable.`
      : 'The key does not exist. Configure an Error Document to show a friendly 404 page.';
    return sendXmlError(res, 404, 'NoSuchKey', 'The specified key does not exist.', { Key: key, BucketName: bucket }, hint);
  } catch (error) {
    if (res.headersSent) { res.destroy(error); return undefined; }
    if (error.code === 'EmulatorUnavailable') return sendXmlError(res, 503, 'ServiceUnavailable', 'Please reduce your request rate.', {}, 'The AWS Emulator is not reachable. Start it from the dashboard.');
    console.error(`S3 website endpoint: ${error.message}`);
    return sendXmlError(res, 500, 'InternalError', 'We encountered an internal error. Please try again.', {}, error.message);
  }
}

/** A separate loopback-only app (its own origin) that serves bucket websites. */
export function createWebsiteApp({ port = config.websitePort } = {}) {
  const app = express();
  app.disable('x-powered-by');
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  app.use((req, res, next) => {
    if (!allowedHosts.has(String(req.headers.host).toLowerCase())) return res.status(403).type('text/plain').send('Forbidden host');
    next();
  });
  app.get('/', (_req, res) => res.type('text/plain').send('S3 Learning Sandbox website endpoint. Open /s3-web/<bucket-name>/'));
  app.all('/s3-web/:bucketName/*', serveWebsite);
  app.all('/s3-web/:bucketName', (req, res) => res.redirect(302, `/s3-web/${encodeURIComponent(req.params.bucketName)}/`));
  return app;
}
