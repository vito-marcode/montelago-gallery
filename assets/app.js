/* Galleria foto da bucket S3 pubblico.
   Nessun backend: l'elenco dei file viene letto dal browser con
   l'API ListObjectsV2 e le immagini sono servite direttamente dal bucket. */
'use strict';

/* Cartella aperta quando l'indirizzo non contiene ?bucket-url=.
   Se resta vuota, il sito chiede l'indirizzo all'avvio. */
const DEFAULT_BUCKET_URL = '';

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|tiff?|heic|heif)$/i;
const PROXY_BASE = 'https://wsrv.nl/?url=';
/* Larghezze fisse: aumentano le probabilità di colpire la cache della CDN */
const THUMB_STEPS = [320, 480, 640, 800, 1024];
const PREVIEW_WIDTH = 1600;
const PAGE_SIZE = 1000;

const collator = new Intl.Collator('it', { numeric: true, sensitivity: 'base' });

const el = (id) => document.getElementById(id);
const dom = {
  title: el('title'),
  meta: el('meta'),
  sort: el('sort'),
  optimize: el('optimize'),
  changeBtn: el('change-btn'),
  changePanel: el('change-panel'),
  bucketInput: el('bucket-input'),
  topbarActions: el('topbar-actions'),
  welcome: el('welcome'),
  status: el('status'),
  statusText: el('status-text'),
  error: el('error'),
  errorTitle: el('error-title'),
  errorText: el('error-text'),
  errorHints: el('error-hints'),
  grid: el('grid'),
  footerSource: el('footer-source'),
  lb: el('lightbox'),
  lbImg: el('lb-img'),
  lbPlaceholder: el('lb-placeholder'),
  lbName: el('lb-name'),
  lbCounter: el('lb-counter'),
  lbInfo: el('lb-info'),
  lbDownload: el('lb-download'),
  lbPrev: el('lb-prev'),
  lbNext: el('lb-next'),
  lbClose: el('lb-close'),
  lbStage: el('lb-stage'),
};

const state = {
  source: null,      // { listBase, objectBase, prefix }
  photos: [],
  sort: 'name-asc',
  optimize: true,
  thumbW: 480,
  index: -1,
  pushedHistory: false,
};

/* ---------------------------------------------------------------- utility */

function humanBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const v = n / 1024 ** i;
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0).replace('.', ',')} ${units[i]}`;
}

function humanDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
}

/* Codifica le sole parti del path, lasciando intatti gli slash */
function encodeKey(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

/* ------------------------------------------------- lettura del bucket URL */

/* Restituisce i possibili modi di interpretare l'URL fornito:
   path-style   -> https://s3.host/bucket/prefix/
   virtual-host -> https://bucket.s3.host/prefix/
   Vengono provati in ordine, il primo che restituisce immagini vince. */
function buildCandidates(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return [];

  let u;
  try {
    u = new URL(trimmed);
  } catch {
    try { u = new URL('https://' + trimmed.replace(/^\/+/, '')); } catch { return []; }
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return [];

  let segs;
  try {
    segs = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    segs = u.pathname.split('/').filter(Boolean);
  }

  const asPrefix = (parts) => (parts.length ? parts.join('/') + '/' : '');
  const out = [];

  if (segs.length) {
    out.push({
      listBase: `${u.origin}/${encodeURIComponent(segs[0])}`,
      objectBase: `${u.origin}/${encodeURIComponent(segs[0])}`,
      prefix: asPrefix(segs.slice(1)),
      label: segs.join('/'),
    });
  }

  out.push({
    listBase: u.origin,
    objectBase: u.origin,
    prefix: asPrefix(segs),
    label: segs.length ? segs.join('/') : u.hostname,
  });

  return out;
}

class ListError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind; // 'network' | 'http' | 'parse'
  }
}

/* Scorre tutte le pagine di ListObjectsV2 e restituisce gli oggetti trovati */
async function listObjects(source, onProgress) {
  const objects = [];
  let token = null;
  let pages = 0;

  do {
    const q = new URLSearchParams({ 'list-type': '2', 'max-keys': String(PAGE_SIZE) });
    if (source.prefix) q.set('prefix', source.prefix);
    if (token) q.set('continuation-token', token);

    let res;
    try {
      res = await fetch(`${source.listBase}?${q}`, { credentials: 'omit' });
    } catch (e) {
      throw new ListError(e.message || 'richiesta bloccata', 'network');
    }
    if (!res.ok) {
      throw new ListError(`il server ha risposto ${res.status} ${res.statusText}`.trim(), 'http');
    }

    const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');
    if (doc.querySelector('parsererror') || !doc.querySelector('ListBucketResult')) {
      const code = doc.querySelector('Error > Code')?.textContent;
      throw new ListError(code ? `il bucket ha risposto "${code}"` : 'risposta non riconosciuta', 'parse');
    }

    for (const node of doc.querySelectorAll('ListBucketResult > Contents')) {
      const key = node.querySelector('Key')?.textContent || '';
      if (!key || key.endsWith('/')) continue;
      objects.push({
        key,
        size: Number(node.querySelector('Size')?.textContent || 0),
        modified: node.querySelector('LastModified')?.textContent || '',
      });
    }

    const truncated = doc.querySelector('ListBucketResult > IsTruncated')?.textContent === 'true';
    token = truncated ? doc.querySelector('ListBucketResult > NextContinuationToken')?.textContent || null : null;
    pages += 1;
    if (onProgress) onProgress(objects.length, pages);
  } while (token);

  return objects;
}

/* ------------------------------------------------------------------ URLs */

function objectUrl(photo) {
  return `${state.source.objectBase}/${encodeKey(photo.key)}`;
}

function proxied(photo, width) {
  return `${PROXY_BASE}${encodeURIComponent(objectUrl(photo))}&w=${width}&output=webp&q=${width > 1000 ? 80 : 74}&n=-1`;
}

const thumbUrl = (photo) => (state.optimize ? proxied(photo, state.thumbW) : objectUrl(photo));
const previewUrl = (photo) => (state.optimize ? proxied(photo, PREVIEW_WIDTH) : objectUrl(photo));

/* ---------------------------------------------------------------- griglia */

const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    observer.unobserve(entry.target);
    loadTile(entry.target);
  }
}, { rootMargin: '600px 0px' });

function loadTile(tile) {
  const photo = state.photos[Number(tile.dataset.i)];
  const img = tile.querySelector('img');
  if (!photo || img.dataset.started) return;
  img.dataset.started = '1';

  let usedFallback = false;
  img.addEventListener('load', () => tile.classList.add('ready'));
  img.addEventListener('error', () => {
    const original = objectUrl(photo);
    if (!usedFallback && img.src !== original) {
      /* Se il proxy delle anteprime non risponde, ricade sull'originale */
      usedFallback = true;
      img.src = original;
    } else {
      tile.classList.add('failed');
    }
  });

  img.src = thumbUrl(photo);
}

function sortPhotos() {
  const [field, dir] = state.sort.split('-');
  const sign = dir === 'desc' ? -1 : 1;
  state.photos.sort((a, b) => {
    if (field === 'date') return sign * (Date.parse(a.modified || 0) - Date.parse(b.modified || 0));
    if (field === 'size') return sign * (a.size - b.size);
    return sign * collator.compare(a.name, b.name);
  });
}

function measureThumbWidth() {
  const probe = dom.grid.firstElementChild;
  const cssW = probe ? probe.getBoundingClientRect().width : 220;
  const needed = cssW * Math.min(window.devicePixelRatio || 1, 2);
  return THUMB_STEPS.find((w) => w >= needed) || THUMB_STEPS[THUMB_STEPS.length - 1];
}

function renderGrid() {
  observer.disconnect();
  dom.grid.textContent = '';

  const frag = document.createDocumentFragment();
  state.photos.forEach((photo, i) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    tile.dataset.i = String(i);
    tile.setAttribute('aria-label', `Apri ${photo.name}`);

    const img = document.createElement('img');
    img.alt = photo.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    tile.append(img);

    const label = document.createElement('span');
    label.className = 'tile-label';
    label.textContent = photo.name;
    tile.append(label);

    frag.append(tile);
  });
  dom.grid.append(frag);

  state.thumbW = measureThumbWidth();
  for (const tile of dom.grid.children) observer.observe(tile);
}

/* -------------------------------------------------------------- lightbox */

function lightboxOpen() {
  return !dom.lb.hidden;
}

function showCurrent() {
  const photo = state.photos[state.index];
  if (!photo) return;

  dom.lb.classList.remove('ready', 'lqip');
  dom.lbImg.removeAttribute('src');
  dom.lbPlaceholder.removeAttribute('src');

  /* La miniatura della griglia è già scaricata: la si mostra ingrandita per
     non lasciare lo schermo nero mentre arriva l'anteprima a piena grandezza.
     Senza le anteprime leggere non serve: griglia e lightbox usano lo stesso
     file originale, quindi è già in cache. */
  if (state.optimize) dom.lbPlaceholder.src = thumbUrl(photo);

  dom.lbImg.alt = photo.name;
  dom.lbImg.src = previewUrl(photo);

  dom.lbName.textContent = photo.name;
  dom.lbCounter.textContent = `${state.index + 1} / ${state.photos.length}`;
  dom.lbDownload.href = objectUrl(photo);
  dom.lbDownload.setAttribute('download', photo.name);

  const bits = [humanBytes(photo.size), humanDate(photo.modified)].filter(Boolean);
  if (state.optimize) bits.push('anteprima ridotta — usa “Scarica” per l’originale');
  dom.lbInfo.textContent = bits.join(' · ');

  const single = state.photos.length < 2;
  dom.lbPrev.hidden = single;
  dom.lbNext.hidden = single;
}

function openAt(index, { fromHistory = false } = {}) {
  if (!state.photos.length) return;
  state.index = ((index % state.photos.length) + state.photos.length) % state.photos.length;

  const wasOpen = lightboxOpen();
  dom.lb.hidden = false;
  document.body.style.overflow = 'hidden';
  showCurrent();
  if (!wasOpen) dom.lbClose.focus({ preventScroll: true });

  const hash = '#' + encodeURIComponent(state.photos[state.index].key);
  if (fromHistory) return;
  if (wasOpen || state.pushedHistory) {
    history.replaceState(history.state, '', hash);
  } else {
    history.pushState({ lightbox: true }, '', hash);
    state.pushedHistory = true;
  }
}

function closeLightbox({ fromHistory = false } = {}) {
  if (!lightboxOpen()) return;
  dom.lb.hidden = true;
  dom.lbImg.removeAttribute('src');
  document.body.style.overflow = '';

  const tile = dom.grid.children[state.index];
  if (tile) tile.focus({ preventScroll: true });

  if (!fromHistory && state.pushedHistory) {
    state.pushedHistory = false;
    history.back();
  } else {
    state.pushedHistory = false;
    if (fromHistory === false) history.replaceState(history.state, '', location.pathname + location.search);
  }
}

function step(delta) {
  openAt(state.index + delta);
}

/* ------------------------------------------------------------ interfaccia */

function showError(message, hints) {
  dom.status.hidden = true;
  dom.error.hidden = false;
  dom.errorText.textContent = message;
  dom.errorHints.textContent = '';
  for (const hint of hints) {
    const li = document.createElement('li');
    li.textContent = hint;
    dom.errorHints.append(li);
  }
}

function updateHeader() {
  const totalBytes = state.photos.reduce((sum, p) => sum + p.size, 0);
  const n = state.photos.length;
  dom.meta.textContent = `${n} foto · ${humanBytes(totalBytes)}`;
  dom.title.textContent = state.source.prefix
    ? state.source.prefix.replace(/\/$/, '').split('/').pop()
    : 'Galleria foto';
  document.title = `${dom.title.textContent} · ${n} foto`;

  const shown = `${state.source.objectBase}/${state.source.prefix}`;
  dom.footerSource.textContent = `Origine: ${shown}`;
}

async function load(rawUrl) {
  const candidates = buildCandidates(rawUrl);
  if (!candidates.length) {
    showError(`“${rawUrl}” non è un indirizzo valido.`, [
      'Formato atteso: https://s3.esempio.com/nome-bucket/cartella/',
    ]);
    return;
  }

  dom.status.hidden = false;
  dom.error.hidden = true;
  dom.statusText.textContent = 'Lettura dell’elenco dei file…';

  let lastError = null;
  let emptyFallback = null;

  for (const candidate of candidates) {
    try {
      const objects = await listObjects(candidate, (count) => {
        dom.statusText.textContent = `Lettura dell’elenco dei file… ${count} trovati`;
      });
      const photos = objects
        .filter((o) => IMAGE_EXT.test(o.key) && o.size > 0)
        .map((o) => ({ ...o, name: o.key.split('/').pop() }));

      if (photos.length) {
        state.source = candidate;
        state.photos = photos;
        finish();
        return;
      }
      emptyFallback ??= candidate;
    } catch (e) {
      lastError = e;
    }
  }

  if (emptyFallback) {
    state.source = emptyFallback;
    state.photos = [];
    dom.status.hidden = true;
    updateHeader();
    showError('Nessuna immagine trovata in questa cartella.', [
      'Verifica che il percorso sia corretto (maiuscole e minuscole contano).',
      'Sono riconosciuti i file jpg, png, gif, webp, avif, bmp, tiff, heic.',
    ]);
    return;
  }

  const kind = lastError?.kind;
  showError(
    `Non è stato possibile leggere l’elenco: ${lastError?.message || 'errore sconosciuto'}.`,
    kind === 'network'
      ? [
          'Il bucket deve consentire le richieste dal browser (regola CORS con AllowedOrigin “*” e metodo GET).',
          'Controlla che l’indirizzo sia raggiungibile e che usi https.',
        ]
      : [
          'L’elenco pubblico dei file deve essere consentito (permesso s3:ListBucket per tutti).',
          'Verifica il nome del bucket e della cartella nell’indirizzo.',
        ]
  );
}

function finish() {
  sortPhotos();
  dom.status.hidden = true;
  dom.error.hidden = true;
  updateHeader();
  renderGrid();

  /* Apertura diretta di una foto condivisa via #chiave */
  const hash = location.hash.slice(1);
  if (hash) {
    let key;
    try { key = decodeURIComponent(hash); } catch { key = hash; }
    const i = state.photos.findIndex((p) => p.key === key);
    if (i >= 0) openAt(i, { fromHistory: true });
  }
}

/* ------------------------------------------------------------------ eventi */

dom.grid.addEventListener('click', (e) => {
  const tile = e.target.closest('.tile');
  if (tile) openAt(Number(tile.dataset.i));
});

dom.sort.addEventListener('change', () => {
  state.sort = dom.sort.value;
  const current = state.photos[state.index];
  sortPhotos();
  renderGrid();
  if (lightboxOpen() && current) {
    state.index = state.photos.indexOf(current);
    showCurrent();
  }
});

dom.optimize.addEventListener('change', () => {
  state.optimize = dom.optimize.checked;
  try { localStorage.setItem('gallery:optimize', state.optimize ? '1' : '0'); } catch { /* ignora */ }
  renderGrid();
  if (lightboxOpen()) showCurrent();
});

function openChangePanel(open) {
  dom.changePanel.hidden = !open;
  dom.changeBtn.setAttribute('aria-expanded', String(open));
  if (open) dom.bucketInput.focus();
}

dom.changeBtn.addEventListener('click', () => openChangePanel(dom.changePanel.hidden));

dom.changePanel.addEventListener('submit', (e) => {
  e.preventDefault();
  const value = dom.bucketInput.value.trim();
  if (value) location.search = '?bucket-url=' + encodeURIComponent(value);
});

dom.lbImg.addEventListener('load', () => dom.lb.classList.add('ready'));

/* Se l'anteprima grande è già arrivata non serve più mostrare la miniatura */
dom.lbPlaceholder.addEventListener('load', () => {
  if (!dom.lb.classList.contains('ready')) dom.lb.classList.add('lqip');
});
dom.lbImg.addEventListener('error', () => {
  const photo = state.photos[state.index];
  /* Se l'anteprima grande non arriva, mostra l'originale */
  if (photo && dom.lbImg.src !== objectUrl(photo)) dom.lbImg.src = objectUrl(photo);
});

dom.lbClose.addEventListener('click', () => closeLightbox());
dom.lbPrev.addEventListener('click', () => step(-1));
dom.lbNext.addEventListener('click', () => step(1));

dom.lb.addEventListener('click', (e) => {
  if (e.target === dom.lb || e.target === dom.lbStage || e.target.classList.contains('lb-imgwrap')) {
    closeLightbox();
  }
});

document.addEventListener('keydown', (e) => {
  if (!lightboxOpen()) return;
  if (e.key === 'Escape') { closeLightbox(); }
  else if (e.key === 'ArrowRight') { step(1); }
  else if (e.key === 'ArrowLeft') { step(-1); }
  else if (e.key === 'Home') { openAt(0); }
  else if (e.key === 'End') { openAt(state.photos.length - 1); }
  else return;
  e.preventDefault();
});

window.addEventListener('popstate', () => {
  if (lightboxOpen()) closeLightbox({ fromHistory: true });
});

/* Scorrimento con il dito su mobile */
let touchStart = null;
dom.lbStage.addEventListener('touchstart', (e) => {
  touchStart = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
}, { passive: true });

dom.lbStage.addEventListener('touchend', (e) => {
  if (!touchStart || e.changedTouches.length !== 1) return;
  const dx = e.changedTouches[0].clientX - touchStart.x;
  const dy = e.changedTouches[0].clientY - touchStart.y;
  touchStart = null;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
}, { passive: true });

/* ---------------------------------------------------------------- avvio */

/* Nessuna cartella indicata: si chiede l'indirizzo invece di mostrare un errore */
function showWelcome() {
  dom.status.hidden = true;
  dom.error.hidden = true;
  dom.welcome.hidden = false;
  dom.meta.textContent = '';
  dom.topbarActions.hidden = true;
  openChangePanel(true);
}

(function init() {
  const params = new URLSearchParams(location.search);
  const raw = (params.get('bucket-url') || params.get('bucket') || DEFAULT_BUCKET_URL).trim();

  try {
    state.optimize = localStorage.getItem('gallery:optimize') !== '0';
  } catch { /* localStorage non disponibile */ }
  dom.optimize.checked = state.optimize;
  dom.sort.value = state.sort;
  /* Il CSS ne ha bisogno per non ingrandire la miniatura oltre il riquadro
     che occuperà l'anteprima grande */
  document.documentElement.style.setProperty('--preview-width', `${PREVIEW_WIDTH}px`);
  if (raw) dom.bucketInput.value = raw;

  if (raw) load(raw);
  else showWelcome();
})();
