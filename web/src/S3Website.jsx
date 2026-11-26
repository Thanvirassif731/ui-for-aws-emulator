import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import Icon from './Icon.jsx';
import { ErrorBanner, Hint, PanelHead, useLatestRequest, useSandboxAction } from './S3SandboxShared.jsx';

export default function S3Website({ bucket, onChanged, onOpenTab }) {
  const [status, setStatus] = useState(null);
  const [form, setForm] = useState({ enabled: false, indexDocument: 'index.html', errorDocument: '404.html' });
  const { busy, error, setError, run } = useSandboxAction('S3 static website');
  const begin = useLatestRequest(bucket);

  const apply = (next) => {
    setStatus(next);
    setForm({ enabled: next.enabled, indexDocument: next.indexDocument || 'index.html', errorDocument: next.enabled ? next.errorDocument : (next.errorDocument || '404.html') });
  };

  const load = useCallback(() => run('load', async () => {
    const isLatest = begin();
    const next = await api.s3Website(bucket);
    if (isLatest()) apply(next);
  }), [bucket, run, begin]);

  useEffect(() => { setStatus(null); load(); }, [load]);

  const save = () => run('save', async () => {
    apply(await api.s3SetWebsite(bucket, form));
  }, form.enabled ? 'Static website hosting saved (PutBucketWebsite).' : 'Static website hosting disabled (DeleteBucketWebsite).');

  const loadSample = () => run('sample', async () => {
    await api.s3LoadSampleSite(bucket);
    await load();
    onChanged?.();
  }, 'Uploaded index.html, style.css, and 404.html. Open the website endpoint to view them.');

  const dirty = status && (form.enabled !== status.enabled
    || (form.enabled && (form.indexDocument.trim() !== status.indexDocument || form.errorDocument.trim() !== status.errorDocument)));

  return (
    <div className="sandbox-stack">
      <ErrorBanner error={error} onDismiss={() => setError('')} />
      <section className="sandbox-panel" aria-labelledby="website-config-title">
        <PanelHead id="website-config-title" eyebrow="PutBucketWebsite" title="Static Website Hosting" hint="S3 can serve a bucket as a website: it returns the index document for folder paths and the error document when a key is missing. Website endpoints are plain HTTP; real deployments add CloudFront for HTTPS.">
          <button disabled={!!busy} onClick={loadSample} title="Uploads index.html, style.css, and 404.html with SSE-S3 encryption">
            {busy === 'sample' ? <span className="spinner" /> : <Icon name="upload" size={15} />}Load Sample Portfolio Site
          </button>
        </PanelHead>
        {!status && busy === 'load' ? <div className="loading-state compact" role="status"><span className="spinner" />Loading website configuration…</div> : (
          <div className="sandbox-form">
            <label className="check-label toggle-row">
              <input type="checkbox" role="switch" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
              <span><b>Enable static website hosting</b><small>Turning this off deletes the website configuration. Objects are not touched.</small></span>
            </label>
            <div className="sandbox-grid two">
              <label>
                <span>Index document <Hint text="Returned for the site root and for any path ending in '/'. For example /docs/ serves docs/index.html. It must be a file name, not a path." /></span>
                <input value={form.indexDocument} disabled={!form.enabled} onChange={(e) => setForm({ ...form, indexDocument: e.target.value })} placeholder="index.html" />
              </label>
              <label>
                <span>Error document (optional) <Hint text="Returned with HTTP 404 when a requested key does not exist. It must be publicly readable too, or visitors see S3's default XML error." /></span>
                <input value={form.errorDocument} disabled={!form.enabled} onChange={(e) => setForm({ ...form, errorDocument: e.target.value })} placeholder="404.html" />
              </label>
            </div>
            <div className="sandbox-actions">
              {dirty && <span className="muted small">Unsaved changes</span>}
              <button className="primary" disabled={!!busy || !dirty || (form.enabled && !form.indexDocument.trim())} onClick={save}>{busy === 'save' ? <><span className="spinner" />Saving…</> : 'Save website settings'}</button>
            </div>
          </div>
        )}
      </section>

      {status && (
        <section className="sandbox-panel" aria-labelledby="website-endpoint-title">
          <PanelHead id="website-endpoint-title" eyebrow="Website endpoint" title="Bucket Website Endpoint" hint="In AWS this looks like http://BUCKET.s3-website-REGION.amazonaws.com. The sandbox serves the same rules from a local URL on its own port, so your site's HTML can never act as this console.">
            <button className="subtle-button" disabled={!!busy} onClick={load}><Icon name="refresh" size={14} />Re-check</button>
          </PanelHead>
          <div className="endpoint-row">
            <Icon name="external" size={15} />
            <a className="endpoint-link mono" href={status.endpoint} target="_blank" rel="noopener noreferrer">{status.endpoint}</a>
          </div>
          <ol className="checklist" aria-label="Website readiness checklist">
            {status.checklist.map((item) => (
              <li key={item.id} className={item.ok ? 'ok' : 'fail'}>
                <span className="check-mark" aria-hidden="true">{item.ok ? '✓' : '✗'}</span>
                <div>
                  <b>{item.label}</b><span className="sr-only">{item.ok ? ': done' : ': not done'}</span>
                  <p>{item.hint}</p>
                  {!item.ok && item.id !== 'website' && <button className="link" onClick={() => onOpenTab('permissions')}>Open Permissions</button>}
                </div>
              </li>
            ))}
          </ol>
          <div className={`sandbox-tip ${status.ready ? 'good' : 'warn'}`}>
            <Icon name={status.ready ? 'check' : 'alert'} size={15} />
            <span>{status.ready
              ? 'All three checks pass. Anonymous visitors can open the endpoint above.'
              : 'Until all three checks pass, the endpoint answers 404 NoSuchWebsiteConfiguration or 403 AccessDenied. The response header X-Learner-Hint explains which rule blocked it.'}</span>
          </div>
        </section>
      )}
    </div>
  );
}
