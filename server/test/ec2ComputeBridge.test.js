import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeUserData,
  AMI_PRESETS,
  INSTANCE_RESOURCES,
  isDockerAvailable,
  launchComputeInstance,
  parsePortMappings,
  reconcileInstances,
} from '../ec2ComputeBridge.js';

test('Docker health check returns false without throwing', async () => {
  assert.equal(await isDockerAvailable({ ping: async () => { throw Object.assign(new Error('connect ENOENT //./pipe/docker_engine'), { code: 'ENOENT' }); } }), false);
  assert.equal(await isDockerAvailable({ ping: async () => 'OK' }), true);
});

test('local AMI presets include emulator-compatible canonical IDs', () => {
  assert.equal(AMI_PRESETS['ami-02404000000000001'].image, 'ubuntu:24.04');
  assert.equal(AMI_PRESETS['ami-0d0cce00000000001'].image, 'docker:27.5.1-dind');
  assert.match('ami-02404000000000001', /^ami-0[0-9a-f]{16}$/);
  assert.match('ami-0d0cce00000000001', /^ami-0[0-9a-f]{16}$/);
});

test('port mappings accept host:container syntax and reject unsafe values', () => {
  assert.deepEqual(parsePortMappings('8080:80, 5353:53/udp'), [
    { hostPort: 8080, containerPort: 80, protocol: 'tcp' },
    { hostPort: 5353, containerPort: 53, protocol: 'udp' },
  ]);
  assert.throws(() => parsePortMappings('70000:80'), /between 1 and 65535/);
  assert.throws(() => parsePortMappings('80'), /host:container/);
});

test('user data accepts plain text and base64 scripts', () => {
  const script = '#!/bin/bash\necho ready\n';
  assert.equal(decodeUserData(script), script);
  assert.equal(decodeUserData(Buffer.from(script).toString('base64')), script);
});

test('launch maps AMI, instance resources, labels, and loopback ports', async () => {
  let createOptions;
  let started = false;
  const missing = Object.assign(new Error('not found'), { statusCode: 404 });
  const container = {
    start: async () => { started = true; },
    remove: async () => {},
  };
  const client = {
    ping: async () => 'OK',
    getImage: () => ({ inspect: async () => ({ Id: 'sha256:image' }) }),
    getContainer: () => ({ inspect: async () => { throw missing; } }),
    createContainer: async (options) => { createOptions = options; return container; },
  };

  const result = await launchComputeInstance({
    instanceId: 'i-00000001',
    amiId: 'ami-ubuntu-24.04',
    instanceType: 't3.small',
    portMappings: '8080:80',
  }, client);

  assert.equal(started, true);
  assert.equal(result.available, true);
  assert.equal(createOptions.name, 'aws-emu-ec2-i-00000001');
  assert.equal(createOptions.Image, 'ubuntu:24.04');
  assert.deepEqual(createOptions.Cmd, ['sleep', 'infinity']);
  assert.deepEqual(createOptions.Labels, { 'managed-by': 'aws-emulator-ui', 'ec2-instance-id': 'i-00000001' });
  assert.equal(createOptions.HostConfig.NanoCpus, INSTANCE_RESOURCES['t3.small'].NanoCpus);
  assert.equal(createOptions.HostConfig.Memory, 2 * 1024 * 1024 * 1024);
  assert.deepEqual(createOptions.HostConfig.PortBindings['80/tcp'], [{ HostIp: '127.0.0.1', HostPort: '8080' }]);
});

test('Docker-in-Docker requires explicit privileged-container approval', async () => {
  await assert.rejects(() => launchComputeInstance({
    instanceId: 'i-00000001',
    amiId: 'ami-0d0cce00000000001',
    instanceType: 't3.micro',
  }, { ping: async () => 'OK' }), /explicit approval/);
});

test('reconciliation mirrors stopped metadata and reports per-instance state', async () => {
  let state = 'running';
  const details = () => ({
    Config: { Labels: { 'managed-by': 'aws-emulator-ui', 'ec2-instance-id': 'i-00000001' } },
    State: { Running: state === 'running' },
  });
  const client = {
    ping: async () => 'OK',
    listContainers: async () => [{ Labels: { 'managed-by': 'aws-emulator-ui', 'ec2-instance-id': 'i-00000001' }, State: state }],
    getContainer: () => ({
      inspect: async () => details(),
      stop: async () => { state = 'exited'; },
    }),
  };
  const result = await reconcileInstances([{ id: 'i-00000001', state: 'stopped' }], client);
  assert.equal(state, 'exited');
  assert.deepEqual(result.instances, [{ available: true, instanceId: 'i-00000001', state: 'exited' }]);
});

test('launch falls back to metadata-only mode when Docker is offline', async () => {
  const result = await launchComputeInstance({ instanceId: 'i-00000001', amiId: 'ami-ubuntu-24.04', instanceType: 't3.micro' }, {
    ping: async () => { throw new Error('connect refused'); },
  });
  assert.equal(result.available, false);
  assert.equal(result.mode, 'metadata-only');
  assert.match(result.reason, /Docker daemon refused/i);
});
