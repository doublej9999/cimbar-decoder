/* 端到端测试 2：摄像头解码路径（真实 getUserMedia + 多帧累积）
 * 把码帧做成 Y4M 交给 Chrome 虚拟摄像头，页面走 getUserMedia → 取帧 → worker 解码 →
 * fountain 多帧累积 → zstd 解压，断言还原文件与原文 SHA-256 一致。
 * 用法：node test/decode-camera.mjs [帧目录]
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { launchChrome, CDP, sleep, assert } from './cdp.mjs';

const SITE = process.env.SITE_URL || 'http://127.0.0.1:8899/index.html';
const DIR = resolve(process.argv[2] || 'test/frames');
const meta = JSON.parse(readFileSync(resolve(DIR, 'meta.json'), 'utf8'));
const frames = readdirSync(DIR).filter((f) => f.endsWith('.png')).sort();
const Y4M = process.env.Y4M_PATH || `/tmp/cimbar-camera-${meta.frames}.y4m`;
const SIZE = Number(process.env.Y4M_SIZE || 1048);   // 必须偶数
const FPS = Number(process.env.Y4M_FPS || 10);
const IDLE_MS = Number(process.env.IDLE_FINISH_MS || 8000);   // 与 public/app.js 的 IDLE_FINISH_MS 对齐

if (!existsSync(Y4M)) {
  // 用 image2 序列（frame_%03d.png）而不是 concat 列表：concat 对单张 PNG 只会产出极少数帧
  const pattern = resolve(DIR, 'frame_%03d.png');
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-framerate', String(FPS), '-start_number', '0', '-i', pattern,
    '-vf', `scale=${SIZE}:${SIZE}:force_original_aspect_ratio=decrease,pad=${SIZE}:${SIZE}:(ow-iw)/2:(oh-ih)/2`,
    '-pix_fmt', 'yuv420p', Y4M
  ], { stdio: 'inherit' });
  const probe = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', Y4M]).toString().trim();
  if (Number(probe) !== frames.length) throw new Error(`Y4M 帧数不符: ${probe} != ${frames.length}`);
}
console.log(`[摄像头解码] ${frames.length} 帧 → ${Y4M} (${(readFileSync(Y4M).length / 1024 / 1024).toFixed(1)}MB)，期望 ${meta.name} ${meta.size} 字节`);

mkdirSync('test/evidence', { recursive: true });
const { proc, browserWs } = await launchChrome([
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-video-capture=${Y4M}`,
  '--window-size=420,900'
], 9340);
const cdp = await CDP.connect(browserWs);
try {
  const { sessionId } = await cdp.newPage('about:blank');
  await cdp.goto(sessionId, SITE);
  await cdp.eval(sessionId, `(async () => {
    const t0 = Date.now();
    while (!window.__cimbarAppReady) { if (Date.now() - t0 > 60000) throw new Error('初始化超时'); await new Promise(r => setTimeout(r, 200)); }
    return true;
  })()`);

  await cdp.eval(sessionId, `document.getElementById('btn-scan').click()`);
  await sleep(2500);
  const cam = await cdp.eval(sessionId, `JSON.stringify({
    hasStream: !!cimbarApp.state.stream,
    label: cimbarApp.state.stream ? cimbarApp.state.stream.getVideoTracks()[0].label : null,
    size: (() => { const v = document.getElementById('video'); return v.videoWidth + 'x' + v.videoHeight; })()
  })`);
  console.log('摄像头:', cam);

  // 等第一个文件解出来
  await cdp.eval(sessionId, `(async () => {
    const t0 = Date.now();
    while (!cimbarApp.state.result) { if (Date.now() - t0 > 600000) throw new Error('等待解码结果超时'); await new Promise(r => setTimeout(r, 300)); }
    return true;
  })()`);

  // 需求 1：扫描中不得弹出结果面板（按真实渲染样式判断），必须有状态提示
  const mid = JSON.parse(await cdp.eval(sessionId, `JSON.stringify({
    scanning: cimbarApp.state.scanning,
    sheetHidden: document.getElementById('result').hidden,
    sheetDisplay: getComputedStyle(document.getElementById('result')).display,
    sheetCovering: (() => { const el = document.elementFromPoint(Math.round(innerWidth/2), Math.round(innerHeight/2));
      return !!(el && el.closest('#result')); })(),
    toastVisible: getComputedStyle(document.getElementById('toast')).display !== 'none',
    toastText: document.getElementById('toast').textContent,
    filesBadge: document.getElementById('badge-files').textContent,
    stateBadge: document.getElementById('badge-state').textContent,
    hint: document.getElementById('hint').textContent,
    received: cimbarApp.state.received.length
  })`));
  console.log('扫描中状态:', JSON.stringify(mid));

  // 模拟发送端结束：停掉摄像头数据流 → 验证「无新数据 8 秒自动收尾」，且收尾后才弹结果面板
  await cdp.eval(sessionId, `(() => { cimbarApp.state.stream.getVideoTracks()[0].stop(); return true; })()`);
  const idleStart = Date.now();
  await cdp.eval(sessionId, `(async () => {
    const t0 = Date.now();
    while (cimbarApp.state.scanning) { if (Date.now() - t0 > 30000) throw new Error('等待空闲自动收尾超时'); await new Promise(r => setTimeout(r, 250)); }
    return true;
  })()`);
  const idleSeconds = (Date.now() - idleStart) / 1000;
  console.log(`空闲收尾耗时 ≈ ${idleSeconds.toFixed(1)}s（阈值 ${IDLE_MS / 1000}s）`);

  const got = JSON.parse(await cdp.eval(sessionId, `(async () => {
    const item = cimbarApp.state.received[0];
    const buf = await item.blob.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    return JSON.stringify({
      name: item.name, size: item.blob.size, sha256: hex,
      frames: cimbarApp.state.frames, hits: cimbarApp.state.hits,
      received: cimbarApp.state.received.length,
      backend: cimbarApp.state.effectiveBackend, lockedMode: cimbarApp.state.lockedMode,
      sheetVisible: !document.getElementById('result').hidden,
      sheetDisplay: getComputedStyle(document.getElementById('result')).display,
      title: document.getElementById('r-title').textContent,
      items: [...document.querySelectorAll('#r-list .file-item .fname')].map(e => e.textContent),
      hint: document.getElementById('hint').textContent,
      badges: [document.getElementById('badge-state').textContent, document.getElementById('badge-mode').textContent, document.getElementById('badge-files').textContent],
      log: cimbarApp.getLog().slice(-7)
    });
  })()`));
  console.log('解码结果:', JSON.stringify({ ...got, log: undefined }));

  const shot = await cdp.screenshot(sessionId);
  writeFileSync('test/evidence/camera-decode.png', shot);
  writeFileSync('test/evidence/camera-decode.json', JSON.stringify({ mid, got }, null, 2));

  assert(cam.includes('"hasStream":true'), '虚拟摄像头已打开：' + cam);
  assert(mid.scanning === true, '收到文件时扫描仍在继续（不中断）');
  assert(mid.sheetHidden === true && mid.sheetDisplay === 'none', `扫描中结果面板真的不可见（hidden=${mid.sheetHidden}, display=${mid.sheetDisplay}）`);
  assert(mid.sheetCovering === false, '扫描中结果面板没有遮挡取景区域');
  assert(mid.toastVisible === true && mid.toastText.includes('已收到'), '扫描中出现「已收到」轻提示：' + mid.toastText);
  assert(mid.stateBadge.includes('接收中') && mid.filesBadge.includes('文件 1'), `扫描中状态徽标可见（${mid.stateBadge} / ${mid.filesBadge}）`);
  assert(got.sheetVisible === true && got.sheetDisplay === 'flex', `扫描结束后自动弹出结果面板（display=${got.sheetDisplay}）`);
  assert(got.title.includes('1 个文件') && got.items.includes(meta.name), `结果面板列出文件（${got.title}）`);
  assert(got.hits >= 1, `worker 有成功解码 (命中 ${got.hits} 次 / 共处理 ${got.frames} 帧)`);
  assert(got.name === meta.name, `文件名还原正确 (${got.name})`);
  assert(got.size === meta.size, `长度一致 (${got.size}/${meta.size} 字节)`);
  assert(got.sha256 === meta.sha256, `SHA-256 逐字节一致 (${got.sha256.slice(0, 12)}…)`);
  assert(got.lockedMode === meta.modeVal, `模式锁定正确 (${got.lockedMode} = ${meta.mode})`);
  console.log('日志尾部:'); got.log.forEach((l) => console.log('   ' + l));
  console.log(process.exitCode ? '[摄像头解码] 失败' : '[摄像头解码] 通过');
} catch (e) {
  console.error('❌ 测试异常:', e.message);
  process.exitCode = 1;
} finally {
  cdp.close();
  proc.kill('SIGKILL');
}
