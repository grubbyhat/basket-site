import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Basket, BookOpen, CheckCircle, CircleNotch, Clock, Cube, FlowArrow, Globe, House, ImageSquare, Info, LockSimple, Moon, Plus, Receipt, RocketLaunch, Sun, Trash, UsersThree, Wallet, X, XLogo } from '@phosphor-icons/react';
import '@fontsource-variable/geist';
import { EXAMPLE_BASKET, IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_RECIPIENTS, normalizeHandle, previewPayload, splitEvenly, toBasisPoints, validateBasket, validateDraft } from './basket.js';
import { CapitalScene, PayoutPreview } from './motion.jsx';
import './styles.css';
import './product-theme.css';

const ROUTES = [
  ['/', 'Overview', House, 'Home'], ['/launch', 'Launch a token', RocketLaunch, 'Launch'],
  ['/payments', 'Payments', Receipt, 'Payments'], ['/capital-flow', 'Capital flow', FlowArrow, 'Flow'], ['/docs', 'Documentation', BookOpen, 'Docs'],
];
const DRAFT_KEY = 'basket-launch-draft-v1';
const INITIAL_DRAFT = { name: '', ticker: '', description: '', twitter: '', devBuy: '0', recipients: [{ id: 'first', handle: '', share: '100' }] };
function loadDraft() {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY));
    if (saved && ['name', 'ticker', 'description', 'twitter', 'devBuy'].every(key => typeof saved[key] === 'string') && Array.isArray(saved.recipients) && saved.recipients.length >= 1 && saved.recipients.length <= 5 && saved.recipients.every(r => typeof r.handle === 'string' && typeof r.share === 'string' && typeof r.id === 'string')) return saved;
  } catch { /* Storage is optional; the editor remains usable. */ }
  return INITIAL_DRAFT;
}

const NavigationContext = React.createContext(null);
function Link({ to, children, onClick, ...props }) {
  const navigate = React.useContext(NavigationContext);
  return <a href={to} {...props} onClick={event => {
    onClick?.(event);
    if (!event.defaultPrevented && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
      event.preventDefault(); navigate(to);
    }
  }}>{children}</a>;
}
function Brand({ compact = false }) {
  return <Link to="/" className="brand" aria-label="Basket overview"><span className="brand-mark"><Basket size={24} weight="bold" /></span>{!compact && <span>basket<span className="brand-period">.</span></span>}</Link>;
}
function PumpBadge() { return <span className="pump-badge"><span className="pump-symbol" aria-hidden="true" />pump.fun</span>; }
function ButtonLink({ to, children, secondary = false, className = '' }) { return <Link to={to} className={`button ${secondary ? 'secondary' : 'primary'} ${className}`}>{children}</Link>; }
function EmptyState({ title = 'The first payment starts here.', description = 'Confirmed payments will appear here once payouts are live.', compact = false }) {
  return <div className={`empty-state ${compact ? 'compact' : ''}`}><div className="empty-visual" aria-hidden="true"><span /><span /><div><ArrowDownLeft size={24} /></div></div><h3>{title}</h3><p>{description}</p><Link to="/launch" className="text-link">Build your basket <ArrowUpRight size={15} /></Link></div>;
}
function Metrics({ large = false }) {
  return <dl className={`metrics ${large ? 'metrics-large' : ''}`}>
    <div><dt>Total paid out</dt><dd><span className="currency">$</span>0<span className="decimals">.00</span></dd></div>
    <div><dt>Tokens launched</dt><dd>0</dd></div>
    <div><dt>Recipients paid</dt><dd>0</dd></div>
  </dl>;
}
function Avatar({ index = 0, handle, small = false }) {
  return <span className={`avatar avatar-${index % 5} ${small ? 'small' : ''}`} aria-hidden="true">{normalizeHandle(handle).slice(0, 1).toUpperCase() || String(index + 1)}</span>;
}
function Distribution({ recipients = EXAMPLE_BASKET, small = false }) {
  const valid = recipients.every(r => toBasisPoints(r.share) !== null);
  return <div className={`distribution ${small ? 'small' : ''}`}>
    <div className="allocation-strip" aria-hidden="true">{recipients.map((r, i) => <span className={`allocation-${i}`} key={r.id} style={{ flexGrow: valid ? (toBasisPoints(r.share) || 0) : 1 }} />)}</div>
    <div className="distribution-list">{recipients.map((r, i) => <div className="distribution-person" key={r.id}><Avatar index={i} handle={r.handle} small={small} /><span>{normalizeHandle(r.handle) ? `@${normalizeHandle(r.handle)}` : `Recipient ${i + 1}`}</span><strong>{r.share || '0'}<span>%</span></strong></div>)}</div>
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
    <div className="basket-example-controls"><span>Example basket</span><div className="segmented-control" aria-label="Example recipient count">{[3, 5].map(value => <button key={value} type="button" aria-pressed={value === count} onClick={() => setCount(value)}>{value} people</button>)}</div></div>
    <Distribution recipients={people} />
    <div className="panel-foot"><Link to="/launch" className="text-link">Build your basket <ArrowUpRight size={18} /></Link></div>
  </div>;
}
function Home() {
  return <>
    <section className="hero">
      <div className="hero-copy">
        <h1>One coin.<br /><span>A shared upside.</span></h1>
        <p>Launch on pump.fun. Share creator fees with up to five people through X Money.</p>
        <div className="hero-actions"><ButtonLink to="/launch">Launch a token <ArrowUpRight size={20} /></ButtonLink><Link className="text-link" to="/docs">How it works <ArrowRight size={19} /></Link></div>
      </div>
      <div className="hero-art"><img src="/basket-sculpture.webp" srcSet="/basket-sculpture-small.webp 360w, /basket-sculpture.webp 720w" sizes="(max-width: 767px) 310px, (max-width: 1199px) 335px, 440px" alt="A sculptural silver basket holding three coins" width="720" height="720" fetchPriority="high" /></div>
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
    setErrors(result.errors);
    if (!result.valid) { if (result.errors.twitter) formRef.current.querySelector('.social-fields').open = true; requestAnimationFrame(() => formRef.current?.querySelector('[aria-invalid="true"]')?.focus()); return; }
    review();
  };
  return <>
    <PageHeading title="Launch a coin. Share the fees.">Pick your people, set the split, and make it yours.</PageHeading>
    <div className="launch-layout">
      <form className="launch-form" ref={formRef} onSubmit={submit} noValidate>
        <section className="form-section">
          <div className="launch-form-heading"><h2>Launch token</h2><PumpBadge /></div>
          <div className="form-section-title"><h3>Your fee basket</h3><span className="count-badge">{draft.recipients.length} of 5</span></div>
          <p className="section-description">Choose who gets a share of the recipient pool.</p>
          <div className="recipient-list">{draft.recipients.map((recipient, index) => <div className="recipient-block" key={recipient.id}>
            <div className="recipient-row"><Avatar handle={recipient.handle} index={index} />
              <div className="recipient-handle field"><label htmlFor={`handle-${index}`}>X account {index + 1}</label><div className="input-prefix"><span aria-hidden="true">@</span><input id={`handle-${index}`} value={recipient.handle} onChange={e => updateRecipient(index, 'handle', e.target.value)} onBlur={() => { const normalized = normalizeHandle(recipient.handle); if (normalized) updateRecipient(index, 'handle', normalized); }} placeholder="username" autoComplete="off" spellCheck="false" aria-invalid={!!errors[`handle-${index}`]} aria-describedby={errors[`handle-${index}`] ? `handle-${index}-error` : undefined} /></div></div>
              <div className="recipient-share field"><label htmlFor={`share-${index}`}>Share</label><div className="input-suffix"><input id={`share-${index}`} value={recipient.share} onChange={e => updateRecipient(index, 'share', e.target.value)} inputMode="decimal" aria-invalid={!!errors[`share-${index}`]} aria-describedby={errors[`share-${index}`] ? `share-${index}-error` : undefined} /><span aria-hidden="true">%</span></div></div>
              <button className="icon-button remove-recipient" type="button" disabled={draft.recipients.length === 1} aria-label={`Remove recipient ${index + 1}`} onClick={() => { update('recipients', draft.recipients.filter(r => r.id !== recipient.id)); setErrors({}); }}><Trash size={19} /></button>
            </div><FieldError id={`handle-${index}-error`}>{errors[`handle-${index}`]}</FieldError><FieldError id={`share-${index}-error`}>{errors[`share-${index}`]}</FieldError>
          </div>)}</div>
          <div className="basket-controls"><button type="button" className="button secondary small-button" onClick={addRecipient} disabled={draft.recipients.length >= MAX_RECIPIENTS}><Plus size={17} />Add recipient</button><button type="button" className="text-button" onClick={() => { update('recipients', splitEvenly(draft.recipients)); setErrors({}); }}>Split evenly</button></div>
          <div className={`allocation-total ${basket.totalBps === 10000 ? 'complete' : 'incomplete'}`}><span>{basket.totalBps === 10000 ? <CheckCircle size={18} /> : <Info size={18} />}<span>{basket.totalBps === 10000 ? 'Fully allocated' : 'Shares must total 100%'}</span></span><strong>{basket.totalBps / 100}%</strong></div><FieldError id="basket-error">{errors.basket}</FieldError>
        </section>
        <section className="form-section token-fields">
          <div className="two-fields"><Field label="Token name" name="name" placeholder="The next good idea" value={draft.name} maxLength={32} onChange={e => update('name', e.target.value)} error={errors.name} autoComplete="off" /><Field label="Ticker" name="ticker" placeholder="IDEA" value={draft.ticker} maxLength={10} onChange={e => update('ticker', e.target.value.toUpperCase())} error={errors.ticker} autoComplete="off" /></div>
          <div className="field image-field"><label htmlFor="token-image">Token image</label><input ref={fileRef} id="token-image" className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" tabIndex={-1} onChange={e => { upload(e.target.files[0]); e.target.value = ''; }} />
            <button type="button" className={`upload-zone ${dragging ? 'is-dragging' : ''} ${image ? 'has-image' : ''}`} onClick={() => fileRef.current.click()} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files[0]); }} aria-invalid={!!(errors.image || imageError)} aria-describedby="image-error">
              {image ? <img src={image.url} alt="Selected token artwork" /> : <span className="upload-icon">{loadingImage ? <CircleNotch className="spin" size={26} /> : <ImageSquare size={26} />}</span>}<span><strong>{loadingImage ? 'Opening image?' : image ? image.name : 'Choose an image'}</strong><span>{image ? 'Click to replace' : 'PNG, JPG or WebP, up to 5 MB'}</span></span><Plus size={20} />
            </button><FieldError id="image-error">{imageError || errors.image}</FieldError>
          </div>
          <div className="field"><label htmlFor="description">Description</label><textarea id="description" value={draft.description} onChange={e => update('description', e.target.value)} maxLength={500} placeholder="What is your coin about?" rows={3} aria-invalid={!!errors.description} aria-describedby={errors.description ? 'description-error' : undefined} /><FieldError id="description-error">{errors.description}</FieldError></div>
          <details className="social-fields"><summary>Social links <span>Optional <Plus size={17} /></span></summary><div className="social-fields-body">
            <div className="field website-field"><label htmlFor="website">Website <span className="automatic-label"><LockSimple size={14} />Automatic</span></label><div className="input-prefix"><Globe size={19} /><input id="website" readOnly value={new URL('/', window.location.origin).href} /></div></div>
            <Field label="X link" name="twitter" value={draft.twitter} placeholder="https://x.com/yourproject" onChange={e => update('twitter', e.target.value)} error={errors.twitter} />
          </div></details>
        </section>
        <section className="form-section"><div className="form-section-title"><h2><label htmlFor="devBuy">Dev buy</label></h2><span className="optional">Optional</span></div><div className="field dev-field"><div className="input-suffix"><input id="devBuy" inputMode="decimal" value={draft.devBuy} onChange={e => update('devBuy', e.target.value)} aria-invalid={!!errors.devBuy} aria-describedby="devBuy-hint" /><span>SOL</span></div><FieldError id="devBuy-error">{errors.devBuy}</FieldError></div>
          <div className="amount-presets">{['0', '0.1', '0.5', '1'].map(value => <button type="button" key={value} aria-pressed={draft.devBuy === value} onClick={() => update('devBuy', value)}>{value === '0' ? 'No buy' : `${value} SOL`}</button>)}</div><p className="field-hint" id="devBuy-hint">Your first buy, included in the launch.</p>
        </section>
        <div className="form-submit"><button className="button primary" type="submit" disabled={loadingImage}>Review launch <ArrowRight size={20} /></button><p>Preview only. No funds move.</p></div>
      </form>
      <aside className="launch-preview"><div className="preview-sticky"><PayoutPreview recipients={draft.recipients} />
        <div className="token-preview"><div className={`token-art ${image ? 'with-art' : ''}`}>{image ? <img src={image.url} alt={`${draft.name || 'Your token'} artwork preview`} /> : <Basket size={65} weight="light" />}</div>
          <div className="token-preview-body"><div className="token-title"><h2>{draft.name || 'Your token name'}</h2><span>${draft.ticker || 'TICKER'}</span></div><PumpBadge />
            {draft.description && <p className="token-description">{draft.description}</p>}<div className="preview-payment"><span>Total paid out</span><strong>$0.00</strong></div>
            <div className="preview-recipients-title"><span>Your fee basket</span><UsersThree size={20} /></div><Distribution recipients={draft.recipients} small />
            <div className="preview-dev"><span>Dev buy</span><strong>{draft.devBuy || '0'} SOL</strong></div>
          </div>
        </div>
      </div></aside>
    </div>
  </>;
}

function Payments() {
  const [filter, setFilter] = useState('All payments');
  return <><PageHeading title="Every payment, in the open.">A record of the people paid and the coins behind them.</PageHeading><Metrics large /><section className="panel payments-ledger"><div className="panel-heading"><h2>Payment history</h2><span className="count-badge">0 payments</span></div><div className="payment-toolbar"><div className="segmented-control" aria-label="Payment status">{['All payments', 'Completed', 'Pending'].map(item => <button key={item} type="button" aria-pressed={item === filter} onClick={() => setFilter(item)}>{item}</button>)}</div><span>Amounts in USD</span></div><div className="ledger-columns" aria-hidden="true"><span>Recipient / token</span><span>Amount</span><span>Status</span><span>Date</span></div><div role="status"><EmptyState title={filter === 'Pending' ? 'Nothing waiting in the wings.' : filter === 'Completed' ? 'No completed payments yet.' : 'A clean slate. A shared future.'} description={filter === 'Pending' ? 'Pending payouts will be listed here when payments are enabled.' : 'When payouts begin, each confirmed payment will have a place here.'} /></div><div className="panel-foot"><span><LockSimple size={13} /> Payouts are not live yet</span><Link to="/docs#payments" className="text-link">About payments <ArrowUpRight size={14} /></Link></div></section></>;
}

function CapitalFlow() {
  const [amount, setAmount] = useState(100);
  const [preset, setPreset] = useState('50 / 30 / 20');
  const recipients = preset === '50 / 30 / 20' ? EXAMPLE_BASKET : splitEvenly(EXAMPLE_BASKET);
  const poolCents = amount * 100;
  const shares = recipients.map(r => Math.floor(poolCents * toBasisPoints(r.share) / 10000));
  shares[0] += poolCents - shares.reduce((a, b) => a + b, 0);
  return <><PageHeading title="Capital flow">Follow the fees, from the first trade to every person in your basket.</PageHeading><CapitalScene /><section className="flow-calculator"><div><h2>Try the split.</h2><p>Change the example recipient pool and see how the dollars are divided.</p><label className="range-label" htmlFor="pool">Example recipient pool <strong>${amount.toLocaleString()}</strong></label><input id="pool" className="range-input" type="range" min="10" max="1000" step="10" value={amount} onChange={e => setAmount(Number(e.target.value))} /><div className="range-limits"><span>$10</span><span>$1,000</span></div><div className="segmented-control split-presets" aria-label="Example split">{['50 / 30 / 20', 'Equal split'].map(value => <button key={value} aria-pressed={preset === value} onClick={() => setPreset(value)}>{value}</button>)}</div><p className="calculator-note">Example amounts, after any applicable costs.</p></div><div className="panel calculator-result"><div className="panel-heading"><h3>Example distribution</h3><Basket size={20} /></div>{recipients.map((recipient, index) => <div className="calculator-person" key={recipient.id}><Avatar index={index} handle={recipient.handle} /><div><strong>@{recipient.handle}</strong><span>{recipient.share}% of the pool</span></div><strong>${(shares[index] / 100).toFixed(2)}</strong></div>)}<div className="calculator-total"><span>Allocated to recipients</span><strong>${amount.toFixed(2)}</strong></div></div></section><section className="panel flow-activity"><div className="panel-heading"><h2>Capital activity</h2><span className="count-badge">0 events</span></div><div className="quiet-empty"><Clock size={23} /><div><h3>No capital movements yet</h3><p>Collections, conversions and payouts will appear here when the service is live.</p></div></div></section></>;
}

const DOCS = [
  { id: 'overview', title: 'A little coin. A bigger circle.', intro: 'Basket is a way to launch a pump.fun token with creator fees shared between the people you choose.', paragraphs: ['Instead of choosing one recipient, build a basket of up to five X accounts. Set a percentage for each person and review the complete allocation before launch.', 'This first version is a frontend preview. You can build a token draft, upload artwork, configure recipients and review your launch. Wallet connections, token creation, fee collection and payouts are not enabled.'] },
  { id: 'launching', title: 'Create your token', intro: 'Keep the idea simple. Make the details your own.', paragraphs: ['Add your token’s name, ticker and image. A description and an X profile or post link are optional. The website field automatically uses this site’s homepage.', 'Set an optional dev buy in SOL, or leave it at zero. The launch flow is designed for a single creator wallet. Bundle buys are not offered.', 'Review launch checks your draft and opens a summary. It does not connect a wallet, charge a fee or create a token. A real fee quote and explicit payment confirmation will be needed when live launches become available.'] },
  { id: 'baskets', title: 'Build your fee basket', intro: 'Your recipients. Your allocation.', paragraphs: ['Add between one and five unique X handles. You can also paste an X or Twitter profile link. Each share must be greater than zero and all shares must total exactly 100%.', 'Shares support two decimal places. Split evenly divides the allocation and assigns any remaining hundredth of a percent to the first recipients, so the total stays exact.', 'These percentages refer to the recipient pool, not to the token supply or every trading fee. Final service fees, conversion costs and pool terms are not set in this preview. Entering a handle does not verify account ownership or X Money eligibility.'] },
  { id: 'payments', title: 'Payments and receipts', intro: 'A clear record from the very first payout.', paragraphs: ['The intended payout destination is each eligible recipient’s X Money account. The payout integration, account checks, currency conversion and settlement timing are still to be connected.', 'Total paid out, payments and recipients all start at zero. The example basket and capital-flow calculator are illustrations, not actual payment history.', 'When the service is live, payment history will distinguish pending and completed transfers. Only confirmed payouts should count toward the total paid out.'] },
  { id: 'drafts', title: 'Your draft stays with you', intro: 'Make changes at your own pace.', paragraphs: ['Text fields and your recipient allocation are saved in this browser when local storage is available. Artwork stays in memory for this session and needs to be selected again after a reload.', 'Drafts are not uploaded to a server. Keep a copy of your artwork. Previewing or editing a basket does not reserve a token name, verify an X account or move any funds.'] },
];
function Docs() {
  return <><PageHeading title="The guide to Basket.">From your first idea to your fee basket.</PageHeading><div className="docs-layout"><nav className="docs-nav" aria-label="Documentation sections">{DOCS.map(doc => <a key={doc.id} href={`#${doc.id}`}>{({ overview: 'The idea', launching: 'Launching a token', baskets: 'Fee baskets', payments: 'Payments', drafts: 'Your draft' })[doc.id]}<ArrowUpRight size={13} /></a>)}</nav><div className="docs-content"><div className="docs-preview-note"><Info size={18} /><span>You’re exploring the frontend preview. Live launches and payouts are coming later.</span></div>{DOCS.map(doc => <section className="doc-section" key={doc.id} id={doc.id}><h2>{doc.title}</h2><p className="doc-intro">{doc.intro}</p>{doc.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}{doc.id === 'baskets' && <div className="doc-example"><span>Example allocation</span><Distribution /></div>}</section>)}<div className="docs-end"><h3>Ready to shape your idea?</h3><ButtonLink to="/launch">Launch a token <ArrowUpRight size={16} /></ButtonLink></div></div></div></>;
}

function ReviewDialog({ open, onClose, draft, image }) {
  const ref = useRef();
  useEffect(() => {
    if (open) ref.current?.showModal();
    else ref.current?.close();
  }, [open]);
  const payload = previewPayload(draft, window.location.origin);
  return <dialog className="review-dialog" ref={ref} onCancel={onClose} onClose={onClose} aria-labelledby="review-title" aria-describedby="review-description" onKeyDown={event => {
    if (event.key !== 'Tab') return;
    const items = [...ref.current.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]')];
    if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
  }} onClick={event => { if (event.target === ref.current) { const rect = ref.current.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}><div className="review-header"><span className="icon-tile"><Basket size={23} /></span><button className="icon-button" onClick={onClose} aria-label="Close launch review"><X size={20} /></button></div><h2 id="review-title">Your basket, ready to review.</h2><p id="review-description">Check the details of your token and its recipients.</p><div className="review-token">{image && <img src={image.url} width="56" height="56" alt="Token artwork" />}<div><strong>{payload.name}</strong><span>${payload.symbol}</span></div><PumpBadge /></div><Distribution recipients={draft.recipients} /><dl className="review-details"><div><dt>Dev buy</dt><dd>{draft.devBuy} SOL</dd></div><div><dt>Website</dt><dd>{payload.website}</dd></div><div><dt>Launch fee</dt><dd>Not quoted yet</dd></div></dl><div className="review-notice"><LockSimple size={18} /><p><strong>Live launches are not enabled yet.</strong>Your draft is ready to review. No token has been created and no payment will be taken.</p></div><button className="button primary" disabled><Wallet size={17} />Payments coming soon</button><button className="text-button back-to-edit" onClick={onClose}>Back to editing</button></dialog>;
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
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('basket-theme') || 'dark'; } catch { return 'dark'; } });
  useEffect(() => { document.documentElement.dataset.theme = theme; try { localStorage.setItem('basket-theme', theme); } catch {} }, [theme]);
  useEffect(() => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch {} }, [draft]);
  useEffect(() => () => { if (image?.url) URL.revokeObjectURL(image.url); }, [image]);
  useEffect(() => { const change = () => setPath(window.location.pathname.replace(/\/$/, '') || '/'); window.addEventListener('popstate', change); return () => window.removeEventListener('popstate', change); }, []);
  useEffect(() => {
    const label = ROUTES.find(route => route[0] === path)?.[1] || 'Page not found';
    document.title = `${label} | Basket`;
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
  const label = ROUTES.find(route => route[0] === path)?.[1] || 'Page not found';
  return <NavigationContext.Provider value={navigate}><a className="skip-link" href="#main">Skip to content</a><aside className="sidebar"><Brand /><nav className="primary-nav" aria-label="Main navigation">{ROUTES.map(([to, title, Icon, shortTitle], index) => <Link key={to} to={to} className={`${path === to ? 'active' : ''} ${index === 4 ? 'nav-docs' : ''}`} aria-label={title} aria-current={path === to ? 'page' : undefined}><Icon size={20} weight={path === to ? 'fill' : 'regular'} /><span><span className="nav-full">{title}</span><span className="nav-short">{shortTitle}</span></span></Link>)}</nav><div className="sidebar-bottom"><div className="sidebar-footer"><span>Built on Solana</span><button type="button" className="icon-button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</button></div></div></aside><div className="app-content"><header className="topbar"><span className="breadcrumb"><strong>{label}</strong></span><div className="topbar-actions"><span className="preview-status">Frontend preview</span><ButtonLink to="/launch">Launch a token <ArrowUpRight size={15} /></ButtonLink></div></header><main id="main" key={path} className={`main-container page-${path.slice(1) || 'home'}`}>{path === '/' ? <Home /> : path === '/launch' ? <Launch draft={draft} setDraft={setDraft} image={image} setImage={setImage} review={() => setReview(true)} /> : path === '/payments' ? <Payments /> : path === '/capital-flow' ? <CapitalFlow /> : path === '/docs' ? <Docs /> : <><PageHeading title="This page isn't in the basket.">The link may have moved. Head back to the overview.</PageHeading><ButtonLink to="/">Back to overview <ArrowRight size={16} /></ButtonLink></>}</main><footer className="site-footer"><span>© {new Date().getFullYear()} Basket</span><span>One coin. A shared upside.</span><Link to="/docs">Documentation <ArrowUpRight size={13} /></Link></footer></div><ReviewDialog open={review} onClose={() => setReview(false)} draft={draft} image={image} /></NavigationContext.Provider>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
