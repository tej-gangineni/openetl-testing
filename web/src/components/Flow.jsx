import React from 'react';
import { KindIcon, fmtN } from './ui.jsx';
import { resolveDetail } from '../reducer.js';

function Box({ role, name, label, detail, kind, active, counter, counterLabel }) {
  return (
    <div className={`fbox ${active ? 'active' : ''}`}>
      <div className="fhead"><KindIcon kind={kind} /><span className="frole">{name}</span></div>
      <div className="flabel">{label}</div>
      {resolveDetail(detail) && <code className="fdetail" title={resolveDetail(detail)}>{resolveDetail(detail)}</code>}
      <div className="fcount" aria-live="off">
        {counter != null
          ? <><b key={counter}>{fmtN(counter)}</b><span>{counterLabel}</span></>
          : <span className="none">&nbsp;</span>}
      </div>
    </div>
  );
}

function Arrow({ on }) {
  return (
    <svg className={`farrow ${on ? 'on' : ''}`} viewBox="0 0 80 16" aria-hidden="true">
      <line className="rail" x1="2" y1="8" x2="70" y2="8" />
      <line className="moving" x1="2" y1="8" x2="70" y2="8" />
      <path d="M68 3l8 5-8 5" />
    </svg>
  );
}

// SOURCE -> OPENETL -> TARGET. `touch` is which box the current step is using.
export default function Flow({ flow, touch, counts, running }) {
  if (!flow) return null;
  const { source = {}, engine = {}, target = {} } = flow;
  return (
    <figure className="flow" aria-label="What goes where: source, OpenETL, target">
      <Box name="Source" kind={source.kind || 'files'} label={source.label} detail={source.detail} active={touch === 'source'}
        counter={counts.files} counterLabel="files found" />
      <Arrow on={running && (touch === 'source' || touch === 'engine')} />
      <Box name="OpenETL" kind="engine" label={engine.label} detail={engine.detail} active={touch === 'engine'}
        counter={counts.records} counterLabel="records reported" />
      <Arrow on={running && (touch === 'engine' || touch === 'target')} />
      <Box name="Target" kind={target.kind || 'postgres'} label={target.label} detail={target.detail} active={touch === 'target'}
        counter={counts.rows} counterLabel="rows in the database" />
    </figure>
  );
}
