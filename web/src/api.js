import { notifyError } from './notifications.js';

async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    notifyError(error, { title: 'UI server unreachable', source: `${method} ${url.split('?')[0]}` });
    throw error;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `${res.status} ${res.statusText}`);
    notifyError(error, { title: 'Request failed', source: `${method} ${url.split('?')[0]}` });
    throw error;
  }
  return data;
}

export const api = {
  status: () => request('GET', '/api/emulator/status'),
  saveNames: (names) => request('POST', '/api/emulator/settings', names),
  build: () => request('POST', '/api/emulator/build', {}),
  start: () => request('POST', '/api/emulator/start', {}),
  resume: () => request('POST', '/api/emulator/resume', {}),
  restart: () => request('POST', '/api/emulator/restart', {}),
  remove: () => request('POST', '/api/emulator/remove', {}),
  stop: () => request('POST', '/api/emulator/stop', {}),
  logs: (tail = 300) => request('GET', `/api/emulator/logs?tail=${tail}`),
  services: (q = '') => request('GET', `/api/services?q=${encodeURIComponent(q)}`),
  operations: (id) => request('GET', `/api/services/${encodeURIComponent(id)}/operations`),
  operation: (id, op) => request('GET', `/api/services/${encodeURIComponent(id)}/operations/${encodeURIComponent(op)}`),
  s3Buckets: () => request('GET', '/api/s3/buckets'),
  s3CreateBucket: (name) => request('POST', '/api/s3/buckets', { name }),
  s3DeleteBucket: (name) => request('DELETE', `/api/s3/buckets/${encodeURIComponent(name)}`, {}),
  s3Objects: (bucket, prefix = '', token = '') => request('GET', `/api/s3/buckets/${encodeURIComponent(bucket)}/objects?prefix=${encodeURIComponent(prefix)}&token=${encodeURIComponent(token)}`),
  s3Put: (bucket, key, contentType, dataBase64) => request('PUT', `/api/s3/buckets/${encodeURIComponent(bucket)}/object`, { key, contentType, dataBase64 }),
  s3Delete: (bucket, key) => request('DELETE', `/api/s3/buckets/${encodeURIComponent(bucket)}/object?key=${encodeURIComponent(key)}`, {}),
  s3ObjectUrl: (bucket, key, download) => `/api/s3/buckets/${encodeURIComponent(bucket)}/object?key=${encodeURIComponent(key)}${download ? '&download=1' : ''}`,
  s3Versioning: (bucket) => request('GET', `/api/s3/buckets/${encodeURIComponent(bucket)}/versioning`),
  s3SetVersioning: (bucket, status) => request('PUT', `/api/s3/buckets/${encodeURIComponent(bucket)}/versioning`, { status }),
  s3Versions: (bucket, prefix = '') => request('GET', `/api/s3/buckets/${encodeURIComponent(bucket)}/versions?prefix=${encodeURIComponent(prefix)}`),
  s3RestoreObject: (bucket, key, versionId) => request('POST', `/api/s3/buckets/${encodeURIComponent(bucket)}/versions/restore`, { key, versionId }),
  s3Website: (bucket) => request('GET', `/api/s3/buckets/${encodeURIComponent(bucket)}/website`),
  s3SetWebsite: (bucket, website) => request('PUT', `/api/s3/buckets/${encodeURIComponent(bucket)}/website`, website),
  s3LoadSampleSite: (bucket) => request('POST', `/api/s3/buckets/${encodeURIComponent(bucket)}/website/sample`, {}),
  s3PublicAccessBlock: (bucket) => request('GET', `/api/s3/buckets/${encodeURIComponent(bucket)}/public-access-block`),
  s3SetPublicAccessBlock: (bucket, settings) => request('PUT', `/api/s3/buckets/${encodeURIComponent(bucket)}/public-access-block`, settings),
  s3Policy: (bucket) => request('GET', `/api/s3/buckets/${encodeURIComponent(bucket)}/policy`),
  s3SetPolicy: (bucket, policy) => request('PUT', `/api/s3/buckets/${encodeURIComponent(bucket)}/policy`, { policy }),
  s3DeletePolicy: (bucket) => request('DELETE', `/api/s3/buckets/${encodeURIComponent(bucket)}/policy`, {}),
  s3SimulatePolicy: (bucket, input) => request('POST', `/api/s3/buckets/${encodeURIComponent(bucket)}/simulate-policy`, input),
  s3Lifecycle: (bucket) => request('GET', `/api/s3/buckets/${encodeURIComponent(bucket)}/lifecycle`),
  s3SaveLifecycleRule: (bucket, rule) => request('POST', `/api/s3/buckets/${encodeURIComponent(bucket)}/lifecycle/rules`, rule),
  s3DeleteLifecycleRule: (bucket, id) => request('DELETE', `/api/s3/buckets/${encodeURIComponent(bucket)}/lifecycle/rules/${encodeURIComponent(id)}`, {}),
  s3SimulateTime: (bucket, advanceDays) => request('POST', `/api/s3/buckets/${encodeURIComponent(bucket)}/lifecycle/simulate-time`, { advanceDays }),
  s3ResetClock: (bucket) => request('DELETE', `/api/s3/buckets/${encodeURIComponent(bucket)}/lifecycle/simulate-time`, {}),
  dynamodbTables: () => request('GET', '/api/dynamodb/tables'),
  dynamodbScan: (tableName, exclusiveStartKey) => request('POST', '/api/dynamodb/scan', { tableName, exclusiveStartKey }),
  sqsQueues: () => request('GET', '/api/sqs/queues'),
  sqsInspect: (queueUrl) => request('POST', '/api/sqs/inspect', { queueUrl }),
  sqsSend: (queueUrl, body) => request('POST', '/api/sqs/send', { queueUrl, body }),
  sqsDeleteMessage: (queueUrl, receiptHandle) => request('POST', '/api/sqs/delete-message', { queueUrl, receiptHandle }),
  sqsPurge: (queueUrl) => request('POST', '/api/sqs/purge', { queueUrl }),
  ec2DockerStatus: () => request('GET', '/api/ec2/docker-status'),
  ec2Instances: (token = '') => request('GET', `/api/ec2/instances?token=${encodeURIComponent(token)}`),
  ec2DescribeInstances: (instanceIds) => request('POST', '/api/ec2/instances/describe', { instanceIds }),
  ec2Images: (token = '') => request('GET', `/api/ec2/images?token=${encodeURIComponent(token)}`),
  ec2RunInstances: (input) => request('POST', '/api/ec2/instances', input),
  ec2InstanceAction: (action, instanceIds) => request('POST', '/api/ec2/instances/action', { action, instanceIds }),
  snapshotExport: async (includeMessages = false) => {
    const url = `/api/snapshots/export?includeMessages=${includeMessages ? 'true' : 'false'}`;
    let response;
    try { response = await fetch(url); }
    catch (error) {
      notifyError(error, { title: 'UI server unreachable', source: 'GET /api/snapshots/export' });
      throw error;
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const error = new Error(data.error || `${response.status} ${response.statusText}`);
      notifyError(error, { title: 'Snapshot export failed', source: 'Snapshots' });
      throw error;
    }
    return response.blob();
  },
  snapshotImport: (snapshot, cleanFirst) => request('POST', '/api/snapshots/import', { snapshot, cleanFirst }),
  traffic: (after = 0) => request('GET', `/api/traffic?after=${encodeURIComponent(after)}`),
  clearTraffic: () => request('DELETE', '/api/traffic', {}),
  invoke: (payload) => request('POST', '/api/invoke', payload),
  raw: (payload) => request('POST', '/api/raw', payload),
};
