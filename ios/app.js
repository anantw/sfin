/* iOS Asset Forge
 * Client-side image processor. AI model is fetched from a public Hugging Face file;
 * inference runs locally with ONNX Runtime Web and WebGPU where available.
 */

const PRESETS = [
  { id: 'full', name: 'Full Screen', w: 1320, h: 2868, ratio: 9/19.5, purpose: 'Splash · onboarding · paywall', guide: 'full', focalX: 0.50 },
  { id: 'hero', name: 'Hero', w: 1536, h: 2048, ratio: 3/4, purpose: 'Today pool · practice · paths · evening review', guide: 'hero', focalX: 0.62 },
  { id: 'square', name: 'Square', w: 1024, h: 1024, ratio: 1, purpose: 'Busts · goal choices · theme thumbnails', guide: 'square', focalX: 0.50 },
  { id: 'texture', name: 'Texture', w: 2048, h: 2048, ratio: 1, purpose: 'Marble theme background · seamless tile', guide: '', focalX: 0.50 },
];

const MODEL_URL = 'https://models.skillsafe.ai/realesr-general-x4v3-fp32@0.2.5.0/model.onnx';
const ORT_VERSION = '1.30.0';
const ORT_WASM = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

let source = null;
let sourceFile = null;
let aiMode = 'auto';
let showGuides = true;
let focalX = 0.62;
let outputs = new Map();
let ortSession = null;
let ortBackend = null;
let modelKind = null;
let modelBytes = null;
let modelLoadPromise = null;
let activeAIStartedAt = 0;

const $ = (id) => document.getElementById(id);
const fileInput = $('fileInput');
const dropZone = $('dropZone');
const browseBtn = $('browseBtn');
const generateBtn = $('generateBtn');
const assetGrid = $('assetGrid');
const downloadAllBtn = $('downloadAllBtn');
const runtimeStatus = $('runtimeStatus');

browseBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => handleFile(e.target.files?.[0]));

['dragenter','dragover'].forEach(evt => dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.add('drag'); }));
['dragleave','drop'].forEach(evt => dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.remove('drag'); }));
dropZone.addEventListener('drop', e => handleFile(e.dataTransfer?.files?.[0]));

document.querySelectorAll('[data-ai]').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('[data-ai]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  aiMode = btn.dataset.ai;
}));
$('qualityRange').addEventListener('input', e => $('qualityValue').textContent = e.target.value);
$('focalX').addEventListener('input', e => { focalX = Number(e.target.value)/100; $('focalValue').textContent = `${e.target.value}%`; });
$('showGuides').addEventListener('change', e => { showGuides = e.target.checked; renderCards(); });
$('resetBtn').addEventListener('click', resetAll);
generateBtn.addEventListener('click', generateAll);
downloadAllBtn.addEventListener('click', downloadAll);

function setStatus(text, kind='ready') {
  runtimeStatus.innerHTML = `<span class="status-dot"></span> ${escapeHtml(text)}`;
  runtimeStatus.dataset.kind = kind;
}

function setProgress(text, pct) {
  $('progressWrap').hidden = false;
  $('progressLabel').textContent = text;
  $('progressPct').textContent = `${Math.round(pct)}%`;
  $('progressBar').style.width = `${pct}%`;
}

async function handleFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  sourceFile = file;
  setStatus('Reading image…');
  try {
    source = await loadImage(file);
    generateBtn.disabled = false;
    downloadAllBtn.disabled = true;
    outputs.clear();
    assetGrid.innerHTML = `<div class="empty-state"><div class="empty-orb">✓</div><strong>${escapeHtml(file.name)}</strong><span>${source.width} × ${source.height} · ready to generate</span></div>`;
    $('modelStatus').textContent = navigator.gpu ? 'WebGPU is available. AI runs on your GPU.' : 'WebGPU is unavailable. AI will fall back to CPU/WASM.';
    setStatus(`${source.width} × ${source.height} loaded`);
  } catch (err) {
    console.error(err);
    setStatus('Could not read image');
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image could not be decoded.')); };
    img.src = url;
  });
}

async function generateAll() {
  if (!source) return;
  generateBtn.disabled = true;
  downloadAllBtn.disabled = true;
  outputs.clear();
  assetGrid.innerHTML = '';
  const originalFocal = focalX;
  const total = PRESETS.length;
  try {
    for (let i=0; i<PRESETS.length; i++) {
      const preset = PRESETS[i];
      focalX = preset.focalX;
      $('focalX').value = Math.round(focalX*100);
      $('focalValue').textContent = `${Math.round(focalX*100)}%`;
      setProgress(`Preparing ${preset.name}…`, (i/total)*100);
      const result = await makeAsset(preset);
      outputs.set(preset.id, result);
      renderCards();
      setProgress(`${preset.name} ready`, ((i+1)/total)*100);
    }
    focalX = originalFocal;
    setStatus(`${outputs.size} assets ready`);
    downloadAllBtn.disabled = outputs.size !== PRESETS.length;
  } catch (err) {
    console.error(err);
    setStatus('Generation failed');
    alert(`Generation failed:\n\n${err.message || err}`);
  } finally {
    generateBtn.disabled = false;
    setTimeout(() => $('progressWrap').hidden = true, 900);
  }
}

function getSourceCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = source.naturalWidth || source.width;
  canvas.height = source.naturalHeight || source.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0);
  return canvas;
}

function cropToAspect(sourceCanvas, ratio, focusX) {
  const sw = sourceCanvas.width, sh = sourceCanvas.height;
  let cw, ch;
  if (sw / sh > ratio) { ch = sh; cw = Math.round(sh * ratio); }
  else { cw = sw; ch = Math.round(sw / ratio); }
  const maxX = sw - cw;
  const x = Math.max(0, Math.min(maxX, Math.round(focusX * sw - cw/2)));
  const y = Math.max(0, Math.min(sh-ch, Math.round(sh/2 - ch/2)));
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently:true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, x,y,cw,ch,0,0,cw,ch);
  return canvas;
}

function highQualityResize(canvas, width, height) {
  const out = document.createElement('canvas');
  out.width = width; out.height = height;
  const ctx = out.getContext('2d', { willReadFrequently:true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0,0,width,height);
  return out;
}

async function makeAsset(preset) {
  const srcCanvas = getSourceCanvas();
  let crop = cropToAspect(srcCanvas, preset.ratio, focalX);
  const needAI = aiMode === 'on' || (aiMode === 'auto' && (crop.width < preset.w * 0.72 || crop.height < preset.h * 0.72));
  let colorCanvas;
  let alphaCanvas = null;
  const hasAlpha = srcCanvas.getContext('2d').getImageData(0,0,1,1).data[3] < 255 || sourceFile?.type === 'image/png';

  if (needAI) {
    const aiInput = chooseAIInput(crop, preset);
    setProgress(`AI enhancing ${preset.name}…`, progressForPreset(preset, 0.22));
    activeAIStartedAt = performance.now();
    colorCanvas = await runRealESRGAN(aiInput.canvas);
    const aiSecs = ((performance.now() - activeAIStartedAt) / 1000).toFixed(1);
    setProgress(`${preset.name} AI complete · ${aiSecs}s`, progressForPreset(preset, 0.72));
    colorCanvas = highQualityResize(colorCanvas, preset.w, preset.h);
    if (hasAlpha) {
      const sourceAlpha = extractAlpha(crop);
      alphaCanvas = highQualityResize(sourceAlpha, preset.w, preset.h);
    }
  } else {
    colorCanvas = highQualityResize(crop, preset.w, preset.h);
    if (hasAlpha) alphaCanvas = highQualityResize(extractAlpha(crop), preset.w, preset.h);
  }

  if (preset.id === 'texture') {
    colorCanvas = seamlessMirror(colorCanvas);
    if (alphaCanvas) alphaCanvas = seamlessMirror(alphaCanvas);
  }

  const format = $('formatSelect').value;
  const quality = Number($('qualityRange').value) / 100;
  const blob = await canvasToBlob(colorCanvas, format, quality, alphaCanvas);
  return {
    preset,
    blob,
    url: URL.createObjectURL(blob),
    filename: `${slugify(preset.name)}-${preset.w}x${preset.h}.${format}`,
  };
}

function chooseAIInput(crop, preset) {
  const targetW = Math.ceil(preset.w / 4);
  const targetH = Math.ceil(preset.h / 4);
  // Keep the AI graph compact while retaining the exact target aspect ratio.
  const scale = Math.min(1, Math.max(targetW / crop.width, targetH / crop.height));
  const w = Math.max(8, Math.round(crop.width * scale));
  const h = Math.max(8, Math.round(crop.height * scale));
  return { canvas: highQualityResize(crop, w, h), w, h };
}

function extractAlpha(canvas) {
  const out = document.createElement('canvas');
  out.width = canvas.width; out.height = canvas.height;
  const src = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height);
  const dst = new Uint8ClampedArray(canvas.width*canvas.height*4);
  for (let i=0, j=0; i<src.data.length; i+=4, j+=4) {
    dst[j] = dst[j+1] = dst[j+2] = src.data[i+3]; dst[j+3] = 255;
  }
  out.getContext('2d').putImageData(new ImageData(dst, canvas.width, canvas.height), 0, 0);
  return out;
}

async function canvasToBlob(canvas, format, quality, alphaCanvas=null) {
  if (alphaCanvas && (format === 'png' || format === 'webp')) {
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0,0,canvas.width,canvas.height);
    const a = alphaCanvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    for (let i=0; i<img.data.length; i+=4) img.data[i+3] = a[i];
    ctx.putImageData(img,0,0);
  }
  if (format === 'jpeg') {
    const flat = document.createElement('canvas'); flat.width=canvas.width; flat.height=canvas.height;
    const fctx = flat.getContext('2d'); fctx.fillStyle='#ffffff'; fctx.fillRect(0,0,flat.width,flat.height); fctx.drawImage(canvas,0,0); canvas=flat;
  }
  const mime = `image/${format}`;
  return await new Promise((resolve,reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('Could not encode image.')), mime, quality));
}

async function runRealESRGAN(canvas) {
  if (!ortSession) await initOrt();
  const {data,width,height} = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height);
  const chw = new Float32Array(width*height*3);
  const plane = width*height;
  for (let p=0, i=0; p<plane; p++, i+=4) {
    chw[p] = data[i] / 255;
    chw[plane+p] = data[i+1] / 255;
    chw[2*plane+p] = data[i+2] / 255;
  }
  const tensor = new ort.Tensor('float32', chw, [1,3,height,width]);
  const result = await ortSession.run({input:tensor});
  const output = result.output || result[Object.keys(result)[0]];
  const [, , oh, ow] = output.dims;
  const vals = output.data;
  const outPlane = ow*oh;
  const rgba = new Uint8ClampedArray(outPlane*4);
  for (let p=0, i=0; p<outPlane; p++, i+=4) {
    rgba[i] = clampByte(vals[p]*255);
    rgba[i+1] = clampByte(vals[outPlane+p]*255);
    rgba[i+2] = clampByte(vals[2*outPlane+p]*255);
    rgba[i+3] = 255;
  }
  const out = document.createElement('canvas'); out.width=ow; out.height=oh;
  out.getContext('2d').putImageData(new ImageData(rgba,ow,oh),0,0);
  return out;
}

async function initOrt() {
  if (ortSession) return ortSession;
  if (modelLoadPromise) return modelLoadPromise;
  if (!window.ort) throw new Error('ONNX Runtime Web did not load. Check your internet connection or a browser content blocker.');

  modelLoadPromise = (async () => {
    ort.env.wasm.wasmPaths = ORT_WASM;
    ort.env.wasm.numThreads = 1;
    const providers = navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'];
    $('modelStatus').textContent = 'Downloading compact 4.6 MB AI model…';
    setStatus('Loading fast AI model…');
    setModelDownload(0);

    if (!modelBytes) {
      const response = await fetch(MODEL_URL, { mode: 'cors', cache: 'force-cache' });
      if (!response.ok) throw new Error(`AI model download failed (${response.status}).`);
      const total = Number(response.headers.get('content-length')) || 0;
      const reader = response.body?.getReader();
      if (reader && total) {
        const chunks=[]; let received=0;
        while (true) {
          const {done,value}=await reader.read();
          if (done) break;
          chunks.push(value); received += value.byteLength;
          setModelDownload((received/total)*100);
        }
        const all = new Uint8Array(received);
        let offset=0; for (const c of chunks) { all.set(c,offset); offset += c.byteLength; }
        modelBytes = all;
      } else {
        modelBytes = new Uint8Array(await response.arrayBuffer());
        setModelDownload(100);
      }
    }

    const t0 = performance.now();
    setStatus('Compiling AI model…');
    $('modelStatus').textContent = 'Compiling WebGPU AI model…';
    try {
      ortSession = await ort.InferenceSession.create(modelBytes, {
        executionProviders: providers,
        graphOptimizationLevel: 'all',
      });
      ortBackend = providers[0] === 'webgpu' ? 'WebGPU · Real-ESRGAN x4v3' : 'WASM · Real-ESRGAN x4v3';
    } catch (err) {
      if (providers[0] === 'webgpu') {
        console.warn('WebGPU session failed; retrying on WASM.', err);
        ortSession = await ort.InferenceSession.create(modelBytes, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        });
        ortBackend = 'WASM · Real-ESRGAN x4v3 fallback';
      } else throw err;
    }
    modelKind = 'x4v3';
    const secs = ((performance.now()-t0)/1000).toFixed(1);
    $('modelStatus').textContent = `${ortBackend} · ready in ${secs}s · model cached by browser.`;
    setStatus(`${ortBackend} active`);
    setModelDownload(100);
    return ortSession;
  })();

  try { return await modelLoadPromise; }
  finally { modelLoadPromise = null; }
}

function setModelDownload(pct) {
  const wrap = $('modelDownloadWrap');
  const bar = $('modelDownloadBar');
  const label = $('modelDownloadLabel');
  if (!wrap || !bar || !label) return;
  wrap.hidden = false;
  const n = Math.max(0, Math.min(100, pct));
  bar.style.width = `${n}%`;
  label.textContent = n >= 100 ? 'AI model ready' : `AI model download · ${Math.round(n)}%`;
}

function seamlessMirror(base) {
  const w=base.width,h=base.height;
  const big=document.createElement('canvas'); big.width=w*2; big.height=h*2;
  const ctx=big.getContext('2d');
  ctx.drawImage(base,0,0);
  ctx.save(); ctx.translate(w*2,0); ctx.scale(-1,1); ctx.drawImage(base,0,0); ctx.restore();
  ctx.save(); ctx.translate(0,h*2); ctx.scale(1,-1); ctx.drawImage(base,0,0); ctx.restore();
  ctx.save(); ctx.translate(w*2,h*2); ctx.scale(-1,-1); ctx.drawImage(base,0,0); ctx.restore();
  const out=document.createElement('canvas'); out.width=w; out.height=h;
  out.getContext('2d').drawImage(big,w/2,h/2,w,h,0,0,w,h);
  return out;
}

function renderCards() {
  if (!outputs.size) return;
  assetGrid.innerHTML='';
  for (const preset of PRESETS) {
    const item=outputs.get(preset.id); if(!item) continue;
    const card=document.createElement('article'); card.className='asset-card';
    const safeClass=showGuides && preset.guide ? `guide-overlay ${preset.guide}` : '';
    card.innerHTML = `
      <div class="asset-top">
        <div><div class="asset-name">${preset.name}</div><div class="asset-purpose">${preset.purpose}</div></div>
        <div class="asset-spec">${preset.w}×${preset.h}</div>
      </div>
      <div class="asset-preview-wrap"><div class="asset-preview-frame"><img src="${item.url}" alt="${preset.name}" /><div class="${safeClass}"></div></div></div>
      <div class="asset-bottom"><div class="asset-meta">${item.blob.type || 'image'} · ${humanBytes(item.blob.size)}</div><button class="download-one" data-download="${preset.id}">Download</button></div>`;
    assetGrid.appendChild(card);
  }
  assetGrid.querySelectorAll('[data-download]').forEach(btn => btn.addEventListener('click', () => {
    const item=outputs.get(btn.dataset.download); if(item) saveBlob(item.blob,item.filename);
  }));
}

async function downloadAll() {
  if (!outputs.size) return;
  const zip = new JSZip();
  outputs.forEach(item => zip.file(item.filename, item.blob));
  const blob = await zip.generateAsync({type:'blob',compression:'STORE'});
  saveBlob(blob, `${slugify(sourceFile?.name?.replace(/\.[^.]+$/,'') || 'ios-assets')}-ios-assets.zip`);
}

function saveBlob(blob, filename) {
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1500);
}

function progressForPreset(preset, local) {
  const idx=PRESETS.findIndex(p=>p.id===preset.id);
  return ((idx + local) / PRESETS.length)*100;
}

function resetAll() {
  source=null; sourceFile=null; outputs.forEach(v=>URL.revokeObjectURL(v.url)); outputs.clear();
  if (ortSession) { try { ortSession.release(); } catch {} ortSession=null; }
  modelBytes = null; modelLoadPromise = null; setModelDownload(0);
  assetGrid.innerHTML='<div class="empty-state"><div class="empty-orb">✦</div><strong>Your four assets will appear here.</strong><span>Full Screen · Hero · Square · Texture</span></div>';
  generateBtn.disabled=true; downloadAllBtn.disabled=true; fileInput.value='';
  setStatus('Ready'); $('modelStatus').textContent='Real-ESRGAN will load on demand.';
}

function humanBytes(n){ return `${(n/1024/1024).toFixed(1)} MB`; }
function slugify(s){ return String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }
function clampByte(v){ return Math.max(0,Math.min(255,Math.round(v))); }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

setStatus('Ready');
