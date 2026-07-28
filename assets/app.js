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
/* Durata della pressione prolungata che avvia la selezione */
const LONG_PRESS_MS = 450;
/* Spostamento oltre il quale la pressione diventa uno scorrimento */
const PRESS_SLOP = 10;
/* Quante foto scaricare in parallelo mentre si prepara lo ZIP */
const FETCH_CONCURRENCY = 3;
/* Oltre i 4 GB servirebbe il formato ZIP64, che non è implementato */
const ZIP_MAX_BYTES = 3.5 * 1024 ** 3;

const collator = new Intl.Collator('it', { numeric: true, sensitivity: 'base' });

const el = (id) => document.getElementById(id);
const dom = {
  title: el('title'),
  meta: el('meta'),
  sort: el('sort'),
  changePanel: el('change-panel'),
  bucketInput: el('bucket-input'),
  topbarActions: el('topbar-actions'),
  selectBtn: el('select-btn'),
  selbar: el('selbar'),
  selCount: el('sel-count'),
  selHint: el('sel-hint'),
  selAll: el('sel-all'),
  selDownload: el('sel-download'),
  selDownloadText: el('sel-download-text'),
  selCancel: el('sel-cancel'),
  selProgress: el('sel-progress'),
  selFill: el('sel-fill'),
  selProgressText: el('sel-progress-text'),
  selAbort: el('sel-abort'),
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
  lbHires: el('lb-hires'),
  lbZoom: el('lb-zoom'),
  lbImgwrap: el('lb-imgwrap'),
  lbName: el('lb-name'),
  lbCounter: el('lb-counter'),
  lbInfo: el('lb-info'),
  lbInfoMain: el('lb-info-main'),
  lbInfoNote: el('lb-info-note'),
  lbDownload: el('lb-download'),
  lbDownloadText: el('lb-download-text'),
  lbShare: el('lb-share'),
  sharePanel: el('share-panel'),
  shareLinks: el('share-links'),
  shareCopy: el('share-copy'),
  shareClose: el('share-close'),
  lbPrev: el('lb-prev'),
  lbNext: el('lb-next'),
  lbClose: el('lb-close'),
  lbStage: el('lb-stage'),
};

const state = {
  source: null,      // { listBase, objectBase, prefix }
  photos: [],
  sort: 'date-asc',
  thumbW: 480,
  index: -1,
  pushedHistory: false,
  /* Identifica la foto in corso di visualizzazione: se si cambia foto prima
     che la precedente sia decodificata, il risultato tardivo va ignorato */
  renderToken: 0,
  /* Chiavi delle foto scelte: sopravvivono al riordino, gli indici no */
  selection: new Set(),
  selecting: false,
  anchor: -1,
  downloading: false,
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

/* Griglia e lightbox usano sempre le anteprime ridimensionate; gli originali
   servono solo per il download (e come ripiego se il proxy non risponde) */
const thumbUrl = (photo) => proxied(photo, state.thumbW);
const previewUrl = (photo) => proxied(photo, PREVIEW_WIDTH);

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
    if (state.selection.has(photo.key)) tile.classList.add('selected');

    const img = document.createElement('img');
    img.alt = photo.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    tile.append(img);

    const label = document.createElement('span');
    label.className = 'tile-label';
    label.textContent = photo.name;
    tile.append(label);

    const check = document.createElement('span');
    check.className = 'tile-check';
    check.setAttribute('aria-hidden', 'true');
    tile.append(check);

    syncTileLabel(tile, photo);
    frag.append(tile);
  });
  dom.grid.append(frag);

  state.thumbW = measureThumbWidth();
  for (const tile of dom.grid.children) observer.observe(tile);
}

/* In modalità selezione il riquadro è un interruttore, altrimenti apre la foto */
function syncTileLabel(tile, photo) {
  if (state.selecting) {
    const on = state.selection.has(photo.key);
    tile.setAttribute('aria-pressed', String(on));
    tile.setAttribute('aria-label', `${on ? 'Deseleziona' : 'Seleziona'} ${photo.name}`);
  } else {
    tile.removeAttribute('aria-pressed');
    tile.setAttribute('aria-label', `Apri ${photo.name}`);
  }
}

/* -------------------------------------------------------------- selezione */

function selectedPhotos() {
  return state.photos.filter((p) => state.selection.has(p.key));
}

function updateSelectionUi() {
  const chosen = selectedPhotos();
  const bytes = chosen.reduce((sum, p) => sum + p.size, 0);

  dom.selbar.classList.toggle('open', state.selecting);
  dom.grid.classList.toggle('selecting', state.selecting);
  dom.selectBtn.textContent = state.selecting ? 'Esci dalla selezione' : 'Seleziona';

  dom.selCount.textContent = chosen.length
    ? `${chosen.length} ${chosen.length === 1 ? 'foto' : 'foto'} · ${humanBytes(bytes)}`
    : 'Nessuna foto selezionata';
  dom.selDownload.disabled = !chosen.length || state.downloading;
  dom.selDownloadText.textContent = chosen.length ? `Scarica (${chosen.length})` : 'Scarica';
  dom.selAll.textContent = chosen.length === state.photos.length ? 'Deseleziona tutte' : 'Seleziona tutte';
  syncSelbarSpace();
}

/* Il pannello copre il fondo della pagina: si aggiunge spazio in coda perché
   l'ultima fila di foto resti raggiungibile. Non sposta nulla di visibile. */
function syncSelbarSpace() {
  document.body.style.paddingBottom = state.selecting ? `${dom.selbar.offsetHeight}px` : '';
}

/* L'altezza cambia col ritorno a capo dei pulsanti e con la barra di avanzamento */
new ResizeObserver(syncSelbarSpace).observe(dom.selbar);

function setSelecting(on) {
  state.selecting = on;
  if (!on) {
    state.selection.clear();
    state.anchor = -1;
    for (const tile of dom.grid.children) tile.classList.remove('selected');
  }
  for (const tile of dom.grid.children) syncTileLabel(tile, state.photos[Number(tile.dataset.i)]);
  updateSelectionUi();
}

function setSelected(index, on) {
  const photo = state.photos[index];
  if (!photo) return;
  if (on) state.selection.add(photo.key);
  else state.selection.delete(photo.key);

  const tile = dom.grid.children[index];
  if (tile) {
    tile.classList.toggle('selected', on);
    syncTileLabel(tile, photo);
  }
}

function toggleAt(index) {
  const photo = state.photos[index];
  if (!photo) return;
  setSelected(index, !state.selection.has(photo.key));
  state.anchor = index;
  updateSelectionUi();
}

/* Maiusc+clic: estende la selezione dall'ultima foto toccata */
function selectRange(from, to) {
  const [start, end] = from <= to ? [from, to] : [to, from];
  for (let i = start; i <= end; i += 1) setSelected(i, true);
  state.anchor = to;
  updateSelectionUi();
}

function enterSelectionWith(index) {
  if (!state.selecting) setSelecting(true);
  toggleAt(index);
}

/* ------------------------------------------------------------- ZIP e salvataggio */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* Data e ora nel formato MS-DOS usato dallo ZIP */
function dosStamp(date) {
  const d = Number.isNaN(date?.getTime?.()) ? new Date() : (date || new Date());
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/* Archivio senza compressione: i JPEG non si comprimono, quindi si evita di
   dipendere da una libreria esterna e il file esce già pronto. */
function buildZip(entries) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;
    const { time, date } = dosStamp(entry.date);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // nomi in UTF-8
    local.setUint16(8, 0, true);      // metodo 0 = store
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, entry.data);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(10, 0, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, date, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, size, true);
    dir.setUint32(24, size, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name);

    offset += 30 + name.length + size;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

/* Il salvataggio passa da un blob same-origin: l'attributo download viene
   ignorato sulle URL di un altro dominio, quindi il nome del file andrebbe
   perso e la foto si aprirebbe invece di scaricarsi. */
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

let downloadAbort = null;

function showProgress(done, total, bytes, totalBytes) {
  dom.selProgress.hidden = false;
  dom.selFill.style.width = `${totalBytes ? (bytes / totalBytes) * 100 : 0}%`;
  dom.selProgressText.textContent =
    `${done}/${total} foto · ${humanBytes(bytes)} di ${humanBytes(totalBytes)}`;
}

/* Scarica in parallelo mantenendo l'ordine della griglia */
async function fetchAll(photos, signal, onProgress) {
  const results = new Array(photos.length);
  let next = 0;
  let bytes = 0;
  let done = 0;

  const worker = async () => {
    while (next < photos.length) {
      const index = next;
      next += 1;
      const photo = photos[index];
      const res = await fetch(objectUrl(photo), { signal, credentials: 'omit' });
      if (!res.ok) throw new Error(`${photo.name}: il server ha risposto ${res.status}`);
      const data = new Uint8Array(await res.arrayBuffer());
      results[index] = { name: photo.name, data, date: new Date(photo.modified) };
      bytes += data.length;
      done += 1;
      onProgress(done, bytes);
    }
  };

  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, photos.length) }, worker));
  return results;
}

function archiveName(count) {
  const folder = state.source?.prefix ? state.source.prefix.replace(/\/$/, '').split('/').pop() : 'foto';
  return `${folder}-${count}.zip`;
}

async function downloadSelection() {
  if (state.downloading) return;
  const photos = selectedPhotos();
  if (!photos.length) return;

  const totalBytes = photos.reduce((sum, p) => sum + p.size, 0);
  if (totalBytes > ZIP_MAX_BYTES) {
    dom.selProgress.hidden = false;
    dom.selProgressText.textContent =
      `Selezione troppo grande (${humanBytes(totalBytes)}): il limite è ${humanBytes(ZIP_MAX_BYTES)}. Scegline meno.`;
    dom.selFill.style.width = '0';
    dom.selAbort.hidden = true;
    return;
  }

  state.downloading = true;
  downloadAbort = new AbortController();
  dom.selAbort.hidden = false;
  updateSelectionUi();
  showProgress(0, photos.length, 0, totalBytes);

  try {
    const entries = await fetchAll(photos, downloadAbort.signal, (done, bytes) =>
      showProgress(done, photos.length, bytes, totalBytes));

    if (entries.length === 1) {
      saveBlob(new Blob([entries[0].data], { type: 'image/jpeg' }), entries[0].name);
      dom.selProgressText.textContent = `Scaricata ${entries[0].name}`;
    } else {
      dom.selProgressText.textContent = `Preparazione dell'archivio (${humanBytes(totalBytes)})…`;
      /* Un attimo per lasciar disegnare il messaggio prima del lavoro sincrono */
      await new Promise((resolve) => setTimeout(resolve, 30));
      saveBlob(buildZip(entries), archiveName(entries.length));
      dom.selProgressText.textContent = `Archivio pronto: ${entries.length} foto, ${humanBytes(totalBytes)}`;
    }
    dom.selAbort.hidden = true;
  } catch (e) {
    dom.selFill.style.width = '0';
    dom.selAbort.hidden = true;
    dom.selProgressText.textContent = e.name === 'AbortError'
      ? 'Download interrotto.'
      : `Download non riuscito — ${e.message}`;
  } finally {
    state.downloading = false;
    downloadAbort = null;
    updateSelectionUi();
  }
}

/* ----------------------------------------------------------- condivisione */

/* Link alla galleria aperta su questa foto: il deep link #chiave la apre
   direttamente, quindi chi lo riceve vede la foto nel suo contesto */
function shareUrl(photo) {
  const url = new URL(location.href);
  url.hash = encodeURIComponent(photo.key);
  return url.toString();
}

const SHARE_TARGETS = [
  { nome: 'WhatsApp', url: (u, t) => `https://wa.me/?text=${encodeURIComponent(`${t} ${u}`)}` },
  { nome: 'Telegram', url: (u, t) => `https://t.me/share/url?url=${encodeURIComponent(u)}&text=${encodeURIComponent(t)}` },
  { nome: 'Facebook', url: (u) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(u)}` },
  { nome: 'X', url: (u, t) => `https://twitter.com/intent/tweet?url=${encodeURIComponent(u)}&text=${encodeURIComponent(t)}` },
  { nome: 'Email', url: (u, t) => `mailto:?subject=${encodeURIComponent(t)}&body=${encodeURIComponent(u)}` },
];

function closeSharePanel() {
  dom.sharePanel.hidden = true;
  dom.shareCopy.textContent = 'Copia link';
}

function openSharePanel(photo) {
  const url = shareUrl(photo);
  const testo = `Foto ${photo.name}`;

  dom.shareLinks.textContent = '';
  for (const target of SHARE_TARGETS) {
    const link = document.createElement('a');
    link.href = target.url(url, testo);
    link.textContent = target.nome;
    /* Si apre in una scheda nuova: la condivisione la conferma l'utente
       nell'interfaccia del servizio, il sito non pubblica nulla da sé */
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    dom.shareLinks.append(link);
  }

  dom.sharePanel.hidden = false;
  dom.shareCopy.focus({ preventScroll: true });
}

async function shareCurrent() {
  const photo = state.photos[state.index];
  if (!photo) return;
  const url = shareUrl(photo);

  /* Su mobile il pannello di sistema è l'opzione migliore: raggiunge tutte
     le app installate. Altrove si ricade sull'elenco esplicito. */
  if (navigator.share) {
    try {
      await navigator.share({ title: photo.name, text: `Foto ${photo.name}`, url });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // annullata dall'utente
    }
  }
  openSharePanel(photo);
}

/* ------------------------------------------------------------------- zoom */

const ZOOM_MAX = 5;
const ZOOM_DOPPIO_TOCCO = 2.5;
/* Oltre questa scala l'anteprima da 1600 px si vedrebbe sfocata */
const HIRES_TRIGGER = 1.4;
const DOPPIO_TOCCO_MS = 300;
/* Spostamento entro il quale un tocco è un tocco e non un trascinamento */
const TOCCO_FERMO = 20;

const zoom = { scale: 1, x: 0, y: 0 };
/* Dimensioni della foto a scala 1, per limitare lo spostamento */
let fotoBase = { w: 0, h: 0 };
let zoomFrame = 0;
let hiresChiesta = false;
/* Dita (o cursore) attualmente premute sulla foto */
const punti = new Map();
let pinchPrec = null;
let trascinaPrec = null;

const ingrandita = () => zoom.scale > 1.001;

/* Le trasformazioni si applicano una volta per fotogramma: più eventi di
   movimento nello stesso fotogramma non producono lavoro inutile */
function applicaZoom() {
  if (zoomFrame) return;
  zoomFrame = requestAnimationFrame(() => {
    zoomFrame = 0;
    dom.lbZoom.style.transform =
      `translate3d(${zoom.x.toFixed(2)}px, ${zoom.y.toFixed(2)}px, 0) scale(${zoom.scale.toFixed(4)})`;
    dom.lb.classList.toggle('zoomed', ingrandita());
  });
}

function misuraFotoBase() {
  const box = dom.lbImgwrap.getBoundingClientRect();
  const nw = dom.lbImg.naturalWidth || 4;
  const nh = dom.lbImg.naturalHeight || 3;
  const fattore = Math.min(box.width / nw, box.height / nh);
  fotoBase = { w: nw * fattore, h: nh * fattore };
}

/* Impedisce di trascinare la foto fuori dal riquadro; quando è più piccola
   del riquadro la rimette al centro */
function limitaSpostamento() {
  const box = dom.lbImgwrap.getBoundingClientRect();
  const maxX = Math.max(0, (fotoBase.w * zoom.scale - box.width) / 2);
  const maxY = Math.max(0, (fotoBase.h * zoom.scale - box.height) / 2);
  zoom.x = Math.min(maxX, Math.max(-maxX, zoom.x));
  zoom.y = Math.min(maxY, Math.max(-maxY, zoom.y));
}

/* Ingrandisce mantenendo fermo il punto sotto le dita (o sotto il cursore).
   Se p è la posizione sullo schermo rispetto al centro e t lo spostamento
   attuale, il punto resta fermo con t' = p - k·(p − t), dove k è il rapporto
   fra la nuova scala e quella vecchia. */
function zoomVerso(clientX, clientY, fattore) {
  const box = dom.lbImgwrap.getBoundingClientRect();
  const px = clientX - (box.left + box.width / 2);
  const py = clientY - (box.top + box.height / 2);

  const nuova = Math.min(ZOOM_MAX, Math.max(1, zoom.scale * fattore));
  const k = nuova / zoom.scale;
  zoom.x = px - k * (px - zoom.x);
  zoom.y = py - k * (py - zoom.y);
  zoom.scale = nuova;

  limitaSpostamento();
  applicaZoom();
  if (zoom.scale >= HIRES_TRIGGER) caricaHires();
}

function conAnimazione(azione) {
  dom.lbZoom.classList.add('animato');
  azione();
  setTimeout(() => dom.lbZoom.classList.remove('animato'), 260);
}

function azzeraZoom() {
  zoom.scale = 1;
  zoom.x = 0;
  zoom.y = 0;
  hiresChiesta = false;
  if (zoomFrame) { cancelAnimationFrame(zoomFrame); zoomFrame = 0; }
  dom.lbZoom.classList.remove('animato');
  dom.lbZoom.style.transform = 'translate3d(0, 0, 0) scale(1)';
  dom.lb.classList.remove('zoomed', 'hires');
  dom.lbHires.removeAttribute('src');
  punti.clear();
  pinchPrec = null;
  trascinaPrec = null;
}

/* Ingrandendo si carica l'originale dal bucket, alla sua piena risoluzione.
   Si sostituisce in silenzio: entra in dissolvenza sopra l'anteprima, che
   resta opaca sotto, come già avviene fra miniatura e anteprima. */
function caricaHires() {
  const photo = state.photos[state.index];
  if (hiresChiesta || !photo) return;
  hiresChiesta = true;

  const token = state.renderToken;
  const img = new Image();
  img.addEventListener('load', () => {
    /* Se nel frattempo si è cambiata foto, questo risultato non serve più */
    if (token !== state.renderToken) return;
    dom.lbHires.src = img.src;
    dom.lb.classList.add('hires');
  });
  /* Se l'originale non arriva resta l'anteprima: si può ritentare */
  img.addEventListener('error', () => { hiresChiesta = false; });
  img.src = objectUrl(photo);
}

/* -------------------------------------------------------------- lightbox */

function lightboxOpen() {
  return !dom.lb.hidden;
}

function showCurrent() {
  const photo = state.photos[state.index];
  if (!photo) return;

  state.renderToken += 1;
  closeSharePanel();
  azzeraZoom();
  dom.lb.classList.remove('ready', 'lqip');
  dom.lbImg.removeAttribute('src');
  dom.lbPlaceholder.removeAttribute('src');

  /* La miniatura della griglia è già scaricata: la si mostra ingrandita per
     non lasciare lo schermo nero mentre arriva l'anteprima a piena grandezza */
  dom.lbPlaceholder.src = thumbUrl(photo);

  dom.lbImg.alt = photo.name;
  dom.lbImg.src = previewUrl(photo);

  dom.lbName.textContent = photo.name;
  dom.lbCounter.textContent = `${state.index + 1} / ${state.photos.length}`;
  dom.lbDownload.href = objectUrl(photo);
  dom.lbDownload.setAttribute('download', photo.name);

  /* La nota è in un elemento a parte perché su mobile viene nascosta:
     sopra la foto occuperebbe due o tre righe */
  dom.lbInfoMain.textContent = [humanBytes(photo.size), humanDate(photo.modified)]
    .filter(Boolean).join(' · ');
  dom.lbInfoNote.textContent = ' · anteprima ridotta — usa “Scarica” per l’originale';

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
  closeSharePanel();
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
  updateSelectionUi();

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

/* Pressione prolungata: avvia la selezione senza aprire la foto.
   Si annulla se il dito scorre, così lo scorrimento della griglia resta libero. */
let press = null;

function cancelPress() {
  if (press) clearTimeout(press.timer);
  press = null;
}

dom.grid.addEventListener('pointerdown', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile || (e.pointerType === 'mouse' && e.button !== 0)) return;
  cancelPress();
  press = {
    index: Number(tile.dataset.i),
    x: e.clientX,
    y: e.clientY,
    fired: false,
    timer: setTimeout(() => {
      press.fired = true;
      enterSelectionWith(press.index);
    }, LONG_PRESS_MS),
  };
});

dom.grid.addEventListener('pointermove', (e) => {
  if (press && !press.fired && Math.hypot(e.clientX - press.x, e.clientY - press.y) > PRESS_SLOP) {
    cancelPress();
  }
}, { passive: true });

dom.grid.addEventListener('pointercancel', cancelPress);
window.addEventListener('scroll', cancelPress, { passive: true });

dom.grid.addEventListener('click', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile) return;
  const index = Number(tile.dataset.i);

  /* Il clic che segue una pressione prolungata è già stato gestito */
  const wasLongPress = press?.fired;
  cancelPress();
  if (wasLongPress) return;

  if (e.shiftKey && state.selecting && state.anchor >= 0) selectRange(state.anchor, index);
  else if (e.metaKey || e.ctrlKey) enterSelectionWith(index);
  else if (state.selecting) toggleAt(index);
  else openAt(index);
});

/* In modalità selezione il menu contestuale intralcia il tocco prolungato */
dom.grid.addEventListener('contextmenu', (e) => {
  if (state.selecting || press?.fired) e.preventDefault();
});

dom.selectBtn.addEventListener('click', () => setSelecting(!state.selecting));
dom.selCancel.addEventListener('click', () => setSelecting(false));

dom.selAll.addEventListener('click', () => {
  const tutte = state.selection.size === state.photos.length;
  state.photos.forEach((_, i) => setSelected(i, !tutte));
  state.anchor = tutte ? -1 : state.photos.length - 1;
  updateSelectionUi();
});

dom.selDownload.addEventListener('click', downloadSelection);
dom.selAbort.addEventListener('click', () => downloadAbort?.abort());

dom.sort.addEventListener('change', () => {
  state.sort = dom.sort.value;
  const current = state.photos[state.index];
  sortPhotos();
  renderGrid();
  /* Gli indici sono cambiati: l'estremo per Maiusc+clic non vale più */
  state.anchor = -1;
  updateSelectionUi();
  if (lightboxOpen() && current) {
    state.index = state.photos.indexOf(current);
    showCurrent();
  }
});

/* Il pannello compare solo all'avvio, quando manca ?bucket-url= */
function openChangePanel(open) {
  dom.changePanel.hidden = !open;
  if (open) dom.bucketInput.focus();
}

dom.changePanel.addEventListener('submit', (e) => {
  e.preventDefault();
  const value = dom.bucketInput.value.trim();
  if (value) location.search = '?bucket-url=' + encodeURIComponent(value);
});

/* Si attende la decodifica prima di svelarla: al primo fotogramma della
   dissolvenza l'immagine è già pronta da disegnare, quindi non ci sono scatti */
dom.lbImg.addEventListener('load', () => {
  const token = state.renderToken;
  /* Ora si conoscono le proporzioni: servono a limitare lo spostamento */
  misuraFotoBase();
  const reveal = () => {
    if (token === state.renderToken) dom.lb.classList.add('ready');
  };
  if (dom.lbImg.decode) dom.lbImg.decode().then(reveal, reveal);
  else reveal();
});

/* A dissolvenza conclusa la miniatura sotto non serve più */
dom.lbImg.addEventListener('transitionend', (e) => {
  if (e.propertyName === 'opacity' && dom.lb.classList.contains('ready')) {
    dom.lb.classList.remove('lqip');
  }
});

dom.lbPlaceholder.addEventListener('load', () => {
  if (!dom.lb.classList.contains('ready')) dom.lb.classList.add('lqip');
});
dom.lbImg.addEventListener('error', () => {
  const photo = state.photos[state.index];
  /* Se l'anteprima grande non arriva, mostra l'originale */
  if (photo && dom.lbImg.src !== objectUrl(photo)) dom.lbImg.src = objectUrl(photo);
});

/* Su mobile il pulsante mostra solo l'icona: mentre il download è in corso
   (o è fallito) il testo va reso visibile, altrimenti manca ogni riscontro */
function setDownloadLabel(testo, mostraSempre) {
  dom.lbDownloadText.textContent = testo;
  dom.lbDownload.classList.toggle('label-visible', mostraSempre);
}

/* Passa dal blob per lo stesso motivo del download in massa: su un'URL di
   un altro dominio l'attributo download è ignorato e la foto si aprirebbe */
dom.lbDownload.addEventListener('click', async (e) => {
  e.preventDefault();
  const photo = state.photos[state.index];
  if (!photo || dom.lbDownload.dataset.busy) return;

  dom.lbDownload.dataset.busy = '1';
  setDownloadLabel('Attendi…', true);
  try {
    const res = await fetch(objectUrl(photo), { credentials: 'omit' });
    if (!res.ok) throw new Error(String(res.status));
    saveBlob(await res.blob(), photo.name);
    setDownloadLabel('Scarica', false);
  } catch {
    setDownloadLabel('Non riuscito', true);
    setTimeout(() => setDownloadLabel('Scarica', false), 2500);
  } finally {
    delete dom.lbDownload.dataset.busy;
  }
});

dom.lbShare.addEventListener('click', shareCurrent);
dom.shareClose.addEventListener('click', closeSharePanel);

dom.shareCopy.addEventListener('click', async () => {
  const photo = state.photos[state.index];
  if (!photo) return;
  try {
    await navigator.clipboard.writeText(shareUrl(photo));
    dom.shareCopy.textContent = 'Link copiato';
  } catch {
    dom.shareCopy.textContent = 'Copia non riuscita';
  }
});

dom.lbClose.addEventListener('click', () => closeLightbox());
dom.lbPrev.addEventListener('click', () => step(-1));
dom.lbNext.addEventListener('click', () => step(1));

dom.lb.addEventListener('click', (e) => {
  /* Un trascinamento col dito genera comunque un clic: senza questo, uno
     scorrimento troppo corto per cambiare foto chiuderebbe il lightbox */
  if (touchDragged) {
    touchDragged = false;
    return;
  }
  /* Da ingrandita il clic serve allo spostamento, non alla chiusura */
  if (ingrandita()) return;
  if (e.target === dom.lb || e.target === dom.lbStage || e.target.classList.contains('lb-imgwrap')) {
    closeLightbox();
  }
});

document.addEventListener('keydown', (e) => {
  if (!lightboxOpen()) {
    /* Esc esce dalla selezione solo se non c'è una foto aperta davanti */
    if (e.key === 'Escape' && state.selecting && !state.downloading) {
      setSelecting(false);
      e.preventDefault();
    }
    return;
  }
  /* Esc chiude prima il pannello di condivisione, poi la foto */
  if (e.key === 'Escape' && !dom.sharePanel.hidden) { closeSharePanel(); }
  else if (e.key === 'Escape') { closeLightbox(); }
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

/* ------------------------------------------------- gesti sulla foto */

let touchDragged = false;
let ultimoTocco = 0;

/* Distanza e punto medio fra le prime due dita */
function misuraPinch() {
  const [a, b] = [...punti.values()];
  return {
    dist: Math.hypot(b.x - a.x, b.y - a.y),
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
  };
}

/* Rotellina del mouse. Il pizzico sul trackpad di macOS arriva come wheel
   con ctrlKey premuto, con incrementi molto più piccoli. */
dom.lbStage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const intensita = e.ctrlKey ? 0.012 : 0.0022;
  zoomVerso(e.clientX, e.clientY, Math.exp(-e.deltaY * intensita));
}, { passive: false });

/* Il trascinamento nativo dell'immagine va impedito, altrimenti il browser
   prende il controllo del gesto e lo spostamento della foto si interrompe */
dom.lbStage.addEventListener('dragstart', (e) => e.preventDefault());

dom.lbStage.addEventListener('pointerdown', (e) => {
  /* Le frecce gestiscono i propri clic */
  if (e.target.closest('.lb-nav')) return;

  /* Toglie di mezzo trascinamento nativo e selezione: sono loro a far
     arrivare un pointercancel a metà gesto */
  e.preventDefault();

  punti.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });

  if (punti.size === 2) {
    pinchPrec = misuraPinch();
    trascinaPrec = null;
  } else if (punti.size === 1) {
    trascinaPrec = { x: e.clientX, y: e.clientY };
    if (ingrandita()) dom.lb.classList.add('trascina');
  }

  /* Tiene il gesto legato all'area anche se il dito ne esce. Va per ultimo e
     protetto: se fallisse, lo stato del gesto è già pronto e non si perde. */
  try {
    dom.lbStage.setPointerCapture(e.pointerId);
  } catch { /* puntatore non più attivo */ }
});

dom.lbStage.addEventListener('pointermove', (e) => {
  const punto = punti.get(e.pointerId);
  if (!punto) return;          // nessun dito premuto: il mouse si sta solo muovendo
  punto.x = e.clientX;
  punto.y = e.clientY;

  if (punti.size >= 2) {
    const ora = misuraPinch();
    if (pinchPrec && pinchPrec.dist > 0 && ora.dist > 0) {
      zoomVerso(ora.cx, ora.cy, ora.dist / pinchPrec.dist);
      /* Segue anche lo spostamento delle due dita, non solo l'allargamento */
      zoom.x += ora.cx - pinchPrec.cx;
      zoom.y += ora.cy - pinchPrec.cy;
      limitaSpostamento();
      applicaZoom();
    }
    pinchPrec = ora;
  } else if (ingrandita() && trascinaPrec) {
    zoom.x += e.clientX - trascinaPrec.x;
    zoom.y += e.clientY - trascinaPrec.y;
    trascinaPrec = { x: e.clientX, y: e.clientY };
    limitaSpostamento();
    applicaZoom();
  }
});

function finePunto(e) {
  const punto = punti.get(e.pointerId);
  punti.delete(e.pointerId);
  dom.lb.classList.remove('trascina');

  if (punti.size < 2) pinchPrec = null;
  trascinaPrec = punti.size === 1 ? { ...[...punti.values()][0] } : null;
  return punto;
}

dom.lbStage.addEventListener('pointerup', (e) => {
  const punto = finePunto(e);
  if (!punto) return;

  const dx = e.clientX - punto.x0;
  const dy = e.clientY - punto.y0;
  const spostamento = Math.hypot(dx, dy);
  if (spostamento > 10) touchDragged = true;

  /* Doppio tocco (o doppio clic): ingrandisce sul punto toccato, e se già
     ingrandita torna a schermo pieno */
  const adesso = performance.now();
  if (spostamento < TOCCO_FERMO && adesso - ultimoTocco < DOPPIO_TOCCO_MS) {
    ultimoTocco = 0;
    touchDragged = true;      // il clic non deve chiudere il lightbox
    conAnimazione(() => zoomVerso(e.clientX, e.clientY,
      ingrandita() ? 1 / zoom.scale : ZOOM_DOPPIO_TOCCO));
    return;
  }
  ultimoTocco = spostamento < TOCCO_FERMO ? adesso : 0;

  /* Con la foto a schermo pieno lo scorrimento cambia immagine; ingrandita
     serve invece a spostarla, quindi non si naviga */
  if (!ingrandita() && e.pointerType !== 'mouse'
      && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
    step(dx < 0 ? 1 : -1);
  }
});

dom.lbStage.addEventListener('pointercancel', finePunto);

/* Cambiando dimensione della finestra il riquadro cambia: va rimisurato */
window.addEventListener('resize', () => {
  if (!lightboxOpen()) return;
  misuraFotoBase();
  limitaSpostamento();
  applicaZoom();
});

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

  dom.sort.value = state.sort;
  /* Il CSS ne ha bisogno per non ingrandire la miniatura oltre il riquadro
     che occuperà l'anteprima grande */
  document.documentElement.style.setProperty('--preview-width', `${PREVIEW_WIDTH}px`);
  if (raw) dom.bucketInput.value = raw;

  if (raw) load(raw);
  else showWelcome();
})();
