import { awsJsonCall, ServiceError } from './aws-json.js';

const call = (operation, input) => awsJsonCall({ signingName: 'sqs', target: `AmazonSQS.${operation}`, input });
const requireQueue = (queueUrl) => {
  if (!queueUrl || typeof queueUrl !== 'string') throw new ServiceError('Queue URL is required');
  return queueUrl;
};

export async function listQueues() {
  const result = await call('ListQueues', { MaxResults: 1000 });
  return result.QueueUrls || [];
}

export async function queueAttributes(queueUrl) {
  const result = await call('GetQueueAttributes', { QueueUrl: requireQueue(queueUrl), AttributeNames: ['All'] });
  return result.Attributes || {};
}

export async function receiveMessages(queueUrl) {
  const result = await call('ReceiveMessage', {
    QueueUrl: requireQueue(queueUrl),
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 0,
    VisibilityTimeout: 0,
    MessageAttributeNames: ['All'],
    MessageSystemAttributeNames: ['All'],
  });
  return result.Messages || [];
}

export async function sendMessage(queueUrl, body) {
  if (typeof body !== 'string' || !body.length) throw new ServiceError('Message body is required');
  return call('SendMessage', { QueueUrl: queueUrl, MessageBody: body });
}

export async function deleteMessage(queueUrl, receiptHandle) {
  if (!receiptHandle) throw new ServiceError('Receipt handle is required');
  await call('DeleteMessage', { QueueUrl: queueUrl, ReceiptHandle: receiptHandle });
}

export async function purgeQueue(queueUrl) {
  await call('PurgeQueue', { QueueUrl: queueUrl });
}
