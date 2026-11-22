import {
  DescribeImagesCommand,
  DescribeInstancesCommand,
  EC2Client,
  RebootInstancesCommand,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import { Readable } from 'node:stream';
import { config } from './config.js';
import { readCredentials, send } from './emulator.js';

const API_VERSION = '2016-11-15';
const ACTIONS = new Set(['start', 'stop', 'reboot', 'terminate']);

export class Ec2Error extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const sdkClient = new EC2Client({
  region: config.region,
  endpoint: `https://${config.emulatorHost}:${config.emulatorPort}`,
  maxAttempts: 1,
  credentials: async () => readCredentials() || { accessKeyId: 'aws-emulator', secretAccessKey: 'aws-emulator' },
  // Reuse the application's certificate-verified transport while the SDK owns EC2
  // command serialization, SigV4 signing, and response deserialization.
  requestHandler: {
    handle: async (request) => {
      const result = await send({
        method: request.method,
        path: request.path,
        query: request.query,
        headers: request.headers,
        body: request.body || '',
        signingName: null,
      });
      const body = result.bodyEncoding === 'base64' ? Buffer.from(result.body, 'base64') : Buffer.from(result.body || '', 'utf8');
      return { response: { statusCode: result.status, reason: result.statusText, headers: result.headers, body: Readable.from([body]) } };
    },
  },
});

async function ec2SdkCall(command) {
  try {
    return await sdkClient.send(command);
  } catch (error) {
    const status = Number(error?.$metadata?.httpStatusCode || 502);
    const message = error?.code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(error?.message || '')
      ? 'Cannot connect to the emulator. Is it running?'
      : error?.message || error?.name || 'EC2 request failed';
    throw new Ec2Error(message, status);
  }
}

function fromSdkInstance(instance, reservation = {}) {
  return {
    id: instance.InstanceId || '',
    name: instance.Tags?.find((tag) => tag.Key === 'Name')?.Value || '',
    imageId: instance.ImageId || '',
    instanceType: instance.InstanceType || '',
    state: instance.State?.Name || 'unknown',
    stateCode: Number(instance.State?.Code || 0),
    launchTime: instance.LaunchTime instanceof Date ? instance.LaunchTime.toISOString() : instance.LaunchTime || null,
    privateIpAddress: instance.PrivateIpAddress || null,
    privateDnsName: instance.PrivateDnsName || null,
    publicIpAddress: instance.PublicIpAddress || null,
    publicDnsName: instance.PublicDnsName || null,
    subnetId: instance.SubnetId || null,
    vpcId: instance.VpcId || null,
    availabilityZone: instance.Placement?.AvailabilityZone || null,
    architecture: instance.Architecture || null,
    platform: instance.PlatformDetails || instance.Platform || null,
    keyName: instance.KeyName || null,
    reservationId: reservation.id || null,
    ownerId: reservation.ownerId || null,
    tags: (instance.Tags || []).map((tag) => ({ key: tag.Key || '', value: tag.Value || '' })),
    securityGroups: (instance.SecurityGroups || []).map((group) => ({ id: group.GroupId || '', name: group.GroupName || '' })),
  };
}

function instancesFromSdk(output) {
  return {
    instances: (output.Reservations || []).flatMap((reservation) => (reservation.Instances || []).map((instance) => fromSdkInstance(instance, {
      id: reservation.ReservationId,
      ownerId: reservation.OwnerId,
    }))),
    nextToken: output.NextToken || null,
  };
}

const decodeXml = (value) => String(value)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
  .replace(/&amp;/g, '&');

/** A small response-only XML reader that preserves nested EC2 Query item sets. */
export function parseXml(xml) {
  const document = { name: '#document', text: '', children: [] };
  const stack = [document];
  const tokens = String(xml).match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>|[^<]+/g) || [];
  for (const token of tokens) {
    if (token.startsWith('<?') || token.startsWith('<!--') || token.startsWith('<!DOCTYPE')) continue;
    if (token.startsWith('<![CDATA[')) {
      stack[stack.length - 1].text += token.slice(9, -3);
      continue;
    }
    if (token.startsWith('</')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (token.startsWith('<')) {
      const match = token.match(/^<\s*([^\s/>]+)/);
      if (!match) continue;
      const node = { name: match[1].split(':').pop(), text: '', children: [] };
      stack[stack.length - 1].children.push(node);
      if (!/\/\s*>$/.test(token)) stack.push(node);
      continue;
    }
    stack[stack.length - 1].text += token;
  }
  return document.children[0] || document;
}

const child = (node, name) => node?.children?.find((item) => item.name === name) || null;
const children = (node, name) => node?.children?.filter((item) => item.name === name) || [];
const text = (node) => decodeXml(node?.text || '').trim();
const rawText = (node) => decodeXml(node?.text || '');
const value = (node, name) => text(child(node, name));
const items = (node, setName) => children(child(node, setName), 'item');

function descendant(node, name) {
  if (!node) return null;
  if (node.name === name) return node;
  for (const entry of node.children || []) {
    const found = descendant(entry, name);
    if (found) return found;
  }
  return null;
}

function requestBody(action, params = {}) {
  const values = new URLSearchParams({ Action: action, Version: API_VERSION });
  for (const [name, item] of Object.entries(params)) {
    if (item !== undefined && item !== null && item !== '') values.append(name, String(item));
  }
  return values.toString();
}

export async function ec2Call(action, params = {}, sendRequest = send) {
  let response;
  try {
    response = await sendRequest({
      method: 'POST',
      path: '/',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: requestBody(action, params),
      signingName: 'ec2',
    });
  } catch (error) {
    throw new Ec2Error(error.code === 'ECONNREFUSED' ? 'Cannot connect to the emulator. Is it running?' : error.message, 502);
  }
  if (response.status >= 400) {
    const root = parseXml(response.bodyEncoding === 'base64' ? Buffer.from(response.body, 'base64').toString('utf8') : response.body);
    const code = text(descendant(root, 'Code'));
    const message = text(descendant(root, 'Message'));
    throw new Ec2Error(message || code || `EC2 returned ${response.status}`, response.status);
  }
  return response.bodyEncoding === 'base64' ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
}

function parseTags(node) {
  return items(node, 'tagSet').map((tag) => ({ key: value(tag, 'key'), value: rawText(child(tag, 'value')) }));
}

function parseInstance(node, reservation = {}) {
  const state = child(node, 'instanceState');
  const placement = child(node, 'placement');
  const tags = parseTags(node);
  return {
    id: value(node, 'instanceId'),
    name: tags.find((tag) => tag.key === 'Name')?.value || '',
    imageId: value(node, 'imageId'),
    instanceType: value(node, 'instanceType'),
    state: value(state, 'name') || 'unknown',
    stateCode: Number(value(state, 'code') || 0),
    launchTime: value(node, 'launchTime') || null,
    privateIpAddress: value(node, 'privateIpAddress') || null,
    privateDnsName: value(node, 'privateDnsName') || null,
    publicIpAddress: value(node, 'ipAddress') || null,
    publicDnsName: value(node, 'dnsName') || null,
    subnetId: value(node, 'subnetId') || null,
    vpcId: value(node, 'vpcId') || null,
    availabilityZone: value(placement, 'availabilityZone') || null,
    architecture: value(node, 'architecture') || null,
    platform: value(node, 'platformDetails') || value(node, 'platform') || null,
    keyName: value(node, 'keyName') || null,
    reservationId: reservation.id || null,
    ownerId: reservation.ownerId || null,
    tags,
    securityGroups: items(node, 'groupSet').map((group) => ({ id: value(group, 'groupId'), name: value(group, 'groupName') })),
  };
}

export function parseInstancesXml(xml) {
  const root = parseXml(xml);
  const reservations = items(root, 'reservationSet').map((reservation) => {
    const info = { id: value(reservation, 'reservationId'), ownerId: value(reservation, 'ownerId') };
    return items(reservation, 'instancesSet').map((instance) => parseInstance(instance, info));
  });
  return { instances: reservations.flat(), nextToken: value(root, 'nextToken') || null };
}

export function parseImagesXml(xml) {
  const root = parseXml(xml);
  return {
    images: items(root, 'imagesSet').map((image) => ({
      id: value(image, 'imageId'),
      name: value(image, 'name') || '',
      description: value(image, 'description') || '',
      state: value(image, 'imageState') || 'unknown',
      architecture: value(image, 'architecture') || null,
      rootDeviceType: value(image, 'rootDeviceType') || null,
      virtualizationType: value(image, 'virtualizationType') || null,
      platform: value(image, 'platformDetails') || value(image, 'platform') || null,
    })),
    nextToken: value(root, 'nextToken') || null,
  };
}

function checkToken(token) {
  if (typeof token !== 'string' || token.length > 4096) throw new Ec2Error('Invalid pagination token');
  return token;
}

function checkInstanceIds(instanceIds) {
  if (!Array.isArray(instanceIds) || !instanceIds.length || instanceIds.length > 1000) throw new Ec2Error('Select at least one EC2 instance');
  const unique = [...new Set(instanceIds.map(String))];
  if (unique.some((id) => !/^i-[A-Za-z0-9]+$/.test(id))) throw new Ec2Error('Invalid EC2 instance ID');
  return unique;
}

export async function listInstances(nextToken = '', sendRequest = send) {
  const token = checkToken(String(nextToken || ''));
  if (sendRequest === send) {
    return instancesFromSdk(await ec2SdkCall(new DescribeInstancesCommand({ MaxResults: 100, ...(token ? { NextToken: token } : {}) })));
  }
  const xml = await ec2Call('DescribeInstances', { MaxResults: 100, NextToken: token }, sendRequest);
  return parseInstancesXml(xml);
}

export async function describeInstances(instanceIds, sendRequest = send) {
  const ids = checkInstanceIds(instanceIds);
  if (sendRequest === send) return instancesFromSdk(await ec2SdkCall(new DescribeInstancesCommand({ InstanceIds: ids })));
  const params = {};
  ids.forEach((id, index) => { params[`InstanceId.${index + 1}`] = id; });
  return parseInstancesXml(await ec2Call('DescribeInstances', params, sendRequest));
}

export async function listImages(nextToken = '', sendRequest = send) {
  const token = checkToken(String(nextToken || ''));
  if (sendRequest === send) {
    const output = await ec2SdkCall(new DescribeImagesCommand({ MaxResults: 100, ...(token ? { NextToken: token } : {}) }));
    return {
      images: (output.Images || []).map((image) => ({
        id: image.ImageId || '',
        name: image.Name || '',
        description: image.Description || '',
        state: image.State || 'unknown',
        architecture: image.Architecture || null,
        rootDeviceType: image.RootDeviceType || null,
        virtualizationType: image.VirtualizationType || null,
        platform: image.PlatformDetails || image.Platform || null,
      })),
      nextToken: output.NextToken || null,
    };
  }
  const xml = await ec2Call('DescribeImages', { MaxResults: 100, NextToken: token }, sendRequest);
  return parseImagesXml(xml);
}

function encodeUserData(value) {
  const supplied = String(value || '');
  if (!supplied) return undefined;
  const compact = supplied.replace(/\s/g, '');
  let script = supplied;
  const looksEncoded = !supplied.includes('\n') && !supplied.includes('\r') && !supplied.startsWith('#!')
    && compact.length >= 4 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)
    && (() => {
      const decoded = Buffer.from(compact, 'base64').toString('utf8');
      if (decoded.startsWith('#!') || decoded.includes('\n')) {
        script = decoded;
        return true;
      }
      return false;
    })();
  if (Buffer.byteLength(script) > 1024 * 1024) throw new Ec2Error('User data must be 1 MB or smaller');
  return looksEncoded ? compact : Buffer.from(script, 'utf8').toString('base64');
}

export async function runInstances(input, sendRequest = send) {
  const imageId = String(input?.imageId || '').trim();
  const instanceType = String(input?.instanceType || 't3.micro').trim();
  const suppliedName = String(input?.name ?? '');
  const hasName = suppliedName.trim().length > 0;
  const rawCount = input?.count ?? 1;
  const count = rawCount === '' ? Number.NaN : Number(rawCount);
  if (!imageId || imageId.length > 2048) throw new Ec2Error('AMI image ID is required');
  if (!/^[a-z0-9][a-z0-9.-]{1,30}$/.test(instanceType)) throw new Ec2Error('Invalid EC2 instance type');
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new Ec2Error('Instance count must be between 1 and 20');
  if (suppliedName.length > 256 || /[\r\n]/.test(suppliedName)) throw new Ec2Error('Instance name must be 256 characters or fewer');

  const userData = encodeUserData(input?.userData);
  if (sendRequest === send) {
    const output = await ec2SdkCall(new RunInstancesCommand({
      ImageId: imageId,
      InstanceType: instanceType,
      MinCount: count,
      MaxCount: count,
      ...(userData ? { UserData: Buffer.from(userData, 'base64') } : {}),
      ...(hasName ? { TagSpecifications: [{ ResourceType: 'instance', Tags: [{ Key: 'Name', Value: suppliedName }] }] } : {}),
    }));
    const reservation = { id: output.ReservationId || null, ownerId: output.OwnerId || null };
    const launched = (output.Instances || []).map((instance) => fromSdkInstance(instance, reservation));
    if (hasName) {
      launched.forEach((instance) => {
        if (!instance.name) instance.name = suppliedName;
        if (!instance.tags.some((tag) => tag.key === 'Name')) instance.tags.push({ key: 'Name', value: suppliedName });
      });
    }
    return { reservationId: reservation.id, instances: launched };
  }
  const xml = await ec2Call('RunInstances', {
    ImageId: imageId,
    InstanceType: instanceType,
    MinCount: count,
    MaxCount: count,
    UserData: userData,
    ...(hasName ? {
      'TagSpecification.1.ResourceType': 'instance',
      'TagSpecification.1.Tag.1.Key': 'Name',
      'TagSpecification.1.Tag.1.Value': suppliedName,
    } : {}),
  }, sendRequest);
  const root = parseXml(xml);
  const reservation = { id: value(root, 'reservationId'), ownerId: value(root, 'ownerId') };
  const launched = items(root, 'instancesSet').map((instance) => parseInstance(instance, reservation));
  if (hasName) {
    launched.forEach((instance) => {
      if (!instance.name) instance.name = suppliedName;
      if (!instance.tags.some((tag) => tag.key === 'Name')) instance.tags.push({ key: 'Name', value: suppliedName });
    });
  }
  return { reservationId: reservation.id, instances: launched };
}

export async function instanceAction(action, instanceIds, sendRequest = send) {
  const normalized = String(action || '').toLowerCase();
  if (!ACTIONS.has(normalized)) throw new Ec2Error('Unsupported EC2 instance action');
  const ids = checkInstanceIds(instanceIds);
  if (sendRequest === send) {
    const Command = { start: StartInstancesCommand, stop: StopInstancesCommand, reboot: RebootInstancesCommand, terminate: TerminateInstancesCommand }[normalized];
    await ec2SdkCall(new Command({ InstanceIds: ids }));
    return { ok: true, action: normalized, instanceIds: ids };
  }
  const params = {};
  ids.forEach((id, index) => { params[`InstanceId.${index + 1}`] = id; });
  const operation = { start: 'StartInstances', stop: 'StopInstances', reboot: 'RebootInstances', terminate: 'TerminateInstances' }[normalized];
  await ec2Call(operation, params, sendRequest);
  return { ok: true, action: normalized, instanceIds: ids };
}
