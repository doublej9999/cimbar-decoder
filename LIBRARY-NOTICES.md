# 第三方组件说明

## libcimbar（解码内核）

- 来源：https://github.com/sz3/libcimbar ，发布版本 **v0.6.8**（tag `v0.6.8`，2026-08-26）
- 制品：官方 release 资源 `cimbar.wasm.tar.gz`（https://github.com/sz3/libcimbar/releases/download/v0.6.8/cimbar.wasm.tar.gz）
- 本仓库中的对应文件及改动：

| 本站路径 | 上游文件名 | SHA256 | 改动 |
| --- | --- | --- | --- |
| `public/vendor/cimbar_js.wasm` | `cimbar_js.2026-08-21T2336.wasm` | `019a0d79419bdee0b918f409cdcfff919c172b75131dac5a36a44385151ca5af` | 仅重命名 |
| `public/vendor/cimbar_js.js` | `cimbar_js.2026-08-21T2336.js` | 见 `sha256sum public/vendor/cimbar_js.js` | 仅重命名 + 把内部引用的 wasm 文件名同步为 `cimbar_js.wasm` |

- 许可证：Mozilla Public License 2.0（见 `LICENSE-libcimbar`）。WASM 二进制属于 libcimbar 的源码编译产物，MPL-2.0 下对应源码即上游仓库该 tag。
- 本站**没有**修改解码算法；封装层（取帧、worker、fountain 重组调用顺序、UI）为本仓库独立实现，参考了上游 `web/recv.js` + `web/recv-worker.js` 的调用约定（`cimbard_configure_decode` / `cimbard_scan_extract_decode` / `cimbard_fountain_decode` / `cimbard_decompress_read`）。

## 图标

`public/icons/icon-192.png`、`icon-512.png`、`favicon.ico` 取自上游 `web/` 目录，同样遵循 MPL-2.0。
