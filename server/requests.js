// Turns (service, operation, JSON input) into an HTTP request, following the service's Smithy protocol.
import { loadModel, collectOperations, shortName } from './models.js';

export class BuildError extends Error {}

const has = (traits, key) => !!traits && `smithy.api#${key}` in traits;
const trait = (traits, key) => traits?.[`smithy.api#${key}`];

function findOperation(model, summary, opName) {
  const svc = model.shapes[summary.shapeId];
  const target = [...collectOperations(model.shapes, svc)].find((t) => shortName(t) === opName);
  if (!target) throw new BuildError(`Unknown operation ${opName}`);
  return model.shapes[target];
}

function encodeUriSegment(value, greedy) {
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return greedy ? String(value).split('/').map(enc).join('/') : enc(String(value));
}

function scalarToString(v) {
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return String(v);
}

// ---------- awsJson ----------
function buildJson(summary, opName, input) {
  const version = summary.protocol.endsWith('1_0') ? '1.0' : '1.1';
  return {
    method: 'POST',
    path: '/',
    query: {},
    headers: {
      'Content-Type': `application/x-amz-json-${version}`,
      'X-Amz-Target': `${summary.name}.${opName}`,
    },
    body: JSON.stringify(input ?? {}),
  };
}

// ---------- awsQuery / ec2Query ----------
function queryName(protocol, memberName, traits) {
  if (protocol.endsWith('ec2Query')) {
    const q = traits?.['aws.protocols#ec2QueryName'];
    if (q) return q;
    const x = trait(traits, 'xmlName');
    const base = x || memberName;
    return base.charAt(0).toUpperCase() + base.slice(1);
  }
  return trait(traits, 'xmlName') || memberName;
}

function flattenQuery(model, protocol, targetId, value, prefix, out, memberTraits) {
  const shape = model.shapes[targetId];
  const type = shape?.type;
  if (value === undefined || value === null) return;
  if (type === 'structure' || type === 'union') {
    for (const [k, v] of Object.entries(value)) {
      const m = shape.members?.[k];
      if (!m) throw new BuildError(`Unknown member "${k}" in ${shortName(targetId)}`);
      const name = queryName(protocol, k, m.traits);
      flattenQuery(model, protocol, m.target, v, prefix ? `${prefix}.${name}` : name, out, m.traits);
    }
  } else if (type === 'list' || type === 'set') {
    const ec2 = protocol.endsWith('ec2Query');
    const flattened = ec2 || has(memberTraits, 'xmlFlattened');
    const itemName = trait(shape.member.traits, 'xmlName') || 'member';
    const base = flattened ? prefix : `${prefix}.${itemName}`;
    if (!value.length) { if (!ec2) out.push([prefix, '']); return; }
    value.forEach((item, i) => flattenQuery(model, protocol, shape.member.target, item, `${base}.${i + 1}`, out, shape.member.traits));
  } else if (type === 'map') {
    const flattened = protocol.endsWith('ec2Query') || has(memberTraits, 'xmlFlattened');
    const keyName = trait(shape.key.traits, 'xmlName') || 'key';
    const valName = trait(shape.value.traits, 'xmlName') || 'value';
    const base = flattened ? prefix : `${prefix}.entry`;
    Object.entries(value).forEach(([k, v], i) => {
      out.push([`${base}.${i + 1}.${keyName}`, k]);
      flattenQuery(model, protocol, shape.value.target, v, `${base}.${i + 1}.${valName}`, out, shape.value.traits);
    });
  } else {
    out.push([prefix, scalarToString(value)]);
  }
}

function buildQuery(model, summary, opName, op, input) {
  const out = [['Action', opName], ['Version', summary.version]];
  if (op.input && op.input.target !== 'smithy.api#Unit') {
    flattenQuery(model, summary.protocol, op.input.target, input ?? {}, '', out, {});
  }
  const body = out.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return {
    method: 'POST',
    path: '/',
    query: {},
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body,
  };
}

// ---------- restJson / restXml ----------
const escapeXmlText = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeXmlAttribute = (value) => escapeXmlText(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function xmlName(shape, fallback) {
  return trait(shape?.traits, 'xmlName') || fallback;
}

function xmlScalar(shape, value, traits = {}) {
  if (shape?.type === 'blob') {
    if (Buffer.isBuffer(value)) return value.toString('base64');
    return Buffer.from(String(value), 'utf8').toString('base64');
  }
  const timestampFormat = trait(traits, 'timestampFormat') || trait(shape?.traits, 'timestampFormat');
  if (shape?.type === 'timestamp' && timestampFormat === 'epoch-seconds') {
    const n = typeof value === 'number' ? value : Date.parse(value) / 1000;
    if (!Number.isFinite(n)) throw new BuildError(`Invalid timestamp "${value}"`);
    return String(n);
  }
  if (shape?.type === 'document' || (typeof value === 'object' && value !== null)) return JSON.stringify(value);
  return String(value);
}

function xmlElement(model, targetId, value, name, memberTraits = {}, root = false) {
  const shape = model.shapes[targetId];
  if (value === undefined || value === null) return '';
  if (!shape) return `<${name}>${escapeXmlText(value)}</${name}>`;

  if (shape.type === 'structure' || shape.type === 'union') {
    const attributes = [];
    const children = [];
    for (const [memberName, member] of Object.entries(shape.members || {})) {
      const memberValue = value?.[memberName];
      if (memberValue === undefined || memberValue === null) continue;
      const memberNameXml = xmlName(member, memberName);
      if (has(member.traits, 'xmlAttribute')) {
        attributes.push(`${memberNameXml}="${escapeXmlAttribute(xmlScalar(model.shapes[member.target], memberValue, member.traits))}"`);
      } else {
        children.push(xmlMember(model, member, memberValue, memberNameXml));
      }
    }
    if (root) {
      const namespace = trait(shape.traits, 'xmlNamespace') || (root === true ? null : root);
      if (namespace?.uri) attributes.unshift(`xmlns${namespace.prefix ? `:${namespace.prefix}` : ''}="${escapeXmlAttribute(namespace.uri)}"`);
    }
    const attrs = attributes.length ? ` ${attributes.join(' ')}` : '';
    return `<${name}${attrs}>${children.join('')}</${name}>`;
  }

  if (shape.type === 'list' || shape.type === 'set') {
    const itemName = xmlName(shape.member, 'member');
    return `<${name}>${(value || []).map((item) => xmlElement(model, shape.member.target, item, itemName, shape.member.traits)).join('')}</${name}>`;
  }

  if (shape.type === 'map') {
    const keyName = xmlName(shape.key, 'key');
    const valueName = xmlName(shape.value, 'value');
    const entries = Object.entries(value || {}).map(([key, item]) => `<entry>${xmlElement(model, shape.key.target, key, keyName, shape.key.traits)}${xmlElement(model, shape.value.target, item, valueName, shape.value.traits)}</entry>`).join('');
    return `<${name}>${entries}</${name}>`;
  }

  return `<${name}>${escapeXmlText(xmlScalar(shape, value, memberTraits))}</${name}>`;
}

function xmlMember(model, member, value, name) {
  const shape = model.shapes[member.target];
  const flattened = has(member.traits, 'xmlFlattened');
  if (flattened && (shape?.type === 'list' || shape?.type === 'set')) {
    return (value || []).map((item) => xmlElement(model, shape.member.target, item, name, shape.member.traits)).join('');
  }
  if (flattened && shape?.type === 'map') {
    const keyName = xmlName(shape.key, 'key');
    const valueName = xmlName(shape.value, 'value');
    return Object.entries(value || {}).map(([key, item]) => `<${name}>${xmlElement(model, shape.key.target, key, keyName, shape.key.traits)}${xmlElement(model, shape.value.target, item, valueName, shape.value.traits)}</${name}>`).join('');
  }
  return xmlElement(model, member.target, value, name, member.traits);
}

export function serializeXml(model, targetId, value, fallbackName, namespace = null) {
  const shape = model.shapes[targetId];
  const name = xmlName(shape, fallbackName || shortName(targetId));
  return xmlElement(model, targetId, value ?? {}, name, {}, namespace || true);
}

function buildRest(model, summary, opName, op, input, bodyOverride) {
  const http = trait(op.traits, 'http');
  if (!http) throw new BuildError(`Operation ${opName} has no http binding`);
  const inputShape = op.input && op.input.target !== 'smithy.api#Unit' ? model.shapes[op.input.target] : null;
  const members = inputShape?.members || {};
  const data = { ...(input || {}) };
  for (const k of Object.keys(data)) {
    if (!(k in members)) throw new BuildError(`Unknown member "${k}" in input`);
  }

  const [uriPath, uriQuery] = http.uri.split('?');
  const query = {};
  if (uriQuery) {
    for (const part of uriQuery.split('&')) {
      const [k, v = ''] = part.split('=');
      query[k] = v;
    }
  }
  const headers = {};
  const bodyData = {};
  let payloadKey = null;

  for (const [name, m] of Object.entries(members)) {
    const v = data[name];
    const t = m.traits || {};
    if (has(t, 'httpLabel')) continue; // handled in path
    if (v === undefined || v === null) continue;
    if (has(t, 'httpQuery')) {
      const key = trait(t, 'httpQuery');
      query[key] = Array.isArray(v) ? v.map(scalarToString) : scalarToString(v);
    } else if (has(t, 'httpQueryParams')) {
      for (const [k, val] of Object.entries(v)) query[k] = Array.isArray(val) ? val.map(scalarToString) : scalarToString(val);
    } else if (has(t, 'httpHeader')) {
      headers[trait(t, 'httpHeader')] = Array.isArray(v) ? v.map(scalarToString).join(', ') : scalarToString(v);
    } else if (has(t, 'httpPrefixHeaders')) {
      for (const [k, val] of Object.entries(v)) headers[trait(t, 'httpPrefixHeaders') + k] = scalarToString(val);
    } else if (has(t, 'httpPayload')) {
      payloadKey = name;
    } else {
      bodyData[name] = v;
    }
  }

  const path = uriPath.replace(/\{([^}]+)\}/g, (_, raw) => {
    const greedy = raw.endsWith('+');
    const label = greedy ? raw.slice(0, -1) : raw;
    const v = data[label];
    if (v === undefined || v === null || v === '') throw new BuildError(`Missing required path parameter "${label}"`);
    return encodeUriSegment(v, greedy);
  });

  let body = '';
  const isXml = summary.protocol.endsWith('restXml');
  const xmlNamespace = isXml ? trait(model.shapes[summary.shapeId]?.traits, 'xmlNamespace') : null;
  if (bodyOverride !== undefined && bodyOverride !== '') {
    body = bodyOverride;
  } else if (payloadKey) {
    const v = data[payloadKey];
    const targetShape = model.shapes[members[payloadKey].target];
    if (targetShape?.type === 'structure' || targetShape?.type === 'union') {
      body = isXml
        ? serializeXml(model, members[payloadKey].target, v, xmlName(members[payloadKey], payloadKey), xmlNamespace)
        : JSON.stringify(v);
    } else {
      body = typeof v === 'string' ? v : JSON.stringify(v);
    }
  } else if (Object.keys(bodyData).length) {
    body = isXml
      ? serializeXml(model, op.input.target, bodyData, shortName(op.input.target), xmlNamespace)
      : JSON.stringify(bodyData);
  } else if (!isXml && !['GET', 'HEAD', 'DELETE'].includes(http.method) && inputShape) {
    body = '{}';
  }
  if (body && !isXml && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (body && isXml && !headers['Content-Type']) headers['Content-Type'] = 'application/xml';

  return { method: http.method, path, query, headers, body };
}

export function buildRequest({ serviceId, operation, input, bodyOverride }) {
  const loaded = loadModel(serviceId);
  if (!loaded) throw new BuildError(`Unknown service ${serviceId}`);
  const { summary, model } = loaded;
  if (!summary.protocol) throw new BuildError('This service uses a protocol the console cannot build requests for. Use Raw mode.');
  const op = findOperation(model, summary, operation);
  let req;
  if (summary.protocol.includes('awsJson')) req = buildJson(summary, operation, input);
  else if (summary.protocol.endsWith('Query')) req = buildQuery(model, summary, operation, op, input);
  else req = buildRest(model, summary, operation, op, input, bodyOverride);
  return { ...req, signingName: summary.signingName };
}
