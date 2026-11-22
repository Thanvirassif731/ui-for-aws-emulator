import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import Icon from './Icon.jsx';
import { confirmDialog } from './dialogs.js';
import { notifyError, notifySuccess } from './notifications.js';

const Ec2TerminalModal = React.lazy(() => import('./Ec2TerminalModal.jsx'));

const AMI_PRESETS = [
  { id: 'ami-02404000000000001', label: 'Ubuntu 24.04 LTS', detail: 'ubuntu:24.04' },
  { id: 'ami-0d0cce00000000001', label: 'Docker-in-Docker Sandbox (privileged)', detail: 'docker:27.5.1-dind', privileged: true },
];
const INSTANCE_TYPES = ['t2.micro', 't3.micro', 't3.small'];
const TRANSITIONAL_STATES = new Set(['pending', 'stopping', 'shutting-down', 'rebooting']);

function stateTone(state) {
  if (state === 'running') return 'good';
  if (state === 'terminated') return 'bad';
  if (state === 'stopped') return 'neutral';
  return 'warn';
}

function displayName(instance) {
  return instance.name || instance.id;
}

function formatTime(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function mergeComputeStates(setComputeStates, compute) {
  if (!Array.isArray(compute?.instances)) return;
  setComputeStates((current) => {
    const next = { ...current };
    for (const entry of compute.instances) if (entry?.instanceId) next[entry.instanceId] = entry;
    return next;
  });
}

function GuideDialog({ onClose }) {
  const dialog = useRef(null);
  const closeButton = useRef(null);

  useEffect(() => {
    window.setTimeout(() => closeButton.current?.focus(), 0);
  }, []);

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.current.querySelectorAll('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first?.focus();
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="ec2-guide" role="dialog" aria-modal="true" aria-labelledby="ec2-guide-title" ref={dialog} onKeyDown={onKeyDown}>
        <header>
          <div><div className="eyebrow">Service tutorial</div><h2 id="ec2-guide-title">Amazon EC2 in the emulator</h2></div>
          <button ref={closeButton} className="notification-close" aria-label="Close EC2 tutorial" onClick={onClose}>×</button>
        </header>
        <div className="ec2-guide-body">
          <section><h3>What EC2 does</h3><p>Amazon Elastic Compute Cloud manages virtual server instances. An instance is launched from an Amazon Machine Image (AMI), receives an instance type that describes its capacity, and moves through lifecycle states such as pending, running, stopped, and terminated.</p></section>
          <section><h3>How this local emulator behaves</h3><p>The emulator keeps EC2 metadata locally. When Docker Desktop is active, this UI also starts an isolated local container for supported AMIs, runs user data, and provides a browser terminal. No resources are created in your AWS account and no AWS charges apply.</p></section>
          <ol className="ec2-guide-steps">
            <li><b>Choose an AMI.</b><span>The image supplies the simulated machine template.</span></li>
            <li><b>Choose an instance type.</b><span>Use a small type such as <code>t3.micro</code> while learning.</span></li>
            <li><b>Launch and inspect.</b><span>The instance starts in <code>pending</code> and then becomes <code>running</code>.</span></li>
            <li><b>Control its lifecycle.</b><span>Stop, start, reboot, or terminate the selected instance.</span></li>
          </ol>
          <div className="ec2-guide-note"><Icon name="info" size={17} /><span>Termination is permanent. Use the generic Console for modeled EC2 operations that are not yet represented on this page.</span></div>
        </div>
        <footer><button className="primary" onClick={onClose}>Got it</button></footer>
      </section>
    </div>
  );
}

export default function EC2({ onOpenService }) {
  const [instances, setInstances] = useState([]);
  const [nextToken, setNextToken] = useState(null);
  const [selectedId, setSelectedId] = useState('');
  const [images, setImages] = useState([]);
  const [dockerStatus, setDockerStatus] = useState(null);
  const [computeStates, setComputeStates] = useState({});
  const [terminalInstance, setTerminalInstance] = useState(null);
  const [ec2Service, setEc2Service] = useState(null);
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showLaunch, setShowLaunch] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [launch, setLaunch] = useState({ imageId: AMI_PRESETS[0].id, instanceType: 't3.micro', count: 1, name: '', portMappings: '', userData: '', allowPrivileged: false });
  const [announcement, setAnnouncement] = useState('');
  const guideButton = useRef(null);
  const launchButton = useRef(null);
  const imageInput = useRef(null);
  const transitionTimer = useRef(null);

  const loadInstances = useCallback(async ({ append = false, quiet = false } = {}) => {
    if (!quiet) setBusy(append ? 'more' : 'instances');
    setError('');
    try {
      const result = await api.ec2Instances(append ? nextToken : '');
      setInstances((current) => append ? [...current, ...result.instances.filter((item) => !current.some((held) => held.id === item.id))] : result.instances);
      mergeComputeStates(setComputeStates, result.compute);
      setNextToken(result.nextToken);
      setAnnouncement(`${result.instances.length} EC2 ${result.instances.length === 1 ? 'instance' : 'instances'} loaded.`);
      return result.instances;
    } catch (loadError) {
      setError(loadError.message);
      return [];
    } finally {
      if (!quiet) setBusy('');
    }
  }, [nextToken]);

  const loadDockerStatus = useCallback(async () => {
    try {
      const status = await api.ec2DockerStatus();
      setDockerStatus(status);
      return status;
    } catch (statusError) {
      setDockerStatus({ available: false, reason: 'The UI server could not check Docker. Refresh after confirming the server is running.' });
      return null;
    }
  }, []);

  useEffect(() => {
    loadInstances();
    loadDockerStatus();
    api.ec2Images().then((result) => {
      setImages(result.images);
    }).catch((loadError) => setError(loadError.message));
    api.services('EC2').then((services) => {
      setEc2Service(services.find((service) => service.signingName === 'ec2' && service.id.includes('ec2-amazonec2')) || null);
    }).catch(() => {});
  // Load the initial page once. Pagination changes should not reset it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => clearTimeout(transitionTimer.current), []);
  useEffect(() => { if (showLaunch) window.setTimeout(() => imageInput.current?.focus(), 0); }, [showLaunch]);

  const selected = instances.find((instance) => instance.id === selectedId) || null;
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return instances.filter((instance) => (stateFilter === 'all' || instance.state === stateFilter)
      && (!needle || `${instance.id} ${instance.name} ${instance.imageId} ${instance.instanceType} ${instance.privateIpAddress || ''}`.toLowerCase().includes(needle)));
  }, [instances, query, stateFilter]);
  const stateCounts = useMemo(() => instances.reduce((counts, instance) => ({ ...counts, [instance.state]: (counts[instance.state] || 0) + 1 }), {}), [instances]);

  const refreshInstancesById = useCallback(async (instanceIds) => {
    const result = await api.ec2DescribeInstances(instanceIds);
    mergeComputeStates(setComputeStates, result.compute);
    setInstances((current) => {
      const refreshed = new Map(result.instances.map((instance) => [instance.id, instance]));
      const merged = current.map((instance) => refreshed.get(instance.id) || instance);
      for (const instance of result.instances) if (!current.some((held) => held.id === instance.id)) merged.push(instance);
      return merged;
    });
    return result.instances;
  }, []);

  const scheduleTransitionRefresh = (instanceIds) => {
    clearTimeout(transitionTimer.current);
    transitionTimer.current = window.setTimeout(() => refreshInstancesById(instanceIds).catch(() => {}), 1400);
  };

  const closeLaunch = () => {
    setShowLaunch(false);
    window.setTimeout(() => launchButton.current?.focus(), 0);
  };

  const selectedAmiPreset = AMI_PRESETS.find((preset) => preset.id === launch.imageId);
  const launchCount = launch.count === '' ? Number.NaN : Number(launch.count);
  const launchCountValid = Number.isInteger(launchCount) && launchCount >= 1 && launchCount <= 20;
  const portMappings = launch.portMappings.trim().split(/[\s,]+/).filter(Boolean);
  const portMappingsValid = portMappings.every((mapping) => /^\d{1,5}:\d{1,5}(?:\/(?:tcp|udp))?$/i.test(mapping))
    && (!portMappings.length || launchCount === 1);

  const reportComputeIssue = (compute, context) => {
    const failed = compute?.instances?.find((entry) => entry?.error);
    const message = failed?.error || compute?.reason;
    if (!message) return;
    setDockerStatus((current) => compute.available === false ? { available: false, reason: message } : current);
    setError(`${context} metadata succeeded, but the local sandbox did not: ${message}`);
    notifyError(message, { title: 'Local compute unavailable', source: 'EC2 Local Compute' });
  };

  const launchInstances = async () => {
    setBusy('launch'); setError(''); setNotice(''); setAnnouncement('Launching EC2 instances.');
    try {
      const result = await api.ec2RunInstances({ ...launch, count: launchCount });
      mergeComputeStates(setComputeStates, result.compute);
      setInstances((current) => [...result.instances, ...current.filter((held) => !result.instances.some((instance) => instance.id === held.id))]);
      const instanceIds = result.instances.map((instance) => instance.id);
      const firstId = instanceIds[0];
      if (firstId) setSelectedId(firstId);
      closeLaunch();
      const message = `${result.instances.length} EC2 ${result.instances.length === 1 ? 'instance' : 'instances'} launched.`;
      setNotice(message); setAnnouncement(message);
      notifySuccess(message, { title: 'EC2 launch started', source: 'EC2' });
      reportComputeIssue(result.compute, 'EC2 launch');
      if (instanceIds.length) scheduleTransitionRefresh(instanceIds);
    } catch (launchError) {
      setError(launchError.message);
      notifyError(launchError, { title: 'Could not launch EC2 instance', source: 'EC2' });
    } finally { setBusy(''); }
  };

  const act = async (action) => {
    if (!selected) return;
    if (action === 'terminate') {
      const confirmed = await confirmDialog({
        title: 'Terminate EC2 instance?',
        message: `Instance “${displayName(selected)}” (${selected.id}) will be permanently terminated. It cannot be started again.`,
        confirmLabel: 'Terminate instance',
      });
      if (!confirmed) return;
    }
    setBusy(action); setError(''); setNotice(''); setAnnouncement(`${action} request in progress.`);
    try {
      const result = await api.ec2InstanceAction(action, [selected.id]);
      mergeComputeStates(setComputeStates, result.compute);
      await refreshInstancesById([selected.id]);
      const label = action.charAt(0).toUpperCase() + action.slice(1);
      const message = `${label} requested for ${selected.id}.`;
      setNotice(message); setAnnouncement(message);
      notifySuccess(message, { title: 'EC2 lifecycle updated', source: 'EC2' });
      reportComputeIssue(result.compute, `EC2 ${action}`);
      scheduleTransitionRefresh([selected.id]);
    } catch (actionError) {
      setError(actionError.message);
      notifyError(actionError, { title: 'EC2 action failed', source: 'EC2' });
    } finally { setBusy(''); }
  };

  const openGuide = () => { setShowGuide(true); };
  const closeGuide = () => { setShowGuide(false); window.setTimeout(() => guideButton.current?.focus(), 0); };
  const canConnect = (instance) => dockerStatus?.available && computeStates[instance.id]?.state === 'running';
  const connectTitle = (instance) => {
    if (!dockerStatus?.available) return dockerStatus?.reason || 'Docker status is still being checked.';
    if (computeStates[instance.id]?.state !== 'running') return 'This EC2 record has no running local sandbox. Launch a new instance while Docker is active.';
    return `Connect to ${instance.id}`;
  };
  const canStart = selected?.state === 'stopped';
  const canStop = selected?.state === 'running';
  const canReboot = selected?.state === 'running';
  const canTerminate = selected && !['terminated', 'shutting-down'].includes(selected.state);

  return (
    <div className="resource-page ec2-page">
      <section className="col picker resource-picker ec2-picker">
        <div className="picker-head ec2-picker-head">
          <div><div className="eyebrow">Compute</div><div className="section-title">EC2 instances</div></div>
          <button ref={guideButton} className="icon-button info-button" aria-label="Learn about Amazon EC2" title="What is EC2?" onClick={openGuide}><Icon name="info" size={16} /></button>
        </div>
        <button className={`ec2-compute-status ${dockerStatus?.available ? 'active' : 'offline'}`} onClick={loadDockerStatus} title={dockerStatus?.reason || 'Check Docker again'}>
          <span className="ec2-state-dot" />
          <span>{dockerStatus === null ? 'Checking Local Docker…' : dockerStatus.available ? 'Compute Engine: Local Docker Active' : 'Metadata-Only Mode — Start Docker Desktop to enable live Ubuntu terminals'}</span>
        </button>
        <button ref={launchButton} className="primary ec2-launch-button" disabled={!!busy} onClick={() => { if (showLaunch) closeLaunch(); else setShowLaunch(true); }} aria-expanded={showLaunch} aria-controls="ec2-launch-panel"><Icon name="server" size={15} />Launch instance</button>
        <div className="search-field"><Icon name="search" size={15} /><input aria-label="Filter EC2 instances" placeholder="Name, ID, IP, AMI…" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button className="clear-search" aria-label="Clear instance filter" onClick={() => setQuery('')}>×</button>}</div>
        <select aria-label="Filter EC2 instances by state" value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}>
          <option value="all">All states ({instances.length})</option>
          {Object.entries(stateCounts).sort().map(([state, count]) => <option key={state} value={state}>{state} ({count})</option>)}
        </select>
        <div className="list ec2-instance-list" aria-busy={busy === 'instances'}>
          {busy === 'instances' && <div className="loading-state compact" role="status"><span className="spinner" />Loading instances…</div>}
          {busy !== 'instances' && visible.map((instance) => (
            <div className="ec2-instance-row" key={instance.id}>
              <button aria-pressed={selectedId === instance.id} className={selectedId === instance.id ? 'item active ec2-instance-item' : 'item ec2-instance-item'} onClick={() => setSelectedId(instance.id)}>
                <span className={`ec2-state-dot ${stateTone(instance.state)}`} aria-hidden="true" />
                <span className="ec2-instance-copy"><b>{displayName(instance)}</b><span className="mono">{instance.id}</span></span>
                <span className={`ec2-state ${stateTone(instance.state)}`}>{instance.state}</span>
              </button>
              {instance.state === 'running' && <button className="ec2-row-connect" disabled={!canConnect(instance)} title={connectTitle(instance)} onClick={() => setTerminalInstance(instance)}>Connect</button>}
            </div>
          ))}
          {busy !== 'instances' && visible.length === 0 && <div className="empty compact">{instances.length ? 'No instances match these filters.' : 'No EC2 instances yet.'}</div>}
        </div>
        {nextToken && <button disabled={!!busy} onClick={() => loadInstances({ append: true })}>{busy === 'more' ? 'Loading…' : 'Load more instances'}</button>}
        <button className="subtle-button" disabled={!!busy} onClick={() => loadInstances()}><Icon name="refresh" size={14} />Refresh instances</button>
      </section>

      <section className="col work ec2-work">
        <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
        {error && <div className="error" role="alert"><span>{error}</span><button className="link" onClick={() => setError('')}>Dismiss</button></div>}
        {notice && <div className="notice" role="status"><Icon name="check" size={15} /><span>{notice}</span><button className="link" aria-label="Dismiss notification" onClick={() => setNotice('')}>Dismiss</button></div>}

        {showLaunch && (
          <section id="ec2-launch-panel" className="ec2-launch-panel" aria-labelledby="ec2-launch-title">
            <div className="ec2-launch-head"><div><div className="eyebrow">RunInstances</div><h2 id="ec2-launch-title">Launch EC2 instances</h2></div><button className="notification-close" aria-label="Close launch form" disabled={busy === 'launch'} onClick={closeLaunch}>×</button></div>
            <div className="ec2-launch-grid">
              <label><span>AMI</span><select ref={imageInput} value={launch.imageId} onChange={(event) => setLaunch({ ...launch, imageId: event.target.value, allowPrivileged: false })}>
                <optgroup label="Local Docker AMIs">{AMI_PRESETS.map((image) => <option key={image.id} value={image.id}>{image.label} ({image.detail})</option>)}</optgroup>
                {!!images.length && <optgroup label="Metadata-only emulator AMIs">{images.filter((image) => !AMI_PRESETS.some((preset) => preset.id === image.id)).map((image) => <option key={image.id} value={image.id}>{image.name || image.description || image.id}</option>)}</optgroup>}
              </select></label>
              <label><span>Instance type</span><select value={launch.instanceType} onChange={(event) => setLaunch({ ...launch, instanceType: event.target.value })}>{INSTANCE_TYPES.map((type) => <option key={type}>{type}</option>)}</select></label>
              <label><span>Count</span><input type="number" min="1" max="20" value={launch.count} aria-invalid={!launchCountValid} aria-describedby={!launchCountValid ? 'ec2-count-error' : undefined} onChange={(event) => setLaunch({ ...launch, count: event.target.value })} />{!launchCountValid && <small id="ec2-count-error" className="field-error">Enter 1–20.</small>}</label>
              <label><span>Name tag (optional)</span><input maxLength="256" value={launch.name} onChange={(event) => setLaunch({ ...launch, name: event.target.value })} placeholder="web-server" /></label>
              <label className="ec2-port-field"><span>Port forwarding (optional)</span><input value={launch.portMappings} aria-invalid={!portMappingsValid} onChange={(event) => setLaunch({ ...launch, portMappings: event.target.value })} placeholder="8080:80, 8443:443" /><small>{portMappings.length && launchCount !== 1 ? 'Port forwarding requires a count of 1.' : 'Use host:container. Ports bind to 127.0.0.1 only.'}</small></label>
              <label className="ec2-user-data-field"><span>User data (optional)</span><textarea value={launch.userData} onChange={(event) => setLaunch({ ...launch, userData: event.target.value })} placeholder={'#!/bin/bash\napt-get update && apt-get install -y nginx'} spellCheck="false" /></label>
            </div>
            {selectedAmiPreset?.privileged && <label className="ec2-privileged-warning"><input type="checkbox" checked={launch.allowPrivileged} onChange={(event) => setLaunch({ ...launch, allowPrivileged: event.target.checked })} /><span><b>Privileged local container</b>This Docker-in-Docker AMI receives broad host kernel and device access. Run only scripts you trust, and select this box to approve it.</span></label>}
            <div className="ec2-launch-actions"><span>{dockerStatus?.available ? 'The Docker image is pulled automatically when needed.' : 'Docker is offline. This launch will create metadata only.'}</span><button disabled={busy === 'launch'} onClick={closeLaunch}>Cancel</button><button className="primary" disabled={!launch.imageId.trim() || !launchCountValid || !portMappingsValid || (selectedAmiPreset?.privileged && !launch.allowPrivileged) || busy === 'launch'} onClick={launchInstances}>{busy === 'launch' ? <><span className="spinner" />Launching…</> : 'Launch'}</button></div>
          </section>
        )}

        {!selected ? (
          <div className="empty-state"><span className="empty-icon"><Icon name="server" size={26} /></span><b>Select or launch an instance</b><span>Inspect an EC2 instance and manage its lifecycle locally.</span>{ec2Service && <button onClick={() => onOpenService(ec2Service)}><Icon name="console" size={15} />Open all EC2 operations</button>}</div>
        ) : (
          <>
            <div className="op-head ec2-detail-head">
              <div><div className="eyebrow">EC2 instance</div><h1>{displayName(selected)}</h1><span className="mono muted small">{selected.id}</span></div>
              <span className={`ec2-state large ${stateTone(selected.state)}`}><span className="ec2-state-dot" />{selected.state}</span>
              {ec2Service && <button title="Open the complete modeled EC2 operation catalog" onClick={() => onOpenService(ec2Service)}><Icon name="console" size={14} />More operations</button>}
              <button className="primary" disabled={selected.state !== 'running' || !canConnect(selected) || !!busy} title={connectTitle(selected)} onClick={() => setTerminalInstance(selected)}><Icon name="console" size={14} />Connect</button>
              <button disabled={!canStart || !!busy} onClick={() => act('start')}>Start</button>
              <button disabled={!canStop || !!busy} onClick={() => act('stop')}>Stop</button>
              <button disabled={!canReboot || !!busy} onClick={() => act('reboot')}>Reboot</button>
              <button className="danger-button" disabled={!canTerminate || !!busy} onClick={() => act('terminate')}><Icon name="trash" size={14} />Terminate</button>
            </div>
            {TRANSITIONAL_STATES.has(selected.state) && <div className="ec2-transition" role="status"><span className="spinner" />The emulator is applying this lifecycle transition.</div>}
            <div className="ec2-facts">
              <div><span>Instance type</span><b>{selected.instanceType || '—'}</b></div>
              <div><span>AMI</span><b className="mono">{selected.imageId || '—'}</b></div>
              <div><span>Availability Zone</span><b>{selected.availabilityZone || '—'}</b></div>
              <div><span>Private IPv4</span><b className="mono">{selected.privateIpAddress || '—'}</b></div>
              <div><span>Public IPv4</span><b className="mono">{selected.publicIpAddress || '—'}</b></div>
              <div><span>Launch time</span><b>{formatTime(selected.launchTime)}</b></div>
            </div>
            <div className="ec2-detail-grid">
              <section className="panel ec2-detail-panel"><div className="panel-head"><div><div className="section-title">Networking</div><div className="section-subtitle">Local addresses and placement</div></div></div><dl>
                <div><dt>VPC</dt><dd className="mono">{selected.vpcId || '—'}</dd></div><div><dt>Subnet</dt><dd className="mono">{selected.subnetId || '—'}</dd></div><div><dt>Private DNS</dt><dd className="mono">{selected.privateDnsName || '—'}</dd></div><div><dt>Public DNS</dt><dd className="mono">{selected.publicDnsName || '—'}</dd></div>
              </dl></section>
              <section className="panel ec2-detail-panel"><div className="panel-head"><div><div className="section-title">Configuration</div><div className="section-subtitle">Image and reservation metadata</div></div></div><dl>
                <div><dt>Architecture</dt><dd>{selected.architecture || '—'}</dd></div><div><dt>Platform</dt><dd>{selected.platform || '—'}</dd></div><div><dt>Key pair</dt><dd>{selected.keyName || '—'}</dd></div><div><dt>Reservation</dt><dd className="mono">{selected.reservationId || '—'}</dd></div>
              </dl></section>
            </div>
            <section className="panel ec2-tags-panel"><div className="panel-head"><div><div className="section-title">Tags</div><div className="section-subtitle">Metadata attached to this instance</div></div>{ec2Service && <button onClick={() => onOpenService(ec2Service, 'CreateTags', { Resources: [selected.id], Tags: [{ Key: '', Value: '' }] })}><Icon name="tag" size={14} />Edit in Console</button>}</div>
              {selected.tags.length ? <table className="objects"><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>{selected.tags.map((tag) => <tr key={tag.key}><td className="mono">{tag.key}</td><td>{tag.value}</td></tr>)}</tbody></table> : <div className="empty compact">No tags attached.</div>}
            </section>
          </>
        )}
      </section>
      {showGuide && <GuideDialog onClose={closeGuide} />}
      {terminalInstance && <React.Suspense fallback={<div className="dialog-backdrop"><div className="loading-state" role="status"><span className="spinner" />Loading terminal…</div></div>}><Ec2TerminalModal instance={terminalInstance} onClose={() => setTerminalInstance(null)} /></React.Suspense>}
    </div>
  );
}
