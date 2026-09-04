/* I-Sopraelevazione v1.4.0 - static GitHub Pages app
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

  async function analyzeGraphPdf(file, sampleStep) {
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
      const scale = 2; const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true }); await page.render({ canvasContext: ctx, viewport }).promise;
      const mappedKm = kmItems.map(i => { const p = viewport.convertToViewportPoint(i.pdfX, i.pdfY); return { pk: i.pk, x: p[0] }; }).sort((a,b) => a.x-b.x);
      const supraP = viewport.convertToViewportPoint(supra.pdfX, supra.pdfY);
      const zeroCandidates = items.filter(i => /^0[.,]0$/.test(i.str)).map(i => { const p = viewport.convertToViewportPoint(i.pdfX, i.pdfY); return { x:p[0], y:p[1], d:Math.abs(p[1]-supraP[1]) }; }).sort((a,b)=>a.d-b.d);
      if (!zeroCandidates.length) { state.diagnostics.push(`${file.name} p.${pageNo}: linea di fede non riconosciuta.`); continue; }
      const zeroY = zeroCandidates[0].y;
      const fit = linearFit(mappedKm.map(k => [k.x, k.pk]));
      const xMin = Math.min(...mappedKm.map(k=>k.x)); const xMax = Math.max(...mappedKm.map(k=>k.x));
      const pkA = fit.a*xMin+fit.b, pkB = fit.a*xMax+fit.b; const pkMin = Math.min(pkA,pkB), pkMax = Math.max(pkA,pkB);
      state.graphRanges.push({ file:file.name, page:pageNo, min:pkMin, max:pkMax });
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const mmPerPixel = (25.4 / 72 / scale) * 6.0;
      let prevY = zeroY;
      const startPk = Math.ceil(pkMin / sampleStep) * sampleStep;
      for (let pk = startPk; pk <= pkMax; pk += sampleStep) {
        let x = (pk - fit.b) / fit.a;
        if (!Number.isFinite(x) || x < xMin || x > xMax) continue;
        const y = traceAtX(image, canvas.width, canvas.height, x, zeroY, prevY, scale);
        prevY = y;
        const measured = Math.abs(y - zeroY) * mmPerPixel;
        const confidence = traceConfidence(image, canvas.width, canvas.height, x, y, zeroY);
        out.push({ source:file.name, page:pageNo, pk, measured, signed:(zeroY-y)*mmPerPixel, confidence });
      }
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

  function horizontalScore(data, width, height, x, y) {
    let sum=0, n=0; for(let dx=-4;dx<=4;dx++){ sum += grayAt(data,width,height,x+dx,y); n++; } return sum/n;
  }

  function traceAtX(data, width, height, x, zeroY, prevY, scale) {
    const searchRadius = Math.round(95*scale/2); const continuity = Math.round(22*scale/2);
    let bestY = zeroY, best = 999;
    const centers = [prevY, zeroY];
    for (const center of centers) {
      const r = center===zeroY ? searchRadius : continuity;
      for (let y=Math.max(2,Math.round(center-r)); y<=Math.min(height-3,Math.round(center+r)); y++) {
        const dz = Math.abs(y-zeroY);
        if (dz < 2.5) continue; // maschera la linea di fede; zero viene ricostruito in assenza di traccia
        const g = horizontalScore(data,width,height,x,y);
        const continuityPenalty = Math.abs(y-prevY)*1.15;
        const score = g + continuityPenalty;
        if (g < 242 && score < best) { best=score; bestY=y; }
      }
    }
    if (best > 250 || Math.abs(bestY-prevY)>continuity*1.5) return zeroY;
    if (Math.abs(bestY-zeroY) < 5) return zeroY;
    return bestY;
  }

  function traceConfidence(data, width, height, x, y, zeroY) {
    if (Math.abs(y-zeroY)<2) return 0.92;
    const g = horizontalScore(data,width,height,x,y); return Math.max(.45,Math.min(.98,(255-g)/80));
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
        ui.projectJobText.textContent = `OCR delle sole colonne necessarie · ${Math.round(m.progress * 100)}% della porzione corrente`;
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

  async function parseProjectPageOcr(pdf, pageNo, worker, track, fileName, jobId) {
    // OCR ad alta definizione ma su due strisce strette: Progressiva e H/rotaia.
    const full=await renderPdfPage(pdf,pageNo,4.0);
    try{
      if(jobId!==state.projectJobSeq) return [];
      const y0=.052,y1=.965;
      const pkCrop=cropCanvas(full,.255,y0,.350,y1);
      const hCrop=cropCanvas(full,.640,y0,.760,y1);

      await worker.setParameters({preserve_interword_spaces:'1',tessedit_pageseg_mode:'6',tessedit_char_whitelist:'0123456789+-.OoVv#='});
      const pkResult=await worker.recognize(pkCrop.canvas);
      if(jobId!==state.projectJobSeq) return [];
      await worker.setParameters({preserve_interword_spaces:'1',tessedit_pageseg_mode:'6',tessedit_char_whitelist:'0123456789OoSxDXdx|-_'});
      const hResult=await worker.recognize(hCrop.canvas);

      const rowTol=Math.max(14,pkCrop.sh*.006), matchTol=rowTol*1.75;
      const pkRows=ocrRowsFromWords(pkResult.data.words||[],pkCrop.sw,rowTol).map(r=>{
        const text=r.items.map(i=>i.text).join('');
        const conf=r.items.length?r.items.reduce((s,i)=>s+i.confidence,0)/r.items.length:0;
        return {cy:r.cy,pk:parseProjectPk(text),conf,text};
      }).filter(r=>Number.isFinite(r.pk));
      const hRows=ocrRowsFromWords(hResult.data.words||[],hCrop.sw,rowTol).map(r=>{
        const text=r.items.map(i=>i.text).join(' '); const tokens=text.match(/\d{1,3}|[Oo]{1,3}/g)||[]; let h=null;
        for(const token of tokens){const n=Number(token.replace(/[Oo]/g,'0'));if(Number.isFinite(n)&&n>=0&&n<=200){h=n;break;}}
        const sm=text.match(/(sx|dx)/i); const conf=r.items.length?r.items.reduce((s,i)=>s+i.confidence,0)/r.items.length:0;
        return {cy:r.cy,h,side:sm?sm[1][0].toUpperCase()+sm[1][1].toLowerCase():'',conf,text};
      }).filter(r=>Number.isFinite(r.h));

      const parsed=[];
      for(const p of pkRows){
        let best=null;
        for(const h of hRows){const d=Math.abs(h.cy-p.cy);if(d<=matchTol&&(!best||d<best.d))best={...h,d};}
        if(!best) continue;
        const hValue=best.h;
        parsed.push({pk:p.pk,h:hValue,side:best.side,page:pageNo,file:fileName,track,method:'ocr-columns',confidence:Math.max(.35,Math.min(.98,((p.conf||.6)+(best.conf||.6))/2))});
      }
      return sanitizeProjectPageRows(parsed);
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
    const pdf=await loadPdf(file); const plan=pagesForSelectedTrack(pdf.numPages,trackMode); const out=[]; let ocrPages=0,textPages=0;
    for(let i=0;i<plan.length;i++){
      if(jobId!==state.projectJobSeq) throw new Error('__JOB_CANCELLED__');
      const {page:pageNo,track}=plan[i];
      setProjectJobProgress(progressBase+((i+.15)/Math.max(1,plan.length))*progressSpan,`${file.name} · pagina ${pageNo}/${pdf.numPages}`);
      let rows=[];
      try{rows=await parseProjectPageText(pdf,pageNo,track,file.name);}catch(err){console.warn('Text parser page error',file.name,pageNo,err);}
      if(rows.length>=4) textPages++;
      else{
        if(!workerHolder.worker) workerHolder.worker=await createProjectOcrWorker(jobId);
        rows=await parseProjectPageOcr(pdf,pageNo,workerHolder.worker,track,file.name,jobId); if(rows.length)ocrPages++;
      }
      out.push(...rows); await new Promise(resolve=>setTimeout(resolve,0));
    }
    return {rows:out,textPages,ocrPages,pages:plan.map(x=>x.page)};
  }

  async function startProjectPreprocessing() {
    const jobId=++state.projectJobSeq;
    state.projectDataset=[];state.projectStats=null;state.projectError='';renderProjectPreview();
    state.projectAudit={files:state.projectFiles.length,indexPages:[],parsedPages:[],candidatePages:[],points:0,coverageMin:null,coverageMax:null,maxGap:null,trackChecks:[]};
    if(!state.projectFiles.length){state.projectStatus='idle';renderProjectJobState();updateReadyState();return;}

    state.projectStatus='processing';renderProjectJobState();setProjectJobProgress(1,'Avvio preparazione tabellino');updateReadyState();
    const trackMode=ui.trackSelect.value; const workerHolder={worker:null}; let all=[]; let totalText=0,totalOcr=0,allPages=[];
    try{
      for(let f=0;f<state.projectFiles.length;f++){
        if(jobId!==state.projectJobSeq) throw new Error('__JOB_CANCELLED__');
        const file=state.projectFiles[f], base=2+(f/state.projectFiles.length)*94, span=94/state.projectFiles.length;
        const result=await preprocessProjectFile(file,trackMode,jobId,workerHolder,base,span);
        all.push(...result.rows); totalText+=result.textPages; totalOcr+=result.ocrPages; allPages.push(...result.pages);
      }
      if(jobId!==state.projectJobSeq) throw new Error('__JOB_CANCELLED__');
      all=dedupeProjectRows(all);
      if(trackMode==='pari'||trackMode==='dispari') all=all.filter(r=>r.track===trackMode||r.track==='auto');
      const validation=validateProjectRows(all); if(!validation.ok) throw new Error(validation.message);

      state.projectDataset=all;state.projectStats=validation.stats;state.projectStatus='ready';
      const pks=all.map(r=>r.pk).sort((a,b)=>a-b),gaps=pks.slice(1).map((v,i)=>v-pks[i]);
      state.projectAudit={files:state.projectFiles.length,indexPages:[],parsedPages:Array.from(new Set(all.map(r=>r.page).filter(Number.isFinite))),candidatePages:Array.from(new Set(allPages)),points:all.length,coverageMin:pks[0],coverageMax:pks[pks.length-1],maxGap:gaps.length?Math.max(...gaps):0,trackChecks:[]};
      state.projectAudit.preprocessSummary={textPages:totalText,ocrPages:totalOcr,trackMode};
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
          const one=f.type==='application/pdf'||/\.pdf$/i.test(f.name)?await analyzeGraphPdf(f,sampleStep):await analyzeGraphImage(f,sampleStep);graphSamples.push(...one);
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
      state.diagnostics.push(`Tabellino pre-elaborato: ${state.projectDataset.length} coppie Progressiva/H disponibili; ${prep.textPages||0} pagina/e lette da testo e ${prep.ocrPages||0} pagina/e tramite OCR mirato.`);
      state.diagnostics.push(`Tratta richiesta dai grafici: ${formatPk(targetMin)}–${formatPk(targetMax)}. Punti progetto usati: ${projectRows.length}; pagine progetto coinvolte: ${new Set(projectRows.map(r=>r.page)).size}.`);
      state.diagnostics.push(`Campioni grafico: ${graphSamples.length}. Campioni confrontati: ${state.samples.length}.`);
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
