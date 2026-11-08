// 真实 DOM（jsdom）端到端诊断：验证整页翻译在接近真实浏览器的 DOM 下
// 是否收集到文本、发出翻译请求、把译文插入 DOM、并创建右下角浮层。
// 比手写桩真实：jsdom 支持 innerHTML 解析 / TreeWalker / getComputedStyle。
// 注意：jsdom 不做布局，getBoundingClientRect 全 0，会误判可见性，需 mock 掉。
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const EXT = path.resolve(__dirname, "../extension");

const html = `<!DOCTYPE html><html><body>
  <h1>Welcome to the demo site</h1>
  <div><p>Hello world this is English content</p><p>Translate this sentence please</p></div>
  <p>这是中文段落</p>
</body></html>`;

const dom = new JSDOM(html, { url: "https://example.com", pretendToBeVisual: true });
const { window } = dom;

// jsdom 不布局，getBoundingClientRect 全 0 -> isElementVisible 全误判为不可见。
// 覆盖为非 0 尺寸，让整页翻译能走到"可见节点立即翻译"的路径。
try {
  Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", {
    value: () => ({ top: 0, left: 0, bottom: 100, right: 100, width: 100, height: 20, x: 0, y: 0 }),
    configurable: true,
    writable: true,
  });
} catch (_) {}

const captured = [];
let msgListeners = [];
const chrome = {
  runtime: {
    id: "diag",
    getURL: (p) => `chrome-extension://diag/${p}`,
    onMessage: { addListener: (fn) => msgListeners.push(fn) },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    sendMessage: async (msg) => {
      if (msg.type === "YUFAN_DETECT") return { ok: true, data: { code: "en", confident: true } };
      if (msg.type === "YUFAN_TRANSLATE_BATCH") {
        const texts = (msg.payload && msg.payload.texts) || [];
        const target = msg.payload && msg.payload.target;
        captured.push({ target, count: texts.length });
        return { ok: true, data: { results: texts.map((t) => "译:" + t), target } };
      }
      return { ok: true, data: {} };
    },
    reload() {}, lastError: null, openOptionsPage() {},
  },
  storage: {
    sync: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
    local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
  },
  contextMenus: { removeAll: (cb) => cb && cb(), create() {}, onClicked: { addListener() {} } },
  scripting: { executeScript: () => Promise.resolve() },
  tabs: { sendMessage() {} },
  webNavigation: { getAllFrames: () => Promise.resolve([]) },
  i18n: { getMessage: () => "" },
};

const sandbox = {
  chrome,
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  getComputedStyle: window.getComputedStyle.bind(window),
  Node: window.Node,
  NodeFilter: window.NodeFilter,
  MutationObserver: window.MutationObserver,
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  setTimeout, clearTimeout, setInterval, clearInterval,
  URL, URLSearchParams, AbortController, AbortSignal,
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  console: { log: () => {}, warn: () => {}, error: (...a) => console.error("[content-error]", ...a) },
  Promise, JSON, Math, Map, Set, Array, Object, String, Number, Boolean, RegExp, Error, Date, Intl, Buffer,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
window.__yufanTranslateLoaded = false;

const code = fs.readFileSync(path.resolve(EXT, "content.js"), "utf8");
vm.createContext(sandbox);
try {
  vm.runInContext(code, sandbox, { filename: "content.js" });
} catch (e) {
  console.error("❌ content.js 加载抛错:", e.stack);
  process.exit(1);
}
console.log("✓ content.js 加载完成, __yufanTranslateLoaded =", window.__yufanTranslateLoaded);

const onMsg = msgListeners.find((f) => typeof f === "function");
if (!onMsg) { console.error("❌ 未捕获 onMessage 监听"); process.exit(1); }

let responded = null;
onMsg({ type: "YUFAN_TRANSLATE_PAGE" }, {}, (r) => { responded = r; });

setTimeout(() => {
  const doc = window.document;
  const trans = doc.querySelectorAll('[data-yufan-translation="true"]');
  const progress = doc.querySelector('[id$="page-progress"], [class*="page-progress"]');
  console.log("翻译请求批次:", captured.length, "目标语言:", [...new Set(captured.map((c) => c.target))]);
  console.log("收集+翻译的总文本条数:", captured.reduce((a, c) => a + c.count, 0));
  console.log("插入的译文元素数:", trans.length);
  console.log("译文样本:", Array.from(trans).slice(0, 3).map((e) => e.textContent));
  console.log("右下角浮层存在:", !!progress);
  if (trans.length === 0) {
    console.error("\n❌ 整页翻译没有插入任何译文 — content.js 在真实 DOM 下存在问题");
    process.exit(2);
  }
  console.log("\n✅ jsdom 真实 DOM 下整页翻译正常：收集文本 + 发请求 + 插入译文 + 浮层");
  process.exit(0);
}, 600);
