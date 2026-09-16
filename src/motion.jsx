import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, CurrencyDollar, Pause, Play, XLogo } from '@phosphor-icons/react';
import { normalizeHandle, toBasisPoints } from './basket.js';

function useMotionVisibility(ref, paused) {
  const [running, setRunning] = useState(false);
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    let visible = false;
    const update = () => {
      setReduced(preference.matches);
      setRunning(visible && !document.hidden && !preference.matches && !paused);
    };
    const observer = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting; update(); });
    if (ref.current) observer.observe(ref.current);
    preference.addEventListener('change', update);
    document.addEventListener('visibilitychange', update);
    update();
    return () => { observer.disconnect(); preference.removeEventListener('change', update); document.removeEventListener('visibilitychange', update); };
  }, [ref, paused]);
  return { running, reduced };
}

export function PayoutPreview({ recipients }) {
  const ref = useRef();
  const [paused, setPaused] = useState(false);
  const [index, setIndex] = useState(0);
  const { running, reduced } = useMotionVisibility(ref, paused);
  useEffect(() => {
    if (!running || recipients.length < 2) return;
    const timer = setInterval(() => setIndex(current => (current + 1) % recipients.length), 3400);
    return () => clearInterval(timer);
  }, [running, recipients.length]);
  const recipient = recipients[index % recipients.length];
  const handle = normalizeHandle(recipient?.handle);
  const amount = (toBasisPoints(recipient?.share) || 0) / 100;
  return <div className={`payout-demo ${running ? 'motion-running' : ''}`} ref={ref}>
    <div className="payout-demo-heading"><span>Example payout <span className="example-pool">from a $100 pool</span></span><button type="button" className="icon-button" aria-label={paused ? 'Play payout preview' : 'Pause payout preview'} aria-pressed={paused} onClick={() => setPaused(value => !value)} disabled={reduced || recipients.length < 2}>{paused ? <Play size={17} weight="fill" /> : <Pause size={17} weight="fill" />}</button></div>
    <div className="payout-stack"><div className="payout-card" key={recipient?.id}>
      <div><strong className="payout-amount">${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong><p>to <strong>{handle ? `@${handle}` : 'Your recipient'}</strong></p></div><span className="payout-x"><XLogo size={26} /></span>
    </div></div>
  </div>;
}

const STAGES = [
  { id: 'pump', title: 'Trading creates the fees', label: 'pump.fun', x: 8, y: 50, mx: 50, my: 9, text: 'Creator fees begin with your coin’s trading activity on pump.fun.' },
  { id: 'collect', title: 'Collected into your basket', label: 'Fees collected', x: 28, y: 50, mx: 50, my: 28, text: 'The fees for your coin are collected together, ready for its recipient pool.' },
  { id: 'convert', title: 'Converted for payout', label: 'Convert to USD', x: 48, y: 50, mx: 50, my: 47, text: 'The planned flow converts the recipient pool to dollars before distribution. Conversion costs and the provider are still to be set.' },
  { id: 'money', title: 'Ready for X Money', label: 'X Money', x: 68, y: 50, mx: 50, my: 66, text: 'Dollar payouts are intended to go through X Money. The payment integration is not live in this preview.' },
  { id: 'creator', title: '50% to the creator', label: 'Creator', share: '50%', x: 91, y: 17, mx: 17, my: 87, text: 'In this example, the creator receives 50% of the recipient pool.' },
  { id: 'builder', title: '30% to the builder', label: 'Builder', share: '30%', x: 91, y: 50, mx: 50, my: 87, text: 'The second person receives 30%. You decide the people and percentages when you create your basket.' },
  { id: 'community', title: '20% to the community', label: 'Community', share: '20%', x: 91, y: 83, mx: 83, my: 87, text: 'The final 20% reaches the third person. Your own basket can contain up to five recipients.' },
];
const PATHS = {
  desktop: ['M80 200 H280', 'M280 200 H480', 'M480 200 H680', 'M680 200 H725 C795 200 780 68 840 68 H910', 'M680 200 H910', 'M680 200 H725 C795 200 780 332 840 332 H910'],
  mobile: ['M200 67.5 V210', 'M200 210 V352.5', 'M200 352.5 V495', 'M200 495 V543 C200 584 68 580 68 620 V652.5', 'M200 495 V652.5', 'M200 495 V543 C200 584 332 580 332 620 V652.5'],
};

function FlowRails({ orientation, running, reduced }) {
  const ref = useRef();
  const [coinScale, setCoinScale] = useState([1, 1]);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width && height) setCoinScale([orientation === 'desktop' ? 1000 / width : 400 / width, orientation === 'desktop' ? 400 / height : 750 / height]);
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [orientation]);
  useEffect(() => { if (running && !reduced) ref.current?.unpauseAnimations(); else ref.current?.pauseAnimations(); }, [running, reduced]);
  return <svg ref={ref} className={`flow-rails ${orientation}`} viewBox={orientation === 'desktop' ? '0 0 1000 400' : '0 0 400 750'} preserveAspectRatio="none" aria-hidden="true">
    {PATHS[orientation].map((path, index) => <path key={path} d={path} className="flow-rail" fill="none" vectorEffect="non-scaling-stroke" />)}
    {!reduced && PATHS[orientation].map((path, index) => <path key={`trail-${path}`} d={path} className="flow-trail" pathLength="100" strokeDasharray="8 100" fill="none" vectorEffect="non-scaling-stroke">
      <animate attributeName="stroke-dashoffset" values="8;-92;-92" keyTimes="0;.19;1" dur="9s" begin={`${-(9 - (index < 3 ? index * 1.7 : 5.1))}s`} repeatCount="indefinite" />
      <animate attributeName="opacity" values="0;.6;.6;0;0" keyTimes="0;.015;.17;.19;1" dur="9s" begin={`${-(9 - (index < 3 ? index * 1.7 : 5.1))}s`} repeatCount="indefinite" />
    </path>)}
    {!reduced && PATHS[orientation].map((path, index) => <g key={path} className="travelling-coin" data-flow-particle="true">
      <animateMotion path={path} dur="9s" begin={`${-(9 - (index < 3 ? index * 1.7 : 5.1))}s`} repeatCount="indefinite" keyPoints="0;1;1" keyTimes="0;.19;1" calcMode="linear" />
      <animate attributeName="opacity" values="0;1;1;0;0" keyTimes="0;.015;.17;.19;1" dur="9s" begin={`${-(9 - (index < 3 ? index * 1.7 : 5.1))}s`} repeatCount="indefinite" />
      <g transform={`scale(${coinScale[0]} ${coinScale[1]})`}><circle r="13" className="travelling-coin-disc" /><text y="5" textAnchor="middle" fontSize="16" fontWeight="600">$</text></g>
    </g>)}
  </svg>;
}

export function CapitalScene({ compact = false }) {
  const ref = useRef();
  const [paused, setPaused] = useState(false);
  const [selected, setSelected] = useState(0);
  const { running, reduced } = useMotionVisibility(ref, paused);
  const selectedStage = STAGES[selected];
  return <section ref={ref} className={`capital-scene-panel panel ${compact ? 'compact-scene' : ''}`}>
    <div className="scene-heading"><div><h2>{compact ? 'Follow the capital.' : 'From the first trade to your people.'}</h2><span>Illustrative flow</span></div><button type="button" className="motion-control" onClick={() => setPaused(value => !value)} disabled={reduced} aria-label={paused ? 'Play capital flow animation' : 'Pause capital flow animation'} aria-pressed={paused}>{paused || reduced ? <Play size={18} weight="fill" /> : <Pause size={18} weight="fill" />}<span>{paused || reduced ? 'Play' : 'Pause'}</span></button></div>
    <div className="capital-scene" data-running={running}>
      <FlowRails orientation="desktop" running={running} reduced={reduced} /><FlowRails orientation="mobile" running={running} reduced={reduced} />
      {STAGES.map((stage, index) => <button type="button" key={stage.id} className={`flow-node flow-node-${stage.id} ${selected === index ? 'selected' : ''}`} style={{ '--node-x': `${stage.x}%`, '--node-y': `${stage.y}%`, '--mobile-x': `${stage.mx}%`, '--mobile-y': `${stage.my}%` }} aria-pressed={selected === index} aria-label={`${stage.label}${stage.share ? `, ${stage.share}` : ''}`} onClick={() => setSelected(index)}>
        <span className="flow-node-disc">{stage.id === 'pump' ? <span className="pump-symbol" /> : stage.id === 'collect' ? <ArrowDown size={29} /> : stage.id === 'convert' ? <CurrencyDollar size={30} /> : stage.id === 'money' ? <XLogo size={29} /> : <XLogo size={23} />}</span>
        <span className="flow-node-label">{stage.label}{stage.share && <strong>{stage.share}</strong>}</span>
      </button>)}
    </div>
    <div className="scene-explanation" aria-live="polite" key={selectedStage.id}><h3>{selectedStage.title}</h3><p>{selectedStage.text}</p></div>
  </section>;
}
