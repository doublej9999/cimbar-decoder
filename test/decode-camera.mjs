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

  await cdp.eval(sessionId, `(async () => {
    const t0 = Date.now();
    while (!cimbarApp.state.result) { if (Date.now() - t0 > 600000) throw new Error('等待解码结果超时'); await new Promise(r => setTimeout(r, 300)); }
    return true;
  })()`);

  const got = await cdp.eval(sessionId, `(async () => {
    const blob = cimbarApp.state.result.blob;
    const buf = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    return JSON.stringify({
      name: cimbarApp.state.result.name, size: blob.size, sha256: hex,
      frames: cimbarApp.state.frames, hits: cimbarApp.state.hits,
      backend: cimbarApp.state.effectiveBackend, lockedMode: cimbarApp.state.lockedMode,
      badges: [document.getElementById('badge-state').textContent, document.getElementById('badge-mode').textContent, document.getElementById('badge-perf').textContent],
      log: cimbarApp.getLog().slice(-6)
    });
  })()`);
  const o = JSON.parse(got);
  console.log('解码结果:', JSON.stringify({ ...o, log: undefined }));

  const shot = await cdp.screenshot(sessionId);
  writeFileSync('test/evidence/camera-decode.png', shot);
  writeFileSync('test/evidence/camera-decode.json', got);

  assert(cam.includes('"hasStream":true'), '虚拟摄像头已打开：' + cam);
  assert(o.hits >= 1, `worker 有成功解码 (命中 ${o.hits} 次 / 共处理 ${o.frames} 帧)`);
  assert(o.name === meta.name, `文件名还原正确 (${o.name})`);
  assert(o.size === meta.size, `长度一致 (${o.size}/${meta.size} 字节)`);
  assert(o.sha256 === meta.sha256, `SHA-256 逐字节一致 (${o.sha256.slice(0, 12)}…)`);
  assert(o.lockedMode === meta.modeVal, `模式锁定正确 (${o.lockedMode} = ${meta.mode})`);
  console.log('日志尾部:'); o.log.forEach((l) => console.log('   ' + l));
  console.log('[摄像头解码] 通过');
} catch (e) {
  console.error('❌ 测试异常:', e.message);
  process.exitCode = 1;
} finally {
  cdp.close();
  proc.kill('SIGKILL');
}
