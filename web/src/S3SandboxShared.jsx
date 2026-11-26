import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { notifyError, notifySuccess } from './notifications.js';

/** Busy/error state for one sandbox panel. `run` reports success and failure through in-app notifications. */
export function useSandboxAction(source) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const run = useCallback(async (label, fn, success = '') => {
    setBusy(label);
    setError('');
    try {
      const result = await fn();
      if (success) notifySuccess(typeof success === 'function' ? success(result) : success, { title: 'S3 sandbox', source });
      return result;
    } catch (e) {
      if (mounted.current) setError(e.message);
      notifyError(e, { title: 'S3 sandbox action failed', source });
      return undefined;
    } finally {
      if (mounted.current) setBusy('');
    }
  }, [source]);
  return { busy, error, setError, run };
}

/** Returns a function that tells whether a load started for `key` is still the latest one. */
export function useLatestRequest(key) {
  const counter = useRef(0);
  useEffect(() => { counter.current += 1; }, [key]);
  return useCallback(() => {
    counter.current += 1;
    const id = counter.current;
    return () => id === counter.current;
  }, []);
}

/** Small info icon that reveals a plain-English explanation on hover or keyboard focus. */
export function Hint({ text, label = 'More information' }) {
  const id = useId();
  return (
    <span className="hint">
      <button type="button" className="hint-button" aria-label={label} aria-describedby={id}><Icon name="info" size={13} /></button>
      <span role="tooltip" id={id} className="hint-bubble">{text}</span>
    </span>
  );
}

export function ErrorBanner({ error, onDismiss }) {
  if (!error) return null;
  return <div className="error" role="alert"><span>{error}</span><button className="link" onClick={onDismiss}>Dismiss</button></div>;
}

export function PanelHead({ id, eyebrow, title, hint, children }) {
  return (
    <div className="sandbox-panel-head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h2 id={id}>{title}{hint && <Hint text={hint} label={`About ${title}`} />}</h2>
      </div>
      {children && <div className="sandbox-panel-actions">{children}</div>}
    </div>
  );
}

export function formatTime(value) {
  return value ? new Date(value).toLocaleString() : '';
}
