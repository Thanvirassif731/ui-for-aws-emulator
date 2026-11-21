import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import Icon from './Icon.jsx';
import { confirmDialog } from './dialogs.js';
import { notifyError, notifySuccess } from './notifications.js';

function formatBody(body, encoding) {
  if (!body) return '(empty)';
  if (encoding === 'base64') return `[base64]\n${body}`;
  try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; }
}

export default function Traffic() {
  const [entries, setEntries] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [proxy, setProxy] = useState('http://127.0.0.1:8790');
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try { setEntries(await api.traffic()); setError(''); } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { api.status().then((status) => setProxy(`http://${status.proxy.host}:${status.proxy.port}`)).catch(() => {}); }, []);
  useEffect(() => {
    refresh();
    if (paused) return undefined;
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [paused, refresh]);

  const selected = entries.find((entry) => entry.id === selectedId) || entries[0] || null;
  const clear = async () => {
    const confirmed = await confirmDialog({
      title: 'Clear captured traffic?',
      message: 'Every request captured during this in-memory session will be removed.',
      confirmLabel: 'Clear traffic',
    });
    if (!confirmed) return;
    try {
      await api.clearTraffic();
      setEntries([]);
      setSelectedId(null);
      setError('');
      notifySuccess('Captured SDK traffic cleared.', { title: 'Traffic cleared', source: 'Traffic' });
    } catch (e) {
      setError(e.message);
      notifyError(e, { title: 'Could not clear traffic', source: 'Traffic' });
    }
  };
  const copyEndpoint = async () => {
    try {
      await navigator.clipboard.writeText(proxy);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      notifyError(e, { title: 'Could not copy endpoint', source: 'Traffic' });
    }
  };

  return (
    <div className="traffic-page">
      <section className="traffic-list-panel">
        <div className="picker-head"><div className="eyebrow">Live observability</div><div className="section-title">SDK traffic</div></div>
        <div className="proxy-callout"><div><span className="muted small">Set in your application</span><code>AWS_ENDPOINT_URL={proxy}</code></div><button onClick={copyEndpoint}>{copied ? 'Copied' : 'Copy'}</button></div>
        <div className="row traffic-actions"><button onClick={() => setPaused((value) => !value)}><Icon name={paused ? 'activity' : 'clock'} size={14} />{paused ? 'Resume' : 'Pause'}</button><button onClick={refresh}><Icon name="refresh" size={14} />Refresh</button><button className="danger-link" disabled={!entries.length} onClick={clear}>Clear</button></div>
        {error && <div className="error">{error}</div>}
        <div className="traffic-list">
          {entries.map((entry) => <button key={entry.id} className={selected?.id === entry.id ? 'traffic-row active' : 'traffic-row'} onClick={() => setSelectedId(entry.id)}>
            <span className={`traffic-status ${entry.status >= 200 && entry.status < 400 ? 'good-text' : entry.status ? 'bad-text' : ''}`}>{entry.status || '…'}</span>
            <span className="traffic-copy"><b><span className="mono">{entry.method}</span> {entry.service || 'AWS'}</b><span className="mono muted">{entry.path}</span></span>
            <span className="muted small">{entry.durationMs === null ? 'in flight' : `${entry.durationMs}ms`}</span>
          </button>)}
          {!entries.length && <div className="empty-state compact"><span className="empty-icon"><Icon name="activity" size={24} /></span><b>Waiting for SDK calls</b><span>Point an application at the endpoint above.</span></div>}
        </div>
      </section>
      <section className="traffic-detail col work">
        {!selected ? <div className="empty-state"><span className="empty-icon"><Icon name="activity" size={26} /></span><b>No request selected</b><span>Captured calls appear here in real time.</span></div> : <>
          <div className="op-head"><div><div className="eyebrow">Captured request #{selected.id}</div><h1><span className="mono">{selected.method}</span> {selected.path}</h1></div><span className={`endpoint-chip ${selected.status >= 200 && selected.status < 400 ? 'good-text' : 'bad-text'}`}>{selected.status || 'In flight'} · {selected.durationMs ?? '…'} ms</span></div>
          {selected.error && <div className="error">{selected.error}</div>}
          <div className="traffic-columns">
            <div className="traffic-block"><h2>Request headers</h2><pre>{JSON.stringify(selected.requestHeaders, null, 2)}</pre></div>
            <div className="traffic-block"><h2>Response headers</h2><pre>{JSON.stringify(selected.responseHeaders, null, 2)}</pre></div>
            <div className="traffic-block"><h2>Request body{selected.requestTruncated ? ' (truncated)' : ''}</h2><pre>{formatBody(selected.requestBody, selected.requestBodyEncoding)}</pre></div>
            <div className="traffic-block"><h2>Response body{selected.responseTruncated ? ' (truncated)' : ''}</h2><pre>{formatBody(selected.responseBody, selected.responseBodyEncoding)}</pre></div>
          </div>
        </>}
      </section>
    </div>
  );
}
