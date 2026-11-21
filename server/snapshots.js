import { awsJsonCall } from './aws-json.js';
import { config } from './config.js';
import * as s3Client from './s3.js';

export const SNAPSHOT_VERSION = '1.0';
export const MAX_S3_OBJECT_BYTES = 16 * 1024 * 1024;

export class SnapshotValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const dynamodbCall = (operation, input = {}) => awsJsonCall({
  signingName: 'dynamodb',
  target: `DynamoDB_20120810.${operation}`,
  input,
});
const sqsCall = (operation, input = {}) => awsJsonCall({
  signingName: 'sqs',
  target: `AmazonSQS.${operation}`,
  input,
});

function clients(overrides = {}) {
  return {
    s3: overrides.s3 || s3Client,
    dynamodbCall: overrides.dynamodbCall || dynamodbCall,
    sqsCall: overrides.sqsCall || sqsCall,
  };
}

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const requireString = (value, path, { empty = false } = {}) => {
  if (typeof value !== 'string' || (!empty && !value)) throw new SnapshotValidationError(`${path} must be ${empty ? 'a string' : 'a non-empty string'}`);
};
const requireArray = (value, path) => {
  if (!Array.isArray(value)) throw new SnapshotValidationError(`${path} must be an array`);
};

function validateBase64(value, path) {
  requireString(value, path, { empty: true });
  if (value && (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))) {
    throw new SnapshotValidationError(`${path} must contain base64 data`);
  }
}

function validateAttributeValue(value, path) {
  if (!isObject(value)) throw new SnapshotValidationError(`${path} must be an AttributeValue object`);
  const keys = Object.keys(value);
  const allowed = new Set(['B', 'BOOL', 'BS', 'L', 'M', 'N', 'NS', 'NULL', 'S', 'SS']);
  if (keys.length !== 1 || !allowed.has(keys[0])) throw new SnapshotValidationError(`${path} must contain exactly one valid AttributeValue type`);
  const type = keys[0];
  const item = value[type];
  if (['B', 'N', 'S'].includes(type) && typeof item !== 'string') throw new SnapshotValidationError(`${path}.${type} must be a string`);
  if (type === 'B') validateBase64(item, `${path}.B`);
  if (type === 'N' && !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?$/.test(item)) throw new SnapshotValidationError(`${path}.N must be a number string`);
  if (type === 'BOOL' && typeof item !== 'boolean') throw new SnapshotValidationError(`${path}.BOOL must be a boolean`);
  if (type === 'NULL' && item !== true) throw new SnapshotValidationError(`${path}.NULL must be true`);
  if (['BS', 'NS', 'SS'].includes(type) && (!Array.isArray(item) || item.some((entry) => typeof entry !== 'string'))) {
    throw new SnapshotValidationError(`${path}.${type} must be an array of strings`);
  }
  if (type === 'BS') item.forEach((entry, index) => validateBase64(entry, `${path}.BS[${index}]`));
  if (type === 'NS' && item.some((entry) => !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?$/.test(entry))) {
    throw new SnapshotValidationError(`${path}.NS must contain number strings`);
  }
  if (type === 'L') {
    requireArray(item, `${path}.L`);
    item.forEach((entry, index) => validateAttributeValue(entry, `${path}.L[${index}]`));
  }
  if (type === 'M') {
    if (!isObject(item)) throw new SnapshotValidationError(`${path}.M must be an object`);
    for (const [name, entry] of Object.entries(item)) validateAttributeValue(entry, `${path}.M.${name}`);
  }
}

function validateKeySchema(schema, path) {
  requireArray(schema, path);
  let hashes = 0;
  let ranges = 0;
  schema.forEach((key, index) => {
    if (!isObject(key)) throw new SnapshotValidationError(`${path}[${index}] must be an object`);
    requireString(key.AttributeName, `${path}[${index}].AttributeName`);
    if (key.KeyType === 'HASH') hashes += 1;
    else if (key.KeyType === 'RANGE') ranges += 1;
    else throw new SnapshotValidationError(`${path}[${index}].KeyType is invalid`);
  });
  if (hashes !== 1 || ranges > 1) throw new SnapshotValidationError(`${path} must contain one HASH key and at most one RANGE key`);
}

function validateMessageAttributes(attributes, path) {
  if (!isObject(attributes)) throw new SnapshotValidationError(`${path} must be an object`);
  for (const [name, attribute] of Object.entries(attributes)) {
    if (!isObject(attribute)) throw new SnapshotValidationError(`${path}.${name} must be an object`);
    requireString(attribute.DataType, `${path}.${name}.DataType`);
    if (attribute.StringValue !== undefined && typeof attribute.StringValue !== 'string') throw new SnapshotValidationError(`${path}.${name}.StringValue must be a string`);
    if (attribute.BinaryValue !== undefined) validateBase64(attribute.BinaryValue, `${path}.${name}.BinaryValue`);
  }
}

/** Validate and return a version 1.0 snapshot. */
export function validateSnapshot(snapshot) {
  if (!isObject(snapshot)) throw new SnapshotValidationError('snapshot must be an object');
  if (snapshot.version !== SNAPSHOT_VERSION) throw new SnapshotValidationError(`snapshot.version must be "${SNAPSHOT_VERSION}"`);
  requireString(snapshot.exportedAt, 'snapshot.exportedAt');
  if (!Number.isFinite(Date.parse(snapshot.exportedAt))) throw new SnapshotValidationError('snapshot.exportedAt must be an ISO date');
  if (!isObject(snapshot.services)) throw new SnapshotValidationError('snapshot.services must be an object');

  for (const service of ['s3', 'dynamodb', 'sqs']) requireArray(snapshot.services[service], `snapshot.services.${service}`);

  const bucketNames = new Set();
  snapshot.services.s3.forEach((bucket, bucketIndex) => {
    const root = `snapshot.services.s3[${bucketIndex}]`;
    if (!isObject(bucket)) throw new SnapshotValidationError(`${root} must be an object`);
    requireString(bucket.name, `${root}.name`);
    try { s3Client.checkBucket(bucket.name); } catch { throw new SnapshotValidationError(`${root}.name is invalid`); }
    if (bucketNames.has(bucket.name)) throw new SnapshotValidationError(`snapshot.services.s3 contains duplicate bucket names`);
    bucketNames.add(bucket.name);
    requireArray(bucket.objects, `${root}.objects`);
    const objectKeys = new Set();
    bucket.objects.forEach((object, objectIndex) => {
      const item = `${root}.objects[${objectIndex}]`;
      if (!isObject(object)) throw new SnapshotValidationError(`${item} must be an object`);
      requireString(object.key, `${item}.key`);
      try { s3Client.checkKey(object.key); } catch { throw new SnapshotValidationError(`${item}.key is invalid`); }
      if (objectKeys.has(object.key)) throw new SnapshotValidationError(`${root}.objects contains duplicate keys`);
      objectKeys.add(object.key);
      requireString(object.contentType, `${item}.contentType`);
      if (/[\r\n]/.test(object.contentType)) throw new SnapshotValidationError(`${item}.contentType is invalid`);
      validateBase64(object.dataBase64, `${item}.dataBase64`);
    });
  });

  const tableNames = new Set();
  snapshot.services.dynamodb.forEach((table, tableIndex) => {
    const root = `snapshot.services.dynamodb[${tableIndex}]`;
    if (!isObject(table)) throw new SnapshotValidationError(`${root} must be an object`);
    requireString(table.name, `${root}.name`);
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(table.name)) throw new SnapshotValidationError(`${root}.name is invalid`);
    if (tableNames.has(table.name)) throw new SnapshotValidationError(`snapshot.services.dynamodb contains duplicate table names`);
    tableNames.add(table.name);
    validateKeySchema(table.keySchema, `${root}.keySchema`);
    requireArray(table.attributeDefinitions, `${root}.attributeDefinitions`);
    const definitions = new Set();
    table.attributeDefinitions.forEach((definition, definitionIndex) => {
      const item = `${root}.attributeDefinitions[${definitionIndex}]`;
      if (!isObject(definition)) throw new SnapshotValidationError(`${item} must be an object`);
      requireString(definition.AttributeName, `${item}.AttributeName`);
      if (!['S', 'N', 'B'].includes(definition.AttributeType)) throw new SnapshotValidationError(`${item}.AttributeType is invalid`);
      if (definitions.has(definition.AttributeName)) throw new SnapshotValidationError(`${root}.attributeDefinitions contains duplicate names`);
      definitions.add(definition.AttributeName);
    });
    if (!['PAY_PER_REQUEST', 'PROVISIONED'].includes(table.billingMode)) throw new SnapshotValidationError(`${root}.billingMode is invalid`);
    requireArray(table.globalSecondaryIndexes, `${root}.globalSecondaryIndexes`);
    const indexNames = new Set();
    table.globalSecondaryIndexes.forEach((index, indexNumber) => {
      const item = `${root}.globalSecondaryIndexes[${indexNumber}]`;
      if (!isObject(index)) throw new SnapshotValidationError(`${item} must be an object`);
      requireString(index.IndexName, `${item}.IndexName`);
      if (!/^[A-Za-z0-9_.-]{3,255}$/.test(index.IndexName) || indexNames.has(index.IndexName)) throw new SnapshotValidationError(`${item}.IndexName is invalid or duplicated`);
      indexNames.add(index.IndexName);
      validateKeySchema(index.KeySchema, `${item}.KeySchema`);
      if (!isObject(index.Projection) || !['ALL', 'KEYS_ONLY', 'INCLUDE'].includes(index.Projection.ProjectionType)) {
        throw new SnapshotValidationError(`${item}.Projection is invalid`);
      }
      if (index.Projection.NonKeyAttributes !== undefined && (!Array.isArray(index.Projection.NonKeyAttributes) || index.Projection.NonKeyAttributes.some((name) => typeof name !== 'string'))) {
        throw new SnapshotValidationError(`${item}.Projection.NonKeyAttributes must be an array of strings`);
      }
    });
    const usedKeys = [...table.keySchema, ...table.globalSecondaryIndexes.flatMap((index) => index.KeySchema)].map((key) => key.AttributeName);
    if (usedKeys.some((name) => !definitions.has(name))) throw new SnapshotValidationError(`${root}.attributeDefinitions must cover every table and index key`);
    requireArray(table.items, `${root}.items`);
    table.items.forEach((item, itemIndex) => {
      if (!isObject(item)) throw new SnapshotValidationError(`${root}.items[${itemIndex}] must be an AttributeValue map`);
      for (const [name, value] of Object.entries(item)) validateAttributeValue(value, `${root}.items[${itemIndex}].${name}`);
    });
  });

  const queueNames = new Set();
  snapshot.services.sqs.forEach((queue, queueIndex) => {
    const root = `snapshot.services.sqs[${queueIndex}]`;
    if (!isObject(queue)) throw new SnapshotValidationError(`${root} must be an object`);
    requireString(queue.name, `${root}.name`);
    if (!/^[A-Za-z0-9_-]{1,80}(?:\.fifo)?$/.test(queue.name) || queue.name.length > 80) throw new SnapshotValidationError(`${root}.name is invalid`);
    if (queueNames.has(queue.name)) throw new SnapshotValidationError(`snapshot.services.sqs contains duplicate queue names`);
    queueNames.add(queue.name);
    if (!isObject(queue.attributes)) throw new SnapshotValidationError(`${root}.attributes must be an object`);
    const allowedAttributes = new Map([['VisibilityTimeout', 43200], ['DelaySeconds', 900], ['ReceiveMessageWaitTimeSeconds', 20]]);
    for (const [name, value] of Object.entries(queue.attributes)) {
      const maximum = allowedAttributes.get(name);
      if (maximum === undefined || typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) > maximum) {
        throw new SnapshotValidationError(`${root}.attributes.${name} is invalid`);
      }
    }
    requireArray(queue.messages, `${root}.messages`);
    queue.messages.forEach((message, messageIndex) => {
      const item = `${root}.messages[${messageIndex}]`;
      if (!isObject(message)) throw new SnapshotValidationError(`${item} must be an object`);
      requireString(message.body, `${item}.body`);
      if (message.messageAttributes !== undefined) validateMessageAttributes(message.messageAttributes, `${item}.messageAttributes`);
      if (message.messageGroupId !== undefined) requireString(message.messageGroupId, `${item}.messageGroupId`);
      if (message.messageDeduplicationId !== undefined) requireString(message.messageDeduplicationId, `${item}.messageDeduplicationId`);
    });
  });
  return snapshot;
}

async function listAllTables(call) {
  const names = [];
  let start;
  const seen = new Set();
  do {
    const result = await call('ListTables', { Limit: 100, ...(start ? { ExclusiveStartTableName: start } : {}) });
    names.push(...(result.TableNames || []));
    start = result.LastEvaluatedTableName;
    if (start && seen.has(start)) break;
    if (start) seen.add(start);
  } while (start);
  return names;
}

async function listAllQueues(call) {
  const urls = [];
  let token;
  const seen = new Set();
  do {
    const result = await call('ListQueues', { MaxResults: 1000, ...(token ? { NextToken: token } : {}) });
    urls.push(...(result.QueueUrls || []));
    token = result.NextToken;
    if (token && seen.has(token)) break;
    if (token) seen.add(token);
  } while (token);
  return urls;
}

function queueName(url) {
  try { return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || ''); }
  catch { return String(url).split('/').filter(Boolean).pop() || String(url); }
}

function createIndex(index, billingMode) {
  const result = {
    IndexName: index.IndexName,
    KeySchema: index.KeySchema || [],
    Projection: index.Projection || { ProjectionType: 'ALL' },
  };
  if (billingMode === 'PROVISIONED') {
    result.ProvisionedThroughput = {
      ReadCapacityUnits: Number(index.ProvisionedThroughput?.ReadCapacityUnits) || 1,
      WriteCapacityUnits: Number(index.ProvisionedThroughput?.WriteCapacityUnits) || 1,
    };
  }
  return result;
}

/** Export the emulator's ephemeral S3, DynamoDB, and SQS state. */
export async function exportSnapshot({ includeMessages = false, clients: clientOverrides } = {}) {
  const client = clients(clientOverrides);
  const snapshot = {
    version: SNAPSHOT_VERSION,
    exportedAt: new Date().toISOString(),
    services: { s3: [], dynamodb: [], sqs: [] },
    warnings: [],
  };

  for (const bucket of await client.s3.listBuckets()) {
    const saved = { name: bucket.name, objects: [] };
    snapshot.services.s3.push(saved);
    let token = '';
    const seen = new Set();
    do {
      const page = await client.s3.listObjects(bucket.name, { token, recursive: true });
      for (const object of page.objects || []) {
        const resource = `${bucket.name}/${object.key}`;
        if (Number(object.size) > MAX_S3_OBJECT_BYTES) {
          snapshot.warnings.push({ service: 's3', resource, message: 'Object exceeds the 16 MiB snapshot limit and was skipped' });
          continue;
        }
        try {
          const value = await client.s3.getObject(bucket.name, object.key);
          if (value.truncated || value.buffer.length > MAX_S3_OBJECT_BYTES) {
            snapshot.warnings.push({ service: 's3', resource, message: 'Object exceeds the 16 MiB snapshot limit and was skipped' });
            continue;
          }
          saved.objects.push({ key: object.key, contentType: value.contentType || 'application/octet-stream', dataBase64: value.buffer.toString('base64') });
        } catch (error) {
          snapshot.warnings.push({ service: 's3', resource, message: error.message });
        }
      }
      token = page.truncated ? page.nextToken : '';
      if (token && seen.has(token)) break;
      if (token) seen.add(token);
    } while (token);
  }

  for (const name of await listAllTables(client.dynamodbCall)) {
    const described = await client.dynamodbCall('DescribeTable', { TableName: name });
    const table = described.Table || {};
    const billingMode = table.BillingModeSummary?.BillingMode || 'PROVISIONED';
    const saved = {
      name,
      keySchema: table.KeySchema || [],
      attributeDefinitions: table.AttributeDefinitions || [],
      billingMode,
      globalSecondaryIndexes: (table.GlobalSecondaryIndexes || []).map((index) => createIndex(index, billingMode)),
      items: [],
    };
    snapshot.services.dynamodb.push(saved);
    let key;
    const seen = new Set();
    do {
      const result = await client.dynamodbCall('Scan', { TableName: name, ...(key ? { ExclusiveStartKey: key } : {}) });
      saved.items.push(...(result.Items || []));
      key = result.LastEvaluatedKey;
      const marker = key ? JSON.stringify(key) : '';
      if (marker && seen.has(marker)) break;
      if (marker) seen.add(marker);
    } while (key);
  }

  const attributeNames = ['VisibilityTimeout', 'DelaySeconds', 'ReceiveMessageWaitTimeSeconds'];
  for (const url of await listAllQueues(client.sqsCall)) {
    const result = await client.sqsCall('GetQueueAttributes', { QueueUrl: url, AttributeNames: attributeNames });
    const saved = { name: queueName(url), attributes: {}, messages: [] };
    for (const name of attributeNames) {
      if (result.Attributes?.[name] !== undefined) saved.attributes[name] = String(result.Attributes[name]);
    }
    if (includeMessages) {
      const received = await client.sqsCall('ReceiveMessage', {
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
        VisibilityTimeout: 0,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['All'],
      });
      saved.messages = (received.Messages || []).map((message) => ({
        body: String(message.Body ?? ''),
        ...(message.MessageAttributes && Object.keys(message.MessageAttributes).length ? { messageAttributes: message.MessageAttributes } : {}),
        ...(message.Attributes?.MessageGroupId ? { messageGroupId: message.Attributes.MessageGroupId } : {}),
        ...(message.Attributes?.MessageDeduplicationId ? { messageDeduplicationId: message.Attributes.MessageDeduplicationId } : {}),
      }));
    }
    snapshot.services.sqs.push(saved);
  }

  return snapshot;
}

function addError(summary, service, operation, resource, error) {
  summary.errors.push({ service, operation, resource, message: error?.message || String(error) });
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForTableActive(call, tableName) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await call('DescribeTable', { TableName: tableName });
    if (result.Table?.TableStatus === 'ACTIVE' || !result.Table?.TableStatus) return;
    await sleep(500);
  }
  throw new Error('Table did not become active within 60 seconds');
}

async function waitForTableDeleted(call, tableName) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { await call('DescribeTable', { TableName: tableName }); }
    catch (error) {
      if (/not.?found|ResourceNotFound/i.test(error.message)) return;
      throw error;
    }
    await sleep(500);
  }
  throw new Error('Table was not deleted within 60 seconds');
}

async function wipeExisting(client, summary) {
  let buckets = [];
  try { buckets = await client.s3.listBuckets(); }
  catch (error) { addError(summary, 's3', 'ListBuckets', '', error); }
  for (const bucket of buckets) {
    let token = '';
    const seen = new Set();
    do {
      let page;
      try { page = await client.s3.listObjects(bucket.name, { token, recursive: true }); }
      catch (error) { addError(summary, 's3', 'ListObjectsV2', bucket.name, error); break; }
      for (const object of page.objects || []) {
        try { await client.s3.deleteObject(bucket.name, object.key); }
        catch (error) { addError(summary, 's3', 'DeleteObject', `${bucket.name}/${object.key}`, error); }
      }
      token = page.truncated ? page.nextToken : '';
      if (token && seen.has(token)) break;
      if (token) seen.add(token);
    } while (token);
    try { await client.s3.deleteBucket(bucket.name); }
    catch (error) { addError(summary, 's3', 'DeleteBucket', bucket.name, error); }
  }

  let tables = [];
  try { tables = await listAllTables(client.dynamodbCall); }
  catch (error) { addError(summary, 'dynamodb', 'ListTables', '', error); }
  for (const name of tables) {
    try {
      const result = await client.dynamodbCall('DeleteTable', { TableName: name });
      if (result.TableDescription?.TableStatus === 'DELETING') await waitForTableDeleted(client.dynamodbCall, name);
    } catch (error) { addError(summary, 'dynamodb', 'DeleteTable', name, error); }
  }

  let queues = [];
  try { queues = await listAllQueues(client.sqsCall); }
  catch (error) { addError(summary, 'sqs', 'ListQueues', '', error); }
  for (const url of queues) {
    try { await client.sqsCall('DeleteQueue', { QueueUrl: url }); }
    catch (error) { addError(summary, 'sqs', 'DeleteQueue', queueName(url), error); }
  }
}

/** Restore a validated snapshot while continuing after individual resource failures. */
export async function importSnapshot(snapshot, { cleanFirst = false, clients: clientOverrides } = {}) {
  validateSnapshot(snapshot);
  const client = clients(clientOverrides);
  const summary = {
    s3: { buckets: 0, objects: 0, skipped: 0 },
    dynamodb: { tables: 0, items: 0 },
    sqs: { queues: 0, messages: 0 },
    errors: [],
  };
  if (cleanFirst) await wipeExisting(client, summary);

  let existingBuckets = new Set();
  try { existingBuckets = new Set((await client.s3.listBuckets()).map((bucket) => bucket.name)); }
  catch (error) { addError(summary, 's3', 'ListBuckets', '', error); }
  for (const bucket of snapshot.services.s3) {
    let ready = existingBuckets.has(bucket.name);
    if (!ready) {
      try { await client.s3.createBucket(bucket.name, config.region); ready = true; }
      catch (error) { addError(summary, 's3', 'CreateBucket', bucket.name, error); }
    }
    if (ready) summary.s3.buckets += 1;
    for (const object of bucket.objects) {
      if (!ready) { summary.s3.skipped += 1; continue; }
      const data = Buffer.from(object.dataBase64, 'base64');
      if (data.length > MAX_S3_OBJECT_BYTES) {
        summary.s3.skipped += 1;
        addError(summary, 's3', 'PutObject', `${bucket.name}/${object.key}`, new Error('Object exceeds the 16 MiB snapshot limit'));
        continue;
      }
      try { await client.s3.putObject(bucket.name, object.key, data, object.contentType); summary.s3.objects += 1; }
      catch (error) { summary.s3.skipped += 1; addError(summary, 's3', 'PutObject', `${bucket.name}/${object.key}`, error); }
    }
  }

  let existingTables = new Set();
  try { existingTables = new Set(await listAllTables(client.dynamodbCall)); }
  catch (error) { addError(summary, 'dynamodb', 'ListTables', '', error); }
  for (const table of snapshot.services.dynamodb) {
    let ready = existingTables.has(table.name);
    if (!ready) {
      const usedAttributes = new Set([...table.keySchema, ...table.globalSecondaryIndexes.flatMap((index) => index.KeySchema)].map((key) => key.AttributeName));
      const input = {
        TableName: table.name,
        KeySchema: table.keySchema,
        AttributeDefinitions: table.attributeDefinitions.filter((definition) => usedAttributes.has(definition.AttributeName)),
        BillingMode: table.billingMode,
        ...(table.globalSecondaryIndexes.length ? { GlobalSecondaryIndexes: table.globalSecondaryIndexes.map((index) => createIndex(index, table.billingMode)) } : {}),
      };
      if (table.billingMode === 'PROVISIONED') input.ProvisionedThroughput = { ReadCapacityUnits: 1, WriteCapacityUnits: 1 };
      try {
        const result = await client.dynamodbCall('CreateTable', input);
        if (result.TableDescription?.TableStatus && result.TableDescription.TableStatus !== 'ACTIVE') {
          await waitForTableActive(client.dynamodbCall, table.name);
        }
        ready = true;
      }
      catch (error) { addError(summary, 'dynamodb', 'CreateTable', table.name, error); }
    }
    if (ready) summary.dynamodb.tables += 1;
    if (!ready) continue;
    for (let offset = 0; offset < table.items.length; offset += 25) {
      let pending = table.items.slice(offset, offset + 25).map((Item) => ({ PutRequest: { Item } }));
      let failed = false;
      for (let attempt = 0; pending.length && attempt < 4; attempt += 1) {
        try {
          const result = await client.dynamodbCall('BatchWriteItem', { RequestItems: { [table.name]: pending } });
          const unprocessed = result.UnprocessedItems?.[table.name] || [];
          summary.dynamodb.items += pending.length - unprocessed.length;
          pending = unprocessed;
          if (pending.length) await sleep(50 * (2 ** attempt));
        } catch (error) {
          addError(summary, 'dynamodb', 'BatchWriteItem', table.name, error);
          failed = true;
          break;
        }
      }
      if (!failed && pending.length) addError(summary, 'dynamodb', 'BatchWriteItem', table.name, new Error(`${pending.length} items were not processed after retries`));
    }
  }

  let existingQueueUrls = [];
  try { existingQueueUrls = await listAllQueues(client.sqsCall); }
  catch (error) { addError(summary, 'sqs', 'ListQueues', '', error); }
  const existingQueues = new Map(existingQueueUrls.map((url) => [queueName(url), url]));
  for (const queue of snapshot.services.sqs) {
    let url = existingQueues.get(queue.name);
    if (!url) {
      const attributes = { ...queue.attributes, ...(queue.name.endsWith('.fifo') ? { FifoQueue: 'true' } : {}) };
      try {
        const result = await client.sqsCall('CreateQueue', { QueueName: queue.name, Attributes: attributes });
        url = result.QueueUrl;
      } catch (error) { addError(summary, 'sqs', 'CreateQueue', queue.name, error); }
    }
    if (!url) continue;
    summary.sqs.queues += 1;
    for (let offset = 0; offset < queue.messages.length; offset += 10) {
      let pending = queue.messages.slice(offset, offset + 10).map((message, index) => ({
        Id: `message-${offset + index}`,
        MessageBody: message.body,
        ...(message.messageAttributes ? { MessageAttributes: message.messageAttributes } : {}),
        ...(message.messageGroupId ? { MessageGroupId: message.messageGroupId } : {}),
        ...(message.messageDeduplicationId ? { MessageDeduplicationId: message.messageDeduplicationId } : {}),
      }));
      let failed = false;
      for (let attempt = 0; pending.length && attempt < 4; attempt += 1) {
        try {
          const result = await client.sqsCall('SendMessageBatch', { QueueUrl: url, Entries: pending });
          const failures = result.Failed || [];
          const failedById = new Map(failures.map((failure) => [failure.Id, failure]));
          summary.sqs.messages += pending.length - failures.length;
          const retry = [];
          for (const entry of pending) {
            const failure = failedById.get(entry.Id);
            if (!failure) continue;
            if (failure.SenderFault) addError(summary, 'sqs', 'SendMessageBatch', `${queue.name}/${failure.Id}`, new Error(failure.Message || failure.Code || 'Message failed'));
            else retry.push(entry);
          }
          pending = retry;
          if (pending.length) await sleep(50 * (2 ** attempt));
        } catch (error) {
          addError(summary, 'sqs', 'SendMessageBatch', queue.name, error);
          failed = true;
          break;
        }
      }
      if (!failed && pending.length) addError(summary, 'sqs', 'SendMessageBatch', queue.name, new Error(`${pending.length} messages failed after retries`));
    }
  }

  return summary;
}
