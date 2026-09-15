/* 生成测试素材：用上游 libcimbar 官方 WASM 编码器（cimbar_js.html）把一段文本编码成码帧 PNG。
 *
 * 原理：直接调用编码器 wasm 的 render/next_frame 逐帧生成，并把 WebGL 画布内容落成 PNG。
 * 不走页面自带的 rAF 循环，因为它的帧节奏依赖于编码器自身的 fountain restart 周期，
 * 且无头浏览器下的截图可能拿到陈旧帧。
 *
 * 前置：把 https://github.com/sz3/libcimbar/releases/download/v0.6.8/cimbar_js.html
 *       放到 ENC_DIR/index.html，并用静态服务暴露（默认 http://127.0.0.1:8898）。
 * 用法：PAYLOAD_SIZE=4000 FRAMES=40 node test/gen-frames.mjs test/frames
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { launchChrome, CDP, sleep } from './cdp.mjs';

const ENC_URL = process.env.ENC_URL || 'http://127.0.0.1:8898/index.html';
const OUT = process.argv[2] || 'test/frames';
const FILE_NAME = process.env.FILE_NAME || (process.env.BINARY ? 'random.bin' : 'hello.txt');
const MODE = process.env.MODE || 'B';
const MODE_VAL = { B: 68, Bu: 66, Bm: 67, '4C': 4 }[MODE];
const N = Number(process.env.FRAMES || 40);
const BINARY = !!process.env.BINARY;

const HEAD = 'cimbar 解码器端到端测试载荷 · libcimbar wasm roundtrip · ';
const base = HEAD + '0123456789 abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ · ';
const target = Number(process.env.PAYLOAD_SIZE || 400);
// 二进制模式用不可压缩的随机字节：zstd 压不动，fountain 流才会真的跨多帧，
// 从而验证「多帧累积重组」这条真实使用路径。
const PAYLOAD_TEXT = BINARY ? '' : base.repeat(Math.max(1, Math.ceil(target / base.length))).slice(0, target);

mkdirSync(OUT, { recursive: true });

const payloadBuf = BINARY ? randomBytes(target) : Buffer.from(PAYLOAD_TEXT, 'utf8');
const sha256 = createHash('sha256').update(payloadBuf).digest('hex');
const b64 = payloadBuf.toString('base64');

const { proc, browserWs } = await launchChrome(['--window-size=1200,1200'], 9333);
const cdp = await CDP.connect(browserWs);
const md5 = (buf) => createHash('md5').update(buf).digest('hex').slice(0, 8);
try {
  const { sessionId } = await cdp.newPage('about:blank');
  await cdp.goto(sessionId, ENC_URL);
  await sleep(1500);

  const ready = await cdp.eval(sessionId, `(() => ({
    hasMain: typeof Main !== 'undefined', hasModule: typeof Module !== 'undefined',
    canvas: (() => { const c = document.getElementById('canvas'); return c ? c.width + 'x' + c.height : null; })(),
    exports: Object.keys(Module).filter(k => k.startsWith('_cimbare'))
  }))()`);
  console.log('编码器:', JSON.stringify(ready));
  if (!ready.hasMain || !ready.exports.includes('_cimbare_next_frame')) throw new Error('编码器未就绪');

  await cdp.eval(sessionId, `(() => { Main.setMode(${JSON.stringify(MODE)}); return true; })()`);
  await cdp.eval(sessionId, `(() => {
    const raw = atob(${JSON.stringify(b64)});
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    Main.importFile(new File([bytes], ${JSON.stringify(FILE_NAME)}, { type: 'application/octet-stream' }));
    return true;
  })()`);
  await sleep(2500);

  const seen = new Set();
  let written = 0;
  for (let i = 0; i < N; i++) {
    const dataUrl = await cdp.eval(sessionId, `(() => {
      Module._cimbare_next_frame(false);
      Module._cimbare_render();
      return document.getElementById('canvas').toDataURL('image/png');
    })()`);
    const png = Buffer.from(dataUrl.split(',')[1], 'base64');
    const h = md5(png);
    if (seen.has(h)) continue;          // 忽略重复帧（编码器会循环重发同一批符号）
    seen.add(h);
    writeFileSync(`${OUT}/frame_${String(written).padStart(3, '0')}.png`, png);
    written++;
  }
  if (BINARY) {
    writeFileSync(`${OUT}/payload.bin`, payloadBuf);
  } else {
    writeFileSync(`${OUT}/payload.txt`, PAYLOAD_TEXT);
  }
  writeFileSync(`${OUT}/meta.json`, JSON.stringify({
    name: FILE_NAME, size: payloadBuf.length, sha256, binary: BINARY,
    mode: MODE, modeVal: MODE_VAL, frames: written
  }));
  console.log(`生成 ${written} 个不同帧（尝试 ${N} 次）→ ${OUT}；文件 ${FILE_NAME} ${payloadBuf.length} 字节 sha256=${sha256.slice(0, 12)}…，模式 ${MODE}(${MODE_VAL})`);
} finally {
  cdp.close();
  proc.kill('SIGKILL');
}
