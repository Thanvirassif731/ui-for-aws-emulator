export const DIALOG_EVENT = 'aws-emulator-ui:dialog';

let nextId = 0;

function clean(value, fallback = '') {
  const result = String(value ?? '').trim();
  return result || fallback;
}

export function confirmDialog(options = {}) {
  if (typeof window === 'undefined') return Promise.resolve(false);
  return new Promise((resolve) => {
    nextId += 1;
    window.dispatchEvent(new CustomEvent(DIALOG_EVENT, {
      detail: {
        id: nextId,
        title: clean(options.title, 'Confirm action'),
        message: clean(options.message, 'Are you sure you want to continue?'),
        confirmLabel: clean(options.confirmLabel, 'Confirm'),
        cancelLabel: clean(options.cancelLabel, 'Cancel'),
        tone: options.tone === 'default' ? 'default' : 'danger',
        resolve,
      },
    }));
  });
}
