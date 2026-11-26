import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import Icon from './Icon.jsx';
import { confirmDialog } from './dialogs.js';
import { notifyError, notifySuccess } from './notifications.js';
import { RESOURCE_REFRESH_EVENT } from './resourceEvents.js';
import S3Lifecycle from './S3Lifecycle.jsx';
import S3Permissions from './S3Permissions.jsx';
import { Hint } from './S3SandboxShared.jsx';
import S3Versions from './S3Versions.jsx';
import S3Website from './S3Website.jsx';

const PREVIEW_MAX = 256 * 1024;
const UPLOAD_MAX = 16 * 1024 * 1024;

const TABS = [
  { id: 'objects', label: 'Objects & Versions' },
  { id: 'website', label: 'Static Website' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'lifecycle', label: 'Lifecycle & Time-Travel' },
];

const VERSIONING_UI = {
  Enabled: { label: 'Enabled', tone: 'good', action: 'Select to suspend versioning' },
  Suspended: { label: 'Suspended', tone: 'warn', action: 'Select to enable versioning again' },
  Unversioned: { label: 'Disabled', tone: 'neutral', action: 'Select to enable versioning' },
};

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error(`Could not read ${file.name}`));
    r.readAsDataURL(file);
  });
}

export default function S3() {
  const [buckets, setBuckets] = useState([]);
  const [bucketQuery, setBucketQuery] = useState('');
  const [bucket, setBucket] = useState(null);
  const [prefix, setPrefix] = useState('');
  const [objectQuery, setObjectQuery] = useState('');
  const [listing, setListing] = useState(null);
  const [extra, setExtra] = useState({ objects: [], prefixes: [] });
  const [selected, setSelected] = useState(new Set());
  const [preview, setPreview] = useState(null);
  const [newBucket, setNewBucket] = useState('');
  const [folderName, setFolderName] = useState('');
  const [showFolderInput, setShowFolderInput] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [busyText, setBusyText] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [tab, setTab] = useState('objects');
  const [versioning, setVersioning] = useState('');
  const [showVersions, setShowVersions] = useState(false);
  const [versionsRefresh, setVersionsRefresh] = useState(0);
  const [auditLogs, setAuditLogs] = useState({});
  const objectsStale = useRef(false);
  const versioningRequest = useRef(0);
  const tabRefs = useRef({});
  const fileInput = useRef();
  const selectAllInput = useRef();
  const dragDepth = useRef(0);
  const objectRequest = useRef(0);
  const busyRequest = useRef(0);

  const guard = async (label, fn, successMessage = '') => {
    const busyId = ++busyRequest.current;
    setBusy(label);
    setBusyText('Working…');
    setError('');
    if (!['buckets', 'objects', 'more', 'preview'].includes(label)) setNotice('');
    try {
      const result = await fn();
      if (busyId === busyRequest.current && successMessage) {
        const message = typeof successMessage === 'function' ? successMessage(result) : successMessage;
        setNotice(message);
        notifySuccess(message, { title: 'S3 update', source: 'S3' });
      }
      return result;
    } catch (e) {
      if (busyId === busyRequest.current) setError(e.message);
      notifyError(e, { title: 'S3 action failed', source: 'S3' });
      return undefined;
    } finally {
      if (busyId === busyRequest.current) {
        setBusy('');
        setBusyText('');
      }
    }
  };

  const applyListing = (next) => {
    setListing(next);
    setExtra({ objects: [], prefixes: [] });
    setSelected(new Set());
    setPreview(null);
  };

  const fetchListing = async (b, p, reset = false) => {
    const requestId = ++objectRequest.current;
    if (reset) {
      setListing(null);
      setExtra({ objects: [], prefixes: [] });
      setSelected(new Set());
      setPreview(null);
    }
    const next = await api.s3Objects(b, p);
    if (requestId !== objectRequest.current) return false;
    applyListing(next);
    return true;
  };

  const refreshAfterMutation = async (b, p, locationVersion) => {
    if (locationVersion !== objectRequest.current) return;
    setVersionsRefresh((n) => n + 1);
    await fetchListing(b, p);
  };

  const loadBuckets = useCallback(() => guard('buckets', async () => setBuckets(await api.s3Buckets())), []);
  const loadObjects = useCallback((b, p) => guard('objects', () => fetchListing(b, p, true)), []);
  const loadVersioning = useCallback(async (b) => {
    const requestId = ++versioningRequest.current;
    setVersioning('');
    try {
      const { status } = await api.s3Versioning(b);
      if (requestId === versioningRequest.current) setVersioning(status);
    } catch { /* reported by the API client */ }
  }, []);

  useEffect(() => { loadBuckets(); }, [loadBuckets]);
  useEffect(() => { if (bucket) loadObjects(bucket, prefix); }, [bucket, prefix, loadObjects]);
  useEffect(() => { if (bucket) loadVersioning(bucket); }, [bucket, loadVersioning]);
  useEffect(() => { setObjectQuery(''); }, [bucket, prefix]);
  useEffect(() => {
    const refresh = () => { loadBuckets(); if (bucket) loadObjects(bucket, prefix); };
    window.addEventListener(RESOURCE_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(RESOURCE_REFRESH_EVENT, refresh);
  }, [bucket, prefix, loadBuckets, loadObjects]);

  const loadMore = () => guard('more', async () => {
    const requestId = ++objectRequest.current;
    const l = await api.s3Objects(bucket, prefix, listing.nextToken);
    if (requestId !== objectRequest.current) return;
    setExtra((e) => ({ objects: [...e.objects, ...l.objects], prefixes: [...e.prefixes, ...l.prefixes] }));
    setListing((cur) => ({ ...cur, truncated: l.truncated, nextToken: l.nextToken }));
  });

  const createBucket = () => {
    const name = newBucket.trim();
    if (!name) return;
    guard('create', async () => {
      await api.s3CreateBucket(name);
      setNewBucket('');
      setBuckets(await api.s3Buckets());
      objectRequest.current += 1;
      setPrefix('');
      setListing(null);
      setBucket(name);
    }, `Bucket “${name}” created.`);
  };

  const deleteBucket = async (name) => {
    const confirmed = await confirmDialog({
      title: 'Delete S3 bucket?',
      message: `Bucket “${name}” will be permanently deleted. The bucket must be empty, and this action cannot be undone.`,
      confirmLabel: 'Delete bucket',
    });
    if (!confirmed) return;
    guard('delete-bucket', async () => {
      await api.s3DeleteBucket(name);
      setAuditLogs(({ [name]: _removed, ...rest }) => rest);
      if (bucket === name) {
        objectRequest.current += 1;
        setBucket(null);
        setListing(null);
      }
      setBuckets(await api.s3Buckets());
    }, `Bucket “${name}” deleted.`);
  };

  const upload = (files) => {
    const tooLarge = files.find((f) => f.size > UPLOAD_MAX);
    if (tooLarge) {
      const message = `${tooLarge.name} is larger than ${formatSize(UPLOAD_MAX)}.`;
      setError(message);
      notifyError(message, { title: 'Upload rejected', source: 'S3' });
      return;
    }
    const locationVersion = objectRequest.current;
    guard('upload', async () => {
      let failure;
      try {
        for (let i = 0; i < files.length; i += 1) {
          const f = files[i];
          setBusyText(`Uploading ${i + 1} of ${files.length}: ${f.name}`);
          await api.s3Put(bucket, prefix + f.name, f.type || 'application/octet-stream', await toBase64(f));
        }
      } catch (e) { failure = e; }
      try { await refreshAfterMutation(bucket, prefix, locationVersion); }
      catch (e) { if (!failure) failure = e; }
      if (failure) throw failure;
    }, `${files.length} ${files.length === 1 ? 'file' : 'files'} uploaded.`);
  };

  const createFolder = () => {
    const name = folderName.trim();
    if (!name) return;
    if (name.includes('/')) {
      const message = 'Folder names cannot contain “/”.';
      setError(message);
      notifyError(message, { title: 'Invalid folder name', source: 'S3' });
      return;
    }
    const locationVersion = objectRequest.current;
    guard('folder', async () => {
      await api.s3Put(bucket, `${prefix}${name}/`, 'application/x-directory', '');
      await refreshAfterMutation(bucket, prefix, locationVersion);
      setFolderName('');
      setShowFolderInput(false);
    }, `Folder “${name}” created.`);
  };

  const deleteSelected = async () => {
    const count = selected.size;
    const noun = count === 1 ? 'object' : 'objects';
    const message = {
      Enabled: `Versioning is enabled, so S3 adds a delete marker to ${count === 1 ? 'this object' : `these ${count} objects`} instead of erasing data. Previous versions are kept; turn on Show All Versions to restore them.`,
      Suspended: `Versioning is suspended. S3 replaces each object's null version with a delete marker, so the null version is lost. Versions written while versioning was enabled are kept.`,
    }[versioning] || `${count} selected ${noun} will be permanently deleted. This bucket is not versioned, so this action cannot be undone.`;
    const confirmed = await confirmDialog({
      title: `Delete ${count} ${noun}?`,
      message,
      confirmLabel: count === 1 ? 'Delete object' : 'Delete objects',
    });
    if (!confirmed) return;
    const locationVersion = objectRequest.current;
    guard('delete', async () => {
      let failure;
      try {
        for (const key of selected) await api.s3Delete(bucket, key);
      } catch (e) { failure = e; }
      try { await refreshAfterMutation(bucket, prefix, locationVersion); }
      catch (e) { if (!failure) failure = e; }
      if (failure) throw failure;
    }, `${count} ${count === 1 ? 'object' : 'objects'} deleted.`);
  };

  const openPreview = (o) => guard('preview', async () => {
    if (o.size > PREVIEW_MAX) { setPreview({ key: o.key, text: null, note: `Too large to preview (${formatSize(o.size)}). Use Download.` }); return; }
    const res = await fetch(api.s3ObjectUrl(bucket, o.key));
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `${res.status}`);
    const buf = await res.arrayBuffer();
    let text = null;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* binary */ }
    setPreview({ key: o.key, text, note: text === null ? 'Binary content. Use Download.' : '' });
  });

  const toggle = (key) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  const chooseBucket = (name) => {
    setPrefix('');
    setListing(null);
    setSelected(new Set());
    setPreview(null);
    setBucket(name);
  };

  const toggleVersioning = async () => {
    const next = versioning === 'Enabled' ? 'Suspended' : 'Enabled';
    if (versioning === 'Unversioned') {
      const confirmed = await confirmDialog({
        title: 'Enable versioning?',
        message: 'From now on S3 keeps every version of every object, and deletes add a delete marker instead of erasing data. Once enabled, versioning can be suspended but never fully turned off.',
        confirmLabel: 'Enable versioning',
        tone: 'default',
      });
      if (!confirmed) return;
    } else if (versioning === 'Enabled') {
      const confirmed = await confirmDialog({
        title: 'Suspend versioning?',
        message: 'Existing versions are kept. New uploads overwrite a single "null" version, and deletes replace it with a delete marker.',
        confirmLabel: 'Suspend versioning',
        tone: 'default',
      });
      if (!confirmed) return;
    }
    const target = bucket;
    guard('versioning', async () => {
      const { status } = await api.s3SetVersioning(target, next);
      if (target === bucket) setVersioning(status);
      setVersionsRefresh((n) => n + 1);
    }, `Versioning ${next === 'Enabled' ? 'enabled' : 'suspended'} (PutBucketVersioning).`);
  };

  const selectTab = (id) => {
    setTab(id);
    if (id === 'objects' && objectsStale.current && bucket) {
      objectsStale.current = false;
      setVersionsRefresh((n) => n + 1);
      loadObjects(bucket, prefix);
    }
  };

  const onTabKeyDown = (event) => {
    const index = TABS.findIndex((item) => item.id === tab);
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = TABS[(index + step + TABS.length) % TABS.length].id;
    selectTab(next);
    tabRefs.current[next]?.focus();
  };

  const markObjectsStale = () => { objectsStale.current = true; };
  const recordAudit = (entry) => setAuditLogs((logs) => {
    const target = entry?.bucket || bucket;
    return { ...logs, [target]: entry ? [entry, ...(logs[target] || [])].slice(0, 50) : [] };
  });

  const prefixes = listing ? [...listing.prefixes, ...extra.prefixes] : [];
  const objects = listing ? [...listing.objects, ...extra.objects] : [];
  const shownBuckets = useMemo(() => {
    const q = bucketQuery.trim().toLowerCase();
    return q ? buckets.filter((b) => b.name.toLowerCase().includes(q)) : buckets;
  }, [buckets, bucketQuery]);
  const shownPrefixes = useMemo(() => {
    const q = objectQuery.trim().toLowerCase();
    return q ? prefixes.filter((p) => p.slice(prefix.length).toLowerCase().includes(q)) : prefixes;
  }, [prefixes, objectQuery, prefix]);
  const shownObjects = useMemo(() => {
    const q = objectQuery.trim().toLowerCase();
    return q ? objects.filter((o) => o.key.slice(prefix.length).toLowerCase().includes(q)) : objects;
  }, [objects, objectQuery, prefix]);
  const allShownSelected = shownObjects.length > 0 && shownObjects.every((o) => selected.has(o.key));
  const someShownSelected = shownObjects.some((o) => selected.has(o.key));
  const crumbs = prefix.split('/').filter(Boolean);

  useEffect(() => {
    if (selectAllInput.current) selectAllInput.current.indeterminate = someShownSelected && !allShownSelected;
  }, [someShownSelected, allShownSelected]);

  const toggleAllShown = () => setSelected((current) => {
    const next = new Set(current);
    if (allShownSelected) shownObjects.forEach((o) => next.delete(o.key));
    else shownObjects.forEach((o) => next.add(o.key));
    return next;
  });

  const onDrop = (event) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    if (busy) return;
    const files = [...event.dataTransfer.files];
    if (files.length) upload(files);
  };

  const onDragEnter = (event) => {
    event.preventDefault();
    dragDepth.current += 1;
    if (!busy) setDragActive(true);
  };

  const onDragLeave = (event) => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  };

  return (
    <div className="s3">
      <section className="col picker bucket-picker">
        <div className="picker-head">
          <div className="eyebrow">Object storage</div>
          <div className="section-title">S3 buckets</div>
        </div>
        <div className="row create-bucket">
          <input className="grow" aria-label="New bucket name" placeholder="Bucket name" value={newBucket} onChange={(e) => setNewBucket(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && createBucket()} />
          <button className="primary icon-button" title="Create bucket" aria-label="Create bucket" disabled={!newBucket.trim() || !!busy} onClick={createBucket}>+</button>
        </div>
        <div className="search-field"><Icon name="search" size={15} /><input aria-label="Filter buckets" placeholder="Filter buckets…" value={bucketQuery} onChange={(e) => setBucketQuery(e.target.value)} />{bucketQuery && <button className="clear-search" aria-label="Clear bucket filter" onClick={() => setBucketQuery('')}>×</button>}</div>
        <div className="list" aria-busy={busy === 'buckets'}>
          {busy === 'buckets' && <div className="loading-state compact" role="status"><span className="spinner" />Loading buckets…</div>}
          {busy !== 'buckets' && shownBuckets.map((b) => (
            <button key={b.name} className={bucket === b.name ? 'item active bucket-item' : 'item bucket-item'} onClick={() => chooseBucket(b.name)} title={b.created || ''}>
              <span className="item-main"><Icon name="bucket" size={16} />{b.name}</span>
              <Icon name="chevron" size={14} />
            </button>
          ))}
          {busy !== 'buckets' && shownBuckets.length === 0 && <div className="empty compact">{buckets.length ? 'No buckets match.' : 'No buckets yet.'}</div>}
        </div>
        <button className="subtle-button" onClick={loadBuckets} disabled={!!busy}><Icon name="refresh" size={14} />Refresh buckets</button>
      </section>

      <section className="col work">
        <div className="sr-only" role="status" aria-live="polite">{busyText || notice}</div>
        {error && <div className="error" role="alert"><span>{error}</span><button className="link" onClick={() => setError('')}>Dismiss</button></div>}
        {notice && <div className="notice" role="status"><Icon name="check" size={16} /><span>{notice}</span><button className="link" aria-label="Dismiss notification" onClick={() => setNotice('')}>Dismiss</button></div>}
        {!bucket ? (
          <div className="empty-state"><span className="empty-icon"><Icon name="bucket" size={26} /></span><b>Select a bucket</b><span>Choose an existing bucket or create a new one.</span></div>
        ) : (
          <>
            <div className="op-head s3-head">
              <div>
                <div className="eyebrow">S3 bucket</div>
                <h1>{bucket}</h1>
              </div>
              <button className="danger-link" onClick={() => deleteBucket(bucket)}><Icon name="trash" size={15} />Delete bucket</button>
            </div>
            <div className="tabs s3-tabs" role="tablist" aria-label="Bucket sections" onKeyDown={onTabKeyDown}>
              {TABS.map((item) => (
                <button
                  key={item.id}
                  ref={(node) => { tabRefs.current[item.id] = node; }}
                  id={`s3-tab-${item.id}`}
                  role="tab"
                  aria-selected={tab === item.id}
                  aria-controls={`s3-panel-${item.id}`}
                  tabIndex={tab === item.id ? 0 : -1}
                  className={tab === item.id ? 'tab active' : 'tab'}
                  onClick={() => selectTab(item.id)}
                >{item.label}</button>
              ))}
            </div>
            {tab === 'website' && <div id="s3-panel-website" role="tabpanel" aria-labelledby="s3-tab-website"><S3Website key={bucket} bucket={bucket} onChanged={markObjectsStale} onOpenTab={selectTab} /></div>}
            {tab === 'permissions' && <div id="s3-panel-permissions" role="tabpanel" aria-labelledby="s3-tab-permissions"><S3Permissions key={bucket} bucket={bucket} onChanged={markObjectsStale} /></div>}
            {tab === 'lifecycle' && (
              <div id="s3-panel-lifecycle" role="tabpanel" aria-labelledby="s3-tab-lifecycle">
                <S3Lifecycle key={bucket} bucket={bucket} versioning={versioning} auditLog={auditLogs[bucket] || []} onAudit={recordAudit} onChanged={markObjectsStale} />
              </div>
            )}
            {tab === 'objects' && (
            <div id="s3-panel-objects" role="tabpanel" aria-labelledby="s3-tab-objects" className="objects-panel">
            <div className="versioning-bar">
              <button
                className={`versioning-toggle ${VERSIONING_UI[versioning]?.tone || 'neutral'}`}
                disabled={!versioning || !!busy}
                onClick={toggleVersioning}
                title={VERSIONING_UI[versioning]?.action || 'Loading versioning status'}
              >
                {busy === 'versioning' ? <span className="spinner" /> : <span className="dot" aria-hidden="true" />}
                Versioning: {VERSIONING_UI[versioning]?.label || '…'}
              </button>
              <Hint text="Versioning keeps every version of an object. Overwrites create a new version, and deletes add a delete marker instead of destroying data, so you can recover from mistakes. Once enabled it can only be suspended. (PutBucketVersioning)" label="About versioning" />
              <span className="spacer" />
              <label className="check-label switch-label">
                <input type="checkbox" role="switch" checked={showVersions} onChange={(e) => setShowVersions(e.target.checked)} />
                <span>Show All Versions</span>
              </label>
              <Hint text="Lists every version and delete marker in this folder (ListObjectVersions), including objects that look deleted in the normal view." label="About Show All Versions" />
            </div>
            <div className="crumbs mono">
              <button className="link" onClick={() => setPrefix('')}>{bucket}</button>
              {crumbs.map((c, i) => (
                <React.Fragment key={crumbs.slice(0, i + 1).join('/')}>
                  <span className="muted">/</span>
                  <button className="link" onClick={() => setPrefix(`${crumbs.slice(0, i + 1).join('/')}/`)}>{c}</button>
                </React.Fragment>
              ))}
            </div>
            <div className="row s3-toolbar">
              <button className="primary" disabled={!!busy} onClick={() => fileInput.current.click()}><Icon name="upload" size={15} />Upload</button>
              <input ref={fileInput} type="file" multiple hidden onChange={(e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) upload(f); }} />
              <button disabled={!!busy} onClick={() => setShowFolderInput((v) => !v)} aria-expanded={showFolderInput}><Icon name="folderPlus" size={15} />New folder</button>
              <button disabled={!!busy} onClick={() => { setVersionsRefresh((n) => n + 1); loadObjects(bucket, prefix); }}><Icon name="refresh" size={15} />Refresh</button>
              {!showVersions && (
                <>
                  <div className="search-field object-search"><Icon name="search" size={15} /><input aria-label="Filter objects" placeholder="Filter this page…" value={objectQuery} onChange={(e) => setObjectQuery(e.target.value)} />{objectQuery && <button className="clear-search" aria-label="Clear object filter" onClick={() => setObjectQuery('')}>×</button>}</div>
                  <span className="toolbar-divider" />
                  <button className="danger-button" disabled={!selected.size || !!busy} onClick={deleteSelected}><Icon name="trash" size={15} />Delete selected {selected.size ? `(${selected.size})` : ''}</button>
                </>
              )}
              {busy && <span className="busy-label"><span className="spinner" />{busyText || 'Working…'}</span>}
            </div>
            {showFolderInput && (
              <div className="inline-form" role="group" aria-label="Create folder">
                <Icon name="folder" size={16} />
                <input autoFocus aria-label="Folder name" placeholder="Folder name" value={folderName} onChange={(e) => setFolderName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') createFolder(); if (e.key === 'Escape') setShowFolderInput(false); }} />
                <button className="primary" disabled={!folderName.trim() || !!busy} onClick={createFolder}>Create folder</button>
                <button onClick={() => { setShowFolderInput(false); setFolderName(''); }}>Cancel</button>
              </div>
            )}
            {showVersions ? (
              <S3Versions bucket={bucket} prefix={prefix} versioning={versioning} refreshKey={versionsRefresh} onOpenPrefix={setPrefix} onChanged={() => loadObjects(bucket, prefix)} />
            ) : (
            <>
            <div
              className={`objects-wrap ${dragActive ? 'drag-active' : ''}`}
              onDragEnter={onDragEnter}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
            >
            {dragActive && <div className="drop-overlay"><Icon name="upload" size={28} /><b>Drop files to upload</b><span>Files will be added to this folder.</span></div>}
            <table className="objects">
              <thead><tr><th className="check-col"><input ref={selectAllInput} type="checkbox" aria-label="Select all visible objects" checked={allShownSelected} disabled={!shownObjects.length} onChange={toggleAllShown} /></th><th>Name</th><th>Size</th><th>Last modified</th><th /></tr></thead>
              <tbody>
                {busy === 'objects' && !listing && <tr><td colSpan={5}><div className="loading-state" role="status"><span className="spinner" />Loading objects…</div></td></tr>}
                {prefix && !objectQuery && (
                  <tr><td /><td colSpan={4}><button className="link" onClick={() => setPrefix(prefix.replace(/[^/]+\/$/, ''))}>.. (up)</button></td></tr>
                )}
                {shownPrefixes.map((p) => (
                  <tr key={p}>
                    <td />
                    <td colSpan={4}><button className="link object-name mono" onClick={() => setPrefix(p)}><Icon name="folder" size={16} />{p.slice(prefix.length)}</button></td>
                  </tr>
                ))}
                {shownObjects.map((o) => (
                  <tr key={o.key} className={preview?.key === o.key ? 'sel' : ''}>
                    <td><input type="checkbox" aria-label={`Select ${o.key.slice(prefix.length)}`} checked={selected.has(o.key)} onChange={() => toggle(o.key)} /></td>
                    <td><button className="link object-name mono" onClick={() => openPreview(o)}><Icon name="file" size={16} />{o.key.slice(prefix.length)}</button></td>
                    <td className="muted">{formatSize(o.size)}</td>
                    <td className="muted small">{o.modified ? new Date(o.modified).toLocaleString() : ''}</td>
                    <td><a className="download-link" href={api.s3ObjectUrl(bucket, o.key, true)}><Icon name="download" size={14} />Download</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            {listing && busy !== 'objects' && shownPrefixes.length === 0 && shownObjects.length === 0 && (
              <div className="empty table-empty">
                {objectQuery ? <>No objects match “{objectQuery}”. <button className="link" onClick={() => setObjectQuery('')}>Clear filter</button></> : 'This location is empty. Drop files here or use Upload.'}
              </div>
            )}
            {listing?.truncated && <button disabled={!!busy} onClick={loadMore}>Load more</button>}
            {preview && (
              <div className="preview">
                <div className="row"><b className="mono">{preview.key}</b><span className="spacer" /><button onClick={() => setPreview(null)}>Close</button></div>
                {preview.text !== null ? <pre>{preview.text || '(empty)'}</pre> : <div className="muted">{preview.note}</div>}
              </div>
            )}
            </>
            )}
            </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
