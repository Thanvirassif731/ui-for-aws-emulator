import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MODES = new Set(['docker', 'native', 'external']);
const mode = String(process.env.EMULATOR_MODE || 'docker').toLowerCase();
if (!MODES.has(mode)) throw new Error('EMULATOR_MODE must be docker, native, or external');

export const config = {
  // Port of this UI's backend API.
  apiPort: Number(process.env.UI_API_PORT || 8787),
  // Vite dev server port (only used to allow its origin).
  webPort: Number(process.env.UI_WEB_PORT || 5173),
  // Loopback HTTP endpoint applications use to send observable SDK traffic.
  proxyPort: Number(process.env.UI_PROXY_PORT || 8790),
  // Loopback HTTP port of the S3 Learning Sandbox website endpoint (/s3-web/<bucket>/).
  // It is a separate origin on purpose: learner HTML must never run on the API origin.
  websitePort: Number(process.env.UI_WEBSITE_PORT || 8791),
  // Emulator endpoint.
  emulatorPort: Number(process.env.EMULATOR_PORT || 9297),
  emulatorHost: process.env.EMULATOR_HOST || '127.0.0.1',
  region: process.env.EMULATOR_REGION || 'us-east-1',
  // Optional portable snapshot restored once when this endpoint first becomes healthy.
  seedFile: process.env.EMULATOR_SEED_FILE || '',
  mode,
  // Native mode accepts an absolute path or a command available on PATH.
  emulatorBinary: process.env.EMULATOR_BINARY || 'aws-emulator',
  // Directory used by both the native process and container for generated runtime files.
  emulatorHome: process.env.EMULATOR_HOME || path.join(os.homedir(), '.aws', 'emulator'),
  // Optional checkout used for Smithy models and Docker builds. The default is the documented sibling checkout.
  repoRoot: process.env.EMULATOR_REPO || path.resolve(here, '..', '..', 'aws-emulator'),
  containerName: 'aws-emulator-ui',
  imageName: 'aws-emulator',
};

// Docker names the user can change from the UI. Persisted next to this file (git-ignored).
const settingsFile = path.join(here, 'settings.json');
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9_.\/:@-]{0,199}$/;
const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function setDockerNames({ imageName, containerName }) {
  const image = String(imageName ?? config.imageName).trim();
  const container = String(containerName ?? config.containerName).trim();
  if (!IMAGE_RE.test(image)) throw new NameError('Invalid image name or tag (example: my-emulator:dev)');
  if (!CONTAINER_RE.test(container)) throw new NameError('Invalid container name (letters, digits, _ . - only)');
  config.imageName = image;
  config.containerName = container;
  try { fs.writeFileSync(settingsFile, JSON.stringify({ imageName: image, containerName: container }, null, 2)); } catch { /* best effort */ }
}

export class NameError extends Error {}

try {
  const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  setDockerNames(saved);
} catch { /* no saved settings */ }

export function emulatorDir() {
  return path.join(config.emulatorHome, String(config.emulatorPort));
}
