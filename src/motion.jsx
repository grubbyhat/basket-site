import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, CurrencyDollar, Path, Pause, Play, XLogo } from '@phosphor-icons/react';
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

export function PayoutPreview({ recipients, resolve = () => null }) {
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
  const picture = resolve(handle)?.profile?.avatarUrl;
  return <div className={`payout-demo ${running ? 'motion-running' : ''}`} ref={ref}>
    <div className="payout-demo-heading"><span>Example payout <span className="example-pool">from a $100 pool</span></span><button type="button" className="icon-button" aria-label={paused ? 'Play payout preview' : 'Pause payout preview'} aria-pressed={paused} onClick={() => setPaused(value => !value)} disabled={reduced || recipients.length < 2}>{paused ? <Play size={17} weight="fill" /> : <Pause size={17} weight="fill" />}</button></div>
    <div className="payout-stack"><div className="payout-card" key={recipient?.id}>
      <div><strong className="payout-amount">${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong><p>to <strong>{handle ? `@${handle}` : 'Your recipient'}</strong></p></div><span className="payout-x">{picture ? <img src={picture} alt="" referrerPolicy="no-referrer" /> : <XLogo size={26} />}</span>
    </div></div>
  </div>;
}

const STAGES = [
  { id: 'pump', title: 'Every trade pays a creator fee', label: 'pump.fun', x: 8, y: 42.9, mx: 50, my: 9, text: 'pump.fun charges a creator fee on every trade of your coin and keeps it in the coin’s own vault. Nothing moves until someone claims it.' },
  { id: 'collect', title: 'Swept every 10 seconds', label: 'Route sweep', x: 28, y: 42.9, mx: 50, my: 28, text: 'Every ten seconds Route sweeps the vault of every coin on Route. Your coin’s fee sharing, locked at launch, sends 95% to Route’s GitHub account on pump.fun and 5% to buying the Route coin.' },
  { id: 'convert', title: 'Claimed and converted', label: 'Claim + USD', x: 48, y: 42.9, mx: 50, my: 47, text: 'Route claims the recipient pool from pump.fun with its GitHub account and converts it to dollars. The conversion provider is being connected.' },
  { id: 'money', title: 'Paid through X Money', label: 'X Money', x: 68, y: 42.9, mx: 50, my: 66, text: 'Dollar payouts go to each recipient’s X Money account in the shares you set. The payment integration is being connected.' },
  { id: 'creator', title: '50% to the creator', label: 'Creator', share: '50%', recipient: true, x: 91, y: 19.3, mx: 17, my: 87, text: 'In this example, the creator receives 50% of the recipient pool.' },
  { id: 'builder', title: '30% to the builder', label: 'Builder', share: '30%', recipient: true, x: 91, y: 42.9, mx: 50, my: 87, text: 'The second person receives 30%. You decide the people and percentages when you create your route.' },
  { id: 'community', title: '20% to the community', label: 'Community', share: '20%', recipient: true, x: 91, y: 66.4, mx: 83, my: 87, text: 'The final 20% reaches the third person. Your own route can include up to five recipients.' },
  { id: 'buyback', title: '5% buys $ROUTE', label: '$ROUTE', share: '5%', x: 28, y: 82.1, mx: 15, my: 28, text: 'Five percent of every coin’s fees is bought straight into $ROUTE, automatically, on the same ten-second sweep. $ROUTE’s own fees are all bought back.' },
];
const PATHS = {
  desktop: ['M80 240 H280', 'M280 240 H480', 'M480 240 H680', 'M680 240 H725 C795 240 780 108 840 108 H910', 'M680 240 H910', 'M680 240 H725 C795 240 780 372 840 372 H910', 'M280 240 V460'],
  mobile: ['M200 67.5 V210', 'M200 210 V352.5', 'M200 352.5 V495', 'M200 495 V543 C200 584 68 580 68 620 V652.5', 'M200 495 V652.5', 'M200 495 V543 C200 584 332 580 332 620 V652.5', 'M200 210 H60'],
};
const MOBILE_QUERY = '(max-width: 767px)';
// Rails are sampled once in viewBox units; speeds and tail lengths are viewBox units (per second for speed).
const LAYOUTS = {
  desktop: { viewBox: '0 0 1000 560', view: [1000, 560], speed: 165, tails: [64, 26], routes: PATHS.desktop.map(path => samplePath(path)) },
  mobile: { viewBox: '0 0 400 750', view: [400, 750], speed: 125, tails: [44, 18], routes: PATHS.mobile.map(path => samplePath(path)) },
};
const RECIPIENTS = STAGES.filter(stage => stage.recipient);
const BUYBACK_ROUTE = 6;
const RECIPIENT_POOL = .95;
const PACKET_DOLLARS = 10;
const SPAWN_INTERVAL = 2.1;
const ABSORB_SECONDS = .24;
const WARM_UP_SECONDS = 6;
const SVG_NS = 'http://www.w3.org/2000/svg';

// Each coin drags two dashes (a faint long one and a bright short one) along a copy of its current rail,
// so the tail bends with the rail instead of cutting across it.
function placeTails(state, coin) {
  const d = PATHS[state.layout][coin.segment], length = LAYOUTS[state.layout].routes[coin.segment].length;
  for (const tail of coin.tails) { tail.setAttribute('d', d); tail.setAttribute('pathLength', String(length)); }
}
function setCoinState(coin, name, flip = false) {
  coin.el.className = `flow-coin state-${name}${flip ? ' flip' : ''}`;
  for (const tail of coin.tails) tail.dataset.state = name;
}
function spawnCoin(state, layers, segment, branch, share, stateName = null) {
  const name = stateName || (segment === 0 ? 'fee' : 'cash');
  const el = document.createElement('span');
  el.dataset.flowParticle = 'true';
  el.dataset.coin = String(state.serial += 1);
  if (typeof branch === 'number') el.dataset.branch = String(branch);
  else if (branch) el.dataset.route = branch;
  el.style.setProperty('--size', `${branch === null ? 34 : typeof branch === 'number' ? 18 + share * .26 : 20}px`);
  el.innerHTML = '<b class="coin-disc"></b>';
  layers.coins.append(el);
  const tails = ['flow-tail flow-tail-faint', 'flow-tail flow-tail-bright'].map(className => { const path = document.createElementNS(SVG_NS, 'path'); path.setAttribute('class', className); layers.tails.append(path); return path; });
  const coin = { el, tails, segment, progress: 0, branch, share, absorb: null };
  setCoinState(coin, name);
  placeTails(state, coin);
  state.coins.push(coin);
  return coin;
}
function removeCoin(state, coin) { coin.el.remove(); coin.tails.forEach(tail => tail.remove()); state.coins.splice(state.coins.indexOf(coin), 1); }
function clearCoins(state, layers) { state.coins = []; state.sinceSpawn = SPAWN_INTERVAL; state.warmed = false; layers.coins?.replaceChildren(); layers.tails?.replaceChildren(); }

// Advances every coin by dt seconds. A fee coin leaves pump.fun, is collected, becomes a dollar coin at
// conversion, splits into share-sized coins at X Money and is absorbed by its recipient.
function step(state, layers, dt, onStage) {
  const layout = LAYOUTS[state.layout];
  state.sinceSpawn += dt;
  if (state.sinceSpawn >= SPAWN_INTERVAL) { state.sinceSpawn -= SPAWN_INTERVAL; spawnCoin(state, layers, 0, null, 100); }
  for (const coin of [...state.coins]) {
    if (coin.absorb !== null) { coin.absorb += dt / ABSORB_SECONDS; if (coin.absorb >= 1) removeCoin(state, coin); continue; }
    const route = layout.routes[coin.segment];
    coin.progress += (dt * layout.speed) / route.length;
    if (coin.progress < 1) continue;
    const carry = (coin.progress - 1) * route.length;
    if (coin.segment === 0) {
      // The sweep: 5% peels off toward the Route coin, the rest carries on as the recipient pool.
      spawnCoin(state, layers, BUYBACK_ROUTE, 'buyback', 5, 'fee').progress = carry / layout.routes[BUYBACK_ROUTE].length;
      coin.segment = 1; setCoinState(coin, 'collected'); placeTails(state, coin); onStage?.('collect');
    }
    else if (coin.segment === 1) { coin.segment = 2; setCoinState(coin, 'cash', true); placeTails(state, coin); onStage?.('convert'); }
    else if (coin.segment === 2) {
      removeCoin(state, coin);
      onStage?.('money');
      RECIPIENTS.forEach((stage, index) => { const share = Number.parseInt(stage.share, 10); spawnCoin(state, layers, 3 + index, index, share).progress = carry / layout.routes[3 + index].length; });
      continue;
    } else { coin.progress = 1; coin.absorb = 0; onStage?.(STAGES[coin.segment + 1].id, { amount: (PACKET_DOLLARS * (coin.branch === 'buyback' ? 1 : RECIPIENT_POOL) * coin.share) / 100 }); continue; }
    coin.progress = carry / layout.routes[coin.segment].length;
  }
}

function render(state) {
  const layout = LAYOUTS[state.layout];
  const [width, height] = state.size;
  if (!width || !height) return;
  for (const coin of state.coins) {
    const route = layout.routes[coin.segment];
    const [x, y] = pointAt(route, coin.progress);
    const scale = coin.absorb === null ? 1 : Math.max(1 - coin.absorb, 0);
    coin.el.style.transform = `translate(${(x / layout.view[0]) * width}px, ${(y / layout.view[1]) * height}px) translate(-50%, -50%) scale(${scale})`;
    const distance = coin.progress * route.length;
    layout.tails.forEach((length, index) => {
      const tail = coin.tails[index], visible = length * scale;
      tail.style.visibility = visible < 1 ? 'hidden' : '';
      tail.setAttribute('stroke-dasharray', `${visible} ${route.length + length}`);
      tail.setAttribute('stroke-dashoffset', String(visible - distance));
    });
  }
}

function useCapitalFlow(sceneRef, coinsRef, tailsRef, running, reduced, onStage) {
  const world = useRef({ coins: [], sinceSpawn: SPAWN_INTERVAL, size: [0, 0], layout: 'desktop', serial: 0, warmed: false });
  const layers = useCallback(() => ({ coins: coinsRef.current, tails: tailsRef.current }), [coinsRef, tailsRef]);
  useEffect(() => {
    const state = world.current;
    const query = matchMedia(MOBILE_QUERY);
    const applyLayout = () => {
      const next = query.matches ? 'mobile' : 'desktop';
      tailsRef.current?.setAttribute('viewBox', LAYOUTS[next].viewBox);
      if (next !== state.layout) { state.layout = next; clearCoins(state, layers()); }
    };
    const observer = new ResizeObserver(([entry]) => { state.size = [entry.contentRect.width, entry.contentRect.height]; render(state); });
    observer.observe(sceneRef.current);
    query.addEventListener('change', applyLayout);
    applyLayout();
    return () => { observer.disconnect(); query.removeEventListener('change', applyLayout); };
  }, [sceneRef, tailsRef, layers]);
  useEffect(() => { if (reduced) clearCoins(world.current, layers()); }, [reduced, layers]);
  useEffect(() => {
    if (!running) return undefined;
    const state = world.current, active = layers();
    if (!state.warmed) { for (let elapsed = 0; elapsed < WARM_UP_SECONDS; elapsed += .05) step(state, active, .05, null); state.warmed = true; }
    render(state);
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const dt = Math.min((now - last) / 1000, .05);
      last = now;
      step(state, active, dt, onStage);
      render(state);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [running, layers, onStage]);
}

function FlowRails({ orientation, reduced }) {
  return <svg className={`flow-rails ${orientation}`} viewBox={LAYOUTS[orientation].viewBox} preserveAspectRatio="none" aria-hidden="true">
    {PATHS[orientation].map(path => <path key={path} d={path} className="flow-rail" fill="none" vectorEffect="non-scaling-stroke" />)}
    {!reduced && PATHS[orientation].map(path => <path key={`current-${path}`} d={path} className="flow-rail-current" pathLength="100" fill="none" vectorEffect="non-scaling-stroke" />)}
  </svg>;
}

export function CapitalScene({ compact = false }) {
  const ref = useRef(), sceneRef = useRef(), coinsRef = useRef(), tailsRef = useRef(), chipsRef = useRef();
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
  useCapitalFlow(sceneRef, coinsRef, tailsRef, running, reduced, onStage);
  const selectedStage = STAGES[selected];
  return <section ref={ref} className={`capital-scene-panel panel ${compact ? 'compact-scene' : ''}`}>
    <div className="scene-heading"><div><h2>{compact ? 'Follow the capital.' : 'From the first trade to your people.'}</h2></div></div>
    <div className="capital-scene" ref={sceneRef} data-running={running}>
      <FlowRails orientation="desktop" reduced={reduced} /><FlowRails orientation="mobile" reduced={reduced} />
      <svg className="flow-tails" ref={tailsRef} viewBox={LAYOUTS.desktop.viewBox} preserveAspectRatio="none" aria-hidden="true" />
      <div className="flow-coins" ref={coinsRef} aria-hidden="true" />
      {STAGES.map((stage, index) => <button type="button" key={stage.id} ref={el => { nodes.current[stage.id] = el; }} className={`flow-node flow-node-${stage.id} ${selected === index ? 'selected' : ''}`} style={{ '--node-x': `${stage.x}%`, '--node-y': `${stage.y}%`, '--mobile-x': `${stage.mx}%`, '--mobile-y': `${stage.my}%` }} aria-pressed={selected === index} aria-label={`${stage.label}${stage.share ? `, ${stage.share}` : ''}`} onClick={() => setSelected(index)}>
        <span className="flow-node-disc">{stage.id === 'pump' ? <span className="pump-symbol" /> : stage.id === 'collect' ? <ArrowDown size={29} /> : stage.id === 'convert' ? <CurrencyDollar size={30} /> : stage.id === 'money' ? <XLogo size={29} /> : stage.id === 'buyback' ? <Path size={28} weight="bold" /> : <XLogo size={23} />}</span>
        <span className="flow-node-label">{stage.label}{stage.share && <strong>{stage.share}</strong>}</span>
      </button>)}
      <div className="flow-chips" ref={chipsRef} aria-hidden="true" />
    </div>
    <div className="scene-explanation" aria-live="polite" key={selectedStage.id}><h3>{selectedStage.title}</h3><p>{selectedStage.text}</p></div>
  </section>;
}
