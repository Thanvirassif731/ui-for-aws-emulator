import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import Icon from './Icon.jsx';
import logoUrl from '../assets/aws-logo.png';

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

  const refresh = useCallback(async () => {
    try {
      const s = await api.status();
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
    try { await fn(); } catch (e) { setErr(e.message); }
    setBusy('');
    refresh();
  };

  const namesDirty = !!st?.names && (imageName.trim() !== st.names.imageName || containerName.trim() !== st.names.containerName);
  const saveNames = () => act('names', () => api.saveNames({ imageName, containerName }));
  const withNames = (fn) => async () => { if (namesDirty) await api.saveNames({ imageName, containerName }); return fn(); };
  const dock = st?.docker;
  const healthy = st?.health?.ok;
  let label = 'UI server unreachable';
  let tone = 'bad';
  if (st) {
    if (healthy) { label = `Emulator running on :${st.port}`; tone = 'good'; }
    else if (!dock?.available) { label = 'Docker not available'; tone = 'bad'; }
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
      {st && (
        <div className="runtime-fields">
          <label className="control-label"><span>Image</span><input value={imageName} onChange={(e) => setImageName(e.target.value)} placeholder="aws-emulator:latest or image ID" size={24} disabled={st.build.running || dock?.running} /></label>
          <label className="control-label"><span>Container</span><input value={containerName} onChange={(e) => setContainerName(e.target.value)} placeholder="aws-emulator-ui" size={16} disabled={st.build.running} /></label>
          {namesDirty && <button disabled={!!busy} onClick={saveNames}>Apply</button>}
        </div>
      )}
      {st && dock?.available && !dock.running && (
        <button disabled={st.build.running} onClick={() => act('build', withNames(api.build))}>
          {st.build.running ? 'Building image…' : dock.imageExists ? 'Rebuild image' : 'Build image'}
        </button>
      )}
      {st && dock?.available && dock.container && !dock.running && (
        <>
          <button className="primary" disabled={!!busy} title="Start the existing container again and keep its data" onClick={() => act('resume', withNames(api.resume))}>Resume</button>
          <button disabled={!!busy} title="Delete this stopped container" onClick={() => window.confirm('Remove container ' + st.names.containerName + '? Data inside it is lost.') && act('remove', api.remove)}>Remove</button>
        </>
      )}
      {st && dock?.available && !dock.container && (
        <button className="primary" disabled={!!busy || st.build.running || !dock.imageExists} title={dock.imageExists ? 'Run a container from this image' : 'Image not found. Build it or enter an existing image name/tag/ID'} onClick={() => act('start', withNames(api.start))}>Start</button>
      )}
      {st && dock?.running && <button disabled={!!busy} onClick={() => act('restart', api.restart)}>Restart</button>}
      {st && dock?.running && <button disabled={!!busy} onClick={() => act('stop', api.stop)}>Stop</button>}
      <button onClick={() => setShowLogs((v) => !v)}>{showLogs ? 'Hide logs' : 'Logs'}</button>
      {(err || (st && !dock?.available && dock?.error)) && <div className="bar-error">{err || dock.error}</div>}
      {st?.build && (st.build.running || (st.build.exitCode !== null && !dock?.imageExists)) && (
        <pre className="bar-log">{st.build.log.split('\n').slice(-12).join('\n')}</pre>
      )}
      {showLogs && <pre className="bar-log big">{logs || '(no output)'}</pre>}
    </header>
  );
}
