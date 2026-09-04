# I-Sopraelevazione

Web app statica pronta per **GitHub Pages** per confrontare il tabellino di progetto con i grafici di riscontro della sopraelevazione.

![Anteprima interfaccia](preview/anteprima-interfaccia.png)

![Anteprima report](preview/anteprima-report.png)

## Cosa fa

- due aree di caricamento indipendenti e chiaramente riconoscibili;
- **drag & drop**;
- **caricamento multiplo** di più file contemporaneamente;
- tabellini di progetto PDF;
- grafici di riscontro PDF, anche multipli;
- analisi locale nel browser con PDF.js + Tesseract.js;
- lettura della linea di sopraelevazione rispetto alla linea di fede;
- campionamento standard ogni 5 m, modificabile;
- confronto con H di progetto;
- dati aggregati: **una sola segnalazione per curva**;
- per ogni curva viene restituita la **tratta omogenea** relativa al codice di allerta più elevato;
- priorità fissa: **ROSSO > ARANCIO > GIALLO > VERDE**;
- report PDF A4 orizzontale stampabile e leggibile;
- indice di affidabilità complessivo della verifica e affidabilità della singola segnalazione;
- nessun database e nessun backend obbligatorio.

## Codice colori

- **VERDE** `#2E7D32`: conforme;
- **GIALLO** `#F4C430`: scostamento dal progetto `|Δ| >= 10 mm`;
- **ARANCIO** `#EF6C00`: avvicinamento alla zona 159/160 mm quando non previsto dal progetto;
- **ROSSO** `#C62828`: sopraelevazione `> 160 mm`.

I colori sono definiti una sola volta nel codice e sono usati in modo coerente nell'interfaccia e nel PDF.

## Aggregazione degli allarmi

L'app continua a campionare internamente il grafico ogni 5 m, ma non restituisce centinaia di righe.

Per ciascuna curva:

1. individua il livello di allerta più elevato;
2. individua il segmento continuo più rappresentativo con quel codice;
3. restituisce **una sola riga** nel report con inizio/fine tratta, H progetto, H rilevata, Δ massimo, motivo e affidabilità.

## Indice di affidabilità

L'indice combina:

- qualità con cui viene riconosciuta la traccia di sopraelevazione;
- copertura effettiva del confronto tra campioni grafici e progetto.

Classi visualizzate:

- **>= 90%**: Alta;
- **80–89%**: Buona;
- **65–79%**: Da verificare;
- **< 65%**: Bassa.

L'affidabilità **non modifica il codice colore dell'anomalia**: serve a indicare quanto è solida la lettura automatica.

## Pubblicazione su GitHub Pages

1. Crea un repository GitHub, ad esempio `I-Sopraelevazione`.
2. Estrai lo ZIP.
3. Carica **il contenuto della cartella** nella root del repository: `index.html`, `app.js`, `styles.css`, `icon.svg`, ecc.
4. Apri `Settings` → `Pages`.
5. In `Build and deployment` scegli `Deploy from a branch`.
6. Seleziona `main` e `/ (root)`.
7. Salva.

Non servono npm, Vercel o una fase di compilazione.

## File principali

- `index.html` — interfaccia;
- `styles.css` — grafica responsive e stampa;
- `app.js` — caricamento, analisi, aggregazione e report PDF;
- `icon.svg` — icona professionale dell'app;
- `manifest.webmanifest` — installazione come web app;
- `.nojekyll` — pubblicazione diretta su GitHub Pages;
- `preview/` — immagini di anteprima.

## Dipendenze

Le librerie vengono caricate via CDN:

- PDF.js;
- Tesseract.js;
- jsPDF;
- jsPDF AutoTable.

Per questo la pagina richiede connessione a Internet quando viene aperta. I file caricati dall'utente vengono elaborati nel browser dall'app e non è previsto un backend applicativo.

## Nota operativa

La lettura automatica dipende dalla qualità e dalla struttura degli elaborati. L'indice di affidabilità serve proprio a rendere evidente quando una lettura richiede una verifica manuale. Il risultato deve essere validato sull'elaborato originale prima dell'uso operativo.


## Versione 1.1.1 – correzione lettura PDF
- controllo preventivo dei PDF a 0 byte;
- fallback FileReader per browser/ambienti Windows in cui `File.arrayBuffer()` non restituisce correttamente i dati;
- un singolo file non leggibile viene ignorato quando sono presenti altri file validi;
- messaggio di errore con il nome esatto del file problematico;
- stato **Analisi non completata** visualizzato in rosso;
- cache-busting di `app.js` e `styles.css` per facilitare l’aggiornamento su GitHub Pages.

Se compare un avviso **0 byte**, aprire il PDF dal PC e verificare che sia realmente scaricato in locale (non solo disponibile online tramite OneDrive/SharePoint), quindi ricaricarlo nell’app.


## Novità v1.2.0
- restituzione grafica immediata a video dopo l’analisi;
- confronto visuale progetto/riscontro con fasce colorate sulle sole tratte aggregate;
- scorrimento automatico ai risultati a fine analisi;
- tasto **Esporta report PDF** posizionato in fondo alla verifica;
- il PDF include anche la restituzione grafica e l’indice di affidabilità.


## Novità v1.3.0 – lettura tabellino più rapida e verificabile
- Ricerca binaria delle pagine utili del tabellino, invece di OCR esteso su molte pagine.
- OCR di indicizzazione su ritagli ridotti (inizio/fine colonna Progressiva).
- OCR dati limitato alle sole colonne Progressiva e H/rotaia alzata.
- Tentativo prioritario di lettura del text-layer PDF, quando disponibile.
- Dettagli tecnici con pagine effettivamente analizzate, numero di punti progetto, copertura progressiva e massimo intervallo tra punti.
- Lo stato finale mostra quanti punti e quante pagine utili sono stati realmente letti.

## v1.3.2 — lettura tabellino semplificata
- Il tabellino viene usato esclusivamente per estrarre la coppia **Progressiva / H**.
- Prima di leggere i dati, ogni pagina candidata controlla la testata **BINARIO PARI / BINARIO DISPARI**.
- La testata deve coincidere con il selettore dell'app; le pagine dell'altro binario vengono escluse e riportate nei dettagli tecnici.
- Non vengono più lette rotaia alzata o altre colonne del tabellino, riducendo il carico OCR.


## v1.3.2
- Rimosso il pulsante di esportazione PDF.
- Rimane il solo comando **Stampa report**.
- Rimossa la restituzione grafica dai risultati a video e dalla stampa.
- La stampa è ottimizzata in A4 orizzontale e mostra solo sintesi, tratte aggregate, H progetto/rilevata, scostamento, codice colore e affidabilità.
