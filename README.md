# Galleria foto da bucket S3

Sito statico (HTML + CSS + JS, nessun build, nessun backend) che legge l'elenco
delle foto contenute in una cartella di un bucket S3 pubblico e le mostra in una
galleria con lightbox.

## Uso

Apri il sito passando la cartella del bucket nel parametro `bucket-url`:

```
https://<utente>.github.io/<repo>/?bucket-url=https://s3.example.com/mio-bucket/foto/
```

Senza parametro il sito chiede l'indirizzo della cartella da mostrare. È possibile
impostarne uno predefinito nella costante `DEFAULT_BUCKET_URL` in `assets/app.js`.
A galleria aperta, il pulsante **Cambia cartella** permette di passare a un altro
indirizzo.

Sono accettati entrambi gli stili di indirizzo S3:

| stile | esempio |
| --- | --- |
| path-style | `https://s3.example.com/mio-bucket/foto/` |
| virtual-hosted | `https://mio-bucket.s3.example.com/foto/` |

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
servizio pubblico gratuito [wsrv.nl](https://wsrv.nl): una foto da 6 MB scende
tipicamente sotto i 15 KB in WebP.

Le anteprime non vengono salvate né nel bucket né nel sito: wsrv.nl le produce al
momento e le serve dalla propria cache (`cache-control: public, max-age=31536000`),
quindi ogni foto viene ridimensionata una sola volta.

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
