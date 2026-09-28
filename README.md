# Toneferry iOS Background Patch

English: A patch for [Toneferry](https://github.com/magicflower2/Toneferry) that keeps its LAN web-audio streaming alive when the iPhone/iPad screen is locked or Safari is backgrounded. Core changes are frontend-only. 中文说明见下。

---

## 解决什么问题

上游 [Toneferry](https://github.com/magicflower2/Toneferry) 让手机浏览器实时收听电脑声音（WASAPI Loopback → WebSocket → WebAudio），但 iPhone/iPad 上有一个系统级限制：**网页一息屏/切后台，iOS 就冻结 WebAudio 音频引擎**，锁屏几秒后就没声了。静音音频保活、`visibilitychange` 补丁都只能续命几十秒。

## 原理（三件套）

1. **伪装直播流**：把 WebAudio 输出接进 `MediaStreamAudioDestinationNode`，再挂到一个 `<audio>` 元素上。Safari 会把它当成"永不结束的直播流"——这是 iOS 唯一允许后台持续播放的网页音频类型。
2. **双通道路由**：前台走 WebAudio 直连扬声器（低延迟），`<audio>` 元素只当 1% 音量的"会话载体"；切后台时元素音量拉满接管出声。**低延迟与息屏播放两全**。
3. **中断自动续播**：AirPods 被其他设备抢走时，iOS 会暂停页面媒体元素。提供级联重试恢复 + 「被抢后自动抢回」开关（默认关，原因见下文 AirPods 规则），锁屏播放条点"播放"可一键恢复。

辅助机制：`navigator.audioSession.type = "playback"`（iOS 16.4+，升级为媒体会话）、AudioContext `interrupted` 状态自动 `resume()`（MDN 记载的 iOS Safari 官方恢复模式）、静音 WAV 循环保媒体会话、服务端对静态资源下发 `Cache-Control: no-cache`（保证 iOS 刷新必得最新脚本）。

## 与上游的差异

核心改动**全在前端**，服务端只加了缓存头：

| 文件 | 改动 |
|---|---|
| `public/app.js` | 伪装直播流、双通道路由、audioSession 声明、中断续播、抢回开关 |
| `public/index.html` | 新增「被抢后自动抢回」开关按钮；脚本引用加版本号击穿 Safari 缓存 |
| `server/index.js` | 静态资源下发 `Cache-Control: no-cache` |

其余文件与上游一致。`bin/audio-capture.exe` 取自上游发布物（164KB，MIT 许可）。

## 使用

前置：Windows + Node.js ≥ 18。

```bash
npm install
npm start
```

或者双击 `start-background.vbs`（无窗口后台启动，重复双击不会起两份；停止双击 `stop-background.vbs`，只杀 3088 端口对应的进程，不误伤其他 node 程序）。

iPhone/iPad 与电脑连同一 Wi-Fi，Safari 打开 `http://<电脑局域网IP>:3088` → 点开始收听。首次运行如弹防火墙提示，点"允许"。

## AirPods 用户必读（切换规则决定的开关语义）

AirPods 自动切换的规则（Apple 官方文档）：**切换由"某台设备开始播放"触发**；耳机只会自动回到"从未停止播放"的设备；没有设备在播放时，耳机原地不动。由此：

- 「被抢后自动抢回」**默认关闭**：耳机被手机抢走后 iPad 保持安静，绝不抢断。回切 = 锁屏播放条点一下播放。
- 打开开关 = 被抢后自动恢复播放，让 iPad 保持"活跃播放设备"身份，手机停声后耳机自动回来——**但切到手机的几秒内它也会把耳机拽回来**（恢复播放本身就是一次"开始播放"）。要用手机听东西，先把开关关掉。
- **进阶推荐**：在 iPad 的「快捷指令」建一个自动化——触发条件选蓝牙设备"AirPods 已连接"→ 动作选"播放"→ 关闭"运行前询问"。耳机切回 iPad 的瞬间系统自动续播，全程只需一次切换点击。
- 想彻底告别自动抢来抢去：设置 → 点顶部的 AirPods → "连接到此 iPhone/iPad" → 改为"上次连接到此 iPhone/iPad"（关闭自动切换，所有切换都由控制中心手动完成）。

## 已知限制

- 锁屏播放控制条可能显示"暂停"状态（媒体会话声明方式导致），不影响实际播放
- 局域网 `http://IP` 属于非安全上下文，AudioWorklet 不可用，会自动降级为 ScriptProcessor 模式（功能一致，CPU 占用略高）
- 前台直连延迟约 0.2s；后台经元素通道约 0.5~1s
- 若 iOS 后台把 WebAudio 渲染图整体冻结（个别版本行为差异），后台可能无声——此时依赖元素通道兜底

## License

MIT。上游作者版权见 [LICENSE](./LICENSE)；本补丁同样以 MIT 发布。
