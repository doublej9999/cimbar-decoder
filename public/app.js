/* cimbar 解码器 · 主线程
 * 职责：摄像头/图片取帧 → 分发给 worker（WASM 提取+解码）→ 集中做 fountain 重组 → zstd 解压 → 交付文件
 * 解码内核来自 sz3/libcimbar 官方 WASM 构建（MPL-2.0）。
 */
const $ = (id) => document.getElementById(id);

const MODE_LABEL = { 0: '自动', 4: '4C', 8: '8C', 66: 'Bu', 67: 'Bm', 68: 'B' };
const AUTO_MODES = [66, 68, 67, 4];              // 自动模式的轮换顺序（与上游一致）
const IMAGE_MAX_DIM = 1600;                      // 取帧/图片最大边长
const WASM_TIMEOUT_MS = 60000;

const state = {
  wasmReady: false,
  scanning: false,
  mode: 0,          // 用户选择（0=自动）
  lockedMode: 0,    // 自动模式下识别成功后锁定
  mainMode: 0,      // 主线程 sink 当前配置
  modeCursor: 0,
  backend: 'auto',
  effectiveBackend: '',
  workerCount: 2,
  workers: [],
  workerReady: 0,
  nextWorker: 0,
  inflight: 0,
  frameSeq: 0,
  stream: null,
  torch: false,
  torchSupported: false,
  facing: 'environment',
  frames: 0, hits: 0, scans: 0, fps: 0,
  pending: new Map(),
  result: null,
  raf: 0,
  wakeLock: null
};

/* ---------------- 基础工具 ---------------- */
function setStatus(text, cls) {
  const el = $('badge-state');
  el.textContent = text;
  el.className = 'badge' + (cls ? ' ' + cls : '');
}
function setModeBadge() {
  const m = state.lockedMode || state.mode;
  $('badge-mode').textContent = '模式 ' + (MODE_LABEL[m] || m) + (state.lockedMode ? '（已锁定）' : '');
}
function setPerf() {
  const el = $('badge-perf');
  el.textContent = `帧 ${state.frames} · 命中 ${state.hits} · ${state.fps}fps · ${state.effectiveBackend || '-'} · ${state.workerCount}线程`;
  el.hidden = false;
}
let logLines = [];
function log(msg) {
  const line = new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ' ' + msg;
  logLines.push(line);
  if (logLines.length > 300) logLines = logLines.slice(-300);
  const el = $('log');
  if (el) el.textContent = logLines.join('\n');
  console.log('[cimbar]', msg);
}

/* ---------------- WASM：主线程 fountain sink ---------------- */
const wasmReady = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('WASM 加载超时（检查 vendor/cimbar_js.wasm 是否可访问）')), WASM_TIMEOUT_MS);
  const done = () => { clearTimeout(timer); resolve(); };
  if (window.__cimbarReady) return done();
  window.__cimbarReadyCb = done;
});

let sinkPtr = 0, sinkSize = 0, decPtr = 0, decSize = 0, fnPtr = 0;
const FN_CAP = 512;

function ensureSinkBuf() {
  const need = Module._cimbard_get_bufsize();
  if (need > sinkSize) {
    if (sinkPtr) Module._free(sinkPtr);
    sinkPtr = Module._malloc(need);
    sinkSize = need;
  }
  if (!fnPtr) fnPtr = Module._malloc(FN_CAP);
  return sinkSize;
}

function configureMain(mode) {
  if (mode <= 0 || mode === state.mainMode) return;
  Module._cimbard_configure_decode(mode);
  state.mainMode = mode;
  ensureSinkBuf();          // bufsize 与模式绑定，模式变化后必须重新分配
  clearBars();
}

function getReport() {
  try {
    const cap = 2048;
    const ptr = Module._malloc(cap);
    const n = Module._cimbard_get_report(ptr, cap);
    let txt = '';
    if (n > 0) txt = new TextDecoder().decode(new Uint8Array(Module.HEAPU8.buffer, ptr, n));
    Module._free(ptr);
    return txt;
  } catch (e) { return ''; }
}

function updateBars() {
  const txt = getReport();
  const m = txt.match(/\[([^\]]*)\]/);
  if (!m) return;
  const vals = m[1].split(',').map((s) => parseFloat(s)).filter((v) => !isNaN(v));
  if (!vals.length) return;
  const wrap = $('progress-wrap');
  const bar = $('progress');
  wrap.hidden = false;
  while (bar.children.length < vals.length) bar.appendChild(document.createElement('i'));
  while (bar.children.length > vals.length) bar.removeChild(bar.lastChild);
  vals.forEach((v, i) => { bar.children[i].style.width = Math.round(v * 100) + '%'; });
}

function clearBars() {
  const bar = $('progress');
  bar.innerHTML = '';
  $('progress-wrap').hidden = true;
}

function feedFountain(bytes, mode) {
  try {
    configureMain(mode);
    const size = Module._cimbard_get_bufsize();
    if (bytes.length > size) { log(`异常：单帧数据 ${bytes.length} > bufsize ${size}`); return; }
    Module.HEAPU8.set(bytes, sinkPtr);
    const res = Module._cimbard_fountain_decode(sinkPtr, bytes.length);
    updateBars();
    const id = (typeof res === 'bigint') ? (res > 0n ? Number(res & 0xFFFFFFFFn) : 0) : Number(res);
    if (id > 0) { log('文件完整，开始解压 id=' + id); recoverAndDeliver(id); }
  } catch (e) {
    log('fountain 解码异常: ' + (e && e.message || e));
  }
}

async function recoverAndDeliver(id) {
  try {
    const fnsize = Module._cimbard_get_filename(id, fnPtr, FN_CAP);
    let name = `cimbar-${id}.bin`;
    if (fnsize > 0) {
      name = new TextDecoder('utf-8').decode(new Uint8Array(Module.HEAPU8.buffer, fnPtr, fnsize)) || name;
    } else if (fnsize < 0) {
      log('读取文件名失败: ' + fnsize);
    }
    const chunk = Module._cimbard_get_decompress_bufsize();
    if (chunk > decSize) { if (decPtr) Module._free(decPtr); decPtr = Module._malloc(chunk); decSize = chunk; }
    const parts = [];
    let total = 0;
    for (let i = 0; i < 200000; i++) {
      const n = Module._cimbard_decompress_read(id, decPtr, chunk);
      if (n <= 0) break;
      parts.push(new Uint8Array(Module.HEAPU8.buffer, decPtr, n).slice());
      total += n;
    }
    if (!parts.length) { log('解压得到 0 字节，忽略'); return; }
    const blob = new Blob(parts, { type: 'application/octet-stream' });
    log(`解压完成 ${name} ${blob.size} 字节`);
    deliver(name, blob, total);
  } catch (e) {
    log('交付文件异常: ' + (e && e.message || e));
  }
}

/* ---------------- 结果展示 ---------------- */
function humanSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function deliver(name, blob) {
  stopScanning();
  if (state.result) URL.revokeObjectURL(state.result.url);
  const url = URL.createObjectURL(blob);
  state.result = { name, blob, url };

  $('r-name').textContent = name;
  $('r-size').textContent = humanSize(blob.size);

  const prev = $('r-preview');
  prev.innerHTML = '';
  const lower = name.toLowerCase();
  if (blob.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp)$/.test(lower)) {
    const img = new Image();
    img.src = url;
    img.alt = name;
    prev.appendChild(img);
  } else if (/\.(txt|md|csv|json|log|yaml|yml|ini|xml|tsv)$/.test(lower) || blob.type.startsWith('text/') || blob.size < 4096) {
    const pre = document.createElement('pre');
    pre.textContent = '读取中…';
    prev.appendChild(pre);
    blob.slice(0, 64 * 1024).text().then((t) => {
      const printable = t.replace(/[\u0000-\u0008\u000b-\u001f]/g, '·');
      pre.textContent = printable.length > 4000 ? printable.slice(0, 4000) + '\n…（已截断，下载看全文）' : printable;
    }).catch(() => { pre.textContent = '（无法以文本预览）'; });
  } else {
    const d = document.createElement('div');
    d.className = 'none';
    d.textContent = '二进制文件，暂不支持预览，请直接下载。';
    prev.appendChild(d);
  }
  $('result').hidden = false;
}

/* ---------------- worker 池 ---------------- */
function waitWorkers(timeout = 60000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (state.workerReady >= state.workerCount) return resolve(true);
      if (Date.now() - t0 > timeout) return reject(new Error('worker WASM 初始化超时'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

async function initPool(n) {
  state.workers.forEach((w) => w.terminate());
  state.workers = [];
  state.workerReady = 0;
  state.inflight = 0;
  state.workerCount = n;
  for (let i = 0; i < n; i++) {
    const w = new Worker('./worker.js');
    w.onmessage = onWorkerMessage;
    w.onerror = (err) => log('worker 错误: ' + (err.message || err));
    state.workers.push(w);
  }
  await waitWorkers();
  log(`就绪：${n} 个解码线程`);
}

function onWorkerMessage(event) {
  const d = event.data || {};
  if (d.type === 'ready') { state.workerReady++; return; }
  if (d.type !== 'scan') return;
  state.inflight = Math.max(0, state.inflight - 1);
  state.scans++;

  const resolver = state.pending.get(d.id);
  if (resolver) {
    state.pending.delete(d.id);
    resolver(d);
    return;
  }

  if (d.bytes && d.bytes.length) {
    state.hits++;
    flashGuide('hit');
    if (state.mode === 0 && !state.lockedMode) {
      state.lockedMode = d.mode;
      setModeBadge();
      log('自动识别成功，锁定模式 ' + (MODE_LABEL[d.mode] || d.mode));
    }
    feedFountain(d.bytes, d.mode);
  } else if (d.len === 0) {
    flashGuide('scan');
  } else if (d.len === -3) {
    /* 常见情况：没找到码，忽略 */
  } else if (d.len === -4) {
    log(d.err || '不支持的帧格式');
  } else if (d.len !== -1) {
    log(`提取/解码返回 ${d.len} ${d.err || ''}`);
  }
  setPerf();
}

function scanOnce(pixels, format, width, height, mode, timeout = 20000) {
  return new Promise((resolve) => {
    const id = ++state.frameSeq;
    let worker;
    if (mode === 0) { worker = state.workers[0]; }
    else { worker = state.workers[state.nextWorker++ % state.workers.length]; }
    const timer = setTimeout(() => { state.pending.delete(id); resolve({ type: 'scan', id, mode, len: -100, err: 'timeout' }); }, timeout);
    state.pending.set(id, (res) => { clearTimeout(timer); resolve(res); });
    state.inflight++;
    worker.postMessage({ type: 'scan', id, mode: mode || AUTO_MODES[0], width, height, format, pixels }, [pixels.buffer]);
  });
}

/* ---------------- 摄像头 ---------------- */
async function startCamera(deviceId) {
  stopCamera();
  const video = $('video');
  const videoConstraints = deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 15 } }
    : {
        facingMode: { ideal: state.facing },
        width: { ideal: 1920 }, height: { ideal: 1080 },
        frameRate: { ideal: 15 },
        advanced: [{ focusMode: 'continuous' }, { exposureMode: 'continuous' }]
      };
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
  state.stream = stream;
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  try { await video.play(); } catch (e) { log('video.play 被拒: ' + e.message); }
  await new Promise((res) => {
    if (video.videoWidth) return res();
    video.onloadedmetadata = () => res();
    setTimeout(res, 3000);
  });
  const track = stream.getVideoTracks()[0];
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  state.torchSupported = !!caps.torch;
  $('btn-torch').hidden = !state.torchSupported;
  state.torch = false;
  $('btn-torch').classList.remove('on');
  $('badge-perf').hidden = false;
  log(`摄像头: ${track.label || deviceId || '默认'} ${video.videoWidth}x${video.videoHeight} torch=${!!caps.torch}`);
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  $('video').srcObject = null;
}

async function listCameras() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === 'videoinput');
  } catch (e) { return []; }
}

function chooseBackend() {
  if (state.backend !== 'auto') return state.backend;
  const canWebCodecs = typeof window.VideoFrame !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  return canWebCodecs ? 'webcodecs' : 'canvas';
}

/* ---------------- 取帧循环 ---------------- */
let canvasEl = null, canvasCtx = null;
function imageDataFromVideo() {
  const video = $('video');
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const scale = Math.min(1, IMAGE_MAX_DIM / Math.max(vw, vh));
  const w = Math.max(2, Math.round(vw * scale)), h = Math.max(2, Math.round(vh * scale));
  if (!canvasEl) { canvasEl = document.createElement('canvas'); }
  if (canvasEl.width !== w || canvasEl.height !== h) {
    canvasEl.width = w; canvasEl.height = h;
    canvasCtx = canvasEl.getContext('2d', { willReadFrequently: true });
  }
  if (!canvasCtx) canvasCtx = canvasEl.getContext('2d', { willReadFrequently: true });
  canvasCtx.drawImage(video, 0, 0, w, h);
  const data = canvasCtx.getImageData(0, 0, w, h);
  return { pixels: new Uint8Array(data.data.buffer), width: w, height: h, format: 'RGBA' };
}

function maxInflight() { return Math.max(1, state.workerCount) * 2; }

function pickMode() {
  if (state.lockedMode) return state.lockedMode;
  if (state.mode) return state.mode;
  const m = AUTO_MODES[state.modeCursor % AUTO_MODES.length];
  state.modeCursor++;
  return m;
}

function postFrame(frame) {
  const worker = state.workers[state.nextWorker++ % state.workers.length];
  if (!worker) return;
  const id = ++state.frameSeq;
  state.inflight++;
  state.frames++;
  worker.postMessage({
    type: 'scan', id, mode: pickMode(),
    width: frame.width, height: frame.height, format: frame.format, pixels: frame.pixels
  }, [frame.pixels.buffer]);
}

function loopCanvas() {
  if (!state.scanning) return;
  state.raf = requestAnimationFrame(loopCanvas);
  if (state.inflight >= maxInflight()) return;
  const frame = imageDataFromVideo();
  if (frame) postFrame(frame);
}

function grabWithWebCodecs(video, timestamp) {
  const vf = new VideoFrame(video, { timestamp });
  try {
    const width = vf.displayWidth, height = vf.displayHeight;
    const nativeFormat = vf.format;            // 注意：close() 之后读 format 会拿到 null
    let params = {};
    let format = nativeFormat;
    if (nativeFormat !== 'NV12' && nativeFormat !== 'I420' && nativeFormat !== 'RGBA') {
      params.format = 'RGBA';
      format = 'RGBA';
    }
    const size = vf.allocationSize(params);
    const buff = new Uint8Array(size);
    vf.copyTo(buff, params);
    if (format === 'RGBA' && size !== width * height * 4) return null;  // 拿不到可直接解的 RGBA
    return { pixels: buff, width, height, format };
  } finally {
    vf.close();
  }
}

let codecsFailStreak = 0;

function loopWebCodecs() {
  if (!state.scanning) return;
  const video = $('video');
  video.requestVideoFrameCallback((now) => {
    if (!state.scanning) return;
    if (state.inflight < maxInflight()) {
      let frame = null;
      try {
        frame = grabWithWebCodecs(video, now);
      } catch (e) {
        codecsFailStreak += 3;
        log('WebCodecs 取帧异常: ' + (e && e.message || e));
      }
      if (frame) {
        codecsFailStreak = 0;
        postFrame(frame);
      } else {
        codecsFailStreak++;
        const fallback = imageDataFromVideo();   // 同一帧改用 Canvas 取
        if (fallback) postFrame(fallback);
        if (codecsFailStreak >= 3 && state.backend === 'auto') {
          switchBackend('canvas');
          return;                                 // 新循环已由 switchBackend 启动
        }
      }
    }
    loopWebCodecs();
  });
}

let backendDowngrades = 0;
function switchBackend(name) {
  if (state.effectiveBackend === name) return;
  state.effectiveBackend = name;
  log('采集后端 → ' + name);
  setPerf();
  updateBackendPicker();
  if (state.scanning) startLoop();
}

function startLoop() {
  cancelAnimationFrame(state.raf);
  if (state.effectiveBackend === 'webcodecs') loopWebCodecs();
  else loopCanvas();
}

/* ---------------- 扫描控制 ---------------- */
async function startScanning() {
  if (state.scanning) return;
  try {
    setStatus('启动中…');
    if (!state.stream) await startCamera();
    if (state.effectiveBackend !== 'canvas' && state.effectiveBackend !== 'webcodecs') {
      state.effectiveBackend = chooseBackend();
    }
    state.scanning = true;
    state.modeCursor = 0;
    $('btn-scan').textContent = '停止扫描';
    $('btn-scan').classList.add('danger');
    $('guide').hidden = false;
    $('hint').textContent = '把 cimbar 码放进取景框，保持稳定';
    setStatus('扫描中…', 'ok');
    setModeBadge();
    requestWakeLock();
    startLoop();
    startPerfTimer();
  } catch (e) {
    setStatus('摄像头失败', 'warn');
    $('hint').textContent = '无法打开摄像头：' + (e && e.message || e) + '（需 HTTPS 与授权）';
    log('getUserMedia 失败: ' + (e && e.message || e));
  }
}

function stopScanning() {
  state.scanning = false;
  cancelAnimationFrame(state.raf);
  stopPerfTimer();
  $('btn-scan').textContent = '开始扫描';
  $('btn-scan').classList.remove('danger');
  setStatus(state.wasmReady ? '已停止' : '初始化…');
  releaseWakeLock();
}

function resetProgress() {
  Module._cimbard_configure_decode(0);
  state.mainMode = 0;
  configureMain(state.lockedMode || state.mode || 68);
  state.lockedMode = 0;
  state.frames = 0; state.hits = 0; state.scans = 0;
  clearBars();
  setModeBadge();
  setPerf();
  log('已清空进度');
}

let perfTimer = 0;
let perfLast = { t: 0, frames: 0 };
function startPerfTimer() {
  stopPerfTimer();
  perfLast = { t: performance.now(), frames: state.frames };
  perfTimer = setInterval(() => {
    const now = performance.now();
    const dt = (now - perfLast.t) / 1000;
    if (dt > 0.2) {
      state.fps = Math.round((state.frames - perfLast.frames) / dt);
      perfLast = { t: now, frames: state.frames };
    }
    setPerf();
  }, 1000);
}
function stopPerfTimer() { if (perfTimer) clearInterval(perfTimer); perfTimer = 0; }

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    }
  } catch (e) { /* 忽略 */ }
}
function releaseWakeLock() {
  if (state.wakeLock) { try { state.wakeLock.release(); } catch (e) {} state.wakeLock = null; }
}

let guideTimer = 0;
function flashGuide(kind) {
  const g = $('guide');
  g.className = kind;
  clearTimeout(guideTimer);
  guideTimer = setTimeout(() => { g.className = ''; }, kind === 'hit' ? 400 : 200);
}

/* ---------------- 图片解码（相册/截图） ---------------- */
async function loadImage(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file); } catch (e) { /* fallthrough */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 30000); }
}

async function decodeImageFiles(files) {
  const imgs = Array.from(files).filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name));
  if (!imgs.length) { log('没有可用的图片文件'); return; }
  setStatus(`图片解码 0/${imgs.length}`);
  $('result').hidden = true;

  const modes = state.lockedMode ? [state.lockedMode] : (state.mode ? [state.mode] : AUTO_MODES.slice());
  let done = 0;
  for (const f of imgs) {
    try {
      const bmp = await loadImage(f);
      const scale = Math.min(1, IMAGE_MAX_DIM / Math.max(bmp.width, bmp.height));
      const w = Math.max(2, Math.round(bmp.width * scale)), h = Math.max(2, Math.round(bmp.height * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h);
      const base = new Uint8Array(data.data.buffer);
      for (const m of modes) {
        const res = await scanOnce(base.slice(), 'RGBA', w, h, m);
        if (res.bytes && res.bytes.length) {
          state.hits++;
          if (!state.lockedMode) { state.lockedMode = m; setModeBadge(); }
          flashGuide('hit');
          feedFountain(res.bytes, m);
        }
      }
      log(`图片 ${f.name} 处理完成`);
    } catch (e) {
      log('图片处理失败 ' + f.name + ': ' + (e && e.message || e));
    }
    done++;
    setStatus(`图片解码 ${done}/${imgs.length}`);
  }
  setStatus('图片解码结束', 'ok');
  if (!$('progress-wrap').hidden) log('提示：单张静态图只提供极少量数据，文件通常需要多张/多帧才能凑齐。');
}

/* ---------------- UI 绑定 ---------------- */
function updateBackendPicker() {
  document.querySelectorAll('#backend-picker button').forEach((b) => {
    b.classList.toggle('on', b.dataset.backend === state.backend && (state.backend !== 'auto' || true));
  });
  $('backend-note').textContent = state.backend === 'auto'
    ? `自动：当前实际使用 ${state.effectiveBackend || '（未开始）'}。优先 WebCodecs 零拷贝取帧，异常时回落 Canvas。`
    : `已固定为 ${state.backend}${state.effectiveBackend && state.effectiveBackend !== state.backend ? '（实际：' + state.effectiveBackend + '）' : ''}`;
}

function bindUI() {
  $('btn-scan').onclick = () => (state.scanning ? stopScanning() : startScanning());
  $('btn-more').onclick = () => { $('panel').hidden = false; };
  $('panel').addEventListener('click', (e) => { if (e.target === $('panel')) $('panel').hidden = true; });

  $('btn-camera').onclick = async () => {
    const cams = await listCameras();
    if (cams.length < 2) {
      state.facing = state.facing === 'environment' ? 'user' : 'environment';
    } else {
      const cur = state.stream && state.stream.getVideoTracks()[0];
      const curId = cur && cur.getSettings ? cur.getSettings().deviceId : null;
      const idx = Math.max(0, cams.findIndex((c) => c.deviceId === curId));
      const next = cams[(idx + 1) % cams.length];
      state.nextDeviceId = next.deviceId;
    }
    try {
      await startCamera(state.nextDeviceId);
      state.nextDeviceId = null;
      if (state.scanning) startLoop();
    } catch (e) { log('切换摄像头失败: ' + (e && e.message || e)); }
  };

  $('btn-torch').onclick = async () => {
    const track = state.stream && state.stream.getVideoTracks()[0];
    if (!track) return;
    try {
      state.torch = !state.torch;
      await track.applyConstraints({ advanced: [{ torch: state.torch }] });
      $('btn-torch').classList.toggle('on', state.torch);
    } catch (e) { log('手电筒切换失败: ' + (e && e.message || e)); }
  };

  $('btn-file').onclick = () => $('file-input').click();
  $('file-input').onchange = async (e) => {
    const files = e.target.files;
    if (files && files.length) await decodeImageFiles(files);
    e.target.value = '';
  };
  $('btn-close-result').onclick = () => { $('result').hidden = true; startScanning(); };
  $('btn-download').onclick = () => {
    if (!state.result) return;
    const a = document.createElement('a');
    a.href = state.result.url;
    a.download = state.result.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  $('btn-clear').onclick = () => resetProgress();
  $('btn-log').onclick = () => {
    const el = $('log');
    el.hidden = !el.hidden;
    $('btn-log').textContent = el.hidden ? '显示日志' : '隐藏日志';
  };

  document.querySelectorAll('#mode-picker button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('#mode-picker button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      state.mode = Number(b.dataset.mode);
      state.lockedMode = 0;
      state.mainMode = 0;
      configureMain(state.mode || 68);
      clearBars();
      setModeBadge();
      log('用户选择模式 ' + (MODE_LABEL[state.mode] || state.mode));
    };
  });

  document.querySelectorAll('#backend-picker button').forEach((b) => {
    b.onclick = () => {
      state.backend = b.dataset.backend;
      state.effectiveBackend = b.dataset.backend === 'auto' ? chooseBackend() : b.dataset.backend;
      updateBackendPicker();
      if (state.scanning) startLoop();
    };
  });

  const slider = $('workers');
  slider.oninput = () => { $('workers-val').textContent = slider.value; };
  slider.onchange = async () => {
    try {
      await initPool(Number(slider.value));
      if (state.scanning) startLoop();
    } catch (e) { log('重建线程池失败: ' + (e && e.message || e)); }
  };

  // 拖拽/粘贴图片
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files.length) await decodeImageFiles(e.dataTransfer.files);
  });
  document.addEventListener('paste', async (e) => {
    const items = Array.from(e.clipboardData ? e.clipboardData.files : []);
    if (items.length) await decodeImageFiles(items);
  });
}

/* ---------------- 启动 ---------------- */
(async function boot() {
  bindUI();
  setModeBadge();
  try {
    await wasmReady;
    state.wasmReady = true;
    log('WASM 就绪');
  } catch (e) {
    setStatus('WASM 加载失败', 'warn');
    log(String(e));
    return;
  }
  $('btn-scan').disabled = false;
  $('btn-camera').disabled = false;
  setStatus('就绪');
  const n = Math.min(4, Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 2)));
  state.workerCount = n;
  $('workers').value = String(n);
  $('workers-val').textContent = String(n);
  try {
    await initPool(n);
    setStatus('就绪');
  } catch (e) {
    setStatus('线程初始化失败', 'warn');
    log(String(e));
  }
  state.effectiveBackend = chooseBackend();
  updateBackendPicker();
  setPerf();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((e) => log('Service Worker 注册失败: ' + e.message));
  }
  if (!window.isSecureContext) {
    $('hint').textContent = '当前不是安全上下文（HTTPS），摄像头会被浏览器拒绝。';
  }
  window.__cimbarAppReady = true;   // 供自动化测试使用
})();

// 暴露少量钩子给自动化测试
window.cimbarApp = {
  state,
  feedFountain,
  decodeImageFiles,
  resetProgress,
  startScanning,
  stopScanning,
  getReport,
  getLog: () => logLines.slice(),
  deliver
};
