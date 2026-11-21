// Starts an optional native AWS Emulator process. Only processes started by this UI can be stopped here.
import { spawn } from 'node:child_process';
import { config } from './config.js';

const state = {
  child: null,
  startedAt: null,
  exitCode: null,
  error: '',
  lines: [],
};

function push(data) {
  state.lines.push(...String(data).split(/\r?\n/).filter(Boolean));
  if (state.lines.length > 2000) state.lines.splice(0, state.lines.length - 2000);
}

export function status() {
  return {
    mode: config.mode,
    controllable: config.mode === 'native',
    binary: config.emulatorBinary,
    running: !!state.child,
    pid: state.child?.pid || null,
    startedAt: state.startedAt,
    exitCode: state.exitCode,
    error: state.error || null,
  };
}

export function start() {
  if (config.mode !== 'native') return { ok: false, error: 'Set EMULATOR_MODE=native to let the UI start a native process.' };
  if (state.child) return { ok: false, error: 'The native emulator process is already running.' };

  state.lines = [];
  state.exitCode = null;
  state.error = '';
  state.startedAt = Date.now();
  try {
    const child = spawn(config.emulatorBinary, ['-b', config.emulatorHost, '-p', String(config.emulatorPort)], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    state.child = child;
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (error) => {
      state.error = error.message;
      push(`failed to start native emulator: ${error.message}`);
      state.child = null;
    });
    child.on('close', (code) => {
      state.exitCode = code;
      state.child = null;
    });
    return { ok: true };
  } catch (error) {
    state.error = error.message;
    state.child = null;
    return { ok: false, error: error.message };
  }
}

export async function stop() {
  const child = state.child;
  if (!child) return { ok: false, error: 'No UI-managed native emulator process is running.' };
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'The native process did not stop within 10 seconds.' }), 10_000);
    child.once('close', () => { clearTimeout(timer); resolve({ ok: true }); });
    if (!child.kill('SIGTERM')) {
      clearTimeout(timer);
      resolve({ ok: false, error: 'Could not signal the native emulator process.' });
    }
  });
}

export function logs(tail = 300) {
  const count = Math.max(1, Math.min(2000, Number(tail) || 300));
  return state.lines.slice(-count).join('\n');
}
