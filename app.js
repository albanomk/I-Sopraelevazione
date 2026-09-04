/* I-Sopraelevazione v1.5.0 - static GitHub Pages app
   Architettura: il tabellino viene pre-elaborato appena caricato e trasformato
   in un dataset Progressiva/H riutilizzato durante il confronto.
   Motore client-side: PDF.js + Tesseract.js.
   Nessun file viene inviato a un server dall'applicazione. */

(() => {
  'use strict';

  const COLORS = Object.freeze({
    green: '#2E7D32',
    yellow: '#F4C430',
    orange: '#EF6C00',
    red: '#C62828'
  });

  const state = {
    projectFiles: [],
    graphFiles: [],
    projectDataset: [],
    projectStats: null,
    projectStatus: 'idle', // idle | processing | ready | error
    projectError: '',
    projectJobSeq: 0,
    samples: [],
    alerts: [],
    curves: [],
    diagnostics: [],
    graphRanges: [],
    reliability: { score: null, label: 'Da calcolare', trace: 0, coverage: 0 },
    projectAudit: { files: 0, indexPages: [], parsedPages: [], candidatePages: [], points: 0, coverageMin: null, coverageMax: null, maxGap: null, trackChecks: [] }
  };

  const $ = (id) => document.getElementById(id);
  const ui = {
    projectInput: $('projectInput'), projectDrop: $('projectDrop'), projectFiles: $('projectFiles'), projectCount: $('projectCount'),
    graphInput: $('graphInput'), graphDrop: $('graphDrop'), graphFiles: $('graphFiles'), graphCount: $('graphCount'),
    analyzeBtn: $('analyzeBtn'), resetBtn: $('resetBtn'), trackSelect: $('trackSelect'), stepSelect: $('stepSelect'),
    orangeInput: $('orangeInput'), yellowInput: $('yellowInput'), statusTitle: $('statusTitle'), statusText: $('statusText'),
    progressWrap: $('progressWrap'), progressBar: $('progressBar'), progressLabel: $('progressLabel'), progressValue: $('progressValue'),
    resultsSection: $('resultsSection'), alertsBody: $('alertsBody'), allOk: $('allOk'), diagnostics: $('diagnostics'),
    curvesTotal: $('curvesTotal'), alertsTotal: $('alertsTotal'), redTotal: $('redTotal'), orangeTotal: $('orangeTotal'), yellowTotal: $('yellowTotal'),
    printBtn: $('printBtn'), statusLed: $('statusLed'),
    reliabilityScore: $('reliabilityScore'), reliabilityLabel: $('reliabilityLabel'), reliabilityBar: $('reliabilityBar'), reliabilityHint: $('reliabilityHint'),
    overallReliabilityTop: $('overallReliabilityTop'), overallReliabilityPill: $('overallReliabilityPill'),
    projectJobPanel: $('projectJobPanel'), projectJobBadge: $('projectJobBadge'), projectJobTitle: $('projectJobTitle'),
    projectJobText: $('projectJobText'), projectJobProgress: $('projectJobProgress'), projectJobProgressBar: $('projectJobProgressBar'),
    projectJobProgressLabel: $('projectJobProgressLabel'), projectMetricPoints: $('projectMetricPoints'),
    projectMetricFrom: $('projectMetricFrom'), projectMetricTo: $('projectMetricTo'), projectMetricH: $('projectMetricH'),
    projectPreviewBody: $('projectPreviewBody'), projectRetryBtn: $('projectRetryBtn')
  };

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  function fmtSize(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function fileKey(file) { return `${file.name}|${file.size}|${file.lastModified}`; }
  function validProject(file) { return file.type === 'application/pdf' || /\.pdf$/i.test(file.name); }
  function validGraph(file) { return file.type === 'application/pdf' || /^image\/(png|jpeg)$/.test(file.type) || /\.(pdf|png|jpe?g)$/i.test(file.name); }

  function addFiles(kind, list) {
    const arr = kind === 'project' ? state.projectFiles : state.graphFiles;
    const valid = kind === 'project' ? validProject : validGraph;
    const existing = new Set(arr.map(fileKey));
    let added = false;
    for (const file of Array.from(list || [])) {
      if (valid(file) && !existing.has(fileKey(file))) {
        arr.push(file); existing.add(fileKey(file)); added = true;
      }
    }
    renderFileList(kind);
    if (kind === 'project' && added) startProjectPreprocessing();
    else updateReadyState();
  }

  function renderFileList(kind) {
    const arr = kind === 'project' ? state.projectFiles : state.graphFiles;
    const wrap = kind === 'project' ? ui.projectFiles : ui.graphFiles;
    const count = kind === 'project' ? ui.projectCount : ui.graphCount;
    count.textContent = `${arr.length} file`;
    wrap.innerHTML = '';
    arr.forEach((file, index) => {
      const row = document.createElement('div'); row.className = 'file-row';
      const meta = document.createElement('div'); meta.className = 'file-meta';
      const name = document.createElement('div'); name.className = 'file-name'; name.textContent = file.name;
      const size = document.createElement('div'); size.className = 'file-size'; size.textContent = fmtSize(file.size);
      const remove = document.createElement('button'); remove.className = 'file-remove'; remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Rimuovi ${file.name}`);
      remove.addEventListener('click', () => {
        arr.splice(index, 1); renderFileList(kind);
        if (kind === 'project') startProjectPreprocessing(); else updateReadyState();
      });
      meta.append(name, size); row.append(meta, remove); wrap.append(row);
    });
  }

  function updateReadyState() {
    const projectReady = state.projectStatus === 'ready' && state.projectDataset.length > 0;
    const ready = projectReady && state.graphFiles.length > 0;
    ui.analyzeBtn.disabled = !ready;
    ui.statusLed.classList.remove('done', 'error');
    ui.statusLed.classList.toggle('ready', ready);

    if (state.projectStatus === 'processing') {
      ui.statusTitle.textContent = 'Preparazione tabellino in corso';
      ui.statusText.textContent = 'Estraggo Progressiva e H una sola volta. Nei PDF scansiti la prima elaborazione può richiedere qualche minuto.';
      return;
    }
    if (state.projectStatus === 'error') {
      ui.statusTitle.textContent = 'Tabellino non validato';
      ui.statusText.textContent = state.projectError || 'Rielabora il tabellino o verifica il binario selezionato.';
      ui.statusLed.classList.add('error');
      return;
    }
    if (!state.projectFiles.length) {
      ui.statusTitle.textContent = 'In attesa del tabellino';
      ui.statusText.textContent = 'Carica almeno un tabellino di progetto.';
      return;
    }
    if (!state.graphFiles.length) {
      ui.statusTitle.textContent = 'Tabellino pronto';
      ui.statusText.textContent = `${state.projectDataset.length} punti progetto validati. Ora carica almeno un grafico.`;
      return;
    }
    ui.statusTitle.textContent = 'Pronto per l’analisi';
    ui.statusText.textContent = `${state.projectDataset.length} punti progetto già preparati · ${state.graphFiles.length} grafico/i caricati.`;
  }

  function wireDropzone(kind, drop, input) {
    input.addEventListener('change', (e) => { addFiles(kind, e.target.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(evt => drop.addEventListener(evt, e => { e.preventDefault(); drop.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach(evt => drop.addEventListener(evt, e => { e.preventDefault(); drop.classList.remove('dragover'); }));
    drop.addEventListener('drop', e => addFiles(kind, e.dataTransfer.files));
  }

  function setProgress(pct, label) {
    const value = Math.max(0, Math.min(100, Math.round(pct)));
    ui.progressWrap.hidden = false; ui.progressBar.style.width = `${value}%`; ui.progressValue.textContent = `${value}%`; ui.progressLabel.textContent = label;
  }

  function hideProgress() { ui.progressWrap.hidden = true; }


  function setProjectJobProgress(pct, label) {
    const value = Math.max(0, Math.min(100, Math.round(pct)));
    ui.projectJobPanel.hidden = false;
    ui.projectJobProgress.hidden = false;
    ui.projectJobProgressBar.style.width = `${value}%`;
    ui.projectJobProgressLabel.textContent = `${label} · ${value}%`;
  }

  function renderProjectJobState() {
    const st = state.projectStatus;
    if (!state.projectFiles.length) {
      ui.projectJobPanel.hidden = true;
      return;
    }
    ui.projectJobPanel.hidden = false;
    ui.projectJobBadge.className = `job-badge job-${st}`;
    if (st === 'processing') {
      ui.projectJobBadge.textContent = 'ELABORAZIONE';
      ui.projectJobTitle.textContent = 'Preparazione automatica del tabellino';
      ui.projectJobText.textContent = 'Estraggo solo Progressiva e H e costruisco il dataset di progetto. Nei PDF scansiti può richiedere qualche minuto.';
      ui.projectRetryBtn.disabled = true;
    } else if (st === 'ready') {
      ui.projectJobBadge.textContent = 'VALIDATO';
      ui.projectJobTitle.textContent = 'Tabellino pronto per il confronto';
      ui.projectJobText.textContent = 'Il pulsante Analizza userà i dati già estratti: il PDF di progetto non verrà riletto.';
      ui.projectRetryBtn.disabled = false;
      ui.projectJobProgress.hidden = true;
    } else if (st === 'error') {
      ui.projectJobBadge.textContent = 'DA VERIFICARE';
      ui.projectJobTitle.textContent = 'Preparazione tabellino non completata';
      ui.projectJobText.textContent = state.projectError || 'Non sono stati estratti abbastanza dati coerenti.';
      ui.projectRetryBtn.disabled = false;
      ui.projectJobProgress.hidden = true;
    }
  }

  function renderProjectPreview() {
    const rows = state.projectDataset;
    const stats = state.projectStats;
    ui.projectMetricPoints.textContent = stats ? String(stats.count) : '0';
    ui.projectMetricFrom.textContent = stats ? formatPk(stats.minPk) : '—';
    ui.projectMetricTo.textContent = stats ? formatPk(stats.maxPk) : '—';
    ui.projectMetricH.textContent = stats ? `${Math.round(stats.minH)}–${Math.round(stats.maxH)} mm` : '—';
    ui.projectPreviewBody.innerHTML = '';
    if (!rows.length) return;

    const wanted = [];
    const n = Math.min(14, rows.length);
    for (let i = 0; i < n; i++) {
      const idx = n === 1 ? 0 : Math.round(i * (rows.length - 1) / (n - 1));
      if (!wanted.includes(idx)) wanted.push(idx);
    }
    for (const idx of wanted) {
      const r = rows[idx];
      const tr = document.createElement('tr');
      [formatPk(r.pk), `${Math.round(r.h)} mm`, r.side || '—', (r.track || '—').toUpperCase(), `${r.file || '—'} · p.${r.page || '—'}`]
        .forEach(v => { const td = document.createElement('td'); td.textContent = v; tr.append(td); });
      ui.projectPreviewBody.append(tr);
    }
  }

  function fileReadError(file, detail='') {
    const name = file?.name || 'file senza nome';
    const extra = detail ? ` ${detail}` : '';
    return new Error(`Il PDF “${name}” non contiene dati leggibili.${extra} Verifica che il file sia stato scaricato realmente sul PC e non sia un collegamento/placeholder cloud, quindi ricaricalo.`);
  }

  async function fileToArrayBuffer(file) {
    if (!file) throw new Error('File non disponibile.');
    if (Number.isFinite(file.size) && file.size === 0) throw fileReadError(file, 'La dimensione risulta 0 byte.');

    let buffer = null;
    // Percorso moderno. Su alcuni browser/drive aziendali può fallire: in quel caso
    // usiamo FileReader come fallback di compatibilità.
    if (typeof file.arrayBuffer === 'function') {
      try { buffer = await file.arrayBuffer(); } catch (_) { buffer = null; }
    }
    if (!buffer || !buffer.byteLength) {
      buffer = await new Promise((resolve, reject) => {
        try {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error || fileReadError(file));
          reader.readAsArrayBuffer(file);
        } catch (err) { reject(err); }
      });
    }
    if (!buffer || !buffer.byteLength) throw fileReadError(file, 'Il browser ha restituito 0 byte durante la lettura.');
    return buffer;
  }

  async function loadPdf(file) {
    if (!window.pdfjsLib) throw new Error('Il motore PDF non è stato caricato. Controlla la connessione Internet e ricarica la pagina.');
    const buffer = await fileToArrayBuffer(file);
    const bytes = new Uint8Array(buffer);
    // Controllo rapido dell’intestazione: evita che PDF.js restituisca messaggi tecnici poco chiari.
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
    if (!head.includes('%PDF-')) throw new Error(`Il file “${file.name}” non sembra essere un PDF valido. Prova ad aprirlo e salvarlo nuovamente come PDF.`);
    try {
      return await pdfjsLib.getDocument({ data: bytes }).promise;
    } catch (err) {
      const msg = String(err?.message || err || '');
      if (/empty|zero bytes/i.test(msg)) throw fileReadError(file);
      throw new Error(`Impossibile leggere il PDF “${file.name}”: ${msg || 'errore PDF non specificato'}`);
    }
  }

  function parsePkString(raw) {
    if (!raw) return null;
    const s = String(raw)
      .replace(/\s/g, '')
      .replace(/[,;]/g, '.')
      .replace(/[Oo]/g, '0')
      .replace(/[–—−]/g, '-');
    // Nei tabellini scansionati Tesseract può leggere il "+" della progressiva come "-".
    // Qui il segno è un separatore km+metri, non un'operazione matematica.
    let m = s.match(/(\d{1,3})[+\-](\d{1,3}(?:\.\d{1,3})?)/);
    if (m) return Number(m[1]) * 1000 + Number(m[2]);
    m = s.match(/km(\d{1,3}(?:\.\d+)?)/i);
    if (m) return Number(m[1]) * 1000;
    return null;
  }

  function formatPk(meters) {
    if (!Number.isFinite(meters)) return '—';
    const km = Math.floor(meters / 1000); const rem = meters - km * 1000;
    return `${km}+${rem.toFixed(0).padStart(3, '0')}`;
  }

  async function analyzeGraphPdf(file, sampleStep, trackMode) {
    const pdf = await loadPdf(file); const out = [];
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      setProgress(8 + (pageNo / pdf.numPages) * 18, `Lettura grafico ${file.name} · pagina ${pageNo}/${pdf.numPages}`);
      const page = await pdf.getPage(pageNo); const text = await page.getTextContent();
      const viewport1 = page.getViewport({ scale: 1 });
      const items = text.items.map(it => {
        const pdfX = it.transform[4], pdfY = it.transform[5];
        const p = viewport1.convertToViewportPoint(pdfX, pdfY);
        return { str: String(it.str || '').trim(), pdfX, pdfY, x: p[0], y: p[1] };
      }).filter(i => i.str);
      const kmItems = items.map(i => ({ ...i, pk: parsePkString(i.str) })).filter(i => Number.isFinite(i.pk) && /km/i.test(i.str));
      const supra = items.find(i => /Sopraelev/i.test(i.str));
      if (kmItems.length < 2 || !supra) {
        state.diagnostics.push(`${file.name} p.${pageNo}: pagina ignorata (riferimenti km/sopraelevazione non riconosciuti).`); continue;
      }
      // Alta precisione: il grafico viene rasterizzato a 3x. A scala 1:6 significa circa 0,71 mm/pixel,
      // contro ~1,06 mm/pixel della versione precedente.
      const scale = 3; const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true }); await page.render({ canvasContext: ctx, viewport }).promise;
      const mappedKm = kmItems.map(i => { const p = viewport.convertToViewportPoint(i.pdfX, i.pdfY); return { pk: i.pk, x: p[0] }; }).sort((a,b) => a.x-b.x);
      const supraP = viewport.convertToViewportPoint(supra.pdfX, supra.pdfY);
      const zeroCandidates = items.filter(i => /^0[.,]0$/.test(i.str)).map(i => { const p = viewport.convertToViewportPoint(i.pdfX, i.pdfY); return { x:p[0], y:p[1], d:Math.abs(p[1]-supraP[1]), item:i }; }).sort((a,b)=>a.d-b.d);
      if (!zeroCandidates.length) { state.diagnostics.push(`${file.name} p.${pageNo}: linea di fede non riconosciuta.`); continue; }
      const fit = linearFit(mappedKm.map(k => [k.x, k.pk]));
      if(!Number.isFinite(fit.a)||Math.abs(fit.a)<1e-9){state.diagnostics.push(`${file.name} p.${pageNo}: scala progressiva non ricostruibile.`);continue;}
      const xMin = Math.min(...mappedKm.map(k=>k.x)); const xMax = Math.max(...mappedKm.map(k=>k.x));
      const pkA = fit.a*xMin+fit.b, pkB = fit.a*xMax+fit.b; const pkMin = Math.min(pkA,pkB), pkMax = Math.max(pkA,pkB);
      state.graphRanges.push({ file:file.name, page:pageNo, min:pkMin, max:pkMax });
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const approxZeroY=zeroCandidates[0].y;
      const zeroY=calibrateZeroLine(image,canvas.width,canvas.height,approxZeroY,xMin,xMax,14);
      const geometricMmPerPixel=(25.4/72/scale)*6.0;
      const mmPerPixel=deriveMmPerPixel(items,viewport,zeroCandidates[0].item,approxZeroY,geometricMmPerPixel);

      // La traccia viene seguita come una curva continua. Il progetto è usato soltanto
      // come debole indizio di quota: non forza mai il valore rilevato.
      const pageProjectRows = projectRowsForRange(pkMin, pkMax, trackMode || 'auto');
      const points = [];
      const startPk = Math.ceil(pkMin / sampleStep) * sampleStep;
      for (let pk = startPk; pk <= pkMax; pk += sampleStep) {
        const x = (pk - fit.b) / fit.a;
        if (!Number.isFinite(x) || x < xMin || x > xMax) continue;
        points.push({ pk, x, project: interpProject(pageProjectRows, pk) });
      }
      // Il motore segue la curva su una maglia densa, con più ipotesi contemporanee e controllo in entrambe le direzioni.
      points.sort((a,b)=>a.x-b.x);
      const traceResult=traceSuperelevationSeries(image,canvas.width,canvas.height,points,zeroY,mmPerPixel,xMin,xMax);
      const traced=traceResult.rows; let bridged=0,skipped=0,zeroAccepted=0;
      for(const t of traced){
        if(!Number.isFinite(t.y)){skipped++;continue;}
        if(t.method&&/^bridge/.test(t.method))bridged++;
        if(t.method==='validated-zero')zeroAccepted++;
        const measured=Math.abs(t.y-zeroY)*mmPerPixel;
        // Un valore vicino a zero entra nel confronto solo se il tratto zero è stato validato geometricamente.
        if(measured<3.2&&t.method!=='validated-zero'){skipped++;continue;}
        out.push({source:file.name,page:pageNo,pk:t.pk,measured,signed:(zeroY-t.y)*mmPerPixel,confidence:t.confidence,traceMethod:t.method||'consensus'});
      }
      const st=traceResult.stats||{};
      state.diagnostics.push(`${file.name} p.${pageNo}: lettura alta precisione 3× · ${st.densePoints||0} punti di inseguimento interno · zero ambiguo escluso ${st.ambiguousZero||0} · sovrapposizioni a zero ricostruite ${st.bridgedZero||0} · zero reali validati ${st.acceptedZero||zeroAccepted}. Scala ${mmPerPixel.toFixed(3)} mm/pixel${Math.abs(mmPerPixel-geometricMmPerPixel)/geometricMmPerPixel>.04?' (calibrata da riferimenti PDF)':''}.`);
      if(bridged||skipped)state.diagnostics.push(`${file.name} p.${pageNo}: ${bridged} campione/i ricostruiti per continuità, ${skipped} campione/i ambigui esclusi anziché trasformati in H=0.`);
    }
    return out;
  }

  async function analyzeGraphImage(file, sampleStep) {
    state.diagnostics.push(`${file.name}: immagini raster richiedono riferimenti km automatici non sempre disponibili; il file è acquisito ma può richiedere revisione.`);
    return [];
  }

  function linearFit(points) {
    const n = points.length; let sx=0, sy=0, sxx=0, sxy=0;
    points.forEach(([x,y]) => { sx+=x; sy+=y; sxx+=x*x; sxy+=x*y; });
    const den = n*sxx-sx*sx; const a = den ? (n*sxy-sx*sy)/den : 0; const b = n ? (sy-a*sx)/n : 0; return {a,b};
  }

  function grayAt(data, width, height, x, y) {
    const xi = Math.max(0,Math.min(width-1,Math.round(x))); const yi = Math.max(0,Math.min(height-1,Math.round(y)));
    const i=(yi*width+xi)*4; return .299*data.data[i]+.587*data.data[i+1]+.114*data.data[i+2];
  }

  function rgbAt(data, width, height, x, y) {
    const xi=Math.max(0,Math.min(width-1,Math.round(x))), yi=Math.max(0,Math.min(height-1,Math.round(y)));
    const i=(yi*width+xi)*4; return [data.data[i],data.data[i+1],data.data[i+2]];
  }

  function horizontalScore(data, width, height, x, y) {
    let sum=0,n=0; for(let dx=-4;dx<=4;dx++){sum+=grayAt(data,width,height,x+dx,y);n++;} return n?sum/n:255;
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function median(values) {
    const a=(values||[]).filter(Number.isFinite).slice().sort((x,y)=>x-y);
    if(!a.length)return null; const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2;
  }

  // Media dei pixel più scuri in un intorno 2D: privilegia la traccia vera rispetto al fondo.
  function localStrokeGray(data, width, height, x, y) {
    const vals=[];
    for(let dy=-1;dy<=1;dy++) for(let dx=-2;dx<=2;dx++) vals.push(grayAt(data,width,height,x+dx,y+dy));
    vals.sort((a,b)=>a-b); const take=Math.min(6,vals.length); let sum=0;
    for(let i=0;i<take;i++)sum+=vals[i]; return take?sum/take:255;
  }

  // Se la sopraelevazione è stampata a colori, la cromia è un indizio molto forte perché la griglia è quasi sempre grigia.
  function localChroma(data,width,height,x,y){
    let best=0;
    for(let dy=-1;dy<=1;dy++)for(let dx=-2;dx<=2;dx++){
      const [r,g,b]=rgbAt(data,width,height,x+dx,y+dy); const c=Math.max(r,g,b)-Math.min(r,g,b); if(c>best)best=c;
    }
    return best;
  }

  // Densità d'inchiostro per riga: serve a riconoscere e penalizzare griglie e linee orizzontali persistenti.
  function buildRowInkDensity(data, width, height, yMin, yMax, xMin, xMax) {
    const density=new Float32Array(height),longest=new Float32Array(height); const stepX=Math.max(4,Math.round((xMax-xMin)/260));
    for(let y=Math.max(1,Math.floor(yMin));y<=Math.min(height-2,Math.ceil(yMax));y++){
      let dark=0,n=0,run=0,maxRun=0;
      for(let x=Math.max(1,Math.floor(xMin));x<=Math.min(width-2,Math.ceil(xMax));x+=stepX){
        const isDark=grayAt(data,width,height,x,y)<205; if(isDark){dark++;run++;if(run>maxRun)maxRun=run;}else run=0;n++;
      }
      density[y]=n?dark/n:0; longest[y]=n?maxRun/n:0;
    }
    return {density,longest};
  }

  function rowInkStatsAt(stats,y){
    if(!stats||!stats.density)return {density:0,longest:0}; const yi=Math.round(y); let d=0,l=0;
    // La linea raster ha spessore: guardiamo anche le due righe vicine per non "scappare" dal filtro griglia di 1 pixel.
    for(let k=-2;k<=2;k++){const q=yi+k;if(q<0||q>=stats.density.length)continue;d=Math.max(d,stats.density[q]||0);l=Math.max(l,stats.longest[q]||0);}
    return {density:d,longest:l};
  }

  // Il testo "0.0" indica approssimativamente la quota zero ma il suo punto PDF è la baseline del testo,
  // non necessariamente il centro della linea di fede. La ricalibriamo sui pixel reali del grafico.
  function calibrateZeroLine(data,width,height,approxY,xMin,xMax,searchPx=20){
    const lo=Math.max(2,Math.round(approxY-searchPx)), hi=Math.min(height-3,Math.round(approxY+searchPx));
    const innerMin=xMin+(xMax-xMin)*.04, innerMax=xMax-(xMax-xMin)*.04;
    let best={y:approxY,score:-Infinity,density:0}; const stepX=Math.max(4,Math.round((innerMax-innerMin)/280));
    for(let y=lo;y<=hi;y++){
      let dark=0,n=0;
      for(let x=innerMin;x<=innerMax;x+=stepX){if(grayAt(data,width,height,x,y)<180)dark++;n++;}
      const density=n?dark/n:0; const score=density*155-Math.abs(y-approxY)*1.15;
      if(score>best.score)best={y,score,density};
    }
    // Se non esiste una riga orizzontale convincente, non spostiamo il riferimento del testo.
    return best.density>=.10?best.y:approxY;
  }

  // Quando sul PDF sono presenti tacche numeriche verticali, usiamo anche quelle per stimare mm/pixel.
  // In assenza di almeno due riferimenti coerenti rimane valida la scala geometrica del PDF.
  function deriveMmPerPixel(items,viewport,zeroItem,zeroY,fallback){
    if(!zeroItem)return fallback;
    const slopes=[];
    for(const it of items){
      const raw=String(it.str||'').trim().replace(',','.');
      if(!/^[+-]?\d{1,3}(?:\.\d+)?$/.test(raw))continue;
      const v=Math.abs(Number(raw)); if(!Number.isFinite(v)||v<10||v>200)continue;
      if(Math.abs(it.pdfX-zeroItem.pdfX)>32)continue;
      const p=viewport.convertToViewportPoint(it.pdfX,it.pdfY); const dy=Math.abs(p[1]-zeroY); if(dy<8)continue;
      const mmpp=v/dy; if(mmpp>=.15&&mmpp<=2.5)slopes.push(mmpp);
    }
    if(slopes.length<2)return fallback;
    const med=median(slopes); const good=slopes.filter(v=>Math.abs(v-med)/med<.18);
    if(good.length<2)return fallback;
    const calibrated=median(good); return calibrated>=.15&&calibrated<=2.5?calibrated:fallback;
  }

  function interpTraceField(points,x,field){
    if(!points.length)return null;
    if(x<=points[0].x)return Number.isFinite(points[0][field])?points[0][field]:null;
    const last=points[points.length-1]; if(x>=last.x)return Number.isFinite(last[field])?last[field]:null;
    let lo=0,hi=points.length-1;
    while(hi-lo>1){const m=(lo+hi)>>1;if(points[m].x<=x)lo=m;else hi=m;}
    const a=points[lo],b=points[hi], av=a[field],bv=b[field];
    if(!Number.isFinite(av)&&!Number.isFinite(bv))return null;
    if(!Number.isFinite(av))return bv; if(!Number.isFinite(bv))return av;
    const t=(x-a.x)/Math.max(.0001,b.x-a.x); return av+(bv-av)*t;
  }

  // Tracciamo a passo molto più fitto dei 5 m richiesti dall'utente. È la differenza principale rispetto
  // al vecchio algoritmo: la curva viene seguita pixel-per-pixel e soltanto dopo ricampionata alle progressive.
  function buildDenseTraceNodes(points){
    if(!points.length)return [];
    const sorted=points.slice().sort((a,b)=>a.x-b.x), xs=[]; const start=sorted[0].x,end=sorted[sorted.length-1].x;
    const denseStepPx=3;
    for(let x=start;x<=end;x+=denseStepPx)xs.push(x);
    for(const p of sorted)xs.push(p.x);
    xs.sort((a,b)=>a-b);
    const uniq=[]; for(const x of xs){if(!uniq.length||Math.abs(x-uniq[uniq.length-1])>.35)uniq.push(x);}
    return uniq.map(x=>({x,pk:interpTraceField(sorted,x,'pk'),project:interpTraceField(sorted,x,'project')}));
  }

  function extractTraceCandidates(data,width,height,node,zeroY,mmPerPixel,rowDensity,maxOffsetPx){
    const yMin=Math.max(2,Math.round(zeroY-maxOffsetPx)), yMax=Math.min(height-3,Math.round(zeroY+maxOffsetPx));
    const inks=new Float32Array(yMax-yMin+1);
    for(let y=yMin;y<=yMax;y++)inks[y-yMin]=localStrokeGray(data,width,height,node.x,y);
    const expectedPx=Number.isFinite(node.project)?Math.abs(node.project)/Math.max(.01,mmPerPixel):null;
    const raw=[];
    for(let y=yMin+1;y<yMax;y++){
      const ink=inks[y-yMin], before=inks[y-yMin-1], after=inks[y-yMin+1]; const chroma=localChroma(data,width,height,node.x,y);
      if(ink>238&&chroma<13)continue;
      if(ink>before+2||ink>after+2)continue; // minimo locale verticale
      const offset=Math.abs(y-zeroY), offsetMm=offset*mmPerPixel, rowStat=rowInkStatsAt(rowDensity,y), rowD=rowStat.density;
      const inkCost=clamp((ink-35)*.43,0,88);
      // Una griglia ha soprattutto una lunghissima sequenza orizzontale continua. La densità da sola
      // penalizzerebbe anche un vero tratto di sopraelevazione costante, quindi il 'longest run' pesa di più.
      const rowPenalty=Math.max(0,rowStat.longest-.42)*210+Math.max(0,rowD-.68)*85;
      let zeroPenalty=0;
      if(offsetMm<3.5){zeroPenalty=(3.5-offsetMm)/3.5*68; if(Number.isFinite(node.project)&&Math.abs(node.project)<=8)zeroPenalty*=.18;}
      const projectCost=Number.isFinite(expectedPx)?Math.min(14,Math.abs(offset-expectedPx)*.045):0; // indizio, non vincolo
      const chromaBonus=Math.min(22,chroma*.55);
      const dataCost=inkCost+rowPenalty+zeroPenalty+projectCost-chromaBonus;
      raw.push({y,dataCost,ink,rowD,chroma,offset,quality:clamp(1-dataCost/145,.18,.99)});
    }
    raw.sort((a,b)=>a.dataCost-b.dataCost);
    const picked=[];
    for(const c of raw){if(picked.every(p=>Math.abs(p.y-c.y)>=3))picked.push(c);if(picked.length>=16)break;}
    return picked;
  }

  // Beam search: mantiene più ipotesi contemporaneamente. Un breve tratto senza traccia può essere attraversato
  // "in inerzia" senza agganciarsi alla linea di fede. Questo evita il classico salto artificiale a H=0.
  function runTraceBeam(nodes,candidateSets){
    if(!nodes.length)return [];
    const BEAM=10, MAX_MISS=7;
    let states=(candidateSets[0]||[]).slice(0,BEAM).map(c=>({y:c.y,slope:0,cost:c.dataCost,miss:0,path:[{...c,observed:true}]}));
    if(!states.length)return nodes.map(()=>null);
    for(let i=1;i<nodes.length;i++){
      const dx=nodes[i].x-nodes[i-1].x, absDx=Math.max(.5,Math.abs(dx)); const next=[];
      for(const c of (candidateSets[i]||[])){
        let best=null;
        for(const s of states){
          const dy=c.y-s.y, slope=dy/dx; const maxJump=22*(absDx/3);
          let trans=Math.abs(dy)*.58+Math.abs(slope-s.slope)*2.15;
          if(Math.abs(dy)>maxJump)trans+=85+(Math.abs(dy)-maxJump)*3.2;
          if(Math.abs(slope)>5.5)trans+=(Math.abs(slope)-5.5)*16;
          const cost=s.cost+c.dataCost+trans;
          if(!best||cost<best.cost)best={y:c.y,slope,cost,miss:0,path:s.path.concat([{...c,observed:true}])};
        }
        if(best)next.push(best);
      }
      // Ipotesi virtuale: continua la traiettoria senza dichiarare una misura quando il tratto è occultato.
      for(const s of states){
        if(s.miss>=MAX_MISS)continue;
        const y=s.y+s.slope*dx; const cost=s.cost+24+s.miss*4.5;
        next.push({y,slope:s.slope,cost,miss:s.miss+1,path:s.path.concat([{y,dataCost:30,quality:.45,observed:false,virtual:true,rowD:0,chroma:0,ink:255}])});
      }
      next.sort((a,b)=>a.cost-b.cost); states=next.slice(0,BEAM); if(!states.length)break;
    }
    if(!states.length)return nodes.map(()=>null);
    states.sort((a,b)=>a.cost-b.cost); return states[0].path;
  }

  function mergeTraceDirections(data,width,height,nodes,forward,backward,zeroY,mmPerPixel,rowDensity){
    const out=[]; const zeroBandPx=Math.max(2.8,3.0/Math.max(.01,mmPerPixel));
    for(let i=0;i<nodes.length;i++){
      const a=forward[i],b=backward[i]; let row={...nodes[i],y:null,confidence:.30,method:'ambiguous'};
      if(!a&&!b){out.push(row);continue;}
      if(a&&b&&Number.isFinite(a.y)&&Number.isFinite(b.y)){
        const diff=Math.abs(a.y-b.y);
        if(diff<=4.5){
          const wa=a.observed?1:.62,wb=b.observed?1:.62; row.y=(a.y*wa+b.y*wb)/(wa+wb);
          const q=((a.quality||.45)+(b.quality||.45))/2; row.confidence=clamp(.55+q*.30+(a.observed&&b.observed?.10:.02)-diff*.018,.48,.98);
          row.method=a.observed&&b.observed?'consensus':'bridge-occlusion';
        }else{
          const az=Math.abs(a.y-zeroY)<=zeroBandPx,bz=Math.abs(b.y-zeroY)<=zeroBandPx;
          // Se una direzione cade sulla fede e l'altra continua su una traccia visibile, preferiamo la traccia lontana dalla fede.
          if(az!==bz){
            const far=az?b:a; const fy=Math.round(far.y), farInk=localStrokeGray(data,width,height,nodes[i].x,far.y);
            const farRow=rowInkStatsAt(rowDensity,fy).longest,zeroRow=rowInkStatsAt(rowDensity,zeroY).longest;
            if(far.observed&&farInk<226&&(farRow+.035<zeroRow||far.chroma>14)){
              row.y=far.y;row.confidence=clamp(.56+(far.quality||.5)*.16,.56,.74);row.method='consensus-away-from-zero';
            }
          }
        }
      }else{
        const one=a||b;
        if(one&&Number.isFinite(one.y)&&one.observed&&Math.abs(one.y-zeroY)>zeroBandPx){row.y=one.y;row.confidence=clamp(.48+(one.quality||.5)*.18,.48,.67);row.method='single-direction';}
      }
      out.push(row);
    }
    return out;
  }

  function repairTraceGaps(rows,zeroY,mmPerPixel){
    const out=rows.map(r=>({...r})),n=out.length;
    // Piccoli buchi non osservati: interpolazione solo con traccia valida ai due lati.
    for(let i=0;i<n;){
      if(Number.isFinite(out[i].y)){i++;continue;}
      const start=i;while(i<n&&!Number.isFinite(out[i].y))i++;const end=i-1,left=start-1,right=i,len=end-start+1;
      if(left>=0&&right<n&&len<=7&&Number.isFinite(out[left].y)&&Number.isFinite(out[right].y)&&Math.abs(out[right].y-out[left].y)<=52){
        for(let k=start;k<=end;k++){const t=(k-left)/(right-left);out[k].y=out[left].y+(out[right].y-out[left].y)*t;out[k].confidence=clamp(Math.min(out[left].confidence||.65,out[right].confidence||.65)*.70,.43,.65);out[k].method='bridge-gap';}
      }
    }

    const zeroBandPx=Math.max(2.8,3.0/Math.max(.01,mmPerPixel)); let ambiguousZero=0,bridgedZero=0,acceptedZero=0;

    // Se entrambe le direzioni hanno escluso la fede ma la curva ARRIVA geometricamente a zero e poi ne esce,
    // recuperiamo il tratto come zero reale. Questo conserva i veri H=0 senza confonderli con una semplice sovrapposizione.
    for(let i=0;i<n;){
      if(Number.isFinite(out[i].y)){i++;continue;}
      const start=i;while(i<n&&!Number.isFinite(out[i].y))i++;const end=i-1,left=start-1,right=i;
      if(left<0||right>=n||!Number.isFinite(out[left].y)||!Number.isFinite(out[right].y))continue;
      const runMeters=Number.isFinite(out[start].pk)&&Number.isFinite(out[end].pk)?Math.abs(out[end].pk-out[start].pk):999;
      if(runMeters>80)continue;
      const lo=Math.abs(out[left].y-zeroY),ro=Math.abs(out[right].y-zeroY); if(lo>zeroBandPx*7||ro>zeroBandPx*7)continue;
      const l2=Math.max(0,left-5),r2=Math.min(n-1,right+5);
      const entryTrend=Number.isFinite(out[l2].y)&&Math.abs(out[l2].y-zeroY)>lo+zeroBandPx*.9;
      const exitTrend=Number.isFinite(out[r2].y)&&Math.abs(out[r2].y-zeroY)>ro+zeroBandPx*.9;
      if(entryTrend&&exitTrend){for(let k=start;k<=end;k++){out[k].y=zeroY;out[k].confidence=.58;out[k].method='recovered-zero-transition';}}
    }

    // Ogni run vicino alla fede viene VALIDATO, non accettato automaticamente come H=0.
    for(let i=0;i<n;){
      if(!Number.isFinite(out[i].y)||Math.abs(out[i].y-zeroY)>zeroBandPx){i++;continue;}
      const start=i;while(i<n&&Number.isFinite(out[i].y)&&Math.abs(out[i].y-zeroY)<=zeroBandPx)i++;const end=i-1,left=start-1,right=i;
      const projectVals=out.slice(start,end+1).map(r=>Math.abs(r.project)).filter(Number.isFinite); const projectNearZero=projectVals.length&&median(projectVals)<=8;
      const runMeters=Number.isFinite(out[start].pk)&&Number.isFinite(out[end].pk)?Math.abs(out[end].pk-out[start].pk):0;
      const leftOk=left>=0&&Number.isFinite(out[left].y),rightOk=right<n&&Number.isFinite(out[right].y);
      let accept=!!projectNearZero, bridge=false;
      if(leftOk&&rightOk){
        const lo=out[left].y-zeroY,ro=out[right].y-zeroY; const sameSide=lo*ro>0,opposite=lo*ro<0;
        const l2=Math.max(0,left-4),r2=Math.min(n-1,right+4);
        const entryTrend=Math.abs(out[l2].y-zeroY)>Math.abs(lo)+zeroBandPx*.55;
        const exitTrend=Math.abs(out[r2].y-zeroY)>Math.abs(ro)+zeroBandPx*.55;
        if(opposite)accept=true; // attraversamento reale della quota zero
        else if(sameSide&&entryTrend&&exitTrend&&runMeters>=3)accept=true; // tocco a zero con ingresso/uscita geometrici
        else if(sameSide&&Math.abs(lo)>zeroBandPx*1.6&&Math.abs(ro)>zeroBandPx*1.6&&Math.abs(out[right].y-out[left].y)<=48)bridge=true;
      }
      if(accept){for(let k=start;k<=end;k++){out[k].confidence=Math.min(out[k].confidence||.7,.82);out[k].method='validated-zero';acceptedZero++;}}
      else if(bridge&&leftOk&&rightOk){
        for(let k=start;k<=end;k++){const t=(k-left)/(right-left);out[k].y=out[left].y+(out[right].y-out[left].y)*t;out[k].confidence=clamp(Math.min(out[left].confidence||.65,out[right].confidence||.65)*.68,.44,.64);out[k].method='bridge-zero-overlap';bridgedZero++;}
      }else{
        for(let k=start;k<=end;k++){out[k].y=null;out[k].confidence=.28;out[k].method='ambiguous-zero';ambiguousZero++;}
      }
    }
    return {rows:out,stats:{ambiguousZero,bridgedZero,acceptedZero}};
  }

  function traceSuperelevationSeries(data,width,height,points,zeroY,mmPerPixel,xMin,xMax){
    if(!points.length)return {rows:[],stats:{ambiguousZero:0,bridgedZero:0,acceptedZero:0,densePoints:0}};
    const maxOffsetPx=Math.max(105,Math.ceil(195/Math.max(.01,mmPerPixel))+12);
    const rowDensity=buildRowInkDensity(data,width,height,zeroY-maxOffsetPx,zeroY+maxOffsetPx,xMin,xMax);
    const denseNodes=buildDenseTraceNodes(points);
    const candidateSets=denseNodes.map(n=>extractTraceCandidates(data,width,height,n,zeroY,mmPerPixel,rowDensity,maxOffsetPx));
    const forward=runTraceBeam(denseNodes,candidateSets);
    const revNodes=denseNodes.slice().reverse(),revSets=candidateSets.slice().reverse();
    const backward=runTraceBeam(revNodes,revSets).reverse();
    const merged=mergeTraceDirections(data,width,height,denseNodes,forward,backward,zeroY,mmPerPixel,rowDensity);
    const repaired=repairTraceGaps(merged,zeroY,mmPerPixel);

    // Ricampionamento esatto alle progressive richieste dall'utente; le loro x sono state inserite nel tracciato denso.
    const rows=[]; let j=0;
    for(const p of points){
      while(j+1<repaired.rows.length&&Math.abs(repaired.rows[j+1].x-p.x)<Math.abs(repaired.rows[j].x-p.x))j++;
      const r=repaired.rows[j]; rows.push({...p,y:r&&Math.abs(r.x-p.x)<=2.2?r.y:null,confidence:r?.confidence||.30,method:r?.method||'missing'});
    }
    return {rows,stats:{...repaired.stats,densePoints:denseNodes.length}};
  }

  // Compatibilità con eventuali chiamate residue: una lettura puntuale non restituisce mai 0 per semplice perdita di traccia.
  function traceAtX(data,width,height,x,zeroY,prevY,scale){
    const mmPerPixel=(25.4/72/Math.max(1,scale))*6.0,maxOffsetPx=Math.max(105,Math.ceil(195/Math.max(.01,mmPerPixel))+12);
    const density=buildRowInkDensity(data,width,height,zeroY-maxOffsetPx,zeroY+maxOffsetPx,0,width-1);
    const node={x,project:null},cands=extractTraceCandidates(data,width,height,node,zeroY,mmPerPixel,density,maxOffsetPx);
    if(!cands.length)return null;
    if(Number.isFinite(prevY)){cands.sort((a,b)=>(a.dataCost+Math.abs(a.y-prevY)*.9)-(b.dataCost+Math.abs(b.y-prevY)*.9));}
    const best=cands[0],prevFinite=Number.isFinite(prevY); return best&&prevFinite&&Math.abs(best.y-zeroY)*mmPerPixel<3&&Math.abs(prevY-zeroY)*mmPerPixel>8?null:best.y;
  }

  function traceConfidence(data,width,height,x,y,zeroY){
    if(!Number.isFinite(y))return .30; const g=localStrokeGray(data,width,height,x,y); return clamp(.42+(243-g)/205,.42,.98);
  }

  function normalizeNumeric(s) {
    return String(s || '')
      .replace(/[Oo]/g, '0')
      .replace(/[Il]/g, '1')
      .replace(',', '.')
      .replace(/[^0-9.+-]/g, '');
  }

  function parseProjectPk(raw) {
    const direct = parsePkString(raw);
    if (Number.isFinite(direct)) return direct;

    const s = String(raw || '')
      .replace(/[Oo]/g, '0')
      .replace(/[Il]/g, '1')
      .replace(/[vV#=]/g, '+')
      .replace(/,/g, '.')
      .replace(/\s+/g, '');

    let m = s.match(/(\d{1,3})[+\-](\d{3}(?:\.\d{1,3})?)/);
    if (m) {
      const v = Number(m[1]) * 1000 + Number(m[2]);
      if (Number.isFinite(v) && Number(m[2]) < 1000) return v;
    }

    // Il "+" può essere scambiato per "4": 51+586.513 -> 514586.513.
    const compact = s.replace(/[^0-9.]/g, '');
    m = compact.match(/^(\d{1,3})4(\d{3}\.\d{1,3})/);
    if (m) {
      const v = Number(m[1]) * 1000 + Number(m[2]);
      if (Number.isFinite(v) && Number(m[2]) < 1000) return v;
    }

    // Ultimo recupero: separatore perso, ma restano km + tre cifre metriche.
    m = compact.match(/^(\d{1,3})(\d{3}\.\d{1,3})/);
    if (m) {
      const v = Number(m[1]) * 1000 + Number(m[2]);
      if (Number.isFinite(v) && Number(m[2]) < 1000) return v;
    }
    return null;
  }

  function groupByVisualRow(items, tolerance = 5) {
    const rows = [];
    const sorted = items.filter(i => i.text && i.text.trim()).slice().sort((a, b) => a.cy - b.cy || a.x - b.x);
    for (const item of sorted) {
      let row = rows.find(r => Math.abs(r.cy - item.cy) <= tolerance);
      if (!row) { row = { cy: item.cy, items: [] }; rows.push(row); }
      row.items.push(item);
      row.cy = row.items.reduce((s, x) => s + x.cy, 0) / row.items.length;
    }
    rows.forEach(r => r.items.sort((a, b) => a.x - b.x));
    return rows.sort((a, b) => a.cy - b.cy);
  }

  function dedupeProjectRows(rows) {
    const map = new Map();
    rows.forEach(r => {
      if (!Number.isFinite(r.pk) || !Number.isFinite(r.h)) return;
      const track = r.track || 'auto';
      const key = `${track}|${Math.round(r.pk * 10) / 10}`;
      const old = map.get(key);
      if (!old || (!old.side && r.side) || ((r.confidence || 0) > (old.confidence || 0))) map.set(key, r);
    });
    return Array.from(map.values()).sort((a, b) => (a.track || '').localeCompare(b.track || '') || a.pk - b.pk);
  }

  function sanitizeProjectPageRows(rows) {
    const clean=dedupeProjectRows(rows).filter(r=>Number.isFinite(r.pk)&&Number.isFinite(r.h));
    if(clean.length<4) return clean;
    const sorted=clean.slice().sort((a,b)=>a.pk-b.pk);
    let bestI=0,bestJ=0,j=0;
    for(let i=0;i<sorted.length;i++){
      if(j<i)j=i;
      while(j+1<sorted.length&&sorted[j+1].pk-sorted[i].pk<=2500)j++;
      if((j-i)>(bestJ-bestI)||(j-i===(bestJ-bestI)&&sorted[j].pk-sorted[i].pk<sorted[bestJ].pk-sorted[bestI].pk)){bestI=i;bestJ=j;}
    }
    const cluster=sorted.slice(bestI,bestJ+1);
    // Applica il filtro solo se esiste davvero un gruppo dominante: evita di tagliare
    // pagine atipiche, ma elimina progressivi OCR palesemente fuori tratta.
    const out=cluster.length>=Math.max(3,Math.ceil(clean.length*.55))?cluster:sorted;
    for(let i=1;i<out.length-1;i++){
      if(out[i].h===9&&(out[i].confidence||1)<.70&&out[i-1].h===0&&out[i+1].h===0) out[i]={...out[i],h:0};
    }
    return out;
  }

  function projectStats(rows) {
    if (!rows.length) return null;
    return {
      count: rows.length,
      minPk: Math.min(...rows.map(r => r.pk)),
      maxPk: Math.max(...rows.map(r => r.pk)),
      minH: Math.min(...rows.map(r => r.h)),
      maxH: Math.max(...rows.map(r => r.h))
    };
  }

  function validateProjectRows(rows) {
    if (rows.length < 8) return { ok: false, message: `Riconosciuti solo ${rows.length} punti Progressiva/H.` };
    const stats = projectStats(rows);
    if (!stats || stats.maxPk - stats.minPk < 100) return { ok: false, message: 'Le progressive riconosciute non coprono una tratta sufficiente.' };
    const plausible = rows.filter(r => r.h >= 0 && r.h <= 200).length / rows.length;
    if (plausible < 0.95) return { ok: false, message: 'Troppi valori H risultano incoerenti.' };
    return { ok: true, stats };
  }

  async function createProjectOcrWorker(jobId) {
    if (!window.Tesseract) throw new Error('Motore OCR non disponibile. Controlla la connessione Internet e ricarica la pagina.');
    const worker = await Tesseract.createWorker('eng', 1, { logger: m => {
      if (jobId !== state.projectJobSeq) return;
      if (m.status === 'recognizing text' && Number.isFinite(m.progress)) {
        ui.projectJobText.textContent = `OCR guidato dalla griglia · ${Math.round(m.progress * 100)}% della porzione corrente`;
      }
    }});
    return worker;
  }

  async function renderPdfPage(pdf, pageNo, scale=1.85) {
    const page = await pdf.getPage(pageNo); const vp = page.getViewport({scale});
    const c=document.createElement('canvas'); c.width=Math.ceil(vp.width); c.height=Math.ceil(vp.height);
    const ctx=c.getContext('2d',{alpha:false}); await page.render({canvasContext:ctx,viewport:vp}).promise; return c;
  }

  function cropCanvas(source, x0,y0,x1,y1) {
    const c=document.createElement('canvas');
    const sx=Math.max(0,Math.round(source.width*x0)), sy=Math.max(0,Math.round(source.height*y0));
    const sw=Math.max(1,Math.round(source.width*(x1-x0))), sh=Math.max(1,Math.round(source.height*(y1-y0)));
    c.width=sw; c.height=sh; c.getContext('2d',{alpha:false}).drawImage(source,sx,sy,sw,sh,0,0,sw,sh);
    return {canvas:c,sx,sy,sw,sh};
  }

  async function parseProjectPageText(pdf, pageNo, track, fileName) {
    const page = await pdf.getPage(pageNo);
    const viewport = page.getViewport({ scale: 1 });
    const text = await page.getTextContent();
    const items = (text.items || []).map(it => {
      const p = viewport.convertToViewportPoint(it.transform[4], it.transform[5]);
      return { text:String(it.str||'').trim(), x:p[0], y:p[1], nx:p[0]/viewport.width, cy:p[1] };
    }).filter(i => i.text);
    if (items.length < 12) return [];

    const rows = groupByVisualRow(items, 3.5); const parsed=[];
    for (const row of rows) {
      const sorted=row.items.slice().sort((a,b)=>a.x-b.x);
      const pkCandidate=sorted.filter(i=>i.nx>=0.24&&i.nx<=0.40).map(i=>({i,pk:parseProjectPk(i.text)})).find(x=>Number.isFinite(x.pk));
      if(!pkCandidate) continue;
      let h=null;
      for(const item of sorted.filter(i=>i.nx>=0.64&&i.nx<=0.73)){
        const n=Number(normalizeNumeric(item.text)); if(Number.isFinite(n)&&n>=0&&n<=200){h=n;break;}
      }
      if(!Number.isFinite(h)) continue;
      const sideText=sorted.filter(i=>i.nx>=0.70&&i.nx<=0.79).map(i=>i.text).join(' ');
      const sm=sideText.match(/\b(sx|dx)\b/i);
      parsed.push({pk:pkCandidate.pk,h,side:sm?sm[1][0].toUpperCase()+sm[1][1].toLowerCase():'',page:pageNo,file:fileName,track,method:'text',confidence:.99});
    }
    return sanitizeProjectPageRows(parsed);
  }

  function ocrRowsFromWords(words, cropWidth, tolerance) {
    const mapped=(words||[]).map(w=>({
      text:String(w.text||'').trim(), x:(w.bbox.x0+w.bbox.x1)/2, cy:(w.bbox.y0+w.bbox.y1)/2,
      nx:((w.bbox.x0+w.bbox.x1)/2)/Math.max(1,cropWidth), confidence:Number(w.confidence||0)/100
    })).filter(w=>w.text);
    return groupByVisualRow(mapped,tolerance);
  }

  function medianValue(values) {
    const a=(values||[]).filter(Number.isFinite).slice().sort((x,y)=>x-y);
    if(!a.length) return null;
    const m=Math.floor(a.length/2);
    return a.length%2?a[m]:(a[m-1]+a[m])/2;
  }

  // Nei tabellini scansionati la griglia è un riferimento più affidabile dell'OCR
  // continuo. Individuiamo le righe fisiche della tabella usando i minimi di
  // luminosità delle linee orizzontali, poi leggiamo Progressiva e H cella per cella
  // su due "corsie" sintetiche senza griglia e senza sfondi colorati.
  function detectProjectTableBands(full) {
    const ctx=full.getContext('2d',{willReadFrequently:true});
    const W=full.width,H=full.height;
    const x0=Math.max(0,Math.floor(W*.640)), x1=Math.min(W,Math.ceil(W*.760));
    const y0=Math.max(0,Math.floor(H*.280)), y1=Math.min(H,Math.ceil(H*.972));
    const sw=Math.max(1,x1-x0), sh=Math.max(1,y1-y0);
    const img=ctx.getImageData(x0,y0,sw,sh); const means=new Float32Array(sh);
    for(let y=0;y<sh;y++){
      let sum=0,n=0;
      for(let x=0;x<sw;x+=2){
        const i=(y*sw+x)*4;
        sum += .299*img.data[i]+.587*img.data[i+1]+.114*img.data[i+2]; n++;
      }
      means[y]=n?sum/n:255;
    }
    const score=new Float32Array(sh);
    for(let y=5;y<sh-5;y++){
      let neigh=0,n=0;
      for(let k=-5;k<=-2;k++){neigh+=means[y+k];n++;}
      for(let k=2;k<=5;k++){neigh+=means[y+k];n++;}
      score[y]=(n?neigh/n:means[y])-means[y];
    }
    const candidates=[];
    for(let y=5;y<sh-5;y++) if(score[y]>35) candidates.push(y);
    if(candidates.length<6) return null;

    const peaks=[]; let a=candidates[0],b=candidates[0];
    const pushPeak=()=>{
      let best=a,bestScore=score[a];
      for(let y=a+1;y<=b;y++) if(score[y]>bestScore){best=y;bestScore=score[y];}
      peaks.push(best);
    };
    for(let i=1;i<candidates.length;i++){
      const y=candidates[i];
      if(y<=b+2)b=y; else{pushPeak();a=b=y;}
    }
    pushPeak();

    const diffs=[];
    for(let i=1;i<peaks.length;i++){
      const d=peaks[i]-peaks[i-1]; if(d>=22&&d<=68)diffs.push(d);
    }
    const spacing=medianValue(diffs);
    if(!Number.isFinite(spacing)||spacing<20) return null;

    let lines=[];
    for(let i=0;i<peaks.length;i++){
      const prev=i?peaks[i]-peaks[i-1]:9999, next=i+1<peaks.length?peaks[i+1]-peaks[i]:9999;
      if((prev>=spacing*.62&&prev<=spacing*1.38)||(next>=spacing*.62&&next<=spacing*1.38)){
        if(!lines.length||peaks[i]-lines[lines.length-1]>8)lines.push(peaks[i]);
      }
    }
    if(lines.length<6) return null;

    // Se una linea della griglia è molto sbiadita, la ricostruiamo dal passo dominante.
    const regular=[lines[0]];
    for(let i=1;i<lines.length;i++){
      let prev=regular[regular.length-1], cur=lines[i], gap=cur-prev;
      if(gap>spacing*1.55&&gap<spacing*2.55){regular.push(Math.round(prev+spacing));prev=regular[regular.length-1];gap=cur-prev;}
      if(gap>=spacing*.50)regular.push(cur);
    }
    lines=regular;

    const bands=[];
    for(let i=0;i<lines.length-1;i++){
      const d=lines[i+1]-lines[i];
      if(d<spacing*.52||d>spacing*1.48)continue;
      bands.push({
        y0:y0+lines[i]+Math.max(3,Math.round(spacing*.12)),
        y1:y0+lines[i+1]-Math.max(3,Math.round(spacing*.12)),
        cy:y0+(lines[i]+lines[i+1])/2,
        index:bands.length
      });
    }
    return bands.length>=4?{bands,spacing}:null;
  }

  function cleanProjectCell(full, band, x0n, x1n, thresholdOffset=25) {
    const ctx=full.getContext('2d',{willReadFrequently:true}); const W=full.width,H=full.height;
    const x0=Math.max(0,Math.floor(W*x0n)), x1=Math.min(W,Math.ceil(W*x1n));
    const y0=Math.max(0,Math.floor(band.y0)), y1=Math.min(H,Math.ceil(band.y1));
    const sw=Math.max(1,x1-x0), sh=Math.max(1,y1-y0); const src=ctx.getImageData(x0,y0,sw,sh);
    const hist=new Uint32Array(256); const gray=new Uint8Array(sw*sh);
    for(let p=0;p<sw*sh;p++){
      const i=p*4,g=Math.round(.299*src.data[i]+.587*src.data[i+1]+.114*src.data[i+2]); gray[p]=g;hist[g]++;
    }
    const half=gray.length/2; let acc=0,med=255;
    for(let g=0;g<256;g++){acc+=hist[g];if(acc>=half){med=g;break;}}
    const cut=clamp(Math.round(med-thresholdOffset),58,178); const out=document.createElement('canvas'); out.width=sw;out.height=sh;
    const octx=out.getContext('2d',{alpha:false}); const id=octx.createImageData(sw,sh); let black=0;
    for(let p=0;p<gray.length;p++){
      const v=gray[p]<cut?0:255; if(v===0)black++;
      const i=p*4; id.data[i]=id.data[i+1]=id.data[i+2]=v;id.data[i+3]=255;
    }
    octx.putImageData(id,0,0);
    return {canvas:out,ink:black/Math.max(1,gray.length)};
  }

  function buildSyntheticProjectLane(full, bands, kind) {
    const cfg=kind==='pk'
      ?{x0:.268,x1:.343,offset:25,width:310}
      :kind==='h'
        ?{x0:.662,x1:.694,offset:25,width:210}
        :{x0:.698,x1:.742,offset:22,width:220};
    const rowHeight=60, out=document.createElement('canvas'); out.width=cfg.width;out.height=Math.max(rowHeight,rowHeight*bands.length);
    const ctx=out.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,out.width,out.height);ctx.imageSmoothingEnabled=false;
    const ink=[];
    bands.forEach((band,idx)=>{
      const cell=cleanProjectCell(full,band,cfg.x0,cfg.x1,cfg.offset);ink[idx]=cell.ink;
      const maxH=48,maxW=out.width-18,scale=Math.min(maxW/cell.canvas.width,maxH/cell.canvas.height);
      const dw=Math.max(1,Math.round(cell.canvas.width*scale)),dh=Math.max(1,Math.round(cell.canvas.height*scale));
      const dx=Math.round((out.width-dw)/2),dy=idx*rowHeight+Math.round((rowHeight-dh)/2);
      ctx.drawImage(cell.canvas,0,0,cell.canvas.width,cell.canvas.height,dx,dy,dw,dh);
      cell.canvas.width=1;cell.canvas.height=1;
    });
    return {canvas:out,rowHeight,ink};
  }

  async function recognizeSyntheticRows(worker, synthetic, whitelist, psm='6') {
    await worker.setParameters({preserve_interword_spaces:'1',tessedit_pageseg_mode:String(psm),tessedit_char_whitelist:whitelist});
    const result=await worker.recognize(synthetic.canvas); const grouped=new Map();
    for(const w of (result.data.words||[])){
      const text=String(w.text||'').trim();if(!text)continue;
      const cy=(w.bbox.y0+w.bbox.y1)/2,idx=Math.max(0,Math.min(Math.ceil(synthetic.canvas.height/synthetic.rowHeight)-1,Math.floor(cy/synthetic.rowHeight)));
      if(!grouped.has(idx))grouped.set(idx,[]);
      grouped.get(idx).push({text,x:w.bbox.x0,confidence:Number(w.confidence||0)/100});
    }
    const rows=[];
    for(const [idx,items] of grouped.entries()){
      items.sort((a,b)=>a.x-b.x);rows[idx]={text:items.map(x=>x.text).join(''),confidence:items.reduce((s,x)=>s+x.confidence,0)/items.length};
    }
    return rows;
  }

  function parseProjectH(raw) {
    const s=String(raw||'').replace(/[Oo]/g,'0').replace(/[Il|]/g,'1').replace(/[^0-9]/g,'');
    if(!s)return null;
    const direct=Number(s); if(Number.isFinite(direct)&&direct>=0&&direct<=200)return direct;
    // Recupero prudente di un carattere spurio ai bordi della cella.
    const variants=[];
    if(s.length>1){variants.push(s.slice(0,-1),s.slice(1));}
    for(const v of variants){const n=Number(v);if(Number.isFinite(n)&&n>=0&&n<=200)return n;}
    return null;
  }

  function parseProjectPkWithKmHint(raw,kmHint) {
    if(!Number.isFinite(kmHint))return null;
    let s=String(raw||'').replace(/[Oo]/g,'0').replace(/[Il]/g,'1').replace(/[vV#=]/g,'+').replace(/,/g,'.').replace(/\s+/g,'');
    const decimals=[...s.matchAll(/(\d{3})[.:](\d{1,3})/g)];
    if(decimals.length){const m=decimals[decimals.length-1],meters=Number(`${m[1]}.${m[2]}`);if(meters<1000)return kmHint*1000+meters;}
    const digits=s.replace(/\D/g,'');
    if(digits.length>=6){const tail=digits.slice(-6),meters=Number(`${tail.slice(0,3)}.${tail.slice(3)}`);if(meters<1000)return kmHint*1000+meters;}
    if(digits.length>=3){const meters=Number(digits.slice(-3));if(meters<1000)return kmHint*1000+meters;}
    return null;
  }

  function repairSyntheticPkRows(rows) {
    const parsed=rows.map(r=>r&&r.text?parseProjectPk(r.text):null); const vals=parsed.filter(Number.isFinite).sort((a,b)=>a-b);
    if(vals.length<3)return parsed;
    let bi=0,bj=0,j=0;
    for(let i=0;i<vals.length;i++){
      if(j<i)j=i; while(j+1<vals.length&&vals[j+1]-vals[i]<=2500)j++;
      if(j-i>bj-bi){bi=i;bj=j;}
    }
    const cluster=vals.slice(bi,bj+1),center=medianValue(cluster),kms=cluster.map(v=>Math.floor(v/1000));
    const counts=new Map();kms.forEach(k=>counts.set(k,(counts.get(k)||0)+1));
    const kmHint=[...counts.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0];
    return parsed.map((pk,idx)=>{
      const suspicious=!Number.isFinite(pk)||(Number.isFinite(center)&&Math.abs(pk-center)>1800);
      if(!suspicious)return pk;
      const recovered=parseProjectPkWithKmHint(rows[idx]?.text,kmHint);
      return Number.isFinite(recovered)?recovered:pk;
    });
  }

  async function recognizeSingleProjectCell(worker, full, band, kind) {
    const cfg=kind==='pk'?{x0:.266,x1:.346,offset:20,wl:'0123456789+-.OoVv#='}:{x0:.658,x1:.698,offset:20,wl:'0123456789OoIl'};
    const cell=cleanProjectCell(full,band,cfg.x0,cfg.x1,cfg.offset);
    const padded=document.createElement('canvas'); padded.width=Math.max(180,cell.canvas.width*2+40);padded.height=Math.max(70,cell.canvas.height*2+24);
    const pctx=padded.getContext('2d',{alpha:false});pctx.fillStyle='#fff';pctx.fillRect(0,0,padded.width,padded.height);pctx.imageSmoothingEnabled=false;
    pctx.drawImage(cell.canvas,0,0,cell.canvas.width,cell.canvas.height,20,12,padded.width-40,padded.height-24);
    await worker.setParameters({preserve_interword_spaces:'1',tessedit_pageseg_mode:'7',tessedit_char_whitelist:cfg.wl});
    const res=await worker.recognize(padded); const text=String(res.data.text||'').trim();
    cell.canvas.width=1;cell.canvas.height=1;padded.width=1;padded.height=1;
    return {text,confidence:Math.max(.25,Math.min(.98,Number(res.data.confidence||0)/100)),ink:cell.ink};
  }

  async function parseProjectPageOcr(pdf, pageNo, worker, track, fileName, jobId) {
    // v1.4.2: OCR guidato dalla griglia. Ogni riga fisica della tabella mantiene
    // l'associazione Progressiva ↔ H anche quando lo sfondo è verde/giallo/blu.
    const full=await renderPdfPage(pdf,pageNo,4.0);
    try{
      if(jobId!==state.projectJobSeq) return [];
      const grid=detectProjectTableBands(full);
      if(!grid||grid.bands.length<4){
        // Fallback al lettore colonne precedente per pagine molto sbiadite/atipiche.
        const y0=.052,y1=.965,pkCrop=cropCanvas(full,.255,y0,.350,y1),hCrop=cropCanvas(full,.640,y0,.760,y1);
        await worker.setParameters({preserve_interword_spaces:'1',tessedit_pageseg_mode:'6',tessedit_char_whitelist:'0123456789+-.OoVv#='});
        const pkResult=await worker.recognize(pkCrop.canvas); if(jobId!==state.projectJobSeq)return [];
        await worker.setParameters({preserve_interword_spaces:'1',tessedit_pageseg_mode:'6',tessedit_char_whitelist:'0123456789OoSxDXdx|-_'});
        const hResult=await worker.recognize(hCrop.canvas); const rowTol=Math.max(14,pkCrop.sh*.006),matchTol=rowTol*1.55;
        const pkRows=ocrRowsFromWords(pkResult.data.words||[],pkCrop.sw,rowTol).map(r=>({cy:r.cy,pk:parseProjectPk(r.items.map(i=>i.text).join('')),conf:r.items.reduce((s,i)=>s+i.confidence,0)/Math.max(1,r.items.length)})).filter(r=>Number.isFinite(r.pk));
        const hRows=ocrRowsFromWords(hResult.data.words||[],hCrop.sw,rowTol).map(r=>{const text=r.items.map(i=>i.text).join(' '),sm=text.match(/(sx|dx)/i);return{cy:r.cy,h:parseProjectH(text),side:sm?sm[1][0].toUpperCase()+sm[1][1].toLowerCase():'',conf:r.items.reduce((s,i)=>s+i.confidence,0)/Math.max(1,r.items.length)}}).filter(r=>Number.isFinite(r.h));
        const parsed=[];for(const p of pkRows){let best=null;for(const h of hRows){const d=Math.abs(h.cy-p.cy);if(d<=matchTol&&(!best||d<best.d))best={...h,d};}if(best)parsed.push({pk:p.pk,h:best.h,side:best.side,page:pageNo,file:fileName,track,method:'ocr-columns-fallback',confidence:Math.max(.35,Math.min(.98,((p.conf||.6)+(best.conf||.6))/2))});}
        pkCrop.canvas.width=hCrop.canvas.width=1;return sanitizeProjectPageRows(parsed);
      }

      const pkLane=buildSyntheticProjectLane(full,grid.bands,'pk'),hLane=buildSyntheticProjectLane(full,grid.bands,'h'),sideLane=buildSyntheticProjectLane(full,grid.bands,'side');
      const pkOcr=await recognizeSyntheticRows(worker,pkLane,'0123456789+-.OoVv#=','6'); if(jobId!==state.projectJobSeq)return [];
      const hOcr=await recognizeSyntheticRows(worker,hLane,'0123456789OoIl','6'); if(jobId!==state.projectJobSeq)return [];
      const sideOcr=await recognizeSyntheticRows(worker,sideLane,'SxDXdx','6');
      let pkValues=repairSyntheticPkRows(pkOcr); let recoveredPk=0,recoveredH=0; const parsed=[];

      // Secondo passaggio mirato solo sulle celle che contengono inchiostro ma non
      // sono state lette correttamente dal passaggio di massa.
      for(let idx=0;idx<grid.bands.length;idx++){
        if(jobId!==state.projectJobSeq)return [];
        let pk=pkValues[idx], pkConf=pkOcr[idx]?.confidence||.55;
        if(!Number.isFinite(pk)&&(pkLane.ink[idx]||0)>.105){
          const one=await recognizeSingleProjectCell(worker,full,grid.bands[idx],'pk');
          const known=pkValues.filter(Number.isFinite),center=known.length?medianValue(known):null,kmHint=known.length?Math.floor(center/1000):null;
          pk=parseProjectPk(one.text);
          if(!Number.isFinite(pk)||(Number.isFinite(center)&&Math.abs(pk-center)>1800)){
            const hinted=parseProjectPkWithKmHint(one.text,kmHint); if(Number.isFinite(hinted))pk=hinted;
          }
          if(Number.isFinite(pk)){pkValues[idx]=pk;pkConf=one.confidence;recoveredPk++;}
        }
        if(!Number.isFinite(pk))continue;

        let h=parseProjectH(hOcr[idx]?.text),hConf=hOcr[idx]?.confidence||.50;
        if(!Number.isFinite(h)){
          const one=await recognizeSingleProjectCell(worker,full,grid.bands[idx],'h');h=parseProjectH(one.text);
          if(Number.isFinite(h)){hConf=one.confidence;recoveredH++;}
        }
        if(!Number.isFinite(h))continue;
        const sideText=String(sideOcr[idx]?.text||''); const sm=sideText.match(/(sx|dx)/i),side=sm?sm[1][0].toUpperCase()+sm[1][1].toLowerCase():'';
        parsed.push({pk,h,side,page:pageNo,file:fileName,track,method:(recoveredPk||recoveredH)?'ocr-grid':'ocr-grid',confidence:Math.max(.38,Math.min(.99,(pkConf+hConf)/2))});
      }
      pkLane.canvas.width=hLane.canvas.width=sideLane.canvas.width=1;
      const clean=sanitizeProjectPageRows(parsed);
      clean.forEach(r=>{r.gridRows=grid.bands.length;r.recoveredCells=recoveredPk+recoveredH;});
      return clean;
    } finally { full.width=1;full.height=1; }
  }

  function pagesForSelectedTrack(numPages, trackMode) {
    const pages=[];
    if(numPages<=3){for(let p=1;p<=numPages;p++)pages.push({page:p,track:trackMode==='auto'?'auto':trackMode});return pages;}
    // Formato tabellino P/D RFI: copertina + metà PARI + metà DISPARI.
    // Sul file da 101 pagine: PARI 2–51, DISPARI 52–101.
    const split=Math.floor(numPages/2)+1;
    if(trackMode==='pari') for(let p=2;p<=split;p++) pages.push({page:p,track:'pari'});
    else if(trackMode==='dispari') for(let p=split+1;p<=numPages;p++) pages.push({page:p,track:'dispari'});
    else for(let p=2;p<=numPages;p++) pages.push({page:p,track:p<=split?'pari':'dispari'});
    return pages;
  }

  async function preprocessProjectFile(file, trackMode, jobId, workerHolder, progressBase, progressSpan) {
    const pdf=await loadPdf(file); const plan=pagesForSelectedTrack(pdf.numPages,trackMode); const out=[];
    let ocrPages=0,textPages=0,recoveredCells=0,gridRows=0;
    for(let i=0;i<plan.length;i++){
      if(jobId!==state.projectJobSeq) throw new Error('__JOB_CANCELLED__');
      const {page:pageNo,track}=plan[i];
      setProjectJobProgress(progressBase+((i+.15)/Math.max(1,plan.length))*progressSpan,`${file.name} · pagina ${pageNo}/${pdf.numPages}`);
      let rows=[];
      try{rows=await parseProjectPageText(pdf,pageNo,track,file.name);}catch(err){console.warn('Text parser page error',file.name,pageNo,err);}
      // Una pagina tabellare piena contiene normalmente molte più di 4 righe: non
      // consideriamo "completa" una lettura testuale parziale, altrimenti alcuni H
      // potrebbero restare fuori senza attivare l'OCR di recupero.
      if(rows.length>=28) textPages++;
      else{
        if(!workerHolder.worker) workerHolder.worker=await createProjectOcrWorker(jobId);
        const ocrRows=await parseProjectPageOcr(pdf,pageNo,workerHolder.worker,track,file.name,jobId);
        if(ocrRows.length){
          rows=dedupeProjectRows([...rows,...ocrRows]);ocrPages++;
          recoveredCells+=Math.max(0,...ocrRows.map(r=>Number(r.recoveredCells||0)));
          gridRows+=Math.max(0,...ocrRows.map(r=>Number(r.gridRows||0)));
        }
      }
      out.push(...rows); await new Promise(resolve=>setTimeout(resolve,0));
    }
    return {rows:out,textPages,ocrPages,recoveredCells,gridRows,pages:plan.map(x=>x.page)};
  }

  async function startProjectPreprocessing() {
    const jobId=++state.projectJobSeq;
    state.projectDataset=[];state.projectStats=null;state.projectError='';renderProjectPreview();
    state.projectAudit={files:state.projectFiles.length,indexPages:[],parsedPages:[],candidatePages:[],points:0,coverageMin:null,coverageMax:null,maxGap:null,trackChecks:[]};
    if(!state.projectFiles.length){state.projectStatus='idle';renderProjectJobState();updateReadyState();return;}

    state.projectStatus='processing';renderProjectJobState();setProjectJobProgress(1,'Avvio preparazione tabellino');updateReadyState();
    const trackMode=ui.trackSelect.value; const workerHolder={worker:null}; let all=[]; let totalText=0,totalOcr=0,totalRecovered=0,totalGridRows=0,allPages=[];
    try{
      for(let f=0;f<state.projectFiles.length;f++){
        if(jobId!==state.projectJobSeq) throw new Error('__JOB_CANCELLED__');
        const file=state.projectFiles[f], base=2+(f/state.projectFiles.length)*94, span=94/state.projectFiles.length;
        const result=await preprocessProjectFile(file,trackMode,jobId,workerHolder,base,span);
        all.push(...result.rows); totalText+=result.textPages; totalOcr+=result.ocrPages; totalRecovered+=result.recoveredCells||0; totalGridRows+=result.gridRows||0; allPages.push(...result.pages);
      }
      if(jobId!==state.projectJobSeq) throw new Error('__JOB_CANCELLED__');
      all=dedupeProjectRows(all);
      if(trackMode==='pari'||trackMode==='dispari') all=all.filter(r=>r.track===trackMode||r.track==='auto');
      const validation=validateProjectRows(all); if(!validation.ok) throw new Error(validation.message);

      state.projectDataset=all;state.projectStats=validation.stats;state.projectStatus='ready';
      const pks=all.map(r=>r.pk).sort((a,b)=>a-b),gaps=pks.slice(1).map((v,i)=>v-pks[i]);
      state.projectAudit={files:state.projectFiles.length,indexPages:[],parsedPages:Array.from(new Set(all.map(r=>r.page).filter(Number.isFinite))),candidatePages:Array.from(new Set(allPages)),points:all.length,coverageMin:pks[0],coverageMax:pks[pks.length-1],maxGap:gaps.length?Math.max(...gaps):0,trackChecks:[]};
      state.projectAudit.preprocessSummary={textPages:totalText,ocrPages:totalOcr,recoveredCells:totalRecovered,gridRows:totalGridRows,trackMode};
      setProjectJobProgress(100,'Tabellino validato');renderProjectPreview();renderProjectJobState();
    }catch(err){
      if(String(err&&err.message)==='__JOB_CANCELLED__') return;
      console.error(err);state.projectDataset=[];state.projectStats=null;state.projectStatus='error';state.projectError=err&&err.message?err.message:'Errore durante la preparazione del tabellino.';renderProjectPreview();renderProjectJobState();
    }finally{
      if(workerHolder.worker){try{await workerHolder.worker.terminate();}catch(_){}}
      if(jobId===state.projectJobSeq)updateReadyState();
    }
  }

  function projectRowsForRange(targetMin,targetMax,trackMode){
    let rows=state.projectDataset.slice();
    if(trackMode==='pari'||trackMode==='dispari') rows=rows.filter(r=>r.track===trackMode||r.track==='auto');
    if(trackMode==='auto'){
      const pari=rows.filter(r=>r.track==='pari'&&r.pk>=targetMin-600&&r.pk<=targetMax+600);
      const dispari=rows.filter(r=>r.track==='dispari'&&r.pk>=targetMin-600&&r.pk<=targetMax+600);
      if(pari.length&&dispari.length){
        const diff=Math.abs(pari.length-dispari.length),maxLen=Math.max(pari.length,dispari.length);
        if(diff<Math.max(4,maxLen*.25))throw new Error('Il tabellino contiene sia Pari sia Dispari sulla stessa tratta. Seleziona il binario corretto prima dell’analisi.');
        rows=pari.length>dispari.length?pari:dispari;
      }else rows=pari.length?pari:dispari;
    }
    return rows.filter(r=>r.pk>=targetMin-600&&r.pk<=targetMax+600).sort((a,b)=>a.pk-b.pk);
  }

  function updateProjectAuditForRows(rows) {
    if(!rows.length){state.projectAudit.points=0;state.projectAudit.coverageMin=null;state.projectAudit.coverageMax=null;state.projectAudit.maxGap=null;return;}
    const pks=rows.map(r=>r.pk).sort((a,b)=>a-b), gaps=pks.slice(1).map((v,i)=>v-pks[i]);
    state.projectAudit.points=rows.length;state.projectAudit.coverageMin=pks[0];state.projectAudit.coverageMax=pks[pks.length-1];state.projectAudit.maxGap=gaps.length?Math.max(...gaps):0;
    state.projectAudit.parsedPages=Array.from(new Set(rows.map(r=>r.page).filter(Number.isFinite)));
  }

  function buildCurves(rows) {
    const sorted=rows.slice().sort((a,b)=>a.pk-b.pk); const curves=[]; let cur=null; let id=0;
    for(let i=0;i<sorted.length;i++){
      const r=sorted[i], prev=sorted[i-1]; const gap=prev?r.pk-prev.pk:0;
      const newCurve = !cur || gap>250 || (prev && prev.h===0 && r.h>0) || (prev && prev.side && r.side && prev.side!==r.side && (prev.h>0||r.h>0));
      if(newCurve){ if(cur&&cur.rows.some(x=>x.h>0))curves.push(cur); cur={id:++id,rows:[]}; }
      cur.rows.push(r);
      if(r.h===0 && cur.rows.some(x=>x.h>0) && i<sorted.length-1 && sorted[i+1].h===0){ curves.push(cur); cur={id:++id,rows:[]}; }
    }
    if(cur&&cur.rows.some(x=>x.h>0))curves.push(cur);
    return curves.map((c,i)=>({id:i+1,rows:c.rows,start:Math.min(...c.rows.map(r=>r.pk)),end:Math.max(...c.rows.map(r=>r.pk)),side:mode(c.rows.map(r=>r.side).filter(Boolean))||'—'}));
  }

  function mode(values){ const c={}; values.forEach(v=>c[v]=(c[v]||0)+1); return Object.keys(c).sort((a,b)=>c[b]-c[a])[0]; }

  function interpProject(rows, pk){
    const s=rows; if(!s.length||pk<s[0].pk||pk>s[s.length-1].pk)return null;
    let lo=0,hi=s.length-1; while(hi-lo>1){const m=(lo+hi)>>1;if(s[m].pk<=pk)lo=m;else hi=m;}
    const a=s[lo],b=s[hi]; if(!a||!b)return null; if(a.pk===b.pk)return a.h; const t=(pk-a.pk)/(b.pk-a.pk); return a.h+(b.h-a.h)*t;
  }

  function severityOf(measured, project, yellowTol, orangeFrom){
    if(measured>160)return {level:'red',reason:'Superamento 160 mm'};
    if(measured>=orangeFrom && measured<=160 && project<orangeFrom)return {level:'orange',reason:`Avvicinamento a 159/160 mm non previsto dal progetto`};
    if(Math.abs(measured-project)>=yellowTol)return {level:'yellow',reason:`Scostamento dal progetto ≥ ±${yellowTol} mm`};
    return {level:'green',reason:'Conforme'};
  }

  function compareSamples(graphSamples, projectRows, curves, yellowTol, orangeFrom){
    const compared=[];
    for(const s of graphSamples){ const project=interpProject(projectRows,s.pk); if(project==null)continue; const curve=curves.find(c=>s.pk>=c.start&&s.pk<=c.end); if(!curve)continue; const sev=severityOf(s.measured,project,yellowTol,orangeFrom); compared.push({...s,project,delta:s.measured-project,curveId:curve.id,side:curve.side,...sev}); }
    return compared;
  }

  function levelRank(l){return {green:0,yellow:1,orange:2,red:3}[l]??0;}

  function aggregateAlerts(samples, sampleStep){
    // Regola di sintesi: una sola segnalazione per curva.
    // Se nella stessa curva compaiono più livelli, prevale quello più grave
    // (rosso > arancio > giallo > verde). La tratta riportata è il segmento
    // continuo più rappresentativo con quel codice omogeneo.
    const byCurve = new Map();
    for (const s of samples) {
      if (!byCurve.has(s.curveId)) byCurve.set(s.curveId, []);
      byCurve.get(s.curveId).push(s);
    }
    const out = [];
    for (const [curveId, curveSamples] of byCurve.entries()) {
      const sorted = curveSamples.slice().sort((a,b)=>a.pk-b.pk);
      const worstRank = sorted.reduce((m,s)=>Math.max(m,levelRank(s.level)),0);
      if (worstRank <= 0) continue;
      const worstLevel = ['green','yellow','orange','red'][worstRank];
      const worst = sorted.filter(s=>s.level===worstLevel);
      const segments = [];
      let g = null;
      for (const s of worst) {
        if (!g || s.pk-g.lastPk > sampleStep*2.2) {
          if (g) segments.push(g);
          g = {curveId, level:worstLevel, reason:s.reason, start:s.pk, end:s.pk, lastPk:s.pk, items:[s]};
        } else {
          g.end=s.pk; g.lastPk=s.pk; g.items.push(s);
        }
      }
      if (g) segments.push(g);
      segments.sort((a,b)=>{
        const lenB=(b.end-b.start)+sampleStep, lenA=(a.end-a.start)+sampleStep;
        if(lenB!==lenA) return lenB-lenA;
        const dB=Math.max(...b.items.map(i=>Math.abs(i.delta))), dA=Math.max(...a.items.map(i=>Math.abs(i.delta)));
        return dB-dA;
      });
      const chosen = finalizeGroup(segments[0]);
      chosen.absorbedSamples = sorted.filter(s=>s.level!=='green' && !chosen.items.includes(s)).length;
      chosen.curveSampleCount = sorted.length;
      out.push(chosen);
    }
    return out.sort((a,b)=>levelRank(b.level)-levelRank(a.level)||a.curveId-b.curveId);
  }

  function finalizeGroup(g){
    const items=g.items||[]; const worst=items.slice().sort((a,b)=>levelRank(b.level)-levelRank(a.level)||Math.abs(b.delta)-Math.abs(a.delta))[0]||{};
    return {...g,start:Math.min(g.start,g.end),end:Math.max(g.start,g.end),projectMin:min(items.map(i=>i.project)),projectMax:max(items.map(i=>i.project)),measuredMin:min(items.map(i=>i.measured)),measuredMax:max(items.map(i=>i.measured)),deltaMax:items.reduce((m,i)=>Math.abs(i.delta)>Math.abs(m)?i.delta:m,0),confidence:items.length?items.reduce((s,i)=>s+i.confidence,0)/items.length:0,reason:worst.reason||g.reason};
  }
  function min(a){return a.length?Math.min(...a):0;} function max(a){return a.length?Math.max(...a):0;}

  function reliabilityLabel(score){
    if(!Number.isFinite(score)) return 'Da calcolare';
    if(score>=90) return 'Alta';
    if(score>=80) return 'Buona';
    if(score>=65) return 'Da verificare';
    return 'Bassa';
  }

  function reliabilityClass(score){
    if(!Number.isFinite(score)) return 'reliability-neutral';
    if(score>=90) return 'reliability-high';
    if(score>=80) return 'reliability-good';
    if(score>=65) return 'reliability-review';
    return 'reliability-low';
  }

  function computeReliability(graphSampleCount){
    const compared = state.samples.length;
    const trace = compared ? state.samples.reduce((sum,s)=>sum+(Number.isFinite(s.confidence)?s.confidence:0),0)/compared : 0;
    const coverage = graphSampleCount ? Math.min(1, compared/graphSampleCount) : 0;
    let score = Math.round(100*(trace*0.78 + coverage*0.22));
    // Evita una falsa sensazione di precisione quando il confronto utile è molto ridotto.
    if(compared>0 && compared<12) score=Math.min(score,79);
    if(!compared) score=0;
    state.reliability={score,label:reliabilityLabel(score),trace,coverage};
    return state.reliability;
  }

  function renderReliability(){
    const r=state.reliability;
    const score=Number.isFinite(r.score)?r.score:null;
    ui.reliabilityScore.textContent=score==null?'—':`${score}%`;
    ui.reliabilityLabel.textContent=r.label||'Da calcolare';
    ui.reliabilityBar.style.width=score==null?'0%':`${Math.max(0,Math.min(100,score))}%`;
    ui.reliabilityBar.style.background=score!=null&&score<65?COLORS.red:score!=null&&score<80?COLORS.yellow:'#1A8EAA';
    ui.reliabilityHint.textContent=score==null?'Valuta qualità della traccia e copertura del confronto':`Traccia ${Math.round((r.trace||0)*100)}% · copertura ${Math.round((r.coverage||0)*100)}%`;
    ui.overallReliabilityTop.textContent=score==null?'—':`${score}% · ${r.label}`;
    ui.overallReliabilityPill.className=`reliability-pill ${reliabilityClass(score)}`;
  }

  function rangeText(a,b,suffix=' mm'){ const ar=Math.round(a),br=Math.round(b); return ar===br?`${ar}${suffix}`:`${ar}–${br}${suffix}`; }
  function levelLabel(level){return {green:'VERDE',yellow:'GIALLO',orange:'ARANCIO',red:'ROSSO'}[level]||level.toUpperCase();}

  function svgEl(name, attrs={}){
    const el=document.createElementNS('http://www.w3.org/2000/svg',name);
    Object.entries(attrs).forEach(([k,v])=>el.setAttribute(k,String(v)));
    return el;
  }

  function renderProfileGraph(){
    const svg=ui.profileChart;
    const list=ui.visualAlertList;
    if(!svg||!list)return;
    svg.innerHTML=''; list.innerHTML='';
    const samples=state.samples.filter(s=>Number.isFinite(s.pk)&&Number.isFinite(s.project)&&Number.isFinite(s.measured)).sort((a,b)=>a.pk-b.pk);
    if(!samples.length){
      const t=svgEl('text',{x:550,y:170,'text-anchor':'middle',class:'chart-empty'});t.textContent='Nessun campione utile da rappresentare';svg.append(t);return;
    }
    const W=1100,H=340,L=72,R=28,T=28,B=54;
    const minPk=samples[0].pk,maxPk=samples[samples.length-1].pk;
    const rawMax=Math.max(160,...samples.map(s=>Math.max(s.project,s.measured)));
    const yMax=Math.max(170,Math.min(220,Math.ceil((rawMax+10)/10)*10));
    const x=pk=>L+(pk-minPk)/Math.max(1,maxPk-minPk)*(W-L-R);
    const y=v=>T+(yMax-v)/yMax*(H-T-B);

    const bg=svgEl('rect',{x:L,y:T,width:W-L-R,height:H-T-B,rx:10,class:'chart-bg'});svg.append(bg);
    [0,50,100,150,160].filter(v=>v<=yMax).forEach(v=>{
      const line=svgEl('line',{x1:L,y1:y(v),x2:W-R,y2:y(v),class:v===160?'chart-grid threshold':'chart-grid'});svg.append(line);
      const txt=svgEl('text',{x:L-12,y:y(v)+4,'text-anchor':'end',class:'chart-axis-label'});txt.textContent=`${v}`;svg.append(txt);
    });
    const yTitle=svgEl('text',{x:17,y:(T+H-B)/2,transform:`rotate(-90 17 ${(T+H-B)/2})`,'text-anchor':'middle',class:'chart-axis-title'});yTitle.textContent='Sopraelevazione [mm]';svg.append(yTitle);

    state.alerts.forEach(a=>{
      const x1=x(Math.max(minPk,a.start)),x2=x(Math.min(maxPk,a.end));
      if(!Number.isFinite(x1)||!Number.isFinite(x2)||x2<x1)return;
      const rect=svgEl('rect',{x:x1,y:T,width:Math.max(3,x2-x1),height:H-T-B,rx:5,class:`chart-alert-zone chart-alert-${a.level}`});svg.append(rect);
      const stripe=svgEl('rect',{x:x1,y:T,width:Math.max(3,x2-x1),height:7,rx:3,fill:COLORS[a.level]});svg.append(stripe);
    });

    const tickCount=6;
    for(let i=0;i<tickCount;i++){
      const pk=minPk+(maxPk-minPk)*(i/(tickCount-1));const xp=x(pk);
      const tick=svgEl('line',{x1:xp,y1:H-B,x2:xp,y2:H-B+6,class:'chart-tick'});svg.append(tick);
      const txt=svgEl('text',{x:xp,y:H-B+24,'text-anchor':'middle',class:'chart-axis-label'});txt.textContent=formatPk(pk);svg.append(txt);
    }
    const xTitle=svgEl('text',{x:(L+W-R)/2,y:H-7,'text-anchor':'middle',class:'chart-axis-title'});xTitle.textContent='Progressiva';svg.append(xTitle);

    function groupsFor(key){
      const groups=[];let cur=[];let prev=null;
      const typicalGap=Math.max(10,(maxPk-minPk)/Math.max(1,samples.length-1));
      const gapLimit=Math.max(35,typicalGap*4);
      for(const s of samples){
        if(prev && (s.pk-prev.pk>gapLimit || s.curveId!==prev.curveId)){ if(cur.length)groups.push(cur);cur=[]; }
        cur.push(s);prev=s;
      }
      if(cur.length)groups.push(cur);
      return groups.map(g=>g.map(s=>`${x(s.pk).toFixed(1)},${y(s[key]).toFixed(1)}`).join(' '));
    }
    groupsFor('project').forEach(points=>svg.append(svgEl('polyline',{points,class:'chart-line project'})));
    groupsFor('measured').forEach(points=>svg.append(svgEl('polyline',{points,class:'chart-line measured'})));

    const statusTitle=svgEl('text',{x:L+10,y:T+24,class:'chart-caption'});statusTitle.textContent=`${state.curves.length} curve analizzate · ${state.alerts.length} segnalazioni aggregate · affidabilità ${state.reliability.score}%`;svg.append(statusTitle);

    const alerts=state.alerts.slice().sort((a,b)=>a.start-b.start);
    if(!alerts.length){
      list.innerHTML='<div class="visual-ok"><span></span><div><strong>Tratto senza anomalie aggregate</strong><small>Il profilo confrontato non genera segnalazioni oltre le soglie impostate.</small></div></div>';
      return;
    }
    alerts.forEach(a=>{
      const card=document.createElement('div');card.className=`visual-alert-card visual-${a.level}`;
      const pct=Math.round((a.confidence||0)*100);
      card.innerHTML=`<div class="visual-code code-${a.level}">${levelLabel(a.level)}</div><div class="visual-alert-main"><strong>Curva ${a.curveId} · ${a.items[0]?.side||'—'}</strong><span>${formatPk(a.start)} ÷ ${formatPk(a.end)}</span></div><div class="visual-alert-values"><b>${rangeText(a.measuredMin,a.measuredMax)}</b><small>H rilevata</small></div><div class="visual-alert-values"><b>${a.deltaMax>=0?'+':''}${Math.round(a.deltaMax)} mm</b><small>Δ max</small></div><div class="visual-confidence"><b>${pct}%</b><small>affidabilità</small></div>`;
      list.append(card);
    });
  }

  async function svgToPngDataUrl(svg, scale=2){
    if(!svg)return null;
    const clone=svg.cloneNode(true);
    clone.setAttribute('xmlns','http://www.w3.org/2000/svg');
    const vb=(clone.getAttribute('viewBox')||'0 0 1100 340').split(/\s+/).map(Number);
    const width=vb[2]||1100,height=vb[3]||340;
    const css=getComputedStyle(document.documentElement);
    const style=document.createElementNS('http://www.w3.org/2000/svg','style');
    style.textContent=`.chart-bg{fill:#f8fafb;stroke:#dfe7ec}.chart-grid{stroke:#dfe7ec;stroke-width:1}.chart-grid.threshold{stroke:${COLORS.red};stroke-width:1.5;stroke-dasharray:7 6}.chart-axis-label{font:12px Arial,sans-serif;fill:#647483}.chart-axis-title{font:bold 12px Arial,sans-serif;fill:#405365}.chart-caption{font:bold 12px Arial,sans-serif;fill:#405365}.chart-tick{stroke:#8fa0ad}.chart-line{fill:none;stroke-width:3;stroke-linejoin:round;stroke-linecap:round}.chart-line.project{stroke:#445b6c}.chart-line.measured{stroke:#168ba5}.chart-alert-zone{opacity:.10}.chart-alert-red{fill:${COLORS.red}}.chart-alert-orange{fill:${COLORS.orange}}.chart-alert-yellow{fill:${COLORS.yellow}}`;
    clone.prepend(style);
    const xml=new XMLSerializer().serializeToString(clone);
    const blob=new Blob([xml],{type:'image/svg+xml;charset=utf-8'});const url=URL.createObjectURL(blob);
    try{
      const img=await new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=reject;im.src=url;});
      const canvas=document.createElement('canvas');canvas.width=Math.round(width*scale);canvas.height=Math.round(height*scale);
      const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.scale(scale,scale);ctx.drawImage(img,0,0,width,height);
      return canvas.toDataURL('image/png',0.96);
    } finally { URL.revokeObjectURL(url); }
  }

  function renderResults() {
    const alerts=state.alerts;
    ui.resultsSection.hidden=false;
    ui.alertsBody.innerHTML='';
    ui.allOk.hidden=alerts.length!==0;
    alerts.sort((a,b)=>levelRank(b.level)-levelRank(a.level)||a.curveId-b.curveId).forEach(a=>{
      const tr=document.createElement('tr');
      tr.className=`alert-${a.level}`;

      const tdCode=document.createElement('td');
      tdCode.innerHTML=`<span class="code-badge code-${a.level}">${levelLabel(a.level)}</span>`;
      tr.append(tdCode);

      const plain=[
        `Curva ${a.curveId} · ${a.items[0]?.side||'—'}`,
        `${formatPk(a.start)} ÷ ${formatPk(a.end)}`,
        rangeText(a.projectMin,a.projectMax),
        rangeText(a.measuredMin,a.measuredMax),
        `${a.deltaMax>=0?'+':''}${Math.round(a.deltaMax)} mm`,
        a.reason
      ];
      plain.forEach(text=>{const td=document.createElement('td');td.textContent=text;tr.append(td);});

      const pct=Math.round((a.confidence||0)*100);
      const tdConf=document.createElement('td');
      const cls=pct<65?'low':pct<80?'review':'';
      tdConf.innerHTML=`<div class="confidence-cell"><span class="confidence-dot ${cls}"></span><div><b>${pct}%</b><small>${reliabilityLabel(pct)}</small></div></div>`;
      tr.append(tdConf);
      ui.alertsBody.append(tr);
    });
    ui.curvesTotal.textContent=state.curves.length;
    ui.alertsTotal.textContent=alerts.length;
    ui.redTotal.textContent=alerts.filter(a=>a.level==='red').length;
    ui.orangeTotal.textContent=alerts.filter(a=>a.level==='orange').length;
    ui.yellowTotal.textContent=alerts.filter(a=>a.level==='yellow').length;
    renderReliability();
    ui.diagnostics.innerHTML=state.diagnostics.length?`<ul>${state.diagnostics.map(d=>`<li>${escapeHtml(d)}</li>`).join('')}</ul>`:'Nessuna nota tecnica.';
  }

  function escapeHtml(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}

  async function analyze() {
    if(state.projectStatus!=='ready'||!state.projectDataset.length||!state.graphFiles.length)return;
    ui.analyzeBtn.disabled=true; state.samples=[];state.alerts=[];state.curves=[];state.diagnostics=[];state.graphRanges=[];state.reliability={score:null,label:'Da calcolare',trace:0,coverage:0}; ui.resultsSection.hidden=true; renderReliability();
    const sampleStep=Number(ui.stepSelect.value)||5; const yellowTol=Number(ui.yellowInput.value)||10; const orangeFrom=Number(ui.orangeInput.value)||159;
    try{
      ui.statusLed.classList.remove('error'); ui.progressBar.classList.remove('error');
      setProgress(2,'Lettura dei grafici…');
      let graphSamples=[];
      for(let i=0;i<state.graphFiles.length;i++){
        const f=state.graphFiles[i];
        try{
          const one=f.type==='application/pdf'||/\.pdf$/i.test(f.name)?await analyzeGraphPdf(f,sampleStep,ui.trackSelect.value):await analyzeGraphImage(f,sampleStep);graphSamples.push(...one);
        }catch(err){state.diagnostics.push(`${f.name}: file ignorato · ${err.message||err}`);}
      }
      if(!state.graphRanges.length)throw new Error('Non riesco a riconoscere automaticamente le progressive dei grafici caricati. Usa preferibilmente il PDF originale RFI con le etichette km leggibili.');
      const targetMin=Math.min(...state.graphRanges.map(r=>r.min)),targetMax=Math.max(...state.graphRanges.map(r=>r.max));
      setProgress(62,'Uso del dataset di progetto già preparato…');
      const projectRows=projectRowsForRange(targetMin,targetMax,ui.trackSelect.value);updateProjectAuditForRows(projectRows);
      if(projectRows.length<4)throw new Error(`Il tabellino è stato validato, ma nella tratta ${formatPk(targetMin)}–${formatPk(targetMax)} non ci sono abbastanza punti progetto. Verifica il binario selezionato.`);
      state.curves=buildCurves(projectRows);setProgress(82,'Confronto progetto / riscontro…');
      state.samples=compareSamples(graphSamples,projectRows,state.curves,yellowTol,orangeFrom);state.alerts=aggregateAlerts(state.samples,sampleStep);computeReliability(graphSamples.length);
      const prep=state.projectAudit.preprocessSummary||{};
      state.diagnostics.push(`Tabellino pre-elaborato: ${state.projectDataset.length} coppie Progressiva/H disponibili; ${prep.textPages||0} pagina/e da testo, ${prep.ocrPages||0} pagina/e con OCR guidato dalla griglia, ${prep.recoveredCells||0} cella/e recuperate con seconda lettura mirata.`);
      state.diagnostics.push(`Tratta richiesta dai grafici: ${formatPk(targetMin)}–${formatPk(targetMax)}. Punti progetto usati: ${projectRows.length}; pagine progetto coinvolte: ${new Set(projectRows.map(r=>r.page)).size}.`);
      state.diagnostics.push(`Campioni grafico affidabili: ${graphSamples.length}. Campioni confrontati: ${state.samples.length}. Motore alta precisione: inseguimento denso bidirezionale, più ipotesi simultanee e validazione obbligatoria dei tratti prossimi a H=0.`);
      state.diagnostics.push(`Regole: ROSSO >160 mm; ARANCIO da ${orangeFrom} mm se non previsto; GIALLO |Δ| ≥ ${yellowTol} mm; priorità rosso > arancio > giallo > verde.`);
      setProgress(100,'Analisi completata');renderResults();ui.statusTitle.textContent='Analisi completata';ui.statusText.textContent=`${state.alerts.length} curva/e aggregate da verificare · ${projectRows.length} punti progetto usati · affidabilità ${state.reliability.score}%.`;ui.statusLed.classList.remove('ready');ui.statusLed.classList.add('done');requestAnimationFrame(()=>ui.resultsSection.scrollIntoView({behavior:'smooth',block:'start'}));setTimeout(hideProgress,900);
    }catch(err){console.error(err);ui.statusTitle.textContent='Analisi non completata';ui.statusText.textContent=err.message||'Errore durante l’analisi.';state.diagnostics.push(err.stack||String(err));ui.statusLed.classList.remove('ready','done');ui.statusLed.classList.add('error');ui.progressBar.classList.add('error');setProgress(100,'Analisi interrotta');}
    finally{ui.analyzeBtn.disabled=!(state.projectStatus==='ready'&&state.projectDataset.length&&state.graphFiles.length);}
  }

  function reset(){
    state.projectJobSeq++; state.projectFiles=[];state.graphFiles=[];state.projectDataset=[];state.projectStats=null;state.projectStatus='idle';state.projectError='';
    state.samples=[];state.alerts=[];state.curves=[];state.diagnostics=[];state.graphRanges=[];state.reliability={score:null,label:'Da calcolare',trace:0,coverage:0};state.projectAudit={files:0,indexPages:[],parsedPages:[],candidatePages:[],points:0,coverageMin:null,coverageMax:null,maxGap:null,trackChecks:[]};
    ui.progressBar.classList.remove('error');ui.statusLed.classList.remove('error','done','ready');renderFileList('project');renderFileList('graph');ui.resultsSection.hidden=true;hideProgress();renderProjectPreview();renderProjectJobState();renderReliability();updateReadyState();
  }

  function loadDemoPreview(){
    state.projectStatus='ready'; state.projectDataset=[{pk:15400,h:0,track:'dispari',file:'demo',page:1}]; state.projectStats=projectStats(state.projectDataset);
    state.projectFiles=[{name:'B.A. Approv P-D posa Totale.pdf',size:6842000,lastModified:Date.now(),type:'application/pdf'}];
    state.graphFiles=[{name:'Grafico_acquisizione_pag_23.pdf',size:1840000,lastModified:Date.now(),type:'application/pdf'},{name:'Grafico_acquisizione_pag_24.pdf',size:1760000,lastModified:Date.now()-1,type:'application/pdf'}];
    renderFileList('project'); renderFileList('graph'); updateReadyState();
    state.curves=[{id:1},{id:2},{id:3},{id:4},{id:5},{id:6}];
    state.samples=[];
    for(let pk=15400;pk<=17000;pk+=10){
      let project=0,curveId=1,side='Sx';
      if(pk>=15600&&pk<=15800){curveId=5;side='Dx';project=pk<15680?160:Math.max(0,160-(pk-15680)*1.35);}
      else if(pk>=16400&&pk<=16850){curveId=2;side='Sx';project=pk<16440?Math.max(0,(pk-16400)*2.75):pk<=16760?110:Math.max(0,110-(pk-16760)*1.25);}
      else {curveId=pk<16400?4:6;project=0;}
      let measured=project;
      if(pk>=15610&&pk<=15665) measured=164;
      else if(pk>=15680&&pk<=15705) measured=159.5;
      else if(pk>=16435&&pk<=16760) measured=Math.min(132,project+20);
      const level=measured>160?'red':(measured>=159&&project<159?'orange':(Math.abs(measured-project)>=10?'yellow':'green'));
      state.samples.push({pk,project,measured,delta:measured-project,curveId,side,level,confidence:.93});
    }
    state.reliability={score:94,label:'Alta',trace:.95,coverage:.90};
    state.alerts=[
      {curveId:5,level:'red',start:15610,end:15665,projectMin:160,projectMax:160,measuredMin:161,measuredMax:166,deltaMax:6,reason:'Superamento 160 mm',confidence:.96,items:[{side:'Dx'}]},
      {curveId:4,level:'orange',start:15680,end:15705,projectMin:145,projectMax:158,measuredMin:159,measuredMax:160,deltaMax:14,reason:'Avvicinamento a 159/160 mm non previsto dal progetto',confidence:.92,items:[{side:'Dx'}]},
      {curveId:2,level:'yellow',start:16435,end:16760,projectMin:110,projectMax:110,measuredMin:127,measuredMax:131,deltaMax:21,reason:'Scostamento dal progetto ≥ ±10 mm',confidence:.95,items:[{side:'Sx'}]}
    ];
    state.diagnostics=['Anteprima grafica: dati dimostrativi, non derivati da un’analisi reale.','La versione operativa calcola l’indice di affidabilità dalla qualità della traccia e dalla copertura del confronto.'];
    renderResults();
    ui.statusTitle.textContent='Anteprima completata';
    ui.statusText.textContent='3 curve aggregate da verificare · affidabilità 94%.';
    ui.statusLed.classList.remove('ready'); ui.statusLed.classList.add('done');
  }

  wireDropzone('project',ui.projectDrop,ui.projectInput); wireDropzone('graph',ui.graphDrop,ui.graphInput);
  ui.analyzeBtn.addEventListener('click',analyze); ui.resetBtn.addEventListener('click',reset); ui.printBtn.addEventListener('click',()=>window.print());
  ui.trackSelect.addEventListener('change',()=>{ if(state.projectFiles.length) startProjectPreprocessing(); else updateReadyState(); });
  ui.projectRetryBtn.addEventListener('click',startProjectPreprocessing);
  renderReliability(); renderProjectJobState(); renderProjectPreview();
  if(new URLSearchParams(window.location.search).get('demo')==='1') loadDemoPreview(); else updateReadyState();
})();
