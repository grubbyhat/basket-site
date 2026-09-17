import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowDownLeft, ArrowRight, ArrowSquareOut, ArrowUpRight, BookOpen, Check, CheckCircle, CircleNotch, Clock, Copy, FlowArrow, Globe, House, ImageSquare, Info, Key, LockSimple, MagnifyingGlass, Path, Play, Plus, Receipt, RocketLaunch, ShieldCheck, SignOut, Stop, Trash, UsersThree, Wallet, Warning, X } from '@phosphor-icons/react';
import '@fontsource-variable/ibm-plex-sans';
import { EXAMPLE_BASKET, IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_RECIPIENTS, launchPayload, normalizeHandle, previewPayload, splitEvenly, toBasisPoints, validateBasket, validateDraft } from './basket.js';
import { CapitalScene, PayoutPreview } from './motion.jsx';
import { adminBuyback, adminBuybackRun, adminSetup, adminStatus, adminSweep, base64ToBytes, bytesToBase64, getCoin, getLaunch, getStats, inspectCoin, listCoins, lookupX, prepareLaunch, prepareRoute, readAsDataUrl, sendLaunch, sendRoute } from './api.js';
import { CHAIN, connectWallet, disconnectWallet, isRejection, listWallets, onWalletsChange, rememberedWalletName, shortAddress, signTransactions } from './wallet.js';
import './styles.css';
import './product-theme.css';
import './live.css';

const ROUTES = [
  ['/', 'Overview', House, 'Home'], ['/launch', 'Launch a token', RocketLaunch, 'Launch'],
  ['/payments', 'Payments', Receipt, 'Payments'], ['/capital-flow', 'Capital flow', FlowArrow, 'Flow'], ['/docs', 'Documentation', BookOpen, 'Docs'],
];
const DRAFT_KEY = 'basket-launch-draft-v1';
const REGISTER_KEY = 'route-register-draft-v1';
const INITIAL_DRAFT = { name: '', ticker: '', description: '', twitter: '', devBuy: '0', recipients: [{ id: 'first', handle: '', share: '100' }] };
const HANDLE_PATTERN = /^[a-z0-9_]{1,15}$/;
const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freshRecipients = () => [{ id: crypto.randomUUID(), handle: '', share: '100' }];
function validRecipients(value) { return Array.isArray(value) && value.length >= 1 && value.length <= 5 && value.every(r => typeof r.handle === 'string' && typeof r.share === 'string' && typeof r.id === 'string'); }
function loadDraft() {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY));
    if (saved && ['name', 'ticker', 'description', 'twitter', 'devBuy'].every(key => typeof saved[key] === 'string') && validRecipients(saved.recipients)) return saved;
  } catch { /* Storage is optional; the editor remains usable. */ }
  return INITIAL_DRAFT;
}
function loadRegisterDraft() {
  try {
    const saved = JSON.parse(localStorage.getItem(REGISTER_KEY));
    if (saved && typeof saved.mint === 'string' && validRecipients(saved.recipients)) return saved;
  } catch { /* optional */ }
  return { mint: '', recipients: freshRecipients() };
}
function timeAgo(iso) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const fmtUsd = value => (value == null || !Number.isFinite(value) ? null : value >= 1e6 ? `$${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `$${(value / 1e3).toFixed(1)}K` : `$${value.toFixed(2)}`);
const tick = symbol => (String(symbol || '').startsWith('$') ? String(symbol) : `$${symbol || '?'}`);
const fmtSol = value => (value == null || !Number.isFinite(value) ? '—' : value >= 100 ? value.toFixed(1) : value >= 1 ? value.toFixed(3) : value.toFixed(4));
const toUsd = (sol, price) => (sol == null || !price?.usd ? null : sol * price.usd);
const Money = ({ sol, price, usd = toUsd(sol, price) }) => (usd == null ? <span className="sol">{fmtSol(sol)}</span> : <>{fmtUsd(usd)}</>);
function friendlyError(error) {
  if (isRejection(error) && !error.status) return 'You closed the wallet prompt. Nothing was sent.';
  return error.message || 'Something went wrong. Nothing was charged.';
}

// X profiles are looked up through Route's server; the cache is per page load.
const profileCache = new Map();
function useProfiles(handles) {
  const [, setVersion] = useState(0);
  const key = handles.join(' ');
  useEffect(() => {
    let active = true;
    const timers = handles.filter(handle => HANDLE_PATTERN.test(handle) && !profileCache.has(handle)).map(handle => setTimeout(async () => {
      profileCache.set(handle, { status: 'loading' });
      if (active) setVersion(v => v + 1);
      try { profileCache.set(handle, { status: 'ok', profile: await lookupX(handle) }); }
      catch (error) {
        profileCache.set(handle, { status: error.status === 404 ? 'missing' : 'error', error: error.message });
        if (error.status !== 404) setTimeout(() => { if (profileCache.get(handle)?.status === 'error') profileCache.delete(handle); }, 30_000);
      }
      if (active) setVersion(v => v + 1);
    }, 450));
    return () => { active = false; timers.forEach(clearTimeout); };
  }, [key]);
  return handle => profileCache.get(normalizeHandle(handle)) || null;
}
const resolveProfile = handle => profileCache.get(normalizeHandle(handle)) || null;

const NavigationContext = React.createContext(null);
const WalletContext = React.createContext(null);
const LiveContext = React.createContext({ coins: {}, sol: null, connected: false, refresh: () => {} });

// Coins on Route and the SOL price, pushed from the server over a WebSocket.
function useLiveFeed() {
  const [state, setState] = useState({ coins: {}, sol: null, route: null, connected: false, loaded: false });
  const refresh = useCallback(async () => {
    try { const body = await listCoins(); setState(current => ({ ...current, loaded: true, sol: body.sol?.usd ? body.sol : current.sol, route: body.route || current.route, coins: Object.fromEntries((body.coins || []).map(coin => [coin.mint, coin])) })); }
    catch { setState(current => ({ ...current, loaded: true })); }
  }, []);
  useEffect(() => {
    let closed = false, attempt = 0, socket = null, timer = null;
    refresh();
    const connect = () => {
      if (closed) return;
      socket = new WebSocket(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`);
      socket.onopen = () => { attempt = 0; setState(current => ({ ...current, connected: true })); };
      socket.onmessage = event => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'snapshot') setState(current => ({ ...current, loaded: true, sol: message.sol?.usd ? message.sol : current.sol, route: message.route || current.route, coins: Object.fromEntries((message.coins || []).map(coin => [coin.mint, coin])) }));
          else if (message.type === 'route' && message.route) setState(current => ({ ...current, route: { ...(current.route || {}), ...message.route } }));
          else if (message.type === 'coin' && message.coin) setState(current => ({ ...current, coins: { ...current.coins, [message.coin.mint]: message.coin } }));
          else if (message.type === 'sol' && message.sol?.usd) setState(current => ({ ...current, sol: message.sol }));
        } catch { /* ignore malformed frames */ }
      };
      socket.onclose = () => { setState(current => ({ ...current, connected: false })); if (!closed) { attempt += 1; timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))); } };
      socket.onerror = () => socket.close();
    };
    connect();
    return () => { closed = true; clearTimeout(timer); socket?.close(); };
  }, [refresh]);
  return { ...state, refresh };
}

function Link({ to, children, onClick, ...props }) {
  const navigate = useContext(NavigationContext);
  return <a href={to} {...props} onClick={event => {
    onClick?.(event);
    if (!event.defaultPrevented && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
      event.preventDefault(); navigate(to);
    }
  }}>{children}</a>;
}
function Brand({ compact = false }) {
  return <Link to="/" className="brand" aria-label="Route overview"><span className="brand-mark"><Path size={24} weight="bold" /></span>{!compact && <span>route<span className="brand-period">.</span></span>}</Link>;
}
function PumpBadge() { return <span className="pump-badge"><span className="pump-symbol" aria-hidden="true" />pump.fun</span>; }
function ButtonLink({ to, children, secondary = false, className = '' }) { return <Link to={to} className={`button ${secondary ? 'secondary' : 'primary'} ${className}`}>{children}</Link>; }
function EmptyState({ title = 'The first payment starts here.', description = 'Confirmed payments will appear here once payouts are live.', compact = false }) {
  return <div className={`empty-state ${compact ? 'compact' : ''}`}><div className="empty-visual" aria-hidden="true"><span /><span /><div><ArrowDownLeft size={24} /></div></div><h3>{title}</h3><p>{description}</p><Link to="/launch" className="text-link">Build your route <ArrowUpRight size={15} /></Link></div>;
}
function useStats(refreshKey = 0) {
  const [stats, setStats] = useState({ coins: 0, recipients: 0, paidOutCents: 0, collectedLamports: '0' });
  useEffect(() => { let active = true; getStats().then(next => { if (active) setStats(next); }).catch(() => {}); return () => { active = false; }; }, [refreshKey]);
  return stats;
}
function Metrics({ large = false }) {
  const live = useContext(LiveContext);
  const stats = useStats(useContext(WalletContext)?.launchCount);
  const coins = Object.values(live.coins);
  const feesSol = coins.reduce((sum, coin) => sum + (coin.live?.feesSol || 0), 0);
  const feesUsd = toUsd(feesSol, live.sol);
  return <dl className={`metrics ${large ? 'metrics-large' : ''}`}>
    <div><dt>Total paid out</dt><dd><span className="currency">$</span>{Math.floor(stats.paidOutCents / 100)}<span className="decimals">.{String(stats.paidOutCents % 100).padStart(2, '0')}</span></dd></div>
    <div><dt>Coins on Route</dt><dd>{live.loaded ? coins.length : stats.coins}</dd></div>
    <div><dt>Fees earned</dt><dd>{feesUsd == null ? <span className="sol">{fmtSol(feesSol)}</span> : <><span className="currency">$</span>{Math.floor(feesUsd)}<span className="decimals">.{String(Math.round((feesUsd % 1) * 100)).padStart(2, '0')}</span></>}</dd></div>
  </dl>;
}
function Avatar({ index = 0, handle, small = false, profile = null }) {
  const picture = profile?.avatarUrl;
  return <span className={`avatar avatar-${index % 5} ${small ? 'small' : ''}`} aria-hidden="true">{picture ? <img src={picture} alt="" loading="lazy" referrerPolicy="no-referrer" /> : (normalizeHandle(handle).slice(0, 1).toUpperCase() || String(index + 1))}</span>;
}
function Distribution({ recipients = EXAMPLE_BASKET, small = false, resolve = () => null }) {
  const valid = recipients.every(r => toBasisPoints(r.share) !== null);
  return <div className={`distribution ${small ? 'small' : ''}`}>
    <div className="allocation-strip" aria-hidden="true">{recipients.map((r, i) => <span className={`allocation-${i}`} key={r.id} style={{ flexGrow: valid ? (toBasisPoints(r.share) || 0) : 1 }} />)}</div>
    <div className="distribution-list">{recipients.map((r, i) => <div className="distribution-person" key={r.id}><Avatar index={i} handle={r.handle} small={small} profile={resolve(r.handle)?.profile || r} /><span>{normalizeHandle(r.handle) ? `@${normalizeHandle(r.handle)}` : `Recipient ${i + 1}`}</span><strong>{r.share || '0'}<span>%</span></strong></div>)}</div>
  </div>;
}
const recordRecipients = record => (record?.recipients || []).map(recipient => ({ id: recipient.xId || recipient.handle, handle: recipient.handle, share: String(recipient.basisPoints / 100), avatarUrl: recipient.avatarUrl }));

function HomeBasket() {
  const [count, setCount] = useState(3);
  const people = count === 3 ? EXAMPLE_BASKET : splitEvenly([...EXAMPLE_BASKET,
    { id: 'example-4', handle: 'the_artist', share: '0' },
    { id: 'example-5', handle: 'the_team', share: '0' },
  ]);
  return <div className="panel basket-feature">
    <div className="panel-heading"><h2>Everyone gets a share.</h2><UsersThree size={25} /></div>
    <div className="basket-example-controls"><span>Example route</span><div className="segmented-control" aria-label="Example recipient count">{[3, 5].map(value => <button key={value} type="button" aria-pressed={value === count} onClick={() => setCount(value)}>{value} people</button>)}</div></div>
    <Distribution recipients={people} />
    <div className="panel-foot"><Link to="/launch" className="text-link">Build your route <ArrowUpRight size={18} /></Link></div>
  </div>;
}
function tiltArt(event) {
  if (event.pointerType !== 'mouse') return;
  const bounds = event.currentTarget.getBoundingClientRect();
  const x = (event.clientX - bounds.left) / bounds.width - .5, y = (event.clientY - bounds.top) / bounds.height - .5;
  event.currentTarget.style.setProperty('--tilt-y', `${(x * 9).toFixed(2)}deg`);
  event.currentTarget.style.setProperty('--tilt-x', `${(-y * 7).toFixed(2)}deg`);
  event.currentTarget.style.setProperty('--art-zoom', '1.03');
}
function resetArt(event) { ['--tilt-x', '--tilt-y', '--art-zoom'].forEach(name => event.currentTarget.style.removeProperty(name)); }
function Home() {
  return <>
    <section className="hero">
      <div className="hero-copy">
        <h1>One coin.<br /><span>A shared upside.</span></h1>
        <p>Launch on pump.fun. Share creator fees with up to five people through X Money.</p>
        <div className="hero-actions"><ButtonLink to="/launch">Launch a token <ArrowUpRight size={20} /></ButtonLink><Link className="text-link" to="/docs">How it works <ArrowRight size={19} /></Link></div>
      </div>
      <div className="hero-art" onPointerMove={tiltArt} onPointerLeave={resetArt}><div className="hero-logo" aria-hidden="true"><Path weight="bold" /></div></div>
    </section>
    <Metrics />
    <section className="overview-grid"><HomeBasket /><div className="panel activity-panel"><div className="panel-heading"><h2>Recent payments</h2><Link to="/payments" className="icon-button" aria-label="View all payments"><ArrowUpRight size={22} /></Link></div><EmptyState compact title="Your first payout belongs here." description="Confirmed payments will appear when payouts go live." /></div></section>
    <div className="home-flow"><CapitalScene compact /><Link to="/capital-flow" className="text-link">Explore capital flow <ArrowRight size={19} /></Link></div>
  </>;
}

function PageHeading({ label, title, children, action }) { return <div className="page-heading"><div>{label && <div className="eyebrow">{label}</div>}<h1 tabIndex="-1">{title}</h1>{children && <p>{children}</p>}</div>{action}</div>; }
function FieldError({ id, children }) { return children ? <p id={id} className="field-error" role="alert">{children}</p> : null; }
function Field({ label, name, value, onChange, error, hint, ...props }) {
  return <div className="field"><label htmlFor={name}>{label}</label><input id={name} name={name} value={value} onChange={onChange} aria-invalid={!!error} aria-describedby={error ? `${name}-error` : hint ? `${name}-hint` : undefined} {...props} />{hint && <p className="field-hint" id={`${name}-hint`}>{hint}</p>}<FieldError id={`${name}-error`}>{error}</FieldError></div>;
}
function LaunchTabs({ active }) {
  return <nav className="launch-tabs" aria-label="Launch mode"><Link to="/launch" className={active === 'launch' ? 'active' : ''} aria-current={active === 'launch' ? 'page' : undefined}><RocketLaunch size={16} />New coin</Link><Link to="/register" className={active === 'register' ? 'active' : ''} aria-current={active === 'register' ? 'page' : undefined}><MagnifyingGlass size={16} />Existing coin</Link></nav>;
}
function RecipientStatus({ handle, lookup }) {
  const normalized = normalizeHandle(handle);
  if (!normalized || !HANDLE_PATTERN.test(normalized) || !lookup) return <p className="recipient-meta" />;
  if (lookup.status === 'loading') return <p className="recipient-meta"><CircleNotch className="spin" size={15} />Checking X…</p>;
  if (lookup.status === 'ok') return <p className="recipient-meta verified"><ShieldCheck size={15} weight="fill" /><strong>{lookup.profile.name || `@${lookup.profile.handle}`}</strong>found on X</p>;
  if (lookup.status === 'missing') return <p className="recipient-meta missing"><Warning size={15} />We couldn’t find @{normalized} on X.</p>;
  return <p className="recipient-meta"><Info size={15} />X lookup is unavailable right now. Recipients are verified again at launch.</p>;
}

// The fee route editor: up to five X accounts and their shares. Shared by new
// launches and registrations.
function RouteBuilder({ recipients, onChange, errors, setErrors, resolve }) {
  const basket = validateBasket(recipients);
  const updateRecipient = (index, key, value) => {
    onChange(recipients.map((recipient, i) => i === index ? { ...recipient, [key]: value } : recipient));
    setErrors(current => ({ ...current, [`${key}-${index}`]: undefined, basket: undefined }));
  };
  const addRecipient = () => {
    if (recipients.length >= MAX_RECIPIENTS) return;
    const remaining = Math.max(0, 10000 - basket.totalBps) / 100;
    onChange([...recipients, { id: crypto.randomUUID(), handle: '', share: String(remaining) }]);
    setErrors({});
    requestAnimationFrame(() => document.getElementById(`handle-${recipients.length}`)?.focus());
  };
  return <>
    <div className="form-section-title"><h3>Your fee route</h3><span className="count-badge">{recipients.length} of 5</span></div>
    <p className="section-description">Choose who gets a share of the recipient pool.</p>
    <div className="recipient-list">{recipients.map((recipient, index) => { const lookup = resolve(recipient.handle); return <div className="recipient-block" key={recipient.id}>
      <div className="recipient-row"><span className="recipient-avatar"><Avatar handle={recipient.handle} index={index} profile={lookup?.profile} />{lookup?.status === 'ok' && <span className="avatar-badge" aria-hidden="true"><Check size={11} weight="bold" /></span>}{lookup?.status === 'loading' && <span className="avatar-badge pending" aria-hidden="true"><CircleNotch className="spin" size={11} /></span>}{lookup?.status === 'missing' && <span className="avatar-badge missing" aria-hidden="true"><X size={11} weight="bold" /></span>}</span>
        <div className="recipient-handle field"><label htmlFor={`handle-${index}`}>X account {index + 1}</label><div className="input-prefix"><span aria-hidden="true">@</span><input id={`handle-${index}`} value={recipient.handle} onChange={e => updateRecipient(index, 'handle', e.target.value)} onBlur={() => { const normalized = normalizeHandle(recipient.handle); if (normalized) updateRecipient(index, 'handle', normalized); }} placeholder="username" autoComplete="off" spellCheck="false" aria-invalid={!!errors[`handle-${index}`]} aria-describedby={errors[`handle-${index}`] ? `handle-${index}-error` : `handle-${index}-status`} /></div></div>
        <div className="recipient-share field"><label htmlFor={`share-${index}`}>Share</label><div className="input-suffix"><input id={`share-${index}`} value={recipient.share} onChange={e => updateRecipient(index, 'share', e.target.value)} inputMode="decimal" aria-invalid={!!errors[`share-${index}`]} aria-describedby={errors[`share-${index}`] ? `share-${index}-error` : undefined} /><span aria-hidden="true">%</span></div></div>
        <button className="icon-button remove-recipient" type="button" disabled={recipients.length === 1} aria-label={`Remove recipient ${index + 1}`} onClick={() => { onChange(recipients.filter(r => r.id !== recipient.id)); setErrors({}); }}><Trash size={19} /></button>
      </div><div id={`handle-${index}-status`}><RecipientStatus handle={recipient.handle} lookup={lookup} /></div><FieldError id={`handle-${index}-error`}>{errors[`handle-${index}`]}</FieldError><FieldError id={`share-${index}-error`}>{errors[`share-${index}`]}</FieldError>
    </div>; })}</div>
    <div className="basket-controls"><button type="button" className="button secondary small-button" onClick={addRecipient} disabled={recipients.length >= MAX_RECIPIENTS}><Plus size={17} />Add recipient</button><button type="button" className="text-button" onClick={() => { onChange(splitEvenly(recipients)); setErrors({}); }}>Split evenly</button></div>
    <div className={`allocation-total ${basket.totalBps === 10000 ? 'complete' : 'incomplete'}`}><span>{basket.totalBps === 10000 ? <CheckCircle size={18} /> : <Info size={18} />}<span>{basket.totalBps === 10000 ? 'Fully allocated' : 'Shares must total 100%'}</span></span><strong>{basket.totalBps / 100}%</strong></div><FieldError id="basket-error">{errors.basket}</FieldError>
  </>;
}
function missingHandleErrors(recipients, resolve, errors) {
  const next = { ...errors };
  recipients.forEach((recipient, index) => { if (!next[`handle-${index}`] && resolve(recipient.handle)?.status === 'missing') next[`handle-${index}`] = `We couldn’t find @${normalizeHandle(recipient.handle)} on X. Check the spelling.`; });
  return next;
}

function Launch({ draft, setDraft, image, setImage, review }) {
  const [errors, setErrors] = useState({});
  const [imageError, setImageError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [loadingImage, setLoadingImage] = useState(false);
  const fileRef = useRef();
  const formRef = useRef();
  const uploadVersion = useRef(0);
  useEffect(() => () => { uploadVersion.current += 1; }, []);
  const resolve = useProfiles(draft.recipients.map(recipient => normalizeHandle(recipient.handle)));
  const update = (name, value) => { setDraft(current => ({ ...current, [name]: value })); setErrors(current => ({ ...current, [name]: undefined })); };
  const upload = async file => {
    const version = ++uploadVersion.current;
    setImageError(''); setLoadingImage(false);
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type)) { setImageError('Choose a PNG, JPG or WebP image.'); return; }
    if (file.size > MAX_IMAGE_BYTES) { setImageError('This image is too large. Choose one under 5 MB.'); return; }
    const url = URL.createObjectURL(file);
    setLoadingImage(true);
    try {
      const img = new Image(); img.src = url; await img.decode();
      if (version !== uploadVersion.current) { URL.revokeObjectURL(url); return; }
      if (img.width < 64 || img.height < 64) throw new Error('Use an image at least 64 × 64 pixels.');
      setImage({ url, name: file.name, file });
      setErrors(current => ({ ...current, image: undefined }));
    } catch (error) {
      URL.revokeObjectURL(url);
      if (version === uploadVersion.current) setImageError(error.message.startsWith('Use an image') ? error.message : 'This image could not be opened. Try another file.');
    } finally { if (version === uploadVersion.current) setLoadingImage(false); }
  };
  const submit = event => {
    event.preventDefault();
    const nextErrors = missingHandleErrors(draft.recipients, resolve, validateDraft(draft, image).errors);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) { if (nextErrors.twitter) formRef.current.querySelector('.social-fields').open = true; requestAnimationFrame(() => formRef.current?.querySelector('[aria-invalid="true"]')?.focus()); return; }
    review();
  };
  return <>
    <PageHeading title="Launch a coin. Share the fees." action={<LaunchTabs active="launch" />}>Pick your people, set the split, and make it yours.</PageHeading>
    <div className="launch-layout">
      <form className="launch-form" ref={formRef} onSubmit={submit} noValidate>
        <section className="form-section">
          <div className="launch-form-heading"><h2>Launch token</h2><PumpBadge /></div>
          <RouteBuilder recipients={draft.recipients} onChange={recipients => update('recipients', recipients)} errors={errors} setErrors={setErrors} resolve={resolve} />
        </section>
        <section className="form-section token-fields">
          <div className="two-fields"><Field label="Token name" name="name" placeholder="The next good idea" value={draft.name} maxLength={32} onChange={e => update('name', e.target.value)} error={errors.name} autoComplete="off" /><Field label="Ticker" name="ticker" placeholder="IDEA" value={draft.ticker} maxLength={10} onChange={e => update('ticker', e.target.value.toUpperCase())} error={errors.ticker} autoComplete="off" /></div>
          <div className="field image-field"><label htmlFor="token-image">Token image</label><input ref={fileRef} id="token-image" className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" tabIndex={-1} onChange={e => { upload(e.target.files[0]); e.target.value = ''; }} />
            <button type="button" className={`upload-zone ${dragging ? 'is-dragging' : ''} ${image ? 'has-image' : ''}`} onClick={() => fileRef.current.click()} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files[0]); }} aria-invalid={!!(errors.image || imageError)} aria-describedby="image-error">
              {image ? <img src={image.url} alt="Selected token artwork" /> : <span className="upload-icon">{loadingImage ? <CircleNotch className="spin" size={26} /> : <ImageSquare size={26} />}</span>}<span><strong>{loadingImage ? 'Opening image…' : image ? image.name : 'Choose an image'}</strong><span>{image ? 'Click to replace' : 'PNG, JPG or WebP, up to 5 MB'}</span></span><Plus size={20} />
            </button><FieldError id="image-error">{imageError || errors.image}</FieldError>
          </div>
          <div className="field"><label htmlFor="description">Description</label><textarea id="description" value={draft.description} onChange={e => update('description', e.target.value)} maxLength={500} placeholder="What is your coin about?" rows={3} aria-invalid={!!errors.description} aria-describedby={errors.description ? 'description-error' : undefined} /><FieldError id="description-error">{errors.description}</FieldError></div>
          <details className="social-fields"><summary>Social links <span>Optional <Plus size={17} /></span></summary><div className="social-fields-body">
            <div className="field website-field"><label htmlFor="website">Website <span className="automatic-label"><LockSimple size={14} />Automatic</span></label><div className="input-prefix"><Globe size={19} /><input id="website" readOnly value={new URL('/', window.location.origin).href} /></div></div>
            <Field label="X link" name="twitter" value={draft.twitter} placeholder="https://x.com/yourproject" onChange={e => update('twitter', e.target.value)} error={errors.twitter} />
          </div></details>
        </section>
        <section className="form-section"><div className="form-section-title"><h2><label htmlFor="devBuy">Dev buy</label></h2><span className="optional">Optional</span></div><div className="field dev-field"><div className="input-suffix"><input id="devBuy" inputMode="decimal" value={draft.devBuy} onChange={e => update('devBuy', e.target.value)} aria-invalid={!!errors.devBuy} aria-describedby="devBuy-hint" /><span>SOL</span></div><FieldError id="devBuy-error">{errors.devBuy}</FieldError></div>
          <div className="amount-presets">{['0', '0.1', '0.5', '1'].map(value => <button type="button" key={value} aria-pressed={draft.devBuy === value} onClick={() => update('devBuy', value)}>{value === '0' ? 'No buy' : `${value} SOL`}</button>)}</div><p className="field-hint" id="devBuy-hint">Your first buy, included in the launch transaction.</p>
        </section>
        <div className="form-submit"><button className="button primary" type="submit" disabled={loadingImage}>Review launch <ArrowRight size={20} /></button><p>You confirm the launch in your wallet. Nothing is sent before that.</p></div>
      </form>
      <aside className="launch-preview"><div className="preview-sticky"><PayoutPreview recipients={draft.recipients} resolve={resolve} />
        <div className="token-preview"><div className={`token-art ${image ? 'with-art' : ''}`}>{image ? <img src={image.url} alt={`${draft.name || 'Your token'} artwork preview`} /> : <ImageSquare size={65} weight="light" />}</div>
          <div className="token-preview-body"><div className="token-title"><h2>{draft.name || 'Your token name'}</h2><span>${draft.ticker || 'TICKER'}</span></div><PumpBadge />
            {draft.description && <p className="token-description">{draft.description}</p>}<div className="preview-payment"><span>Total paid out</span><strong>$0.00</strong></div>
            <div className="preview-recipients-title"><span>Your fee route</span><UsersThree size={20} /></div><Distribution recipients={draft.recipients} small resolve={resolve} />
            <div className="preview-dev"><span>Dev buy</span><strong>{draft.devBuy || '0'} SOL</strong></div>
          </div>
        </div>
      </div></aside>
    </div>
  </>;
}

// Prepares, signs and confirms a coin's fee-route transaction. Used for
// registrations and for finishing a launch whose route did not land.
function useRouteFlow() {
  const { wallet, account } = useContext(WalletContext);
  const live = useContext(LiveContext);
  const [stage, setStage] = useState('idle');
  const [error, setError] = useState('');
  const run = useRef(0);
  const reset = useCallback(() => { run.current += 1; setStage('idle'); setError(''); }, []);
  const start = async ({ mint, recipients = null }) => {
    const attempt = ++run.current;
    const active = () => attempt === run.current;
    setError(''); setStage('preparing');
    try {
      const prepared = await prepareRoute({ mint, wallet: account.address, ...(recipients ? { recipients } : {}) });
      if (!active()) return null;
      if (prepared.already) { setStage('done'); live.refresh(); return prepared.record; }
      setStage('signing');
      const [signed] = await signTransactions(wallet, account, prepared.transactions.map(base64ToBytes));
      if (!active()) return null;
      setStage('sending');
      await sendRoute({ mint, signedTransaction: bytesToBase64(signed) });
      setStage('confirming');
      for (;;) {
        await sleep(2000);
        if (!active()) return null;
        const { coin } = await getCoin(mint);
        if (coin.route?.status === 'active') { setStage('done'); live.refresh(); return coin; }
        if (['failed', 'unknown'].includes(coin.route?.status)) throw new Error(coin.route.friendly || (coin.route.error === 'expired' ? 'Solana did not include the transaction in time. Nothing changed. Try again.' : 'The fee route transaction failed on-chain.'));
      }
    } catch (caught) {
      if (!active()) return null;
      setStage('error'); setError(friendlyError(caught));
      return null;
    }
  };
  return { stage, error, start, reset, busy: ['preparing', 'signing', 'sending', 'confirming'].includes(stage) };
}
const ROUTE_STEPS = [['preparing', 'Checking the coin'], ['signing', 'Confirm in your wallet'], ['sending', 'Sending to Solana'], ['confirming', 'Waiting for confirmation']];
function Steps({ steps, stage }) {
  const index = steps.findIndex(([id]) => id === stage);
  return <div className="launch-steps" aria-live="polite">{steps.map(([id, label], i) => <div className={`launch-step ${i < index ? 'done' : i === index ? 'active' : ''}`} key={id}><span>{i < index ? <Check size={13} weight="bold" /> : i === index ? <CircleNotch className="spin" size={14} /> : i + 1}</span>{label}</div>)}</div>;
}
function PhasePill({ live }) {
  if (!live) return <span className="status-pill pending">Waiting for data</span>;
  if (live.bonded) return <span className="status-pill bonded">Bonded</span>;
  const percent = Math.round(live.progress * 100);
  return <span className="status-pill bonding"><i aria-hidden="true"><b style={{ width: `${percent}%` }} /></i>Bonding {percent}%</span>;
}
function CoinArt({ src, alt = '', size = 48 }) { return src ? <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" /> : <span className="coin-art"><ImageSquare size={size / 2} /></span>; }

function RegisterCoin({ register, setRegister, openChooser }) {
  const { account } = useContext(WalletContext);
  const [errors, setErrors] = useState({});
  const [coin, setCoin] = useState(null);
  const [inspecting, setInspecting] = useState(false);
  const [lookupError, setLookupError] = useState('');
  const flow = useRouteFlow();
  const resolve = useProfiles(register.recipients.map(recipient => normalizeHandle(recipient.handle)));
  const update = (name, value) => setRegister(current => ({ ...current, [name]: value }));
  const lookup = async event => {
    event?.preventDefault();
    const mint = register.mint.trim();
    if (!MINT_PATTERN.test(mint)) { setLookupError('Enter the coin’s mint address.'); return; }
    setLookupError(''); setInspecting(true); setCoin(null); flow.reset();
    try { setCoin(await inspectCoin(mint)); }
    catch (error) { setLookupError(error.message); }
    finally { setInspecting(false); }
  };
  useEffect(() => { if (MINT_PATTERN.test(register.mint.trim()) && !coin && !inspecting && !lookupError) lookup(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const owned = coin && account && coin.creator === account.address;
  const already = coin?.record?.route?.status === 'active' || coin?.onRoute;
  const blocked = coin?.sharing && !coin.onRoute;
  const submit = async event => {
    event.preventDefault();
    const nextErrors = missingHandleErrors(register.recipients, resolve, validateBasket(register.recipients).errors);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    const result = await flow.start({ mint: coin.mint, recipients: register.recipients.map(recipient => ({ handle: normalizeHandle(recipient.handle), basisPoints: toBasisPoints(recipient.share) })) });
    if (result) setCoin(current => ({ ...current, record: result, onRoute: true }));
  };
  return <>
    <PageHeading title="Put an existing coin on Route." action={<LaunchTabs active="register" />}>Launched on pump.fun already? Point its creator fees at your people.</PageHeading>
    <div className="register-layout">
      <form className="register-form" onSubmit={flow.stage === 'done' ? event => event.preventDefault() : coin && !already && !blocked ? submit : lookup} noValidate>
        <section className="form-section">
          <div className="launch-form-heading"><h2>Find your coin</h2><PumpBadge /></div>
          <div className="register-lookup"><Field label="Mint address" name="mint" value={register.mint} placeholder="Paste the coin’s mint address" autoComplete="off" spellCheck="false" onChange={e => { update('mint', e.target.value); setLookupError(''); setCoin(null); flow.reset(); }} error={lookupError} /><button type="button" className="button secondary" onClick={lookup} disabled={inspecting}>{inspecting ? <CircleNotch className="spin" size={17} /> : <MagnifyingGlass size={17} />}Look up</button></div>
          {coin && <div className="coin-card"><CoinArt src={coin.imageUrl} size={64} /><div><strong>{coin.name || 'Unnamed coin'}</strong><span>{tick(coin.symbol)} · created by <span className="mono">{shortAddress(coin.creator)}</span></span></div><span className={`status-pill ${coin.graduated || coin.complete ? 'bonded' : 'bonding'}`}>{coin.graduated || coin.complete ? 'Bonded' : 'Bonding'}</span></div>}
          {coin && already && flow.stage !== 'done' && <div className="register-note good"><CheckCircle size={18} /><span>This coin is already on Route.{coin.record && <> Fees route to {coin.record.recipients.map(r => `@${r.handle}`).join(', ')}.</>} <Link to={`/coin/${coin.mint}`} className="text-link">Open its page <ArrowUpRight size={14} /></Link></span></div>}
          {coin && blocked && <div className="register-note warn"><Warning size={18} /><span>This coin already shares its fees with {coin.sharing.shareholders.length} address{coin.sharing.shareholders.length === 1 ? '' : 'es'} elsewhere. pump.fun locks fee sharing after the first change, so it cannot move to Route.</span></div>}
          {coin && !already && !blocked && !account && <div className="register-note"><Wallet size={18} /><span>Connect the wallet that created this coin, <span className="mono">{shortAddress(coin.creator)}</span>, to continue.</span></div>}
          {coin && !already && !blocked && account && !owned && <div className="register-note warn"><Warning size={18} /><span>Connect <span className="mono">{shortAddress(coin.creator)}</span>, the wallet that created this coin. You are connected as <span className="mono">{shortAddress(account.address)}</span>.</span></div>}
        </section>
        {coin && !already && !blocked && <section className="form-section">
          <RouteBuilder recipients={register.recipients} onChange={recipients => update('recipients', recipients)} errors={errors} setErrors={setErrors} resolve={resolve} />
        </section>}
        {coin && !already && !blocked && <div className="form-submit">
          {flow.busy ? <Steps steps={ROUTE_STEPS} stage={flow.stage} /> : null}
          {flow.error && <div className="launch-error" role="alert"><Warning size={18} /><span>{flow.error}</span></div>}
          {!account ? <button type="button" className="button primary" onClick={openChooser}><Wallet size={17} />Connect wallet</button>
            : <button className="button primary" type="submit" disabled={!owned || flow.busy}>{flow.busy ? <><CircleNotch className="spin" size={17} />{ROUTE_STEPS.find(([id]) => id === flow.stage)?.[1]}</> : <><Path size={17} />Put fees on Route</>}</button>}
          <p>One transaction, signed by the creator wallet. pump.fun locks the route after this.</p>
        </div>}
        {flow.stage === 'done' && coin && <div className="form-submit"><div className="register-note good"><CheckCircle size={18} /><span>Done. Creator fees for {tick(coin.symbol)} now route to your people. <Link to={`/coin/${coin.mint}`} className="text-link">Open the coin page <ArrowUpRight size={14} /></Link></span></div></div>}
      </form>
      <aside className="launch-preview"><div className="preview-sticky"><PayoutPreview recipients={register.recipients} resolve={resolve} />
        <div className="token-preview"><div className={`token-art ${coin?.imageUrl ? 'with-art' : ''}`}>{coin?.imageUrl ? <img src={coin.imageUrl} alt={`${coin.name || 'Coin'} artwork`} referrerPolicy="no-referrer" /> : <ImageSquare size={65} weight="light" />}</div>
          <div className="token-preview-body"><div className="token-title"><h2>{coin?.name || 'Your coin'}</h2><span>{coin ? tick(coin.symbol) : '$TICKER'}</span></div><PumpBadge />
            <div className="preview-payment"><span>Total paid out</span><strong>$0.00</strong></div>
            <div className="preview-recipients-title"><span>Your fee route</span><UsersThree size={20} /></div><Distribution recipients={register.recipients} small resolve={resolve} />
          </div>
        </div>
      </div></aside>
    </div>
  </>;
}

function CoinsList() {
  const live = useContext(LiveContext);
  const coins = Object.values(live.coins).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const route = live.route;
  return <section className="panel payments-ledger"><div className="panel-heading"><h2>Coins on Route</h2><span className={`live-dot ${live.connected ? '' : 'off'}`}>{live.connected ? 'Live' : 'Reconnecting'}</span></div>
    {route?.github && <div className="route-account">{route.github.avatarUrl && <img src={route.github.avatarUrl} alt="" referrerPolicy="no-referrer" />}<span>Fees collect to <strong>{route.github.login}</strong> on pump.fun{route.exists ? '' : ' (account not created yet)'}</span><span className="route-account-sums"><Money sol={route.unclaimedSol} usd={route.unclaimedUsd} /> waiting to claim · <Money sol={route.claimedSol} usd={route.claimedUsd} /> claimed</span></div>}
    <div className="coin-columns" aria-hidden="true"><span /><span>Coin</span><span>Market cap</span><span>Status</span><span>Fees earned</span><span /></div>
    <div className="launched-list">{coins.length ? coins.map(coin => <Link className="coin-row" key={coin.mint} to={`/coin/${coin.mint}`}><CoinArt src={coin.imageUrl} /><div><strong>{coin.name} <span className="mono">{tick(coin.symbol)}</span></strong><span>{coin.recipients.length === 1 ? `@${coin.recipients[0].handle}` : `${coin.recipients.length} recipients`} · {timeAgo(coin.confirmedAt || coin.createdAt)}</span></div><div><strong><Money sol={coin.live?.mcapSol} usd={coin.live?.mcapUsd} /></strong><span>{coin.live?.mcapUsd ? <span className="sol">{fmtSol(coin.live.mcapSol)}</span> : 'market cap'}</span></div><div><PhasePill live={coin.live} />{coin.route?.status !== 'active' && <span>Fee route {coin.route?.status || 'pending'}</span>}</div><div><strong><Money sol={coin.live?.feesSol} usd={coin.live?.feesUsd} /></strong><span>{coin.live?.feesUsd != null ? <span className="sol">{fmtSol(coin.live.feesSol)}</span> : 'creator fees'}</span></div><ArrowRight size={18} /></Link>)
      : live.loaded ? <div className="quiet-empty" style={{ padding: '31px 28px 32px' }}><RocketLaunch size={23} /><div><h3>No coins on Route yet</h3><p>Every coin launched or registered here appears with its live market cap and fees.</p></div></div> : null}</div>
  </section>;
}
function Payments() {
  const [filter, setFilter] = useState('All payments');
  return <><PageHeading title="Every payment, in the open." action={<ButtonLink to="/register" secondary>Register a coin <ArrowUpRight size={15} /></ButtonLink>}>A record of the people paid and the coins behind them.</PageHeading><Metrics large /><CoinsList /><section className="panel payments-ledger" style={{ marginTop: 24 }}><div className="panel-heading"><h2>Payment history</h2><span className="count-badge">0 payments</span></div><div className="payment-toolbar"><div className="segmented-control" aria-label="Payment status">{['All payments', 'Completed', 'Pending'].map(item => <button key={item} type="button" aria-pressed={item === filter} onClick={() => setFilter(item)}>{item}</button>)}</div><span>Amounts in USD</span></div><div className="ledger-columns" aria-hidden="true"><span>Recipient / token</span><span>Amount</span><span>Status</span><span>Date</span></div><div role="status"><EmptyState title={filter === 'Pending' ? 'Nothing waiting in the wings.' : filter === 'Completed' ? 'No completed payments yet.' : 'A clean slate. A shared future.'} description={filter === 'Pending' ? 'Pending payouts will be listed here when payments are enabled.' : 'When payouts begin, each confirmed payment will have a place here.'} /></div><div className="panel-foot"><span><LockSimple size={13} /> Payouts are being connected</span><Link to="/docs#payments" className="text-link">About payments <ArrowUpRight size={14} /></Link></div></section></>;
}

function CoinPage({ mint, openChooser }) {
  const live = useContext(LiveContext);
  const { account } = useContext(WalletContext);
  const [fetched, setFetched] = useState(null);
  const [missing, setMissing] = useState(false);
  const flow = useRouteFlow();
  const coin = live.coins[mint] || fetched;
  useEffect(() => { let active = true; setMissing(false); getCoin(mint).then(body => { if (active) setFetched(body.coin); }).catch(() => { if (active) setMissing(true); }); return () => { active = false; }; }, [mint, flow.stage]);
  if (missing && !coin) return <><PageHeading title="This coin isn’t on Route.">Launch it here or register it if you created it.</PageHeading><ButtonLink to="/register">Register a coin <ArrowRight size={16} /></ButtonLink></>;
  if (!coin) return <PageHeading title="Loading coin…" />;
  const state = coin.live;
  const routeActive = coin.route?.status === 'active';
  const canFinish = !routeActive && account && account.address === coin.wallet && coin.status === 'confirmed' && !['sending', 'sent'].includes(coin.route?.status);
  return <>
    <div className="coin-header"><CoinArt src={coin.imageUrl} size={88} /><div><h1 tabIndex="-1">{coin.name} <span className="mono">{tick(coin.symbol)}</span></h1><p><PhasePill live={state} /><span>created by <span className="mono">{shortAddress(coin.wallet)}</span></span><span>{timeAgo(coin.confirmedAt || coin.createdAt)}</span><span className={`live-dot ${live.connected ? '' : 'off'}`}>{live.connected ? 'Live' : 'Reconnecting'}</span></p></div><div className="coin-links"><a className="button secondary" href={coin.pumpUrl} target="_blank" rel="noreferrer">pump.fun <ArrowSquareOut size={16} /></a><a className="button secondary" href={`https://solscan.io/token/${coin.mint}`} target="_blank" rel="noreferrer">Solscan <ArrowSquareOut size={16} /></a></div></div>
    <div className="coin-tiles">
      <div className="coin-tile"><span>Market cap</span><strong><Money sol={state?.mcapSol} usd={state?.mcapUsd} /></strong><small>{state?.mcapUsd ? <span className="sol">{fmtSol(state.mcapSol)}</span> : 'from the bonding curve'}</small></div>
      <div className="coin-tile"><span>Bonding</span><strong>{state ? state.bonded ? 'Bonded' : `${Math.round(state.progress * 100)}%` : '—'}</strong><small>{state?.phase === 'graduated' ? 'trading on PumpSwap' : state?.phase === 'migrating' ? 'migrating to PumpSwap' : 'of the curve sold'}</small></div>
      <div className="coin-tile"><span>Fees earned</span><strong><Money sol={state?.feesSol} usd={state?.feesUsd} /></strong><small>{state?.feesUsd != null ? <><span className="sol">{fmtSol(state.feesSol)}</span> to date</> : 'creator fees to date'}</small></div>
      <div className="coin-tile"><span>Sent to Route</span><strong><Money sol={state?.collectedSol} price={live.sol} /></strong><small>{state ? <><Money sol={state.unclaimedSol} price={live.sol} /> still in the coin's vault</> : 'collected for payouts'}</small></div>
    </div>
    <div className="coin-grid">
      <section className="panel"><div className="panel-heading"><h2>Fee route</h2><UsersThree size={22} /></div><div style={{ marginTop: 22 }}><Distribution recipients={recordRecipients(coin)} resolve={() => null} /></div>
        <div className="coin-route-status"><span>{routeActive ? 'On-chain fee sharing is active and locked to Route.' : coin.route?.status === 'failed' ? 'The fee route transaction did not land.' : coin.route?.status === 'unknown' ? 'The fee route is still unconfirmed.' : 'Fee route pending.'}</span><span className={`status-pill ${routeActive ? 'bonded' : 'pending'}`}>{routeActive ? 'On Route' : 'Pending'}</span></div>
        {canFinish && <div style={{ marginTop: 18 }}>{flow.busy ? <Steps steps={ROUTE_STEPS} stage={flow.stage} /> : null}{flow.error && <div className="launch-error" role="alert"><Warning size={18} /><span>{flow.error}</span></div>}<button type="button" className="button primary" disabled={flow.busy} onClick={() => flow.start({ mint: coin.mint })}>{flow.busy ? <CircleNotch className="spin" size={17} /> : <Path size={17} />}Finish fee route</button></div>}
        {!routeActive && !account && coin.status === 'confirmed' && <div style={{ marginTop: 18 }}><button type="button" className="button secondary" onClick={openChooser}><Wallet size={17} />Connect the creator wallet to finish</button></div>}
      </section>
      <section className="panel"><div className="panel-heading"><h2>Details</h2><Info size={22} /></div>
        <dl className="review-details" style={{ borderBottom: 0 }}><div><dt>Mint</dt><dd className="mono" style={{ overflowWrap: 'anywhere', textAlign: 'right' }}>{coin.mint}</dd></div><div><dt>Creator</dt><dd className="mono">{shortAddress(coin.wallet)}</dd></div><div><dt>Added</dt><dd>{coin.kind === 'registered' ? 'Registered' : 'Launched'} {timeAgo(coin.confirmedAt || coin.createdAt)}</dd></div><div><dt>Fees collected</dt><dd>{coin.fees?.claims?.length || 0} collection{coin.fees?.claims?.length === 1 ? '' : 's'}</dd></div>{coin.signature && <div><dt>Transaction</dt><dd><a className="text-link" href={`https://solscan.io/tx/${coin.signature}`} target="_blank" rel="noreferrer">Solscan <ArrowSquareOut size={13} /></a></dd></div>}</dl>
      </section>
    </div>
  </>;
}

function CapitalFlow() {
  const [amount, setAmount] = useState(100);
  const [preset, setPreset] = useState('50 / 30 / 20');
  const recipients = preset === '50 / 30 / 20' ? EXAMPLE_BASKET : splitEvenly(EXAMPLE_BASKET);
  const poolCents = amount * 100;
  const shares = recipients.map(r => Math.floor(poolCents * toBasisPoints(r.share) / 10000));
  shares[0] += poolCents - shares.reduce((a, b) => a + b, 0);
  return <><PageHeading title="Capital flow">Follow the fees, from the first trade to every person on your route.</PageHeading><CapitalScene /><section className="flow-calculator"><div><h2>Try the split.</h2><p>Change the example recipient pool and see how the dollars are divided.</p><label className="range-label" htmlFor="pool">Example recipient pool <strong>${amount.toLocaleString()}</strong></label><input id="pool" className="range-input" type="range" min="10" max="1000" step="10" value={amount} onChange={e => setAmount(Number(e.target.value))} /><div className="range-limits"><span>$10</span><span>$1,000</span></div><div className="segmented-control split-presets" aria-label="Example split">{['50 / 30 / 20', 'Equal split'].map(value => <button key={value} aria-pressed={preset === value} onClick={() => setPreset(value)}>{value}</button>)}</div><p className="calculator-note">Example amounts, after any applicable costs.</p></div><div className="panel calculator-result"><div className="panel-heading"><h3>Example distribution</h3><Path size={20} /></div>{recipients.map((recipient, index) => <div className="calculator-person" key={recipient.id}><Avatar index={index} handle={recipient.handle} /><div><strong>@{recipient.handle}</strong><span>{recipient.share}% of the pool</span></div><strong>${(shares[index] / 100).toFixed(2)}</strong></div>)}<div className="calculator-total"><span>Allocated to recipients</span><strong>${amount.toFixed(2)}</strong></div></div></section><section className="panel flow-activity"><div className="panel-heading"><h2>Capital activity</h2><span className="count-badge">0 events</span></div><div className="quiet-empty"><Clock size={23} /><div><h3>No capital movements yet</h3><p>Collections, conversions and payouts will appear here when the service is live.</p></div></div></section></>;
}

const DOCS = [
  { id: 'overview', title: 'A little coin. A bigger circle.', intro: 'Route is a way to launch a pump.fun token with creator fees shared between the people you choose.', paragraphs: ['Instead of choosing one recipient, route the fees to up to five X accounts. Set a percentage for each person and review the complete allocation before launch.', 'Launches are live. Connect a Solana wallet, build your route and create the coin on pump.fun. Its creator fees flow to Route through pump.fun’s fee sharing; the conversion to dollars and the X Money payout are still being connected.'] },
  { id: 'launching', title: 'Create your token', intro: 'Keep the idea simple. Make the details your own.', paragraphs: ['Add your token’s name, ticker and image. A description and an X profile or post link are optional. The website field automatically uses this site’s homepage.', 'Set an optional dev buy in SOL, or leave it at zero. The launch flow is designed for a single creator wallet. Bundle buys are not offered.', 'Review launch checks your draft, verifies every recipient on X and opens a summary. Launch on pump.fun asks your wallet to confirm two transactions at once: one creates the coin, the next puts its fees on Route. Your wallet pays the dev buy and the Solana network fees; Route charges no launch fee today.'] },
  { id: 'fees', title: 'How the fees move', intro: 'pump.fun keeps them until someone collects.', paragraphs: ['pump.fun pays a creator fee on every trade into a vault; nothing is sent automatically. With fee sharing, the coin’s creator creates a fee-sharing config for the coin and names the shareholders once. From then on the fees accrue in the coin’s own vault and anyone can trigger a distribution to the shareholders. pump.fun locks the shareholders after that first change.', 'On Route the single shareholder is Route’s own pump.fun identity, a GitHub account, so pump.fun shows Route’s picture next to the coin. Every ten seconds Route sweeps every coin’s vault and moves the fees into that account, so each coin shows the fees it has earned, what is still waiting in its vault, and what has been sent to Route. Route then claims from pump.fun with that GitHub account to pay recipients.', 'The coin stays yours: you remain its creator on pump.fun, you keep every token you hold, and you can still trade it anywhere.'] },
  { id: 'register', title: 'Register a coin you already launched', intro: 'Any pump.fun coin, as long as you created it.', paragraphs: ['Paste the coin’s mint address on the Existing coin tab. Route reads the coin from the chain, shows its name and picture, and checks who created it. Connect that wallet, choose your recipients and confirm one transaction that creates the fee-sharing config and points it at Route.', 'Coins whose fee sharing was already set up elsewhere cannot move: pump.fun allows one change only. Fees that accrued before registration stay in the creator’s own pump.fun vault and are not part of Route.'] },
  { id: 'baskets', title: 'Build your fee route', intro: 'Your recipients. Your allocation.', paragraphs: ['Add between one and five unique X handles. You can also paste an X or Twitter profile link. Each share must be greater than zero and all shares must total exactly 100%.', 'Shares support two decimal places. Split evenly divides the allocation and assigns any remaining hundredth of a percent to the first recipients, so the total stays exact.', 'When you enter a handle, Route looks the account up on X and shows its name and picture. Each launch keeps the account’s numeric X ID, so a later username change never redirects a payout. This does not prove account ownership or X Money eligibility. These percentages refer to the recipient pool, not to the token supply; final service fees and conversion costs are not set yet.'] },
  { id: 'payments', title: 'Payments and receipts', intro: 'A clear record from the very first payout.', paragraphs: ['The intended payout destination is each eligible recipient’s X Money account. Creator fees are collected per coin; the payout integration, account checks, currency conversion and settlement timing are still to be connected.', 'Total paid out starts at zero. Coins on Route counts confirmed launches and registrations; fees earned is the live sum of every coin’s creator fees. The example route and capital-flow calculator are illustrations, not actual payment history.', 'When payouts are live, payment history will distinguish pending and completed transfers. Only confirmed payouts should count toward the total paid out.'] },
  { id: 'drafts', title: 'Your draft stays with you', intro: 'Make changes at your own pace.', paragraphs: ['Text fields and your recipient allocation are saved in this browser when local storage is available. Artwork stays in memory for this session and needs to be selected again after a reload.', 'Nothing is uploaded until you launch. Launching stores your artwork and token metadata on Route so pump.fun and wallets can display them. Previewing or editing a route does not reserve a token name or move any funds.'] },
];
const DOC_LABELS = { overview: 'The idea', launching: 'Launching a token', fees: 'How fees move', register: 'Registering a coin', baskets: 'Fee routes', payments: 'Payments', drafts: 'Your draft' };
function Docs() {
  return <><PageHeading title="The guide to Route.">From your first idea to your fee route.</PageHeading><div className="docs-layout"><nav className="docs-nav" aria-label="Documentation sections">{DOCS.map(doc => <a key={doc.id} href={`#${doc.id}`}>{DOC_LABELS[doc.id]}<ArrowUpRight size={13} /></a>)}</nav><div className="docs-content"><div className="docs-preview-note"><RocketLaunch size={18} /><span>Launches and registrations are live on pump.fun. Payouts to recipients are being connected.</span></div>{DOCS.map(doc => <section className="doc-section" key={doc.id} id={doc.id}><h2>{doc.title}</h2><p className="doc-intro">{doc.intro}</p>{doc.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}{doc.id === 'baskets' && <div className="doc-example"><span>Example allocation</span><Distribution /></div>}</section>)}<div className="docs-end"><h3>Ready to shape your idea?</h3><ButtonLink to="/launch">Launch a token <ArrowUpRight size={16} /></ButtonLink></div></div></div></>;
}

const ADMIN_KEY = 'route-admin-token';
const lamportsToSol = value => (value == null ? null : Number(value) / 1e9);
function Admin() {
  const [token, setToken] = useState(() => { try { return sessionStorage.getItem(ADMIN_KEY) || ''; } catch { return ''; } });
  const [entry, setEntry] = useState('');
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [mainCoin, setMainCoin] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(async current => {
    try { const next = await adminStatus(current); setStatus(next); setError(''); if (next.buyback?.mainCoin) setMainCoin(value => value || next.buyback.mainCoin); }
    catch (caught) { setError(caught.status === 403 ? 'That token is not accepted.' : caught.message); if (caught.status === 403) { setStatus(null); } }
  }, []);
  useEffect(() => { if (!token) return undefined; load(token); const timer = setInterval(() => load(token), 10_000); return () => clearInterval(timer); }, [token, load]);
  const act = async (label, fn) => { setBusy(label); setNotice(''); try { const result = await fn(); setNotice(typeof result === 'string' ? result : JSON.stringify(result)); await load(token); } catch (caught) { setNotice(caught.message); } finally { setBusy(''); } };
  if (!token) return <><PageHeading title="Route admin.">Enter the admin token to manage collection and buybacks.</PageHeading><form className="panel admin-panel" onSubmit={event => { event.preventDefault(); try { sessionStorage.setItem(ADMIN_KEY, entry.trim()); } catch { /* optional */ } setToken(entry.trim()); }}><Field label="Admin token" name="admin-token" type="password" value={entry} onChange={e => setEntry(e.target.value)} autoComplete="off" /><button className="button primary" type="submit" disabled={!entry.trim()}><Key size={17} />Open admin</button></form></>;
  const buyback = status?.buyback;
  const sol = value => value == null ? '—' : fmtSol(lamportsToSol(value));
  return <>
    <PageHeading title="Route admin." action={<button type="button" className="button secondary" onClick={() => { try { sessionStorage.removeItem(ADMIN_KEY); } catch { /* optional */ } setToken(''); setStatus(null); }}><SignOut size={16} />Lock</button>}>Collection runs every {status?.collector ? status.collector.sweepMs / 1000 : 10} seconds. Buybacks run on the same sweep once started.</PageHeading>
    {error && <div className="launch-error" role="alert"><Warning size={18} /><span>{error}</span></div>}
    {status && <div className="admin-grid">
      <section className="panel admin-panel"><div className="panel-heading"><h2>Buyback</h2><span className={`status-pill ${buyback?.enabled ? 'bonded' : 'pending'}`}>{buyback?.enabled ? 'Running' : 'Stopped'}</span></div>
        <dl className="review-details"><div><dt>Main coin</dt><dd className="mono">{buyback?.mainCoin ? shortAddress(buyback.mainCoin) : 'not set'}</dd></div><div><dt>Owed to buybacks</dt><dd className="sol">{sol(buyback?.owedLamports)}</dd></div><div><dt>Treasury balance</dt><dd className="sol">{sol(buyback?.treasuryLamports)}</dd></div><div><dt>Available now</dt><dd className="sol">{sol(buyback?.availableLamports)}</dd></div><div><dt>Spent on buybacks</dt><dd className="sol">{sol(buyback?.spentLamports)}</dd></div><div><dt>Minimum per buy</dt><dd className="sol">{sol(buyback?.minLamports)}</dd></div><div><dt>Backup</dt><dd>{buyback?.backup === 'pumpportal' ? 'PumpPortal' : 'None'}</dd></div><div><dt>Last run</dt><dd>{buyback?.lastRun ? timeAgo(buyback.lastRun) : 'never'}</dd></div></dl>
        {buyback?.lastError && <div className="launch-error" role="alert"><Warning size={18} /><span>{timeAgo(buyback.lastError.at)}: {buyback.lastError.message}</span></div>}
        <div className="admin-row"><Field label="Main coin mint" name="main-coin" value={mainCoin} placeholder="Paste the main coin's mint" onChange={e => setMainCoin(e.target.value)} autoComplete="off" spellCheck="false" /><button type="button" className="button secondary" disabled={!!busy} onClick={() => act('save', () => adminBuyback(token, { mainCoin: mainCoin.trim() || null }))}>Save</button></div>
        <div className="admin-actions">
          {buyback?.enabled ? <button type="button" className="button secondary" disabled={!!busy} onClick={() => act('stop', () => adminBuyback(token, { enabled: false }))}><Stop size={17} weight="fill" />Stop buybacks</button>
            : <button type="button" className="button primary" disabled={!!busy || !buyback?.mainCoin} onClick={() => act('start', () => adminBuyback(token, { enabled: true }))}><Play size={17} weight="fill" />Start buybacks</button>}
          <button type="button" className="button secondary" disabled={!!busy || !buyback?.mainCoin} onClick={() => act('run', () => adminBuybackRun(token))}>Buy now</button>
          <label className="admin-toggle"><input type="checkbox" checked={buyback?.backup === 'pumpportal'} disabled={!!busy} onChange={e => act('backup', () => adminBuyback(token, { backup: e.target.checked ? 'pumpportal' : 'none' }))} />PumpPortal as backup</label>
        </div>
        {buyback?.purchases?.length ? <div className="admin-list">{buyback.purchases.map(purchase => <div key={purchase.signature}><span>{timeAgo(purchase.at)}</span><span className="sol">{fmtSol(lamportsToSol(purchase.lamports))}</span><span>{purchase.venue}</span><a className="text-link" href={`https://solscan.io/tx/${purchase.signature}`} target="_blank" rel="noreferrer">tx <ArrowSquareOut size={12} /></a></div>)}</div> : <p className="admin-empty">No buybacks yet.</p>}
      </section>
      <section className="panel admin-panel"><div className="panel-heading"><h2>Collection</h2><span className="status-pill bonded">Every {status.collector ? status.collector.sweepMs / 1000 : '—'} s</span></div>
        <dl className="review-details"><div><dt>Treasury</dt><dd className="mono">{status.treasury ? shortAddress(status.treasury) : '—'}</dd></div><div><dt>Coins on Route</dt><dd>{status.coins?.coins ?? 0}</dd></div><div><dt>Collected to date</dt><dd className="sol">{sol(status.coins?.collectedLamports)}</dd></div><div><dt>GitHub</dt><dd>{status.route?.github ? `${status.route.github.login} ${status.route.github.ready ? '' : '(account missing)'}` : 'not set'}</dd></div><div><dt>Waiting in GitHub account</dt><dd className="sol">{fmtSol(status.route?.unclaimedSol)}</dd></div><div><dt>Claimed on pump.fun</dt><dd className="sol">{fmtSol(status.route?.claimedSol)}</dd></div></dl>
        <div className="admin-actions"><button type="button" className="button secondary" disabled={!!busy} onClick={() => act('sweep', () => adminSweep(token))}>Sweep now</button>{status.route?.github && !status.route.github.ready && <button type="button" className="button secondary" disabled={!!busy} onClick={() => act('setup', () => adminSetup(token))}>Create GitHub fee account</button>}</div>
      </section>
    </div>}
    {notice && <p className="admin-notice mono">{busy ? '…' : notice}</p>}
  </>;
}

function useWalletState() {
  const [wallets, setWallets] = useState(listWallets);
  const [wallet, setWallet] = useState(null);
  const [account, setAccount] = useState(null);
  const [busy, setBusy] = useState(false);
  const [launchCount, setLaunchCount] = useState(0);
  useEffect(() => onWalletsChange(() => setWallets(listWallets())), []);
  useEffect(() => {
    const name = rememberedWalletName();
    if (!name || wallet) return undefined;
    const candidate = wallets.find(entry => entry.name === name);
    if (!candidate) return undefined;
    let active = true;
    connectWallet(candidate, { silent: true }).then(next => { if (active) { setWallet(candidate); setAccount(next); } }).catch(() => {});
    return () => { active = false; };
  }, [wallets, wallet]);
  useEffect(() => {
    const events = wallet?.features['standard:events'];
    if (!events) return undefined;
    return events.on('change', ({ accounts }) => {
      if (!accounts) return;
      if (!accounts.length) { setWallet(null); setAccount(null); }
      else setAccount(accounts.find(entry => entry.chains.includes(CHAIN)) || accounts[0]);
    });
  }, [wallet]);
  const connect = async candidate => {
    setBusy(true);
    try { const next = await connectWallet(candidate); setWallet(candidate); setAccount(next); return next; }
    finally { setBusy(false); }
  };
  const disconnect = async () => { await disconnectWallet(wallet); setWallet(null); setAccount(null); };
  return { wallets, wallet, account, busy, connect, disconnect, launchCount, launched: () => setLaunchCount(count => count + 1) };
}
function WalletButton({ openChooser }) {
  const { wallet, account, disconnect } = useContext(WalletContext);
  const [copied, setCopied] = useState(false);
  const ref = useRef();
  useEffect(() => {
    const close = event => { if (ref.current && !ref.current.contains(event.target)) ref.current.open = false; };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  if (!account) return <button type="button" className="button secondary wallet-connect" onClick={openChooser} aria-label="Connect wallet"><Wallet size={17} /><span>Connect wallet</span></button>;
  return <details className="wallet-menu" ref={ref}><summary className="button secondary" aria-label={`Wallet menu for ${account.address}`}>{wallet.icon ? <img className="wallet-icon" src={wallet.icon} alt="" /> : <Wallet size={17} />}<span className="mono">{shortAddress(account.address)}</span></summary><div className="wallet-panel"><span>{wallet.name}</span><button type="button" onClick={async () => { try { await navigator.clipboard.writeText(account.address); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard optional */ } }}><Copy size={16} />{copied ? 'Copied' : 'Copy address'}</button><button type="button" onClick={() => { ref.current.open = false; disconnect(); }}><SignOut size={16} />Disconnect</button></div></details>;
}
function Modal({ open, onClose, children, labelledBy, describedBy, className = '', locked = false }) {
  const ref = useRef();
  useEffect(() => { if (open) ref.current?.showModal(); else ref.current?.close(); }, [open]);
  return <dialog className={`review-dialog ${className}`} ref={ref} onCancel={event => { if (locked) event.preventDefault(); else onClose(); }} onClose={onClose} aria-labelledby={labelledBy} aria-describedby={describedBy} onKeyDown={event => {
    if (event.key !== 'Tab') return;
    const items = [...ref.current.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]')];
    if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
  }} onClick={event => { if (!locked && event.target === ref.current) { const rect = ref.current.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}>{children}</dialog>;
}
function WalletDialog({ open, onClose, onConnected }) {
  const { wallets, busy, connect } = useContext(WalletContext);
  const [error, setError] = useState('');
  useEffect(() => { if (!open) setError(''); }, [open]);
  const choose = async wallet => {
    setError('');
    try { const account = await connect(wallet); onConnected?.(account); onClose(); }
    catch (caught) { setError(isRejection(caught) ? 'The wallet request was closed.' : caught.message); }
  };
  return <Modal open={open} onClose={onClose} labelledBy="wallet-title" describedBy="wallet-description" className="wallet-dialog"><div className="review-header"><span className="icon-tile"><Wallet size={23} /></span><button className="icon-button" onClick={onClose} aria-label="Close wallet chooser"><X size={20} /></button></div><h2 id="wallet-title">Connect a Solana wallet.</h2><p id="wallet-description">Your wallet creates the coin and pays for the launch. Route never holds your keys.</p>
    {wallets.length ? <div className="wallet-list">{wallets.map(wallet => <button type="button" className="wallet-option" key={wallet.name} disabled={busy} onClick={() => choose(wallet)}>{wallet.icon && <img src={wallet.icon} alt="" />}{wallet.name}<span>{busy ? 'Connecting…' : 'Connect'}</span></button>)}</div>
      : <div className="wallet-empty"><p>No Solana wallet was detected in this browser.</p><p>Install <a href="https://phantom.com/download" target="_blank" rel="noreferrer">Phantom</a>, <a href="https://solflare.com/download" target="_blank" rel="noreferrer">Solflare</a> or <a href="https://backpack.app/download" target="_blank" rel="noreferrer">Backpack</a>, then reload this page.</p></div>}
    {error && <div className="launch-error" role="alert"><Warning size={18} /><span>{error}</span></div>}
  </Modal>;
}

const STEPS = [['preparing', 'Preparing your coin'], ['signing', 'Confirm both transactions'], ['sending', 'Creating the coin'], ['confirming', 'Waiting for confirmation'], ['routing', 'Setting up the fee route']];
function ReviewDialog({ open, onClose, draft, image, resolve, openChooser, onLaunched }) {
  const { wallet, account } = useContext(WalletContext);
  const live = useContext(LiveContext);
  const [stage, setStage] = useState('idle');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);
  const run = useRef(0);
  const routeFlow = useRouteFlow();
  useEffect(() => { if (!open) { run.current += 1; setStage('idle'); setError(''); setResult(null); routeFlow.reset(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const payload = previewPayload(draft, window.location.origin);
  const busy = STEPS.some(([id]) => id === stage) || routeFlow.busy;
  const launch = async () => {
    const attempt = ++run.current;
    const active = () => attempt === run.current;
    setError(''); setResult(null); setStage('preparing');
    try {
      const imageData = await readAsDataUrl(image.file);
      const prepared = await prepareLaunch({ ...launchPayload(draft), image: imageData, wallet: account.address });
      if (!active()) return;
      setResult({ mint: prepared.mint });
      setStage('signing');
      const signed = await signTransactions(wallet, account, prepared.transactions.map(base64ToBytes));
      if (!active()) return;
      setStage('sending');
      const { signature } = await sendLaunch({ mint: prepared.mint, signedTransactions: signed.map(bytesToBase64) });
      if (!active()) return;
      setResult({ mint: prepared.mint, signature });
      setStage('confirming');
      for (;;) {
        await sleep(2000);
        if (!active()) return;
        const record = await getLaunch(prepared.mint);
        if (record.status === 'failed') throw new Error(record.error === 'expired' ? 'Solana did not include your launch in time. Nothing was charged. Try again.' : 'The launch failed on-chain. Nothing was created.');
        if (record.status === 'unknown') { setResult(record); setStage('unknown'); return; }
        if (record.status !== 'confirmed') continue;
        if (record.route?.status === 'active') { setResult(record); setStage('done'); live.refresh(); onLaunched?.(record); return; }
        if (['failed', 'unknown'].includes(record.route?.status)) { setResult(record); setStage('route-pending'); live.refresh(); onLaunched?.(record); return; }
        setStage('routing');
      }
    } catch (caught) {
      if (!active()) return;
      setStage('error'); setError(friendlyError(caught));
    }
  };
  const finishRoute = async () => { const coin = await routeFlow.start({ mint: result.mint }); if (coin) { setResult(coin); setStage('done'); } };
  const copyMint = async () => { try { await navigator.clipboard.writeText(result.mint); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard optional */ } };
  const stepIndex = STEPS.findIndex(([id]) => id === stage);
  const mintBlock = result?.mint && <div className="launch-address"><span className="mono">{result.mint}</span><button type="button" className="icon-button" onClick={copyMint} aria-label="Copy mint address">{copied ? <Check size={16} /> : <Copy size={16} />}</button></div>;
  return <Modal open={open} onClose={onClose} locked={busy} labelledBy="review-title" describedBy="review-description">
    <div className="review-header"><span className="icon-tile">{stage === 'done' ? <Check size={23} weight="bold" /> : <Path size={23} />}</span><button className="icon-button" onClick={onClose} aria-label="Close launch review" disabled={busy}><X size={20} /></button></div>
    {stage === 'done' ? <>
      <h2 id="review-title">Your coin is live.</h2><p id="review-description">Trading is open on pump.fun and its creator fees route to your people.</p>
      <div className="launch-result"><div className="launch-result-token">{image && <img src={image.url} alt="Token artwork" />}<div><strong>{result.name}</strong><span>${result.symbol} · {result.recipients.length} recipient{result.recipients.length === 1 ? '' : 's'}</span></div></div>
        {mintBlock}
        <div className="launch-result-links"><a className="button primary" href={result.pumpUrl} target="_blank" rel="noreferrer">View on pump.fun <ArrowSquareOut size={17} /></a><Link className="button secondary" to={`/coin/${result.mint}`}>Coin page <ArrowRight size={17} /></Link></div>
      </div>
      <button className="text-button back-to-edit" onClick={onClose}>Launch another</button>
    </> : stage === 'route-pending' ? <>
      <h2 id="review-title">Your coin is live. One more step.</h2><p id="review-description">The coin was created, but the fee route did not confirm. Sign it again to send the fees to your people.</p>
      {mintBlock}
      {routeFlow.busy && <Steps steps={ROUTE_STEPS} stage={routeFlow.stage} />}
      {routeFlow.error && <div className="launch-error" role="alert"><Warning size={18} /><span>{routeFlow.error}</span></div>}
      <div className="review-actions"><button className="button primary" type="button" onClick={finishRoute} disabled={routeFlow.busy}>{routeFlow.busy ? <CircleNotch className="spin" size={17} /> : <Path size={17} />}Finish fee route</button><Link className="text-button back-to-edit" to={`/coin/${result.mint}`}>Do it later from the coin page</Link></div>
    </> : stage === 'unknown' ? <>
      <h2 id="review-title">Still confirming.</h2><p id="review-description">Solana has not reported your launch yet. Check the mint on pump.fun before launching again.</p>
      {mintBlock}
      <div className="launch-result-links"><a className="button primary" href={`https://pump.fun/coin/${result.mint}`} target="_blank" rel="noreferrer">Check pump.fun <ArrowSquareOut size={17} /></a>{result.signature && <a className="button secondary" href={`https://solscan.io/tx/${result.signature}`} target="_blank" rel="noreferrer">Transaction <ArrowSquareOut size={17} /></a>}</div>
      <button className="text-button back-to-edit" onClick={onClose}>Back to editing</button>
    </> : <>
      <h2 id="review-title">{busy ? 'Launching your coin.' : 'Your route, ready to launch.'}</h2><p id="review-description">{busy ? 'Keep this window open until the fee route is confirmed.' : 'Check the details of your token and its recipients.'}</p>
      <div className="review-token">{image && <img src={image.url} width="56" height="56" alt="Token artwork" />}<div><strong>{payload.name}</strong><span>${payload.symbol}</span></div><PumpBadge /></div>
      {busy ? <Steps steps={STEPS} stage={stage} /> : <>
        <Distribution recipients={draft.recipients} resolve={resolve} />
        <dl className="review-details"><div><dt>Dev buy</dt><dd>{draft.devBuy} SOL</dd></div><div><dt>Website</dt><dd>{payload.website}</dd></div><div><dt>You pay</dt><dd>Dev buy + network fees</dd></div><div><dt>Wallet</dt><dd className="mono">{account ? shortAddress(account.address) : 'Not connected'}</dd></div></dl>
        <div className="review-summary"><span>Creator fees from this coin route to <strong>{draft.recipients.map(r => `@${normalizeHandle(r.handle)}`).join(', ')}</strong> in the shares above.</span><span>Your wallet confirms two transactions together: one creates the coin on pump.fun, the next locks its fee sharing to Route.</span></div>
      </>}
      {error && <div className="launch-error" role="alert"><Warning size={18} /><span>{error}</span></div>}
      <div className="review-actions">{account ? <button className="button primary" type="button" onClick={launch} disabled={busy}>{busy ? <><CircleNotch className="spin" size={17} />{STEPS[stepIndex]?.[1]}</> : error ? <><RocketLaunch size={17} />Try again</> : <><RocketLaunch size={17} />Launch on pump.fun</>}</button> : <button className="button primary" type="button" onClick={openChooser}><Wallet size={17} />Connect wallet to launch</button>}<button className="text-button back-to-edit" onClick={onClose} disabled={busy}>Back to editing</button></div>
    </>}
  </Modal>;
}

function App() {
  useEffect(() => {
    const keyboard = () => { document.documentElement.dataset.input = 'keyboard'; };
    const pointer = () => { document.documentElement.dataset.input = 'pointer'; };
    window.addEventListener('keydown', keyboard); window.addEventListener('pointerdown', pointer);
    return () => { window.removeEventListener('keydown', keyboard); window.removeEventListener('pointerdown', pointer); };
  }, []);
  const [path, setPath] = useState(window.location.pathname.replace(/\/$/, '') || '/');
  const [draft, setDraft] = useState(loadDraft);
  const [register, setRegister] = useState(loadRegisterDraft);
  const [image, setImage] = useState(null);
  const [review, setReview] = useState(false);
  const [chooser, setChooser] = useState(false);
  const walletState = useWalletState();
  const liveState = useLiveFeed();
  useEffect(() => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch {} }, [draft]);
  useEffect(() => { try { localStorage.setItem(REGISTER_KEY, JSON.stringify(register)); } catch {} }, [register]);
  useEffect(() => () => { if (image?.url) URL.revokeObjectURL(image.url); }, [image]);
  useEffect(() => { const change = () => setPath(window.location.pathname.replace(/\/$/, '') || '/'); window.addEventListener('popstate', change); return () => window.removeEventListener('popstate', change); }, []);
  const coinMint = path.startsWith('/coin/') ? path.slice(6) : null;
  const label = coinMint ? (liveState.coins[coinMint]?.name || 'Coin') : path === '/register' ? 'Register a coin' : path === '/admin' ? 'Admin' : ROUTES.find(route => route[0] === path)?.[1] || 'Page not found';
  useEffect(() => {
    document.title = `${label} | Route`;
    if (window.location.hash) requestAnimationFrame(() => document.getElementById(window.location.hash.slice(1))?.scrollIntoView());
  }, [path, label]);
  const navigate = to => {
    const url = new URL(to, window.location.origin);
    window.history.pushState({}, '', `${url.pathname}${url.hash}`);
    setPath(url.pathname.replace(/\/$/, '') || '/'); setReview(false);
    requestAnimationFrame(() => {
      if (url.hash) document.getElementById(url.hash.slice(1))?.scrollIntoView();
      else { window.scrollTo({ top: 0, behavior: 'instant' }); const heading = document.querySelector('main h1'); heading?.setAttribute('tabindex', '-1'); heading?.focus({ preventScroll: true }); }
    });
  };
  const lastLaunch = useRef(null);
  const closeReview = () => {
    setReview(false);
    // A confirmed launch starts a fresh draft; anything else keeps the user's work.
    if (lastLaunch.current) { setDraft({ ...INITIAL_DRAFT, recipients: freshRecipients() }); setImage(null); lastLaunch.current = null; }
  };
  const activeNav = coinMint ? '/payments' : path === '/register' ? '/launch' : path;
  return <NavigationContext.Provider value={navigate}><WalletContext.Provider value={walletState}><LiveContext.Provider value={liveState}><a className="skip-link" href="#main">Skip to content</a><aside className="sidebar"><Brand /><nav className="primary-nav" aria-label="Main navigation">{ROUTES.map(([to, title, Icon, shortTitle], index) => <Link key={to} to={to} className={`${activeNav === to ? 'active' : ''} ${index === 4 ? 'nav-docs' : ''}`} aria-label={title} aria-current={path === to ? 'page' : undefined}><Icon size={20} weight={activeNav === to ? 'fill' : 'regular'} /><span><span className="nav-full">{title}</span><span className="nav-short">{shortTitle}</span></span></Link>)}</nav><div className="sidebar-bottom"><div className="sidebar-footer"><span>Built on Solana</span></div></div></aside><div className="app-content"><header className="topbar"><span className="breadcrumb"><strong>{label}</strong></span><div className="topbar-actions"><WalletButton openChooser={() => setChooser(true)} /><ButtonLink to="/launch">Launch a token <ArrowUpRight size={15} /></ButtonLink></div></header><main id="main" key={path} className={`main-container page-${coinMint ? 'coin' : path.slice(1) || 'home'}`}>{path === '/' ? <Home /> : path === '/launch' ? <Launch draft={draft} setDraft={setDraft} image={image} setImage={setImage} review={() => setReview(true)} /> : path === '/register' ? <RegisterCoin register={register} setRegister={setRegister} openChooser={() => setChooser(true)} /> : path === '/admin' ? <Admin /> : coinMint ? <CoinPage mint={coinMint} openChooser={() => setChooser(true)} /> : path === '/payments' ? <Payments /> : path === '/capital-flow' ? <CapitalFlow /> : path === '/docs' ? <Docs /> : <><PageHeading title="This page isn't on the route.">The link may have moved. Head back to the overview.</PageHeading><ButtonLink to="/">Back to overview <ArrowRight size={16} /></ButtonLink></>}</main><footer className="site-footer"><span>© {new Date().getFullYear()} Route</span><span>One coin. A shared upside.</span><Link to="/docs">Documentation <ArrowUpRight size={13} /></Link></footer></div><ReviewDialog open={review} onClose={closeReview} draft={draft} image={image} resolve={resolveProfile} openChooser={() => setChooser(true)} onLaunched={record => { lastLaunch.current = record; walletState.launched(); }} /><WalletDialog open={chooser} onClose={() => setChooser(false)} /></LiveContext.Provider></WalletContext.Provider></NavigationContext.Provider>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
