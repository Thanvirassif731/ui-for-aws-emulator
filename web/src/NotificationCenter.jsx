import React, { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { NOTIFICATION_EVENT, notificationDetail } from './notifications.js';

const STORAGE_KEY = 'emulator-ui.notifications.v1';
const MAX_ITEMS = 50;
const DEDUPE_WINDOW = 5 * 60 * 1000;

function loadNotifications() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!Array.isArray(stored)) return [];
    return stored.slice(0, MAX_ITEMS).map((item) => ({
      ...notificationDetail(item),
      id: String(item.id),
      at: Number(item.at) || Date.now(),
      unread: !!item.unread,
      count: Math.max(1, Number(item.count) || 1),
    }));
  } catch {
    return [];
  }
}

function relativeTime(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 10) return 'now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function typeIcon(type) {
  if (type === 'success') return 'check';
  if (type === 'error' || type === 'warning') return 'alert';
  return 'info';
}

export default function NotificationCenter() {
  const [items, setItems] = useState(loadNotifications);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('all');
  const root = useRef(null);
  const panel = useRef(null);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch { /* best effort */ }
  }, [items]);

  useEffect(() => {
    const add = (event) => {
      const detail = notificationDetail(event.detail);
      const now = Date.now();
      setItems((current) => {
        const matchingIndex = current.findIndex((item) => item.type === detail.type
          && item.title === detail.title && item.message === detail.message && item.source === detail.source
          && now - item.at < DEDUPE_WINDOW);
        if (matchingIndex >= 0) {
          const previous = current[matchingIndex];
          const next = current.filter((_, index) => index !== matchingIndex);
          return [{ ...previous, at: now, unread: true, count: previous.count + 1 }, ...next].slice(0, MAX_ITEMS);
        }
        return [{ ...detail, id: `${now}-${Math.random().toString(36).slice(2, 8)}`, at: now, unread: true, count: 1 }, ...current].slice(0, MAX_ITEMS);
      });
    };
    window.addEventListener(NOTIFICATION_EVENT, add);
    return () => window.removeEventListener(NOTIFICATION_EVENT, add);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => { if (!root.current?.contains(event.target)) setOpen(false); };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
        root.current?.querySelector('.notification-bell')?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.setTimeout(() => panel.current?.focus(), 0);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const unread = items.filter((item) => item.unread).length;
  const errors = items.filter((item) => item.type === 'error').length;
  const visible = useMemo(() => filter === 'errors' ? items.filter((item) => item.type === 'error') : items, [filter, items]);
  const dismiss = (id) => setItems((current) => current.filter((item) => item.id !== id));
  const markAllRead = () => setItems((current) => current.map((item) => ({ ...item, unread: false })));
  const clearAll = () => setItems([]);

  return (
    <div className="notification-center" ref={root}>
      <button
        className="icon-button notification-bell"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        aria-expanded={open}
        aria-controls="notification-panel"
        title="Notifications"
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="bell" size={18} />
        {unread > 0 && <span className="notification-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <section id="notification-panel" className="notification-popover" role="dialog" aria-label="Notifications" tabIndex="-1" ref={panel}>
          <header className="notification-head">
            <div><b>Notifications</b><span>{unread ? `${unread} unread` : 'You are up to date'}</span></div>
            <button className="notification-close" aria-label="Close notifications" onClick={() => setOpen(false)}>×</button>
          </header>
          <div className="notification-toolbar">
            <div className="notification-filters" role="tablist" aria-label="Notification filters">
              <button role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All <span>{items.length}</span></button>
              <button role="tab" aria-selected={filter === 'errors'} className={filter === 'errors' ? 'active' : ''} onClick={() => setFilter('errors')}>Errors <span>{errors}</span></button>
            </div>
            {unread > 0 && <button className="link" onClick={markAllRead}>Mark all read</button>}
          </div>
          <div className="notification-list" aria-live="polite">
            {visible.map((item) => (
              <article key={item.id} className={`notification-item ${item.type} ${item.unread ? 'unread' : ''}`}>
                <span className="notification-type"><Icon name={typeIcon(item.type)} size={16} /></span>
                <div className="notification-copy">
                  <div className="notification-title"><b>{item.title}</b>{item.count > 1 && <span className="notification-count">×{item.count}</span>}</div>
                  {item.message && <p>{item.message}</p>}
                  <div className="notification-meta">{item.source && <span>{item.source}</span>}<time dateTime={new Date(item.at).toISOString()} title={new Date(item.at).toLocaleString()}>{relativeTime(item.at)}</time></div>
                </div>
                <button className="notification-dismiss" aria-label={`Dismiss ${item.title}`} title="Dismiss" onClick={() => dismiss(item.id)}>×</button>
              </article>
            ))}
            {!visible.length && <div className="notification-empty"><Icon name={filter === 'errors' ? 'check' : 'bell'} size={24} /><b>{filter === 'errors' ? 'No errors' : 'No notifications'}</b><span>{filter === 'errors' ? 'Errors from this app will appear here.' : 'Updates and errors will appear here.'}</span></div>}
          </div>
          {items.length > 0 && <footer className="notification-foot"><button className="link" onClick={clearAll}>Clear all notifications</button></footer>}
        </section>
      )}
    </div>
  );
}
