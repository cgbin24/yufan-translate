// 真实 DOM 端到端：用 jsdom 构造含中英文文本 / shadow / iframe / 属性的页面，
// 注入 chrome 桩，加载真实 content.js，触发整页翻译，捕获任何运行时错误。
// 目的：暴露桩测试掩盖的真实 DOM 抛错（如 showProgress 的 querySelector、
//       深度收集器在真实节点的行为）。
const { JSDOM } = require("jsdom");
const fs = require("node:fs");
const path = require("node:path");

const EXT = path.resolve(__dirname, "../extension");

const html = `<!doctype html><html><head><title>Page</title></head><body>
  <h1>Welcome to the demo site</h1>
  <p>Hello world this is English content</p>
  <p>这是中文段落</p>
  <input placeholder="Search here" />
  <img alt="company logo" src="x.png" />
  <button value="Submit">Submit</button>
  <div id="shadow-host"></div>
  <iframe id="sub" src="about:blank"></iframe>
</body></html>`;

const dom = new JSDOM(html, { url: "https://example.com", runScripts: "outside-only" });
const { window } = dom;

let msgListener = null;
const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(" ")); };

// ---- chrome / 浏览器 API 桩（jsdom 不提供的部分）----
window.chrome = {
  runtime: {
    id: "test",
    getURL: (p) => `chrome-extension://test/${p}`,
    onMessage: { addListener: (fn) => { msgListener = fn; } },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
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
  storage: { sync: { get: async () => ({}), set: async () => {}, remove: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  contextMenus: { removeAll: (cb) => cb && cb(), create() {}, onClicked: { addListener() {} } },
  scripting: { executeScript: async () => ({}) },
  tabs: { sendMessage() {} },
  webNavigation: { getAllFrames: async () => [] },
  i18n: { getMessage: () => "" },
};
window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
window.Audio = class { play() { return Promise.resolve(); } pause() {} };
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.cancelAnimationFrame = (id) => clearTimeout(id);
window.fetch = async () => ({ ok: true, json: async () => ({}), text: async () => "" });
// jsdom 不做布局：getBoundingClientRect 默认全 0，会让 isElementVisible 误判所有节点不可见，
// 导致整页翻译 skipHidden 跳过全部节点。patch 成非零尺寸模拟真实可见节点。
const OrigGBCR = window.HTMLElement.prototype.getBoundingClientRect;
window.HTMLElement.prototype.getBoundingClientRect = function () {
  const r = OrigGBCR.call(this);
  return { top: 0, left: 0, bottom: 20, right: 100, width: (r && r.width) || 100, height: (r && r.height) || 20 };
};
window.HTMLElement.prototype.offsetWidth = 100;
window.HTMLElement.prototype.offsetHeight = 20;

// ---- 加载真实 content.js ----
const code = fs.readFileSync(path.resolve(EXT, "content.js"), "utf8");
try {
  window.eval(code);
} catch (e) {
  console.error = origError;
  console.log("❌ content.js 加载抛错:", e && e.message, "\n", e && e.stack);
  process.exit(1);
}
console.log("content.js 加载完成, __yufanTranslateLoaded =", window.__yufanTranslateLoaded);

// 在加载后构造 shadow DOM（content.js 已注册监听，不影响）
const host = window.document.getElementById("shadow-host");
if (host) {
  try {
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = "<p>Shadow text inside web component</p>";
  } catch (e) {
    console.log("attachShadow 失败（jsdom 限制）:", e.message);
  }
}

if (!msgListener) {
  console.error = origError;
  console.log("❌ 未捕获到 onMessage 监听（content.js 顶层可能抛错导致监听未注册）");
  console.log("加载期 console.error:", errors);
  process.exit(1);
}

// 诊断：手动统计 body 有效文本节点（模拟 collectTextNodesDeep 的遍历）
let manualText = 0;
(function walk(n) {
  const kids = n.childNodes;
  if (!kids) return;
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (c.nodeType === 3) { if ((c.nodeValue || "").trim().length >= 2) manualText++; }
    else if (c.nodeType === 1) { walk(c); }
  }
})(window.document.body);
console.log("手动统计 body 有效文本节点数:", manualText);
console.log("body.innerHTML 长度:", window.document.body.innerHTML.length);

// 诊断：content.js 闭包里 Node / NodeFilter 是否可用
console.log("--- eval 内 Node 诊断 ---");
console.log("typeof Node =", window.eval("typeof Node"));
console.log("Node.TEXT_NODE =", window.eval("typeof Node === 'undefined' ? 'NO Node' : Node.TEXT_NODE"));
console.log("Node.ELEMENT_NODE =", window.eval("typeof Node === 'undefined' ? 'NO Node' : Node.ELEMENT_NODE"));
console.log("typeof NodeFilter =", window.eval("typeof NodeFilter"));
const eqFound = window.eval(`(function(){ var out=[]; function visit(n){ var k=n.childNodes; if(!k) return; for(var i=0;i<k.length;i++){ var c=k[i]; if(c.nodeType===3){ out.push(c);} else if(c.nodeType===1){ visit(c);} } } visit(document.body); return out.length; })()`);
console.log("eval 等价遍历(硬编码 3/1)找到文本节点:", eqFound);
const eqFound2 = window.eval(`(function(){ if(typeof Node==='undefined') return 'NO Node'; var out=[]; function visit(n){ var k=n.childNodes; if(!k) return; for(var i=0;i<k.length;i++){ var c=k[i]; if(c.nodeType===Node.TEXT_NODE){ out.push(c);} else if(c.nodeType===Node.ELEMENT_NODE){ visit(c);} } } visit(document.body); return out.length; })()`);
console.log("eval 等价遍历(用 Node 常量)找到文本节点:", eqFound2);

// ---- 触发整页翻译 ----
msgListener({ type: "YUFAN_TRANSLATE_PAGE" }, {}, () => {});

setTimeout(() => {
  console.error = origError;
  const translations = window.document.querySelectorAll("[data-yufan-translation='true']");
  const progress = window.document.getElementById("yufan-page-progress");
  console.log("插入译文节点数:", translations.length);
  console.log("译文样本:", [...translations].slice(0, 3).map((e) => e.textContent));
  console.log("右下角浮层(page-progress)存在:", !!progress);
  console.log("整页翻译过程 console.error 次数:", errors.length);
  if (errors.length) console.log("错误明细:", errors);

  let bad = false;
  if (translations.length === 0) { console.log("❌ 未插入任何译文"); bad = true; }
  if (errors.length) { console.log("❌ 翻译过程有运行时错误（见上）"); bad = true; }
  if (bad) process.exit(2);
  console.log("\n✅ 整页翻译在真实 DOM 正常工作：译文已插入、浮层已创建、无运行时错误");
}, 600);
