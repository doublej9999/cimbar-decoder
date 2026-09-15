/* cimbar 解码 worker：一帧图像 → 提取 + 解码 → fountain chunk 字节
 * 每个 worker 持有独立的一份 cimbar WASM 实例（scan_extract_decode）。
 * 真正的 fountain 重组放在主线程（单一 sink），和上游 libcimbar 的 web 实现一致。
 */
'use strict';

let ready = false;
const buffs = {};

var Module = {
  onRuntimeInitialized() {
    ready = true;
    self.postMessage({ type: 'ready' });
  },
  print() {},
  printErr(msg) { console.warn('[wasm]', msg); },
  locateFile(path) { return new URL('vendor/' + path, self.location.href).href; }
};

function heapView(u8) {
  // HEAPU8 增长后旧视图会失效，每次访问都重建
  if (u8.buffer !== Module.HEAPU8.buffer) {
    return new Uint8Array(Module.HEAPU8.buffer, u8.byteOffset, u8.byteLength);
  }
  return u8;
}

function mallocPlease(name, size) {
  const cur = buffs[name];
  if (cur === undefined || size > cur.length) {
    // 注意：预留额外空间，避免 wasm 堆增长后反复重建
    if (cur !== undefined) Module._free(cur.byteOffset);
    const ptr = Module._malloc(size);
    buffs[name] = new Uint8Array(Module.HEAPU8.buffer, ptr, size);
  }
  return buffs[name];
}

function formatToType(format) {
  if (format === 'NV12') return 12;
  if (format === 'I420') return 420;
  if (format === 'RGBA') return 4;
  return 0; // 不支持
}

function scan(msg) {
  const { id, width, height, format, mode, pixels } = msg;
  const type = formatToType(format);
  if (!type) return { type: 'scan', id, mode, len: -4, err: 'unsupported frame format: ' + format };

  try {
    // 每次都用当前模式配置（同模式时是 no-op）
    if (mode) Module._cimbard_configure_decode(mode);

    const img = mallocPlease('img', pixels.byteLength);
    heapView(img).set(new Uint8Array(pixels));

    const fountSize = Module._cimbard_get_bufsize();
    const fount = mallocPlease('fount', fountSize);

    const len = Module._cimbard_scan_extract_decode(
      img.byteOffset, width, height, type, fount.byteOffset, fount.byteLength
    );

    if (len > 0) {
      const bytes = heapView(fount).slice(0, len);
      return { type: 'scan', id, mode, len, bytes };
    }
    return { type: 'scan', id, mode, len, err: report() };
  } catch (e) {
    return { type: 'scan', id, mode, len: -99, err: String(e && e.message || e) };
  }
}

function report() {
  try {
    const buff = mallocPlease('report', 512);
    const n = Module._cimbard_get_report(buff.byteOffset, buff.byteLength);
    if (n > 0) return new TextDecoder().decode(heapView(buff).slice(0, n));
  } catch (e) { /* ignore */ }
  return '';
}

self.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type !== 'scan') return;
  if (!ready) {
    self.postMessage({ type: 'scan', id: msg.id, mode: msg.mode, len: -1, err: 'wasm not ready' });
    return;
  }
  const res = scan(msg);
  if (res.bytes) self.postMessage(res, [res.bytes.buffer]);
  else self.postMessage(res);
};

importScripts('./vendor/cimbar_js.js');
