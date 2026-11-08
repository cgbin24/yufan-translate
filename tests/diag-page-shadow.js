// 诊断脚本 2：验证整页翻译的"深度收集"——Shadow DOM 穿透 + 属性翻译。
// 真实 DOM 桩需支持 shadowRoot、属性读写、childNodes 递归（不使用 TreeWalker）。
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT = path.resolve(__dirname, "../extension");

// ---------- 真实节点桩（支持 shadowRoot）----------
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
    shadowRoot: null, // open shadow root（模拟）
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

// 给元素挂一个 open shadow root 并返回它（模拟 element.attachShadow）
function attachShadow(host, doc) {
  const sr = makeElement("#shadowroot#", doc);
  host.shadowRoot = sr;
  return sr;
}

function makeDocument() {
  const doc = {
    nodeType: 9,
    _byId: {},
    createElement: (t) => makeElement(t, doc),
    createTextNode: (t) => makeTextNode(t, doc),
    getElementById(id) { if (!this._byId[id]) this._byId[id] = makeElement("div", doc); return this._byId[id]; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
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

// 构造一棵含 shadow DOM + 属性的页面树
function buildPage(doc) {
  // 1) 普通文本（light DOM）
  const p0 = makeElement("p", doc);
  p0.appendChild(makeTextNode("Normal light DOM paragraph", doc));
  doc.body.appendChild(p0);

  // 2) 自定义元素 + open shadow root（Web Components 场景）
  const card = makeElement("my-card", doc);
  const sr = attachShadow(card, doc);
  const p1 = makeElement("p", doc);
  p1.appendChild(makeTextNode("Shadow DOM heading text", doc));
  const btn = makeElement("button", doc);
  btn.appendChild(makeTextNode("Shadow button label", doc));
  btn.setAttribute("title", "Shadow tooltip text");
  sr.appendChild(p1);
  sr.appendChild(btn);
  doc.body.appendChild(card);

  // 3) 属性里的文字（placeholder / alt）
  const input = makeElement("input", doc);
  input.setAttribute("type", "search");
  input.setAttribute("placeholder", "Search the site");
  doc.body.appendChild(input);

  const img = makeElement("img", doc);
  img.setAttribute("alt", "Company logo image");
  doc.body.appendChild(img);

  // 4) 下拉选项（之前被 SELECT/OPTION 跳过，现在应被识别）
  const select = makeElement("select", doc);
  const opt = makeElement("option", doc);
  opt.appendChild(makeTextNode("Choose language", doc));
  select.appendChild(opt);
  doc.body.appendChild(select);
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

// 在 doc.body 下递归查找：某元素的某属性值是否已被翻译
// （placeholder/aria-label/alt 直接变成"译:原文"；title 变成"原文 ｜ 译:原文"）
function attrHasTranslation(root, attr) {
  let found = null;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    for (const c of cur.childNodes || []) {
      if (c.nodeType === 1) {
        const v = c.getAttribute && c.getAttribute(attr);
        if (v && String(v).includes("译:")) {
          found = String(v);
        }
        if (c.shadowRoot) stack.push(c.shadowRoot);
        stack.push(c);
      }
    }
  }
  return found;
}

// 统计插入的译文节点（data-yufan-translation）数量，含 shadow
function countTranslations(root) {
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    for (const c of cur.childNodes || []) {
      if (c.nodeType === 1) {
        if (c.getAttribute && c.getAttribute("data-yufan-translation") === "true") count++;
        if (c.shadowRoot) stack.push(c.shadowRoot);
        stack.push(c);
      }
    }
  }
  return count;
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

  const onMsg = getMsgListeners().find((f) => typeof f === "function");
  if (!onMsg) { console.error("❌ 未捕获到 onMessage 监听器"); process.exit(1); }

  let responded = null;
  onMsg({ type: "YUFAN_TRANSLATE_PAGE" }, {}, (r) => { responded = r; });
  await new Promise((r) => setTimeout(r, 400));

  const textCount = countTranslations(doc.body);
  const shadowPlaceholder = attrHasTranslation(doc.body, "placeholder");
  const shadowAlt = attrHasTranslation(doc.body, "alt");
  const shadowTitle = attrHasTranslation(doc.body, "title");

  console.log("message 响应:", JSON.stringify(responded));
  console.log("插入的译文本节点数（含 shadow）:", textCount);
  console.log("placeholder 翻译:", shadowPlaceholder);
  console.log("alt 翻译:", shadowAlt);
  console.log("title 翻译:", shadowTitle);

  const ok =
    textCount >= 4 && // 普通 + shadow + 选项 文本都应被翻译
    shadowPlaceholder &&
    shadowAlt &&
    shadowTitle;

  if (!ok) {
    console.error("\n❌ 深度收集存在漏识别：文本节点数=" + textCount +
      " placeholder=" + shadowPlaceholder + " alt=" + shadowAlt + " title=" + shadowTitle);
    process.exit(2);
  } else {
    console.log("\n✅ 深度收集正常：Shadow DOM 文本 + 属性（placeholder/alt/title）+ 下拉选项 均被识别并翻译");
  }
})();
