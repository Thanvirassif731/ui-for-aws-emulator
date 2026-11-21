import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import Icon from './Icon.jsx';
import { confirmDialog } from './dialogs.js';
import { notifyError, notifySuccess } from './notifications.js';
import { RESOURCE_REFRESH_EVENT } from './resourceEvents.js';

const queueName = (url) => { try { return new URL(url).pathname.split('/').filter(Boolean).pop() || url; } catch { return url; } };

export default function SQS() {
  const [queues, setQueues] = useState([]);
  const [queue, setQueue] = useState('');
  const [details, setDetails] = useState(null);
  const [query, setQuery] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const run = useCallback(async (label, fn, message = '') => {
    setBusy(label); setError(''); setNotice('');
    try {
      const result = await fn();
      if (message) {
        setNotice(message);
        notifySuccess(message, { title: 'SQS update', source: 'SQS' });
      }
      return result;
    } catch (e) {
      setError(e.message);
      notifyError(e, { title: 'SQS action failed', source: 'SQS' });
      return undefined;
    }
    finally { setBusy(''); }
  }, []);

  const loadQueues = useCallback(() => run('queues', async () => setQueues(await api.sqsQueues())), [run]);
  const inspect = useCallback((url) => run('inspect', async () => setDetails(await api.sqsInspect(url))), [run]);

  useEffect(() => { loadQueues(); }, [loadQueues]);
  useEffect(() => { setDetails(null); if (queue) inspect(queue); }, [queue, inspect]);
  useEffect(() => {
    const refresh = () => { loadQueues(); if (queue) inspect(queue); };
    window.addEventListener(RESOURCE_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(RESOURCE_REFRESH_EVENT, refresh);
  }, [inspect, loadQueues, queue]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? queues.filter((url) => queueName(url).toLowerCase().includes(needle)) : queues;
  }, [queues, query]);

  const send = () => {
    if (!body) return;
    run('send', async () => { await api.sqsSend(queue, body); setBody(''); await inspect(queue); }, 'Message sent.');
  };
  const removeMessage = async (message) => {
    const confirmed = await confirmDialog({
      title: 'Delete SQS message?',
      message: message.MessageId ? `Message “${message.MessageId}” will be permanently deleted.` : 'This message will be permanently deleted.',
      confirmLabel: 'Delete message',
    });
    if (!confirmed) return;
    run('delete', async () => { await api.sqsDeleteMessage(queue, message.ReceiptHandle); await inspect(queue); }, 'Message deleted.');
  };
  const purge = async () => {
    const confirmed = await confirmDialog({
      title: 'Purge SQS queue?',
      message: `Every available message in “${queueName(queue)}” will be permanently deleted. This action cannot be undone.`,
      confirmLabel: 'Purge queue',
    });
    if (!confirmed) return;
    run('purge', async () => { await api.sqsPurge(queue); await inspect(queue); }, 'Queue purged.');
  };

  return (
    <div className="resource-page">
      <section className="col picker resource-picker">
        <div className="picker-head"><div className="eyebrow">Message queues</div><div className="section-title">SQS queues</div></div>
        <div className="search-field"><Icon name="search" size={15} /><input aria-label="Filter queues" placeholder="Filter queues…" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
        <div className="list" aria-busy={busy === 'queues'}>
          {shown.map((url) => <button key={url} className={queue === url ? 'item active' : 'item'} title={url} onClick={() => setQueue(url)}><span className="item-main"><Icon name="box" size={15} />{queueName(url)}</span><Icon name="chevron" size={14} /></button>)}
          {!busy && shown.length === 0 && <div className="empty compact">{queues.length ? 'No queues match.' : 'No queues yet.'}</div>}
        </div>
        <button className="subtle-button" disabled={!!busy} onClick={loadQueues}><Icon name="refresh" size={14} />Refresh queues</button>
      </section>
      <section className="col work">
        {error && <div className="error" role="alert"><span>{error}</span><button className="link" onClick={() => setError('')}>Dismiss</button></div>}
        {notice && <div className="notice"><Icon name="check" size={15} /><span>{notice}</span></div>}
        {!queue ? <div className="empty-state"><span className="empty-icon"><Icon name="box" size={26} /></span><b>Select a queue</b><span>Inspect attributes and available messages.</span></div> : <>
          <div className="op-head"><div><div className="eyebrow">SQS queue</div><h1>{queueName(queue)}</h1></div><button disabled={!!busy} onClick={() => inspect(queue)}><Icon name="refresh" size={15} />Refresh</button><button className="danger-button" disabled={!!busy} onClick={purge}><Icon name="trash" size={15} />Purge</button></div>
          <div className="endpoint-chip mono queue-url">{queue}</div>
          <div className="resource-summary">{details && Object.entries(details.attributes).slice(0, 6).map(([name, value]) => <span key={name} title={name}><b>{value}</b> {name.replace(/^ApproximateNumberOf/, '')}</span>)}{busy && <span className="busy-label"><span className="spinner" />Working…</span>}</div>
          <div className="inline-form message-form"><textarea aria-label="New message body" placeholder="Message body" value={body} onChange={(e) => setBody(e.target.value)} /><button className="primary" disabled={!body || !!busy} onClick={send}><Icon name="send" size={15} />Send</button></div>
          <div className="message-list">
            {(details?.messages || []).map((message) => <article className="message-card" key={message.ReceiptHandle || message.MessageId}>
              <div className="row"><b className="mono">{message.MessageId}</b><span className="spacer" /><button className="danger-link" disabled={!!busy} onClick={() => removeMessage(message)}><Icon name="trash" size={14} />Delete</button></div>
              <pre>{message.Body}</pre>
              {message.Attributes && <details><summary>System attributes</summary><pre>{JSON.stringify(message.Attributes, null, 2)}</pre></details>}
              {message.MessageAttributes && Object.keys(message.MessageAttributes).length > 0 && <details><summary>Message attributes</summary><pre>{JSON.stringify(message.MessageAttributes, null, 2)}</pre></details>}
            </article>)}
          </div>
          {details && details.messages.length === 0 && <div className="empty table-empty">No messages are currently available.</div>}
        </>}
      </section>
    </div>
  );
}
