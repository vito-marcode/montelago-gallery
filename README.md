# Galleria foto da bucket S3

Sito statico (HTML + CSS + JS, nessun build, nessun backend) che legge l'elenco
delle foto contenute in una cartella di un bucket S3 pubblico e le mostra in una
galleria con lightbox.

## Uso

Apri il sito passando la cartella del bucket nel parametro `bucket-url`:

```
https://<utente>.github.io/montelago-gallery/?bucket-url=https://s3.cubbit.eu/montelago/foto/
```

Senza parametro viene usata la cartella predefinita impostata in
`assets/app.js` (`DEFAULT_BUCKET_URL`). Dall'interfaccia, il pulsante
**Cambia cartella** permette di inserire un altro indirizzo.

Sono accettati entrambi gli stili di indirizzo S3:

| stile | esempio |
| --- | --- |
| path-style | `https://s3.cubbit.eu/montelago/foto/` |
| virtual-hosted | `https://montelago.s3.cubbit.eu/foto/` |

## Come funziona

1. Il browser chiama `ListObjectsV2` sul bucket
   (`?list-type=2&prefix=foto/`), seguendo la paginazione fino alla fine.
2. Dai risultati tiene solo i file immagine (`jpg png gif webp avif bmp tiff heic`).
3. Le anteprime vengono caricate solo quando entrano nella viewport
   (`IntersectionObserver`).

### Requisiti sul bucket

- **lettura pubblica degli oggetti** (`s3:GetObject`);
- **elenco pubblico dei file** (`s3:ListBucket`);
- **CORS** che consenta `GET` dall'origine del sito. Regola minima:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"]
  }
]
```

Se manca uno dei tre requisiti la galleria mostra un messaggio d'errore che
spiega quale.

## Anteprime leggere

Le foto originali possono pesare diversi MB l'una: caricare la griglia a piena
risoluzione consumerebbe centinaia di MB. Per questo l'opzione **Anteprime
leggere** (attiva per impostazione predefinita) genera le miniature tramite il
servizio pubblico gratuito [wsrv.nl](https://wsrv.nl) — nell'esempio del bucket
`montelago` una foto passa da ~6,6 MB a ~10 KB in WebP.

Nel lightbox viene mostrata una versione a 1600 px (~75 KB) e il pulsante
**Scarica** punta sempre al file originale nel bucket.

Disattivando l'opzione nessuna richiesta passa da terze parti e le immagini
arrivano direttamente dal bucket a piena risoluzione. La scelta viene
ricordata nel browser. Se il proxy non risponde, il sito ricade
automaticamente sull'immagine originale.

> Nota: gli URL delle foto vengono inviati a wsrv.nl quando l'opzione è attiva.
> Non è un problema per un bucket già pubblico; per contenuti riservati va
> disattivata (o cambiata la costante `PROXY_BASE`).

## Funzioni della galleria

- ordinamento per nome, data o dimensione;
- lightbox con frecce, `←` `→` `Home` `End` `Esc`, swipe su mobile e
  precaricamento delle foto adiacenti;
- link diretto a una singola foto tramite `#<chiave>`
  (il tasto *indietro* chiude il lightbox);
- tema chiaro/scuro automatico, layout responsive.

## Pubblicazione su GitHub Pages

Il repository non richiede build. In *Settings → Pages* seleziona
**Deploy from a branch**, branch `main`, cartella `/ (root)`.

## File

```
index.html         markup della pagina
assets/style.css   stili
assets/app.js      lettura del bucket, griglia, lightbox
```
