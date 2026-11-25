# 会话内查找 · Find in conversation

DeepSeek Harness 的会话内查找插件：`Ctrl+F`（macOS `Cmd+F`）在打开的会话正文里找字，像浏览器那样高亮全部命中、逐个跳转、显示真实计数。

这个仓库的重点不是「功能多」，而是**每个报出来的数字都能被独立验证**。`node verify.mjs` 的 36 条断言里，凡涉及语义的都拿**安装包 `app.asar` 里读出来的宿主源码**当对照，而不是拿我这个插件的另一份实现当对照。

> **What this is.** A find-in-conversation plugin for DeepSeek Harness. Press `Ctrl+F` / `Cmd+F` to search the rendered conversation text with browser-like highlighting, stepping, and an honest match count. The point of this repo is not breadth of features but that **every number it reports can be checked independently**: `verify.mjs` compares this plugin's matching semantics against the copy of the host's own filter code read out of the installed `app.asar`, not against a second implementation of my own.

---

## 装

插件通过 **profile 的 `package.json` + `cordis.patch.yml`** 挂载，不需要构建步骤（纯 ESM，无依赖，无 `node_modules`）。

1. 在本机某个目录克隆本仓库，例如 `D:\Workbuddyspace\dsh-find-in-session`。
2. 在 DSH profile 目录（Windows 上是 `%USERPROFILE%\.dsh\profiles\desktop`）的 `package.json` 里，往两个位置各加一项：

   ```jsonc
   {
     "dependencies": {
       "@local/dsh-find-in-session": "link:D:/Workbuddyspace/dsh-find-in-session"
     },
     "dsh": {
       "profile": {
         "bundles": [
           // ……原有的 bundle 保持不动，只在末尾追加这一行
           "@local/dsh-find-in-session"
         ]
       }
     }
   }
   ```

   注意 bundle 列表在 `dsh.profile.bundles` 里，**不是** `dsh.bundles`；`dependencies` 则是最外层的一个键。

3. profile 的 `cordis.patch.yml` 由本包自带的 `cordis.patch.yml` 负责插入，内容是：

   ```yaml
   - insert:
       - id: find-in-session
         name: '@local/dsh-find-in-session'
   ```

   只有当 profile 没有自动合并 bundle 的 patch 时，才需要把这三行手工抄进 profile 的 `cordis.patch.yml`。

4. **完全退出** DeepSeek Harness（不是关窗口，是让所有进程退出）再启动。客户端 bundle 在首次 GET 后被缓存，只刷新页面不会加载到新代码。

## 用

- **侧栏底部**「会话内查找」入口；侧栏收窄成 rail 时变成放大镜图标，命中数显示在宽态行上。
- **`Ctrl+F` / `Cmd+F`** 打开。**再按一次是重新聚焦并全选**（浏览器的行为），不是关闭。
- 查找条浮在会话列右上角，列宽变化（开右栏、折叠侧栏、拖分隔条）时用 `ResizeObserver` 重新测量位置——这些变化不触发 `window.resize`。
- 打开时如果会话里有选中文字，会用那段文字作为查询种子（最多 200 字符）。

键位：

| 位置 | 键 | 行为 |
|---|---|---|
| 输入框内 | 输入 | 即搜（20ms 防抖） |
| 输入框内 | `Enter` / `F3` | 下一处 |
| 输入框内 | `Shift+Enter` / `Shift+F3` | 上一处 |
| 输入框内 | `Escape` | 关闭并把焦点还给打开前的位置 |
| 任意处 | `Ctrl+F` / `Cmd+F` | 打开 / 重新聚焦并全选 |
| 任意处 | `Ctrl+G` / `Ctrl+Shift+G` | 下一处 / 上一处 |
| 任意处 | `F3` / `Shift+F3` | 下一处 / 上一处 |
| 任意处 | `Escape` | 关闭（输入框内的 Escape 由输入框自己处理，全局监听主动跳过） |

用中文输入法时，用 `Enter` **提交候选词**不会误跳到下一处：Chromium 的 `compositionend` → `keydown` 顺序会让 `isComposing` 已经是 `false`，所以插件额外记了 composition 结束的时刻，`IME_COMMIT_GUARD_MS = 60` 毫秒内的 Enter 一律当提交处理。

### 三个容易误解但都正确的行为

- **0 命中时会自己去翻页。** 当前窗口里找不到，插件会去**点宿主自己的「加载更早」控件**（`[data-chat-history]` 里那个按钮），然后重搜，最多 8 页。它自己从不实现分页——补页、滚动锚定、重分页都归宿主，第二个实现只会跟它打架。翻到会话开头和翻满 8 页是**两句不同的话**。
- **计数带 `+` 是有意的。** 高亮不是免费的（`new Highlight(...ranges)` 每个命中一个实参），最多画 4000 处。到上限时条上会明说「已高亮 4000 处」，侧栏计数写成 `5000+`。没有命中被静默丢弃。
- **没有会话的页面说「没有会话」。** 在设置/插件/日程页按 `Ctrl+F`，条会说明当前页面没有会话，而不是对一个不存在的会话说「已到开头」或「无匹配」。

## 匹配语义：与宿主逐字等价

查询编译方式与宿主自己的会话文本过滤（`@deepseek-ai/dsh-session-query` 的 `compileSessionTextFilter`）**逐字等价**：大小写不敏感、词间空白弹性（`hello world` 命中 `hello\t\tworld` 和换行，但不命中 `helloworld`）、其余一律字面量（输入 `.*` 找的是点加星号，不是通配符）。

这不是我声明的，是 `verify.mjs` 断言的：同一组探针字符串分别喂给本插件的编译器和**从 `app.asar` 里读出来的**宿主编译器，正则 `source` 与 `flags` 不一致即失败。

## 验证

```bash
node verify.mjs
```

```
36 项断言全部通过 — 全绿
```

`verify.mjs` 无依赖（只用 Node 内置模块），它做三类事：

1. **抽取而非复制。** 用 `vm` 执行 `client.js` 里 `// #region pure-contracts` 段的纯函数，同时从 `app.asar` 里切出宿主的 `extractSessionEventText` / `compileSessionTextFilter` 一起求值，然后对拍。
2. **拿真实日志跑。** 读本机最大的会话 `.jsonl.zstd`（多帧 zstd，需 `tools/zstd-frames.mjs` 分帧解），用宿主的抽取规则算出全部可搜文本，再拿 7 条查询在**全部文档**上比对两个实现是否 0 分歧。
3. **拿宿主设计令牌算对比度。** 从 asar 里读 `design-platform.css` 解析出真实色值，重算 WCAG 对比度，而不是相信我写在文档里的数字。

### 这台机器之外跑不了

`verify.mjs:25`、`verify.mjs:28` 和 `tools/host-inventory.mjs:27` 硬编码了本机的 DSH 安装路径与会话目录：

```js
const ASAR = 'C:\\Users\\Hanoc\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar'
const SESSIONS_ROOT = 'C:\\Users\\Hanoc\\.dsh\\sessions'
```

换一台机器要改这三处才能跑。这是有意的取舍：**宁可在能跑的地方跑真的**，也不把断言降级成「检查字符串里有没有某个函数名」。

## 目录

```
client.js              全部实现：纯函数契约区 / 搜索引擎 / 控制器 / 查找条 / 侧栏入口
index.js               Host half（空 apply()，一切都在 Client 侧）
cordis.patch.yml       把插件挂进 profile 的 patch 行
locale/{zh,en}.json    插件名、描述、meta.detail（指向 docs/）
docs/DETAIL.zh.md      插件详情页正文（中文）
docs/DETAIL.md         同上（英文）
docs/preview.svg       详情页首图
icon.svg               插件页图标
verify.mjs             36 条断言的真值对照程序
tools/asar-read.mjs    无依赖读 app.asar（payload 起点 = 8 + u32@4，不是 u32@12）
tools/host-inventory.mjs  asar 查询 CLI：find / grep / tokens / read
tools/zstd-frames.mjs  多帧 zstd 解帧（Node 内置只解第一帧）
```

发布集合是 `package.json` 的 `files` 字段：`index.js`、`client.js`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`、`docs/*`。`verify.mjs` 和 `tools/` 不在发布集合里，它们是证据，不是运行时。

`docs/` 三个文件是**硬依赖**：`locale/*.json` 的 `meta.detail` 指向它们，宿主会校验文件存在且路径不越出包根，缺了详情页打不开。

## 它刻意不做什么

- **不读会话事件日志。** 只匹配会话列真正渲染出来的文字。工具调用的原始参数、请求头、任何没画进正文的东西都不在范围内——那是宿主会话搜索的职责，这条查找条不冒充能做。
- **不搜控件里的字。** 候选只来自文本节点，落在 `button`、`input`、`select`、`option`、`textarea`、`script`、`style`、`[aria-hidden="true"]`、`[data-chat-history]`、`[data-chat-turn-spacer]`、`[data-text-interaction-surface]` 之下的一律跳过。转写区自带按钮上的文字因此搜不到：那是界面外壳，不是对话内容，把这些算进命中会让计数取决于恰好有哪些控件在屏幕上。
- **不跨会话。** 一次只搜当前这一段。
- **查找条不能拖动、停靠或折叠。** 固定在会话头部下方、右对齐聊天列。它会遮住正文最上面一条消息的一小部分——这是不往宿主布局里塞容器的代价。
- **不新增命中列表、设置页、第二个搜索框或独立窗口。** 一条条、一个侧栏入口、同一套快捷键。
- **不实现正则、全词匹配或大小写敏感开关。** 宿主只有一套字面量语义，对齐它才是重点。

更细的讨论（含每处对比度的具体数值）见 [docs/DETAIL.zh.md](docs/DETAIL.zh.md)。

## 许可

[MIT](LICENSE)。
