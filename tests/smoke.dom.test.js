// 冒烟测试：在最小 DOM 桩里加载 content.js / popup.js，
// 确认脚本能完整求值（捕捉 TDZ、未定义变量、拼写错误这类"一加载就崩"的问题）。
// 跑法（项目根）： node tests/smoke.dom.test.js
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT = path.resolve(__dirname, "../extension");

let pass = 0;
let fail = 0;
const log = [];
function check(name, cond, detail) {
  if (cond) {
    pass++;
    log.push(`  ✓ ${name}`);
  } else {
    fail++;
    log.push(`  ✗ ${name}${detail ? "  ->  " + detail : ""}`);
  }
}

// ---------- 最小 DOM 桩 ----------
function makeElement(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    nodeType: 1,
    style: {},
    dataset: {},
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else { on ? this._s.add(c) : this._s.delete(c); } },
      contains(c) { return this._s.has(c); },
    },
    children: [],
    childNodes: [],
    attributes: {},
    innerHTML: "",
    textContent: "",
    value: "",
    hidden: false,
    disabled: false,
    offsetWidth: 100,
    offsetHeight: 100,
    firstChild: null,
    parentElement: null,
    appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
    insertBefore(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    remove() {},
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
    removeAttribute(k) { delete this.attributes[k]; },
    hasAttribute(k) { return k in this.attributes; },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    querySelector() { return makeElement("div"); },
    querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect() { return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }; },
    scrollIntoView() {},
    focus() {},
    normalize() {},
    after() {},
    get lastChild() { return this.children[this.children.length - 1] || null; },
  };
  return el;
}

function makeDocument() {
  const doc = {
    nodeType: 9,
    body: makeElement("body"),
    head: makeElement("head"),
    documentElement: Object.assign(makeElement("html"), { clientWidth: 1200, clientHeight: 800 }),
    _listeners: {},
    createElement: (t) => makeElement(t),
    createTreeWalker() {
      return { nextNode: () => null, currentNode: null };
    },
    // 真实浏览器里这些元素由 options.html / popup.html 提供，
    // 桩里必须返回元素对象而不是 null，否则 options.js 一求值就崩。
    getElementById(id) {
      this._byId = this._byId || {};
      if (!this._byId[id]) this._byId[id] = makeElement("div");
      return this._byId[id];
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    removeEventListener() {},
  };
  doc.documentElement.style = {};
  return doc;
}

function buildSandbox() {
  const doc = makeDocument();
  const listeners = { chrome: [], dom: {}, window: {} };
  const win = {
    __yufanTranslateLoaded: false,
    innerWidth: 1200,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    getSelection: () => ({ toString: () => "", rangeCount: 0, getRangeAt: () => ({ getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 }) }) }),
    addEventListener(type, fn) { (listeners.window[type] = listeners.window[type] || []).push(fn); },
    removeEventListener() {},
    getComputedStyle: () => ({}),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  const sandbox = {
    window: win,
    document: doc,
    chrome: {
      runtime: {
        id: "smoke",
        getURL: (p) => `chrome-extension://smoke/${p}`,
        getManifest: () => ({ version: "2.3.0" }),
        onMessage: { addListener: (fn) => listeners.chrome.push(fn) },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
        sendMessage: () => Promise.resolve({ ok: true, data: { results: [] } }),
        reload() {},
        lastError: null,
        openOptionsPage() {},
      },
      storage: {
        sync: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
        local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
        session: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      },
      contextMenus: { removeAll: (cb) => cb && cb(), create() {}, onClicked: { addListener() {} } },
      scripting: { executeScript: () => Promise.resolve() },
      tabs: { sendMessage() {} },
      webNavigation: { getAllFrames: () => Promise.resolve([]) },
      i18n: { getMessage: () => "" },
    },
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    getComputedStyle: () => ({}),
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    IntersectionObserver: class { constructor() {} observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { constructor() {} observe() {} disconnect() {} },
    AbortController,
    AbortSignal,
    URL,
    URLSearchParams,
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve("") }),
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    Audio: class { play() { return Promise.resolve(); } },
    location: { href: "https://example.com" },
    alert() {},
    Promise,
    JSON,
    Math,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Date,
    Buffer,
    Intl,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  return { sandbox, doc, win, listeners };
}

function loadScript(file, extraSetup) {
  const { sandbox } = buildSandbox();
  if (extraSetup) extraSetup(sandbox);
  const code = fs.readFileSync(path.resolve(EXT, file), "utf8");
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: file });
  return sandbox;
}

// ---------- 测试 ----------
log.push("content.js 加载");
try {
  const sb = loadScript("content.js");
  check("content.js 完整求值无异常", true);
  check("设置了防重复注入标记", sb.window.__yufanTranslateLoaded === true);
} catch (e) {
  check("content.js 完整求值无异常", false, e.message);
}

log.push("\npopup.js 加载");
try {
  const sb = loadScript("popup.js");
  check("popup.js 完整求值无异常", true);
} catch (e) {
  check("popup.js 完整求值无异常", false, e.message);
}

log.push("\noptions.js 加载");
try {
  const sb = loadScript("options.js");
  check("options.js 完整求值无异常", true);
  // 版本号必须来自 manifest（chrome.runtime.getManifest().version），不再硬编码。
  // 桩里 getManifest 返回 "2.1.0"，options.js 会拼成 "v2.1.0" 写入 headerVersion。
  const hv = sb.document.getElementById("headerVersion");
  const av = sb.document.getElementById("aboutVersion");
  check(
    "options.js 版本号取自 manifest（headerVersion=v2.3.0）",
    hv && hv.textContent === "v2.3.0",
    hv && hv.textContent
  );
  check(
    "options.js 关于区版本号同步（aboutVersion=v2.3.0）",
    av && av.textContent === "v2.3.0",
    av && av.textContent
  );
} catch (e) {
  check("options.js 完整求值无异常", false, e.message);
}

log.push("\nmanifest.json 校验");
try {
  const mf = JSON.parse(fs.readFileSync(path.resolve(EXT, "manifest.json"), "utf8"));
  check("manifest 是合法 JSON", true);
  check("background 指向 background.js", mf.background && mf.background.service_worker === "background.js");
  const files = ["background.js", "content.js", "popup.js", "options.js", "popup.html", "options.html", "manifest.json"];
  const missing = files.filter((f) => !fs.existsSync(path.resolve(EXT, f)));
  check("manifest 依赖的文件都存在", missing.length === 0, missing.join(", "));
  // web_accessible_resources 里的图标必须真实存在，否则 getURL 返回坏链
  const iconDir = path.resolve(EXT, "icons");
  const neededIcons = ["icon16.png", "icon32.png", "icon48.png", "icon128.png", "logo.svg"];
  const missingIcons = neededIcons.filter((f) => !fs.existsSync(path.join(iconDir, f)));
  check("图标资源齐全", missingIcons.length === 0, missingIcons.join(", "));
  // content.css 必须在 WAR 中：胶囊 Shadow DOM 用 <link href=getURL("content.css")> 加载样式，
  // 不在 WAR 里会被 Chrome 拒绝（Denying load of chrome-extension://...），表现为胶囊完全无样式。
  // use_dynamic_url 必须禁用：它会把静态 chrome-extension:// URL 全部封死（实测 logo.svg/icon48.png
  // 均 LOAD_FAIL），而 content.js 恰恰依赖 getURL() 的静态 URL 注入 <img>/<link>，两者不兼容。
  const war = mf.web_accessible_resources && mf.web_accessible_resources[0];
  check("web_accessible_resources 含 content.css（Shadow DOM 样式加载前提）",
    !!(war && Array.isArray(war.resources) && war.resources.includes("content.css")));
  check("web_accessible_resources 禁用 use_dynamic_url（会封死 getURL 静态资源）",
    !!(war && war.use_dynamic_url !== true));
  // 显式声明最低 Chrome 版本（MV3 基线），便于商店合规与能力断言
  check("manifest 声明 minimum_chrome_version", !!mf.minimum_chrome_version, String(mf.minimum_chrome_version));
  check("Bing 词典域名纳入 host_permissions（零鉴权抓取不被误判越权）",
    Array.isArray(mf.host_permissions) && mf.host_permissions.some((h) => h.includes("cn.bing.com")));
} catch (e) {
  check("manifest 是合法 JSON", false, e.message);
}

log.push("\n产物一致性");
const rootZip = path.resolve(__dirname, "../extension.zip");
const pubZip = path.resolve(__dirname, "../public/extension.zip");
check("extension.zip 存在", fs.existsSync(rootZip));
check("public/extension.zip 存在", fs.existsSync(pubZip));
if (fs.existsSync(pubZip)) {
  // zip 内容经过 deflate 压缩，不能在原始字节里搜字符串，
  // 必须真正解出来再比对。
  const { execFileSync } = require("node:child_process");
  const listing = execFileSync("unzip", ["-Z1", pubZip], { encoding: "utf8" });
  check(
    "不含 background-bac.js（已剔除含密钥的死代码）",
    !listing.split("\n").includes("background-bac.js"),
    listing
  );
  check("不含 .DS_Store", !listing.split("\n").some((l) => l.includes(".DS_Store")));
  const packedBg = execFileSync("unzip", ["-p", pubZip, "background.js"], { encoding: "utf8" });
  check("zip 内的 background.js 含批量翻译接口", packedBg.includes("YUFAN_TRANSLATE_BATCH"));
  check("zip 内的 background.js 含多 entry 合并", packedBg.includes("mergeMeanings"));
  check("zip 内的 background.js 含打开链接消息", packedBg.includes("YUFAN_OPEN_URL"));
  const packedContent = execFileSync("unzip", ["-p", pubZip, "content.js"], { encoding: "utf8" });
  check("zip 内的 content.js 走批量通道", packedContent.includes("YUFAN_TRANSLATE_BATCH"));
  check("zip 内的 content.js 含页面语言检测", packedContent.includes("resolvePageTarget"));
  check("zip 内的 content.js 含搜索按钮", packedContent.includes("${NAMESPACE}-pill-search"));
  check("zip 内的 content.js 含复制按钮", packedContent.includes("${NAMESPACE}-pill-copy"));
  check("zip 内的 content.js 含打开链接按钮", packedContent.includes("${NAMESPACE}-pill-open"));
  // 动态内容翻译修复（title/popover/tooltip）
  check("zip 内的 content.js 含旧译文清理函数", packedContent.includes("cleanupNodeTranslation"));
  check("zip 内的 content.js 含属性重译判定", packedContent.includes("needsRetranslateAttr"));
  check("zip 内的 content.js 含属性标记清除", packedContent.includes("clearAttrTranslationMark"));
  check("zip 内的 content.js 含译文值备份属性", packedContent.includes("ATTR_TRANSLATED_VAL_PREFIX"));
  check("zip 内的 content.js attributeFilter 含 value", packedContent.includes('"value"') && (packedContent.match(/attributeFilter/g) || []).length >= 2);
  check("zip 内的 content.js 深度遍历递归子元素（walkElementsDeep 修复）", packedContent.includes("stack.push(child)"));
  check("zip 内的 content.js 含 notranslate 尊重逻辑", packedContent.includes("isNoTranslate"));
  check("zip 内的 content.js 含 SVG title 管线", packedContent.includes("translateSvgTitleBatch") && packedContent.includes("isSvgTitleElement"));
  check("zip 内的 content.js 含 shadow 直挂文本回退", packedContent.includes("effectiveParent"));
  check("zip 内的 content.js 含失败重试计数", packedContent.includes("nodeFailCounts"));
  check("zip 内的 content.js 含补扫调度器", packedContent.includes("startRescan"));
  check("zip 内的 content.js 含统一属性过滤器", packedContent.includes("MUTATION_ATTR_FILTER"));
  check("zip 内的 content.js 支持 data-* tooltip 属性", packedContent.includes('"data-original-title"') && packedContent.includes('"data-tip"'));
  // 补扫收敛 + 内存清理（长开页面不再每 10s 永久全页遍历、不再泄漏已删节点）
  check("zip 内的 content.js 含补扫收敛阈值 RESCAN_MAX_IDLE", packedContent.includes("RESCAN_MAX_IDLE"));
  check("zip 内的 content.js 含已删节点清理 pruneDetachedNodes", packedContent.includes("pruneDetachedNodes"));
  check("zip 内的 content.js 仅观察非自身 UI 节点（不把译文 <font> 挂进 IO）", packedContent.includes("if (isOwnUI(el)) return;") && packedContent.includes("if (pageObserver && !isOwnUI(node))"));
  const packedOptionsHtml = execFileSync("unzip", ["-p", pubZip, "options.html"], { encoding: "utf8" });
  check("zip 内的 options.html 含搜索开关", packedOptionsHtml.includes("searchEnabled"));
  check("zip 内的 options.html 含复制开关", packedOptionsHtml.includes("copyEnabled"));
  check("zip 内的 options.html 含搜索引擎选择", packedOptionsHtml.includes("searchEngine"));
  check("zip 内的 options.html 含自动跳转开关", packedOptionsHtml.includes("searchAutoJump"));
  check("zip 内的 options.html 含打开链接开关", packedOptionsHtml.includes("openLinkEnabled"));
  const packedPopup = execFileSync("unzip", ["-p", pubZip, "popup.js"], { encoding: "utf8" });
  // 消息协议必须 background↔popup 同步：从源 background.js 动态读出 MSG_PROTOCOL，
  // 再验证 zip 里的 popup.js 含同一个协议串。
  // 旧断言比对的是"迭代号"（v2026-xx-xx.n），那种数字每次发版都要手工同步两处，
  // 漏改就会导致 popup 打开即 reload；改成协议版本后常态下永不触发 reload。
  const srcBgProto = fs.readFileSync(path.resolve(__dirname, "../extension/background.js"), "utf8")
    .match(/MSG_PROTOCOL\s*=\s*"([^"]+)"/);
  const curProto = srcBgProto ? srcBgProto[1] : "";
  check("从源 background.js 读到消息协议版本", !!curProto, curProto);
  check(
    "zip 内的 popup.js 协议版本与 background 一致",
    !!curProto && packedPopup.includes(curProto) && packedBg.includes(curProto),
    `proto=${curProto} popupHas=${packedPopup.includes(curProto)} bgHas=${packedBg.includes(curProto)}`
  );
  check(
    "popup 只在协议不匹配时 reload（不再比对迭代号）",
    !packedPopup.includes('expected = "v') && packedPopup.includes("expectedProtocol"),
    packedPopup.match(/const expected\w*\s*=\s*"[^"]*"/)?.[0] || "未找到协议常量"
  );
  check("zip 内的 background.js 含整页翻译广播（YUFAN_TRANSLATE_PAGE）", execFileSync("unzip", ["-p", pubZip, "background.js"], { encoding: "utf8" }).includes("YUFAN_TRANSLATE_PAGE"));
  const packedPopupHtml = execFileSync("unzip", ["-p", pubZip, "popup.html"], { encoding: "utf8" });
  check("zip 内的 popup.html 不含整页翻译按钮（整页翻译走右键菜单，不在弹窗加按钮）", !packedPopupHtml.includes("translatePage"));
  const packedBgMenu = execFileSync("unzip", ["-p", pubZip, "background.js"], { encoding: "utf8" });
  check("zip 内的 background.js 含右键菜单注册", packedBgMenu.includes("yufan-translate-page"));
  // popup 把配额剩余信息展示给用户（额度快用完时提前提示，而非撞上 429 才说）
  check(
    "popup 渲染 MyMemory 配额剩余（charsLeft/charsLimit）",
    packedPopup.includes("YUFAN_QUOTA_STATUS") && packedPopup.includes("charsLeft") && packedPopup.includes("toLocaleString"),
    "popup 未接入配额剩余展示"
  );
}

console.log(log.join("\n"));
console.log(`\n${fail === 0 ? "✅" : "❌"} 通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
