// 诊断脚本：用增强 DOM 桩加载 content.js，派发整页翻译消息，验证译文是否插入 DOM。
// 目的：确认"整页翻译没有效果"是 content.js 逻辑问题还是触发入口问题。
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT = path.resolve(__dirname, "../extension");

// ---------- 真实节点桩 ----------
function makeTextNode(text, doc) {
  return {
    nodeType: 3,
    _value: text,
    parentElement: null,
    ownerDocument: doc,
    get nodeValue() { return this._value; },
    set nodeValue(v) { this._value = v; },
    get textContent() { return this._value; },
    set textContent(v) { this._value = v; },
  };
}

function makeElement(tag, doc) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    nodeType: 1,
    style: {},
    dataset: {},
    _attrs: {},
    _classes: new Set(),
    childNodes: [],
    parentElement: null,
    ownerDocument: doc,
    offsetWidth: 100,
    offsetHeight: 20,
    textContent: "",
    innerHTML: "",
    hidden: false,
    disabled: false,
    value: "",
    firstChild: null,
    _listeners: {},
    get classList() {
      const s = this._classes;
      return {
        add: (...c) => c.forEach((x) => s.add(x)),
        remove: (...c) => c.forEach((x) => s.delete(x)),
        toggle: (c, on) => { if (on === undefined) { s.has(c) ? s.delete(c) : s.add(c); } else { on ? s.add(c) : s.delete(c); } },
        contains: (c) => s.has(c),
      };
    },
    get className() { return [...this._classes].join(" "); },
    set className(v) { this._classes = new Set(String(v || "").split(/\s+/).filter(Boolean)); },
    appendChild(c) { c.parentElement = this; this.childNodes.push(c); this._syncFirst(); return c; },
    insertBefore(c, ref) {
      const i = this.childNodes.indexOf(ref);
      if (i === -1) return this.appendChild(c);
      this.childNodes.splice(i, 0, c); c.parentElement = this; this._syncFirst(); return c;
    },
    after(n) {
      if (!this.parentElement) return;
      const sibs = this.parentElement.childNodes;
      const i = sibs.indexOf(this);
      if (i === -1) { this.parentElement.appendChild(n); return; }
      sibs.splice(i + 1, 0, n); n.parentElement = this.parentElement;
    },
    removeChild(c) { this.childNodes = this.childNodes.filter((x) => x !== c); this._syncFirst(); return c; },
    remove() { if (this.parentElement) this.parentElement.removeChild(this); },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    removeAttribute(k) { delete this._attrs[k]; },
    hasAttribute(k) { return k in this._attrs; },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener() {},
    dispatchEvent() { return true; },
    closest() { return null; },
    getBoundingClientRect() { return { top: 0, left: 0, bottom: 20, right: 100, width: 100, height: 20 }; },
    getClientRects() { return [{ width: 100, height: 20 }]; },
    scrollIntoView() {},
    focus() {},
    normalize() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementsByTagName() { return []; },
    _syncFirst() { this.firstChild = this.childNodes[0] || null; },
  };
  return el;
}

function makeDocument() {
  const doc = {
    nodeType: 9,
    _byId: {},
    createElement: (t) => makeElement(t, doc),
    createTextNode: (t) => makeTextNode(t, doc),
    createTreeWalker(root, whatToShow, filter) {
      const all = [];
      (function walk(node) {
        for (const child of node.childNodes || []) {
          if (child.nodeType === 3) {
            if (!filter || filter.acceptNode(child) === 1) all.push(child);
          } else if (child.nodeType === 1) {
            walk(child);
          }
        }
      })(root || doc.body);
      let i = 0;
      return { nextNode() { return i < all.length ? all[i++] : null; }, currentNode: null };
    },
    getElementById(id) { if (!this._byId[id]) this._byId[id] = makeElement("div", doc); return this._byId[id]; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(t, fn) { (this._listeners = this._listeners || {})[t] = (this._listeners[t] || []).concat(fn); },
    _listeners: {},
  };
  doc.body = makeElement("body", doc);
  doc.head = makeElement("head", doc);
  doc.documentElement = makeElement("html", doc);
  doc.documentElement.clientWidth = 1200;
  doc.documentElement.clientHeight = 800;
  return doc;
}

// 构造一棵带文本节点的页面树
function buildPage(doc) {
  const h1 = makeElement("h1", doc);
  h1.appendChild(makeTextNode("Welcome to the demo site", doc));
  const div = makeElement("div", doc);
  const p1 = makeElement("p", doc);
  p1.appendChild(makeTextNode("Hello world this is English content", doc));
  const p2 = makeElement("p", doc);
  p2.appendChild(makeTextNode("Translate this sentence please", doc));
  div.appendChild(p1); div.appendChild(p2);
  doc.body.appendChild(h1); doc.body.appendChild(div);
}

// ---------- sandbox ----------
function buildSandbox() {
  const doc = makeDocument();
  let msgListeners = [];
  const win = {
    __yufanTranslateLoaded: false,
    innerWidth: 1200, innerHeight: 800, scrollX: 0, scrollY: 0,
    getSelection: () => ({ toString: () => "", rangeCount: 0, getRangeAt: () => ({ getBoundingClientRect: () => ({ width: 0, height: 0 }) }) }),
    addEventListener() {}, removeEventListener() {},
    getComputedStyle: () => ({}),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  const sandbox = {
    window: win, document: doc,
    chrome: {
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
            return { ok: true, data: { results: texts.map((t) => "译:" + t) } };
          }
          return { ok: true, data: {} };
        },
        reload() {}, lastError: null, openOptionsPage() {},
      },
      storage: { sync: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() }, local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
      contextMenus: { removeAll: (cb) => cb && cb(), create() {}, onClicked: { addListener() {} } },
      scripting: { executeScript: () => Promise.resolve() },
      tabs: { sendMessage() {} },
      webNavigation: { getAllFrames: () => Promise.resolve([]) },
      i18n: { getMessage: () => "" },
    },
    console: { log: () => {}, warn: () => {}, error: (...a) => console.error("[content-error]", ...a) },
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    getComputedStyle: () => ({}),
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    AbortController, AbortSignal, URL, URLSearchParams, fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    Audio: class { play() { return Promise.resolve(); } },
    location: { href: "https://example.com" },
    Promise, JSON, Math, Map, Set, Array, Object, String, Number, Boolean, RegExp, Error, Date, Buffer, Intl,
  };
  sandbox.globalThis = sandbox; sandbox.self = sandbox;
  return { sandbox, doc, win, getMsgListeners: () => msgListeners };
}

(async () => {
  const { sandbox, doc, win, getMsgListeners } = buildSandbox();
  buildPage(doc);

  const code = fs.readFileSync(path.resolve(EXT, "content.js"), "utf8");
  vm.createContext(sandbox);
  try {
    vm.runInContext(code, sandbox, { filename: "content.js" });
  } catch (e) {
    console.error("❌ content.js 加载抛错:", e.message);
    process.exit(1);
  }
  console.log("✓ content.js 加载完成, __yufanTranslateLoaded =", win.__yufanTranslateLoaded);

  const listeners = getMsgListeners();
  const onMsg = listeners.find((f) => typeof f === "function");
  if (!onMsg) { console.error("❌ 未捕获到 onMessage 监听器"); process.exit(1); }

  // 派发整页翻译指令
  let responded = null;
  onMsg({ type: "YUFAN_TRANSLATE_PAGE" }, {}, (r) => { responded = r; });
  // 等待异步翻译完成
  await new Promise((r) => setTimeout(r, 300));

  // 收集所有 data-yufan-translation 元素
  const found = [];
  (function walk(node) {
    for (const c of node.childNodes || []) {
      if (c.nodeType === 1) {
        if (c.getAttribute && c.getAttribute("data-yufan-translation") === "true") {
          found.push(c.textContent);
        }
        walk(c);
      }
    }
  })(doc.body);

  console.log("message 响应:", JSON.stringify(responded));
  console.log("插入的译文节点数:", found.length);
  console.log("译文内容样本:", found.slice(0, 5));
  if (found.length === 0) {
    console.error("\n❌ 整页翻译没有插入任何译文 — content.js 逻辑存在问题");
    process.exit(2);
  } else {
    console.log("\n✅ 整页翻译成功插入译文，content.js 逻辑正常");
  }
})();
