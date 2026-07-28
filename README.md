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
A galleria aperta si cambia cartella solo modificando l'indirizzo.

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

## Anteprime

Le foto originali possono pesare diversi MB l'una: caricare la griglia a piena
risoluzione consumerebbe centinaia di MB. Le miniature sono quindi **sempre**
generate dal servizio pubblico gratuito [wsrv.nl](https://wsrv.nl) — non è una
scelta esposta all'utente: una foto da 6 MB scende tipicamente sotto i 15 KB
in WebP.

Le anteprime non vengono salvate né nel bucket né nel sito: wsrv.nl le produce al
momento e le serve dalla propria cache (`cache-control: public, max-age=31536000`),
quindi ogni foto viene ridimensionata una sola volta.

Nel lightbox viene mostrata una versione a 1600 px (~75 KB) e il pulsante
**Scarica** punta sempre al file originale nel bucket.

Le anteprime vengono richieste solo quando servono: nulla viene preparato in
anticipo, quindi il proxy non lavora per foto che nessuno apre. La prima richiesta
di ciascuna è la più lenta, perché deve scaricarsi l'originale dal bucket e
ridimensionarlo; dalla seconda in poi risponde dalla cache. L'attesa è coperta dal
fallback qui sotto.

### Fallback progressivo

Aprendo una foto la cui anteprima grande non è ancora pronta, viene mostrata
subito la miniatura della griglia ingrandita — già scaricata, quindi immediata —
sostituita in dissolvenza da quella a piena grandezza appena arriva. Le due
immagini occupano la stessa cella del grid e hanno le stesse proporzioni, quindi
lo scambio non sposta nulla. Lo spinner compare solo se non è disponibile
nemmeno la miniatura.

Se il proxy non risponde, il sito ricade automaticamente sull'immagine originale
del bucket, quindi la galleria resta utilizzabile.

> Nota: gli URL delle foto vengono inviati a wsrv.nl. Non è un problema per un
> bucket già pubblico; per contenuti riservati va cambiata la costante
> `PROXY_BASE` in `assets/app.js` (o servite anteprime proprie).

## Selezione e download in massa

Si entra in modalità selezione tenendo premuto su una foto (450 ms) o col pulsante
**Seleziona**. Poi: tocco singolo per aggiungere e togliere, `Maiusc`+clic per un
intervallo, `Ctrl`/`Cmd`+clic per selezionare senza entrare prima in modalità,
**Seleziona tutte**, `Esc` per uscire. La pressione si annulla se il dito scorre di
più di 10 px, così lo scorrimento della griglia resta libero.

La barra mostra quante foto e quanti MB sono selezionati, con avanzamento e
**Interrompi** durante il download.

### Perché uno ZIP e non tanti download

L'attributo `download` **viene ignorato sulle URL di un altro dominio**: un link
diretto al bucket aprirebbe la foto invece di salvarla, perdendo il nome del file.
In più i browser bloccano o scartano download programmatici ravvicinati.

Poiché il bucket manda `access-control-allow-origin: *`, il sito può invece leggere
i byte con `fetch()`, costruire l'archivio e salvarlo come `blob:` — che è
same-origin, quindi `download` funziona e il nome è quello giusto. Le foto vengono
scaricate 3 alla volta mantenendo l'ordine della griglia.

L'archivio usa il metodo *store* (nessuna compressione: i JPEG non comprimono),
scritto direttamente in `assets/app.js` — nessuna libreria esterna. Con una sola
foto selezionata non crea uno ZIP ma salva il file singolo.

Limite: non è implementato ZIP64, quindi la selezione è rifiutata sopra i 3,5 GB
con un messaggio esplicito. Le foto vengono tenute in memoria mentre l'archivio si
costruisce, quindi selezioni molto grandi consumano RAM in proporzione.

Per lo stesso motivo il pulsante **Scarica** del lightbox passa dal blob: prima
apriva la foto invece di salvarla.

## Condivisione

Nel lightbox il pulsante **Condividi** propone il link alla galleria aperta su
quella foto (`…?bucket-url=…#<chiave>`), che chi lo riceve vede nel contesto della
galleria.

Dove esiste `navigator.share` (mobile, Safari) si apre il pannello di condivisione
di sistema, che raggiunge tutte le app installate. Altrove compare un elenco con
WhatsApp, Telegram, Facebook, X, Email e **Copia link**: sono normali link aperti
in una scheda nuova, quindi la pubblicazione la conferma sempre l'utente
nell'interfaccia del servizio — il sito non pubblica nulla da sé.

## Funzioni della galleria

- ordinamento per data, nome o dimensione — per impostazione predefinita dalle
  più vecchie alle più recenti;
- lightbox con frecce, `←` `→` `Home` `End` `Esc` e swipe su mobile;
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
