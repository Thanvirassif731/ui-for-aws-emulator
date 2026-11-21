export const NOTIFICATION_EVENT = 'aws-emulator-ui:notification';

const TYPES = new Set(['info', 'success', 'warning', 'error']);
const reportedErrors = new WeakSet();

function text(value, fallback = '') {
  const result = String(value ?? '').trim();
  return result || fallback;
}

export function notificationDetail(input = {}) {
  const type = TYPES.has(input.type) ? input.type : 'info';
  return {
    type,
    title: text(input.title, type === 'error' ? 'Something went wrong' : 'Notification'),
    message: text(input.message),
    source: text(input.source),
  };
}

export function notify(input) {
  const detail = notificationDetail(input);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(NOTIFICATION_EVENT, { detail }));
  return detail;
}

export function notifySuccess(message, options = {}) {
  return notify({ type: 'success', title: options.title || 'Action completed', message, source: options.source });
}

export function notifyWarning(message, options = {}) {
  return notify({ type: 'warning', title: options.title || 'Attention needed', message, source: options.source });
}

export function notifyError(error, options = {}) {
  if (error && typeof error === 'object') {
    if (reportedErrors.has(error)) return null;
    reportedErrors.add(error);
  }
  const message = error instanceof Error ? error.message : text(error, 'An unexpected error occurred.');
  return notify({ type: 'error', title: options.title || 'Action failed', message, source: options.source });
}
