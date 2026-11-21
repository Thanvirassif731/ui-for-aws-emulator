import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import Icon from './Icon.jsx';
import { notifyError, notifySuccess, notifyWarning } from './notifications.js';
import { refreshResourceViews } from './resourceEvents.js';

function snapshotCounts(snapshot) {
  if (!snapshot || snapshot.version !== '1.0' || !snapshot.services ||
      !Array.isArray(snapshot.services.s3) || !Array.isArray(snapshot.services.dynamodb) || !Array.isArray(snapshot.services.sqs)) {
    throw new Error('Select a valid version 1.0 emulator snapshot.');
  }
  return {
    buckets: snapshot.services.s3.length,
    tables: snapshot.services.dynamodb.length,
    queues: snapshot.services.sqs.length,
  };
}

function focusableElements(root) {
  return [...root.querySelectorAll('button:not(:disabled), input:not(:disabled):not([type="file"]), [href], [tabindex]:not([tabindex="-1"])')];
}

export default function SnapshotControls({ disabled = false }) {
  const [exportOpen, setExportOpen] = useState(false);
  const [includeMessages, setIncludeMessages] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  const [fileName, setFileName] = useState('');
  const [counts, setCounts] = useState(null);
  const [cleanFirst, setCleanFirst] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const exportRoot = useRef(null);
  const dialog = useRef(null);
  const fileInput = useRef(null);
  const restoreButton = useRef(null);
  const closeButton = useRef(null);

  useEffect(() => {
    if (!exportOpen) return undefined;
    const outside = (event) => { if (!exportRoot.current?.contains(event.target)) setExportOpen(false); };
    const key = (event) => {
      if (event.key === 'Escape') {
        setExportOpen(false);
        exportRoot.current?.querySelector('.snapshot-export-button')?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key);
    };
  }, [exportOpen]);

  useEffect(() => {
    if (!restoreOpen) return undefined;
    window.setTimeout(() => closeButton.current?.focus(), 0);
    const previous = restoreButton.current;
    return () => previous?.focus();
  }, [restoreOpen]);

  const exportSeed = async () => {
    setExporting(true);
    setAnnouncement('Exporting emulator seed.');
    try {
      const blob = await api.snapshotExport(includeMessages);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'emulator-seed.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setAnnouncement('Emulator seed downloaded.');
      setExportOpen(false);
      notifySuccess('emulator-seed.json downloaded.', { title: 'Snapshot exported', source: 'Snapshots' });
    } catch (exportError) {
      setAnnouncement(`Snapshot export failed: ${exportError.message}`);
    } finally {
      setExporting(false);
    }
  };

  const resetRestore = () => {
    setSnapshot(null);
    setFileName('');
    setCounts(null);
    setCleanFirst(false);
    setResult(null);
    setError('');
    setDragActive(false);
  };

  const openRestore = () => {
    resetRestore();
    setExportOpen(false);
    setRestoreOpen(true);
  };

  const closeRestore = () => {
    if (!importing) setRestoreOpen(false);
  };

  const readFile = async (file) => {
    if (!file) return;
    setError('');
    setResult(null);
    try {
      if (!file.name.toLowerCase().endsWith('.json')) throw new Error('Select a .json snapshot file.');
      const parsed = JSON.parse(await file.text());
      const preview = snapshotCounts(parsed);
      setSnapshot(parsed);
      setFileName(file.name);
      setCounts(preview);
      setAnnouncement(`Snapshot ready: ${preview.buckets} buckets, ${preview.tables} tables, and ${preview.queues} queues.`);
    } catch (readError) {
      setSnapshot(null);
      setFileName(file.name);
      setCounts(null);
      setError(readError instanceof SyntaxError ? 'The selected file is not valid JSON.' : readError.message);
    }
  };

  const restoreSeed = async () => {
    if (!snapshot) return;
    setImporting(true);
    setError('');
    setResult(null);
    setAnnouncement('Restoring emulator seed.');
    try {
      const response = await api.snapshotImport(snapshot, cleanFirst);
      setResult(response.summary);
      refreshResourceViews();
      const summary = response.summary;
      setAnnouncement(`Restore complete: ${summary.s3.buckets} buckets, ${summary.dynamodb.tables} tables, and ${summary.sqs.queues} queues restored.`);
      if (summary.errors.length) {
        notifyWarning(`Restore completed with ${summary.errors.length} partial ${summary.errors.length === 1 ? 'error' : 'errors'}.`, { title: 'Snapshot partially restored', source: 'Snapshots' });
      } else {
        notifySuccess('S3, DynamoDB, and SQS resources restored.', { title: 'Snapshot restored', source: 'Snapshots' });
      }
    } catch (restoreError) {
      setError(restoreError.message);
      setAnnouncement(`Snapshot restore failed: ${restoreError.message}`);
      notifyError(restoreError, { title: 'Snapshot restore failed', source: 'Snapshots' });
    } finally {
      setImporting(false);
    }
  };

  const onDialogKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeRestore();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = focusableElements(dialog.current);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <div className="snapshot-controls">
        <div className="snapshot-export" ref={exportRoot}>
          <button
            className="snapshot-export-button"
            disabled={disabled || exporting}
            aria-expanded={exportOpen}
            aria-controls="snapshot-export-popover"
            onClick={() => setExportOpen((open) => !open)}
          >
            <Icon name="download" size={14} />{exporting ? 'Exporting…' : 'Export seed'}
          </button>
          {exportOpen && (
            <section id="snapshot-export-popover" className="snapshot-popover" role="dialog" aria-label="Export emulator seed">
              <b>Export emulator seed</b>
              <p>Download S3, DynamoDB, and SQS state as portable JSON.</p>
              <label className="check-label"><input type="checkbox" checked={includeMessages} onChange={(event) => setIncludeMessages(event.target.checked)} />Include available SQS messages</label>
              <button className="primary" disabled={exporting} onClick={exportSeed}><Icon name="download" size={14} />{exporting ? 'Preparing…' : 'Download seed'}</button>
            </section>
          )}
        </div>
        <button ref={restoreButton} disabled={disabled || importing} onClick={openRestore}><Icon name="upload" size={14} />Restore seed</button>
      </div>
      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>

      {restoreOpen && (
        <div className="dialog-backdrop snapshot-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeRestore(); }}>
          <section className="snapshot-dialog" role="dialog" aria-modal="true" aria-labelledby="snapshot-dialog-title" ref={dialog} onKeyDown={onDialogKeyDown}>
            <header className="snapshot-dialog-head">
              <div><div className="eyebrow">Ephemeral state</div><h2 id="snapshot-dialog-title">Restore emulator seed</h2></div>
              <button ref={closeButton} className="notification-close" aria-label="Close restore dialog" disabled={importing} onClick={closeRestore}>×</button>
            </header>
            <div className="snapshot-dialog-body">
              <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(event) => { readFile(event.target.files?.[0]); event.target.value = ''; }} />
              <div
                className={`snapshot-dropzone ${dragActive ? 'drag-active' : ''}`}
                role="button"
                tabIndex="0"
                aria-label="Choose or drop an emulator snapshot JSON file"
                onClick={() => fileInput.current?.click()}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.current?.click(); } }}
                onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragActive(false); }}
                onDrop={(event) => { event.preventDefault(); setDragActive(false); readFile(event.dataTransfer.files?.[0]); }}
              >
                <Icon name="upload" size={26} />
                <b>{fileName || 'Choose a snapshot file'}</b>
                <span>Drop emulator-seed.json here or select a file.</span>
              </div>

              {error && <div className="error" role="alert"><span>{error}</span></div>}
              {counts && (
                <div className="snapshot-preview" aria-label="Snapshot resource preview">
                  <span><b>{counts.buckets}</b>S3 {counts.buckets === 1 ? 'bucket' : 'buckets'}</span>
                  <span><b>{counts.tables}</b>DynamoDB {counts.tables === 1 ? 'table' : 'tables'}</span>
                  <span><b>{counts.queues}</b>SQS {counts.queues === 1 ? 'queue' : 'queues'}</span>
                </div>
              )}
              {snapshot && (
                <label className="check-label wipe-option"><input type="checkbox" checked={cleanFirst} onChange={(event) => setCleanFirst(event.target.checked)} />
                  <span><b>Wipe existing S3, DynamoDB, and SQS resources before restoring</b><small>This permanently removes current resources from the emulator.</small></span>
                </label>
              )}
              {result && (
                <section className={`snapshot-result ${result.errors.length ? 'partial' : 'success'}`} role="status">
                  <h3>{result.errors.length ? 'Restore completed with errors' : 'Restore complete'}</h3>
                  <p>{result.s3.buckets} buckets and {result.s3.objects} objects · {result.dynamodb.tables} tables and {result.dynamodb.items} items · {result.sqs.queues} queues and {result.sqs.messages} messages</p>
                  {result.s3.skipped > 0 && <p>{result.s3.skipped} S3 objects skipped.</p>}
                  {result.errors.length > 0 && <ul>{result.errors.map((item, index) => <li key={`${item.service}-${item.resource}-${index}`}><b>{item.service}</b> {item.resource || item.operation}: {item.message}</li>)}</ul>}
                </section>
              )}
            </div>
            <footer className="snapshot-dialog-actions">
              <button disabled={importing} onClick={closeRestore}>{result ? 'Close' : 'Cancel'}</button>
              {!result && <button className="primary" disabled={!snapshot || importing} onClick={restoreSeed}>{importing ? <><span className="spinner" />Restoring…</> : 'Restore resources'}</button>}
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
