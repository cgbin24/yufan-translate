// 专项诊断：验证整页翻译目标语言被锁定为简体中文 (zh-CN)。
//   场景1：英文页面 + 无 target 的指令 -> 应译为 zh-CN
//   场景2：英文页面 + popup 传入 target=fr -> 应忽略 popup，仍为 zh-CN
//   场景3：简体中文页面 -> 不应触发任何翻译（语言保护跳过）
// 做法：加载真实 content.js 到沙箱，拦截 YUFAN_TRANSLATE_BATCH 消息，记录 payload.target。
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT = path.resolve(__dirname, "../extension");

// ---------- 精简 DOM 桩（与 diag-page-translate.js 同源，保证一致） ----------
function makeTextNode(text, doc) {
  return {
    nodeType: 3, _value: text, parentElement: null, ownerDocument: doc,
    get nodeValue() { return this._value; },
    set nodeValue(v) { this._value = v; },
    get textContent() { return this._value; },
    set textContent(v) { this._value = v; },
  };
}
function makeElement(tag, doc) {
  const el = {
    tagName: String(tag || "div").toUpperCase(), nodeType: 1, style: {}, dataset: {},
    _attrs: {}, _classes: new Set(), childNodes: [], parentElement: null, ownerDocument: doc,
    offsetWidth: 100, offsetHeight: 20, textContent: "", innerHTML: "", hidden: false, disabled: false, value: "", firstChild: null, _listeners: {},
    get classList() { const s = this._classes; return { add: (...c) => c.forEach((x) => s.add(x)), remove: (...c) => c.forEach((x) => s.delete(x)), toggle: (c, on) => { if (on === undefined) { s.has(c) ? s.delete(c) : s.add(c); } else { on ? s.add(c) : s.delete(c); } }, contains: (c) => s.has(c) }; },
    get className() { return [...this._classes].join(" "); },
    set className(v) { this._classes = new Set(String(v || "").split(/\s+/).filter(Boolean)); },
    appendChild(c) { c.parentElement = this; this.childNodes.push(c); this._syncFirst(); return c; },
    insertBefore(c, ref) { const i = this.childNodes.indexOf(ref); if (i === -1) return this.appendChild(c); this.childNodes.splice(i, 0, c); c.parentElement = this; this._syncFirst(); return c; },
    after(n) { if (!this.parentElement) return; const sibs = this.parentElement.childNodes; const i = sibs.indexOf(this); if (i === -1) { this.parentElement.appendChild(n); return; } sibs.splice(i + 1, 0, n); n.parentElement = this.parentElement; },
    removeChild(c) { this.childNodes = this.childNodes.filter((x) => x !== c); this._syncFirst(); return c; },
    remove() { if (this.parentElement) this.parentElement.removeChild(this); },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    removeAttribute(k) { delete this._attrs[k]; },
    hasAttribute(k) { return k in this._attrs; },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener() {}, dispatchEvent() { return true; }, closest() { return null; },
    getBoundingClientRect() { return { top: 0, left: 0, bottom: 20, right: 100, width: 100, height: 20 }; },
    getClientRects() { return [{ width: 100, height: 20 }]; }, scrollIntoView() {}, focus() {}, normalize() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, getElementsByTagName() { return []; },
    _syncFirst() { this.firstChild = this.childNodes[0] || null; },
  };
  return el;
}
function makeDocument() {
  const doc = {
    nodeType: 9, _byId: {},
    createElement: (t) => makeElement(t, doc), createTextNode: (t) => makeTextNode(t, doc),
    createTreeWalker(root, whatToShow, filter) {
      const all = [];
      (function walk(node) {
        for (const child of node.childNodes || []) {
          if (child.nodeType === 3) { if (!filter || filter.acceptNode(child) === 1) all.push(child); }
          else if (child.nodeType === 1) { walk(child); }
        }
      })(root || doc.body);
      let i = 0;
      return { nextNode() { return i < all.length ? all[i++] : null; }, currentNode: null };
    },
    getElementById(id) { if (!this._byId[id]) this._byId[id] = makeElement("div", doc); return this._byId[id]; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener(t, fn) { (this._listeners = this._listeners || {})[t] = (this._listeners[t] || []).concat(fn); }, _listeners: {},
  };
  doc.body = makeElement("body", doc); doc.head = makeElement("head", doc); doc.documentElement = makeElement("html", doc);
  doc.documentElement.clientWidth = 1200; doc.documentElement.clientHeight = 800;
  return doc;
}
function buildPage(doc) {
  const h1 = makeElement("h1", doc); h1.appendChild(makeTextNode("Welcome to the demo site", doc));
  const div = makeElement("div", doc);
  const p1 = makeElement("p", doc); p1.appendChild(makeTextNode("Hello world this is English content", doc));
  const p2 = makeElement("p", doc); p2.appendChild(makeTextNode("Translate this sentence please", doc));
  div.appendChild(p1); div.appendChild(p2);
  doc.body.appendChild(h1); doc.body.appendChild(div);
}

// 加载 content.js 到沙箱，拦截翻译请求并记录目标语言
function loadContent(detectCode) {
  const doc = makeDocument();
  const capturedTargets = [];
  let msgListeners = [];
  const win = {
    __yufanTranslateLoaded: false, innerWidth: 1200, innerHeight: 800, scrollX: 0, scrollY: 0,
    getSelection: () => ({ toString: () => "", rangeCount: 0, getRangeAt: () => ({ getBoundingClientRect: () => ({ width: 0, height: 0 }) }) }),
    addEventListener() {}, removeEventListener() {}, getComputedStyle: () => ({}),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  const sandbox = {
    window: win, document: doc,
    chrome: {
      runtime: {
        id: "diag", getURL: (p) => `chrome-extension://diag/${p}`,
        onMessage: { addListener: (fn) => msgListeners.push(fn) },
        onInstalled: { addListener() {} }, onStartup: { addListener() {} },
        sendMessage: async (msg) => {
          if (msg.type === "YUFAN_DETECT") return { ok: true, data: { code: detectCode, confident: true } };
          if (msg.type === "YUFAN_TRANSLATE_BATCH") {
            const t = msg.payload && msg.payload.target;
            if (t) capturedTargets.push(t);
            const texts = (msg.payload && msg.payload.texts) || [];
            return { ok: true, data: { results: texts.map((x) => "译:" + x) } };
          }
          return { ok: true, data: {} };
        },
        reload() {}, lastError: null, openOptionsPage() {},
      },
      storage: { sync: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() }, local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
      contextMenus: { removeAll: (cb) => cb && cb(), create() {}, onClicked: { addListener() {} } },
      scripting: { executeScript: () => Promise.resolve() }, tabs: { sendMessage() {} },
      webNavigation: { getAllFrames: () => Promise.resolve([]) }, i18n: { getMessage: () => "" },
    },
    console: { log: () => {}, warn: () => {}, error: (...a) => console.error("[content-error]", ...a) },
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: (id) => clearTimeout(id),
    getComputedStyle: () => ({}), Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
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
  const code = fs.readFileSync(path.resolve(EXT, "content.js"), "utf8");
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "content.js" });
  const onMsg = msgListeners.find((f) => typeof f === "function");
  return { doc, onMsg, capturedTargets };
}

(async () => {
  let failures = 0;

  // 场景1：英文页面 + 无 target -> 应译为 zh-CN
  {
    const { doc, onMsg, capturedTargets } = loadContent("en");
    buildPage(doc);
    onMsg({ type: "YUFAN_TRANSLATE_PAGE" }, {}, () => {});
    await new Promise((r) => setTimeout(r, 300));
    const uniq = [...new Set(capturedTargets)];
    const ok = capturedTargets.length > 0 && capturedTargets.every((t) => t === "zh-CN");
    console.log(`[场景1] 英文页面/无target: 翻译请求数=${capturedTargets.length}, 目标=${JSON.stringify(uniq)} -> ${ok ? "通过" : "失败"}`);
    if (!ok) failures++;
  }

  // 场景2：英文页面 + popup 传入 target=fr -> 应忽略，仍为 zh-CN
  {
    const { doc, onMsg, capturedTargets } = loadContent("en");
    buildPage(doc);
    onMsg({ type: "YUFAN_TRANSLATE_PAGE", payload: { target: "fr" } }, {}, () => {});
    await new Promise((r) => setTimeout(r, 300));
    const uniq = [...new Set(capturedTargets)];
    const ok = capturedTargets.length > 0 && capturedTargets.every((t) => t === "zh-CN");
    console.log(`[场景2] 英文页面/popup传fr: 翻译请求数=${capturedTargets.length}, 目标=${JSON.stringify(uniq)} -> ${ok ? "通过" : "失败"}`);
    if (!ok) failures++;
  }

  // 场景3：简体中文页面（检测源=zh-CN，且页面混有英文片段）-> 不再整页跳过，
  //         仍把页面外文译为 zh-CN（验证"源是中文也翻译外文"，目标始终 zh-CN）。
  {
    const { doc, onMsg, capturedTargets } = loadContent("zh-CN");
    const h1 = makeElement("h1", doc); h1.appendChild(makeTextNode("欢迎使用本站 Welcome to our site", doc));
    const p = makeElement("p", doc); p.appendChild(makeTextNode("这是中文段落 with some English content", doc));
    doc.body.appendChild(h1); doc.body.appendChild(p);
    onMsg({ type: "YUFAN_TRANSLATE_PAGE" }, {}, () => {});
    await new Promise((r) => setTimeout(r, 300));
    const uniq = [...new Set(capturedTargets)];
    const ok = capturedTargets.length > 0 && capturedTargets.every((t) => t === "zh-CN");
    console.log(`[场景3] 简中页(混英文): 翻译请求数=${capturedTargets.length}, 目标=${JSON.stringify(uniq)} -> ${ok ? "通过(不再跳过)" : "失败"}`);
    if (!ok) failures++;
  }

  if (failures > 0) {
    console.error(`\n❌ 整页翻译目标语言锁定测试失败 (${failures} 项)`);
    process.exit(2);
  }
  console.log("\n✅ 整页翻译目标语言锁定为简体中文：通过（忽略 popup 传入语言；源为简体中文时自动跳过）");
})();
