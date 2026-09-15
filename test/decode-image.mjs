/* 端到端测试 1：图片解码路径
 * 把 test/frames-xxx 下的码帧通过真实的 <input type="file"> 提交给本站，
 * 断言还原出的文件名、字节长度与 SHA-256 与原文完全一致。
 * 用法：node test/decode-image.mjs [帧目录]
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchChrome, CDP, sleep, assert } from './cdp.mjs';

const SITE = process.env.SITE_URL || 'http://127.0.0.1:8899/index.html';
const DIR = resolve(process.argv[2] || 'test/frames');
const meta = JSON.parse(readFileSync(resolve(DIR, 'meta.json'), 'utf8'));
const frames = readdirSync(DIR).filter((f) => f.endsWith('.png')).sort().map((f) => resolve(DIR, f));

console.log(`[图片解码] ${frames.length} 帧 / 期望 ${meta.name} ${meta.size} 字节 sha256=${meta.sha256.slice(0, 12)}…`);

const { proc, browserWs } = await launchChrome([], 9334);
const cdp = await CDP.connect(browserWs);
try {
  const { sessionId } = await cdp.newPage('about:blank');
  await cdp.goto(sessionId, SITE);
  await cdp.eval(sessionId, `(async () => {
    const t0 = Date.now();
    while (!window.__cimbarAppReady) { if (Date.now() - t0 > 60000) throw new Error('站点初始化超时'); await new Promise(r => setTimeout(r, 200)); }
    return true;
  })()`);
  console.log('站点已就绪，线程数 =', await cdp.eval(sessionId, 'cimbarApp.state.workerCount'));

  await cdp.setFileInput(sessionId, '#file-input', frames);
  // 图片路径是「离线处理」：等所有图片处理完、结果面板弹出后再断言
  await cdp.eval(sessionId, `(async () => {
    const t0 = Date.now();
    while (document.getElementById('result').hidden) {
      if (Date.now() - t0 > 180000) throw new Error('等待结果面板超时');
      await new Promise(r => setTimeout(r, 300));
    }
    return true;
  })()`);

  const got = await cdp.eval(sessionId, `(async () => {
    const item = cimbarApp.state.received[0];
    const buf = await item.blob.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    return JSON.stringify({
      name: item.name, size: item.blob.size, sha256: hex,
      lockedMode: cimbarApp.state.lockedMode, hits: cimbarApp.state.hits,
      resultVisible: !document.getElementById('result').hidden,
      resultDisplay: getComputedStyle(document.getElementById('result')).display,
      title: document.getElementById('r-title').textContent,
      items: [...document.querySelectorAll('#r-list .file-item .fname')].map(e => e.textContent),
      modeBadge: document.getElementById('badge-mode').textContent,
      sizeShown: document.querySelector('#r-list .file-item .fsize') ? document.querySelector('#r-list .file-item .fsize').textContent : ''
    });
  })()`);
  const o = JSON.parse(got);
  console.log('解码结果:', got);

  assert(o.name === meta.name, `文件名还原正确 (${o.name})`);
  assert(o.size === meta.size, `长度一致 (${o.size}/${meta.size} 字节)`);
  assert(o.sha256 === meta.sha256, `SHA-256 逐字节一致 (${o.sha256.slice(0, 12)}…)`);
  assert(o.resultVisible && o.resultDisplay === 'flex' && o.items.includes(meta.name), `图片处理结束后结果面板真的可见并列出文件（display=${o.resultDisplay}, ${o.title}）`);
  assert(o.lockedMode > 0, '自动模式识别后已锁定模式：' + o.modeBadge);
  console.log(process.exitCode ? '[图片解码] 失败' : '[图片解码] 通过');
} catch (e) {
  console.error('❌ 测试异常:', e.message);
  process.exitCode = 1;
} finally {
  cdp.close();
  proc.kill('SIGKILL');
}
