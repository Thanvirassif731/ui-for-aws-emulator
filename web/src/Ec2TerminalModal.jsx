import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

function websocketUrl(instanceId) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/ec2/connect/${encodeURIComponent(instanceId)}`;
}

export default function Ec2TerminalModal({ instance, onClose }) {
  const host = useRef(null);
  const dialog = useRef(null);
  const closeButton = useRef(null);
  const restoreFocus = useRef(null);
  const socketRef = useRef(null);
  const terminalRef = useRef(null);
  const [status, setStatus] = useState('Connecting to the local sandbox…');

  useEffect(() => {
    restoreFocus.current = document.activeElement;
    const focusTimer = window.setTimeout(() => closeButton.current?.focus(), 0);
    return () => {
      window.clearTimeout(focusTimer);
      restoreFocus.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: {
        background: '#070b10',
        foreground: '#d8e1ec',
        cursor: '#ff9900',
        selectionBackground: '#31577d88',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    terminalRef.current = terminal;
    terminal.writeln('\x1b[38;5;214mAWS Emulator Local Compute\x1b[0m');
    terminal.writeln(`Connecting to ${instance.id}…\r\n`);

    const socket = new WebSocket(websocketUrl(instance.id));
    socket.binaryType = 'arraybuffer';
    socketRef.current = socket;
    const decoder = new TextDecoder();

    const sendSize = () => {
      try { fit.fit(); } catch { return; }
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      }
    };
    const resizeObserver = new ResizeObserver(sendSize);
    resizeObserver.observe(host.current);

    const input = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    });
    socket.addEventListener('open', () => {
      setStatus('Connected');
      terminal.focus();
      sendSize();
    });
    socket.addEventListener('message', async (event) => {
      if (typeof event.data === 'string') {
        try {
          const control = JSON.parse(event.data);
          if (control.type === 'error') {
            setStatus(control.message);
            terminal.writeln(`\r\n\x1b[31m${control.message}\x1b[0m`);
            return;
          }
          if (control.type === 'warning') {
            terminal.writeln(`\r\n\x1b[33m${control.message}\x1b[0m`);
            return;
          }
        } catch { /* terminal text */ }
        terminal.write(event.data);
        return;
      }
      if (event.data instanceof ArrayBuffer) terminal.write(decoder.decode(event.data, { stream: true }));
      else if (event.data instanceof Blob) terminal.write(decoder.decode(await event.data.arrayBuffer(), { stream: true }));
    });
    socket.addEventListener('close', (event) => {
      setStatus((current) => current === 'Connected' ? 'Terminal disconnected' : current);
      if (event.code === 1000) terminal.writeln('\r\n\x1b[33mShell session ended.\x1b[0m');
    });
    socket.addEventListener('error', () => {
      setStatus('Could not connect to the terminal service. Check that Docker Desktop is running.');
      terminal.writeln('\r\n\x1b[31mCould not connect to the terminal service.\x1b[0m');
    });

    const firstFit = window.setTimeout(sendSize, 0);
    return () => {
      window.clearTimeout(firstFit);
      resizeObserver.disconnect();
      input.dispose();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1000, 'Terminal closed');
      terminal.dispose();
      socketRef.current = null;
      terminalRef.current = null;
    };
  }, [instance.id]);

  const showBootLogs = () => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send("printf '\\n--- cloud-init boot log ---\\n'; if [ -f /var/log/cloud-init-output.log ]; then cat /var/log/cloud-init-output.log; else echo 'No user-data boot log exists for this instance.'; fi; printf '\\n--- end boot log ---\\n'\r");
    terminalRef.current?.focus();
  };

  const onKeyDown = (event) => {
    // Escape is meaningful inside shells and editors, so close only from modal controls.
    if (event.key === 'Escape' && !host.current?.contains(event.target)) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || host.current?.contains(event.target)) return;
    const focusable = [...dialog.current.querySelectorAll('button:not(:disabled), [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  return (
    <div className="dialog-backdrop ec2-terminal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="ec2-terminal-dialog" role="dialog" aria-modal="true" aria-labelledby="ec2-terminal-title" ref={dialog} onKeyDown={onKeyDown}>
        <header>
          <div>
            <div className="eyebrow">EC2 Instance Connect</div>
            <h2 id="ec2-terminal-title">{instance.name || instance.id}</h2>
            <span className="mono">{instance.id}</span>
          </div>
          <div className="ec2-terminal-actions">
            <button onClick={showBootLogs} disabled={status !== 'Connected'}>View Cloud-Init Boot Logs</button>
            <button ref={closeButton} className="notification-close" aria-label="Close EC2 terminal" onClick={onClose}>×</button>
          </div>
        </header>
        <div className={status === 'Connected' ? 'ec2-terminal-status good' : 'ec2-terminal-status'} role="status">
          <span className="ec2-state-dot" />{status}
        </div>
        <div className="ec2-terminal-host" ref={host} aria-label={`Terminal for ${instance.id}`} />
        <footer>{instance.imageId === 'ami-0d0cce00000000001' ? 'This Docker-in-Docker sandbox is privileged. Run only commands you trust.' : 'Commands run inside a local Docker container. They never connect to an AWS account.'}</footer>
      </section>
    </div>
  );
}
