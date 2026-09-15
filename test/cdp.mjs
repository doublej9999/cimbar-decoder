/* 极简 CDP 客户端（Node 22+ 自带 WebSocket），用于本地回归测试：
 *  - 生成测试用 cimbar 码帧（驱动上游 cimbar_js.html 编码器）
 *  - 用真实 Chrome 打开本站，走图片解码 / 摄像头解码两条路径并断言结果
 * 用法：node test/cdp.mjs <command> ...
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHROME = process.env.CHROME_BIN || '/root/.agent-browser/browsers/chrome-151.0.7922.71/chrome';

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export async function launchChrome(extraArgs = [], port = 9333) {
  const profile = mkdtempSync(join(tmpdir(), 'cimbar-test-'));
  const headed = !!process.env.HEADED;
  const args = [
    ...(headed ? [] : ['--headless=new']),
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
    ...extraArgs
  ];
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', () => {});
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const info = await res.json();
        return { proc, port, browserWs: info.webSocketDebuggerUrl, version: info['Browser'] };
      }
    } catch (e) { /* not up yet */ }
    await sleep(250);
  }
  proc.kill('SIGKILL');
  throw new Error('Chrome 调试端口未就绪');
}

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.sessions = new Map();
    this.events = [];
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new CDP(ws);
    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      if (data.id && cdp.pending.has(data.id)) {
        const { resolve, reject } = cdp.pending.get(data.id);
        cdp.pending.delete(data.id);
        data.error ? reject(new Error(JSON.stringify(data.error))) : resolve(data.result);
      } else if (data.method) {
        cdp.events.push(data);
        const waiters = cdp.waiters || [];
        cdp.waiters = waiters.filter((w) => !w(data));
      }
    };
    return cdp;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); }
      }, Number(process.env.CDP_TIMEOUT || 300000));
    });
  }
  waitEvent(method, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('等待事件超时: ' + method)), timeout);
      const fn = (ev) => {
        if (ev.method === method) { clearTimeout(t); resolve(ev.params); return true; }
        return false;
      };
      this.waiters = this.waiters || [];
      this.waiters.push(fn);
    });
  }
  async newPage(url = 'about:blank') {
    const { targetId } = await this.send('Target.createTarget', { url });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    await this.send('Page.enable', {}, sessionId);
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('DOM.enable', {}, sessionId);
    return { targetId, sessionId };
  }
  async eval(sessionId, expression, { awaitPromise = true } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true
    }, sessionId);
    if (res.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(res.exceptionDetails.exception || res.exceptionDetails));
    return res.result.value;
  }
  async goto(sessionId, url) {
    const done = this.waitEvent('Page.loadEventFired', 30000);
    await this.send('Page.navigate', { url }, sessionId);
    await done.catch(() => {});
  }
  async screenshot(sessionId, clip) {
    const opts = { format: 'png' };
    if (clip) opts.clip = { ...clip, scale: 1 };
    const { data } = await this.send('Page.captureScreenshot', opts, sessionId);
    return Buffer.from(data, 'base64');
  }
  async setFileInput(sessionId, selector, files) {
    const { root } = await this.send('DOM.getDocument', { depth: -1 }, sessionId);
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector }, sessionId);
    if (!nodeId) throw new Error('未找到 ' + selector);
    await this.send('DOM.setFileInputFiles', { nodeId, files }, sessionId);
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

export function assert(cond, msg) {
  if (cond) { console.log('  ✅ ' + msg); return true; }
  console.error('  ❌ ' + msg);
  process.exitCode = 1;
  return false;
}

if (existsSync(CHROME)) {
  // 仅用于校验路径
}
