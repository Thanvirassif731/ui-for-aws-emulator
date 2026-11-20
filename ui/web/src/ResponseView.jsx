import React, { useEffect, useState } from 'react';
import Icon from './Icon.jsx';

// Indents XML. An element holding only text stays on one line: <a>text</a>.
function prettyXml(xml) {
  const tokens = xml.match(/<[^>]+>|[^<]+/g) || [];
  const lines = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (!t.startsWith('<')) {
      if (t.trim()) lines.push('  '.repeat(depth) + t.trim());
      continue;
    }
    const isClose = t.startsWith('</');
    const isStandalone = /^<[?!]/.test(t) || t.endsWith('/>');
    const next = tokens[i + 1];
    const afterNext = tokens[i + 2];
    if (!isClose && !isStandalone && next && !next.startsWith('<') && afterNext?.startsWith('</')) {
      lines.push('  '.repeat(depth) + t + next + afterNext);
      i += 2;
      continue;
    }
    if (isClose) depth = Math.max(0, depth - 1);
    lines.push('  '.repeat(depth) + t);
    if (!isClose && !isStandalone) depth += 1;
  }
  return lines.join('\n');
}

export function formatBody(res) {
  if (res.bodyEncoding === 'base64') return `(binary, ${res.body.length} base64 chars)\n${res.body.slice(0, 2000)}`;
  const text = res.body;
  if (!text) return '';
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON */ }
  if (text.trimStart().startsWith('<')) {
    try { return prettyXml(text); } catch { /* fall through */ }
  }
  return text;
}

export default function ResponseView({ res }) {
  const [showHeaders, setShowHeaders] = useState(false);
  const [copyState, setCopyState] = useState('');

  useEffect(() => {
    setShowHeaders(false);
    setCopyState('');
  }, [res]);

  const copyBody = async () => {
    try {
      await navigator.clipboard.writeText(formatBody(res));
      setCopyState('Copied');
    } catch {
      setCopyState('Copy failed');
    }
    window.setTimeout(() => setCopyState(''), 1800);
  };

  if (!res) return <div className="response-empty"><span className="empty-icon"><Icon name="code" size={24} /></span><b>Response</b><span>Send a request to see its response here.</span></div>;
  const ok = res.status >= 200 && res.status < 300;
  const tone = res.status === 0 ? 'bad' : ok ? 'good' : res.status >= 500 ? 'bad' : 'warn';
  return (
    <div className="response">
      <div className="response-head">
        <span className={`pill ${tone}`}>{res.status === 0 ? 'ERR' : `${res.status} ${res.statusText || ''}`}</span>
        <span className="muted">{res.durationMs} ms</span>
        {res.request && <span className="muted mono">{res.request.method} {res.request.url}</span>}
        {res.request && !res.request.signed && <span className="muted">unsigned</span>}
        <div className="spacer" />
        <button className="link" aria-expanded={showHeaders} onClick={() => setShowHeaders((v) => !v)}>{showHeaders ? 'Hide' : 'Show'} headers</button>
        <button className="link" onClick={copyBody}><Icon name={copyState === 'Copied' ? 'check' : 'copy'} size={14} />{copyState || 'Copy body'}</button>
        <span className="sr-only" role="status" aria-live="polite">{copyState}</span>
      </div>
      {res.error && <div className="error">{res.error}</div>}
      {res.truncated && <div className="error">Response truncated at 20 MB.</div>}
      {showHeaders && (
        <pre className="code small">{Object.entries(res.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n')}</pre>
      )}
      <pre className="code">{formatBody(res)}</pre>
    </div>
  );
}
