import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { DIALOG_EVENT } from './dialogs.js';

export default function DialogHost() {
  const [queue, setQueue] = useState([]);
  const dialog = useRef(null);
  const cancelButton = useRef(null);
  const restoreFocus = useRef(null);
  const active = queue[0] || null;

  useEffect(() => {
    const enqueue = (event) => setQueue((current) => [...current, event.detail]);
    window.addEventListener(DIALOG_EVENT, enqueue);
    return () => window.removeEventListener(DIALOG_EVENT, enqueue);
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    restoreFocus.current = document.activeElement;
    window.setTimeout(() => cancelButton.current?.focus(), 0);
    return () => restoreFocus.current?.focus?.();
  }, [active?.id]);

  const settle = (answer) => {
    if (!active) return;
    active.resolve(answer);
    setQueue((current) => current.slice(1));
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      settle(false);
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.current.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')];
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

  if (!active) return null;

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) settle(false); }}>
      <section
        className={`app-dialog ${active.tone}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="app-dialog-title"
        aria-describedby="app-dialog-message"
        ref={dialog}
        onKeyDown={onKeyDown}
      >
        <div className="dialog-icon"><Icon name={active.tone === 'danger' ? 'alert' : 'info'} size={20} /></div>
        <div className="dialog-content">
          <h2 id="app-dialog-title">{active.title}</h2>
          <p id="app-dialog-message">{active.message}</p>
        </div>
        <div className="dialog-actions">
          <button ref={cancelButton} onClick={() => settle(false)}>{active.cancelLabel}</button>
          <button className={active.tone === 'danger' ? 'danger-confirm' : 'primary'} onClick={() => settle(true)}>{active.confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}
