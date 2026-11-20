import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeOperation, getIndex, listOperations } from '../models.js';
import { buildRequest, BuildError } from '../requests.js';

const find = (needle) => [...getIndex().keys()].find((k) => k.includes(needle));

test('index covers every service model', () => {
  assert.ok(getIndex().size > 400);
});

test('awsJson: DynamoDB ListTables', () => {
  const id = find('dynamodb-dynamodb-2012');
  const r = buildRequest({ serviceId: id, operation: 'ListTables', input: { Limit: 5 } });
  assert.equal(r.method, 'POST');
  assert.equal(r.path, '/');
  assert.equal(r.headers['X-Amz-Target'], 'DynamoDB_20120810.ListTables');
  assert.equal(r.headers['Content-Type'], 'application/x-amz-json-1.0');
  assert.equal(r.body, '{"Limit":5}');
  assert.equal(r.signingName, 'dynamodb');
});

test('awsQuery: STS GetCallerIdentity', () => {
  const id = find('sts-awssecuritytokenservice');
  const r = buildRequest({ serviceId: id, operation: 'GetCallerIdentity', input: {} });
  assert.equal(r.body, 'Action=GetCallerIdentity&Version=2011-06-15');
});

test('awsQuery: nested lists are flattened', () => {
  const id = find('sts-awssecuritytokenservice');
  const r = buildRequest({
    serviceId: id,
    operation: 'AssumeRole',
    input: { RoleArn: 'arn:aws:iam::000000000000:role/r', RoleSessionName: 's', PolicyArns: [{ arn: 'a' }, { arn: 'b' }] },
  });
  const params = new URLSearchParams(r.body);
  assert.equal(params.get('PolicyArns.member.1.arn'), 'a');
  assert.equal(params.get('PolicyArns.member.2.arn'), 'b');
  assert.equal(params.get('RoleSessionName'), 's');
});

test('ec2Query: capitalised names and flattened lists', () => {
  const id = find('ec2-amazonec2');
  const r = buildRequest({ serviceId: id, operation: 'DescribeInstances', input: { InstanceIds: ['i-1', 'i-2'] } });
  const params = new URLSearchParams(r.body);
  assert.equal(params.get('Action'), 'DescribeInstances');
  assert.equal(params.get('InstanceId.1'), 'i-1');
  assert.equal(params.get('InstanceId.2'), 'i-2');
});

test('restXml: S3 ListObjectsV2 binds path, query and headers', () => {
  const id = find('s3-amazons3');
  const r = buildRequest({ serviceId: id, operation: 'ListObjectsV2', input: { Bucket: 'my-bucket', Prefix: 'a b/' } });
  assert.equal(r.method, 'GET');
  assert.equal(r.path, '/my-bucket');
  assert.equal(r.query['list-type'], '2');
  assert.equal(r.query.prefix, 'a b/');
  assert.equal(r.body, '');
});

test('restXml: greedy label keeps slashes', () => {
  const id = find('s3-amazons3');
  const r = buildRequest({ serviceId: id, operation: 'GetObject', input: { Bucket: 'b', Key: 'dir/file name.txt' } });
  assert.equal(r.path, '/b/dir/file%20name.txt');
});

test('restJson: body members go to JSON body, labels to path', () => {
  const id = find('lambda-awsgirapiservice');
  assert.ok(id, 'lambda model present');
  const ops = listOperations(id).map((o) => o.name);
  assert.ok(ops.includes('CreateFunction'));
  const r = buildRequest({ serviceId: id, operation: 'GetFunction', input: { FunctionName: 'fn' } });
  assert.equal(r.method, 'GET');
  assert.match(r.path, /\/functions\/fn$/);
});

test('errors: missing label and unknown member', () => {
  const id = find('s3-amazons3');
  assert.throws(() => buildRequest({ serviceId: id, operation: 'GetObject', input: { Bucket: 'b' } }), BuildError);
  assert.throws(() => buildRequest({ serviceId: id, operation: 'GetObject', input: { Nope: 1 } }), BuildError);
  assert.throws(() => buildRequest({ serviceId: id, operation: 'NoSuchOp', input: {} }), BuildError);
});

test('describeOperation: skeleton contains required members', () => {
  const id = find('dynamodb-dynamodb-2012');
  const d = describeOperation(id, 'GetItem');
  assert.ok('TableName' in d.skeleton);
  assert.ok('Key' in d.skeleton);
  assert.ok(d.members.find((m) => m.name === 'TableName').required);
});
