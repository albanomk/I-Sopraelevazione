# I-Sopraelevazione v1.5.0

## Modifica principale

Il tabellino di progetto viene **pre-elaborato appena caricato**. L’app estrae e valida una sola volta le coppie **Progressiva / H**, conserva il dataset in memoria e, quando premi **Analizza sopraelevazione**, non rilegge più il tabellino: legge i grafici e confronta i valori con il dataset già pronto.

Per i tabellini scansiti l’OCR lavora soltanto su due strisce strette (Progressiva e H/rotaia) ad alta risoluzione, invece di tentare di interpretare l’intera pagina.

### Uso consigliato
1. Seleziona il binario (predefinito: **Dispari**).
2. Carica il tabellino e attendi lo stato **VALIDATO**.
3. Apri “Controlla un campione dei dati estratti” e verifica alcune righe.
4. Carica i grafici di riscontro.
5. Premi **Analizza sopraelevazione**.

Se cambi Pari/Dispari, il tabellino viene rielaborato automaticamente. Nei PDF scansiti molto lunghi la prima indicizzazione può richiedere qualche minuto; i confronti successivi non ripetono l’OCR.

---


Web app statica pronta per **GitHub Pages** per confrontare il tabellino di progetto con i grafici di riscontro della sopraelevazione.


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
- report sintetico stampabile (anche in PDF tramite la finestra di stampa);
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




## Versione 1.5.0 – lettura grafico ad alta precisione

- rasterizzazione dei grafici a **3×**: la risoluzione verticale passa indicativamente da circa 1,06 mm/pixel a circa **0,71 mm/pixel** sulla scala 1:6;
- la quota **0** non viene più presa direttamente dalla baseline testuale `0.0`: viene ricalibrata sulla linea fisica del grafico;
- quando sono disponibili tacche numeriche coerenti sul PDF, la conversione **pixel → mm** viene ulteriormente calibrata sui riferimenti stampati;
- la sopraelevazione viene inseguita su una **maglia densa ogni 3 pixel**, non soltanto alle progressive di campionamento;
- nuovo inseguimento **bidirezionale** con beam search: più possibili tracce vengono mantenute contemporaneamente e confrontate da sinistra→destra e destra→sinistra;
- griglia, linea di fede e altre rette orizzontali vengono riconosciute tramite **persistenza orizzontale** e fortemente penalizzate;
- se una direzione cade sulla linea di fede e l’altra continua sulla curva, viene preferita la traccia coerente lontana dallo zero;
- un breve occultamento può essere attraversato per continuità senza inventare un valore;
- soprattutto, **H ≈ 0 non viene più accettata automaticamente**: deve essere confermata dalla geometria di ingresso/uscita della curva oppure dalla coerenza con un vero tratto a zero. Se non è distinguibile dalla linea di fede, il campione viene escluso come ambiguo invece di generare una falsa segnalazione a 0;
- la diagnostica riporta quanti punti prossimi a zero sono stati esclusi, ricostruiti o realmente validati.

La scelta è volutamente conservativa: tra “inventare H=0” e non usare un campione graficamente ambiguo, la v1.5.0 sceglie il secondo comportamento.

## Versione 1.4.2 – lettura completa dei punti H

- il tabellino scansito non viene più letto come due colonne continue: viene prima individuata la **griglia fisica della tabella**;
- ogni riga viene isolata e ripulita da bordi e sfondi colorati prima dell’OCR, mantenendo l’associazione esatta **Progressiva ↔ H**;
- le celle Progressiva e H che risultano presenti graficamente ma non lette al primo passaggio vengono sottoposte a una **seconda lettura mirata cella per cella**;
- recupero più robusto delle progressive quando il `+` o il punto decimale vengono letti male (es. `0+176.749`, `0#176749`, separatore perso);
- le pagine con una lettura testuale solo parziale non vengono più considerate complete: vengono integrate con l’OCR a griglia;
- la diagnostica riporta anche quante celle sono state recuperate al secondo passaggio.

## Versione 1.4.1 – inseguimento continuo della linea

- la linea di sopraelevazione viene seguita per continuità geometrica da sinistra a destra;
- una perdita di traccia non viene più convertita automaticamente in `H = 0`; il campione viene escluso oppure ricostruito solo per brevi interruzioni con traccia valida ai due lati;
- brevi sovrapposizioni/intersezioni con la linea di fede vengono interpolate senza far cadere artificialmente la misura a zero;
- le linee orizzontali persistenti (griglia/fede) sono penalizzate per evitare che il tracciatore vi si agganci;
- la finestra verticale di ricerca copre circa 190 mm, così da non perdere quote elevate;
- il valore di progetto viene usato solo come indizio debole per scegliere la traccia corretta, senza imporre il valore rilevato.


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


## v1.3.3 — fix tabellino RFI scansito
- Corretto il reset della whitelist OCR prima del riconoscimento BINARIO PARI/DISPARI (causa principale dell'errore “non sono stati riconosciuti abbastanza punti Progressiva/H”).
- Corretto l'inizio della metà DISPARI nei PDF con copertina + due sezioni simmetriche (nel file da 101 pagine: DISPARI da pagina 52).
- Indicizzazione Progressiva più robusta con OCR sparse-text a risoluzione maggiore.
- Lettura Progressiva/H a risoluzione maggiore, colonna H ricalibrata e associazione per coordinata verticale.
- Diagnostica per pagina con conteggi Progressiva, H e coppie riconosciute.
