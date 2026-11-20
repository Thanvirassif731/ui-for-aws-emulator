import React from 'react';
import Icon from './Icon.jsx';
import { APP_INFO, PEOPLE } from './appInfo.js';
import logoUrl from '../assets/aws-logo.png';

function PersonCard({ person }) {
  const initials = person.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  return (
    <article className="person-card">
      <div className="person-avatar" aria-hidden="true">{initials}</div>
      <div className="person-details">
        <div className="person-name-row">
          <h3>{person.name}</h3>
          <div className="role-list">{person.roles.map((role) => <span className="role-badge" key={role}>{role}</span>)}</div>
        </div>
        <a className="profile-link" href={person.profileUrl} target="_blank" rel="noreferrer">{person.handle}<Icon name="external" size={13} /></a>
        <p>{person.contribution}</p>
      </div>
    </article>
  );
}

export default function Credits() {
  return (
    <div className="credits-page">
      <section className="credits-hero">
        <img className="credits-logo" src={logoUrl} alt="AWS Emulator UI logo" />
        <div>
          <div className="eyebrow">About this project</div>
          <h1>Credits</h1>
          <p>A companion web interface for developing with the local AWS Emulator.</p>
          <div className="project-badges">
            <span><Icon name="tag" size={14} />Version {APP_INFO.version}</span>
            <a href={APP_INFO.licenseUrl} target="_blank" rel="noreferrer"><Icon name="file" size={14} />{APP_INFO.license}</a>
          </div>
        </div>
      </section>

      <section className="credits-section" aria-labelledby="people-title">
        <div className="credits-section-head">
          <div>
            <div className="eyebrow">Project team</div>
            <h2 id="people-title">Maintainers &amp; contributors</h2>
          </div>
          <span className="contributor-count">{PEOPLE.length} {PEOPLE.length === 1 ? 'person' : 'people'}</span>
        </div>
        <div className="people-list">
          {PEOPLE.map((person) => <PersonCard key={person.profileUrl} person={person} />)}
        </div>
      </section>

      <section className="credits-section project-info" aria-labelledby="project-title">
        <div className="credits-section-head">
          <div>
            <div className="eyebrow">Open source</div>
            <h2 id="project-title">Project information</h2>
          </div>
        </div>
        <dl className="info-grid">
          <div><dt>Application</dt><dd>{APP_INFO.name}</dd></div>
          <div><dt>Version</dt><dd>{APP_INFO.version}</dd></div>
          <div><dt>License</dt><dd><a href={APP_INFO.licenseUrl} target="_blank" rel="noreferrer">Apache License 2.0<Icon name="external" size={13} /></a></dd></div>
          <div><dt>Source code</dt><dd><a href={APP_INFO.repositoryUrl} target="_blank" rel="noreferrer">GitHub repository<Icon name="external" size={13} /></a></dd></div>
        </dl>
        <p className="license-note">Licensed under Apache-2.0. You may use, modify, and distribute this software under the terms provided in the repository license.</p>
      </section>
    </div>
  );
}
