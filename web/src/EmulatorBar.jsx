import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import Icon from './Icon.jsx';
import NotificationCenter from './NotificationCenter.jsx';
import SnapshotControls from './SnapshotControls.jsx';
import { confirmDialog } from './dialogs.js';
import { notifyError, notifySuccess } from './notifications.js';
import logoUrl from '../assets/aws-logo.png';

const ACTION_MESSAGES = {
  names: 'Docker image and container names saved.',
  start: 'Emulator started.',
  resume: 'Emulator container resumed.',
  restart: 'Emulator restarted.',
  stop: 'Emulator stopped.',
  remove: 'Emulator container removed.',
};

export default function EmulatorBar() {
  const [st, setSt] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState('');
  const [imageName, setImageName] = useState('');
  const [containerName, setContainerName] = useState('');
  const namesLoaded = useRef(false);
  const timer = useRef();
  const buildWasRunning = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const s = await api.status();
      if (buildWasRunning.current && !s.build.running && s.build.exitCode !== null) {
        if (s.build.exitCode === 0) notifySuccess('Docker image built successfully.', { title: 'Image ready', source: 'Docker' });
        else {
          const detail = s.build.log.split('\n').filter(Boolean).slice(-4).join('\n');
          notifyError(detail || `Docker exited with code ${s.build.exitCode}.`, { title: 'Image build failed', source: 'Docker' });
        }
      }
      buildWasRunning.current = !!s.build.running;
      setSt(s);
      if (!namesLoaded.current && s.names) {
        setImageName(s.names.imageName);
        setContainerName(s.names.containerName);
        namesLoaded.current = true;
      }
      setErr('');
    } catch (e) {
      setSt(null);
      setErr(e.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    timer.current = setInterval(refresh, 3000);
    return () => clearInterval(timer.current);
  }, [refresh]);

  useEffect(() => {
    if (!showLogs) return undefined;
    const load = () => api.logs().then((r) => setLogs(r.logs)).catch((e) => setLogs(e.message));
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [showLogs]);

  const act = async (name, fn) => {
    setBusy(name);
    setErr('');
    try {
      await fn();
      if (ACTION_MESSAGES[name]) notifySuccess(ACTION_MESSAGES[name], { source: 'Emulator' });
    } catch (e) {
      setErr(e.message);
      notifyError(e, { title: 'Emulator action failed', source: 'Emulator' });
    }
    setBusy('');
    refresh();
  };

  const namesDirty = !!st?.names && (imageName.trim() !== st.names.imageName || containerName.trim() !== st.names.containerName);
  const saveNames = () => act('names', () => api.saveNames({ imageName, containerName }));
  const withNames = (fn) => async () => { if (namesDirty) await api.saveNames({ imageName, containerName }); return fn(); };
  const removeContainer = async () => {
    const confirmed = await confirmDialog({
      title: 'Remove emulator container?',
      message: `Container “${st.names.containerName}” will be deleted. Data stored only inside the container will be lost.`,
      confirmLabel: 'Remove container',
    });
    if (confirmed) act('remove', api.remove);
  };
  const dock = st?.docker;
  const native = st?.native;
  const healthy = st?.health?.ok;
  let label = 'UI server unreachable';
  let tone = 'bad';
  if (st) {
    if (healthy) { label = `Emulator running on ${st.host}:${st.port}`; tone = 'good'; }
    else if (st.mode === 'external') { label = `Waiting for external emulator on ${st.host}:${st.port}`; tone = 'warn'; }
    else if (st.mode === 'native') {
      label = native?.running ? 'Native emulator starting…' : 'Native emulator stopped';
      tone = native?.error ? 'bad' : 'warn';
    } else if (!dock?.available) { label = 'Docker not available'; tone = 'bad'; }
    else if (dock.running) { label = 'Emulator starting…'; tone = 'warn'; }
    else if (dock.container) { label = `Container '${st.names.containerName}' is ${dock.container}`; tone = 'warn'; }
    else if (!dock.imageExists) { label = 'Image not found'; tone = 'warn'; }
    else { label = 'Emulator stopped'; tone = 'warn'; }
  }

  return (
    <header className="bar">
      <div className="brand"><span className="brand-mark"><img src={logoUrl} alt="" /></span><span>AWS Emulator <small>UI</small></span></div>
      <div className={`pill ${tone}`}><span className="dot" />{label}</div>
      {st && healthy && !st.authCredentials && <span className="auth-note"><Icon name="lock" size={13} />Requests unsigned</span>}
      <div className="spacer" />
      {st?.mode === 'docker' && (
        <div className="runtime-fields">
          <label className="control-label"><span>Image</span><input value={imageName} onChange={(e) => setImageName(e.target.value)} placeholder="aws-emulator:latest or image ID" size={24} disabled={st.build.running || dock?.running} /></label>
          <label className="control-label"><span>Container</span><input value={containerName} onChange={(e) => setContainerName(e.target.value)} placeholder="aws-emulator-ui" size={16} disabled={st.build.running} /></label>
          {namesDirty && <button disabled={!!busy} onClick={saveNames}>Apply</button>}
        </div>
      )}
      {st?.mode === 'native' && !native?.running && <span className="auth-note mono" title={native?.binary}>{native?.binary}</span>}
      {st?.mode === 'native' && !native?.running && <button className="primary" disabled={!!busy} onClick={() => act('start', api.start)}>Start native</button>}
      {st?.mode === 'native' && native?.running && <button disabled={!!busy} onClick={() => act('stop', api.stop)}>Stop native</button>}
      {st && dock?.available && !dock.running && (
        <button disabled={st.build.running} onClick={() => act('build', withNames(api.build))}>
          {st.build.running ? 'Building image…' : dock.imageExists ? 'Rebuild image' : 'Build image'}
        </button>
      )}
      {st && dock?.available && dock.container && !dock.running && (
        <>
          <button className="primary" disabled={!!busy} title="Start the existing container again and keep its data" onClick={() => act('resume', withNames(api.resume))}>Resume</button>
          <button disabled={!!busy} title="Delete this stopped container" onClick={removeContainer}>Remove</button>
        </>
      )}
      {st && dock?.available && !dock.container && (
        <button className="primary" disabled={!!busy || st.build.running || !dock.imageExists} title={dock.imageExists ? 'Run a container from this image' : 'Image not found. Build it or enter an existing image name/tag/ID'} onClick={() => act('start', withNames(api.start))}>Start</button>
      )}
      {st && dock?.running && <button disabled={!!busy} onClick={() => act('restart', api.restart)}>Restart</button>}
      {st && dock?.running && <button disabled={!!busy} onClick={() => act('stop', api.stop)}>Stop</button>}
      <SnapshotControls disabled={!healthy} />
      <button onClick={() => setShowLogs((v) => !v)}>{showLogs ? 'Hide logs' : 'Logs'}</button>
      <NotificationCenter />
      {(err || (st?.mode === 'docker' && !dock?.available && dock?.error) || native?.error) && <div className="bar-error">{err || dock?.error || native?.error}</div>}
      {st?.build && (st.build.running || (st.build.exitCode !== null && !dock?.imageExists)) && (
        <pre className="bar-log">{st.build.log.split('\n').slice(-12).join('\n')}</pre>
      )}
      {showLogs && <pre className="bar-log big">{logs || '(no output)'}</pre>}
    </header>
  );
}
