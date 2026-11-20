import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import ResponseView from './ResponseView.jsx';
import Icon from './Icon.jsx';

const HISTORY_KEY = 'emulator-ui.history.v1';
const HISTORY_MAX = 50;

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
}

function parseHeaders(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export default function Console({ initial }) {
  const [mode, setMode] = useState('operation');
  const [services, setServices] = useState([]);
  const [servicesLoading, setServicesLoading] = useState(true);
  const [svcQuery, setSvcQuery] = useState('');
  const [service, setService] = useState(null);
  const [ops, setOps] = useState([]);
  const [opsLoading, setOpsLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [opQuery, setOpQuery] = useState('');
  const [detail, setDetail] = useState(null);
  const [input, setInput] = useState('{}');
  const [bodyOverride, setBodyOverride] = useState('');
  const [raw, setRaw] = useState({ method: 'GET', path: '/__admin/health', headers: '', body: '', sign: false });
  const [response, setResponse] = useState(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [history, setHistory] = useState(loadHistory);
  const [announcement, setAnnouncement] = useState('');
  const operationSearch = useRef(null);
  const inputEditor = useRef(null);
  const serviceRequest = useRef(0);
  const operationRequest = useRef(0);

  useEffect(() => {
    let active = true;
    setServicesLoading(true);
    const t = setTimeout(() => api.services(svcQuery)
      .then((items) => { if (active) { setServices(items); setError(''); } })
      .catch((e) => { if (active) setError(e.message); })
      .finally(() => { if (active) setServicesLoading(false); }), 150);
    return () => { active = false; clearTimeout(t); };
  }, [svcQuery]);

  const pickService = useCallback(async (svc) => {
    const requestId = ++serviceRequest.current;
    operationRequest.current += 1;
    setService(svc);
    setDetail(null);
    setOps([]);
    setOpQuery('');
    setError('');
    setOpsLoading(true);
    setDetailLoading(false);
    try {
      const nextOps = await api.operations(svc.id);
      if (requestId !== serviceRequest.current) return;
      setOps(nextOps);
      window.setTimeout(() => operationSearch.current?.focus(), 0);
    } catch (e) {
      if (requestId === serviceRequest.current) setError(e.message);
    } finally {
      if (requestId === serviceRequest.current) setOpsLoading(false);
    }
  }, []);

  const pickOperation = useCallback(async (svc, opName, presetInput) => {
    const requestId = ++operationRequest.current;
    setError('');
    setDetail(null);
    setDetailLoading(true);
    try {
      const d = await api.operation(svc.id, opName);
      if (requestId !== operationRequest.current) return;
      setDetail(d);
      setInput(JSON.stringify(presetInput ?? d.skeleton ?? {}, null, 2));
      setBodyOverride('');
      window.setTimeout(() => inputEditor.current?.focus(), 0);
    } catch (e) {
      if (requestId === operationRequest.current) setError(e.message);
    } finally {
      if (requestId === operationRequest.current) setDetailLoading(false);
    }
  }, []);

  const filteredOps = useMemo(() => {
    const q = opQuery.trim().toLowerCase();
    return q ? ops.filter((o) => o.name.toLowerCase().includes(q)) : ops;
  }, [ops, opQuery]);

  const inputJsonError = useMemo(() => {
    if (mode !== 'operation' || !input.trim()) return '';
    try { JSON.parse(input); return ''; }
    catch (e) { return e.message; }
  }, [input, mode]);
  const rawPathError = mode === 'raw' && raw.path && !raw.path.startsWith('/') ? 'Path must start with /.' : '';
  const signingError = mode === 'raw' && raw.sign && !service ? 'Select a service before signing this request.' : '';
  const canSend = !sending && (mode === 'operation' ? !!detail && !inputJsonError : !!raw.path && !rawPathError && !signingError);

  const formatInput = () => {
    if (inputJsonError) return;
    const parsed = input.trim() ? JSON.parse(input) : {};
    setInput(JSON.stringify(parsed, null, 2));
    setAnnouncement('JSON input formatted.');
  };

  const remember = (entry) => {
    const next = [{ ...entry, at: Date.now() }, ...history].slice(0, HISTORY_MAX);
    setHistory(next);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  };

  const send = async () => {
    if (!canSend) return;
    setError('');
    setAnnouncement('Sending request…');
    setSending(true);
    try {
      let res;
      if (mode === 'operation') {
        if (!service || !detail) throw new Error('Pick a service and an operation first.');
        let parsed;
        try { parsed = input.trim() ? JSON.parse(input) : {}; } catch (e) { throw new Error(`Input is not valid JSON: ${e.message}`); }
        res = await api.invoke({ serviceId: service.id, operation: detail.name, input: parsed, bodyOverride: bodyOverride || undefined });
        remember({ kind: 'operation', service, operation: detail.name, input: parsed, status: res.status, label: `${service.title}.${detail.name}` });
      } else {
        const [pathOnly, qs = ''] = raw.path.split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(qs)) query[k] = query[k] === undefined ? v : [].concat(query[k], v);
        res = await api.raw({
          method: raw.method.toUpperCase(),
          path: pathOnly,
          query,
          headers: parseHeaders(raw.headers),
          body: raw.body,
          signingName: raw.sign ? (service?.signingName || '') : null,
        });
        remember({ kind: 'raw', raw: { ...raw }, status: res.status, label: `${raw.method} ${raw.path}` });
      }
      setResponse(res);
      setAnnouncement(`Request completed with status ${res.status || 'error'} in ${res.durationMs} milliseconds.`);
    } catch (e) {
      setError(e.message);
      setAnnouncement(`Request failed: ${e.message}`);
    } finally {
      setSending(false);
    }
  };

  const restore = async (h) => {
    if (h.kind === 'raw') { setMode('raw'); setRaw(h.raw); return; }
    setMode('operation');
    await pickService(h.service);
    await pickOperation(h.service, h.operation, h.input);
  };

  useEffect(() => {
    if (!initial?.service) return;
    (async () => {
      await pickService(initial.service);
      if (initial.operation) await pickOperation(initial.service, initial.operation, initial.input);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);
  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
  };

  const isRest = detail?.protocol?.startsWith('aws.protocols#rest');

  return (
    <div className="console">
      <section className="col picker service-picker">
        <div className="picker-head">
          <div className="eyebrow">Request builder</div>
          <div className="section-title">Console</div>
        </div>
        <div className="tabs" role="tablist" aria-label="Request mode">
          <button role="tab" aria-selected={mode === 'operation'} className={mode === 'operation' ? 'tab active' : 'tab'} onClick={() => setMode('operation')}><Icon name="grid" size={15} />Operation</button>
          <button role="tab" aria-selected={mode === 'raw'} className={mode === 'raw' ? 'tab active' : 'tab'} onClick={() => setMode('raw')}><Icon name="code" size={15} />Raw HTTP</button>
        </div>
        <div className="search-field"><Icon name="search" size={15} /><input aria-label="Search services" placeholder={`Search ${services.length} services…`} value={svcQuery} onChange={(e) => setSvcQuery(e.target.value)} />{svcQuery && <button className="clear-search" aria-label="Clear service search" onClick={() => setSvcQuery('')}>×</button>}</div>
        <div className="list" aria-busy={servicesLoading}>
          {servicesLoading && <div className="loading-state compact" role="status"><span className="spinner" />Loading…</div>}
          {!servicesLoading && services.length === 0 && <div className="empty compact">No services found.</div>}
          {!servicesLoading && services.map((s) => (
            <button key={s.id} className={service?.id === s.id ? 'item active' : 'item'} onClick={() => pickService(s)} title={s.id}>
              <span>{s.title}</span>
              <span className="muted small">{s.operationCount}</span>
            </button>
          ))}
        </div>
      </section>

      {mode === 'operation' && (
        <section className="col picker operation-picker">
          <div className="picker-head compact">
            <div className="eyebrow">Service</div>
            <div className="section-title">{service ? service.title : 'Select a service'}</div>
          </div>
          <div className="search-field"><Icon name="search" size={15} /><input ref={operationSearch} aria-label="Filter operations" placeholder="Filter operations…" value={opQuery} disabled={!service} onChange={(e) => setOpQuery(e.target.value)} />{opQuery && <button className="clear-search" aria-label="Clear operation filter" onClick={() => setOpQuery('')}>×</button>}</div>
          <div className="list" aria-busy={opsLoading}>
            {opsLoading && <div className="loading-state compact" role="status"><span className="spinner" />Loading operations…</div>}
            {!opsLoading && service && filteredOps.length === 0 && <div className="empty compact">{ops.length ? 'No operations match.' : 'No operations available.'}</div>}
            {!opsLoading && filteredOps.map((o) => (
              <button key={o.name} className={detail?.name === o.name ? 'item active' : 'item'} onClick={() => pickOperation(service, o.name)} title={o.documentation}>
                <span>{o.name}</span>
                {o.method && <span className="muted small">{o.method}</span>}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="col work" aria-busy={sending || detailLoading}>
        <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
        {error && <div className="error" role="alert"><span>{error}</span><button className="link" aria-label="Dismiss error" onClick={() => setError('')}>Dismiss</button></div>}
        {detailLoading && <div className="loading-state work-loading" role="status"><span className="spinner" />Loading operation…</div>}

        {!detailLoading && (mode === 'operation' ? (
          detail ? (
            <>
              <div className="op-head">
                <div>
                  <div className="eyebrow">{service?.title} operation</div>
                  <h1>{detail.name}</h1>
                </div>
                <span className="endpoint-chip mono">{detail.protocol?.replace('aws.protocols#', '')}{detail.method ? ` · ${detail.method} ${detail.uri}` : ''}</span>
              </div>
              {detail.documentation && <p className="doc">{detail.documentation}</p>}
              {detail.members.length > 0 && (
                <details className="members">
                  <summary>{detail.members.length} input members</summary>
                  <table>
                    <tbody>
                      {detail.members.map((m) => (
                        <tr key={m.name} title={m.documentation}>
                          <td className="mono">{m.name}{m.required && <b className="req"> *</b>}</td>
                          <td className="muted mono">{m.type}</td>
                          <td className="muted">{m.binding !== 'body' ? m.binding : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
              <div className="editor-label">
                <label className="field-label" htmlFor="operation-input">Input (JSON)</label>
                <button className="link" disabled={!!inputJsonError} onClick={formatInput}>Format JSON</button>
              </div>
              <textarea id="operation-input" ref={inputEditor} className={`editor ${inputJsonError ? 'invalid' : ''}`} aria-invalid={!!inputJsonError} aria-describedby={inputJsonError ? 'json-error' : undefined} spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} />
              {inputJsonError && <div id="json-error" className="field-error" role="alert">Invalid JSON: {inputJsonError}</div>}
              {isRest && (
                <>
                  <label className="field-label">Body override (optional, sent as-is; needed for XML bodies)</label>
                  <textarea className="editor short" spellCheck={false} value={bodyOverride} onChange={(e) => setBodyOverride(e.target.value)} onKeyDown={onKey} />
                </>
              )}
            </>
          ) : (
            <div className="empty-state"><span className="empty-icon"><Icon name="console" size={26} /></span><b>Build a request</b><span>Choose a service and an operation to get started.</span></div>
          )
        ) : (
          <>
            <div className="op-head">
              <div>
                <div className="eyebrow">Direct request</div>
                <h1>Raw HTTP</h1>
              </div>
              <span className="endpoint-chip mono">HTTPS</span>
            </div>
            <div className="row request-line">
              <select aria-label="HTTP method" value={raw.method} onChange={(e) => setRaw({ ...raw, method: e.target.value })}>
                {['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH'].map((m) => <option key={m}>{m}</option>)}
              </select>
              <input aria-label="Request path" aria-invalid={!!rawPathError} className={`grow mono ${rawPathError ? 'invalid' : ''}`} value={raw.path} onChange={(e) => setRaw({ ...raw, path: e.target.value })} onKeyDown={onKey} placeholder="/path?query=1" />
            </div>
            {rawPathError && <div className="field-error" role="alert">{rawPathError}</div>}
            <label className="check">
              <input type="checkbox" checked={raw.sign} onChange={(e) => setRaw({ ...raw, sign: e.target.checked })} />
              Sign with SigV4 as service <b>{service?.signingName || '(select a service)'}</b>
            </label>
            {signingError && <div className="field-error" role="alert">{signingError}</div>}
            <label className="field-label">Headers (one per line, <span className="mono">Name: value</span>)</label>
            <textarea className="editor short" spellCheck={false} value={raw.headers} onChange={(e) => setRaw({ ...raw, headers: e.target.value })} />
            <label className="field-label">Body</label>
            <textarea className="editor" spellCheck={false} value={raw.body} onChange={(e) => setRaw({ ...raw, body: e.target.value })} onKeyDown={onKey} />
          </>
        ))}

        <div className="row">
          <button className="primary send-button" disabled={!canSend} onClick={send}>
            <Icon name="send" size={15} />{sending ? 'Sending…' : 'Send request'} <span className="kbd">Ctrl+Enter</span>
          </button>
        </div>

        <ResponseView res={response} />

        {history.length > 0 && (
          <details className="history">
            <summary>History ({history.length})</summary>
            <div className="list flat">
              {history.map((h) => (
                <button key={h.at} className="item" onClick={() => restore(h)}>
                  <span className="mono">{h.label}</span>
                  <span className={h.status >= 200 && h.status < 300 ? 'good-text small' : 'bad-text small'}>{h.status || 'ERR'}</span>
                </button>
              ))}
            </div>
            <button className="link" onClick={() => { setHistory([]); localStorage.removeItem(HISTORY_KEY); }}>Clear history</button>
          </details>
        )}
      </section>
    </div>
  );
}
