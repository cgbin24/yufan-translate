// 动态内容翻译测试（真实 DOM via jsdom）：
//   1) 直接添加的文本节点（textContent / createTextNode+appendChild）被翻译
//      —— 旧 childList handler 只处理 ELEMENT_NODE，纯文本节点被跳过
//   2) 已翻译的文本节点内容被外部修改后重新翻译（复用的弹窗/tooltip 场景）
//      —— 旧 characterData handler 跳过 translatedNodes 里的节点
//   3) 已翻译的属性被外部覆盖后重新翻译（placeholder / value）
//      —— 旧 handler 无 needsRetranslateAttr，外部覆盖的属性不重译
//   4) value 属性纳入 attributeFilter（动态 button value 变化被捕获）
//   5) INPUT 的 title 属性被翻译 —— 旧版祖先链把 INPUT 自身算进去导致漏翻
//   6) SVG <title> 被翻译且不用 font 包裹 —— 图标原生 tooltip 专用管线
//   7) data-original-title（Bootstrap tooltip）被翻译
//   8) notranslate / translate="no" 标记被尊重
//   9) API 失败后节点可被补扫重试 —— 旧版失败节点永久标记为已翻译
//  10) Shadow DOM 穿透翻译 + 恢复原文穿透 shadow
// 运行：NODE_PATH=/Users/cgbin24/.workbuddy/binaries/node/workspace/node_modules \
//      node tests/content.dynamic.test.js
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

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

// ---------- jsdom 环境 ----------
const html = `<!DOCTYPE html><html><body>
  <p id="plain">Hello world this is visible text</p>
  <div id="tooltip-host"><span id="tip-text">First tooltip message</span></div>
  <input id="search-input" type="text" placeholder="Search here please">
  <input id="submit-btn" type="submit" value="Submit form">
  <input id="name-input" type="text" title="Enter your full name here">
  <svg id="icon-svg" xmlns="http://www.w3.org/2000/svg"><title>Delete this item now</title></svg>
  <button id="bs-btn" data-original-title="Bootstrap tooltip message">Hover over button</button>
  <div id="nt-holder" class="notranslate">This must stay untranslated always</div>
  <div id="nt2-holder" translate="no">Also stays untranslated text</div>
  <div id="empty-holder"></div>
  <nav id="nav-links">
    <a href="/docs" id="link-docs">Documentation</a>
    <a href="/api" id="link-api"><span>Nested link label text</span></a>
    <a href="/home" id="link-icon" aria-label="Go to homepage screen"></a>
  </nav>
  <select id="lang-select">
    <option value="en" label="English language option"></option>
    <option value="zh">Chinese language option</option>
  </select>
  <button id="btn-value" value="Send message now">Visible button text</button>
  <div id="slider" role="slider" aria-valuetext="Medium priority level" aria-roledescription="Priority selector"></div>
  <svg id="chart-svg" xmlns="http://www.w3.org/2000/svg">
    <text id="chart-axis" x="10" y="20">Total revenue</text>
    <text id="chart-tspan-parent" x="10" y="40"><tspan id="chart-tspan">Net profit</tspan></text>
    <text id="chart-num" x="10" y="60">42</text>
  </svg>
</body></html>`;

const dom = new JSDOM(html, { url: "https://example.com", pretendToBeVisual: true });
const { window } = dom;
const { document } = window;

// jsdom 不布局，getBoundingClientRect 全 0，mock 成非 0 让可见性判断生效
// （SVGElement 不继承 HTMLElement，需要单独 mock，否则 svg 内的 title 被
//  可见性检查跳过）
try {
  const rectMock = function () {
    const cs = window.getComputedStyle(this);
    const hidden = cs.display === "none";
    return {
      top: 0, left: 0, bottom: 20, right: 200,
      width: hidden ? 0 : 200, height: hidden ? 0 : 20, x: 0, y: 0,
    };
  };
  Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", {
    value: rectMock, configurable: true, writable: true,
  });
  if (window.SVGElement) {
    Object.defineProperty(window.SVGElement.prototype, "getBoundingClientRect", {
      value: rectMock, configurable: true, writable: true,
    });
  }
} catch (_) {}

// Mock IntersectionObserver：可见元素 observe 时触发 isIntersecting=true
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

// ---------- Shadow DOM 穿透查询 ----------
// 2.3.x 起 UI（整页翻译进度胶囊/提示气泡等）挂在 #yufan-ui-root 的 shadow root 里，
// document.querySelector 找不到 —— 必须经 shadowRoot 查询。
const uiShadow = () => {
  const c = document.getElementById("yufan-ui-root");
  return (c && c.shadowRoot) || null;
};
const qProgress = () => {
  const sr = uiShadow();
  return sr ? (sr.getElementById ? sr.getElementById("yufan-page-progress") : sr.querySelector("#yufan-page-progress")) : null;
};
const qTip = () => {
  const sr = uiShadow();
  return sr ? sr.querySelector(".yufan-pill-tip") : null;
};

// Mock chrome.runtime.sendMessage：返回 "译:" + 原文，方便断言。
// failTexts 里的文本返回失败（模拟 API 瞬时故障），用于测试失败重试机制。
const captured = [];
const failTexts = new Set();
// quotaMode=true 时批次一律返回"配额耗尽 + retryAfterMin"，
// 用于测试错误提示走胶囊 tooltip 与自动续翻文案
let quotaMode = false;
// 配额模式下批次消息计数：用于断言熔断后进入静默暂停期（不再发消息）
let quotaBatchCalls = 0;
// rateMode=true 时批次一律返回"频率限流"（rateLimited=true，quotaExhausted=false）：
// 整页翻译绝不能因此熔断
let rateMode = false;
let msgListeners = [];
const chrome = {
  runtime: {
    id: "test",
    getURL: (p) => `chrome-extension://test/${p}`,
    onMessage: { addListener: (fn) => msgListeners.push(fn) },
    onInstalled: { addListener() {} }, onStartup: { addListener() {} },
    sendMessage: async (msg) => {
      if (msg.type === "YUFAN_DETECT") return { ok: true, data: { code: "en", confident: true } };
      if (msg.type === "YUFAN_TRANSLATE_BATCH") {
        const texts = (msg.payload && msg.payload.texts) || [];
        const target = msg.payload && msg.payload.target;
        if (quotaMode) {
          quotaBatchCalls += 1;
          return {
            ok: true,
            data: {
              results: texts.map(() => ""),
              target,
              error: "MyMemory 今日免费翻译额度已用完（59 分钟后重置）。请稍后再试",
              quotaExhausted: true,
              retryAfterMin: 59,
            },
          };
        }
        if (rateMode) {
          return {
            ok: true,
            data: {
              results: texts.map(() => ""),
              target,
              error: "翻译请求过于频繁，已自动降速，稍后自动重试剩余内容",
              quotaExhausted: false,
              rateLimited: true,
              retryAfterMin: 0,
            },
          };
        }
        if (texts.some((t) => failTexts.has(t))) {
          return { ok: false, error: "mock transient failure" };
        }
        captured.push(...texts);
        return { ok: true, data: { results: texts.map((t) => "\u8bd1:" + t), target } };
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
  // content.js 的分片 walker（collectTextNodesDeepAsync）用裸 performance.now()
  // 做时间切片 —— Chrome 内容脚本里解析到 window.performance，沙箱须显式注入
  performance: window.performance,
  URL, URLSearchParams, AbortController, AbortSignal,
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve("") }),
  console: { log: () => {}, warn: () => {}, error: (...a) => console.error("[content-error]", ...a) },
  Promise, JSON, Math, Map, Set, Array, Object, String, Number, Boolean, RegExp, Error, Date, Intl, Buffer,
};
sandbox.globalThis = sandbox; sandbox.self = sandbox;
window.__yufanTranslateLoaded = false;

const code = fs.readFileSync(path.resolve(EXT, "content.js"), "utf8");
vm.createContext(sandbox);
try { vm.runInContext(code, sandbox, { filename: "content.js" }); }
catch (e) { console.error("✗ content.js 加载抛错:", e.stack); process.exit(1); }

const onMsg = msgListeners.find((f) => typeof f === "function");
if (!onMsg) { console.error("✗ 未捕获 onMessage"); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 查找某根下所有译文节点的文本
const translationsIn = (root) => {
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (n.nodeType === 1 && n.getAttribute && n.getAttribute("data-yufan-translation") === "true") out.push(n.textContent);
    const kids = n.childNodes || [];
    for (const c of kids) walk(c);
  })(root);
  return out;
};

// 查找 data 属性
const NAMESPACE = "yufan";
const ATTR_BACKUP = `data-${NAMESPACE}-attr-`;
const ATTR_VAL = `data-${NAMESPACE}-attr-val-`;
const ATTR_MARK = `data-${NAMESPACE}-attr-translated`;

(async () => {
  // ========== 触发整页翻译 ==========
  onMsg({ type: "YUFAN_TRANSLATE_PAGE" }, {}, () => {});
  await sleep(600);

  // ---------- 测试 1：直接添加的文本节点（textContent）被翻译 ----------
  log.push("测试 1：直接添加的文本节点（textContent）被翻译");
  {
    const holder = document.getElementById("empty-holder");
    // 用 textContent 设置纯文本：产生 TEXT_NODE 子节点
    // 旧 childList handler 只处理 ELEMENT_NODE，会跳过 TEXT_NODE
    holder.textContent = "Directly added text content";
    await sleep(400);
    const tr = translationsIn(holder);
    check("textContent 添加的文本节点被翻译", tr.length > 0, "译文数=" + tr.length);
    check("译文内容正确", tr.some((t) => t.includes("Directly added text content")), tr.join(", "));
  }

  // ---------- 测试 2：已翻译的文本节点内容被外部修改后重新翻译 ----------
  log.push("\n测试 2：已翻译节点内容被外部修改后重新翻译");
  {
    const tipHost = document.getElementById("tooltip-host");
    // 初始翻译应已完成
    const trBefore = translationsIn(tipHost);
    check("初始翻译已存在", trBefore.length > 0, "译文数=" + trBefore.length);

    // 找到被 <font> 包裹的原文文本节点
    const originalFont = tipHost.querySelector(`font.${NAMESPACE}-page-original`);
    check("原文 font 包裹器存在", !!originalFont);
    const textNode = originalFont && originalFont.firstChild;
    check("文本节点存在", !!(textNode && textNode.nodeType === window.Node.TEXT_NODE));

    if (textNode) {
      // 模拟复用弹窗：直接修改 nodeValue（触发 characterData）
      textNode.nodeValue = "Second tooltip message updated";
      await sleep(500); // 等 characterData 处理 + 清理旧译文 + 150ms 节流 + 重译

      // 旧译文应被清理，新译文应出现
      const trAfter = translationsIn(tipHost);
      check("重新翻译后仍有译文", trAfter.length > 0, "译文数=" + trAfter.length);
      check("新译文包含更新后的内容", trAfter.some((t) => t.includes("Second tooltip message updated")), trAfter.join(", "));
      // 旧译文不应残留
      check("旧译文已被清理", !trAfter.some((t) => t.includes("First tooltip message")), "旧译文残留");
    }
  }

  // ---------- 测试 3：已翻译属性被外部覆盖后重新翻译（placeholder）----------
  log.push("\n测试 3：已翻译属性被外部覆盖后重新翻译（placeholder）");
  {
    const input = document.getElementById("search-input");
    const placeholderAfterInit = input.getAttribute("placeholder");
    check("初始 placeholder 已翻译", !!placeholderAfterInit && placeholderAfterInit.startsWith("\u8bd1:"), placeholderAfterInit);
    check("备份原文存在", input.hasAttribute(ATTR_BACKUP + "placeholder"));
    check("译文值已存储", input.hasAttribute(ATTR_VAL + "placeholder"));

    // 模拟外部覆盖
    input.setAttribute("placeholder", "New search query text here");
    await sleep(400); // 等 attribute mutation + 重译

    const placeholderAfterOverwrite = input.getAttribute("placeholder");
    check("覆盖后 placeholder 被重新翻译", !!placeholderAfterOverwrite && placeholderAfterOverwrite.startsWith("\u8bd1:"), placeholderAfterOverwrite);
    check("重译内容正确", !!placeholderAfterOverwrite && placeholderAfterOverwrite.includes("New search query text here"), placeholderAfterOverwrite);
  }

  // ---------- 测试 4：value 属性纳入 attributeFilter（动态 button value 变化）----------
  log.push("\n测试 4：value 属性动态变化被捕获并重译");
  {
    const btn = document.getElementById("submit-btn");
    const valAfterInit = btn.getAttribute("value");
    check("初始 value 已翻译", !!valAfterInit && valAfterInit.startsWith("\u8bd1:"), valAfterInit);

    // 动态修改 value（需 attributeFilter 含 "value" 才能被观察到）
    btn.setAttribute("value", "Send form now");
    await sleep(400);

    const valAfterChange = btn.getAttribute("value");
    check("value 变化后被重新翻译", !!valAfterChange && valAfterChange.startsWith("\u8bd1:"), valAfterChange);
    check("重译 value 内容正确", !!valAfterChange && valAfterChange.includes("Send form now"), valAfterChange);
  }

  // ---------- 测试 5：INPUT 的 title 属性被翻译（表单控件原生 tooltip）----------
  log.push("\n测试 5：INPUT 的 title 属性被翻译");
  {
    const input = document.getElementById("name-input");
    const title = input.getAttribute("title");
    // 旧版 shouldTranslateTitle 祖先链从 el 自身开始，INPUT 在 SKIP_TAGS 里
    // 导致表单控件的 tooltip 永远翻不到
    check("INPUT title 已翻译为对比格式", !!title && title.includes(" ｜ ") && title.includes("\u8bd1:"), title);
    check("INPUT title 保留原文", !!title && title.startsWith("Enter your full name here"), title);
  }

  // ---------- 测试 6：SVG <title> 被翻译（图标原生 tooltip）----------
  log.push("\n测试 6：SVG <title> 被翻译");
  {
    const svgTitle = document.querySelector("#icon-svg title");
    check("SVG title 元素存在", !!svgTitle);
    if (svgTitle) {
      const text = svgTitle.textContent;
      check("SVG title 已翻译为对比格式", !!text && text.includes(" ｜ ") && text.includes("\u8bd1:"), text);
      check("SVG title 保留原文", !!text && text.startsWith("Delete this item now"), text);
      check("SVG title 无 font 包裹（不破坏原生 tooltip）", svgTitle.querySelectorAll("font").length === 0);
    }
  }

  // ---------- 测试 7：data-original-title（Bootstrap tooltip 属性）被翻译 ----------
  log.push("\n测试 7：data-original-title 被翻译");
  {
    const btn = document.getElementById("bs-btn");
    const val = btn.getAttribute("data-original-title");
    check("data-original-title 已翻译", !!val && val.startsWith("\u8bd1:"), val);
    check("备份原文存在", btn.hasAttribute(ATTR_BACKUP + "data-original-title"));
  }

  // ---------- 测试 8：notranslate / translate=no 不被翻译 ----------
  log.push("\n测试 8：notranslate 标记被尊重");
  {
    const nt1 = document.getElementById("nt-holder");
    const nt2 = document.getElementById("nt2-holder");
    const tr1 = translationsIn(nt1);
    const tr2 = translationsIn(nt2);
    check("class=notranslate 的文本未被翻译", tr1.length === 0, "译文数=" + tr1.length);
    check("translate=no 的文本未被翻译", tr2.length === 0, "译文数=" + tr2.length);
    check("notranslate 原文保持不变", (nt1.textContent || "").includes("This must stay untranslated always"));
  }

  // ---------- 测试 9：API 失败后节点可被重试（不再永久标记为已翻译）----------
  log.push("\n测试 9：API 失败后补扫重试");
  {
    const holder = document.createElement("div");
    holder.id = "fail-holder";
    document.body.appendChild(holder);
    const failText = "Transient failure recovery text";
    holder.textContent = failText;
    // 模拟 API 瞬时故障
    failTexts.add(failText);
    await sleep(300); // 等 mutation handler 尝试翻译并失败
    check("失败时尚未插入译文", translationsIn(holder).length === 0, "译文数=" + translationsIn(holder).length);
    // 故障恢复：补扫调度器（1s/2s/4s/8s 退避）应重试该节点
    // 旧代码失败后节点永久留在 translatedNodes 里，恢复后也不会重试
    failTexts.delete(failText);
    await sleep(1800);
    const tr = translationsIn(holder);
    check("API 恢复后补扫重试成功", tr.length > 0, "译文数=" + tr.length);
    check("重试译文内容正确", tr.some((t) => t.includes(failText)), tr.join(", "));
  }

  // ---------- 测试 9b：隐藏内容显示后必须被翻译（IO 兜底）----------
  // 回归背景：IntersectionObserver 回调把收集结果存在回调内的局部变量里，
  // 节流 timer 一旦在跑，这一轮 entry 收集到的内容就被直接丢弃 —— 连续
  // 滚动/快速展开时绝大多数 entry 落在节流窗口内，表现为"动态加载的内容
  // 滚出来后一片未翻译"。这里在同一节流窗口内连打两次回调做验证。
  log.push("\n测试 9b：隐藏内容显示后由 IntersectionObserver 兜底翻译");
  {
    const io = MockIO.instance;
    const mk = (text) => {
      const el = document.createElement("div");
      el.style.display = "none"; // 初始隐藏：不应被立即翻译
      el.textContent = text;
      document.body.appendChild(el);
      return el;
    };
    const h1 = mk("Hidden block number one content");
    const h2 = mk("Hidden block number two content");
    await sleep(400);
    check(
      "隐藏内容首轮不翻译（留给 IO 兜底）",
      translationsIn(h1).length + translationsIn(h2).length === 0,
      `h1=${translationsIn(h1).length} h2=${translationsIn(h2).length}`
    );
    // 显示出来，并在同一个节流窗口内连打两次 IO 回调
    h1.style.display = "block";
    h2.style.display = "block";
    io.trigger(h1, true);
    io.trigger(h2, true);
    await sleep(500);
    check(
      "第一次 IO 回调的内容被翻译",
      translationsIn(h1).length > 0,
      "译文数=" + translationsIn(h1).length
    );
    check(
      "第二次 IO 回调的内容也被翻译（节流窗口内不丢弃）",
      translationsIn(h2).length > 0,
      "译文数=" + translationsIn(h2).length
    );
    h1.remove();
    h2.remove();
  }

  // ---------- 测试 9c：标签类内容（链接 / 下拉项 / 按钮 / aria / SVG 文字）----------
  log.push("\n测试 9c：标签类内容被识别翻译");
  {
    // 超链接：纯文本链接与嵌套 span 的链接
    const linkDocs = document.getElementById("link-docs");
    const linkApi = document.getElementById("link-api");
    check("超链接 <a> 文本被翻译", translationsIn(linkDocs).length > 0, "译文数=" + translationsIn(linkDocs).length);
    check(
      "超链接内嵌 <span> 的文本被翻译",
      translationsIn(linkApi).length > 0,
      "译文数=" + translationsIn(linkApi).length
    );
    const linkIcon = document.getElementById("link-icon");
    check(
      "纯图标链接的 aria-label 被翻译",
      (linkIcon.getAttribute("aria-label") || "").includes("\u8bd1:"),
      linkIcon.getAttribute("aria-label")
    );

    // 下拉项：label 属性与 option 文本
    const opt1 = document.querySelector("#lang-select option[value='en']");
    check(
      "<option label> 被翻译",
      (opt1.getAttribute("label") || "").includes("\u8bd1:"),
      opt1.getAttribute("label")
    );
    const opt2 = document.querySelector("#lang-select option[value='zh']");
    check(
      "<option> 文本被翻译",
      translationsIn(opt2).length > 0,
      "译文数=" + translationsIn(opt2).length
    );

    // 按钮 value
    const btnValue = document.getElementById("btn-value");
    check(
      "<button value> 被翻译",
      (btnValue.getAttribute("value") || "").includes("\u8bd1:"),
      btnValue.getAttribute("value")
    );

    // aria-* 无障碍标签
    const slider = document.getElementById("slider");
    check(
      "aria-valuetext 被翻译",
      (slider.getAttribute("aria-valuetext") || "").includes("\u8bd1:"),
      slider.getAttribute("aria-valuetext")
    );
    check(
      "aria-roledescription 被翻译",
      (slider.getAttribute("aria-roledescription") || "").includes("\u8bd1:"),
      slider.getAttribute("aria-roledescription")
    );

    // SVG 可见文字（图表轴标签）：必须改写 textContent，不能塞 <font>
    const axis = document.getElementById("chart-axis");
    check(
      "SVG <text> 文字被翻译（textContent 改写）",
      (axis.textContent || "").includes("\u8bd1:"),
      axis.textContent
    );
    check(
      "SVG <text> 内没有插入 <font>（不会破坏渲染）",
      axis.querySelectorAll("font").length === 0,
      "font 数=" + axis.querySelectorAll("font").length
    );
    check(
      "SVG <text> 原文已备份（可还原）",
      !!axis.getAttribute("data-yufan-svg-text-original"),
      axis.getAttribute("data-yufan-svg-text-original")
    );
    // <text> 嵌 <tspan> 时只处理叶子层，父级结构不能被拍平
    const tspan = document.getElementById("chart-tspan");
    const tspanParent = document.getElementById("chart-tspan-parent");
    check(
      "SVG <tspan> 文字被翻译",
      (tspan.textContent || "").includes("\u8bd1:"),
      tspan.textContent
    );
    check(
      "<tspan> 的父 <text> 未被拍平（子结构保留）",
      tspanParent.querySelector("tspan") !== null,
      "父级 tspan 丢失"
    );
    // 纯数字不该翻译（省配额，也没意义）
    const num = document.getElementById("chart-num");
    check("SVG 纯数字文本不翻译", num.textContent === "42", num.textContent);

    // 紧凑型标签宿主（链接/按钮…）应被打上标记，由 CSS 改为只显示译文
    check(
      "链接宿主被打上 yufan-tight-label 标记",
      linkDocs.classList.contains("yufan-tight-label"),
      linkDocs.className
    );
    check(
      "按钮宿主被打上 yufan-tight-label 标记",
      btnValue.classList.contains("yufan-tight-label"),
      btnValue.className
    );
  }

  // ---------- 测试 10：Shadow DOM 穿透翻译 + 恢复原文穿透 ----------
  log.push("\n测试 10：Shadow DOM 穿透翻译与恢复");
  {
    const host = document.createElement("div");
    host.id = "shadow-host";
    document.body.appendChild(host);
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = "<p>Shadow DOM inner text content</p>Direct shadow root text";
    await sleep(600); // 等 mutation handler 穿透 shadow 翻译 + 补扫
    const trInShadow = translationsIn(sr);
    check("shadow 内 <p> 文本被翻译", trInShadow.some((t) => t.includes("Shadow DOM inner text content")), trInShadow.join(", "));
    check("shadow 直挂根节点的文本被翻译（effectiveParent 回退 host）", trInShadow.some((t) => t.includes("Direct shadow root text")), trInShadow.join(", "));

    // ========== 触发恢复原文（第二次调用 = 取消翻译分支）==========
    onMsg({ type: "YUFAN_TRANSLATE_PAGE" }, {}, () => {});
    await sleep(200);

    // 恢复验证：shadow 内的 font 包裹器全部清除、文本还原
    const fontsAfterRestore = sr.querySelectorAll("font").length;
    check("恢复后 shadow 内无 font 残留", fontsAfterRestore === 0, "font 数=" + fontsAfterRestore);
    const srText = sr.textContent || "";
    check(
      "恢复后 shadow 内文本还原",
      srText.includes("Shadow DOM inner text content") && srText.includes("Direct shadow root text") && !srText.includes("\u8bd1:"),
      srText
    );

    // 恢复验证：SVG title 还原为纯原文
    const svgTitle = document.querySelector("#icon-svg title");
    check("恢复后 SVG title 还原", !!svgTitle && svgTitle.textContent === "Delete this item now", svgTitle && svgTitle.textContent);

    // 恢复验证：INPUT title 还原
    const input = document.getElementById("name-input");
    check("恢复后 INPUT title 还原", input.getAttribute("title") === "Enter your full name here", input.getAttribute("title"));

    // 恢复验证：data-original-title 还原
    const btn = document.getElementById("bs-btn");
    check("恢复后 data-original-title 还原", btn.getAttribute("data-original-title") === "Bootstrap tooltip message", btn.getAttribute("data-original-title"));

    // 恢复验证：主文档无 font 残留
    const bodyFonts = document.body.querySelectorAll("font.yufan-page-translation, font.yufan-page-original").length;
    check("恢复后主文档无 font 残留", bodyFonts === 0, "font 数=" + bodyFonts);

    // 恢复验证：placeholder / value 还原
    // 注意：测试 3/4 里外部覆盖后重译已更新了"最新原文"备份，
    // 恢复到的是覆盖后的值（这是正确语义：恢复页面当前内容的原文）
    const searchInput = document.getElementById("search-input");
    check("恢复后 placeholder 还原为最新原文", searchInput.getAttribute("placeholder") === "New search query text here", searchInput.getAttribute("placeholder"));
    const submitBtn = document.getElementById("submit-btn");
    check("恢复后 value 还原为最新原文", submitBtn.getAttribute("value") === "Send form now", submitBtn.getAttribute("value"));

    // 恢复验证：超链接文本还原、紧凑标签标记被摘除
    const linkDocs = document.getElementById("link-docs");
    check(
      "恢复后超链接文本还原为原文",
      linkDocs.textContent.includes("Documentation") && !linkDocs.textContent.includes("\u8bd1:"),
      linkDocs.textContent
    );
    check(
      "恢复后紧凑标签标记被移除",
      !linkDocs.classList.contains("yufan-tight-label"),
      linkDocs.className
    );
    // 恢复验证：SVG 文字还原为原文
    const chartAxis = document.getElementById("chart-axis");
    check(
      "恢复后 SVG <text> 文字还原为原文",
      chartAxis.textContent.includes("Total revenue") && !chartAxis.textContent.includes("\u8bd1:"),
      chartAxis.textContent
    );
  }

  // ---------- 附加验证：attributeFilter 统一为 MUTATION_ATTR_FILTER ----------
  log.push("\n附加验证：attributeFilter 配置");
  {
    const src = fs.readFileSync(path.resolve(EXT, "content.js"), "utf8");
    // 两个观察器（主 + shadow）都应使用统一的 MUTATION_ATTR_FILTER 常量
    const uses = (src.match(/attributeFilter:\s*MUTATION_ATTR_FILTER/g) || []).length;
    check("两个观察器都使用 MUTATION_ATTR_FILTER", uses >= 2, "次数=" + uses);
    const def = src.match(/const MUTATION_ATTR_FILTER = \[[^\]]+\]/);
    check("MUTATION_ATTR_FILTER 基于 TRANSLATE_ATTRS 展开", !!def && def[0].includes("TRANSLATE_ATTRS"), def && def[0]);
    const attrsDef = src.match(/const TRANSLATE_ATTRS = \[[^\]]+\]/);
    check(
      "TRANSLATE_ATTRS 含 data-* tooltip 属性",
      !!attrsDef && attrsDef[0].includes('"value"') && attrsDef[0].includes('"data-original-title"') && attrsDef[0].includes('"data-tip"') && attrsDef[0].includes('"data-tooltip"') && attrsDef[0].includes('"data-title"'),
      attrsDef && attrsDef[0]
    );
  }

  // ---------- 测试 11：额度耗尽提示走胶囊 tooltip + 自动续翻文案 ----------
  log.push("\n测试 11：额度提示为胶囊 tooltip（不塞进胶囊本体）");
  {
    quotaMode = true;
    // 关键：前两轮翻过的文本都在 translationCache 里，缓存命中就不会发消息、
    // 也就不会有"配额耗尽"响应。放一段全新文本逼出真实的批次请求。
    const quotaProbe = document.createElement("p");
    quotaProbe.id = "quota-probe";
    quotaProbe.textContent = "Fresh sentence to trigger quota exhaustion";
    document.body.appendChild(quotaProbe);
    onMsg({ type: "YUFAN_TRANSLATE_PAGE" }, {}, () => {});
    await sleep(500);
    const pill = qProgress();
    check("错误时胶囊浮层存在", !!pill, !!pill);
    const titleEl = pill && pill.querySelector(".yufan-progress-title");
    check(
      "胶囊标题保持品牌名（长错误文案不再塞进胶囊）",
      !!titleEl && titleEl.textContent === "语翻",
      titleEl && titleEl.textContent
    );
    check(
      "胶囊带错误角标状态类",
      !!pill && pill.classList.contains("yufan-has-error"),
      pill && pill.className
    );
    const tip = qTip();
    check(
      "完整错误文案以气泡显示在胶囊上方",
      !!tip && tip.textContent.includes("今日免费翻译额度已用完"),
      tip && tip.textContent
    );
    check(
      "气泡文案包含自动续翻承诺（服务端给了恢复时间）",
      !!tip && tip.textContent.includes("自动继续翻译剩余内容"),
      tip && tip.textContent
    );

    // 静默暂停期：熔断后补扫/观察器的重试空转（不发消息、不再触发
    // showProgress），提示气泡稳定显示，不会被"眨灯"式地反复隐藏/重现
    const callsAtBreaker = quotaBatchCalls;
    const tipTextAtBreaker = tip && tip.textContent;
    await sleep(1600); // 覆盖补扫前几轮（1s/2s）
    check(
      "熔断后进入静默暂停期（补扫重试不再发任何消息）",
      quotaBatchCalls === callsAtBreaker,
      `熔断时=${callsAtBreaker} 暂停期=${quotaBatchCalls}`
    );
    const tip2 = qTip();
    check(
      "暂停期提示气泡稳定存在（不闪烁）",
      !!tip2 && tip2.textContent === tipTextAtBreaker && tip2.classList.contains("yufan-pill-tip-show"),
      tip2 && tip2.textContent
    );
    const pill2 = qProgress();
    check(
      "暂停期错误角标保持点亮",
      !!pill2 && pill2.classList.contains("yufan-has-error"),
      pill2 && pill2.className
    );

    // 气泡自动隐藏后，悬停/点击胶囊（含感叹号角标）必须能重新唤出最后一条提示
    const tipEl = qTip();
    tipEl.classList.remove("yufan-pill-tip-show"); // 模拟自动隐藏后的状态
    pill2.dispatchEvent(new window.MouseEvent("mouseenter"));
    await sleep(30);
    check(
      "自动隐藏后悬停胶囊重新唤出提示",
      tipEl.classList.contains("yufan-pill-tip-show") && (tipEl.textContent || "").includes("额度"),
      tipEl && tipEl.className + " | " + tipEl.textContent
    );
    tipEl.classList.remove("yufan-pill-tip-show");
    pill2.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(30);
    check(
      "自动隐藏后点击胶囊重新唤出提示",
      tipEl.classList.contains("yufan-pill-tip-show") && (tipEl.textContent || "").includes("额度"),
      tipEl && tipEl.className + " | " + tipEl.textContent
    );

    // 用户取消翻译：气泡与错误态清除，续翻定时器随之取消（进程可正常退出）
    quotaMode = false;
    onMsg({ type: "YUFAN_TRANSLATE_PAGE" }, {}, () => {});
    await sleep(400);
    const tipAfter = qTip();
    check(
      "取消翻译后气泡不再显示",
      !tipAfter || !tipAfter.classList.contains("yufan-pill-tip-show"),
      tipAfter && tipAfter.className
    );
    const pillAfter = qProgress();
    check(
      "取消翻译后胶囊浮层移除",
      !pillAfter,
      !!pillAfter
    );
  }

  // ---------- 测试 12：频率限流不熔断整页（"无法翻译整页"回归锁）----------
  log.push("\n测试 12：频率限流（429）按暂时性失败处理");
  {
    rateMode = true;
    const rlProbe = document.createElement("p");
    rlProbe.id = "rate-probe";
    rlProbe.textContent = "Fresh sentence for rate limit handling";
    document.body.appendChild(rlProbe);
    onMsg({ type: "YUFAN_TRANSLATE_PAGE" }, {}, () => {});
    await sleep(500);
    const pill = qProgress();
    check("限流时胶囊浮层存在（翻译未被熔断中断）", !!pill, !!pill);
    check(
      "限流不是错误态：胶囊无红色角标",
      !!pill && !pill.classList.contains("yufan-has-error"),
      pill && pill.className
    );
    const tip = qTip();
    check(
      "限流提示告知会自动重试",
      !!tip && /自动降速|自动重试/.test(tip.textContent || ""),
      tip && tip.textContent
    );
    check(
      "限流提示不承诺自动续翻（那是额度恢复才有的语义）",
      !!tip && !(tip.textContent || "").includes("自动继续翻译剩余内容"),
      tip && tip.textContent
    );

    rateMode = false;
    onMsg({ type: "YUFAN_TRANSLATE_PAGE" }, {}, () => {});
    await sleep(400);
    const pillAfter = qProgress();
    check("取消翻译后胶囊浮层移除", !pillAfter, !!pillAfter);
  }

  console.log(log.join("\n"));
  console.log(`\n${fail === 0 ? "\u2705" : "\u274c"} 通过 ${pass} / 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
