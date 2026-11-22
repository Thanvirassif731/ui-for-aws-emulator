import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeInstances, Ec2Error, instanceAction, listInstances, parseInstancesXml, runInstances } from '../ec2.js';

const describeXml = `<?xml version="1.0"?>
<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <reservationSet><item><reservationId>r-0001</reservationId><ownerId>000000000000</ownerId>
    <instancesSet><item>
      <instanceId>i-00000000000000001</instanceId><imageId>ami-00000001</imageId><instanceType>t3.micro</instanceType>
      <instanceState><code>16</code><name>running</name></instanceState>
      <privateIpAddress>10.0.0.5</privateIpAddress><subnetId>subnet-1</subnetId><vpcId>vpc-1</vpcId>
      <placement><availabilityZone>us-east-1a</availabilityZone></placement>
      <tagSet><item><key>Name</key><value>web &amp; api</value></item><item><key>team</key><value>dev</value></item></tagSet>
      <groupSet><item><groupId>sg-1</groupId><groupName>default</groupName></item></groupSet>
    </item></instancesSet>
  </item></reservationSet><nextToken>next-page</nextToken>
</DescribeInstancesResponse>`;

test('EC2 response parser preserves nested reservation, instance, tag, and group sets', () => {
  const result = parseInstancesXml(describeXml);
  assert.equal(result.nextToken, 'next-page');
  assert.equal(result.instances.length, 1);
  assert.deepEqual(result.instances[0], {
    id: 'i-00000000000000001', name: 'web & api', imageId: 'ami-00000001', instanceType: 't3.micro',
    state: 'running', stateCode: 16, launchTime: null, privateIpAddress: '10.0.0.5', privateDnsName: null,
    publicIpAddress: null, publicDnsName: null, subnetId: 'subnet-1', vpcId: 'vpc-1', availabilityZone: 'us-east-1a',
    architecture: null, platform: null, keyName: null, reservationId: 'r-0001', ownerId: '000000000000',
    tags: [{ key: 'Name', value: 'web & api' }, { key: 'team', value: 'dev' }],
    securityGroups: [{ id: 'sg-1', name: 'default' }],
  });
});

test('EC2 instance listing sends a signed paginated EC2 Query request', async () => {
  let request;
  const result = await listInstances('cursor', async (input) => {
    request = input;
    return { status: 200, bodyEncoding: 'utf8', body: describeXml };
  });
  const params = new URLSearchParams(request.body);
  assert.equal(request.signingName, 'ec2');
  assert.equal(params.get('Action'), 'DescribeInstances');
  assert.equal(params.get('Version'), '2016-11-15');
  assert.equal(params.get('MaxResults'), '100');
  assert.equal(params.get('NextToken'), 'cursor');
  assert.equal(result.instances[0].id, 'i-00000000000000001');
});

test('EC2 targeted refresh omits MaxResults when instance IDs are supplied', async () => {
  let request;
  await describeInstances(['i-00000000000000001'], async (input) => {
    request = input;
    return { status: 200, bodyEncoding: 'utf8', body: describeXml };
  });
  const params = new URLSearchParams(request.body);
  assert.equal(params.get('InstanceId.1'), 'i-00000000000000001');
  assert.equal(params.has('MaxResults'), false);
});

test('EC2 launch applies an optional Name tag atomically in RunInstances', async () => {
  const requests = [];
  const runXml = `<RunInstancesResponse><reservationId>r-1</reservationId><ownerId>000000000000</ownerId><instancesSet><item><instanceId>i-00000001</instanceId><imageId>ami-1</imageId><instanceType>t3.micro</instanceType><instanceState><code>0</code><name>pending</name></instanceState></item><item><instanceId>i-00000002</instanceId><imageId>ami-1</imageId><instanceType>t3.micro</instanceType><instanceState><code>0</code><name>pending</name></instanceState></item></instancesSet></RunInstancesResponse>`;
  const result = await runInstances({ imageId: 'ami-1', instanceType: 't3.micro', count: 2, name: 'workers', userData: '#!/bin/bash\necho ready' }, async (request) => {
    requests.push(new URLSearchParams(request.body));
    return { status: 200, bodyEncoding: 'utf8', body: runXml };
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].get('Action'), 'RunInstances');
  assert.equal(requests[0].get('MinCount'), '2');
  assert.equal(requests[0].get('TagSpecification.1.ResourceType'), 'instance');
  assert.equal(requests[0].get('TagSpecification.1.Tag.1.Key'), 'Name');
  assert.equal(requests[0].get('TagSpecification.1.Tag.1.Value'), 'workers');
  assert.equal(Buffer.from(requests[0].get('UserData'), 'base64').toString('utf8'), '#!/bin/bash\necho ready');
  assert.equal(result.instances[1].name, 'workers');
});

test('EC2 launch rejects an explicit zero count before sending', async () => {
  let sent = false;
  await assert.rejects(() => runInstances({ imageId: 'ami-1', count: 0 }, async () => { sent = true; }), /between 1 and 20/);
  assert.equal(sent, false);
});

test('EC2 lifecycle actions reject unsupported actions before sending', async () => {
  let sent = false;
  await assert.rejects(() => instanceAction('delete', ['i-00000001'], async () => { sent = true; }), Ec2Error);
  assert.equal(sent, false);
});
