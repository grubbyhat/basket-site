import React, { useContext, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowDownLeft, ArrowRight, ArrowSquareOut, ArrowUpRight, BookOpen, Check, CheckCircle, CircleNotch, Clock, Copy, FlowArrow, Globe, House, ImageSquare, Info, LockSimple, Path, Plus, Receipt, RocketLaunch, ShieldCheck, SignOut, Trash, UsersThree, Wallet, Warning, X } from '@phosphor-icons/react';
import '@fontsource-variable/ibm-plex-sans';
import { EXAMPLE_BASKET, IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_RECIPIENTS, launchPayload, normalizeHandle, previewPayload, splitEvenly, toBasisPoints, validateBasket, validateDraft } from './basket.js';
import { CapitalScene, PayoutPreview } from './motion.jsx';
import { base64ToBytes, bytesToBase64, getLaunch, getStats, listLaunches, lookupX, prepareLaunch, readAsDataUrl, sendLaunch } from './api.js';
import { CHAIN, connectWallet, disconnectWallet, isRejection, listWallets, onWalletsChange, rememberedWalletName, shortAddress, signTransaction } from './wallet.js';
import './styles.css';
import './product-theme.css';
import './live.css';

const ROUTES = [
  ['/', 'Overview', House, 'Home'], ['/launch', 'Launch a token', RocketLaunch, 'Launch'],
  ['/payments', 'Payments', Receipt, 'Payments'], ['/capital-flow', 'Capital flow', FlowArrow, 'Flow'], ['/docs', 'Documentation', BookOpen, 'Docs'],
];
const DRAFT_KEY = 'basket-launch-draft-v1';
const INITIAL_DRAFT = { name: '', ticker: '', description: '', twitter: '', devBuy: '0', recipients: [{ id: 'first', handle: '', share: '100' }] };
const HANDLE_PATTERN = /^[a-z0-9_]{1,15}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function loadDraft() {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY));
    if (saved && ['name', 'ticker', 'description', 'twitter', 'devBuy'].every(key => typeof saved[key] === 'string') && Array.isArray(saved.recipients) && saved.recipients.length >= 1 && saved.recipients.length <= 5 && saved.recipients.every(r => typeof r.handle === 'string' && typeof r.share === 'string' && typeof r.id === 'string')) return saved;
  } catch { /* Storage is optional; the editor remains usable. */ }
  return INITIAL_DRAFT;
}
function timeAgo(iso) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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

const NavigationContext = React.createContext(null);
const WalletContext = React.createContext(null);
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
  const [stats, setStats] = useState({ launched: 0, recipients: 0, paidOutCents: 0 });
  useEffect(() => { let active = true; getStats().then(next => { if (active) setStats(next); }).catch(() => {}); return () => { active = false; }; }, [refreshKey]);
  return stats;
}
function Metrics({ large = false }) {
  const stats = useStats(useContext(WalletContext)?.launchCount);
  return <dl className={`metrics ${large ? 'metrics-large' : ''}`}>
    <div><dt>Total paid out</dt><dd><span className="currency">$</span>{Math.floor(stats.paidOutCents / 100)}<span className="decimals">.{String(stats.paidOutCents % 100).padStart(2, '0')}</span></dd></div>
    <div><dt>Tokens launched</dt><dd>{stats.launched}</dd></div>
    <div><dt>Recipients paid</dt><dd>0</dd></div>
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
    <div className="distribution-list">{recipients.map((r, i) => <div className="distribution-person" key={r.id}><Avatar index={i} handle={r.handle} small={small} profile={resolve(r.handle)?.profile} /><span>{normalizeHandle(r.handle) ? `@${normalizeHandle(r.handle)}` : `Recipient ${i + 1}`}</span><strong>{r.share || '0'}<span>%</span></strong></div>)}</div>
  </div>;
}

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
function RecipientStatus({ handle, lookup }) {
  const normalized = normalizeHandle(handle);
  if (!normalized || !HANDLE_PATTERN.test(normalized) || !lookup) return <p className="recipient-meta" />;
  if (lookup.status === 'loading') return <p className="recipient-meta"><CircleNotch className="spin" size={15} />Checking X…</p>;
  if (lookup.status === 'ok') return <p className="recipient-meta verified"><ShieldCheck size={15} weight="fill" /><strong>{lookup.profile.name || `@${lookup.profile.handle}`}</strong>found on X</p>;
  if (lookup.status === 'missing') return <p className="recipient-meta missing"><Warning size={15} />We couldn’t find @{normalized} on X.</p>;
  return <p className="recipient-meta"><Info size={15} />X lookup is unavailable right now. Recipients are verified again at launch.</p>;
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
  const basket = validateBasket(draft.recipients);
  const resolve = useProfiles(draft.recipients.map(recipient => normalizeHandle(recipient.handle)));
  const update = (name, value) => { setDraft(current => ({ ...current, [name]: value })); setErrors(current => ({ ...current, [name]: undefined })); };
  const updateRecipient = (index, key, value) => {
    setDraft(current => ({ ...current, recipients: current.recipients.map((recipient, i) => i === index ? { ...recipient, [key]: value } : recipient) }));
    setErrors(current => ({ ...current, [`${key}-${index}`]: undefined, basket: undefined }));
  };
  const addRecipient = () => {
    if (draft.recipients.length >= MAX_RECIPIENTS) return;
    const remaining = Math.max(0, 10000 - basket.totalBps) / 100;
    update('recipients', [...draft.recipients, { id: crypto.randomUUID(), handle: '', share: String(remaining) }]);
    setErrors({});
    requestAnimationFrame(() => document.getElementById(`handle-${draft.recipients.length}`)?.focus());
  };
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
    const result = validateDraft(draft, image);
    const nextErrors = { ...result.errors };
    draft.recipients.forEach((recipient, index) => { if (!nextErrors[`handle-${index}`] && resolve(recipient.handle)?.status === 'missing') nextErrors[`handle-${index}`] = `We couldn’t find @${normalizeHandle(recipient.handle)} on X. Check the spelling.`; });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) { if (nextErrors.twitter) formRef.current.querySelector('.social-fields').open = true; requestAnimationFrame(() => formRef.current?.querySelector('[aria-invalid="true"]')?.focus()); return; }
    review();
  };
  return <>
    <PageHeading title="Launch a coin. Share the fees.">Pick your people, set the split, and make it yours.</PageHeading>
    <div className="launch-layout">
      <form className="launch-form" ref={formRef} onSubmit={submit} noValidate>
        <section className="form-section">
          <div className="launch-form-heading"><h2>Launch token</h2><PumpBadge /></div>
          <div className="form-section-title"><h3>Your fee route</h3><span className="count-badge">{draft.recipients.length} of 5</span></div>
          <p className="section-description">Choose who gets a share of the recipient pool.</p>
          <div className="recipient-list">{draft.recipients.map((recipient, index) => { const lookup = resolve(recipient.handle); return <div className="recipient-block" key={recipient.id}>
            <div className="recipient-row"><span className="recipient-avatar"><Avatar handle={recipient.handle} index={index} profile={lookup?.profile} />{lookup?.status === 'ok' && <span className="avatar-badge" aria-hidden="true"><Check size={11} weight="bold" /></span>}{lookup?.status === 'loading' && <span className="avatar-badge pending" aria-hidden="true"><CircleNotch className="spin" size={11} /></span>}{lookup?.status === 'missing' && <span className="avatar-badge missing" aria-hidden="true"><X size={11} weight="bold" /></span>}</span>
              <div className="recipient-handle field"><label htmlFor={`handle-${index}`}>X account {index + 1}</label><div className="input-prefix"><span aria-hidden="true">@</span><input id={`handle-${index}`} value={recipient.handle} onChange={e => updateRecipient(index, 'handle', e.target.value)} onBlur={() => { const normalized = normalizeHandle(recipient.handle); if (normalized) updateRecipient(index, 'handle', normalized); }} placeholder="username" autoComplete="off" spellCheck="false" aria-invalid={!!errors[`handle-${index}`]} aria-describedby={errors[`handle-${index}`] ? `handle-${index}-error` : `handle-${index}-status`} /></div></div>
              <div className="recipient-share field"><label htmlFor={`share-${index}`}>Share</label><div className="input-suffix"><input id={`share-${index}`} value={recipient.share} onChange={e => updateRecipient(index, 'share', e.target.value)} inputMode="decimal" aria-invalid={!!errors[`share-${index}`]} aria-describedby={errors[`share-${index}`] ? `share-${index}-error` : undefined} /><span aria-hidden="true">%</span></div></div>
              <button className="icon-button remove-recipient" type="button" disabled={draft.recipients.length === 1} aria-label={`Remove recipient ${index + 1}`} onClick={() => { update('recipients', draft.recipients.filter(r => r.id !== recipient.id)); setErrors({}); }}><Trash size={19} /></button>
            </div><div id={`handle-${index}-status`}><RecipientStatus handle={recipient.handle} lookup={lookup} /></div><FieldError id={`handle-${index}-error`}>{errors[`handle-${index}`]}</FieldError><FieldError id={`share-${index}-error`}>{errors[`share-${index}`]}</FieldError>
          </div>; })}</div>
          <div className="basket-controls"><button type="button" className="button secondary small-button" onClick={addRecipient} disabled={draft.recipients.length >= MAX_RECIPIENTS}><Plus size={17} />Add recipient</button><button type="button" className="text-button" onClick={() => { update('recipients', splitEvenly(draft.recipients)); setErrors({}); }}>Split evenly</button></div>
          <div className={`allocation-total ${basket.totalBps === 10000 ? 'complete' : 'incomplete'}`}><span>{basket.totalBps === 10000 ? <CheckCircle size={18} /> : <Info size={18} />}<span>{basket.totalBps === 10000 ? 'Fully allocated' : 'Shares must total 100%'}</span></span><strong>{basket.totalBps / 100}%</strong></div><FieldError id="basket-error">{errors.basket}</FieldError>
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

function LaunchedTokens() {
  const { launchCount } = useContext(WalletContext);
  const [launches, setLaunches] = useState(null);
  useEffect(() => { let active = true; listLaunches({ limit: 50 }).then(body => { if (active) setLaunches(body.launches || []); }).catch(() => { if (active) setLaunches([]); }); return () => { active = false; }; }, [launchCount]);
  return <section className="panel payments-ledger"><div className="panel-heading"><h2>Coins launched</h2><span className="count-badge">{launches ? `${launches.length} coin${launches.length === 1 ? '' : 's'}` : '…'}</span></div>
    <div className="launched-list">{launches?.length ? launches.map(launch => <div className="launched-row" key={launch.mint}><img src={launch.imageUrl} alt="" loading="lazy" /><div><strong>{launch.name} <span className="mono">${launch.symbol}</span></strong><span>by <span className="mono">{shortAddress(launch.wallet)}</span> · {timeAgo(launch.confirmedAt || launch.createdAt)}</span></div><div className="launched-people">{launch.recipients.map((recipient, index) => <Avatar key={recipient.xId} index={index} handle={recipient.handle} profile={recipient} />)}<span>{launch.recipients.length === 1 ? `@${launch.recipients[0].handle}` : `${launch.recipients.length} recipients`}</span></div><a className="button secondary small-button" href={launch.pumpUrl} target="_blank" rel="noreferrer">pump.fun <ArrowSquareOut size={15} /></a></div>) : launches ? <div className="quiet-empty" style={{ padding: '31px 28px 32px' }}><RocketLaunch size={23} /><div><h3>No coins launched yet</h3><p>Every coin launched through Route appears here with its fee route.</p></div></div> : null}</div>
  </section>;
}
function Payments() {
  const [filter, setFilter] = useState('All payments');
  return <><PageHeading title="Every payment, in the open.">A record of the people paid and the coins behind them.</PageHeading><Metrics large /><LaunchedTokens /><section className="panel payments-ledger" style={{ marginTop: 24 }}><div className="panel-heading"><h2>Payment history</h2><span className="count-badge">0 payments</span></div><div className="payment-toolbar"><div className="segmented-control" aria-label="Payment status">{['All payments', 'Completed', 'Pending'].map(item => <button key={item} type="button" aria-pressed={item === filter} onClick={() => setFilter(item)}>{item}</button>)}</div><span>Amounts in USD</span></div><div className="ledger-columns" aria-hidden="true"><span>Recipient / token</span><span>Amount</span><span>Status</span><span>Date</span></div><div role="status"><EmptyState title={filter === 'Pending' ? 'Nothing waiting in the wings.' : filter === 'Completed' ? 'No completed payments yet.' : 'A clean slate. A shared future.'} description={filter === 'Pending' ? 'Pending payouts will be listed here when payments are enabled.' : 'When payouts begin, each confirmed payment will have a place here.'} /></div><div className="panel-foot"><span><LockSimple size={13} /> Payouts are being connected</span><Link to="/docs#payments" className="text-link">About payments <ArrowUpRight size={14} /></Link></div></section></>;
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
  { id: 'overview', title: 'A little coin. A bigger circle.', intro: 'Route is a way to launch a pump.fun token with creator fees shared between the people you choose.', paragraphs: ['Instead of choosing one recipient, route the fees to up to five X accounts. Set a percentage for each person and review the complete allocation before launch.', 'Launches are live. Connect a Solana wallet, build your route and create the coin on pump.fun in a single transaction that you confirm in your wallet. Creator fees accrue to Route on behalf of your recipients; the conversion to dollars and the X Money payout are still being connected.'] },
  { id: 'launching', title: 'Create your token', intro: 'Keep the idea simple. Make the details your own.', paragraphs: ['Add your token’s name, ticker and image. A description and an X profile or post link are optional. The website field automatically uses this site’s homepage.', 'Set an optional dev buy in SOL, or leave it at zero. The launch flow is designed for a single creator wallet. Bundle buys are not offered.', 'Review launch checks your draft, verifies every recipient on X and opens a summary. Launch on pump.fun asks your wallet to confirm one transaction that creates the coin and includes your dev buy. Your wallet pays the dev buy and the Solana network fees; Route charges no launch fee today.'] },
  { id: 'baskets', title: 'Build your fee route', intro: 'Your recipients. Your allocation.', paragraphs: ['Add between one and five unique X handles. You can also paste an X or Twitter profile link. Each share must be greater than zero and all shares must total exactly 100%.', 'Shares support two decimal places. Split evenly divides the allocation and assigns any remaining hundredth of a percent to the first recipients, so the total stays exact.', 'When you enter a handle, Route looks the account up on X and shows its name and picture. Each launch keeps the account’s numeric X ID, so a later username change never redirects a payout. This does not prove account ownership or X Money eligibility. These percentages refer to the recipient pool, not to the token supply; final service fees and conversion costs are not set yet.'] },
  { id: 'payments', title: 'Payments and receipts', intro: 'A clear record from the very first payout.', paragraphs: ['The intended payout destination is each eligible recipient’s X Money account. Creator fees are collected per coin; the payout integration, account checks, currency conversion and settlement timing are still to be connected.', 'Total paid out and recipients paid start at zero. Tokens launched counts confirmed launches. The example route and capital-flow calculator are illustrations, not actual payment history.', 'When payouts are live, payment history will distinguish pending and completed transfers. Only confirmed payouts should count toward the total paid out.'] },
  { id: 'drafts', title: 'Your draft stays with you', intro: 'Make changes at your own pace.', paragraphs: ['Text fields and your recipient allocation are saved in this browser when local storage is available. Artwork stays in memory for this session and needs to be selected again after a reload.', 'Nothing is uploaded until you launch. Launching stores your artwork and token metadata on Route so pump.fun and wallets can display them. Previewing or editing a route does not reserve a token name or move any funds.'] },
];
function Docs() {
  return <><PageHeading title="The guide to Route.">From your first idea to your fee route.</PageHeading><div className="docs-layout"><nav className="docs-nav" aria-label="Documentation sections">{DOCS.map(doc => <a key={doc.id} href={`#${doc.id}`}>{({ overview: 'The idea', launching: 'Launching a token', baskets: 'Fee routes', payments: 'Payments', drafts: 'Your draft' })[doc.id]}<ArrowUpRight size={13} /></a>)}</nav><div className="docs-content"><div className="docs-preview-note"><RocketLaunch size={18} /><span>Launches are live on pump.fun. Payouts to recipients are being connected.</span></div>{DOCS.map(doc => <section className="doc-section" key={doc.id} id={doc.id}><h2>{doc.title}</h2><p className="doc-intro">{doc.intro}</p>{doc.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}{doc.id === 'baskets' && <div className="doc-example"><span>Example allocation</span><Distribution /></div>}</section>)}<div className="docs-end"><h3>Ready to shape your idea?</h3><ButtonLink to="/launch">Launch a token <ArrowUpRight size={16} /></ButtonLink></div></div></div></>;
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

const STEPS = [['preparing', 'Preparing your coin'], ['signing', 'Confirm in your wallet'], ['sending', 'Sending to Solana'], ['confirming', 'Waiting for confirmation']];
function friendlyError(error) {
  if (isRejection(error) && !error.status) return 'You closed the wallet prompt. Nothing was sent.';
  return error.message || 'Something went wrong. Nothing was charged.';
}
function ReviewDialog({ open, onClose, draft, image, resolve, openChooser, onLaunched }) {
  const { wallet, account } = useContext(WalletContext);
  const [stage, setStage] = useState('idle');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);
  const run = useRef(0);
  useEffect(() => { if (!open) { run.current += 1; setStage('idle'); setError(''); setResult(null); } }, [open]);
  const payload = previewPayload(draft, window.location.origin);
  const busy = STEPS.some(([id]) => id === stage);
  const launch = async () => {
    const attempt = ++run.current;
    const live = () => attempt === run.current;
    setError(''); setResult(null); setStage('preparing');
    try {
      const imageData = await readAsDataUrl(image.file);
      const prepared = await prepareLaunch({ ...launchPayload(draft), image: imageData, wallet: account.address });
      if (!live()) return;
      setResult({ mint: prepared.mint });
      setStage('signing');
      const signed = await signTransaction(wallet, account, base64ToBytes(prepared.transaction));
      if (!live()) return;
      setStage('sending');
      const { signature } = await sendLaunch({ mint: prepared.mint, signedTransaction: bytesToBase64(signed) });
      if (!live()) return;
      setResult({ mint: prepared.mint, signature });
      setStage('confirming');
      for (;;) {
        await sleep(2000);
        if (!live()) return;
        const record = await getLaunch(prepared.mint);
        if (record.status === 'confirmed') { setResult(record); setStage('done'); onLaunched?.(record); return; }
        if (record.status === 'failed') throw new Error(record.error === 'expired' ? 'Solana did not include your launch in time. Nothing was charged. Try again.' : 'The launch failed on-chain. Nothing was created.');
        if (record.status === 'unknown') { setResult(record); setStage('unknown'); return; }
      }
    } catch (caught) {
      if (!live()) return;
      setStage('error'); setError(friendlyError(caught));
    }
  };
  const copyMint = async () => { try { await navigator.clipboard.writeText(result.mint); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard optional */ } };
  const stepIndex = STEPS.findIndex(([id]) => id === stage);
  return <Modal open={open} onClose={onClose} locked={busy} labelledBy="review-title" describedBy="review-description">
    <div className="review-header"><span className="icon-tile">{stage === 'done' ? <Check size={23} weight="bold" /> : <Path size={23} />}</span><button className="icon-button" onClick={onClose} aria-label="Close launch review" disabled={busy}><X size={20} /></button></div>
    {stage === 'done' ? <>
      <h2 id="review-title">Your coin is live.</h2><p id="review-description">Trading is open on pump.fun. Creator fees now route to your recipients.</p>
      <div className="launch-result"><div className="launch-result-token">{image && <img src={image.url} alt="Token artwork" />}<div><strong>{result.name}</strong><span>${result.symbol} · {result.recipients.length} recipient{result.recipients.length === 1 ? '' : 's'}</span></div></div>
        <div className="launch-address"><span className="mono">{result.mint}</span><button type="button" className="icon-button" onClick={copyMint} aria-label="Copy mint address">{copied ? <Check size={16} /> : <Copy size={16} />}</button></div>
        <div className="launch-result-links"><a className="button primary" href={result.pumpUrl} target="_blank" rel="noreferrer">View on pump.fun <ArrowSquareOut size={17} /></a><a className="button secondary" href={`https://solscan.io/tx/${result.signature}`} target="_blank" rel="noreferrer">Transaction <ArrowSquareOut size={17} /></a></div>
      </div>
      <button className="text-button back-to-edit" onClick={onClose}>Launch another</button>
    </> : stage === 'unknown' ? <>
      <h2 id="review-title">Still confirming.</h2><p id="review-description">Solana has not reported your launch yet. Check the mint on pump.fun before launching again.</p>
      <div className="launch-address"><span className="mono">{result.mint}</span><button type="button" className="icon-button" onClick={copyMint} aria-label="Copy mint address">{copied ? <Check size={16} /> : <Copy size={16} />}</button></div>
      <div className="launch-result-links"><a className="button primary" href={`https://pump.fun/coin/${result.mint}`} target="_blank" rel="noreferrer">Check pump.fun <ArrowSquareOut size={17} /></a>{result.signature && <a className="button secondary" href={`https://solscan.io/tx/${result.signature}`} target="_blank" rel="noreferrer">Transaction <ArrowSquareOut size={17} /></a>}</div>
      <button className="text-button back-to-edit" onClick={onClose}>Back to editing</button>
    </> : <>
      <h2 id="review-title">{busy ? 'Launching your coin.' : 'Your route, ready to launch.'}</h2><p id="review-description">{busy ? 'Keep this window open until the launch is confirmed.' : 'Check the details of your token and its recipients.'}</p>
      <div className="review-token">{image && <img src={image.url} width="56" height="56" alt="Token artwork" />}<div><strong>{payload.name}</strong><span>${payload.symbol}</span></div><PumpBadge /></div>
      {busy ? <div className="launch-steps" aria-live="polite">{STEPS.map(([id, label], index) => <div className={`launch-step ${index < stepIndex ? 'done' : index === stepIndex ? 'active' : ''}`} key={id}><span>{index < stepIndex ? <Check size={13} weight="bold" /> : index === stepIndex ? <CircleNotch className="spin" size={14} /> : index + 1}</span>{label}</div>)}</div> : <>
        <Distribution recipients={draft.recipients} resolve={resolve} />
        <dl className="review-details"><div><dt>Dev buy</dt><dd>{draft.devBuy} SOL</dd></div><div><dt>Website</dt><dd>{payload.website}</dd></div><div><dt>You pay</dt><dd>Dev buy + network fees</dd></div><div><dt>Wallet</dt><dd className="mono">{account ? shortAddress(account.address) : 'Not connected'}</dd></div></dl>
        <div className="review-summary"><span>Creator fees from this coin accrue to Route for <strong>{draft.recipients.map(r => `@${normalizeHandle(r.handle)}`).join(', ')}</strong> in the shares above.</span><span>One transaction creates the coin on pump.fun. Your wallet shows the exact cost before you confirm.</span></div>
      </>}
      {error && <div className="launch-error" role="alert"><Warning size={18} /><span>{error}</span></div>}
      <div className="review-actions">{account ? <button className="button primary" type="button" onClick={launch} disabled={busy}>{busy ? <><CircleNotch className="spin" size={17} />{STEPS[stepIndex][1]}</> : error ? <><RocketLaunch size={17} />Try again</> : <><RocketLaunch size={17} />Launch on pump.fun</>}</button> : <button className="button primary" type="button" onClick={openChooser}><Wallet size={17} />Connect wallet to launch</button>}<button className="text-button back-to-edit" onClick={onClose} disabled={busy}>Back to editing</button></div>
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
  const [image, setImage] = useState(null);
  const [review, setReview] = useState(false);
  const [chooser, setChooser] = useState(false);
  const walletState = useWalletState();
  const resolve = handle => profileCache.get(normalizeHandle(handle)) || null;
  useEffect(() => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch {} }, [draft]);
  useEffect(() => () => { if (image?.url) URL.revokeObjectURL(image.url); }, [image]);
  useEffect(() => { const change = () => setPath(window.location.pathname.replace(/\/$/, '') || '/'); window.addEventListener('popstate', change); return () => window.removeEventListener('popstate', change); }, []);
  useEffect(() => {
    const label = ROUTES.find(route => route[0] === path)?.[1] || 'Page not found';
    document.title = `${label} | Route`;
    if (window.location.hash) requestAnimationFrame(() => document.getElementById(window.location.hash.slice(1))?.scrollIntoView());
  }, [path]);
  const navigate = to => {
    const url = new URL(to, window.location.origin);
    window.history.pushState({}, '', `${url.pathname}${url.hash}`);
    setPath(url.pathname); setReview(false);
    requestAnimationFrame(() => {
      if (url.hash) document.getElementById(url.hash.slice(1))?.scrollIntoView();
      else { window.scrollTo({ top: 0, behavior: 'instant' }); const heading = document.querySelector('main h1'); heading?.setAttribute('tabindex', '-1'); heading?.focus({ preventScroll: true }); }
    });
  };
  const lastLaunch = useRef(null);
  const closeReview = () => {
    setReview(false);
    // A confirmed launch starts a fresh draft; anything else keeps the user's work.
    if (lastLaunch.current) { setDraft({ ...INITIAL_DRAFT, recipients: [{ id: crypto.randomUUID(), handle: '', share: '100' }] }); setImage(null); lastLaunch.current = null; }
  };
  const label = ROUTES.find(route => route[0] === path)?.[1] || 'Page not found';
  return <NavigationContext.Provider value={navigate}><WalletContext.Provider value={walletState}><a className="skip-link" href="#main">Skip to content</a><aside className="sidebar"><Brand /><nav className="primary-nav" aria-label="Main navigation">{ROUTES.map(([to, title, Icon, shortTitle], index) => <Link key={to} to={to} className={`${path === to ? 'active' : ''} ${index === 4 ? 'nav-docs' : ''}`} aria-label={title} aria-current={path === to ? 'page' : undefined}><Icon size={20} weight={path === to ? 'fill' : 'regular'} /><span><span className="nav-full">{title}</span><span className="nav-short">{shortTitle}</span></span></Link>)}</nav><div className="sidebar-bottom"><div className="sidebar-footer"><span>Built on Solana</span></div></div></aside><div className="app-content"><header className="topbar"><span className="breadcrumb"><strong>{label}</strong></span><div className="topbar-actions"><WalletButton openChooser={() => setChooser(true)} /><ButtonLink to="/launch">Launch a token <ArrowUpRight size={15} /></ButtonLink></div></header><main id="main" key={path} className={`main-container page-${path.slice(1) || 'home'}`}>{path === '/' ? <Home /> : path === '/launch' ? <Launch draft={draft} setDraft={setDraft} image={image} setImage={setImage} review={() => setReview(true)} /> : path === '/payments' ? <Payments /> : path === '/capital-flow' ? <CapitalFlow /> : path === '/docs' ? <Docs /> : <><PageHeading title="This page isn't on the route.">The link may have moved. Head back to the overview.</PageHeading><ButtonLink to="/">Back to overview <ArrowRight size={16} /></ButtonLink></>}</main><footer className="site-footer"><span>© {new Date().getFullYear()} Route</span><span>One coin. A shared upside.</span><Link to="/docs">Documentation <ArrowUpRight size={13} /></Link></footer></div><ReviewDialog open={review} onClose={closeReview} draft={draft} image={image} resolve={resolve} openChooser={() => setChooser(true)} onLaunched={record => { lastLaunch.current = record; walletState.launched(); }} /><WalletDialog open={chooser} onClose={() => setChooser(false)} /></WalletContext.Provider></NavigationContext.Provider>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
