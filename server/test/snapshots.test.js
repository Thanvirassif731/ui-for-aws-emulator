import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  exportSnapshot,
  importSnapshot,
  MAX_S3_OBJECT_BYTES,
  SnapshotValidationError,
  validateSnapshot,
} from '../snapshots.js';

function snapshot(overrides = {}) {
  return {
    version: '1.0',
    exportedAt: '2025-01-01T00:00:00.000Z',
    services: { s3: [], dynamodb: [], sqs: [], ...overrides },
  };
}

const emptyS3 = {
  listBuckets: async () => [],
  createBucket: async () => {},
  putObject: async () => {},
};

test('snapshot schema rejects invalid versions and malformed service payloads', () => {
  assert.throws(() => validateSnapshot({}), SnapshotValidationError);
  assert.throws(() => validateSnapshot({ ...snapshot(), version: '2.0' }), /version must be "1.0"/);
  assert.throws(() => validateSnapshot({ ...snapshot(), services: { s3: [], dynamodb: [] } }), /services.sqs must be an array/);
  assert.throws(() => validateSnapshot(snapshot({ s3: [{ name: 'bucket', objects: [{ key: 'x', contentType: 'text/plain', dataBase64: '*' }] }] })), /base64/);
  assert.throws(() => validateSnapshot(snapshot({ dynamodb: [{ name: 'table', keySchema: [{}], attributeDefinitions: [], billingMode: 'PAY_PER_REQUEST', globalSecondaryIndexes: [], items: [] }] })), /AttributeName/);
  assert.throws(() => validateSnapshot(snapshot({ dynamodb: [{ name: 'table', keySchema: [{ AttributeName: 'id', KeyType: 'HASH' }], attributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }], billingMode: 'INVALID', globalSecondaryIndexes: [], items: [] }] })), /billingMode/);
  assert.throws(() => validateSnapshot(snapshot({ dynamodb: [{ name: 'table', keySchema: [{ AttributeName: 'id', KeyType: 'HASH' }], attributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }], billingMode: 'PAY_PER_REQUEST', globalSecondaryIndexes: [], items: [{ id: { bogus: 'x' } }] }] })), /AttributeValue type/);
  assert.throws(() => validateSnapshot(snapshot({ sqs: [{ name: 'queue', attributes: { VisibilityTimeout: 30 }, messages: [] }] })), /attributes.VisibilityTimeout/);
});

test('snapshot import chunks DynamoDB writes at 25 items', async () => {
  const sizes = [];
  const dynamodbCall = async (operation, input) => {
    if (operation === 'ListTables') return { TableNames: [] };
    if (operation === 'CreateTable') return { TableDescription: { TableStatus: 'ACTIVE' } };
    if (operation === 'BatchWriteItem') {
      sizes.push(input.RequestItems.table.length);
      return { UnprocessedItems: {} };
    }
    throw new Error(`Unexpected DynamoDB operation ${operation}`);
  };
  const summary = await importSnapshot(snapshot({
    dynamodb: [{
      name: 'table',
      keySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      attributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
      billingMode: 'PAY_PER_REQUEST',
      globalSecondaryIndexes: [],
      items: Array.from({ length: 53 }, (_, index) => ({ id: { S: String(index) } })),
    }],
  }), {
    clients: {
      s3: emptyS3,
      dynamodbCall,
      sqsCall: async (operation) => operation === 'ListQueues' ? { QueueUrls: [] } : {},
    },
  });
  assert.deepEqual(sizes, [25, 25, 3]);
  assert.equal(summary.dynamodb.items, 53);
});

test('snapshot import chunks SQS batches at 10 messages', async () => {
  const sizes = [];
  const sqsCall = async (operation, input) => {
    if (operation === 'ListQueues') return { QueueUrls: [] };
    if (operation === 'CreateQueue') return { QueueUrl: 'https://127.0.0.1/000000000000/queue' };
    if (operation === 'SendMessageBatch') {
      sizes.push(input.Entries.length);
      return { Successful: input.Entries.map(({ Id }) => ({ Id })) };
    }
    throw new Error(`Unexpected SQS operation ${operation}`);
  };
  const summary = await importSnapshot(snapshot({
    sqs: [{
      name: 'queue',
      attributes: { VisibilityTimeout: '30' },
      messages: Array.from({ length: 23 }, (_, index) => ({ body: `message ${index}` })),
    }],
  }), {
    clients: {
      s3: emptyS3,
      dynamodbCall: async (operation) => operation === 'ListTables' ? { TableNames: [] } : {},
      sqsCall,
    },
  });
  assert.deepEqual(sizes, [10, 10, 3]);
  assert.equal(summary.sqs.messages, 23);
});

test('snapshot export skips S3 objects larger than 16 MiB without downloading them', async () => {
  let downloads = 0;
  const result = await exportSnapshot({ clients: {
    s3: {
      listBuckets: async () => [{ name: 'bucket' }],
      listObjects: async () => ({
        objects: [{ key: 'large.bin', size: MAX_S3_OBJECT_BYTES + 1 }],
        truncated: false,
        nextToken: null,
      }),
      getObject: async () => { downloads += 1; throw new Error('must not download'); },
    },
    dynamodbCall: async (operation) => operation === 'ListTables' ? { TableNames: [] } : {},
    sqsCall: async (operation) => operation === 'ListQueues' ? { QueueUrls: [] } : {},
  } });
  assert.equal(downloads, 0);
  assert.deepEqual(result.services.s3[0].objects, []);
  assert.match(result.warnings[0].message, /16 MiB/);
});
