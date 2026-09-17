import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, CurrencyDollar, Pause, Play, XLogo } from '@phosphor-icons/react';
import { normalizeHandle, toBasisPoints } from './basket.js';
import { pointAt, samplePath } from './flow-geometry.js';

function useMotionVisibility(ref, paused = false) {
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
const MOBILE_QUERY = '(max-width: 767px)';
// Rails are sampled once in viewBox units; speeds are viewBox units per second.
const LAYOUTS = {
  desktop: { view: [1000, 400], speed: 250, routes: PATHS.desktop.map(path => samplePath(path)) },
  mobile: { view: [400, 750], speed: 185, routes: PATHS.mobile.map(path => samplePath(path)) },
};
const RECIPIENTS = STAGES.filter(stage => stage.share);
const PACKET_DOLLARS = 10;
const SPAWN_INTERVAL = 1.15;
const ABSORB_SECONDS = .24;
const WARM_UP_SECONDS = 5;

function spawnCoin(state, container, segment, branch, share) {
  const el = document.createElement('span');
  el.className = `flow-coin ${segment === 0 ? 'state-fee' : 'state-cash'}`;
  el.dataset.flowParticle = 'true';
  el.dataset.coin = String(state.serial += 1);
  if (branch !== null) el.dataset.branch = String(branch);
  el.style.setProperty('--size', `${branch === null ? 34 : 18 + share * .26}px`);
  el.innerHTML = '<i class="coin-tail"></i><b class="coin-disc"></b>';
  container.append(el);
  const coin = { el, segment, progress: 0, branch, share, absorb: null };
  state.coins.push(coin);
  return coin;
}
function removeCoin(state, coin) { coin.el.remove(); state.coins.splice(state.coins.indexOf(coin), 1); }
function clearCoins(state, container) { state.coins = []; state.sinceSpawn = SPAWN_INTERVAL; state.warmed = false; container?.replaceChildren(); }

// Advances every coin by dt seconds. A fee coin leaves pump.fun, is collected, becomes a dollar coin at
// conversion, splits into share-sized coins at X Money and is absorbed by its recipient.
function step(state, container, dt, onStage) {
  const layout = LAYOUTS[state.layout];
  state.sinceSpawn += dt;
  if (state.sinceSpawn >= SPAWN_INTERVAL) { state.sinceSpawn -= SPAWN_INTERVAL; spawnCoin(state, container, 0, null, 100); }
  for (const coin of [...state.coins]) {
    if (coin.absorb !== null) { coin.absorb += dt / ABSORB_SECONDS; if (coin.absorb >= 1) removeCoin(state, coin); continue; }
    const route = layout.routes[coin.segment];
    coin.progress += (dt * layout.speed) / route.length;
    if (coin.progress < 1) continue;
    const carry = (coin.progress - 1) * route.length;
    if (coin.segment === 0) { coin.segment = 1; coin.el.classList.replace('state-fee', 'state-collected'); onStage?.('collect'); }
    else if (coin.segment === 1) { coin.segment = 2; coin.el.classList.remove('state-collected'); coin.el.classList.add('state-cash', 'flip'); onStage?.('convert'); }
    else if (coin.segment === 2) {
      removeCoin(state, coin);
      onStage?.('money');
      RECIPIENTS.forEach((stage, index) => { const share = Number.parseInt(stage.share, 10); spawnCoin(state, container, 3 + index, index, share).progress = carry / layout.routes[3 + index].length; });
      continue;
    } else { coin.progress = 1; coin.absorb = 0; onStage?.(STAGES[coin.segment + 1].id, { amount: (PACKET_DOLLARS * coin.share) / 100 }); continue; }
    coin.progress = carry / layout.routes[coin.segment].length;
  }
}

function render(state) {
  const layout = LAYOUTS[state.layout];
  const [width, height] = state.size;
  if (!width || !height) return;
  for (const coin of state.coins) {
    const [x, y, dx, dy] = pointAt(layout.routes[coin.segment], coin.progress);
    const scale = coin.absorb === null ? 1 : Math.max(1 - coin.absorb, 0);
    coin.el.style.transform = `translate(${(x / layout.view[0]) * width}px, ${(y / layout.view[1]) * height}px) translate(-50%, -50%) scale(${scale})`;
    coin.el.style.setProperty('--angle', `${Math.atan2((dy * height) / layout.view[1], (dx * width) / layout.view[0])}rad`);
  }
}

function useCapitalFlow(sceneRef, coinsRef, running, reduced, onStage) {
  const world = useRef({ coins: [], sinceSpawn: SPAWN_INTERVAL, size: [0, 0], layout: 'desktop', serial: 0, warmed: false });
  useEffect(() => {
    const state = world.current;
    const query = matchMedia(MOBILE_QUERY);
    const applyLayout = () => { const next = query.matches ? 'mobile' : 'desktop'; if (next !== state.layout) { state.layout = next; clearCoins(state, coinsRef.current); } };
    const observer = new ResizeObserver(([entry]) => { state.size = [entry.contentRect.width, entry.contentRect.height]; render(state); });
    observer.observe(sceneRef.current);
    query.addEventListener('change', applyLayout);
    applyLayout();
    return () => { observer.disconnect(); query.removeEventListener('change', applyLayout); };
  }, [sceneRef, coinsRef]);
  useEffect(() => { if (reduced) clearCoins(world.current, coinsRef.current); }, [reduced, coinsRef]);
  useEffect(() => {
    if (!running) return undefined;
    const state = world.current, container = coinsRef.current;
    if (!state.warmed) { for (let elapsed = 0; elapsed < WARM_UP_SECONDS; elapsed += .05) step(state, container, .05, null); state.warmed = true; }
    render(state);
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const dt = Math.min((now - last) / 1000, .05);
      last = now;
      step(state, container, dt, onStage);
      render(state);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [running, coinsRef, onStage]);
}

function FlowRails({ orientation, reduced }) {
  return <svg className={`flow-rails ${orientation}`} viewBox={orientation === 'desktop' ? '0 0 1000 400' : '0 0 400 750'} preserveAspectRatio="none" aria-hidden="true">
    {PATHS[orientation].map(path => <path key={path} d={path} className="flow-rail" fill="none" vectorEffect="non-scaling-stroke" />)}
    {!reduced && PATHS[orientation].map(path => <path key={`current-${path}`} d={path} className="flow-rail-current" pathLength="100" fill="none" vectorEffect="non-scaling-stroke" />)}
  </svg>;
}

export function CapitalScene({ compact = false }) {
  const ref = useRef(), sceneRef = useRef(), coinsRef = useRef(), chipsRef = useRef();
  const nodes = useRef({});
  const [selected, setSelected] = useState(0);
  const { running, reduced } = useMotionVisibility(ref);
  const onStage = useCallback((id, detail) => {
    const node = nodes.current[id];
    if (node) { node.classList.remove('hit'); void node.offsetWidth; node.classList.add('hit'); }
    if (detail?.amount === undefined || !chipsRef.current) return;
    const stage = STAGES.find(item => item.id === id), mobile = matchMedia(MOBILE_QUERY).matches;
    const chip = document.createElement('span');
    chip.className = 'flow-chip';
    chip.textContent = `+$${detail.amount.toFixed(2)}`;
    chip.style.left = `${mobile ? stage.mx : stage.x}%`;
    chip.style.top = `calc(${mobile ? stage.my : stage.y}% - 44px)`;
    chip.addEventListener('animationend', () => chip.remove());
    setTimeout(() => chip.remove(), 1800);
    chipsRef.current.append(chip);
  }, []);
  useCapitalFlow(sceneRef, coinsRef, running, reduced, onStage);
  const selectedStage = STAGES[selected];
  return <section ref={ref} className={`capital-scene-panel panel ${compact ? 'compact-scene' : ''}`}>
    <div className="scene-heading"><div><h2>{compact ? 'Follow the capital.' : 'From the first trade to your people.'}</h2></div></div>
    <div className="capital-scene" ref={sceneRef} data-running={running}>
      <FlowRails orientation="desktop" reduced={reduced} /><FlowRails orientation="mobile" reduced={reduced} />
      <div className="flow-coins" ref={coinsRef} aria-hidden="true" />
      {STAGES.map((stage, index) => <button type="button" key={stage.id} ref={el => { nodes.current[stage.id] = el; }} className={`flow-node flow-node-${stage.id} ${selected === index ? 'selected' : ''}`} style={{ '--node-x': `${stage.x}%`, '--node-y': `${stage.y}%`, '--mobile-x': `${stage.mx}%`, '--mobile-y': `${stage.my}%` }} aria-pressed={selected === index} aria-label={`${stage.label}${stage.share ? `, ${stage.share}` : ''}`} onClick={() => setSelected(index)}>
        <span className="flow-node-disc">{stage.id === 'pump' ? <span className="pump-symbol" /> : stage.id === 'collect' ? <ArrowDown size={29} /> : stage.id === 'convert' ? <CurrencyDollar size={30} /> : stage.id === 'money' ? <XLogo size={29} /> : <XLogo size={23} />}</span>
        <span className="flow-node-label">{stage.label}{stage.share && <strong>{stage.share}</strong>}</span>
      </button>)}
      <div className="flow-chips" ref={chipsRef} aria-hidden="true" />
    </div>
    <div className="scene-explanation" aria-live="polite" key={selectedStage.id}><h3>{selectedStage.title}</h3><p>{selectedStage.text}</p></div>
  </section>;
}
