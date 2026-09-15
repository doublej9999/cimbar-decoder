/* UI 回归测试：结果面板/提示的可见性（按真实渲染样式判断，而不是 el.hidden 属性）
 *
 * 背景：#result 的 CSS 里写了 display:flex，会盖掉 UA 的 [hidden]{display:none}，
 * 导致这个 position:fixed;inset:0 的面板从加载起就一直盖在摄像头上；
 * 而只检查 element.hidden 的断言仍然是 true，所以测试全绿却漏掉了。
 * 本测试断言 computed style + 真实遮挡，并覆盖移动端视口下的底部抽屉布局。
 *
 * 用法：node test/ui-sheet.mjs
 */
import { launchChrome, CDP, sleep, assert } from './cdp.mjs';

const SITE = process.env.SITE_URL || 'http://127.0.0.1:8899/index.html';

// 读取"面板是否真的可见/是否遮挡页面"
const PROBE = `(() => {
  const ids = ['result', 'panel', 'toast', 'progress-wrap', 'badge-files'];
  const vis = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    vis[id] = { display: cs.display, visibility: cs.visibility, w: Math.round(r.width), h: Math.round(r.height) };
  }
  const cx = Math.round(window.innerWidth / 2), cy = Math.round(window.innerHeight / 2);
  const top = document.elementFromPoint(cx, cy);
  let blockedBy = null;
  if (top && top.id !== 'video' && !top.closest('#stage')) {
    blockedBy = top.id || top.className || top.tagName;
  }
  const card = document.querySelector('#result .card');
  const cr = card ? card.getBoundingClientRect() : null;
  const cs2 = card ? getComputedStyle(card) : null;
  return JSON.stringify({
    vis, blockedBy,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    card: cr ? { top: Math.round(cr.top), bottom: Math.round(cr.bottom), h: Math.round(cr.height), radiusTop: cs2.borderTopLeftRadius, radiusBottom: cs2.borderBottomLeftRadius } : null,
    xVisible: !!document.getElementById('btn-x'),
    sheetTitle: document.getElementById('r-title').textContent,
    items: [...document.querySelectorAll('#r-list .file-item .fname')].map(e => e.textContent)
  });
})()`;

const { proc, browserWs } = await launchChrome([], 9341);
const cdp = await CDP.connect(browserWs);
try {
  const { sessionId } = await cdp.newPage('about:blank');
  await cdp.goto(sessionId, SITE);
  await cdp.eval(sessionId, `(async () => {
    const t0 = Date.now();
    while (!window.__cimbarAppReady) { if (Date.now() - t0 > 60000) throw new Error('初始化超时'); await new Promise(r => setTimeout(r, 200)); }
    return true;
  })()`);

  // 1) 初始：所有面板必须真的不可见，且不遮挡取景
  const init = JSON.parse(await cdp.eval(sessionId, PROBE));
  console.log('初始可见性:', JSON.stringify(init.vis));
  assert(init.vis.result.display === 'none' && init.vis.result.h === 0, `结果面板初始不可见（display=${init.vis.result.display}, h=${init.vis.result.h}）`);
  assert(init.vis.panel.display === 'none', `设置面板初始不可见（display=${init.vis.panel.display}）`);
  assert(init.vis.toast.display === 'none', `toast 初始不可见（display=${init.vis.toast.display}）`);
  assert(init.vis['badge-files'].display === 'none', '「文件 N」徽标初始不显示');
  assert(init.blockedBy === null, `取景区域未被面板遮挡（遮挡元素：${init.blockedBy}）`);
  assert(init.xVisible, '结果卡片带关闭按钮 ✕');

  // 2) 收到文件：只出 toast，面板仍不可见
  await cdp.eval(sessionId, `(() => { cimbarApp.deliver('t.txt', new Blob(['hi'], { type: 'text/plain' })); return true; })()`);
  const afterDeliver = JSON.parse(await cdp.eval(sessionId, PROBE));
  assert(afterDeliver.vis.toast.display !== 'none', '收到文件后出现 toast 提示');
  assert(afterDeliver.vis.result.display === 'none', `收到文件后面板仍不可见（display=${afterDeliver.vis.result.display}）`);
  assert(afterDeliver.blockedBy === null, `收到文件后取景仍未被遮挡（遮挡：${afterDeliver.blockedBy}）`);

  // 3) toast 会自己消失
  await sleep(6000);
  const toastGone = JSON.parse(await cdp.eval(sessionId, PROBE));
  assert(toastGone.vis.toast.display === 'none', 'toast 5 秒后自动消失');

  // 4) 主动打开结果面板
  await cdp.eval(sessionId, `cimbarApp.openResults()`);
  const opened = JSON.parse(await cdp.eval(sessionId, PROBE));
  assert(opened.vis.result.display === 'flex', `打开后面板可见（display=${opened.vis.result.display}）`);
  assert(opened.sheetTitle.includes('1 个文件') && opened.items.includes('t.txt'), `面板列出文件（${opened.sheetTitle} / ${opened.items}）`);

  // 5) 关闭（按钮 / 点遮罩）都要真的隐藏
  await cdp.eval(sessionId, `document.getElementById('btn-x').click()`);
  const closedByX = JSON.parse(await cdp.eval(sessionId, PROBE));
  assert(closedByX.vis.result.display === 'none', `✕ 关闭后面板不可见（display=${closedByX.vis.result.display}）`);
  await cdp.eval(sessionId, `cimbarApp.openResults(); document.getElementById('result').click()`);
  const closedByTap = JSON.parse(await cdp.eval(sessionId, PROBE));
  assert(closedByTap.vis.result.display === 'none', `点遮罩关闭后面板不可见（display=${closedByTap.vis.result.display}）`);
  assert(JSON.parse(await cdp.eval(sessionId, `JSON.stringify({d: cimbarApp.state.sheetDismissedAt > 0})`)).d, '关闭时间已记录（避免同一批文件反复弹出）');

  // 6) 移动端视口：底部抽屉、不遮整屏、安全区
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, sessionId);
  await cdp.eval(sessionId, `cimbarApp.openResults()`);
  const mobile = JSON.parse(await cdp.eval(sessionId, PROBE));
  console.log('移动端视口:', JSON.stringify({ viewport: mobile.viewport, card: mobile.card }));
  assert(mobile.card.bottom >= mobile.viewport.h - 2, `移动端抽屉贴底（card.bottom=${mobile.card.bottom}, 视口高=${mobile.viewport.h}）`);
  assert(mobile.card.h <= mobile.viewport.h * 0.8, `抽屉不超过屏幕 80%（${mobile.card.h}/${mobile.viewport.h}）`);
  assert(mobile.card.top > mobile.viewport.h * 0.15, '抽屉顶部留出取景空间（不是整屏面板）');
  assert(mobile.vis.panel.display === 'none' && mobile.vis.result.display === 'flex', '移动端可见性正确');
  await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);

  console.log(process.exitCode ? '[UI 可见性] 失败' : '[UI 可见性] 通过');
} catch (e) {
  console.error('❌ 测试异常:', e.message);
  process.exitCode = 1;
} finally {
  cdp.close();
  proc.kill('SIGKILL');
}
