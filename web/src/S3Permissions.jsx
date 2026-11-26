import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import Icon from './Icon.jsx';
import { confirmDialog } from './dialogs.js';
import { POLICY_PRESETS, presetPolicyText } from './s3PolicyPresets.js';
import { ErrorBanner, Hint, PanelHead, useLatestRequest, useSandboxAction } from './S3SandboxShared.jsx';

const PAB_SETTINGS = [
  { field: 'BlockPublicAcls', label: 'Block new public ACLs', detail: 'S3 rejects requests that add a public access control list (ACL) to the bucket or its objects.' },
  { field: 'IgnorePublicAcls', label: 'Ignore existing public ACLs', detail: 'S3 ignores public ACLs that are already attached, so they grant nothing.' },
  { field: 'BlockPublicPolicy', label: 'Block public bucket policies', detail: 'S3 rejects PutBucketPolicy when the policy would make the bucket public, for example Principal "*" with s3:GetObject.' },
  { field: 'RestrictPublicBuckets', label: 'Restrict public buckets', detail: 'Even if a public policy is already attached, anonymous requests are refused. Only principals in your own account keep access.' },
];

const ACTIONS = ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'];
const EMPTY_PAB = { BlockPublicAcls: false, IgnorePublicAcls: false, BlockPublicPolicy: false, RestrictPublicBuckets: false };

function pretty(policy) {
  if (!policy) return '';
  try { return JSON.stringify(JSON.parse(policy), null, 2); } catch { return policy; }
}

function jsonProblem(text) {
  if (!text.trim()) return '';
  try { JSON.parse(text); return ''; } catch (e) { return e.message; }
}

const DECISION_LABEL = { ALLOWED: 'Allowed', EXPLICIT_DENY: 'Explicit deny', IMPLICIT_DENY: 'Implicit deny' };

function PublicAccessPanel({ bucket, onChanged }) {
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState(EMPTY_PAB);
  const masterInput = useRef();
  const { busy, error, setError, run } = useSandboxAction('S3 Block Public Access');
  const begin = useLatestRequest(bucket);

  const load = useCallback(() => run('load', async () => {
    const isLatest = begin();
    const next = await api.s3PublicAccessBlock(bucket);
    if (isLatest()) { setSaved(next); setForm(Object.fromEntries(PAB_SETTINGS.map(({ field }) => [field, next[field]]))); }
  }), [bucket, run, begin]);
  useEffect(() => { setSaved(null); load(); }, [load]);

  const values = PAB_SETTINGS.map(({ field }) => form[field]);
  const all = values.every(Boolean);
  const some = values.some(Boolean);
  useEffect(() => { if (masterInput.current) masterInput.current.indeterminate = some && !all; }, [some, all]);

  const dirty = saved && PAB_SETTINGS.some(({ field }) => form[field] !== saved[field]);
  const savedBlocksWebsite = saved && (saved.BlockPublicPolicy || saved.RestrictPublicBuckets);
  const savedAny = saved && PAB_SETTINGS.some(({ field }) => saved[field]);

  const save = async () => {
    const loosening = PAB_SETTINGS.some(({ field }) => saved[field] && !form[field]);
    if (loosening) {
      const confirmed = await confirmDialog({
        title: 'Allow public access?',
        message: 'With these settings off, a bucket policy or ACL can make objects readable by anyone on the internet. In real AWS, turn Block Public Access off only for buckets that are meant to be public, such as a static website.',
        confirmLabel: 'Save settings',
        tone: 'default',
      });
      if (!confirmed) return;
    }
    run('save', async () => {
      const next = await api.s3SetPublicAccessBlock(bucket, form);
      setSaved(next);
      onChanged?.();
    }, 'Block Public Access settings saved (PutPublicAccessBlock).');
  };

  return (
    <section className="sandbox-panel" aria-labelledby="pab-title">
      <PanelHead id="pab-title" eyebrow="PutPublicAccessBlock" title="Block Public Access" hint="A safety switch that overrides policies and ACLs. New AWS buckets have all four settings on. When it is on, nothing in the bucket can be made public, whatever the bucket policy says." />
      <ErrorBanner error={error} onDismiss={() => setError('')} />
      {savedAny && (
        <div className="sandbox-tip warn" role="status">
          <Icon name="lock" size={15} />
          <span>
            <b>Block Public Access is on.</b>{' '}
            {savedBlocksWebsite
              ? 'Anonymous visitors are refused even if your bucket policy allows Principal "*". Your static website endpoint will return 403 AccessDenied until you turn off "Block public bucket policies" and "Restrict public buckets".'
              : 'Public ACLs are blocked. A public bucket policy can still grant access because the policy settings are off.'}
          </span>
        </div>
      )}
      {!saved && busy === 'load' ? <div className="loading-state compact" role="status"><span className="spinner" />Loading settings…</div> : (
        <div className="sandbox-form">
          <label className="check-label toggle-row master">
            <input ref={masterInput} type="checkbox" checked={all} onChange={(e) => setForm(Object.fromEntries(PAB_SETTINGS.map(({ field }) => [field, e.target.checked])))} />
            <span><b>Block all public access</b><small>Turns on all four settings below.</small></span>
          </label>
          <div className="pab-settings">
            {PAB_SETTINGS.map(({ field, label, detail }) => (
              <label key={field} className="check-label">
                <input type="checkbox" checked={form[field]} onChange={(e) => setForm({ ...form, [field]: e.target.checked })} />
                <span><b>{label}</b> <code className="small">{field}</code><small>{detail}</small></span>
              </label>
            ))}
          </div>
          <div className="sandbox-actions">
            {dirty && <span className="muted small">Unsaved changes</span>}
            <button className="primary" disabled={!dirty || !!busy} onClick={save}>{busy === 'save' ? <><span className="spinner" />Saving…</> : 'Save Block Public Access'}</button>
          </div>
        </div>
      )}
    </section>
  );
}

function PolicyPanel({ bucket, onChanged }) {
  const [saved, setSaved] = useState(undefined);
  const [draft, setDraft] = useState('');
  const [presetId, setPresetId] = useState('');
  const [sim, setSim] = useState({ action: 's3:GetObject', key: 'index.html', caller: 'anonymous', sse: '' });
  const [result, setResult] = useState(null);
  const { busy, error, setError, run } = useSandboxAction('S3 bucket policy');
  const begin = useLatestRequest(bucket);

  const load = useCallback(() => run('load', async () => {
    const isLatest = begin();
    const { policy } = await api.s3Policy(bucket);
    if (isLatest()) { setSaved(policy); setDraft(pretty(policy)); setResult(null); }
  }), [bucket, run, begin]);
  useEffect(() => { setSaved(undefined); setDraft(''); setResult(null); load(); }, [load]);

  const problem = jsonProblem(draft);
  const dirty = saved !== undefined && draft.trim() !== pretty(saved).trim();
  const activePreset = POLICY_PRESETS.find((preset) => draft.trim() === presetPolicyText(preset.id, bucket));

  const choosePreset = async (id) => {
    setPresetId('');
    if (!id) return;
    if (draft.trim() && dirty) {
      const confirmed = await confirmDialog({ title: 'Replace the editor contents?', message: 'Your unsaved edits will be replaced by the preset. The saved bucket policy does not change until you select Save policy.', confirmLabel: 'Replace', tone: 'default' });
      if (!confirmed) return;
    }
    setDraft(presetPolicyText(id, bucket));
    setResult(null);
  };

  const save = () => run('save', async () => {
    const { policy } = await api.s3SetPolicy(bucket, draft);
    setSaved(policy);
    setDraft(pretty(policy));
    onChanged?.();
  }, 'Bucket policy saved (PutBucketPolicy).');

  const remove = async () => {
    const confirmed = await confirmDialog({ title: 'Delete the bucket policy?', message: 'Every grant and deny in the policy stops applying immediately. Public visitors lose access granted by the policy.', confirmLabel: 'Delete policy' });
    if (!confirmed) return;
    run('delete', async () => {
      await api.s3DeletePolicy(bucket);
      setSaved(null);
      setDraft('');
      onChanged?.();
    }, 'Bucket policy deleted (DeleteBucketPolicy).');
  };

  const test = () => run('simulate', async () => {
    const headers = sim.action === 's3:PutObject' && sim.sse ? { 'x-amz-server-side-encryption': sim.sse } : {};
    setResult(await api.s3SimulatePolicy(bucket, {
      action: sim.action,
      key: sim.key,
      isAnonymous: sim.caller === 'anonymous',
      headers,
      policy: draft.trim() ? draft : null,
    }));
  });

  return (
    <>
      <section className="sandbox-panel" aria-labelledby="policy-title">
        <PanelHead id="policy-title" eyebrow="PutBucketPolicy" title="Bucket Policy" hint="A JSON document attached to the bucket. Each statement says who (Principal) may or may not (Effect) do what (Action) to which objects (Resource), optionally only under a Condition.">
          <label className="preset-picker">
            <span className="sr-only">Load beginner preset</span>
            <select value={presetId} onChange={(e) => choosePreset(e.target.value)} disabled={!!busy}>
              <option value="">Load Beginner Preset…</option>
              {POLICY_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
            </select>
          </label>
        </PanelHead>
        <ErrorBanner error={error} onDismiss={() => setError('')} />
        {activePreset && <div className="sandbox-tip"><Icon name="info" size={15} /><span><b>{activePreset.label}.</b> {activePreset.summary}</span></div>}
        <textarea
          className="policy-editor"
          aria-label="Bucket policy JSON"
          spellCheck="false"
          value={draft}
          placeholder={saved === null ? 'This bucket has no policy. Load a beginner preset or paste a policy here.' : ''}
          onChange={(e) => setDraft(e.target.value)}
          aria-invalid={!!problem}
          aria-describedby="policy-status"
        />
        <div className="sandbox-actions">
          <span id="policy-status" className={`small ${problem ? 'field-error' : 'muted'}`}>
            {problem ? `JSON error: ${problem}` : saved === undefined ? '' : dirty ? 'Unsaved changes' : saved ? 'Matches the saved policy' : 'No policy attached'}
          </span>
          <span className="spacer" />
          {saved && <button className="danger-button" disabled={!!busy} onClick={remove}><Icon name="trash" size={14} />Delete policy</button>}
          <button disabled={!!busy || !!problem || !draft.trim()} onClick={() => setDraft(pretty(draft))}>Format JSON</button>
          <button disabled={!!busy || !dirty} onClick={() => setDraft(pretty(saved))}>Revert</button>
          <button className="primary" disabled={!!busy || !dirty || !!problem || !draft.trim()} onClick={save}>{busy === 'save' ? <><span className="spinner" />Saving…</> : 'Save policy'}</button>
        </div>
      </section>

      <section className="sandbox-panel" aria-labelledby="simulator-title">
        <PanelHead id="simulator-title" eyebrow="Policy simulator" title="Test a request" hint="Evaluates the policy in the editor, including unsaved edits, the way S3 does: an explicit Deny wins, then any Allow, otherwise the request is implicitly denied. Saved Block Public Access settings also apply to anonymous callers." />
        <div className="simulator-bar">
          <label><span>Action</span>
            <select value={sim.action} onChange={(e) => setSim({ ...sim, action: e.target.value })}>{ACTIONS.map((action) => <option key={action}>{action}</option>)}</select>
          </label>
          <label className="grow"><span>Object key</span>
            <input value={sim.key} onChange={(e) => setSim({ ...sim, key: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && test()} placeholder="public/photo.jpg" />
          </label>
          <label><span>Caller <Hint text="Anonymous is anyone on the internet without credentials (Principal &quot;*&quot;). The authenticated student is an IAM user in the bucket owner's account; only the bucket policy is evaluated for them here." /></span>
            <select value={sim.caller} onChange={(e) => setSim({ ...sim, caller: e.target.value })}>
              <option value="anonymous">Anonymous Public User</option>
              <option value="student">Authenticated Student</option>
            </select>
          </label>
          {sim.action === 's3:PutObject' && (
            <label><span>Encryption header <Hint text="Sets x-amz-server-side-encryption on the simulated upload. Use it to see the SSE-S3 preset deny or allow a PutObject." /></span>
              <select value={sim.sse} onChange={(e) => setSim({ ...sim, sse: e.target.value })}>
                <option value="">None (unencrypted)</option>
                <option value="AES256">AES256 (SSE-S3)</option>
                <option value="aws:kms">aws:kms (SSE-KMS)</option>
              </select>
            </label>
          )}
          <button className="primary" disabled={!!busy || !sim.key.trim()} onClick={test}>{busy === 'simulate' ? <><span className="spinner" />Testing…</> : 'Test Request'}</button>
        </div>
        {result && (
          <div className={`verdict ${result.allowed ? 'allow' : 'deny'}`} role="status">
            <div className="verdict-head">
              <Icon name={result.allowed ? 'check' : 'lock'} size={18} />
              <b>{result.allowed ? 'Request allowed' : 'Request denied'}</b>
              <span className="verdict-decision mono">{result.decision}</span>
              {result.blockedBy === 'BlockPublicAccess' && <span className="vbadge marker">Blocked by Block Public Access</span>}
              {result.matchedStatementId && <span className="muted small">Statement: <code>{result.matchedStatementId}</code></span>}
            </div>
            <p>{result.explanation}</p>
            <p className="muted small">{DECISION_LABEL[result.decision]} · tested against the {result.policySource === 'draft' ? 'policy in the editor' : 'saved policy'} · resource <code>{result.resource}</code></p>
            {result.warnings?.map((warning) => <p key={warning} className="small verdict-warning">{warning}</p>)}
            {!!result.trace?.length && (
              <details>
                <summary>Show statement-by-statement evaluation</summary>
                <ol className="trace-list">
                  {result.trace.map((entry) => (
                    <li key={entry.sid} className={entry.matched ? 'matched' : ''}>
                      <code>{entry.sid}</code> <span className={`vbadge ${entry.effect === 'Deny' ? 'marker' : 'latest'}`}>{entry.effect}</span>{' '}
                      <b>{entry.matched ? 'applies' : 'does not apply'}</b>: {entry.reason}
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </div>
        )}
      </section>
    </>
  );
}

export default function S3Permissions({ bucket, onChanged }) {
  return (
    <div className="sandbox-stack">
      <PublicAccessPanel bucket={bucket} onChanged={onChanged} />
      <PolicyPanel bucket={bucket} onChanged={onChanged} />
    </div>
  );
}
