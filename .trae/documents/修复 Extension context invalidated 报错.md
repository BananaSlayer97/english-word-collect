## 现象与原因
- 报错 `Uncaught Error: Extension context invalidated` 表示当前扩展脚本运行的上下文已被销毁（常见于：你在开发时“重新加载扩展/热更新”，或页面导航/刷新导致 content script 被替换）。
- 这类报错多发生在 content script 的异步回调/定时器/MutationObserver 触发时仍去调用 `chrome.storage`，典型位置是 [content.js](file:///Users/liuya/antigravityProject/english-word-collect/content/content.js#L7-L42) 的 `initHighlighting()` + debounce。

## 代码定位（已确认触发点）
- content script：`chrome.storage.local.get(['collectedWords'], ...)` 会在 DOMReady 和 MutationObserver 的 setTimeout 回调里被反复调用，扩展 reload 后很容易“回调落在已失效上下文”。[content.js](file:///Users/liuya/antigravityProject/english-word-collect/content/content.js#L7-L42)
- popup：打开 popup 时也会 `await chrome.storage.local.get(...)`，扩展 reload/关闭 popup 的边界上可能抛同类错误。[popup.js](file:///Users/liuya/antigravityProject/english-word-collect/popup/popup.js#L1-L16)
- options：同样大量读取 storage，但主要风险小于 content/popup（仍可加防护）。

## 修改方案（不改变功能，仅消除未捕获异常）
1) 在 `content/content.js` 增加“上下文存活”保护与清理
- 增加 `let wcAlive = true`。
- 在 `pagehide`/`unload` 时：
  - `wcAlive = false`
  - `observer.disconnect()`
  - `clearTimeout(highlightTimeout)`
- 所有入口函数（尤其 `initHighlighting()`）开头判断 `if (!wcAlive) return;`。

2) 为 storage 调用做安全封装
- 新增 `safeStorageGet(keys, cb)` 与 `safeStorageGetAsync(keys)`：
  - 用 `try/catch` 捕获 `Extension context invalidated`
  - 在回调里检查 `chrome.runtime.lastError`，出现错误则静默返回
- 将以下调用替换为安全封装：
  - `initHighlighting()` 内的 `chrome.storage.local.get`（最关键）
  - 弹窗渲染前的 `await chrome.storage.local.get(...)`（[content.js](file:///Users/liuya/antigravityProject/english-word-collect/content/content.js#L182-L187)）
  - `saveWord()` 等其它 get/set（同类风险点）

3) 在 `popup/popup.js` 增加 try/catch
- 包裹 `await chrome.storage.local.get(...)`；遇到 invalidated 直接 return，不再抛未捕获异常。

4)（可选）在 `options/options.js` 也做一致性防护
- 对初始化读取/保存配置的 storage 调用加 lastError 检查，避免关闭页面瞬间的噪音。

## 验证方式
- 打开任意网页（注入 content script），然后在 chrome://extensions 里点击“重新加载扩展”。
- 观察页面 Console：不应再出现 `Uncaught Error: Extension context invalidated`。
- 打开 popup 与 options 后重复 reload：同样不应再出现未捕获异常。

## 交付结果
- 不改变现有功能与数据结构，仅提升健壮性：扩展 reload/页面切换时不再出现未捕获错误，减少控制台噪音并避免潜在的逻辑中断。