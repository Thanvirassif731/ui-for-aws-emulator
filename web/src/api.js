async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
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
  s3DeleteBucket: (name) => request('DELETE', `/api/s3/buckets/${encodeURIComponent(name)}`),
  s3Objects: (bucket, prefix = '', token = '') => request('GET', `/api/s3/buckets/${encodeURIComponent(bucket)}/objects?prefix=${encodeURIComponent(prefix)}&token=${encodeURIComponent(token)}`),
  s3Put: (bucket, key, contentType, dataBase64) => request('PUT', `/api/s3/buckets/${encodeURIComponent(bucket)}/object`, { key, contentType, dataBase64 }),
  s3Delete: (bucket, key) => request('DELETE', `/api/s3/buckets/${encodeURIComponent(bucket)}/object?key=${encodeURIComponent(key)}`),
  s3ObjectUrl: (bucket, key, download) => `/api/s3/buckets/${encodeURIComponent(bucket)}/object?key=${encodeURIComponent(key)}${download ? '&download=1' : ''}`,
  invoke: (payload) => request('POST', '/api/invoke', payload),
  raw: (payload) => request('POST', '/api/raw', payload),
};
