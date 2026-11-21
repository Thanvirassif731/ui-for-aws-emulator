import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import Icon from './Icon.jsx';
import { RESOURCE_REFRESH_EVENT } from './resourceEvents.js';

function attributeValue(value) {
  if (!value || typeof value !== 'object') return value;
  if ('S' in value) return value.S;
  if ('N' in value) return value.N;
  if ('BOOL' in value) return value.BOOL;
  if ('NULL' in value) return null;
  if ('B' in value) return `[binary] ${value.B}`;
  if ('SS' in value) return value.SS;
  if ('NS' in value) return value.NS;
  if ('BS' in value) return value.BS.map((item) => `[binary] ${item}`);
  if ('L' in value) return value.L.map(attributeValue);
  if ('M' in value) return Object.fromEntries(Object.entries(value.M).map(([key, item]) => [key, attributeValue(item)]));
  return value;
}

function display(value) {
  const plain = attributeValue(value);
  if (plain === null) return 'null';
  if (typeof plain === 'object') return JSON.stringify(plain);
  return String(plain);
}

export default function DynamoDB() {
  const [tables, setTables] = useState([]);
  const [table, setTable] = useState('');
  const [items, setItems] = useState([]);
  const [nextKey, setNextKey] = useState(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadTables = useCallback(async () => {
    setBusy(true); setError('');
    try { setTables(await api.dynamodbTables()); } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }, []);

  const scan = useCallback(async (name, startKey = null, append = false) => {
    if (!name) return;
    setBusy(true); setError('');
    try {
      const result = await api.dynamodbScan(name, startKey);
      setItems((current) => append ? [...current, ...result.items] : result.items);
      setNextKey(result.nextKey);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { loadTables(); }, [loadTables]);
  useEffect(() => { setItems([]); setNextKey(null); if (table) scan(table); }, [table, scan]);
  useEffect(() => {
    const refresh = () => { loadTables(); if (table) scan(table); };
    window.addEventListener(RESOURCE_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(RESOURCE_REFRESH_EVENT, refresh);
  }, [loadTables, scan, table]);

  const shownTables = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? tables.filter((name) => name.toLowerCase().includes(needle)) : tables;
  }, [tables, query]);
  const columns = useMemo(() => [...new Set(items.flatMap((item) => Object.keys(item)))].sort(), [items]);

  return (
    <div className="resource-page">
      <section className="col picker resource-picker">
        <div className="picker-head"><div className="eyebrow">NoSQL database</div><div className="section-title">DynamoDB tables</div></div>
        <div className="search-field"><Icon name="search" size={15} /><input aria-label="Filter tables" placeholder="Filter tables…" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
        <div className="list" aria-busy={busy && !table}>
          {shownTables.map((name) => <button key={name} className={table === name ? 'item active' : 'item'} onClick={() => setTable(name)}><span className="item-main"><Icon name="database" size={15} />{name}</span><Icon name="chevron" size={14} /></button>)}
          {!busy && shownTables.length === 0 && <div className="empty compact">{tables.length ? 'No tables match.' : 'No tables yet.'}</div>}
        </div>
        <button className="subtle-button" disabled={busy} onClick={loadTables}><Icon name="refresh" size={14} />Refresh tables</button>
      </section>
      <section className="col work">
        {error && <div className="error" role="alert"><span>{error}</span><button className="link" onClick={() => setError('')}>Dismiss</button></div>}
        {!table ? <div className="empty-state"><span className="empty-icon"><Icon name="database" size={26} /></span><b>Select a table</b><span>Choose a DynamoDB table to scan its first 100 items.</span></div> : <>
          <div className="op-head"><div><div className="eyebrow">DynamoDB table</div><h1>{table}</h1></div><button disabled={busy} onClick={() => scan(table)}><Icon name="refresh" size={15} />Refresh</button></div>
          <div className="resource-summary"><span><b>{items.length}</b> loaded items</span><span>{columns.length} attributes</span>{busy && <span className="busy-label"><span className="spinner" />Scanning…</span>}</div>
          <div className="objects-wrap resource-grid-wrap">
            <table className="objects resource-grid">
              <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
              <tbody>{items.map((item, index) => <tr key={`${index}-${JSON.stringify(item)}`}>{columns.map((column) => <td key={column} className="mono" title={display(item[column])}>{item[column] === undefined ? <span className="muted">—</span> : display(item[column])}</td>)}</tr>)}</tbody>
            </table>
          </div>
          {!busy && items.length === 0 && <div className="empty table-empty">This table has no items.</div>}
          {nextKey && <button disabled={busy} onClick={() => scan(table, nextKey, true)}>Load next 100 items</button>}
        </>}
      </section>
    </div>
  );
}
