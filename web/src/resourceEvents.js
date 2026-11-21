export const RESOURCE_REFRESH_EVENT = 'aws-emulator-ui:resources-changed';

export function refreshResourceViews() {
  window.dispatchEvent(new CustomEvent(RESOURCE_REFRESH_EVENT));
}
