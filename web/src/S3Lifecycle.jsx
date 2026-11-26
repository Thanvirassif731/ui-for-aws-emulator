import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import Icon from './Icon.jsx';
import { confirmDialog } from './dialogs.js';
import { ErrorBanner, Hint, PanelHead, useLatestRequest, useSandboxAction } from './S3SandboxShared.jsx';

const EMPTY_RULE = { id: '', prefix: '', expirationDays: '', noncurrentDays: '' };
const JUMPS = [1, 7, 30];

const ACTION_TEXT = {
  DELETE_MARKER_CREATED: { label: 'Delete marker created', tone: 'warn', explain: 'The current version expired. Versioning is on, so S3 added a delete marker; the data survives as a noncurrent version.' },
  DELETED: { label: 'Deleted', tone: 'bad', explain: 'The object expired. The bucket is not versioned, so it was removed permanently.' },
  NONCURRENT_PURGED: { label: 'Noncurrent version purged', tone: 'bad', explain: 'This older version had been noncurrent long enough, so S3 deleted it permanently.' },
};

function validDays(value) {
  if (value === '') return true;
  const days = Number(value);
  return Number.isInteger(days) && days >= 1 && days <= 36500;
}

export default function S3Lifecycle({ bucket, versioning, auditLog, onAudit, onChanged }) {
  const [rules, setRules] = useState(null);
  const [clock, setClock] = useState({ simulatedDaysOffset: 0, simulatedNow: null });
  const [form, setForm] = useState(EMPTY_RULE);
  const { busy, error, setError, run } = useSandboxAction('S3 lifecycle');
  const begin = useLatestRequest(bucket);

  const apply = (data) => { setRules(data.rules); setClock(data.clock); };

  const load = useCallback(() => run('load', async () => {
    const isLatest = begin();
    const data = await api.s3Lifecycle(bucket);
    if (isLatest()) apply(data);
  }), [bucket, run, begin]);
  useEffect(() => { setRules(null); load(); }, [load]);

  const formValid = form.id.trim() && validDays(form.expirationDays) && validDays(form.noncurrentDays) && (form.expirationDays !== '' || form.noncurrentDays !== '');
  const replacing = rules?.some((rule) => rule.id === form.id.trim());

  const saveRule = () => run('save', async () => {
    apply(await api.s3SaveLifecycleRule(bucket, {
      id: form.id.trim(),
      prefix: form.prefix,
      expirationDays: form.expirationDays === '' ? null : Number(form.expirationDays),
      noncurrentDays: form.noncurrentDays === '' ? null : Number(form.noncurrentDays),
    }));
    setForm(EMPTY_RULE);
  }, `Lifecycle rule “${form.id.trim()}” ${replacing ? 'updated' : 'created'} (PutBucketLifecycleConfiguration).`);

  const deleteRule = async (id) => {
    const confirmed = await confirmDialog({ title: `Delete rule “${id}”?`, message: 'The rule stops expiring objects. Objects it already expired are not restored.', confirmLabel: 'Delete rule' });
    if (!confirmed) return;
    run(`delete:${id}`, async () => apply(await api.s3DeleteLifecycleRule(bucket, id)), `Lifecycle rule “${id}” deleted.`);
  };

  const jump = (days) => run(`jump:${days}`, async () => {
    const result = await api.s3SimulateTime(bucket, days);
    setClock({ simulatedDaysOffset: result.simulatedDaysOffset, simulatedNow: result.simulatedNow });
    onAudit({ ...result, at: new Date().toISOString() });
    if (result.log.length) onChanged?.();
    return result;
  }, (result) => (result.log.length
    ? `+${days} ${days === 1 ? 'day' : 'days'}: ${result.log.length} lifecycle ${result.log.length === 1 ? 'action' : 'actions'} ran.`
    : `+${days} ${days === 1 ? 'day' : 'days'}: no object reached a lifecycle threshold.`));

  const reset = async () => {
    const confirmed = await confirmDialog({ title: 'Reset the simulated clock?', message: 'The offset returns to +0 days and the audit log is cleared. Objects that were already expired or purged stay deleted.', confirmLabel: 'Reset clock', tone: 'default' });
    if (!confirmed) return;
    run('reset', async () => {
      const next = await api.s3ResetClock(bucket);
      setClock(next);
      onAudit(null);
    }, 'Simulated clock reset to +0 days.');
  };

  return (
    <div className="sandbox-stack">
      <ErrorBanner error={error} onDismiss={() => setError('')} />
      <section className="sandbox-panel" aria-labelledby="lifecycle-rules-title">
        <PanelHead id="lifecycle-rules-title" eyebrow="PutBucketLifecycleConfiguration" title="Lifecycle Rules" hint="Lifecycle rules let S3 clean up for you: expire objects after N days, and permanently delete old (noncurrent) versions after N days. Real S3 runs them about once a day; here you fast-forward the clock instead." />
        {versioning !== 'Enabled' && (
          <div className="sandbox-tip"><Icon name="info" size={15} /><span>{versioning === 'Suspended' ? 'Versioning is suspended.' : 'Versioning is off.'} Expiring a current object then {versioning === 'Suspended' ? 'replaces its null version with a delete marker' : 'deletes it permanently'}. Enable versioning on the Objects tab to see delete markers and noncurrent versions.</span></div>
        )}
        <div className="sandbox-grid four">
          <label><span>Rule ID</span><input value={form.id} maxLength={255} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="expire-logs" /></label>
          <label><span>Prefix filter <Hint text="The rule applies only to keys that start with this text, such as logs/. Leave it empty to apply the rule to the whole bucket." /></span><input value={form.prefix} onChange={(e) => setForm({ ...form, prefix: e.target.value })} placeholder="logs/ (empty = whole bucket)" /></label>
          <label>
            <span>Expire current objects after (days) <Hint text="Expiration.Days. Counted from the object's last-modified time. On a versioned bucket this adds a delete marker instead of destroying data." /></span>
            <input type="number" min="1" max="36500" value={form.expirationDays} aria-invalid={!validDays(form.expirationDays)} onChange={(e) => setForm({ ...form, expirationDays: e.target.value })} placeholder="30" />
          </label>
          <label>
            <span>Permanently delete noncurrent versions after (days) <Hint text="NoncurrentVersionExpiration.NoncurrentDays. Counted from the moment a version stopped being current, that is, when a newer version or delete marker was written." /></span>
            <input type="number" min="1" max="36500" value={form.noncurrentDays} aria-invalid={!validDays(form.noncurrentDays)} onChange={(e) => setForm({ ...form, noncurrentDays: e.target.value })} placeholder="7" />
          </label>
        </div>
        <div className="sandbox-actions">
          <span className="muted small">{(!validDays(form.expirationDays) || !validDays(form.noncurrentDays)) ? 'Days must be whole numbers from 1 to 36500.' : replacing ? 'A rule with this ID exists; saving replaces it.' : 'Set at least one of the two day counts.'}</span>
          <button className="primary" disabled={!formValid || !!busy} onClick={saveRule}>{busy === 'save' ? <><span className="spinner" />Saving…</> : replacing ? 'Update rule' : 'Add rule'}</button>
        </div>
        <div className="objects-wrap">
          <table className="objects">
            <thead><tr><th>Rule ID</th><th>Status</th><th>Prefix</th><th>Expire current</th><th>Delete noncurrent</th><th /></tr></thead>
            <tbody>
              {!rules && busy === 'load' && <tr><td colSpan={6}><div className="loading-state compact" role="status"><span className="spinner" />Loading rules…</div></td></tr>}
              {rules?.map((rule) => (
                <tr key={rule.id}>
                  <td className="mono">{rule.id}</td>
                  <td><span className={`vbadge ${rule.status === 'Enabled' ? 'latest' : 'previous'}`}>{rule.status}</span></td>
                  <td className="mono small">{rule.prefix || <span className="muted">(whole bucket)</span>}{rule.hasTagFilter && <span className="muted small"> + tag filter</span>}</td>
                  <td className="small">{rule.expirationDays ? `after ${rule.expirationDays} days` : rule.expirationDate ? `on ${new Date(rule.expirationDate).toLocaleDateString()}` : '—'}</td>
                  <td className="small">{rule.noncurrentDays ? `after ${rule.noncurrentDays} days${rule.newerNoncurrentVersions ? ` (keep ${rule.newerNoncurrentVersions} newest)` : ''}` : '—'}</td>
                  <td className="row-actions">
                    <button className="link" disabled={!!busy} onClick={() => setForm({ id: rule.id, prefix: rule.prefix, expirationDays: rule.expirationDays ?? '', noncurrentDays: rule.noncurrentDays ?? '' })}>Edit</button>
                    <button className="danger-link" disabled={!!busy} onClick={() => deleteRule(rule.id)}><Icon name="trash" size={13} />Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rules && !rules.length && <div className="empty table-empty">No lifecycle rules yet. Add one above, for example ID expire-logs, prefix logs/, 30 days.</div>}
      </section>

      <section className="sandbox-panel" aria-labelledby="time-travel-title">
        <PanelHead id="time-travel-title" eyebrow="Time-travel demo" title="Fast-forward time" hint="Each jump adds days to this bucket's simulated clock, then applies every Enabled rule to every object version using its simulated age. Real objects are deleted in the emulator, just as S3 would do it." />
        <div className="time-bar">
          <div className="time-offset" aria-live="polite">
            <span className="eyebrow">Current Simulated Offset</span>
            <b>+{clock.simulatedDaysOffset} {clock.simulatedDaysOffset === 1 ? 'Day' : 'Days'}</b>
            {clock.simulatedNow && <span className="muted small">Simulated date: {new Date(clock.simulatedNow).toLocaleString()}</span>}
          </div>
          <div className="time-buttons">
            {JUMPS.map((days) => (
              <button key={days} disabled={!!busy} onClick={() => jump(days)}>
                {busy === `jump:${days}` ? <span className="spinner" /> : <Icon name="clock" size={14} />}+{days} {days === 1 ? 'Day' : 'Days'}
              </button>
            ))}
            <button className="subtle-button" disabled={!!busy || (!clock.simulatedDaysOffset && !auditLog?.length)} onClick={reset}><Icon name="refresh" size={14} />Reset Clock</button>
          </div>
        </div>

        <div className="audit-log" aria-label="Lifecycle Execution Audit Log">
          <div className="audit-title"><b>Lifecycle Execution Audit Log</b><span className="muted small">Newest jump first</span></div>
          {!auditLog?.length && <div className="empty compact">No jumps yet. Add a rule, then press +1 Day, +7 Days, or +30 Days.</div>}
          {auditLog?.map((jumpResult) => (
            <div key={jumpResult.at} className="audit-jump">
              <div className="audit-jump-head">
                <Icon name="clock" size={14} />
                <b>+{jumpResult.advancedDays} {jumpResult.advancedDays === 1 ? 'day' : 'days'}</b>
                <span className="muted small">offset now +{jumpResult.simulatedDaysOffset} · simulated {new Date(jumpResult.simulatedNow).toLocaleDateString()} · {jumpResult.rulesEvaluated} {jumpResult.rulesEvaluated === 1 ? 'rule' : 'rules'} · {jumpResult.versionsScanned} versions checked</span>
              </div>
              {!jumpResult.log.length && <p className="muted small audit-none">Nothing reached a lifecycle threshold on this jump.</p>}
              <ul>
                {jumpResult.log.map((entry) => {
                  const text = ACTION_TEXT[entry.action];
                  return (
                    <li key={`${entry.key}:${entry.versionId}:${entry.action}`}>
                      <span className={`vbadge ${text.tone}`}>{text.label}</span>
                      <span className="mono">{entry.key}</span>
                      <span className="muted small mono" title="Version ID">{entry.versionId}</span>
                      <span className="small">Rule <code>{entry.ruleId}</code>: {entry.thresholdDays != null ? `simulated age ${entry.simulatedAgeDays} days ≥ ${entry.thresholdDays} days.` : 'the rule\'s expiration date has passed in simulated time.'} {text.explain}</span>
                    </li>
                  );
                })}
              </ul>
              {jumpResult.notes.map((note) => <p key={note} className="small audit-note"><Icon name="info" size={12} />{note}</p>)}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
