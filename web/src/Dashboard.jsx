import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import Icon from './Icon.jsx';

const HISTORY_KEY = 'emulator-ui.history.v1';

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const protocolName = (p) => (p ? p.replace('aws.protocols#', '') : 'unknown');

function Card({ title, tone, value, lines, icon }) {
  return (
    <div className={`card ${tone || ''}`}>
      <div className="card-top">
        <span className="card-icon"><Icon name={icon} size={18} /></span>
        <span className={`status-dot ${tone || ''}`} />
      </div>
      <div className="card-title">{title}</div>
      <div className="card-value">{value}</div>
      <div className="card-meta">
        {lines.filter(Boolean).map((l) => <div key={l} className="muted small">{l}</div>)}
      </div>
    </div>
  );
}

export default function Dashboard({ onOpenService, onOpenConsole }) {
  const [st, setSt] = useState(null);
  const [stErr, setStErr] = useState('');
  const [statusLoading, setStatusLoading] = useState(true);
  const [services, setServices] = useState([]);
  const [servicesLoading, setServicesLoading] = useState(true);
  const [servicesError, setServicesError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);
  const [query, setQuery] = useState('');
  const [protocol, setProtocol] = useState('all');
  const [history, setHistory] = useState(loadHistory);

  const loadStatus = useCallback(async (showLoading = false) => {
    if (showLoading) setStatusLoading(true);
    try {
      setSt(await api.status());
      setStErr('');
      setLastUpdated(Date.now());
    } catch (e) {
      setSt(null);
      setStErr(e.message);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  const loadServices = useCallback(async () => {
    setServicesLoading(true);
    setServicesError('');
    try { setServices(await api.services('')); }
    catch (e) { setServices([]); setServicesError(e.message); }
    finally { setServicesLoading(false); }
  }, []);

  useEffect(() => {
    let alive = true;
    loadStatus(true);
    const t = setInterval(() => {
      if (alive) { loadStatus(); setHistory(loadHistory()); }
    }, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [loadStatus]);

  useEffect(() => { loadServices(); }, [loadServices]);

  const refreshAll = () => Promise.all([loadStatus(true), loadServices()]);

  const protocols = useMemo(() => {
    const counts = new Map();
    for (const s of services) counts.set(protocolName(s.protocol), (counts.get(protocolName(s.protocol)) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [services]);

  const totalOps = useMemo(() => services.reduce((n, s) => n + (s.operationCount || 0), 0), [services]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return services.filter((s) => (protocol === 'all' || protocolName(s.protocol) === protocol)
      && (!q || `${s.title} ${s.id} ${s.signingName}`.toLowerCase().includes(q)));
  }, [services, query, protocol]);

  const dock = st?.docker;
  const healthy = !!st?.health?.ok;

  let emu = statusLoading && !st
    ? { value: 'Checking…', tone: '', lines: ['Connecting to the local emulator'] }
    : { value: 'Unreachable', tone: 'bad', lines: [stErr] };
  if (st) {
    emu = healthy
      ? { value: 'Running', tone: 'good', lines: [`${st.host}:${st.port}`, `Region ${st.region}`] }
      : { value: 'Not responding', tone: 'warn', lines: [`Expected on port ${st.port}`, st.health?.error] };
  }

  let container = { value: '-', tone: '', lines: [] };
  if (st?.mode === 'external') {
    container = { value: 'External process', tone: healthy ? 'good' : 'warn', lines: [`${st.host}:${st.port}`, 'Lifecycle managed outside this UI'] };
  } else if (st?.mode === 'native') {
    container = {
      value: st.native?.running ? 'UI-managed process' : healthy ? 'External native process' : 'Stopped',
      tone: healthy ? 'good' : 'warn',
      lines: [st.native?.running && st.native.pid ? `PID ${st.native.pid}` : '', st.native?.binary],
    };
  } else if (dock) {
    container = !dock.available
      ? { value: 'Docker unavailable', tone: 'bad', lines: [dock.error] }
      : {
        value: dock.container ? dock.container : 'No container',
        tone: dock.running ? 'good' : 'warn',
        lines: [st.names?.containerName && `Name: ${st.names.containerName}`, `Docker ${dock.version}`],
      };
  }

  const image = st?.mode === 'native'
    ? { value: st.native?.binary || 'aws-emulator', tone: st.native?.error ? 'bad' : '', lines: ['Native executable'] }
    : st?.mode === 'external'
      ? { value: `${st.host}:${st.port}`, tone: healthy ? 'good' : 'warn', lines: ['Configured endpoint'] }
      : dock?.available
        ? { value: dock.imageExists ? 'Found' : 'Not found', tone: dock.imageExists ? 'good' : 'warn', lines: [st.names?.imageName] }
        : { value: '-', tone: '', lines: [] };

  return (
    <div className="dashboard">
      <div className="page-head dash-head">
        <div>
          <div className="eyebrow">Overview</div>
          <h1>Dashboard</h1>
          <p>Monitor your local AWS environment and open available services.</p>
        </div>
        <div className="page-actions">
          <span className="last-updated" aria-live="polite">{lastUpdated ? `Updated ${ago(lastUpdated)}` : 'Connecting…'}</span>
          <button onClick={refreshAll} disabled={statusLoading || servicesLoading}><Icon name="refresh" size={15} />{statusLoading || servicesLoading ? 'Refreshing…' : 'Refresh'}</button>
          <button className="primary action-button" onClick={onOpenConsole}><Icon name="console" size={16} />Open Console</button>
        </div>
      </div>

      <div className="cards">
        <Card title="Emulator" icon="activity" {...emu} />
        <Card title={st?.mode === 'docker' ? 'Container' : 'Runtime'} icon="server" {...container} />
        <Card title={st?.mode === 'docker' ? 'Image' : st?.mode === 'native' ? 'Binary' : 'Endpoint'} icon="image" {...image} />
        <Card
          title="Authentication"
          icon="lock"
          tone={!st ? '' : st.authCredentials ? 'good' : 'warn'}
          value={st ? (st.authCredentials ? 'Signed requests' : 'Unsigned') : '-'}
          lines={[st && !st.authCredentials && 'No credentials found in the emulator home']}
        />
        <Card title="Services" icon="grid" value={services.length} lines={[`${totalOps.toLocaleString()} operations`]} />
      </div>

      <div className="dash-grid">
        <section className="panel">
          <div className="panel-head">
            <div>
              <div className="section-title">Services</div>
              <div className="section-subtitle">{shown.length} available in this view</div>
            </div>
            <div className="search-field grow"><Icon name="search" size={15} /><input aria-label="Search services" placeholder={`Search ${services.length} services…`} value={query} onChange={(e) => setQuery(e.target.value)} />{query && <button className="clear-search" aria-label="Clear service search" onClick={() => setQuery('')}>×</button>}</div>
            <select value={protocol} onChange={(e) => setProtocol(e.target.value)} aria-label="Filter by protocol">
              <option value="all">All protocols</option>
              {protocols.map(([p, n]) => <option key={p} value={p}>{p} ({n})</option>)}
            </select>
          </div>
          <div className="svc-grid">
            {shown.map((s) => (
              <button key={s.id} className="svc" onClick={() => onOpenService(s)} title={`Open ${s.title} in the Console`}>
                <span className="svc-icon"><Icon name="box" size={17} /></span>
                <span className="svc-copy">
                  <span className="svc-title">{s.title}</span>
                  <span className="muted small">{protocolName(s.protocol)} · {s.operationCount} ops</span>
                </span>
                <Icon name="chevron" size={15} className="svc-arrow" />
              </button>
            ))}
            {servicesLoading && <div className="loading-state" role="status"><span className="spinner" />Loading services…</div>}
            {!servicesLoading && servicesError && <div className="inline-state error-state"><span>Could not load services: {servicesError}</span><button onClick={loadServices}>Try again</button></div>}
            {!servicesLoading && !servicesError && shown.length === 0 && (
              <div className="inline-state">
                <span>{services.length ? 'No services match these filters.' : 'No services found. Check EMULATOR_REPO.'}</span>
                {services.length > 0 && <button onClick={() => { setQuery(''); setProtocol('all'); }}>Clear filters</button>}
              </div>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <div className="section-title">Recent requests</div>
              <div className="section-subtitle">Latest console activity</div>
            </div>
            <span className="panel-head-icon"><Icon name="clock" size={17} /></span>
          </div>
          {history.length === 0 && <div className="empty">Requests sent from the Console appear here.</div>}
          <div className="list flat">
            {history.slice(0, 12).map((h) => (
              <button
                key={h.at}
                className="item"
                onClick={() => (h.kind === 'raw' ? onOpenConsole() : onOpenService(h.service, h.operation, h.input))}
              >
                <span className="mono">{h.label}</span>
                <span className="muted small">{ago(h.at)}</span>
                <span className={h.status >= 200 && h.status < 300 ? 'good-text small' : 'bad-text small'}>{h.status || 'ERR'}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
