# cimbar 解码器（手机浏览器版）

用手机浏览器调用摄像头，扫描 [cimbar](https://github.com/sz3/libcimbar) 彩色数据码并解码还原文件。
纯前端运行（WebAssembly），不经过任何服务器：码帧在你手机本地解码，文件也在本机重组。

- 解码内核：libcimbar 官方 **v0.6.8 WASM 构建**（`cimbar_js.js` + `cimbar_js.wasm`，MPL-2.0），未改动算法。
- 本仓库提供的是**解码端网页**（移动优先）：取景框、模式选择/自动识别、多线程解码、进度条、文件预览与下载、PWA 离线缓存。

## 功能

- **摄像头扫码**：`getUserMedia` 后置摄像头 + 连续对焦，整屏取景框，命中/扫描状态可视化。
- **扫描中的状态提示**：顶部状态徽标（扫描中·未识别到码 / 已识别 / 接收中·已收 N）、已收文件数、进度条，以及长时间无数据的对齐/反光提示与空闲倒计时。
- **自动模式识别**：自动轮换尝试 `Bu / B / Bm / 4C`，任一模式解出数据即锁定，避免模式选错卡住。
- **图片解码**：手机相册里的截图/照片可直接批量导入解码（无需摄像头，也没有实时压力）。
- **多线程解码**：每个 worker 一份 WASM 实例，默认按 CPU 核心数自动取 1–4 个，可在「更多」里调整。
- **两种取帧后端**：WebCodecs（`VideoFrame`，零拷贝、更省电）优先，异常自动回落 Canvas（iOS Safari 常用）。
- **手势/开关**：手电筒（设备支持时）、切换前后摄像头、停止/继续、清空进度、日志面板。
- **PWA**：1.9MB 的 WASM 缓存到本地，装到桌面后离线也能扫。
- **结果面板只在扫描结束后弹出**：扫描中收到文件只做轻提示（toast）并继续接收，停止扫描（或 8 秒无新数据自动收尾）后才弹出结果面板，多文件可逐个预览/下载。
- **移动端适配**：小屏下结果面板是底部抽屉（不遮住取景、带 ✕ 与点遮罩关闭、安全区适配），底部按钮放大，收到文件后关掉过面板不会对同一批文件反复弹出。

## 本地运行

必须通过 HTTP 服务访问（`file://` 下 worker/WASM 会被浏览器策略挡住），摄像头还需要 HTTPS 或 `localhost`：

```bash
git clone https://github.com/doublej9999/cimbar-decoder.git
cd cimbar-decoder
python3 -m http.server 8000 --directory public
# 打开 http://localhost:8000/index.html
```

## 部署（Vercel）

`vercel.json` 已声明 `outputDirectory: public`、`/vendor/*.wasm` 的 `application/wasm` 类型与长缓存、摄像头 `Permissions-Policy`。

```bash
vercel link --yes --project cimbar-decoder
vercel deploy --prod --yes
```

部署后 `https://<域名>/` 可直接手机访问；HTTPS 由 Vercel 提供，摄像头权限即可正常授权。

### GitHub 自动部署

仓库已连接到 Vercel 项目 `doub/cimbar-decoder`：

- 推送到 `main` → 自动发布到生产环境（Production）
- 开 Pull Request → 自动生成 Preview 部署
- 无需再手动执行 `vercel deploy`

（如果换了仓库或需要重新连接：`vercel git connect <repo-url>`。）

## 自动化测试（真实浏览器 + 真实编解码）

测试不是「页面能打开」级别，而是**真编码 → 真解码 → SHA-256 逐字节比对**：

```bash
# 0) 准备：站点静态服务 + 上游官方编码器（编码器用于生成测试码帧）
python3 -m http.server 8899 --directory public &
mkdir -p /tmp/cimbar-enc && cd /tmp/cimbar-enc   # 放入 releases/v0.6.8/cimbar_js.html 并改名 index.html
python3 -m http.server 8898 --bind 127.0.0.1 &   # 编码器页面

# 1) 生成测试码帧
#    文本载荷（体积小、可压缩，通常 1 帧即可解出）
PAYLOAD_SIZE=400 FRAMES=30 node test/gen-frames.mjs test/frames-small
#    二进制随机载荷（zstd 压不动，fountain 流跨多帧，用于验证多帧累积重组）
BINARY=1 PAYLOAD_SIZE=120000 FRAMES=70 node test/gen-frames.mjs test/frames-bin

# 2) 图片解码路径：码帧经 <input type="file"> 提交，断言文件名/长度/SHA-256 一致
node test/decode-image.mjs test/frames-small

# 3) UI 可见性回归（按真实渲染样式断言，不用 el.hidden）
#    覆盖：结果面板初始不可见且不遮挡取景、收到文件只出 toast、toast 自动消失、
#          ✕/点遮罩关闭、移动端视口下是贴底抽屉
node test/ui-sheet.mjs

# 4) 摄像头解码路径：码帧转 Y4M 喂给 Chrome 虚拟摄像头，走真实 getUserMedia
node test/decode-camera.mjs test/frames-bin

# 5) 对线上环境做同样验证（把 SITE_URL 指到部署地址即可）
SITE_URL=https://cimbar-decoder.vercel.app/index.html node test/decode-camera.mjs test/frames-bin
SITE_URL=https://cimbar-decoder.vercel.app/index.html node test/ui-sheet.mjs
```

**坑（踩过）**：给面板加 `display:flex` 之类的作者样式会盖掉 UA 的 `[hidden]{display:none}`，面板就会常驻显示；
断言必须查 `getComputedStyle(el).display` 与 `document.elementFromPoint` 遮挡，只查 `el.hidden` 会让这种 bug 静默通过。

实测结果（2C/4G VPS + Chrome 151 无头）：120000 字节随机文件经摄像头路径 20 帧解码完成，
SHA-256 与原文一致，模式自动锁定为 B，约 3 秒收完。

前提：Chrome/Chromium（`CHROME_BIN` 可覆盖路径）、Node 22+（自带 WebSocket）、ffmpeg。
注意：`--use-file-for-fake-video-capture` 的 Y4M 必须用 `-framerate N -start_number 0 -i frame_%03d.png` 逐帧生成，
用 concat 列表只会产出极少数帧。

## 用法要点

1. 对端用 cimbar 发送端播放彩色码：网站 [cimbar.org](https://cimbar.org)，或 [Android App](https://github.com/sz3/cfc/releases)。
2. 点击「开始扫描」授权摄像头，把整块码放进取景框，四角尽量都可见。
3. 进度条走满即完成，结果卡片弹出后可直接下载；「继续扫描」可继续接第二份文件。
4. 模式：建议「自动」。**发送方与接收方模式一致时最快**（对端选 B，这里也选 B）。
5. 没有摄像头时，把对方屏幕截图存进相册，用「图片解码」批量导入即可。

## 性能与限制

- 解码速度取决于帧率与清晰度：1080p、发送端 15fps 时通常十几秒内可收完几十 KB。
- 手机端建议 2 个解码线程；线程越多内存占用越高（每份实例约数十 MB）。
- 单张静态图只带来一帧的数据量，小文件可一张搞定，大文件需要多帧/多张。
- iPhone 需要 iOS 16.4+（WebCodecs/`requestVideoFrameCallback` 相关），低版本会自动走 Canvas 取帧。
- 亮度、抖动、摩尔纹都会影响识别：贴近平板/显示器、避开反光效果最好。

## 许可证与致谢

- `public/vendor/cimbar_js.js`、`public/vendor/cimbar_js.wasm`：来自 [sz3/libcimbar](https://github.com/sz3/libcimbar) v0.6.8 官方发布，**未修改算法**，仅重命名文件并同步引用路径（见 `LIBRARY-NOTICES.md`）。遵循 MPL-2.0，见 `LICENSE-libcimbar`。
- 本仓库其余代码：MIT。
