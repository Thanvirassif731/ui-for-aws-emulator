import { send } from './emulator.js';

export class ServiceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export async function awsJsonCall({ signingName, target, input = {} }) {
  let response;
  try {
    response = await send({
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-amz-json-1.0',
        'X-Amz-Target': target,
      },
      body: JSON.stringify(input),
      signingName,
    });
  } catch (error) {
    throw new ServiceError(error.code === 'ECONNREFUSED' ? 'Cannot connect to the emulator. Is it running?' : error.message, 502);
  }
  let data = {};
  try { data = response.body ? JSON.parse(response.body) : {}; } catch { data = { message: response.body }; }
  if (response.status >= 400) {
    throw new ServiceError(data.message || data.Message || data.__type || `${signingName} returned ${response.status}`, response.status);
  }
  return data;
}
