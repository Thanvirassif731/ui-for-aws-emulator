// Reads the emulator's Smithy JSON models (read-only) to describe services and operations.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const PROTOCOL_ORDER = [
  'aws.protocols#awsJson1_0',
  'aws.protocols#awsJson1_1',
  'aws.protocols#restJson1',
  'aws.protocols#restXml',
  'aws.protocols#awsQuery',
  'aws.protocols#ec2Query',
];

const SIMPLE_TYPES = new Set([
  'blob', 'boolean', 'string', 'byte', 'short', 'integer', 'long', 'float', 'double',
  'bigInteger', 'bigDecimal', 'timestamp', 'document', 'enum', 'intEnum',
]);

let index = null; // Map<id, summary>
const modelCache = new Map(); // id -> parsed model (small LRU)
const MODEL_CACHE_MAX = 4;

function shortName(shapeId) {
  return shapeId.split('#').pop();
}

function pickProtocol(traits = {}) {
  return PROTOCOL_ORDER.find((p) => p in traits) || null;
}

function collectOperations(shapes, shape, out = new Set(), seen = new Set()) {
  for (const o of shape.operations || []) out.add(o.target);
  for (const r of shape.resources || []) {
    if (seen.has(r.target)) continue;
    seen.add(r.target);
    const res = shapes[r.target];
    if (!res) continue;
    for (const key of ['create', 'put', 'read', 'update', 'delete', 'list']) {
      if (res[key]) out.add(res[key].target);
    }
    for (const key of ['operations', 'collectionOperations']) {
      for (const o of res[key] || []) out.add(o.target);
    }
    collectOperations(shapes, res, out, seen);
  }
  return out;
}

function modelFiles() {
  const servicesDir = path.join(config.repoRoot, 'services');
  if (!fs.existsSync(servicesDir)) return [];
  const files = [];
  for (const dir of fs.readdirSync(servicesDir)) {
    if (!dir.startsWith('service-')) continue;
    const modelDir = path.join(servicesDir, dir, 'smithy-model');
    if (!fs.existsSync(modelDir)) continue;
    for (const f of fs.readdirSync(modelDir)) {
      if (f.endsWith('.json')) files.push({ id: dir.replace(/^service-/, ''), file: path.join(modelDir, f) });
    }
  }
  return files;
}

function summarize(id, file, model) {
  for (const [shapeId, shape] of Object.entries(model.shapes)) {
    if (shape.type !== 'service') continue;
    const t = shape.traits || {};
    const api = t['aws.api#service'] || {};
    const sigv4 = t['aws.auth#sigv4'];
    return {
      id,
      file,
      shapeId,
      name: shortName(shapeId),
      title: api.sdkId || t['smithy.api#title'] || shortName(shapeId),
      signingName: (sigv4 && sigv4.name) || api.arnNamespace || api.endpointPrefix || null,
      protocol: pickProtocol(t),
      version: shape.version || null,
      operationCount: collectOperations(model.shapes, shape).size,
    };
  }
  return null;
}

export function getIndex() {
  if (index) return index;
  index = new Map();
  for (const { id, file } of modelFiles()) {
    try {
      const model = JSON.parse(fs.readFileSync(file, 'utf8'));
      const s = summarize(id, file, model);
      if (s) index.set(id, s);
    } catch (e) {
      console.warn(`skipping ${file}: ${e.message}`);
    }
  }
  return index;
}

export function listServices(q = '') {
  const needle = q.trim().toLowerCase();
  return [...getIndex().values()]
    .filter((s) => !needle || `${s.title} ${s.id} ${s.signingName}`.toLowerCase().includes(needle))
    .map(({ file, ...rest }) => rest)
    .sort((a, b) => a.title.localeCompare(b.title));
}

export function loadModel(id) {
  const summary = getIndex().get(id);
  if (!summary) return null;
  if (modelCache.has(id)) return { summary, model: modelCache.get(id) };
  const model = JSON.parse(fs.readFileSync(summary.file, 'utf8'));
  modelCache.set(id, model);
  if (modelCache.size > MODEL_CACHE_MAX) modelCache.delete(modelCache.keys().next().value);
  return { summary, model };
}

export function listOperations(id) {
  const loaded = loadModel(id);
  if (!loaded) return null;
  const { summary, model } = loaded;
  const svc = model.shapes[summary.shapeId];
  return [...collectOperations(model.shapes, svc)]
    .map((target) => {
      const op = model.shapes[target];
      const http = op?.traits?.['smithy.api#http'];
      return {
        name: shortName(target),
        method: http?.method || null,
        uri: http?.uri || null,
        documentation: stripHtml(op?.traits?.['smithy.api#documentation']),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function stripHtml(s) {
  if (!s) return '';
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 600);
}

/** Build a template JSON value for a shape (required members only, depth limited). */
export function skeleton(shapes, shapeId, depth = 0, trail = new Set()) {
  const shape = shapes[shapeId];
  const prelude = shapeId.startsWith('smithy.api#') ? shapeId.slice(11).toLowerCase() : null;
  if (prelude) {
    if (prelude === 'boolean' || prelude === 'primitiveboolean') return false;
    if (/integer|long|short|byte|float|double|bigint|bigdec/.test(prelude)) return 0;
    if (prelude === 'timestamp') return '2024-01-01T00:00:00Z';
    return '';
  }
  if (!shape) return null;
  switch (shape.type) {
    case 'boolean': return false;
    case 'byte': case 'short': case 'integer': case 'long': case 'float': case 'double':
    case 'bigInteger': case 'bigDecimal': case 'intEnum': return 0;
    case 'timestamp': return '2024-01-01T00:00:00Z';
    case 'enum': return Object.keys(shape.members || {})[0] ?
      (shape.members[Object.keys(shape.members)[0]].traits?.['smithy.api#enumValue'] ?? Object.keys(shape.members)[0]) : '';
    case 'document': return {};
    case 'list': case 'set': return [];
    case 'map': return {};
    case 'structure': {
      if (depth > 3 || trail.has(shapeId)) return {};
      const next = new Set(trail).add(shapeId);
      const out = {};
      for (const [name, m] of Object.entries(shape.members || {})) {
        if (m.traits && 'smithy.api#required' in m.traits) out[name] = skeleton(shapes, m.target, depth + 1, next);
      }
      return out;
    }
    case 'union': {
      if (depth > 3 || trail.has(shapeId)) return {};
      const [name, m] = Object.entries(shape.members || {})[0] || [];
      return name ? { [name]: skeleton(shapes, m.target, depth + 1, new Set(trail).add(shapeId)) } : {};
    }
    default:
      return SIMPLE_TYPES.has(shape.type) ? '' : null;
  }
}

function describeType(shapes, target) {
  const s = shapes[target];
  if (!s) return shortName(target);
  if (s.type === 'list' || s.type === 'set') return `list<${describeType(shapes, s.member.target)}>`;
  if (s.type === 'map') return `map<${describeType(shapes, s.value.target)}>`;
  return s.type === 'structure' || s.type === 'union' ? shortName(target) : s.type;
}

export function describeOperation(id, opName) {
  const loaded = loadModel(id);
  if (!loaded) return null;
  const { summary, model } = loaded;
  const svc = model.shapes[summary.shapeId];
  const target = [...collectOperations(model.shapes, svc)].find((t) => shortName(t) === opName);
  if (!target) return null;
  const op = model.shapes[target];
  const inputId = op.input?.target;
  const input = inputId && inputId !== 'smithy.api#Unit' ? model.shapes[inputId] : null;
  const members = Object.entries(input?.members || {}).map(([name, m]) => ({
    name,
    type: describeType(model.shapes, m.target),
    required: !!m.traits?.['smithy.api#required'],
    binding: bindingOf(m.traits),
    documentation: stripHtml(m.traits?.['smithy.api#documentation']).slice(0, 240),
  }));
  const http = op.traits?.['smithy.api#http'];
  return {
    service: summary.id,
    protocol: summary.protocol,
    name: opName,
    method: http?.method || null,
    uri: http?.uri || null,
    documentation: stripHtml(op.traits?.['smithy.api#documentation']),
    members,
    skeleton: inputId && input ? skeleton(model.shapes, inputId) : {},
  };
}

function bindingOf(traits = {}) {
  if ('smithy.api#httpLabel' in traits) return 'path';
  if ('smithy.api#httpQuery' in traits) return 'query';
  if ('smithy.api#httpQueryParams' in traits) return 'queryParams';
  if ('smithy.api#httpHeader' in traits) return 'header';
  if ('smithy.api#httpPrefixHeaders' in traits) return 'prefixHeaders';
  if ('smithy.api#httpPayload' in traits) return 'payload';
  return 'body';
}

export { shortName, collectOperations };
