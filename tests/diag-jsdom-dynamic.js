// 真实 DOM（jsdom）动态内容诊断：
//   1) 含 shadow root 的组件（模拟 GitHub tool-tip）—— 验证 shadow 内 tooltip 文本被翻译
//   2) 初始 display:none 的动态面板 —— 验证其显示后（isIntersecting 变化）文本被兜底翻译
// 运行：NODE_PATH=... node tests/diag-jsdom-dynamic.js
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const EXT = path.resolve(__dirname, "../extension");

const html = `<!DOCTYPE html><html><body>
  <p id="plain">Hello world this is visible text</p>
  <x-tooltip id="tip"></x-tooltip>
  <div id="dialog" style="display:none"><p>Dialog dynamic panel content</p></div>
</body></html>`;

const dom = new JSDOM(html, { url: "https://example.com", pretendToBeVisual: true });
const { window } = dom;
const { document } = window;

// 给 x-tooltip 挂 open shadow root，内部放 tooltip 文本（light DOM 无文本，模拟 GitHub tool-tip）
const tipHost = document.getElementById("tip");
const sr = tipHost.attachShadow({ mode: "open" });
const tipInner = document.createElement("span");
tipInner.textContent = "Open menu tooltip text";
sr.appendChild(tipInner);

// jsdom 不布局，getBoundingClientRect 全 0，mock 成非 0 让可见性判断生效
try {
  Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", {
    value: function () {
      const cs = window.getComputedStyle(this);
      const hidden = cs.display === "none";
      return { top: 0, left: 0, bottom: 100, right: 100, width: hidden ? 0 : 100, height: hidden ? 0 : 20, x: 0, y: 0 };
    },
    configurable: true, writable: true,
  });
} catch (_) {}

// Mock IntersectionObserver：可见元素 observe 时触发 isIntersecting=true；
// display:none 元素 isIntersecting=false；并可手动 trigger 模拟"显示后进入视窗"。
class MockIO {
  constructor(cb) { this.cb = cb; MockIO.instance = this; }
  observe(el) {
    setTimeout(() => {
      const cs = window.getComputedStyle(el);
      const vis = cs.display !== "none";
      this.cb([{ isIntersecting: vis, target: el }], this);
    }, 0);
  }
  trigger(el, isIntersecting) { this.cb([{ isIntersecting, target: el }], this); }
  unobserve() {} disconnect() {}
}

const captured = [];
let msgListeners = [];
const chrome = {
  runtime: {
    id: "diag", getURL: (p) => `chrome-extension://diag/${p}`,
    onMessage: { addListener: (fn) => msgListeners.push(fn) },
    onInstalled: { addListener() {} }, onStartup: { addListener() {} },
    sendMessage: async (msg) => {
      if (msg.type === "YUFAN_DETECT") return { ok: true, data: { code: "en", confident: true } };
      if (msg.type === "YUFAN_TRANSLATE_BATCH") {
        const texts = (msg.payload && msg.payload.texts) || [];
        const target = msg.payload && msg.payload.target;
        captured.push(...texts);
        return { ok: true, data: { results: texts.map((t) => "译:" + t), target } };
      }
      return { ok: true, data: {} };
    },
    reload() {}, lastError: null, openOptionsPage() {},
  },
  storage: { sync: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() }, local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
  contextMenus: { removeAll: (cb) => cb && cb(), create() {}, onClicked: { addListener() {} } },
  scripting: { executeScript: () => Promise.resolve() }, tabs: { sendMessage() {} },
  webNavigation: { getAllFrames: () => Promise.resolve([]) }, i18n: { getMessage: () => "" },
};

const sandbox = {
  chrome, window, document,
  navigator: window.navigator, location: window.location,
  getComputedStyle: window.getComputedStyle.bind(window),
  Node: window.Node, NodeFilter: window.NodeFilter,
  MutationObserver: window.MutationObserver, IntersectionObserver: MockIO,
  requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: (id) => clearTimeout(id),
  setTimeout, clearTimeout, setInterval, clearInterval,
  URL, URLSearchParams, AbortController, AbortSignal,
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  console: { log: () => {}, warn: () => {}, error: (...a) => console.error("[content-error]", ...a) },
  Promise, JSON, Math, Map, Set, Array, Object, String, Number, Boolean, RegExp, Error, Date, Intl, Buffer,
};
sandbox.globalThis = sandbox; sandbox.self = sandbox;
window.__yufanTranslateLoaded = false;

const code = fs.readFileSync(path.resolve(EXT, "content.js"), "utf8");
vm.createContext(sandbox);
try { vm.runInContext(code, sandbox, { filename: "content.js" }); }
catch (e) { console.error("❌ content.js 加载抛错:", e.stack); process.exit(1); }

const onMsg = msgListeners.find((f) => typeof f === "function");
if (!onMsg) { console.error("❌ 未捕获 onMessage"); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const translationsIn = (root) => {
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (n.nodeType === 1 && n.getAttribute && n.getAttribute("data-yufan-translation") === "true") out.push(n.textContent);
    const kids = n.childNodes || [];
    for (const c of kids) walk(c);
    if (n.nodeType === 1 && n.shadowRoot) walk(n.shadowRoot);
  })(root);
  return out;
};

(async () => {
  onMsg({ type: "YUFAN_TRANSLATE_PAGE" }, {}, () => {});
  await sleep(500);

  const plainTr = translationsIn(document.getElementById("plain").parentElement);
  const tipTr = translationsIn(tipHost).concat(translationsIn(sr));
  const dialogTr = translationsIn(document.getElementById("dialog"));

  console.log("普通可见文本译文:", plainTr.slice(0, 2));
  console.log("shadow tooltip 译文:", tipTr.slice(0, 2), "(captured 含 tooltip:", captured.some((t) => /tooltip/i.test(t)), ")");
  console.log("隐藏面板译文(显示前):", dialogTr.slice(0, 2));

  // 模拟弹窗显示：display:none -> block，并触发 IO isIntersecting
  const dialog = document.getElementById("dialog");
  dialog.style.display = "block";
  if (MockIO.instance) MockIO.instance.trigger(dialog, true);
  await sleep(400);
  const dialogTrAfter = translationsIn(dialog);
  console.log("隐藏面板译文(显示后):", dialogTrAfter.slice(0, 2));

  const okPlain = plainTr.length > 0;
  const okTip = captured.some((t) => /tooltip/i.test(t)) || tipTr.length > 0;
  const okDialog = dialogTrAfter.length > 0;
  console.log(`\n普通文本翻译: ${okPlain ? "✓" : "✗"}`);
  console.log(`shadow tooltip 翻译: ${okTip ? "✓" : "✗"}`);
  console.log(`动态面板显示后翻译: ${okDialog ? "✓" : "✗"}`);

  if (okPlain && okTip && okDialog) {
    console.log("\n✅ 动态内容（shadow tooltip / 动态面板）翻译正常");
    process.exit(0);
  } else {
    console.error("\n❌ 仍有动态内容未被翻译");
    process.exit(2);
  }
})();
