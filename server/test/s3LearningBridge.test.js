import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  S3SandboxError,
  evaluateBucketPolicy,
  groupVersions,
  parsePolicy,
  publicAccessBlockReason,
} from '../s3LearningBridge.js';

const bucket = 'learn-bucket';
const publicRead = {
  Version: '2012-10-17',
  Statement: [{ Sid: 'PublicReadGetObject', Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: `arn:aws:s3:::${bucket}/*` }],
};
const denyUnencrypted = {
  Version: '2012-10-17',
  Statement: [{
    Sid: 'DenyUnencryptedObjectUploads',
    Effect: 'Deny',
    Principal: '*',
    Action: 's3:PutObject',
    Resource: `arn:aws:s3:::${bucket}/*`,
    Condition: { StringNotEquals: { 's3:x-amz-server-side-encryption': 'AES256' } },
  }],
};

test('public read policy allows anonymous GetObject and nothing else', () => {
  const allowed = evaluateBucketPolicy(publicRead, { bucket, action: 's3:GetObject', key: 'index.html', isAnonymous: true });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.decision, 'ALLOWED');
  assert.equal(allowed.matchedStatementId, 'PublicReadGetObject');

  const put = evaluateBucketPolicy(publicRead, { bucket, action: 's3:PutObject', key: 'index.html', isAnonymous: true });
  assert.equal(put.decision, 'IMPLICIT_DENY');
  assert.equal(put.allowed, false);
});

test('missing policy is an implicit deny', () => {
  const result = evaluateBucketPolicy(null, { bucket, action: 's3:GetObject', key: 'a.txt', isAnonymous: true });
  assert.equal(result.decision, 'IMPLICIT_DENY');
  assert.match(result.explanation, /no bucket policy/);
});

test('explicit deny overrides an allow in the same policy', () => {
  const policy = { Version: '2012-10-17', Statement: [
    { Sid: 'AllowAll', Effect: 'Allow', Principal: '*', Action: 's3:*', Resource: `arn:aws:s3:::${bucket}/*` },
    { Sid: 'DenySecrets', Effect: 'Deny', Principal: '*', Action: 's3:GetObject', Resource: `arn:aws:s3:::${bucket}/secret/*` },
  ] };
  const secret = evaluateBucketPolicy(policy, { bucket, action: 's3:GetObject', key: 'secret/key.pem', isAnonymous: true });
  assert.equal(secret.decision, 'EXPLICIT_DENY');
  assert.equal(secret.matchedStatementId, 'DenySecrets');
  const other = evaluateBucketPolicy(policy, { bucket, action: 's3:getobject', key: 'public/a.png', isAnonymous: true });
  assert.equal(other.decision, 'ALLOWED', 'actions match case-insensitively and s3:* covers GetObject');
});

test('StringNotEquals denies missing and wrong encryption headers but not AES256', () => {
  const base = { bucket, action: 's3:PutObject', key: 'a.txt', isAnonymous: false };
  assert.equal(evaluateBucketPolicy(denyUnencrypted, base).decision, 'EXPLICIT_DENY');
  assert.equal(evaluateBucketPolicy(denyUnencrypted, { ...base, headers: { 'X-Amz-Server-Side-Encryption': 'aws:kms' } }).decision, 'EXPLICIT_DENY');
  assert.equal(evaluateBucketPolicy(denyUnencrypted, { ...base, headers: { 'x-amz-server-side-encryption': 'AES256' } }).decision, 'IMPLICIT_DENY');
});

test('prefix resources and IfExists / Null conditions follow IAM semantics', () => {
  const prefixPolicy = { Version: '2012-10-17', Statement: [{ Sid: 'Public', Effect: 'Allow', Principal: { AWS: '*' }, Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${bucket}/public/*`] }] };
  assert.equal(evaluateBucketPolicy(prefixPolicy, { bucket, action: 's3:GetObject', key: 'public/cat.jpg', isAnonymous: true }).allowed, true);
  assert.equal(evaluateBucketPolicy(prefixPolicy, { bucket, action: 's3:GetObject', key: 'private/cat.jpg', isAnonymous: true }).allowed, false);

  const conditional = (Condition) => ({ Version: '2012-10-17', Statement: [{ Sid: 'C', Effect: 'Allow', Principal: '*', Action: 's3:PutObject', Resource: '*', Condition }] });
  const request = { bucket, action: 's3:PutObject', key: 'a', isAnonymous: true };
  assert.equal(evaluateBucketPolicy(conditional({ StringEqualsIfExists: { 's3:x-amz-acl': 'private' } }), request).allowed, true);
  assert.equal(evaluateBucketPolicy(conditional({ StringEquals: { 's3:x-amz-acl': 'private' } }), request).allowed, false);
  assert.equal(evaluateBucketPolicy(conditional({ Null: { 's3:x-amz-acl': 'true' } }), request).allowed, true);
});

test('specific principals do not match anonymous callers', () => {
  const policy = { Version: '2012-10-17', Statement: [{ Sid: 'Student', Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::123456789012:user/student' }, Action: 's3:GetObject', Resource: `arn:aws:s3:::${bucket}/*` }] };
  assert.equal(evaluateBucketPolicy(policy, { bucket, action: 's3:GetObject', key: 'a', isAnonymous: true }).allowed, false);
  assert.equal(evaluateBucketPolicy(policy, { bucket, action: 's3:GetObject', key: 'a', isAnonymous: false }).allowed, true);
});

test('unsupported condition operators are reported, never silently allowed', () => {
  const policy = { Version: '2012-10-17', Statement: [{ Sid: 'Ip', Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: '*', Condition: { IpAddress: { 'aws:SourceIp': '10.0.0.0/8' } } }] };
  const result = evaluateBucketPolicy(policy, { bucket, action: 's3:GetObject', key: 'a', isAnonymous: true });
  assert.equal(result.allowed, false);
  assert.match(result.warnings[0], /IpAddress/);
});

test('policy parsing gives beginner-friendly errors', () => {
  assert.throws(() => parsePolicy('{"Version":'), (e) => e instanceof S3SandboxError && /not valid JSON/.test(e.message));
  assert.throws(() => parsePolicy({ Version: '2012-10-17' }), /Statement/);
  assert.throws(() => parsePolicy({ Statement: [{ Effect: 'allow', Action: 's3:GetObject', Resource: '*' }] }), /case-sensitive/);
  assert.equal(parsePolicy({ Statement: { Effect: 'Allow', Action: 's3:GetObject', Resource: '*' } }).Statement.length, 1);
});

test('Block Public Access reasons cover the two website-blocking settings', () => {
  assert.equal(publicAccessBlockReason({ BlockPublicAcls: true, IgnorePublicAcls: true }), '');
  assert.match(publicAccessBlockReason({ BlockPublicPolicy: true }), /BlockPublicPolicy/);
  assert.match(publicAccessBlockReason({ RestrictPublicBuckets: true }), /RestrictPublicBuckets/);
});

test('version groups put the current version first, then newest to oldest', () => {
  const groups = groupVersions([
    { key: 'b.txt', versionId: 'old', isLatest: false, isDeleteMarker: false, lastModified: '2026-01-01T00:00:00Z' },
    { key: 'a.txt', versionId: 'only', isLatest: true, isDeleteMarker: false, lastModified: '2026-01-01T00:00:00Z' },
    { key: 'b.txt', versionId: 'mid', isLatest: false, isDeleteMarker: false, lastModified: '2026-02-01T00:00:00Z' },
    { key: 'b.txt', versionId: 'marker', isLatest: true, isDeleteMarker: true, lastModified: '2026-03-01T00:00:00Z' },
  ]);
  assert.deepEqual(groups.map((group) => group.key), ['a.txt', 'b.txt']);
  assert.deepEqual(groups[1].versions.map((version) => version.versionId), ['marker', 'mid', 'old']);
  assert.equal(groups[1].deleted, true);
  assert.equal(groups[0].deleted, false);
});
