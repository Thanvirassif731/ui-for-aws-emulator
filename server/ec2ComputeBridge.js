import Docker from 'dockerode';
import { EventEmitter } from 'node:events';

const UBUNTU_PRESET = Object.freeze({
  image: 'ubuntu:24.04',
  command: ['sleep', 'infinity'],
  shell: '/bin/bash',
  privileged: false,
});
const DOCKER_PRESET = Object.freeze({
  image: 'docker:27.5.1-dind',
  command: ['dockerd'],
  shell: '/bin/sh',
  privileged: true,
});

export const AMI_PRESETS = Object.freeze({
  // Canonical IDs satisfy EC2's ami- plus 17 lowercase hexadecimal digit contract.
  'ami-02404000000000001': UBUNTU_PRESET,
  'ami-0d0cce00000000001': DOCKER_PRESET,
  // Friendly aliases keep direct bridge callers and older saved launch forms compatible.
  'ami-ubuntu-24.04': UBUNTU_PRESET,
  'ami-ubuntu-docker': DOCKER_PRESET,
});

export const INSTANCE_RESOURCES = Object.freeze({
  't2.micro': { NanoCpus: 1e9, Memory: 1024 * 1024 * 1024 },
  't3.micro': { NanoCpus: 1e9, Memory: 1024 * 1024 * 1024 },
  't3.small': { NanoCpus: 2e9, Memory: 2048 * 1024 * 1024 },
});

const MANAGED_BY = 'aws-emulator-ui';
const MAX_USER_DATA_BYTES = 1024 * 1024;
const INSTANCE_ID_RE = /^i-[A-Za-z0-9]+$/;
const activePulls = new Map();

export const computeBridgeEvents = new EventEmitter();
export const docker = new Docker();

export class ComputeBridgeError extends Error {
  constructor(message, code = 'COMPUTE_BRIDGE_ERROR') {
    super(message);
    this.name = 'ComputeBridgeError';
    this.code = code;
  }
}

function friendlyDockerError(error) {
  const message = String(error?.reason || error?.message || error || '').trim();
  if (/ENOENT|connect ENOENT|pipe\/docker_engine|docker\.sock/i.test(message)) {
    return 'Docker Desktop is not running. Start Docker Desktop to enable local compute.';
  }
  if (/ECONNREFUSED|connect refused/i.test(message)) {
    return 'The Docker daemon refused the connection. Start or restart Docker Desktop.';
  }
  if (/permission denied|EACCES/i.test(message)) {
    return 'The UI cannot access the Docker daemon. Check Docker socket permissions.';
  }
  return message ? `Docker is unavailable: ${message}` : 'Docker is unavailable. Start Docker Desktop to enable local compute.';
}

export async function dockerStatus(client = docker) {
  try {
    await client.ping();
    return { available: true };
  } catch (error) {
    return { available: false, reason: friendlyDockerError(error) };
  }
}

export async function isDockerAvailable(client = docker) {
  return (await dockerStatus(client)).available;
}

export function containerName(instanceId) {
  const id = String(instanceId || '');
  if (!INSTANCE_ID_RE.test(id)) throw new ComputeBridgeError('Invalid EC2 instance ID.', 'INVALID_INSTANCE_ID');
  return `aws-emu-ec2-${id}`;
}

function numberPort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ComputeBridgeError(`${label} must be between 1 and 65535.`, 'INVALID_PORT_MAPPING');
  }
  return port;
}

/** Accepts "8080:80", comma/newline-separated values, or mapping objects. */
export function parsePortMappings(input) {
  if (input === undefined || input === null || input === '') return [];
  const entries = Array.isArray(input) ? input : String(input).split(/[\s,]+/).filter(Boolean);
  const mappings = entries.map((entry) => {
    if (entry && typeof entry === 'object') {
      const protocol = String(entry.protocol || 'tcp').toLowerCase();
      if (!['tcp', 'udp'].includes(protocol)) throw new ComputeBridgeError('Port protocol must be tcp or udp.', 'INVALID_PORT_MAPPING');
      return {
        hostPort: numberPort(entry.hostPort, 'Host port'),
        containerPort: numberPort(entry.containerPort, 'Container port'),
        protocol,
      };
    }
    const match = String(entry).match(/^(\d+):(\d+)(?:\/(tcp|udp))?$/i);
    if (!match) throw new ComputeBridgeError('Use host:container port mappings, for example 8080:80.', 'INVALID_PORT_MAPPING');
    return {
      hostPort: numberPort(match[1], 'Host port'),
      containerPort: numberPort(match[2], 'Container port'),
      protocol: (match[3] || 'tcp').toLowerCase(),
    };
  });
  const keys = new Set();
  for (const mapping of mappings) {
    const key = `${mapping.containerPort}/${mapping.protocol}`;
    if (keys.has(key)) throw new ComputeBridgeError(`Container port ${key} is mapped more than once.`, 'INVALID_PORT_MAPPING');
    keys.add(key);
  }
  return mappings;
}

export function decodeUserData(value) {
  const supplied = String(value || '');
  if (!supplied) return '';
  let script = supplied;
  if (!supplied.includes('\n') && !supplied.includes('\r') && !supplied.startsWith('#!')) {
    const compact = supplied.replace(/\s/g, '');
    if (compact.length >= 4 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
      const decoded = Buffer.from(compact, 'base64').toString('utf8');
      if (decoded.startsWith('#!') || decoded.includes('\n')) script = decoded;
    }
  }
  if (Buffer.byteLength(script) > MAX_USER_DATA_BYTES) {
    throw new ComputeBridgeError('User data must be 1 MB or smaller.', 'USER_DATA_TOO_LARGE');
  }
  return script.replace(/\r\n/g, '\n');
}

async function ensureImage(image, client) {
  try {
    await client.getImage(image).inspect();
    return;
  } catch (error) {
    if (error?.statusCode !== 404) throw error;
  }

  if (!activePulls.has(image)) {
    activePulls.set(image, new Promise((resolve, reject) => {
      client.pull(image, (pullError, stream) => {
        if (pullError) return reject(pullError);
        client.modem.followProgress(stream, (error, output) => {
          if (error) reject(error);
          else resolve(output);
        }, (event) => computeBridgeEvents.emit('pull-progress', { image, ...event }));
      });
    }).finally(() => activePulls.delete(image)));
  }
  try {
    await activePulls.get(image);
  } catch (error) {
    throw new ComputeBridgeError(`Docker could not pull ${image}: ${error.message}`, 'IMAGE_PULL_FAILED');
  }
}

function portConfig(mappings) {
  const ExposedPorts = {};
  const PortBindings = {};
  for (const mapping of mappings) {
    const key = `${mapping.containerPort}/${mapping.protocol}`;
    ExposedPorts[key] = {};
    PortBindings[key] = [{ HostIp: '127.0.0.1', HostPort: String(mapping.hostPort) }];
  }
  return { ExposedPorts, PortBindings };
}

async function writeUserData(container, script, shell) {
  if (!script) return;
  const writer = await container.exec({
    Cmd: [shell, '-c', 'mkdir -p /var/lib/cloud/instance /var/log && cat > /var/lib/cloud/instance/user-data.sh && chmod 700 /var/lib/cloud/instance/user-data.sh'],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await writer.start({ hijack: true, stdin: true });
  await new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.once('end', resolve);
    stream.end(script);
  });

  const runner = await container.exec({
    Cmd: [shell, '-c', `nohup ${shell} /var/lib/cloud/instance/user-data.sh > /var/log/cloud-init-output.log 2>&1 < /dev/null &`],
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
  });
  await runner.start({ Detach: true });
}

async function findManagedContainer(instanceId, client, { allowMissing = false } = {}) {
  const name = containerName(instanceId);
  const container = client.getContainer(name);
  try {
    const details = await container.inspect();
    if (details.Config?.Labels?.['managed-by'] !== MANAGED_BY || details.Config?.Labels?.['ec2-instance-id'] !== instanceId) {
      throw new ComputeBridgeError(`Container ${name} exists but is not managed by this UI.`, 'CONTAINER_NAME_CONFLICT');
    }
    return { container, details };
  } catch (error) {
    if (allowMissing && error?.statusCode === 404) return null;
    if (error?.statusCode === 404) {
      throw new ComputeBridgeError(`No local sandbox exists for ${instanceId}. Launch it while Docker is active.`, 'CONTAINER_NOT_FOUND');
    }
    throw error;
  }
}

function metadataOnly(reason) {
  return { available: false, mode: 'metadata-only', reason };
}

async function requireDocker(client) {
  const status = await dockerStatus(client);
  return status.available ? null : metadataOnly(status.reason);
}

export async function launchComputeInstance(input, client = docker) {
  const instanceId = String(input?.instanceId || '');
  containerName(instanceId);
  const unavailable = await requireDocker(client);
  if (unavailable) return { ...unavailable, instanceId };

  const name = containerName(instanceId);
  const preset = AMI_PRESETS[String(input?.amiId || '')];
  if (!preset) {
    return { available: true, mode: 'metadata-only', state: 'absent', error: `AMI ${String(input?.amiId || '(missing)')} has no local Docker image mapping. Choose a Local Docker AMI preset to launch a live sandbox.`, instanceId };
  }
  const resources = INSTANCE_RESOURCES[String(input?.instanceType || '')];
  if (!resources) {
    return { available: true, mode: 'metadata-only', state: 'absent', error: `Instance type ${String(input?.instanceType || '(missing)')} has no local resource mapping. Choose t2.micro, t3.micro, or t3.small.`, instanceId };
  }
  const mappings = parsePortMappings(input?.portMappings);
  const userData = decodeUserData(input?.userData);
  if (preset.privileged && input?.allowPrivileged !== true) {
    throw new ComputeBridgeError('The Docker-in-Docker AMI requires explicit approval because it runs a privileged local container.', 'PRIVILEGED_APPROVAL_REQUIRED');
  }
  await ensureImage(preset.image, client);

  const held = await findManagedContainer(instanceId, client, { allowMissing: true });
  if (held) {
    if (held.details.State?.Running) return { available: true, instanceId, containerName: name, state: 'running', reused: true };
    await held.container.remove({ force: true });
  }

  const ports = portConfig(mappings);
  let container;
  try {
    container = await client.createContainer({
      name,
      Image: preset.image,
      Cmd: preset.command,
      Labels: { 'managed-by': MANAGED_BY, 'ec2-instance-id': instanceId },
      ExposedPorts: ports.ExposedPorts,
      HostConfig: {
        ...resources,
        MemorySwap: resources.Memory,
        PortBindings: ports.PortBindings,
        Privileged: preset.privileged,
      },
    });
    await container.start();
    await writeUserData(container, userData, preset.shell);
    return {
      available: true,
      instanceId,
      containerName: name,
      image: preset.image,
      state: 'running',
      ports: mappings,
    };
  } catch (error) {
    if (container) await container.remove({ force: true }).catch(() => {});
    if (/port is already allocated|address already in use/i.test(error.message)) {
      throw new ComputeBridgeError('A requested host port is already in use. Choose another host port and launch a new instance.', 'PORT_IN_USE');
    }
    throw new ComputeBridgeError(`The EC2 metadata was created, but its local container could not start: ${error.message}`, 'CONTAINER_START_FAILED');
  }
}

async function runContainerAction(instanceId, action, client = docker) {
  const normalizedId = String(instanceId || '');
  containerName(normalizedId);
  const unavailable = await requireDocker(client);
  if (unavailable) return { ...unavailable, instanceId: normalizedId };
  const held = await findManagedContainer(normalizedId, client, { allowMissing: true });
  if (!held) return {
    available: true,
    instanceId: normalizedId,
    state: 'absent',
    ...(action === 'remove' ? {} : { error: `No local sandbox exists for ${normalizedId}. Launch a new instance while Docker is active.` }),
  };
  if (action === 'start' && !held.details.State?.Running) await held.container.start();
  if (action === 'stop' && held.details.State?.Running) await held.container.stop({ t: 10 });
  if (action === 'restart' && held.details.State?.Running) await held.container.restart({ t: 10 });
  if (action === 'remove') await held.container.remove({ force: true });
  return { available: true, instanceId: normalizedId, containerName: containerName(normalizedId), state: action === 'remove' ? 'absent' : action === 'stop' ? 'stopped' : 'running' };
}

export const stopComputeInstance = (instanceId, client = docker) => runContainerAction(instanceId, 'stop', client);
export const startComputeInstance = (instanceId, client = docker) => runContainerAction(instanceId, 'start', client);
export const rebootComputeInstance = (instanceId, client = docker) => runContainerAction(instanceId, 'restart', client);
export const terminateComputeInstance = (instanceId, client = docker) => runContainerAction(instanceId, 'remove', client);

export async function reconcileInstances(emulatorInstances, client = docker, { removeOrphans = false } = {}) {
  const unavailable = await requireDocker(client);
  if (unavailable) return unavailable;
  const byId = new Map((Array.isArray(emulatorInstances) ? emulatorInstances : []).map((instance) => [instance.id, instance]));
  const containers = await client.listContainers({ all: true, filters: { label: [`managed-by=${MANAGED_BY}`] } });
  const results = [];
  for (const summary of containers) {
    const instanceId = summary.Labels?.['ec2-instance-id'];
    if (!instanceId) continue;
    const instance = byId.get(instanceId);
    try {
      if (!instance && removeOrphans) results.push(await terminateComputeInstance(instanceId, client));
      else if (instance && ['terminated', 'shutting-down'].includes(instance.state)) results.push(await terminateComputeInstance(instanceId, client));
      else if (instance && ['stopped', 'stopping'].includes(instance.state) && summary.State === 'running') results.push(await stopComputeInstance(instanceId, client));
      else if (instance?.state === 'running' && summary.State !== 'running') results.push(await startComputeInstance(instanceId, client));
    } catch (error) {
      results.push({ available: true, instanceId, error: error.message });
    }
  }
  const currentContainers = await client.listContainers({ all: true, filters: { label: [`managed-by=${MANAGED_BY}`] } });
  const states = new Map(currentContainers.map((summary) => [summary.Labels?.['ec2-instance-id'], summary.State || 'unknown']));
  return {
    available: true,
    results,
    instances: (Array.isArray(emulatorInstances) ? emulatorInstances : []).map((instance) => ({
      available: true,
      instanceId: instance.id,
      state: states.get(instance.id) || 'absent',
    })),
  };
}

export async function getRunningContainer(instanceId, client = docker) {
  const status = await dockerStatus(client);
  if (!status.available) throw new ComputeBridgeError(status.reason, 'DOCKER_UNAVAILABLE');
  const held = await findManagedContainer(String(instanceId || ''), client);
  if (!held.details.State?.Running) {
    throw new ComputeBridgeError(`The local sandbox for ${instanceId} is stopped. Start the EC2 instance before connecting.`, 'CONTAINER_NOT_RUNNING');
  }
  return held.container;
}
