import React, { useEffect, useState } from 'react';
import Console from './Console.jsx';
import S3 from './S3.jsx';
import Dashboard from './Dashboard.jsx';
import EmulatorBar from './EmulatorBar.jsx';
import Credits from './Credits.jsx';
import Icon from './Icon.jsx';
import { APP_INFO } from './appInfo.js';
import logoUrl from '../assets/aws-logo.png';

const PAGES = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', ready: true },
  { id: 'console', label: 'Console', icon: 'console', ready: true },
  { id: 's3', label: 'S3', icon: 'bucket', ready: true },
  { id: 'ec2', label: 'EC2', icon: 'server' },
  { id: 'dynamodb', label: 'DynamoDB', icon: 'database' },
  { id: 'lambda', label: 'Lambda', icon: 'lambda' },
  { id: 'credits', label: 'Credits', icon: 'users', ready: true, footerOnly: true },
];

const READY_PAGES = new Set(PAGES.filter((p) => p.ready).map((p) => p.id));
const pageFromHash = () => {
  const id = window.location.hash.slice(1);
  return READY_PAGES.has(id) ? id : 'dashboard';
};

export default function App() {
  const [page, setPage] = useState(pageFromHash);
  const [target, setTarget] = useState(null);

  const navigate = (next) => {
    if (!READY_PAGES.has(next)) return;
    setPage(next);
    if (window.location.hash !== `#${next}`) window.location.hash = next;
  };

  useEffect(() => {
    const onHashChange = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHashChange);
    if (!window.location.hash) window.history.replaceState(null, '', '#dashboard');
    document.title = `${PAGES.find((p) => p.id === page)?.label || 'Dashboard'} · AWS Emulator UI`;
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [page]);

  const openService = (service, operation, input) => {
    setTarget({ service, operation, input, key: Date.now() });
    navigate('console');
  };
  return (
    <div className="app">
      <a className="skip-link" href="#main-content" onClick={(e) => { e.preventDefault(); document.getElementById('main-content')?.focus(); }}>Skip to content</a>
      <EmulatorBar />
      <div className="body">
        <nav className="nav" aria-label="Primary navigation">
          <div className="nav-label">Workspace</div>
          {PAGES.filter((p) => !p.footerOnly).map((p) => (
            <button
              key={p.id}
              className={page === p.id ? 'nav-item active' : 'nav-item'}
              disabled={!p.ready}
              title={p.ready ? '' : 'Coming soon'}
              aria-current={page === p.id ? 'page' : undefined}
              onClick={() => navigate(p.id)}
            >
              <span className="nav-item-label"><Icon name={p.icon} size={17} />{p.label}</span>
              {!p.ready && <span className="soon">Soon</span>}
            </button>
          ))}
          <div className="nav-foot">
            <span className="nav-foot-mark">AWS</span>
            <span>Local workspace</span>
          </div>
        </nav>
        <main className="main" id="main-content" tabIndex="-1">
          {page === 'dashboard' && <Dashboard onOpenService={openService} onOpenConsole={() => navigate('console')} />}
          {page === 's3' && <S3 />}
          {page === 'console' && <Console key={target?.key} initial={target} />}
          {page === 'credits' && <Credits />}
        </main>
      </div>
      <footer className="app-footer">
        <div className="footer-product"><img src={logoUrl} alt="" /><span>{APP_INFO.name}</span></div>
        <span className="footer-separator" aria-hidden="true" />
        <span>Version {APP_INFO.version}</span>
        <span className="footer-separator" aria-hidden="true" />
        <a href={APP_INFO.licenseUrl} target="_blank" rel="noreferrer">{APP_INFO.license} License</a>
        <span className="footer-spacer" />
        <button className={page === 'credits' ? 'footer-link active' : 'footer-link'} onClick={() => navigate('credits')}><Icon name="users" size={14} />Maintainers &amp; contributors</button>
        <a href={APP_INFO.repositoryUrl} target="_blank" rel="noreferrer">Source<Icon name="external" size={12} /></a>
      </footer>
    </div>
  );
}
