// Controls the emulator container through the docker CLI. Arguments are always passed as arrays (no shell).
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config, emulatorDir } from './config.js';

function run(args, { timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile('docker', args, { timeout, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr || err?.message || '') });
    });
  });
}

export async function status() {
  const info = await run(['info', '--format', '{{.ServerVersion}}'], { timeout: 8000 });
  if (!info.ok) {
    return { available: false, error: firstLine(info.stderr) || 'Docker is not available' };
  }
  const image = await run(['image', 'inspect', config.imageName, '--format', '{{.Id}}']);
  const container = await run(['inspect', config.containerName, '--format', '{{.State.Status}}']);
  return {
    available: true,
    version: info.stdout.trim(),
    imageExists: image.ok,
    container: container.ok ? container.stdout.trim() : null,
    running: container.ok && container.stdout.trim() === 'running',
  };
}

function firstLine(s) {
  return String(s).split(/\r?\n/).find((l) => l.trim()) || '';
}

// ----- image build (streams into an in-memory log) -----
const build = { running: false, lines: [], exitCode: null };

export function buildState() {
  return { running: build.running, exitCode: build.exitCode, log: build.lines.join('\n') };
}

export function buildImage() {
  if (build.running) return false;
  let dockerfile = fs.readFileSync(path.join(config.repoRoot, 'Dockerfile'), 'utf8');
  if (process.arch === 'arm64') dockerfile = dockerfile.replace('aws-emulator-x86_64.rpm', 'aws-emulator-aarch64.rpm');
  build.running = true;
  build.lines = [];
  build.exitCode = null;
  // The Dockerfile is piped on stdin, so no build context (this repo is large) is sent to the daemon.
  const child = spawn('docker', ['build', '--progress=plain', '-t', config.imageName, '-'], { windowsHide: true });
  const push = (d) => {
    build.lines.push(...String(d).split(/\r?\n/).filter(Boolean));
    if (build.lines.length > 2000) build.lines.splice(0, build.lines.length - 2000);
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('error', (e) => { push(`failed to start docker: ${e.message}`); build.running = false; build.exitCode = -1; });
  child.on('close', (code) => { build.running = false; build.exitCode = code; });
  child.stdin.end(dockerfile);
  return true;
}

export async function start() {
  const port = String(config.emulatorPort);
  fs.mkdirSync(config.emulatorHome, { recursive: true });
  // Never delete an existing container here: it may hold resources the user created earlier.
  const existing = await run(['inspect', config.containerName, '--format', '{{.State.Status}}']);
  if (existing.ok) {
    return { ok: false, stderr: `Container '${config.containerName}' already exists (${existing.stdout.trim()}). Use Resume, or Remove it first.` };
  }
  // No --rm: a stopped container is kept so it can be resumed with its data.
  return run([
    'run', '-d',
    '--name', config.containerName,
    '--memory=2g', '--memory-swap=2g',
    '-p', `127.0.0.1:${port}:${port}`,
    '-v', `${config.emulatorHome}:/home/emulator/.aws/emulator`,
    config.imageName, '-p', port,
  ]);
}

export function resume() {
  return run(['start', config.containerName], { timeout: 60_000 });
}
export function restart() {
  return run(['restart', config.containerName], { timeout: 90_000 });
}
export function remove() {
  return run(['rm', config.containerName]);
}
export function stop() {
  return run(['stop', config.containerName], { timeout: 60_000 });
}

export async function logs(tail = 200) {
  const n = Math.max(1, Math.min(2000, Number(tail) || 200));
  const r = await run(['logs', '--tail', String(n), config.containerName]);
  return r.ok ? (r.stdout + r.stderr) : r.stderr;
}

export { emulatorDir };
