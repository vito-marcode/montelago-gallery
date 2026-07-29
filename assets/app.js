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

/* Byte iniziali da leggere per trovare la data di scatto: su questi file ne
   bastano 2 KB, 16 KB è margine. Se non basta si ritenta con 64 KB. */
const EXIF_RANGE = 16 * 1024;
const EXIF_RANGE_FALLBACK = 64 * 1024;
const EXIF_CONCURRENCY = 8;
const EXIF_CACHE = 'gallery:exif:';

const collator = new Intl.Collator('it', { numeric: true, sensitivity: 'base' });

/* Quando la foto è stata scattata. La data del bucket è quella di
   caricamento: se le foto sono state caricate tutte insieme raggruppa male. */
const quando = (photo) => photo.taken || photo.modified;

const el = (id) => document.getElementById(id);
const dom = {
  title: el('title'),
  meta: el('meta'),
  hero: el('hero'),
  heroPhoto: el('hero-photo'),
  heroActions: el('hero-actions'),
  daybar: el('daybar'),
  downloadAll: el('download-all'),
  shareGallery: el('share-gallery'),
  selectBtn: el('select-btn'),
  changePanel: el('change-panel'),
  bucketInput: el('bucket-input'),
  selbar: el('selbar'),
  selCount: el('sel-count'),
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
  lbFav: el('lb-fav'),
  zoombar: el('zoombar'),
  zoomRange: el('zoom-range'),
  zoomVal: el('zoom-val'),
  zoomIn: el('zoom-in'),
  zoomOut: el('zoom-out'),
  filmstrip: el('filmstrip'),
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
  photos: [],        // tutte le foto, ordinate
  /* Foto effettivamente mostrate: coincidono con photos, o con un solo
     giorno quando è attivo un filtro. Griglia e visore lavorano su queste. */
  shown: [],
  giorni: [],        // { chiave, etichetta, count }
  filtro: null,      // chiave del giorno scelto, o null per "Tutte"
  /* Ordinamento fisso, non modificabile dall'interfaccia */
  sort: 'date-asc',
  thumbW: 480,
  index: -1,
  pushedHistory: false,
  /* Identifica la foto in corso di visualizzazione: se si cambia foto prima
     che la precedente sia decodificata, il risultato tardivo va ignorato */
  renderToken: 0,
  /* Chiavi delle foto scelte: sopravvivono al riordino, gli indici no */
  selection: new Set(),
  /* Preferiti: chiavi delle foto col cuore, salvate sul dispositivo */
  favorites: new Set(),
  selecting: false,
  anchor: -1,
  downloading: false,
  /* La striscia di anteprime va ricostruita al prossimo bisogno */
  stripDirty: true,
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
  const photo = state.shown[Number(tile.dataset.i)];
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
    if (field === 'date') {
      const diff = Date.parse(quando(a)) - Date.parse(quando(b));
      /* A parità di istante — tipico quando l'EXIF manca — conta il nome:
         i file numerati seguono l'ordine di scatto */
      return sign * (diff || collator.compare(a.name, b.name));
    }
    if (field === 'size') return sign * (a.size - b.size);
    return sign * collator.compare(a.name, b.name);
  });
}

/* ---------------------------------------------------------- preferiti */

/* Chiave di salvataggio legata alla cartella: due gallerie diverse non si
   mescolano i preferiti */
const FAV_STORE = () => `gallery:fav:${state.source?.objectBase || ''}/${state.source?.prefix || ''}`;
/* Valore speciale del filtro: non è un giorno */
const FILTRO_PREFERITI = 'preferiti';   // le chiavi dei giorni sono AAAA-MM-GG, non collide

function caricaPreferiti() {
  try {
    const salvati = JSON.parse(localStorage.getItem(FAV_STORE()) || '[]');
    if (Array.isArray(salvati)) state.favorites = new Set(salvati);
  } catch { /* niente di salvato o spazio non disponibile */ }
}

function salvaPreferiti() {
  try {
    localStorage.setItem(FAV_STORE(), JSON.stringify([...state.favorites]));
  } catch { /* spazio esaurito: i preferiti restano solo per questa visita */ }
}

/* Cuore nella barra del visore: lo aggiornano sia l'apertura di una foto
   sia il clic sul cuore stesso */
function syncLbFav() {
  const photo = state.shown[state.index];
  if (!photo) return;
  const preferita = state.favorites.has(photo.key);
  dom.lbFav.setAttribute('aria-pressed', String(preferita));
  dom.lbFav.title = preferita ? 'Togli dai preferiti' : 'Aggiungi ai preferiti';
  dom.lbFav.classList.toggle('is-on', preferita);
  dom.lbFav.querySelector('use')?.setAttribute('href', preferita ? '#i-heart-fill' : '#i-heart');
}

function alternaPreferito(index) {
  const photo = state.shown[index];
  if (!photo) return;

  if (state.favorites.has(photo.key)) state.favorites.delete(photo.key);
  else state.favorites.add(photo.key);
  salvaPreferiti();

  const tile = tileAt(index);
  if (tile) {
    tile.classList.toggle('favorita', state.favorites.has(photo.key));
    syncTileLabel(tile, photo);
  }
  renderDaybar();
  if (lightboxOpen()) syncLbFav();

  /* Se si sta guardando solo i preferiti, quella tolta deve sparire */
  if (state.filtro === FILTRO_PREFERITI) applicaFiltro(FILTRO_PREFERITI);
}

/* ------------------------------------------------------- date di scatto */

function leggiAscii(view, offset, lunghezza) {
  let s = '';
  for (let i = 0; i < lunghezza && offset + i < view.byteLength; i += 1) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/* "2026:07:19 22:01:45" — l'EXIF non porta il fuso, quindi va letta come ora
   locale: è il giorno che il fotografo ha vissuto */
function dataDaExif(testo) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(testo || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/* Percorre gli IFD del blocco TIFF cercando DateTimeOriginal (0x9003), con
   DateTime (0x0132) come ripiego */
function leggiTiff(view, start, end) {
  if (start + 8 > end) return null;
  const be = leggiAscii(view, start, 2) === 'MM';
  const u16 = (o) => view.getUint16(o, !be);
  const u32 = (o) => view.getUint32(o, !be);
  if (u16(start + 2) !== 0x2a) return null;

  let risultato = null;
  const ifd = (offset, profondita) => {
    const o = start + offset;
    if (profondita > 2 || o + 2 > end) return;
    const n = u16(o);
    for (let k = 0; k < n; k += 1) {
      const e = o + 2 + k * 12;
      if (e + 12 > end) return;
      const tag = u16(e);
      const cnt = u32(e + 4);
      if (tag === 0x8769) { ifd(u32(e + 8), profondita + 1); continue; }
      if (tag !== 0x9003 && tag !== 0x0132) continue;
      const p = cnt > 4 ? start + u32(e + 8) : e + 8;
      const data = dataDaExif(leggiAscii(view, p, Math.min(20, cnt)));
      /* DateTimeOriginal ha la precedenza su DateTime */
      if (data && (tag === 0x9003 || !risultato)) risultato = data;
    }
  };
  ifd(u32(start + 4), 0);
  return risultato;
}

/* Cerca il segmento APP1/Exif nell'intestazione del JPEG */
function exifDate(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;

  let i = 2;
  while (i + 4 <= view.byteLength) {
    if (view.getUint8(i) !== 0xff) { i += 1; continue; }
    const marker = view.getUint8(i + 1);
    if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
    if (marker === 0xda) break;              // inizia l'immagine: nessun EXIF
    const len = view.getUint16(i + 2);
    if (len < 2) break;
    if (marker === 0xe1 && leggiAscii(view, i + 4, 4) === 'Exif') {
      return leggiTiff(view, i + 10, Math.min(i + 2 + len, view.byteLength));
    }
    i += 2 + len;
  }
  return null;
}

async function scaricaExif(photo, byte) {
  try {
    const res = await fetch(objectUrl(photo), {
      headers: { Range: `bytes=0-${byte - 1}` },
      credentials: 'omit',
    });
    /* Solo una risposta parziale: se il server ignorasse Range arriverebbero
       i megabyte dell'originale, per ogni foto */
    if (res.status !== 206) {
      res.body?.cancel?.();
      return null;
    }
    return exifDate(await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function dataDiScatto(photo) {
  const chiave = `${EXIF_CACHE}${photo.key}:${photo.size}`;
  try {
    const salvata = localStorage.getItem(chiave);
    if (salvata !== null) return salvata === '-' ? null : salvata;
  } catch { /* localStorage non disponibile */ }

  const data = await scaricaExif(photo, EXIF_RANGE)
    || await scaricaExif(photo, EXIF_RANGE_FALLBACK);
  try { localStorage.setItem(chiave, data || '-'); } catch { /* spazio esaurito */ }
  return data;
}

/* Legge le date in parallelo, poi riordina e raggruppa. Si fa dopo il primo
   disegno: i nomi numerati seguono già l'ordine di scatto, quindi la griglia
   non si rimescola, cambiano solo le intestazioni di giornata. */
async function aggiornaDateDiScatto() {
  const daLeggere = state.photos.filter((p) => !p.taken);
  if (!daLeggere.length) return;

  const nota = document.createElement('span');
  nota.className = 'hero-nota';
  dom.meta.append(nota);
  const avanza = (fatte) => { nota.textContent = `date di scatto ${fatte}/${daLeggere.length}`; };
  avanza(0);

  let prossima = 0;
  let fatte = 0;
  const worker = async () => {
    while (prossima < daLeggere.length) {
      const photo = daLeggere[prossima];
      prossima += 1;
      photo.taken = await dataDiScatto(photo);
      fatte += 1;
      avanza(fatte);
    }
  };
  await Promise.all(Array.from({ length: Math.min(EXIF_CONCURRENCY, daLeggere.length) }, worker));
  nota.remove();

  if (!state.photos.some((p) => p.taken)) return;   // nessuna data trovata

  const aperta = lightboxOpen() ? state.shown[state.index] : null;
  sortPhotos();
  raggruppaPerGiorno();
  updateHeader();
  /* Le chiavi dei giorni sono cambiate: il filtro precedente non vale più */
  applicaFiltro(null);
  if (aperta) {
    const i = state.shown.indexOf(aperta);
    if (i >= 0) { state.index = i; showCurrent(); } else closeLightbox();
  }
}

/* ------------------------------------------------------ giorni e copertina */

/* Chiave di giornata nel fuso locale: le date ISO del bucket sono in UTC,
   raggrupparle senza convertirle spezzerebbe le foto serali sul giorno dopo */
function chiaveGiorno(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'senza-data';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function etichettaGiorno(iso, conGiornoSettimana = true) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Senza data';
  const testo = d.toLocaleDateString('it-IT', conGiornoSettimana
    ? { weekday: 'long', day: 'numeric', month: 'long' }
    : { day: 'numeric', month: 'long' });
  return testo.charAt(0).toUpperCase() + testo.slice(1);
}

function raggruppaPerGiorno() {
  const mappa = new Map();
  for (const photo of state.photos) {
    const chiave = chiaveGiorno(quando(photo));
    if (!mappa.has(chiave)) {
      mappa.set(chiave, { chiave, iso: quando(photo), count: 0 });
    }
    mappa.get(chiave).count += 1;
  }
  state.giorni = [...mappa.values()];
}

/* "28 luglio 2026", "27–28 luglio 2026" oppure "29 giugno – 3 luglio 2026" */
function intervalloDate() {
  if (!state.photos.length) return '';
  const date = state.photos.map((p) => new Date(quando(p))).filter((d) => !Number.isNaN(d.getTime()));
  if (!date.length) return '';

  const primo = new Date(Math.min(...date));
  const ultimo = new Date(Math.max(...date));
  const anno = ultimo.getFullYear();

  const stessoGiorno = primo.toDateString() === ultimo.toDateString();
  if (stessoGiorno) return `${etichettaGiorno(primo.toISOString(), false)} ${anno}`;

  if (primo.getMonth() === ultimo.getMonth() && primo.getFullYear() === anno) {
    const mese = ultimo.toLocaleDateString('it-IT', { month: 'long' });
    return `${primo.getDate()}–${ultimo.getDate()} ${mese} ${anno}`;
  }
  return `${etichettaGiorno(primo.toISOString(), false)} – ${etichettaGiorno(ultimo.toISOString(), false)} ${anno}`;
}

/* La prima foto della raccolta fa da copertina */
function impostaCopertina() {
  const photo = state.photos[0];
  if (!photo) return;
  dom.heroPhoto.style.backgroundImage = `url("${proxied(photo, 1600)}")`;
}

function applicaFiltro(chiave) {
  state.filtro = chiave;
  if (chiave === FILTRO_PREFERITI) {
    state.shown = state.photos.filter((p) => state.favorites.has(p.key));
  } else if (chiave) {
    state.shown = state.photos.filter((p) => chiaveGiorno(quando(p)) === chiave);
  } else {
    state.shown = state.photos;
  }
  state.anchor = -1;
  state.stripDirty = true;
  renderDaybar();
  renderGrid();
  updateSelectionUi();
}

function renderDaybar() {
  /* Con un solo giorno il filtro non aggiunge nulla */
  const utile = state.giorni.length > 1;
  dom.daybar.hidden = !utile;
  if (!utile) return;

  dom.daybar.textContent = '';
  const voci = [{ chiave: null, etichetta: 'Tutte', count: state.photos.length }, ...state.giorni.map((g) => ({
    chiave: g.chiave,
    etichetta: etichettaGiorno(g.iso, false),
    count: g.count,
  }))];

  for (const voce of voci) {
    const attiva = state.filtro === voce.chiave;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `btn chip ${attiva ? 'btn-primary' : 'btn-ghost'}`;
    chip.setAttribute('aria-pressed', String(attiva));
    chip.append(document.createTextNode(voce.etichetta));

    const n = document.createElement('span');
    n.className = 'chip-n';
    n.textContent = String(voce.count);
    chip.append(n);

    chip.addEventListener('click', () => applicaFiltro(voce.chiave));
    dom.daybar.append(chip);
  }

  /* Il cuore sta all'altro capo: mostra quanti preferiti e li isola */
  const spazio = document.createElement('span');
  spazio.className = 'daybar-spacer';
  dom.daybar.append(spazio);

  const attivi = state.filtro === FILTRO_PREFERITI;
  const cuore = document.createElement('button');
  cuore.type = 'button';
  cuore.className = `btn chip chip-fav ${attivi ? 'btn-primary' : 'btn-ghost'}`;
  cuore.setAttribute('aria-pressed', String(attivi));
  cuore.setAttribute('aria-label', `Mostra solo i preferiti (${state.favorites.size})`);
  cuore.innerHTML = '';

  const icona = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icona.setAttribute('class', 'icon');
  icona.setAttribute('aria-hidden', 'true');
  const uso = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  uso.setAttribute('href', state.favorites.size ? '#i-heart-fill' : '#i-heart');
  icona.append(uso);
  cuore.append(icona);

  const n = document.createElement('span');
  n.className = 'chip-n';
  n.textContent = String(state.favorites.size);
  cuore.append(n);

  cuore.addEventListener('click', () => {
    applicaFiltro(state.filtro === FILTRO_PREFERITI ? null : FILTRO_PREFERITI);
  });
  dom.daybar.append(cuore);
}

/* ---------------------------------------------------------------- griglia */

/* La griglia contiene anche le intestazioni di giornata, quindi i riquadri
   non coincidono più con i figli: si cercano per indice. */
const tileAt = (i) => dom.grid.querySelector(`.tile[data-i="${i}"]`);
const allTiles = () => dom.grid.querySelectorAll('.tile');

function measureThumbWidth() {
  const probe = dom.grid.querySelector('.tile');
  const cssW = probe ? probe.getBoundingClientRect().width : 220;
  const needed = cssW * Math.min(window.devicePixelRatio || 1, 2);
  return THUMB_STEPS.find((w) => w >= needed) || THUMB_STEPS[THUMB_STEPS.length - 1];
}

/* Occupa tutta la riga della griglia: nome del giorno, quante foto e un filo
   che sfuma verso destra */
function intestazioneGiorno(photo, chiave) {
  const testa = document.createElement('div');
  testa.className = 'day-head';

  const nome = document.createElement('h2');
  nome.className = 'day-name';
  nome.textContent = etichettaGiorno(quando(photo));
  testa.append(nome);

  const n = state.shown.filter((p) => chiaveGiorno(quando(p)) === chiave).length;
  const conteggio = document.createElement('span');
  conteggio.className = 'day-count';
  conteggio.textContent = `${n} foto`;
  testa.append(conteggio);

  const filo = document.createElement('span');
  filo.className = 'day-rule';
  filo.setAttribute('aria-hidden', 'true');
  testa.append(filo);

  return testa;
}

function renderGrid() {
  observer.disconnect();
  dom.grid.textContent = '';

  const frag = document.createDocumentFragment();
  let giornoCorrente = null;

  state.shown.forEach((photo, i) => {
    /* Le foto sono già ordinate per data: basta accorgersi del cambio di
       giorno per inserire l'intestazione al punto giusto */
    const giorno = chiaveGiorno(quando(photo));
    if (giorno !== giornoCorrente) {
      giornoCorrente = giorno;
      frag.append(intestazioneGiorno(photo, giorno));
    }

    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.i = String(i);
    if (state.selection.has(photo.key)) tile.classList.add('selected');

    const img = document.createElement('img');
    img.alt = photo.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    tile.append(img);

    /* Due pulsanti veri e distinti: uno copre il riquadro e apre la foto,
       l'altro è il segno di spunta. Così entrambe le azioni si raggiungono
       anche da tastiera, senza il pulsante "Seleziona" nell'intestazione. */
    const apri = document.createElement('button');
    apri.type = 'button';
    apri.className = 'tile-open';
    tile.append(apri);

    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'tile-check';
    tile.append(check);

    const preferita = state.favorites.has(photo.key);
    if (preferita) tile.classList.add('favorita');

    const cuore = document.createElement('button');
    cuore.type = 'button';
    cuore.className = 'tile-fav';
    const icona = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icona.setAttribute('class', 'icon');
    icona.setAttribute('aria-hidden', 'true');
    const uso = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    uso.setAttribute('href', preferita ? '#i-heart-fill' : '#i-heart');
    icona.append(uso);
    cuore.append(icona);
    tile.append(cuore);

    const label = document.createElement('span');
    label.className = 'tile-label';
    label.textContent = photo.name;
    tile.append(label);

    syncTileLabel(tile, photo);
    frag.append(tile);
  });
  dom.grid.append(frag);

  state.thumbW = measureThumbWidth();
  for (const tile of allTiles()) observer.observe(tile);
}

/* In modalità selezione il riquadro è un interruttore, altrimenti apre la foto */
function syncTileLabel(tile, photo) {
  const apri = tile.querySelector('.tile-open');
  const check = tile.querySelector('.tile-check');
  if (!apri || !check) return;

  const scelta = state.selection.has(photo.key);
  const azione = `${scelta ? 'Deseleziona' : 'Seleziona'} ${photo.name}`;

  check.setAttribute('aria-pressed', String(scelta));
  check.setAttribute('aria-label', azione);

  const cuore = tile.querySelector('.tile-fav');
  if (cuore) {
    const preferita = state.favorites.has(photo.key);
    cuore.setAttribute('aria-pressed', String(preferita));
    cuore.setAttribute('aria-label',
      `${preferita ? 'Togli dai preferiti' : 'Aggiungi ai preferiti'}: ${photo.name}`);
    cuore.querySelector('use')?.setAttribute('href', preferita ? '#i-heart-fill' : '#i-heart');
  }

  if (state.selecting) {
    apri.setAttribute('aria-pressed', String(scelta));
    apri.setAttribute('aria-label', azione);
  } else {
    apri.removeAttribute('aria-pressed');
    apri.setAttribute('aria-label', `Apri ${photo.name}`);
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

  dom.selCount.textContent = chosen.length
    ? `${chosen.length} ${chosen.length === 1 ? 'foto' : 'foto'} · ${humanBytes(bytes)}`
    : 'Nessuna foto selezionata';
  dom.selDownload.disabled = !chosen.length || state.downloading;
  dom.selDownloadText.textContent = chosen.length ? `Scarica (${chosen.length})` : 'Scarica';
  /* Riga di stato: durante il download la riscrive showProgress */
  if (!state.downloading) {
    dom.selProgressText.textContent = chosen.length
      ? 'Pronte per il download'
      : 'Tocca il segno di spunta su una foto, o tienila premuta';
  }
  dom.selAll.textContent = chosen.length === state.shown.length ? 'Deseleziona tutte' : 'Seleziona tutte';
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
    for (const tile of allTiles()) tile.classList.remove('selected');
  }
  for (const tile of allTiles()) syncTileLabel(tile, state.shown[Number(tile.dataset.i)]);
  updateSelectionUi();
}

function setSelected(index, on) {
  const photo = state.shown[index];
  if (!photo) return;
  if (on) state.selection.add(photo.key);
  else state.selection.delete(photo.key);

  const tile = tileAt(index);
  if (tile) {
    tile.classList.toggle('selected', on);
    syncTileLabel(tile, photo);
  }
}

function toggleAt(index) {
  const photo = state.shown[index];
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
      results[index] = { name: photo.name, data, date: new Date(quando(photo)) };
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
    /* Pulsanti del design system, non link nudi */
    link.className = 'btn btn-secondary';
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
  const photo = state.shown[state.index];
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
    /* Tiene allineata la barra dello zoom, da qualunque gesto arrivi */
    const percento = Math.round(zoom.scale * 100);
    dom.zoomVal.textContent = `${percento}%`;
    dom.zoomRange.value = String(percento);
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
  /* Anche i comandi tornano a 100%: qui si salta applicaZoom, che di solito
     è il punto in cui la barra si riallinea */
  dom.zoomVal.textContent = '100%';
  dom.zoomRange.value = '100';
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
  const photo = state.shown[state.index];
  if (hiresChiesta || !photo) return;
  hiresChiesta = true;

  const token = state.renderToken;
  const img = new Image();
  img.addEventListener('load', () => {
    /* Se nel frattempo si è cambiata foto, questo risultato non serve più */
    if (token !== state.renderToken) return;
    dom.lbHires.src = img.src;
    dom.lb.classList.add('hires');
    dom.lbInfoNote.textContent = ' · originale a piena risoluzione';
  });
  /* Se l'originale non arriva resta l'anteprima: si può ritentare */
  img.addEventListener('error', () => { hiresChiesta = false; });
  img.src = objectUrl(photo);
}

/* ----------------------------------------------------- barra dello zoom */

/* Il centro dell'area della foto: i comandi ingrandiscono da lì, non dal
   punto in cui si è cliccato */
function centroFoto() {
  const box = dom.lbImgwrap.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

function zoomAScala(nuova) {
  const c = centroFoto();
  zoomVerso(c.x, c.y, Math.max(1, nuova) / zoom.scale);
}

dom.zoomIn.addEventListener('click', () => {
  const c = centroFoto();
  conAnimazione(() => zoomVerso(c.x, c.y, 1.4));
});

dom.zoomOut.addEventListener('click', () => {
  const c = centroFoto();
  conAnimazione(() => zoomVerso(c.x, c.y, 1 / 1.4));
});

dom.zoomRange.addEventListener('input', () => {
  zoomAScala(Number(dom.zoomRange.value) / 100);
});

/* ------------------------------------------------- striscia di anteprime */

function renderFilmstrip() {
  dom.filmstrip.textContent = '';
  if (state.shown.length < 2) return;

  const frag = document.createDocumentFragment();
  state.shown.forEach((photo, i) => {
    const voce = document.createElement('button');
    voce.type = 'button';
    voce.className = 'strip-item';
    voce.dataset.i = String(i);
    voce.setAttribute('aria-label', photo.name);

    const img = document.createElement('img');
    /* Stessa misura della griglia: le anteprime sono già in cache */
    img.src = thumbUrl(photo);
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    voce.append(img);

    frag.append(voce);
  });
  dom.filmstrip.append(frag);
}

/* Evidenzia la corrente e la porta in vista */
function syncFilmstrip() {
  const voci = dom.filmstrip.children;
  for (const voce of voci) voce.classList.remove('corrente');
  const attuale = voci[state.index];
  if (!attuale) return;
  attuale.classList.add('corrente');
  attuale.scrollIntoView({ inline: 'center', block: 'nearest' });
}

dom.filmstrip.addEventListener('click', (e) => {
  const voce = e.target.closest('.strip-item');
  if (voce) openAt(Number(voce.dataset.i));
});

/* -------------------------------------------------------------- lightbox */

function lightboxOpen() {
  return !dom.lb.hidden;
}

function showCurrent() {
  const photo = state.shown[state.index];
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
  dom.lbCounter.textContent = `${state.index + 1} / ${state.shown.length}`;
  dom.lbDownload.href = objectUrl(photo);
  dom.lbDownload.setAttribute('download', photo.name);

  /* La nota è in un elemento a parte perché su mobile viene nascosta:
     sopra la foto occuperebbe due o tre righe */
  dom.lbInfoMain.textContent = [humanBytes(photo.size), humanDate(quando(photo))]
    .filter(Boolean).join(' · ');
  /* La nota cambia quando arriva l'originale */
  dom.lbInfoNote.textContent = ' · anteprima ridotta — usa “Scarica” per l’originale';

  syncLbFav();
  syncFilmstrip();

  const single = state.shown.length < 2;
  dom.lbPrev.hidden = single;
  dom.lbNext.hidden = single;
}

function openAt(index, { fromHistory = false } = {}) {
  /* La striscia si costruisce alla prima apertura, non all'avvio: se il
     visore non viene mai aperto non serve */
  if (state.stripDirty) {
    renderFilmstrip();
    state.stripDirty = false;
  }
  if (!state.shown.length) return;
  state.index = ((index % state.shown.length) + state.shown.length) % state.shown.length;

  const wasOpen = lightboxOpen();
  dom.lb.hidden = false;
  document.body.style.overflow = 'hidden';
  showCurrent();
  if (!wasOpen) dom.lbClose.focus({ preventScroll: true });

  const hash = '#' + encodeURIComponent(state.shown[state.index].key);
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

  /* Il riquadro è un contenitore: il focus torna al pulsante che apre */
  const apri = tileAt(state.index)?.querySelector('.tile-open');
  if (apri) apri.focus({ preventScroll: true });

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

  /* Voci in elementi separati: il separatore lo disegna il CSS, non è un
     carattere dentro al testo */
  dom.meta.textContent = '';
  for (const voce of [`${n} foto`, humanBytes(totalBytes), intervalloDate()].filter(Boolean)) {
    const s = document.createElement('span');
    s.textContent = voce;
    dom.meta.append(s);
  }

  dom.title.textContent = state.source.prefix
    ? state.source.prefix.replace(/\/$/, '').split('/').pop()
    : 'Galleria foto';
  document.title = `${dom.title.textContent} · ${n} foto`;
  dom.heroActions.hidden = n === 0;

  const origine = `${state.source.objectBase}/${state.source.prefix}`;
  dom.footerSource.textContent = `Origine: ${origine}`;
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
        state.shown = photos;
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
    state.shown = [];
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
  raggruppaPerGiorno();
  dom.status.hidden = true;
  dom.error.hidden = true;
  updateHeader();
  impostaCopertina();
  caricaPreferiti();
  /* Nessun filtro all'avvio: mostra tutte e disegna la barra dei giorni */
  applicaFiltro(null);

  /* Apertura diretta di una foto condivisa via #chiave */
  const hash = location.hash.slice(1);
  if (hash) {
    let key;
    try { key = decodeURIComponent(hash); } catch { key = hash; }
    const i = state.shown.findIndex((p) => p.key === key);
    if (i >= 0) openAt(i, { fromHistory: true });
  }

  /* Le date di scatto arrivano dopo: la griglia è già visibile e sarà
     riordinata e ri-raggruppata quando la lettura finisce */
  aggiornaDateDiScatto();
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

  /* Il cuore e il segno di spunta agiscono sempre, anche fuori dalla
     modalità selezione, e non aprono la foto */
  if (e.target.closest('.tile-fav')) { alternaPreferito(index); return; }
  if (e.target.closest('.tile-check')) { enterSelectionWith(index); return; }

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

/* "Scarica tutto" sceglie tutte le foto mostrate e apre il pannello, senza
   partire da sé: con centinaia di originali conviene che la mole sia visibile
   prima di confermare */
dom.downloadAll.addEventListener('click', () => {
  if (!state.shown.length) return;
  setSelecting(true);
  state.shown.forEach((_, i) => setSelected(i, true));
  state.anchor = state.shown.length - 1;
  updateSelectionUi();
  dom.selDownload.focus({ preventScroll: true });
});

/* Condivide la galleria, non una singola foto: stesso indirizzo senza #chiave */
dom.shareGallery.addEventListener('click', async () => {
  const url = location.origin + location.pathname + location.search;
  const titolo = dom.title.textContent;
  if (navigator.share) {
    try {
      await navigator.share({ title: titolo, text: `Galleria ${titolo}`, url });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    dom.shareGallery.querySelector('span').textContent = 'Link copiato';
    setTimeout(() => { dom.shareGallery.querySelector('span').textContent = 'Condividi'; }, 2500);
  } catch { /* niente appunti disponibili */ }
});

dom.selAll.addEventListener('click', () => {
  const tutte = state.selection.size === state.shown.length;
  state.shown.forEach((_, i) => setSelected(i, !tutte));
  state.anchor = tutte ? -1 : state.shown.length - 1;
  updateSelectionUi();
});

dom.selDownload.addEventListener('click', downloadSelection);
dom.selAbort.addEventListener('click', () => downloadAbort?.abort());

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
  const photo = state.shown[state.index];
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
  const photo = state.shown[state.index];
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
dom.lbFav.addEventListener('click', () => alternaPreferito(state.index));
dom.shareClose.addEventListener('click', closeSharePanel);

dom.shareCopy.addEventListener('click', async () => {
  const photo = state.shown[state.index];
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
  else if (e.key === 'End') { openAt(state.shown.length - 1); }
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
  if (e.target.closest('.zoombar')) return;
  e.preventDefault();
  const intensita = e.ctrlKey ? 0.012 : 0.0022;
  zoomVerso(e.clientX, e.clientY, Math.exp(-e.deltaY * intensita));
}, { passive: false });

/* Il trascinamento nativo dell'immagine va impedito, altrimenti il browser
   prende il controllo del gesto e lo spostamento della foto si interrompe */
dom.lbStage.addEventListener('dragstart', (e) => e.preventDefault());

dom.lbStage.addEventListener('pointerdown', (e) => {
  /* Le frecce gestiscono i propri clic */
  if (e.target.closest('.lb-nav') || e.target.closest('.zoombar')) return;

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
  dom.heroActions.hidden = true;
  dom.daybar.hidden = true;
  openChangePanel(true);
}

(function init() {
  const params = new URLSearchParams(location.search);
  const raw = (params.get('bucket-url') || params.get('bucket') || DEFAULT_BUCKET_URL).trim();

  /* Il CSS ne ha bisogno per non ingrandire la miniatura oltre il riquadro
     che occuperà l'anteprima grande */
  document.documentElement.style.setProperty('--preview-width', `${PREVIEW_WIDTH}px`);
  if (raw) dom.bucketInput.value = raw;

  if (raw) load(raw);
  else showWelcome();
})();
