/* I-Sopraelevazione v1.3.2 - static GitHub Pages app
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
    overallReliabilityTop: $('overallReliabilityTop'), overallReliabilityPill: $('overallReliabilityPill')
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
    for (const file of Array.from(list || [])) {
      if (valid(file) && !existing.has(fileKey(file))) {
        arr.push(file); existing.add(fileKey(file));
      }
    }
    renderFileList(kind); updateReadyState();
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
      remove.addEventListener('click', () => { arr.splice(index, 1); renderFileList(kind); updateReadyState(); });
      meta.append(name, size); row.append(meta, remove); wrap.append(row);
    });
  }

  function updateReadyState() {
    const ready = state.projectFiles.length > 0 && state.graphFiles.length > 0;
    ui.analyzeBtn.disabled = !ready;
    ui.statusLed.classList.toggle('ready', ready);
    ui.statusLed.classList.remove('done', 'error');
    if (ready) {
      ui.statusTitle.textContent = 'Pronto per l’analisi';
      ui.statusText.textContent = `${state.projectFiles.length} tabellino/i e ${state.graphFiles.length} grafico/i caricati.`;
    } else {
      ui.statusTitle.textContent = 'In attesa dei file';
      ui.statusText.textContent = state.projectFiles.length ? 'Manca almeno un grafico.' : state.graphFiles.length ? 'Manca almeno un tabellino.' : 'Carica almeno un tabellino e un grafico.';
    }
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
    const s = String(raw).replace(/\s/g, '').replace(',', '.').replace(/[Oo]/g, '0');
    let m = s.match(/(\d{1,3})\+(\d{1,3}(?:\.\d{1,3})?)/);
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

  async function createOcrWorker() {
    const worker = await Tesseract.createWorker('eng', 1, { logger: m => {
      if (m.status === 'recognizing text' && Number.isFinite(m.progress)) setProgress(32 + m.progress*18, `OCR tabellino · ${Math.round(m.progress*100)}%`);
    }});
    await worker.setParameters({ preserve_interword_spaces: '1' }); return worker;
  }

  async function renderPdfPage(pdf, pageNo, scale=1.6) {
    const page = await pdf.getPage(pageNo); const vp = page.getViewport({scale}); const c=document.createElement('canvas'); c.width=Math.ceil(vp.width); c.height=Math.ceil(vp.height); await page.render({canvasContext:c.getContext('2d'),viewport:vp}).promise; return c;
  }

  function cropCanvas(source, x0,y0,x1,y1) {
    const c=document.createElement('canvas'); const sx=Math.round(source.width*x0), sy=Math.round(source.height*y0), sw=Math.round(source.width*(x1-x0)), sh=Math.round(source.height*(y1-y0)); c.width=sw; c.height=sh; c.getContext('2d').drawImage(source,sx,sy,sw,sh,0,0,sw,sh); return {canvas:c, sx, sy, sw, sh};
  }

  async function getPagePkRange(pdf, pageNo, worker) {
    // Prima prova il text layer nativo: quando presente è quasi istantaneo.
    try {
      const page = await pdf.getPage(pageNo);
      const text = await page.getTextContent();
      const nativeVals = (text.items || []).map(i => parsePkString(i.str)).filter(Number.isFinite);
      if (nativeVals.length >= 2) return { min: Math.min(...nativeVals), max: Math.max(...nativeVals), method: 'text' };
    } catch (_) {}

    // PDF scansito: OCR soltanto l'inizio e la fine della colonna Progressiva.
    // È sufficiente per ordinare le pagine ed evita l'OCR dell'intera colonna.
    const full = await renderPdfPage(pdf, pageNo, .92);
    const top = cropCanvas(full, .255, .07, .385, .285);
    const bottom = cropCanvas(full, .255, .735, .385, .95);
    const gap = 8;
    const compact = document.createElement('canvas');
    compact.width = Math.max(top.sw, bottom.sw);
    compact.height = top.sh + gap + bottom.sh;
    const cctx = compact.getContext('2d');
    cctx.fillStyle = '#fff'; cctx.fillRect(0,0,compact.width,compact.height);
    cctx.drawImage(top.canvas,0,0); cctx.drawImage(bottom.canvas,0,top.sh+gap);
    await worker.setParameters({ preserve_interword_spaces: '1', tessedit_char_whitelist: '0123456789+-,.' });
    const r = await worker.recognize(compact);
    const vals = (r.data.text.match(/\d{1,3}\s*[+\-]\s*\d{1,3}(?:[\.,]\d{1,3})?/g)||[]).map(parsePkString).filter(Number.isFinite);
    if(!vals.length) return null;
    return {min:Math.min(...vals),max:Math.max(...vals),method:'ocr'};
  }

  async function locatePages(pdf, targetMin, targetMax, worker, trackMode) {
    let start=2,end=pdf.numPages;
    if(trackMode==='pari') end=Math.max(2,Math.floor(pdf.numPages/2)+1);
    if(trackMode==='dispari') start=Math.max(2,Math.floor(pdf.numPages/2)+1);
    const cache=new Map();
    let indexCount=0;
    async function range(p){
      if(cache.has(p)) return cache.get(p);
      setProgress(31 + Math.min(12,indexCount*1.4), `Indicizzazione rapida tabellino · pagina ${p}`);
      const r=await getPagePkRange(pdf,p,worker); cache.set(p,r); indexCount++;
      state.projectAudit.indexPages.push(p);
      return r;
    }

    // Le progressive del tabellino sono ordinate per pagina. Ricerca binaria: ~6-8
    // pagine indice su 50, invece di OCR sequenziale/coarse scan di decine di pagine.
    async function nearestValid(p, lo, hi){
      const direct=await range(p); if(direct) return {p,r:direct};
      for(let d=1;d<=2;d++){
        if(p-d>=lo){const r=await range(p-d);if(r)return {p:p-d,r};}
        if(p+d<=hi){const r=await range(p+d);if(r)return {p:p+d,r};}
      }
      return null;
    }

    async function firstPageWithMaxAtLeast(value){
      let lo=start, hi=end, ans=end;
      while(lo<=hi){
        const mid=Math.floor((lo+hi)/2); const got=await nearestValid(mid,start,end);
        if(!got) break;
        if(got.r.max >= value){ans=got.p;hi=got.p-1;} else lo=got.p+1;
      }
      return ans;
    }
    async function lastPageWithMinAtMost(value){
      let lo=start, hi=end, ans=start;
      while(lo<=hi){
        const mid=Math.floor((lo+hi)/2); const got=await nearestValid(mid,start,end);
        if(!got) break;
        if(got.r.min <= value){ans=got.p;lo=got.p+1;} else hi=got.p-1;
      }
      return ans;
    }

    let lo=await firstPageWithMaxAtLeast(targetMin-150);
    let hi=await lastPageWithMinAtMost(targetMax+150);
    lo=Math.max(start,lo-1); hi=Math.min(end,hi+1);
    if(lo>hi){ const t=lo;lo=hi;hi=t; }
    const pages=[];
    // Verifica soltanto la piccola finestra individuata dalla ricerca binaria.
    for(let p=lo;p<=hi;p++){
      const r=await range(p);
      if(r && r.max>=targetMin-180 && r.min<=targetMax+180) pages.push(p);
    }
    if(!pages.length){
      // Fallback prudente: piccola finestra centrale, mai scansione indiscriminata.
      const mid=Math.floor((lo+hi)/2);
      for(let p=Math.max(start,mid-2);p<=Math.min(end,mid+2);p++) pages.push(p);
    }
    state.projectAudit.candidatePages.push(...pages);
    return Array.from(new Set(pages)).sort((a,b)=>a-b);
  }

  function groupWordsIntoRows(words) {
    const rows=[];
    const sorted=words.filter(w=>w.text&&w.text.trim()).sort((a,b)=>((a.bbox.y0+a.bbox.y1)/2)-((b.bbox.y0+b.bbox.y1)/2));
    for(const w of sorted){ const cy=(w.bbox.y0+w.bbox.y1)/2; let row=rows.find(r=>Math.abs(r.cy-cy)<8); if(!row){row={cy,words:[]};rows.push(row);} row.words.push(w); row.cy=(row.cy*(row.words.length-1)+cy)/row.words.length; }
    rows.forEach(r=>r.words.sort((a,b)=>a.bbox.x0-b.bbox.x0)); return rows;
  }

  function normalizeNumeric(s) { return String(s||'').replace(/[Oo]/g,'0').replace(',','.').replace(/[^0-9.+-]/g,''); }

  async function detectPageTrack(pdf, pageNo, worker) {
    // Ogni foglio del tabellino riporta in alto BINARIO PARI o BINARIO DISPARI.
    // Prima usiamo il text-layer (istantaneo), poi OCR soltanto sulla testata.
    let text = '';
    try {
      const page = await pdf.getPage(pageNo);
      const tc = await page.getTextContent();
      text = (tc.items || []).map(i => i.str || '').join(' ').toUpperCase();
    } catch (_) {}
    const fromText = /BINARIO\s+DISPARI/.test(text) ? 'dispari' : (/BINARIO\s+PARI/.test(text) ? 'pari' : null);
    if (fromText) return { track: fromText, method: 'text' };

    const full = await renderPdfPage(pdf, pageNo, 1.0);
    const head = cropCanvas(full, .20, .00, .82, .115).canvas;
    await worker.setParameters({ preserve_interword_spaces: '1' });
    const r = await worker.recognize(head);
    const t = String(r.data.text || '').toUpperCase().replace(/\s+/g, ' ');
    const track = /BINARIO\s+DISPARI/.test(t) ? 'dispari' : (/BINARIO\s+PARI/.test(t) ? 'pari' : null);
    return { track, method: 'ocr' };
  }

  async function parseProjectPage(pdf,pageNo,worker,trackMode) {
    // Prima verifica obbligatoria: il binario scritto nella testata deve coincidere
    // con il selettore dell'utente. Una pagina dell'altro binario non viene letta.
    const trackInfo = await detectPageTrack(pdf, pageNo, worker);
    state.projectAudit.trackChecks.push({page:pageNo, detected:trackInfo.track, selected:trackMode, method:trackInfo.method});
    if (!trackInfo.track) {
      state.diagnostics.push(`Pagina ${pageNo}: BINARIO PARI/DISPARI non riconosciuto in testata; pagina esclusa.`);
      return [];
    }
    if (trackInfo.track !== trackMode) {
      state.diagnostics.push(`Pagina ${pageNo}: testata BINARIO ${trackInfo.track.toUpperCase()} diversa dal selettore ${trackMode.toUpperCase()}; pagina esclusa.`);
      return [];
    }

    // Lettura minima del tabellino: SOLO Progressiva e colonna H.
    // Le due colonne vengono affiancate in un unico piccolo canvas per velocizzare OCR.
    const full=await renderPdfPage(pdf,pageNo,1.58);
    const progressiva=cropCanvas(full,.255,.075,.390,.955);
    const hcol=cropCanvas(full,.640,.075,.710,.955);
    const gap=12;
    const combo=document.createElement('canvas');
    combo.width=progressiva.sw+gap+hcol.sw; combo.height=Math.max(progressiva.sh,hcol.sh);
    const ctx=combo.getContext('2d'); ctx.fillStyle='#fff';ctx.fillRect(0,0,combo.width,combo.height);
    ctx.drawImage(progressiva.canvas,0,0); ctx.drawImage(hcol.canvas,progressiva.sw+gap,0);
    await worker.setParameters({ preserve_interword_spaces:'1', tessedit_char_whitelist:'0123456789+-,.' });
    const result=await worker.recognize(combo);
    const rows=groupWordsIntoRows(result.data.words||[]); const parsed=[];
    for(const row of rows){
      const mapped=row.words.map(w=>{
        const cx=(w.bbox.x0+w.bbox.x1)/2; let zone='';
        if(cx<=progressiva.sw) zone='pk';
        else if(cx>=progressiva.sw+gap) zone='h';
        return {text:w.text.trim(),zone};
      }).filter(w=>w.zone);
      const pkWord=mapped.find(w=>w.zone==='pk'&&parsePkString(w.text)!=null); if(!pkWord)continue;
      const pk=parsePkString(pkWord.text);
      const hRaw=mapped.filter(w=>w.zone==='h').map(w=>normalizeNumeric(w.text)).find(t=>/^[-+]?\d{1,3}(?:\.\d+)?$/.test(t));
      const h=hRaw==null?null:Number(hRaw);
      if(Number.isFinite(pk) && Number.isFinite(h) && h>=0 && h<=250) parsed.push({pk,h,side:'',page:pageNo,track:trackMode});
    }
    state.projectAudit.parsedPages.push(pageNo);
    return dedupeProjectRows(parsed);
  }

  function dedupeProjectRows(rows){ const map=new Map(); rows.forEach(r=>{ const k=Math.round(r.pk*10)/10; const old=map.get(k); if(!old||(!old.side&&r.side))map.set(k,r); }); return Array.from(map.values()).sort((a,b)=>a.pk-b.pk); }

  async function extractProjectRows(targetMin,targetMax,trackMode){
    const worker=await createOcrWorker(); let all=[];
    state.projectAudit={files:state.projectFiles.length,indexPages:[],parsedPages:[],candidatePages:[],points:0,coverageMin:null,coverageMax:null,maxGap:null,trackChecks:[]};
    try{
      for(let f=0;f<state.projectFiles.length;f++){
        const file=state.projectFiles[f];
        try {
          const pdf=await loadPdf(file); setProgress(31,`Localizzazione rapida tratto · ${file.name}`);
          const pages=await locatePages(pdf,targetMin,targetMax,worker,trackMode);
          state.diagnostics.push(`${file.name}: pagine utili individuate ${pages.join(', ')||'nessuna'}; pagine indice lette ${Array.from(new Set(state.projectAudit.indexPages)).sort((a,b)=>a-b).join(', ')}.`);
          for(let i=0;i<pages.length;i++){
            setProgress(48+(i/Math.max(1,pages.length))*27,`Lettura dati progetto · pagina ${pages[i]} (${i+1}/${pages.length})`);
            const rows=await parseProjectPage(pdf,pages[i],worker,trackMode); all.push(...rows);
          }
        } catch (err) {
          state.diagnostics.push(`${file.name}: file di progetto ignorato · ${err.message||err}`);
        }
      }
    } finally { await worker.terminate(); }
    all=dedupeProjectRows(all).filter(r=>r.pk>=targetMin-180&&r.pk<=targetMax+180);
    if(all.length){
      const pks=all.map(r=>r.pk).sort((a,b)=>a-b);
      const gaps=pks.slice(1).map((v,i)=>v-pks[i]);
      state.projectAudit.points=all.length; state.projectAudit.coverageMin=pks[0]; state.projectAudit.coverageMax=pks[pks.length-1]; state.projectAudit.maxGap=gaps.length?Math.max(...gaps):0;
      const checked=state.projectAudit.trackChecks.filter(x=>x.detected); const accepted=checked.filter(x=>x.detected===trackMode).length; const rejected=checked.length-accepted; state.diagnostics.push(`Binario selezionato: ${trackMode.toUpperCase()}. Testate verificate: ${checked.length}; coerenti: ${accepted}; escluse per binario diverso: ${rejected}.`);
      const coverStart=pks[0] <= targetMin+80; const coverEnd=pks[pks.length-1] >= targetMax-80;
      if(!coverStart || !coverEnd) state.diagnostics.push(`ATTENZIONE: copertura tabellino parziale (${formatPk(pks[0])}–${formatPk(pks[pks.length-1])}) rispetto al grafico (${formatPk(targetMin)}–${formatPk(targetMax)}).`);
    }
    return all;
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
    if(!state.projectFiles.length||!state.graphFiles.length)return;
    ui.analyzeBtn.disabled=true; state.samples=[];state.alerts=[];state.curves=[];state.diagnostics=[];state.graphRanges=[];state.reliability={score:null,label:'Da calcolare',trace:0,coverage:0}; state.projectAudit={files:0,indexPages:[],parsedPages:[],candidatePages:[],points:0,coverageMin:null,coverageMax:null,maxGap:null,trackChecks:[]}; ui.resultsSection.hidden=true; renderReliability();
    const sampleStep=Number(ui.stepSelect.value)||5; const yellowTol=Number(ui.yellowInput.value)||10; const orangeFrom=Number(ui.orangeInput.value)||159;
    try{
      ui.statusLed.classList.remove('error'); ui.progressBar.classList.remove('error');
      setProgress(2,'Preparazione dei file…');
      let graphSamples=[];
      for(let i=0;i<state.graphFiles.length;i++){
        const f=state.graphFiles[i];
        try {
          const one=f.type==='application/pdf'||/\.pdf$/i.test(f.name)?await analyzeGraphPdf(f,sampleStep):await analyzeGraphImage(f,sampleStep);
          graphSamples.push(...one);
        } catch (err) {
          state.diagnostics.push(`${f.name}: file ignorato · ${err.message||err}`);
        }
      }
      if(!state.graphRanges.length) throw new Error('Non riesco a riconoscere automaticamente le progressive dei grafici caricati. Usa preferibilmente il PDF originale RFI con le etichette km leggibili.');
      const targetMin=Math.min(...state.graphRanges.map(r=>r.min)), targetMax=Math.max(...state.graphRanges.map(r=>r.max));
      setProgress(30,'Ricerca del tratto nel tabellino di progetto…');
      const projectRows=await extractProjectRows(targetMin,targetMax,ui.trackSelect.value);
      if(projectRows.length<4) throw new Error('Il tabellino è stato letto ma non sono stati riconosciuti abbastanza punti Progressiva/H. Prova a selezionare Pari o Dispari oppure usa un PDF più nitido.');
      state.curves=buildCurves(projectRows); setProgress(82,'Confronto progetto / riscontro…');
      state.samples=compareSamples(graphSamples,projectRows,state.curves,yellowTol,orangeFrom);
      state.alerts=aggregateAlerts(state.samples,sampleStep);
      computeReliability(graphSamples.length);
      state.diagnostics.push(`Campioni grafico: ${graphSamples.length}. Coppie Progressiva/H riconosciute: ${projectRows.length}. Campioni confrontati: ${state.samples.length}.`);
      state.diagnostics.push(`Controllo completezza tabellino: ${new Set(state.projectAudit.parsedPages).size} pagina/e dati analizzate; copertura ${formatPk(state.projectAudit.coverageMin)}–${formatPk(state.projectAudit.coverageMax)}; intervallo massimo tra punti ${Math.round(state.projectAudit.maxGap||0)} m.`);
      state.diagnostics.push(`Regole: ROSSO >160 mm; ARANCIO da ${orangeFrom} mm se non previsto; GIALLO |Δ| ≥ ${yellowTol} mm; priorità rosso > arancio > giallo > verde.`);
      setProgress(100,'Analisi completata'); renderResults(); ui.statusTitle.textContent='Analisi completata'; ui.statusText.textContent=`${state.alerts.length} curva/e aggregate da verificare · ${projectRows.length} punti progetto letti su ${new Set(state.projectAudit.parsedPages).size} pagina/e utili · affidabilità ${state.reliability.score}%.`; ui.statusLed.classList.remove('ready'); ui.statusLed.classList.add('done'); requestAnimationFrame(()=>ui.resultsSection.scrollIntoView({behavior:'smooth',block:'start'})); setTimeout(hideProgress,900);
    } catch(err){ console.error(err); ui.statusTitle.textContent='Analisi non completata'; ui.statusText.textContent=err.message||'Errore durante l’analisi.'; state.diagnostics.push(err.stack||String(err)); ui.statusLed.classList.remove('ready','done'); ui.statusLed.classList.add('error'); ui.progressBar.classList.add('error'); setProgress(100,'Analisi interrotta'); }
    finally{ ui.analyzeBtn.disabled=false; }
  }


  function reset(){state.projectFiles=[];state.graphFiles=[];state.samples=[];state.alerts=[];state.curves=[];state.diagnostics=[];state.graphRanges=[];state.reliability={score:null,label:'Da calcolare',trace:0,coverage:0};state.projectAudit={files:0,indexPages:[],parsedPages:[],candidatePages:[],points:0,coverageMin:null,coverageMax:null,maxGap:null,trackChecks:[]};ui.progressBar.classList.remove('error');ui.statusLed.classList.remove('error');renderFileList('project');renderFileList('graph');ui.resultsSection.hidden=true;hideProgress();renderReliability();updateReadyState();}

  function loadDemoPreview(){
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
  renderReliability();
  if(new URLSearchParams(window.location.search).get('demo')==='1') loadDemoPreview(); else updateReadyState();
})();
