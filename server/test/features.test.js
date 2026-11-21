import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { config } from '../config.js';
import { getIndex } from '../models.js';
import { buildRequest, serializeXml } from '../requests.js';
import { clearTraffic, createTrafficProxy, listTraffic } from '../traffic.js';

const find = (needle) => [...getIndex().keys()].find((key) => key.includes(needle));

test('default model path resolves to the documented sibling checkout', () => {
  if (process.env.EMULATOR_REPO) return;
  assert.equal(path.basename(config.repoRoot), 'aws-emulator');
  assert.ok(fs.existsSync(path.join(config.repoRoot, 'services')));
});

test('restXml serializes structure payloads, flattened lists, namespaces, and escaping', () => {
  const serviceId = find('s3-amazons3');
  const request = buildRequest({
    serviceId,
    operation: 'DeleteObjects',
    input: {
      Bucket: 'bucket',
      Delete: { Objects: [{ Key: 'one&two' }, { Key: '<three>' }], Quiet: true },
    },
  });
  assert.equal(request.headers['Content-Type'], 'application/xml');
  assert.equal(request.body, '<Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Object><Key>one&amp;two</Key></Object><Object><Key>&lt;three&gt;</Key></Object><Quiet>true</Quiet></Delete>');
});

test('restXml serializes nested list wrappers', () => {
  const serviceId = find('s3-amazons3');
  const request = buildRequest({
    serviceId,
    operation: 'PutBucketTagging',
    input: { Bucket: 'bucket', Tagging: { TagSet: [{ Key: 'environment', Value: 'test' }] } },
  });
  assert.equal(request.body, '<Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet><Tag><Key>environment</Key><Value>test</Value></Tag></TagSet></Tagging>');
});

test('restXml body override remains authoritative', () => {
  const serviceId = find('s3-amazons3');
  const request = buildRequest({
    serviceId,
    operation: 'DeleteObjects',
    input: { Bucket: 'bucket', Delete: { Objects: [{ Key: 'ignored' }] } },
    bodyOverride: '<Custom />',
  });
  assert.equal(request.body, '<Custom />');
});

test('XML serializer covers attributes, maps, blobs, and epoch timestamps', () => {
  const model = { shapes: {
    'test#Root': { type: 'structure', traits: { 'smithy.api#xmlName': 'Envelope' }, members: {
      Version: { target: 'smithy.api#String', traits: { 'smithy.api#xmlAttribute': {}, 'smithy.api#xmlName': 'version' } },
      Items: { target: 'test#Items', traits: { 'smithy.api#xmlFlattened': {}, 'smithy.api#xmlName': 'Item' } },
      Metadata: { target: 'test#Metadata' },
      At: { target: 'smithy.api#Timestamp', traits: { 'smithy.api#timestampFormat': 'epoch-seconds' } },
    } },
    'test#Items': { type: 'list', member: { target: 'test#Item' } },
    'test#Item': { type: 'structure', members: { Name: { target: 'smithy.api#String' }, Data: { target: 'test#Blob' } } },
    'test#Blob': { type: 'blob' },
    'test#Metadata': { type: 'map', key: { target: 'smithy.api#String' }, value: { target: 'smithy.api#String' } },
    'smithy.api#String': { type: 'string' },
    'smithy.api#Timestamp': { type: 'timestamp' },
  } };
  const xml = serializeXml(model, 'test#Root', {
    Version: '1', Items: [{ Name: 'first', Data: 'hi' }], Metadata: { environment: 'test' }, At: 12.5,
  }, 'Root', { uri: 'urn:test' });
  assert.equal(xml, '<Envelope xmlns="urn:test" version="1"><Item><Name>first</Name><Data>aGk=</Data></Item><Metadata><entry><key>environment</key><value>test</value></entry></Metadata><At>12.5</At></Envelope>');
});

test('traffic proxy is loopback-compatible and redacts credentials in captures', async () => {
  const previousHome = config.emulatorHome;
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'emulator-ui-test-'));
  config.emulatorHome = emptyHome;
  clearTraffic();
  const server = createTrafficProxy();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/`, {
      headers: { Authorization: 'secret-value', 'X-Amz-Target': 'DynamoDB_20120810.ListTables' },
    });
    assert.equal(response.status, 502);
    const [capture] = listTraffic();
    assert.equal(capture.service, 'DynamoDB_20120810');
    assert.equal(capture.requestHeaders.authorization, '[redacted]');
    assert.equal(capture.status, 502);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    config.emulatorHome = previousHome;
    fs.rmSync(emptyHome, { recursive: true, force: true });
    clearTraffic();
  }
});
