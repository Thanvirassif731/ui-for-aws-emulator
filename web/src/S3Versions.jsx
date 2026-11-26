import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import Icon from './Icon.jsx';
import { ErrorBanner, Hint, formatTime, useLatestRequest, useSandboxAction } from './S3SandboxShared.jsx';

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function VersionBadge({ version }) {
  if (version.isDeleteMarker) return <span className="vbadge marker">Delete Marker</span>;
  if (version.isLatest) return <span className="vbadge latest">Latest</span>;
  return <span className="vbadge previous">Previous Version</span>;
}

function versionNote(version) {
  if (version.isDeleteMarker && version.isLatest) return 'Object appears deleted to standard GET requests';
  if (version.isDeleteMarker) return 'Older delete marker. It has no effect while a newer version exists.';
  if (version.isLatest) return 'Returned by a normal GET request';
  return 'Kept by versioning. Readable only with ?versionId=';
}

/** Version stack for the current folder: every key with its versions and delete markers, newest first. */
export default function S3Versions({ bucket, prefix, versioning, refreshKey, onOpenPrefix, onChanged }) {
  const [data, setData] = useState(null);
  const { busy, error, setError, run } = useSandboxAction('S3 versions');
  const begin = useLatestRequest(`${bucket}/${prefix}`);

  const load = useCallback(() => run('load', async () => {
    const isLatest = begin();
    const next = await api.s3Versions(bucket, prefix);
    if (isLatest()) setData(next);
  }), [bucket, prefix, run, begin]);

  useEffect(() => { setData(null); load(); }, [load, refreshKey]);

  const restore = (key, versionId) => run(`restore:${versionId}`, async () => {
    await api.s3RestoreObject(bucket, key, versionId);
    await load();
    onChanged?.();
  }, `Restored “${key}” by removing its delete marker. The previous version is current again.`);

  const objects = data?.objects || [];
  const prefixes = data?.prefixes || [];

  return (
    <div className="versions-view">
      <ErrorBanner error={error} onDismiss={() => setError('')} />
      {versioning === 'Unversioned' && (
        <div className="sandbox-tip"><Icon name="info" size={15} /><span>Versioning has never been enabled on this bucket, so every key has exactly one version with the ID <code>null</code>, and deleting an object removes it permanently. Enable versioning to keep previous versions and get delete markers.</span></div>
      )}
      {versioning === 'Suspended' && (
        <div className="sandbox-tip warn"><Icon name="alert" size={15} /><span>Versioning is suspended. Existing versions are kept, but new uploads overwrite the <code>null</code> version, and deletes add a delete marker with the ID <code>null</code>.</span></div>
      )}
      <div className="objects-wrap">
        <table className="objects versions-table">
          <thead>
            <tr>
              <th>Key / version</th>
              <th>Type <Hint text="Latest is what a normal GET returns. Previous versions are kept when versioning is on. A delete marker is a placeholder version that makes the object look deleted without destroying any data." /></th>
              <th>Version ID</th>
              <th>Last modified</th>
              <th>Size</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {busy === 'load' && !data && <tr><td colSpan={6}><div className="loading-state" role="status"><span className="spinner" />Loading versions…</div></td></tr>}
            {prefix && <tr><td colSpan={6}><button className="link" onClick={() => onOpenPrefix(prefix.replace(/[^/]+\/$/, ''))}>.. (up)</button></td></tr>}
            {prefixes.map((p) => (
              <tr key={p}><td colSpan={6}><button className="link object-name mono" onClick={() => onOpenPrefix(p)}><Icon name="folder" size={16} />{p.slice(prefix.length)}</button></td></tr>
            ))}
            {objects.map((group) => (
              <React.Fragment key={group.key}>
                <tr className={`version-key-row ${group.deleted ? 'deleted' : ''}`}>
                  <td colSpan={6}>
                    <span className="object-name mono"><Icon name="file" size={16} />{group.key.slice(prefix.length)}</span>
                    <span className="muted small version-count">{group.versions.length} {group.versions.length === 1 ? 'version' : 'versions'}{group.deleted ? ' · hidden by a delete marker' : ''}</span>
                  </td>
                </tr>
                {group.versions.map((version) => (
                  <tr key={version.versionId} className={`version-row ${version.isDeleteMarker ? 'marker' : version.isLatest ? 'latest' : 'previous'}`}>
                    <td className="version-indent"><span className="version-branch" aria-hidden="true" /><span className="small muted">{versionNote(version)}</span></td>
                    <td><VersionBadge version={version} /></td>
                    <td className="mono small" title={version.versionId}>{version.versionId}</td>
                    <td className="muted small">{formatTime(version.lastModified)}</td>
                    <td className="muted small">{version.isDeleteMarker ? '—' : formatSize(version.size)}</td>
                    <td>
                      {version.isDeleteMarker && version.isLatest && (
                        <button className="restore-button" disabled={!!busy} onClick={() => restore(group.key, version.versionId)} title="Deletes only this delete marker (DeleteObject with its VersionId). The newest real version becomes current again.">
                          {busy === `restore:${version.versionId}` ? <span className="spinner" /> : <Icon name="refresh" size={14} />}Restore Object
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {data && !objects.length && !prefixes.length && <div className="empty table-empty">No objects or versions in this location.</div>}
      {data?.truncated && <div className="muted small">Showing the first 2,000 versions in this folder.</div>}
    </div>
  );
}
