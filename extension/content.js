/* Yufan Translate — content script
 * Adds a small floating pill button below the current text selection.
 * Clicking it opens a soft, minimal translation panel positioned smartly
 * inside the viewport.
 */
(() => {
  if (window.__yufanTranslateLoaded) return;
  window.__yufanTranslateLoaded = true;

  const PILL_ID = "yufan-translate-pill";
  const PANEL_ID = "yufan-translate-panel";
  const NAMESPACE = "yufan";
  const ROOT_ID = "yufan-ui-root";

  let shadowRoot = null;
  const getYufanShadowRoot = () => {
    if (shadowRoot) return shadowRoot;
    let container = document.getElementById(ROOT_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = ROOT_ID;
      // 确保容器本身不占用布局空间且层级最高
      container.style.cssText = "position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;border:none;margin:0;padding:0;display:block;";
      document.body.appendChild(container);
    }
    try {
      shadowRoot = container.shadowRoot || container.attachShadow({ mode: "open" });
      // 注入样式到 Shadow DOM
      const cssUrl = safeGetURL("content.css");
      if (cssUrl && !shadowRoot.querySelector(`link[href="${cssUrl}"]`)) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = cssUrl;
        shadowRoot.appendChild(link);
      }
    } catch (e) {
      // 降级处理：如果不支持 Shadow DOM，直接返回容器或 document
      console.warn("[Yufan] Shadow DOM not supported, falling back.", e);
      shadowRoot = container;
    }
    return shadowRoot;
  };

  // ---------- 扩展上下文失效防护（"Extension context invalidated"）----------
  // 扩展更新/重载后，旧标签页里的 content script 仍驻留，但其 chrome.runtime
  // 已失效：任何 getURL/sendMessage 调用都会抛错。此前 logo URL 直接写在模板
  // 里，胶囊/浮层一构建就崩（用户表现为"整页翻译坏了、提示一闪而过"）。
  // 注入时上下文一定有效——此刻把资源 URL 缓存为字符串，失效后照常渲染 UI；
  // 消息失败时给出明确的"请刷新页面"提示，而不是静默崩溃。
  const safeGetURL = (p) => {
    try {
      return chrome.runtime.getURL(p);
    } catch (_) {
      return "";
    }
  };
  const LOGO_URL = safeGetURL("icons/logo.svg");
  const isCtxInvalidError = (err) =>
    /Extension context invalidated/i.test(
      String((err && err.message) || err || "")
    );
  let ctxToastEl = null;
  const notifyCtxInvalidated = () => {
    if (ctxToastEl) return;
    ctxToastEl = document.createElement("div");
    ctxToastEl.textContent = "语翻扩展已更新，请刷新页面（F5）后再使用翻译功能";
    ctxToastEl.setAttribute("data-yufan-ctx-toast", "true");
    ctxToastEl.style.cssText =
      "position:fixed;top:16px;left:50%;transform:translateX(-50%);" +
      "z-index:2147483647;background:#1f2937;color:#ffffff;padding:10px 18px;" +
      "border-radius:8px;font-size:13px;font-family:system-ui,sans-serif;" +
      "box-shadow:0 4px 12px rgba(0,0,0,0.25);";
    getYufanShadowRoot().appendChild(ctxToastEl);
    setTimeout(() => {
      if (ctxToastEl) {
        ctxToastEl.remove();
        ctxToastEl = null;
      }
    }, 8000);
  };

  // 目标语言列表（与 popup.js 保持一致，去掉 auto）
  const TARGET_LANGS = [
    { code: "zh-CN", label: "简体中文" },
    { code: "zh-TW", label: "繁體中文" },
    { code: "en", label: "英语 English" },
    { code: "ja", label: "日语 日本語" },
    { code: "ko", label: "韩语 한국어" },
    { code: "fr", label: "法语 Français" },
    { code: "de", label: "德语 Deutsch" },
    { code: "es", label: "西班牙语 Español" },
    { code: "ru", label: "俄语 Русский" },
    { code: "it", label: "意大利语 Italiano" },
    { code: "pt", label: "葡萄牙语 Português" },
    { code: "ar", label: "阿拉伯语 العربية" },
    { code: "th", label: "泰语 ไทย" },
    { code: "vi", label: "越南语 Tiếng Việt" },
  ];

  // 判断语言代码是否为中文（含简体/繁体变体）
  const isZhCode = (code) =>
    String(code || "").toLowerCase().startsWith("zh");

  // 归一化语言代码到主语言（zh-CN/zh-TW -> zh，en-US -> en）
  const normalizeLang = (code) => {
    const c = String(code || "").toLowerCase();
    if (c.startsWith("zh")) return "zh";
    if (c.startsWith("en")) return "en";
    return c.split("-")[0] || c;
  };

  // 本地启发式：判断文本是否为中文
  // 改进：用中文字符占比（而非绝对数量比较），更可靠地处理中英混排
  const looksLikeChinese = (text) => {
    const t = String(text || "");
    const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
    const letters = (t.match(/[A-Za-z]/g) || []).length;
    const total = cjk + letters;
    if (total === 0) return false;
    // 中文字符占比超过 30% 即判定为中文（容忍少量英文单词混排）
    return cjk / total > 0.3;
  };

  // 初始目标语言选择策略：
  // 1) 中文文本 -> 默认英文（最常见的"中文 → 英文"需求）
  // 2) 非中文文本 -> 默认简体中文（"外文 → 中文"）
  // 注：只在用户**还没选过**目标语言时使用。选了之后用户偏好优先。
  const resolveInitialTarget = (text) => {
    return looksLikeChinese(text) ? "en" : "zh-CN";
  };

  const state = {
    selectedText: "",
    selectionRect: null,
    currentTarget: "zh-CN", // 当前面板使用的目标语言
  };

  // 划词胶囊扩展功能配置
  const SEARCH_ENGINES = {
    baidu: { label: "百度", url: "https://www.baidu.com/s?wd={q}" },
    google: { label: "Google", url: "https://www.google.com/search?q={q}" },
    bing: { label: "Bing", url: "https://www.bing.com/search?q={q}" },
    duckduckgo: { label: "DuckDuckGo", url: "https://duckduckgo.com/?q={q}" },
  };

  const settings = {
    searchEnabled: true,
    searchEngine: "baidu",
    openLinkEnabled: true,
    searchAutoJump: true,
    copyEnabled: true,
    selectionEnabled: true, // 划词管理：总开关，关闭则完全停用划词胶囊
    pillTempClose: true, // 临时关闭快捷键：Ctrl/Cmd + Option/Alt 一次性关闭当前胶囊
  };

  const loadSettings = async () => {
    try {
      const data = await chrome.storage.sync.get([
        "yufanSearchEnabled",
        "yufanSearchEngine",
        "yufanOpenLinkEnabled",
        "yufanSearchAutoJump",
        "yufanCopyEnabled",
        "yufanSelectionEnabled",
        "yufanPillTempCloseEnabled",
      ]);
      settings.searchEnabled = data.yufanSearchEnabled !== false;
      settings.searchEngine = SEARCH_ENGINES[data.yufanSearchEngine]
        ? data.yufanSearchEngine
        : "baidu";
      settings.openLinkEnabled = data.yufanOpenLinkEnabled !== false;
      settings.searchAutoJump = data.yufanSearchAutoJump !== false;
      settings.copyEnabled = data.yufanCopyEnabled !== false;
      settings.selectionEnabled = data.yufanSelectionEnabled !== false;
      settings.pillTempClose = data.yufanPillTempCloseEnabled !== false;
    } catch (_) {
      // 保持默认
    }
  };

  // 首次加载即读取配置；后续若用户改配置，重新读取即可
  loadSettings();

  // 监听配置变更：用户在 options 页面切换开关后，当前已打开的页面无需刷新即可生效
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      const keys = [
        "yufanSearchEnabled",
        "yufanSearchEngine",
        "yufanOpenLinkEnabled",
        "yufanSearchAutoJump",
        "yufanCopyEnabled",
        "yufanSelectionEnabled",
        "yufanPillTempCloseEnabled",
      ];
      if (keys.some((k) => changes[k])) loadSettings();
      // 即时响应：划词管理关闭时立即隐藏已显示的胶囊（loadSettings 为异步，这里同步处理）
      if (changes.yufanSelectionEnabled) {
        settings.selectionEnabled =
          changes.yufanSelectionEnabled.newValue !== false;
        if (!settings.selectionEnabled) hidePill();
      }
      if (changes.yufanPillTempCloseEnabled) {
        settings.pillTempClose =
          changes.yufanPillTempCloseEnabled.newValue !== false;
      }
    });
  } catch (_) {
    /* 非扩展环境（测试）下没有 storage.onChanged，忽略 */
  }

  // ---------- helpers ----------
  const removeEl = (id) => {
    const sr = getYufanShadowRoot();
    const el = sr.getElementById ? sr.getElementById(id) : sr.querySelector(`#${id}`);
    if (el) el.remove();
  };

  const cleanSelection = (str) => (str || "").replace(/\s+/g, " ").trim();

  // 检测文本是否为可直接打开的 http/https 链接
  const isHttpUrl = (str) => {
    const s = String(str || "").trim();
    if (!s) return false;
    // 去掉两端常见标点，避免选区把链接前后的括号/句号也带进来
    const cleaned = s.replace(/^[\s\u00A0<>"'()\[\]{}]+|[\s\u00A0<>"'()\[\]{}]+$/g, "");
    return /^https?:\/\//i.test(cleaned);
  };

  // 复制按钮：把当前选中的原文写入剪贴板（优先 navigator.clipboard，
  // 失败时降级 document.execCommand("copy") 以兼容受限的 http 页面）
  const copySelectionToClipboard = async (btn) => {
    const text = String(state.selectedText || "").trim();
    if (!text) return;
    const oldHtml = btn.innerHTML;
    const flash = () => {
      btn.innerHTML = "已复制 ✓";
      setTimeout(() => {
        btn.innerHTML = oldHtml;
      }, 1400);
    };
    try {
      await navigator.clipboard.writeText(text);
      flash();
    } catch (err) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        flash();
      } catch (_) {
        /* 降级也失败则静默 */
      }
    }
  };

  const normalizeOpenUrl = (str) => {
    return String(str || "")
      .trim()
      .replace(/^[\s\u00A0<>"'()\[\]{}]+|[\s\u00A0<>"'()\[\]{}]+$/g, "");
  };

  const buildSearchUrl = (str) => {
    const engine = SEARCH_ENGINES[settings.searchEngine] || SEARCH_ENGINES.baidu;
    return engine.url.replace("{q}", encodeURIComponent(String(str || "").trim()));
  };

  const openUrl = async (url, active = true) => {
    try {
      await chrome.runtime.sendMessage({
        type: "YUFAN_OPEN_URL",
        payload: { url, active: active !== false },
      });
    } catch (_) {
      // 降级：直接 window.open（可能被弹窗拦截）
      window.open(url, active !== false ? "_blank" : "_blank", "noopener,noreferrer");
    }
  };

  const positionBelow = (el, rect, width, height) => {
    // 统一用视窗坐标定位（panel 始终 position:fixed；pill 用 absolute 但也按视窗坐标+scroll）
    const isPanel = el.id === PANEL_ID;
    const scrollX = window.scrollX || document.documentElement.scrollLeft || 0;
    const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    let top = rect.bottom + 10; // viewport-relative
    let left = rect.left + rect.width / 2 - width / 2; // viewport-relative

    // If not enough space below, place above.
    if (top + height > vh - 8) {
      top = rect.top - height - 10;
      if (top < 8) top = Math.max(8, vh - height - 8);
    }
    // Horizontal clamp
    if (left < 8) left = 8;
    if (left + width > vw - 8) left = vw - width - 8;

    // panel 用 fixed 只需视窗坐标；pill 用 absolute 需加滚动偏移
    el.style.top = `${top + (isPanel ? 0 : scrollY)}px`;
    el.style.left = `${left + (isPanel ? 0 : scrollX)}px`;
  };

  const showPill = (rect) => {
    const selected = state.selectedText || "";
    const canSearch = settings.searchEnabled;
    const canOpen = settings.openLinkEnabled && isHttpUrl(selected);
    const canCopy = settings.copyEnabled;
    const sig =
      selected + "|" +
      (canSearch ? "S" : "") +
      (canOpen ? "O" : "") +
      (canCopy ? "C" : "");

    // 幂等：内容未变时仅重新定位，不重建 DOM，避免重复显示引起的闪烁
    const sr = getYufanShadowRoot();
    const existing = sr.getElementById ? sr.getElementById(PILL_ID) : sr.querySelector(`#${PILL_ID}`);
    if (existing && existing.dataset.shownSig === sig) {
      const { offsetWidth, offsetHeight } = existing;
      positionBelow(existing, rect, offsetWidth, offsetHeight);
      return;
    }

    removeEl(PILL_ID);
    const pill = document.createElement("div");
    pill.id = PILL_ID;
    pill.className = `${NAMESPACE}-pill`;
    pill.setAttribute("data-testid", "yufan-select-pill");
    pill.dataset.shownSig = sig;

    // 构建分段按钮：翻译 | 复制 | 搜索 | 打开
    const parts = [];
    parts.push(`
      <button type="button" class="${NAMESPACE}-pill-btn ${NAMESPACE}-pill-translate" data-action="translate" aria-label="翻译">
        <img src="${LOGO_URL}" width="16" height="16" alt="" />
        <span>翻译</span>
      </button>
    `);
    if (canCopy) {
      parts.push(`
        <button type="button" class="${NAMESPACE}-pill-btn ${NAMESPACE}-pill-copy" data-action="copy" aria-label="复制">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/></svg>
          <span>复制</span>
        </button>
      `);
    }
    if (canSearch) {
      parts.push(`
        <button type="button" class="${NAMESPACE}-pill-btn ${NAMESPACE}-pill-search" data-action="search" aria-label="搜索">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <span>搜索</span>
        </button>
      `);
    }
    if (canOpen) {
      parts.push(`
        <button type="button" class="${NAMESPACE}-pill-btn ${NAMESPACE}-pill-open" data-action="open" aria-label="打开链接">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
          <span>打开</span>
        </button>
      `);
    }
    pill.innerHTML = parts.join("");
    sr.appendChild(pill);
    // measure then position
    const { offsetWidth, offsetHeight } = pill;
    positionBelow(pill, rect, offsetWidth, offsetHeight);
    // trigger enter animation next frame
    requestAnimationFrame(() => pill.classList.add(`${NAMESPACE}-pill-in`));

    // 保持选区：在按钮上按下鼠标时不取消选择
    pill.addEventListener("mousedown", (e) => {
      if (e.target.closest(`.${NAMESPACE}-pill-btn`)) e.preventDefault();
    });
    // 事件委托
    pill.addEventListener("click", (e) => {
      const btn = e.target.closest(`.${NAMESPACE}-pill-btn`);
      if (!btn) return;
      e.stopPropagation();
      e.preventDefault();
      const action = btn.dataset.action;
      if (action === "translate") {
        openPanel(rect);
      } else if (action === "search") {
        openUrl(buildSearchUrl(selected), settings.searchAutoJump);
      } else if (action === "open") {
        openUrl(normalizeOpenUrl(selected), settings.searchAutoJump);
      } else if (action === "copy") {
        copySelectionToClipboard(btn);
      }
    });
  };

  const hidePill = () => removeEl(PILL_ID);
  const hidePanel = () => {
    const sr = getYufanShadowRoot();
    const panel = sr.getElementById ? sr.getElementById(PANEL_ID) : sr.querySelector(`#${PANEL_ID}`);
    if (!panel) return;
    // 走和关闭按钮一致的淡出动画，避免突兀消失
    panel.classList.remove(`${NAMESPACE}-panel-in`);
    setTimeout(() => panel.remove(), 180);
  };

  // ---------- Panel ----------
  const openPanel = async (rect) => {
    hidePill();
    removeEl(PANEL_ID);
    const sr = getYufanShadowRoot();
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = `${NAMESPACE}-panel`;
    panel.setAttribute("data-testid", "yufan-translate-panel");
    panel.innerHTML = `
      <div class="${NAMESPACE}-panel-head">
        <div class="${NAMESPACE}-panel-brand">
          <img class="${NAMESPACE}-brand-logo" src="${LOGO_URL}" width="18" height="18" alt="语翻" />
          <span class="${NAMESPACE}-brand-name">语翻 · Yufan</span>
        </div>
        <button class="${NAMESPACE}-panel-close" aria-label="关闭" data-testid="yufan-panel-close">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>
      <div class="${NAMESPACE}-target-row">
        <div class="${NAMESPACE}-target-select" data-testid="yufan-target-select">
          <button type="button" class="${NAMESPACE}-target-trigger" aria-haspopup="listbox" aria-expanded="false">
            <span class="${NAMESPACE}-target-label-text"></span>
            <svg class="${NAMESPACE}-target-caret" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <ul class="${NAMESPACE}-target-menu" role="listbox"></ul>
        </div>
      </div>
      <div class="${NAMESPACE}-panel-source" data-testid="yufan-panel-source">${escapeHtml(state.selectedText)}</div>
      <div class="${NAMESPACE}-dict-head" data-testid="yufan-dict-head" hidden>
        <span class="${NAMESPACE}-dict-phonetic"></span>
        <button class="${NAMESPACE}-dict-audio" type="button" aria-label="发音" hidden>
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
        </button>
      </div>
      <div class="${NAMESPACE}-panel-result" data-testid="yufan-panel-result">
        <div class="${NAMESPACE}-loader"><span></span><span></span><span></span></div>
      </div>
      <div class="${NAMESPACE}-panel-footer">
        <span class="${NAMESPACE}-panel-provider" data-testid="yufan-panel-provider"></span>
        <button class="${NAMESPACE}-btn-ghost" title="复制">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/></svg>
          <span data-testid="yufan-panel-copy">复制</span>
        </button>
      </div>
    `;
    sr.appendChild(panel);
    positionBelow(panel, rect, panel.offsetWidth, panel.offsetHeight);
    requestAnimationFrame(() => panel.classList.add(`${NAMESPACE}-panel-in`));

    // 标记 panel 是否被拖动过；拖动后不再跟随划词位置重定位
    let panelDragged = false;

    panel
      .querySelector(`.${NAMESPACE}-panel-close`)
      .addEventListener("click", () => {
        panel.classList.remove(`${NAMESPACE}-panel-in`);
        setTimeout(() => panel.remove(), 180);
      });

    // ---------- Drag by header ----------
    const head = panel.querySelector(`.${NAMESPACE}-panel-head`);
    let dragging = false;
    let dragStart = { x: 0, y: 0, left: 0, top: 0 };

    const onDragMove = (e) => {
      if (!dragging) return;
      // panel 用 position:fixed，坐标基于视窗，不需加 scrollX/Y
      let newLeft = e.clientX - dragStart.x + dragStart.left;
      let newTop = e.clientY - dragStart.y + dragStart.top;
      // clamp inside viewport so the panel can't be dragged fully off-screen
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const w = panel.offsetWidth;
      const h = panel.offsetHeight;
      // keep at least 40px of the panel visible on each axis
      newLeft = Math.max(-(w - 40), Math.min(vw - 40, newLeft));
      newTop = Math.max(0, Math.min(vh - 40, newTop));
      panel.style.left = `${newLeft}px`;
      panel.style.top = `${newTop}px`;
    };

    const onDragEnd = () => {
      if (!dragging) return;
      dragging = false;
      // panel 始终 position:fixed，拖动后只需标记，不再切换 position
      // 同时设置 dataset.dragged 供顶层 onScrollOrResize 检测（它无法访问闭包变量）
      panelDragged = true;
      panel.dataset.dragged = "1";
      panel.classList.remove(`${NAMESPACE}-dragging`);
      document.removeEventListener("mousemove", onDragMove);
      document.removeEventListener("mouseup", onDragEnd);
    };

    head.addEventListener("mousedown", (e) => {
      // 忽略关闭按钮上的按下，避免误触发拖拽
      if (e.target.closest(`.${NAMESPACE}-panel-close`)) return;
      // 仅左键触发拖拽
      if (e.button !== 0) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      dragStart = {
        x: e.clientX,
        y: e.clientY,
        left: rect.left,
        top: rect.top,
      };
      panel.classList.add(`${NAMESPACE}-dragging`);
      // 拖拽时阻止默认行为，避免选中文本
      e.preventDefault();
      document.addEventListener("mousemove", onDragMove);
      document.addEventListener("mouseup", onDragEnd);
    });

    // ---------- Target language selector (custom dropdown) ----------
    const targetWrap = panel.querySelector(`.${NAMESPACE}-target-select`);
    const targetTrigger = targetWrap.querySelector(
      `.${NAMESPACE}-target-trigger`
    );
    const targetLabelText = targetWrap.querySelector(
      `.${NAMESPACE}-target-label-text`
    );
    const targetMenu = targetWrap.querySelector(`.${NAMESPACE}-target-menu`);

    // 渲染下拉选项
    TARGET_LANGS.forEach((l) => {
      const li = document.createElement("li");
      li.className = `${NAMESPACE}-target-option`;
      li.setAttribute("role", "option");
      li.dataset.value = l.code;
      li.innerHTML = `<span>${l.label}</span><svg class="${NAMESPACE}-target-check" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
      li.addEventListener("click", (e) => {
        e.stopPropagation();
        state.currentTarget = l.code;
        syncTargetUI();
        closeTargetMenu();
        doTranslate(state.currentTarget);
      });
      targetMenu.appendChild(li);
    });

    // 初始目标语言：根据选中文本预判（中文->en，非中文->zh-CN）
    const initialTarget = resolveInitialTarget(state.selectedText);
    state.currentTarget = initialTarget;

    const syncTargetUI = () => {
      const current = TARGET_LANGS.find(
        (l) => l.code === state.currentTarget
      );
      targetLabelText.textContent = current ? current.label : state.currentTarget;
      targetMenu
        .querySelectorAll(`.${NAMESPACE}-target-option`)
        .forEach((li) => {
          li.classList.toggle(
            `${NAMESPACE}-target-option-selected`,
            li.dataset.value === state.currentTarget
          );
        });
    };

    const openTargetMenu = () => {
      targetWrap.classList.add(`${NAMESPACE}-target-open`);
      targetTrigger.setAttribute("aria-expanded", "true");
      const selected = targetMenu.querySelector(
        `.${NAMESPACE}-target-option-selected`
      );
      if (selected) {
        requestAnimationFrame(() =>
          selected.scrollIntoView({ block: "nearest" })
        );
      }
    };
    const closeTargetMenu = () => {
      targetWrap.classList.remove(`${NAMESPACE}-target-open`);
      targetTrigger.setAttribute("aria-expanded", "false");
    };

    targetTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      if (targetWrap.classList.contains(`${NAMESPACE}-target-open`)) {
        closeTargetMenu();
      } else {
        openTargetMenu();
      }
    });
    // 点击面板内其他区域关闭下拉
    panel.addEventListener("click", (e) => {
      if (!e.target.closest(`.${NAMESPACE}-target-select`)) {
        closeTargetMenu();
      }
    });

    syncTargetUI();

    // ---------- Translation logic (reusable) ----------
    // 播放单词发音：
    // 1) 优先让 background 拉取音频转 data: URL（绕开 content script 直接 new Audio 的
    //    autoplay/CORS 问题，且 audio 元素可一次创建、多次播放）
    // 2) 失败时降级为 content script 直接 new Audio
    // 3) 按钮状态变化：idle -> loading -> playing -> idle / error
    const playPronunciation = async (audioUrl, audioBtn) => {
      if (!audioUrl) return;
      const setState = (state) => {
        if (!audioBtn) return;
        audioBtn.dataset.state = state;
        audioBtn.disabled = state === "loading" || state === "playing";
      };
      setState("loading");
      let dataUrl = "";
      try {
        const r = await chrome.runtime.sendMessage({
          type: "YUFAN_FETCH_AUDIO",
          payload: { url: audioUrl },
        });
        if (r && r.ok && r.data && r.data.dataUrl) {
          dataUrl = r.data.dataUrl;
        }
      } catch (_) {
        // 静默降级
      }
      try {
        const src = dataUrl || audioUrl;
        const a = new Audio(src);
        a.preload = "auto";
        a.onplaying = () => setState("playing");
        a.onended = () => setState("idle");
        a.onerror = () => setState("error");
        await a.play();
        // 用户没静音、文件正常：3s 后自动归位（防止某些情况下 onended 不触发）
        setTimeout(() => {
          if (audioBtn && audioBtn.dataset.state === "playing") {
            setState("idle");
          }
        }, 3000);
      } catch (e) {
        setState("error");
        setTimeout(() => setState("idle"), 1500);
      }
    };

    // 渲染"词典头"（音标 + 发音按钮）
    // 单词本身已在源 pill（panel-source）中显示，dict-head 不再重复展示
    const renderDictHead = (data) => {
      const head = panel.querySelector(`.${NAMESPACE}-dict-head`);
      if (!head) return;
      const phonEl = head.querySelector(`.${NAMESPACE}-dict-phonetic`);
      const audioBtn = head.querySelector(`.${NAMESPACE}-dict-audio`);
      const phonetic = data.phonetic || "";
      const audio = data.audio || "";
      phonEl.textContent = phonetic;
      if (audio) {
        audioBtn.hidden = false;
        audioBtn.dataset.state = "idle";
        audioBtn.disabled = false;
        audioBtn.onclick = () => playPronunciation(audio, audioBtn);
      } else {
        audioBtn.hidden = true;
        audioBtn.onclick = null;
        audioBtn.dataset.state = "";
      }
      // 既没音标也没音频，整行不显示
      head.hidden = !phonetic && !audio;
    };
    const hideDictHead = () => {
      const head = panel.querySelector(`.${NAMESPACE}-dict-head`);
      if (head) head.hidden = true;
    };

    // 渲染词典主体：多词性多释义
    // meanings: [{partOfSpeech, definitions:[{definition, example, synonyms, antonyms}]}]
    // 主释义用 translatedMeanings（中文）时优先；否则用原 meanings（英文）
    const renderDictionary = (data) => {
      const resultEl = panel.querySelector(`.${NAMESPACE}-panel-result`);
      // 必应词典把网络释义标成「网络 / 网路 / web」，统一本地化为「网络释义」更专业。
      const POS_LABEL_MAP = { 网络: "网络释义", 网路: "网络释义", web: "网络释义" };
      const normPos = (p) => POS_LABEL_MAP[String(p || "").trim().toLowerCase()] || p;
      const list = (data.translatedMeanings && data.translatedMeanings.length)
        ? data.translatedMeanings
        : data.meanings || [];
      if (!list.length) {
        resultEl.innerHTML = `<div class="${NAMESPACE}-error">未找到该单词的释义。</div>`;
        return;
      }
      const html = list.map((m) => {
        const pos = m.partOfSpeech ? `<span class="${NAMESPACE}-dict-pos">${escapeHtml(normPos(m.partOfSpeech))}</span>` : "";
        const defs = (m.definitions || []).map((d, i) => {
          const defText = d.definition || "";
          // 例句：双语显示
          //   - exampleOriginal（源语言）必显示
          //   - example（译文）与 exampleOriginal 不同时再显示译文
          //   - 都没则不显示
          const exOrig = (d.exampleOriginal || "").trim();
          const exTrans = (d.example || "").trim();
          let exampleBlock = "";
          if (exOrig && exTrans && exOrig !== exTrans) {
            exampleBlock = `<div class="${NAMESPACE}-dict-example">
              <div class="${NAMESPACE}-dict-ex-orig">${escapeHtml(exOrig)}</div>
              <div class="${NAMESPACE}-dict-ex-trans">例：${escapeHtml(exTrans)}</div>
            </div>`;
          } else if (exOrig) {
            // 只有原文（target=en，或翻译后被覆盖回原文）
            exampleBlock = `<div class="${NAMESPACE}-dict-example"><div class="${NAMESPACE}-dict-ex-orig">例：${escapeHtml(exOrig)}</div></div>`;
          } else if (exTrans) {
            // 只有译文（极少数边界）
            exampleBlock = `<div class="${NAMESPACE}-dict-example"><div class="${NAMESPACE}-dict-ex-trans">例：${escapeHtml(exTrans)}</div></div>`;
          }
          // 同义/反义词用 chip 展示
          const syn = (d.synonyms && d.synonyms.length)
            ? `<div class="${NAMESPACE}-dict-chips"><span class="${NAMESPACE}-dict-chip-label">同义</span>${d.synonyms.slice(0, 5).map((s) => `<span class="${NAMESPACE}-dict-chip">${escapeHtml(s)}</span>`).join("")}</div>`
            : "";
          const ant = (d.antonyms && d.antonyms.length)
            ? `<div class="${NAMESPACE}-dict-chips"><span class="${NAMESPACE}-dict-chip-label">反义</span>${d.antonyms.slice(0, 5).map((s) => `<span class="${NAMESPACE}-dict-chip">${escapeHtml(s)}</span>`).join("")}</div>`
            : "";
          return `<li class="${NAMESPACE}-dict-def"><span class="${NAMESPACE}-dict-def-num">${i + 1}.</span><div class="${NAMESPACE}-dict-def-body">${escapeHtml(defText)}${exampleBlock}${syn}${ant}</div></li>`;
        }).join("");
        return `<div class="${NAMESPACE}-dict-pos-block">${pos}<ol class="${NAMESPACE}-dict-defs">${defs}</ol></div>`;
      }).join("");
      // 例句来源：优先用 background 已按目标语言翻译好的 translatedExamples（{ex, tr}），
      // 这样 ja/ko/fr/de 等非中英文目标也能看到译后的例句；旧实现只渲染原始
      // examples（{en, cn}），非中英文目标下例句永远是英文/中文、从未翻译。
      const exList =
        data.translatedExamples && data.translatedExamples.length
          ? data.translatedExamples
          : Array.isArray(data.examples) ? data.examples : [];
      let examplesBlock = "";
      if (exList.length) {
        const renderItem = (e) => {
          const ex = (e && (e.ex != null ? e.ex : e.en)) || "";
          const tr = (e && (e.tr != null ? e.tr : e.cn)) || "";
          return `
          <li class="${NAMESPACE}-dict-ex-item">
            <div class="${NAMESPACE}-dict-ex-en">${escapeHtml(ex)}</div>
            <div class="${NAMESPACE}-dict-ex-cn">${escapeHtml(tr)}</div>
          </li>`;
        };
        const preview = exList.slice(0, 2);
        const rest = exList.slice(2);
        if (rest.length > 0) {
          const moreId = `${NAMESPACE}-dict-ex-more-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
          examplesBlock = `<div class="${NAMESPACE}-dict-examples-block">
            <div class="${NAMESPACE}-dict-examples-title">例句 · ${exList.length} 条</div>
            <ol class="${NAMESPACE}-dict-examples-list">${preview.map(renderItem).join("")}</ol>
            <ol class="${NAMESPACE}-dict-examples-list ${NAMESPACE}-dict-examples-rest" id="${moreId}" hidden>${rest.map(renderItem).join("")}</ol>
            <button type="button" class="${NAMESPACE}-dict-examples-toggle" data-target="${moreId}" aria-expanded="false">
              <span class="${NAMESPACE}-dict-examples-toggle-text">展开剩余 ${rest.length} 条例句</span>
              <svg class="${NAMESPACE}-dict-examples-toggle-caret" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            </button>
          </div>`;
        } else {
          examplesBlock = `<div class="${NAMESPACE}-dict-examples-block">
            <div class="${NAMESPACE}-dict-examples-title">例句</div>
            <ol class="${NAMESPACE}-dict-examples-list">${exList.map(renderItem).join("")}</ol>
          </div>`;
        }
      }
      resultEl.innerHTML = html + examplesBlock;
      // 绑定展开 / 收起按钮
      // 注意：必须先判断 exList 是否存在（"rest" 变量只在 exList.length > 2 时存在）
      if (exList.length > 2) {
        const restCount = exList.length - 2;
        resultEl.querySelectorAll(`.${NAMESPACE}-dict-examples-toggle`).forEach((btn) => {
          const textEl = btn.querySelector(`.${NAMESPACE}-dict-examples-toggle-text`);
          if (textEl) {
            btn.dataset.collapsedText = textEl.textContent;
            btn.dataset.expandedText = `收起剩余 ${restCount} 条例句`;
          }
          btn.addEventListener("click", () => {
            const target = document.getElementById(btn.dataset.target);
            if (!target) return;
            const expanded = btn.getAttribute("aria-expanded") === "true";
            target.hidden = expanded;
            btn.setAttribute("aria-expanded", expanded ? "false" : "true");
            btn.classList.toggle("is-expanded", !expanded);
            if (textEl) {
              textEl.textContent = expanded ? btn.dataset.collapsedText : btn.dataset.expandedText;
            }
          });
        });
      }
    };

    // 把当前面板内容转成可复制的纯文本（用于剪贴板）
    const collectCopyText = (data) => {
      if (data && data.mode === "dictionary") {
        const lines = [];
        if (data.word) lines.push(data.word);
        if (data.phonetic) lines.push(data.phonetic);
        const list = (data.translatedMeanings && data.translatedMeanings.length)
          ? data.translatedMeanings
          : data.meanings || [];
        list.forEach((m) => {
          if (m.partOfSpeech) lines.push(`【${m.partOfSpeech}】`);
          (m.definitions || []).forEach((d, i) => {
            lines.push(`  ${i + 1}. ${d.definition || ""}`);
            const exOrig = (d.exampleOriginal || "").trim();
            const exTrans = (d.example || "").trim();
            if (exOrig && exTrans && exOrig !== exTrans) {
              lines.push(`     ${exOrig}`);
              lines.push(`     例：${exTrans}`);
            } else if (exOrig) {
              lines.push(`     例：${exOrig}`);
            } else if (exTrans) {
              lines.push(`     例：${exTrans}`);
            }
          });
        });
        return lines.filter(Boolean).join("\n");
      }
      return (data && data.translated) || "";
    };

    const doTranslate = async (target) => {
      const resultEl = panel.querySelector(`.${NAMESPACE}-panel-result`);
      const providerEl = panel.querySelector(`.${NAMESPACE}-panel-provider`);
      const dictHead = panel.querySelector(`.${NAMESPACE}-dict-head`);
      // 显示加载态
      resultEl.innerHTML = `<div class="${NAMESPACE}-loader"><span></span><span></span><span></span></div>`;
      providerEl.textContent = "";
      if (dictHead) dictHead.hidden = true;
      // 语言保护统一交给 background 处理（它有多语种脚本检测 + 繁简地区判定）。
      // 这里不再做第二套启发式切换 —— 两套规则并存只会互相打架，
      // 而且本地切换后下拉框不会同步，用户看到的和实际翻译的语言对不上。
      const normZh = (c) => String(c || "").toLowerCase().startsWith("zh");
      try {
        const resp = await chrome.runtime.sendMessage({
          type: "YUFAN_TRANSLATE",
          payload: {
            text: state.selectedText,
            source: "auto",
            target,
          },
        });
        if (!resp || !resp.ok) {
          // 兜底：极少数情况下 background 仍判为同语言（混合文本 CJK=letters），
          // 自动翻成相反主语言再试一次。
          const errMsg = (resp && resp.error) || "网络异常";
          if (errMsg.includes("源语言和目标语言相同")) {
            const retryTarget = normZh(target) ? "en" : "zh-CN";
            if (retryTarget !== target) {
              const resp2 = await chrome.runtime.sendMessage({
                type: "YUFAN_TRANSLATE",
                payload: { text: state.selectedText, source: "auto", target: retryTarget },
              });
              if (resp2 && resp2.ok) {
                target = retryTarget;
                // 同步到自定义下拉框：它是 div 结构，必须走 state + syncTargetUI，
                // 直接写 .value 对 div 无效（下拉框会一直显示旧语言）。
                state.currentTarget = retryTarget;
                syncTargetUI();
                // 把成功响应"伪装"成主请求的 resp，下方统一渲染
                resp.ok = true;
                resp.data = resp2.data;
              }
            }
          }
          if (!resp.ok) {
            resultEl.innerHTML = `<div class="${NAMESPACE}-error">翻译失败：${escapeHtml(errMsg)}</div>`;
            return;
          }
        }
        const data = resp.data || {};
        // 同语言保护可能改写目标语言（中文文本 + 目标简中 -> 实际翻成英文）。
        // background 会回传实际生效的 target，这里同步到下拉框，避免 UI 说谎。
        if (data.target && data.target !== state.currentTarget) {
          state.currentTarget = data.target;
          syncTargetUI();
        }
        // background 已经做了一次性路由：
        //   - 单词（looksLikeWord）-> 词典
        //   - 句子 / 词典未命中 -> MyMemory
        // UI 不再做"降级"判断，直接按 mode 渲染。
        const sourceEl = panel.querySelector(`.${NAMESPACE}-panel-source`);
        if (sourceEl) sourceEl.hidden = false;
        if (data.mode === "dictionary") {
          resultEl.classList.remove(`${NAMESPACE}-panel-result-text`);
          renderDictHead(data);
          renderDictionary(data);
        } else {
          hideDictHead();
          resultEl.classList.add(`${NAMESPACE}-panel-result-text`);
          resultEl.textContent = data.translated || "";
        }
        const provider = data.provider || "MyMemory";
        const detected = data.detected || data.detectedSource || "";
        providerEl.textContent = detected
          ? `${provider} · 识别：${detected}`
          : provider;
        // 把当前数据存到 panel 上，复制按钮直接读
        panel.__yufanLastData = data;
        // reposition (result height changed)：拖动过则保持位置，否则跟随划词位置
        if (!panelDragged) {
          positionBelow(panel, rect, panel.offsetWidth, panel.offsetHeight);
        }
      } catch (err) {
        resultEl.innerHTML = `<div class="${NAMESPACE}-error">翻译失败：${escapeHtml(err.message || String(err))}</div>`;
      }
    };

    // 首次翻译
    doTranslate(state.currentTarget);

    panel
      .querySelector(`[data-testid="yufan-panel-copy"]`)
      .addEventListener("click", async () => {
        const data = panel.__yufanLastData;
        const txt = collectCopyText(data || {}) ||
          (panel.querySelector(`.${NAMESPACE}-panel-result`).textContent || "");
        try {
          await navigator.clipboard.writeText(String(txt).trim());
          const btnLabel = panel.querySelector(`[data-testid="yufan-panel-copy"]`);
          const old = btnLabel.textContent;
          btnLabel.textContent = "已复制 ✓";
          setTimeout(() => (btnLabel.textContent = old), 1400);
        } catch (_) {
          /* no-op */
        }
      });
  };

  const escapeHtml = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  // ---------- selection handling ----------
  let selectionChangeTimer = null;
  // 拖动选择中（mousedown 后到 mouseup 前）：期间不显示胶囊，避免持续闪烁
  let isSelecting = false;

  const checkSelection = (fromEvent) => {
    // 划词管理总开关：关闭后完全停用划词胶囊
    if (!settings.selectionEnabled) {
      hidePill();
      return;
    }
    const sel = window.getSelection();
    const text = cleanSelection(sel && sel.toString());
    if (!text || text.length < 1 || text.length > 800) {
      hidePill();
      return;
    }
    // hide previous panel when a new selection is made
    hidePanel();
    if (!sel || sel.rangeCount === 0) {
      hidePill();
      return;
    }
    let rect = null;
    try {
      rect = sel.getRangeAt(0).getBoundingClientRect();
    } catch (_) {
      rect = null;
    }
    // 某些页面（如 shadow DOM / 富文本编辑器）getBoundingClientRect 可能为 0x0，
    // 但选区文本非空，此时尝试用选区锚点元素的位置兜底。
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      try {
        const anchor = sel.anchorNode;
        if (anchor && anchor.getBoundingClientRect) {
          rect = anchor.getBoundingClientRect();
        } else if (anchor && anchor.parentElement) {
          rect = anchor.parentElement.getBoundingClientRect();
        }
      } catch (_) {
        rect = null;
      }
    }
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      hidePill();
      return;
    }
    state.selectedText = text;
    state.selectionRect = rect;
    showPill(rect);
  };

  // 判断事件是否源自扩展自身的 UI（胶囊/面板/进度胶囊）。
  // 关键坑：这些 UI 挂在 Shadow DOM 内，document 层监听到的 event.target 会被
  // 重定位（retarget）到 shadow 宿主元素，closest("#yufan-select-pill") 永远匹配不到
  // 内部按钮 —— 导致点在胶囊上也被误判为"页面外部点击"而 hidePill/hidePanel。
  // 必须用 composedPath() 还原真实事件路径再判断。
  const isInsideYufanUI = (nodeOrEvent) => {
    let path = null;
    if (nodeOrEvent && typeof nodeOrEvent.composedPath === "function") {
      path = nodeOrEvent.composedPath();
    } else if (nodeOrEvent) {
      path = [nodeOrEvent];
    }
    if (!path) return false;
    return path.some(
      (el) =>
        el &&
        el.id &&
        (el.id === PILL_ID || el.id === PANEL_ID || el.id === PROGRESS_ID)
    );
  };

  const onSelectionChange = () => {
    // 拖动选择中：只隐藏上一次残留的胶囊，绝不重建/显示，避免持续闪烁
    if (isSelecting) {
      hidePill();
      return;
    }
    // 非拖动场景（键盘选词、特殊页面不触发 up 事件）：防抖兜底显示
    if (selectionChangeTimer) clearTimeout(selectionChangeTimer);
    selectionChangeTimer = setTimeout(() => checkSelection("selectionchange"), 120);
  };

  const onMouseUp = (e) => {
    // 无论是否在 UI 上抬起，都先复位拖动标记，避免永久拦截显示
    if (isInsideYufanUI(e)) { isSelecting = false; return; }
    isSelecting = false; // 立即复位：避免 mouseup 之后的 selectionchange 误隐藏造成闪烁
    // 给浏览器一点时间来完成选区更新
    setTimeout(() => checkSelection("mouseup"), 20);
  };

  const onPointerUp = (e) => {
    if (isInsideYufanUI(e)) { isSelecting = false; return; }
    isSelecting = false;
    setTimeout(() => checkSelection("pointerup"), 20);
  };

  const onTouchEnd = (e) => {
    if (isInsideYufanUI(e)) { isSelecting = false; return; }
    isSelecting = false;
    setTimeout(() => checkSelection("touchend"), 50);
  };

  const onKeyUp = (e) => {
    // Shift/方向键/Ctrl+A 等键盘选区操作后兜底检查
    if (["Shift", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "a", "A"].includes(e.key)) {
      setTimeout(() => checkSelection("keyup"), 50);
    }
  };

  const onMouseDown = (e) => {
    // 点在扩展自身 UI 上时（胶囊/面板/进度胶囊，位于 Shadow DOM 内）不处理，
    // 否则会被当成"页面外部点击"误删 UI。注意：shadow 内的事件在 document 层
    // 监听时 target 被重定位到宿主，必须用 composedPath 判断（见 isInsideYufanUI）。
    if (isInsideYufanUI(e)) {
      return; // interacting with our own UI
    }
    // 标记开始拖动选择：期间 selectionchange 不再显示胶囊，避免闪烁
    isSelecting = true;
    // 点击面板/pill 外部时，同时关闭 pill 和 panel
    hidePill();
    hidePanel();
  };

  const onScrollOrResize = () => {
    // Reposition based on live selection rect if still valid.
    const sel = window.getSelection();
    if (!sel || !sel.toString().trim()) {
      hidePill();
      return;
    }
    const range = sel.rangeCount ? sel.getRangeAt(0) : null;
    if (!range) return;
    const rect = range.getBoundingClientRect();
    const sr = getYufanShadowRoot();
    const pill = sr.getElementById ? sr.getElementById(PILL_ID) : sr.querySelector(`#${PILL_ID}`);
    if (pill) positionBelow(pill, rect, pill.offsetWidth, pill.offsetHeight);
    const panel = sr.getElementById ? sr.getElementById(PANEL_ID) : sr.querySelector(`#${PANEL_ID}`);
    // panel 未拖动时跟随划词位置（fixed 定位，视窗坐标）；拖动后固定不再重定位
    if (panel && !panel.dataset.dragged) {
      positionBelow(panel, rect, panel.offsetWidth, panel.offsetHeight);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      hidePill();
      hidePanel();
      return;
    }
    // 临时关闭快捷键：Ctrl/Cmd + Option/Alt 组合键一次性关闭当前胶囊。
    // 仅在「临时关闭」开关开启、且胶囊当前可见时生效；关闭后下次划词会重新显示，
    // 因此每次划词都可再次用同一组合键临时关闭（不会永久停用划词）。
    if ((e.ctrlKey || e.metaKey) && e.altKey) {
      const sr = getYufanShadowRoot();
      const pill = sr.getElementById ? sr.getElementById(PILL_ID) : sr.querySelector(`#${PILL_ID}`);
      if (settings.pillTempClose && pill) {
        hidePill();
        if (e.preventDefault) {
          try {
            e.preventDefault();
          } catch (_) {
            /* 忽略 */
          }
        }
      }
    }
  };

  // ---------- Page translation (from context menu) ----------
  // 全新策略：一次性翻译整个页面所有可见文本，并持续监控动态内容
  let pageTranslated = false;
  let pageTranslationTarget = "zh-CN"; // 当前页面的翻译目标语言
  let pageTranslationInProgress = false;

  // 跳过这些标签内的文本。
  // 注意：早期版本把 KBD/SAMP/VAR/SELECT/OPTION 也跳过了，导致大量可见文本
  // （键盘提示、示例输出、下拉选项文案）根本没被识别。这里只保留"翻了会坏"
  // 或"纯机器语言"的标签：脚本/样式/输入框/代码块。
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "OBJECT", "EMBED",
    "TEXTAREA", "INPUT", "CODE", "PRE",
  ]);

  // 跳过我们自己的 UI（含进度浮层，避免其内部文本被翻译、被当作外部点击）
  const isOwnUI = (el) => {
    if (!el || !el.closest) return false;
    return !!el.closest(`#${PILL_ID}, #${PANEL_ID}, #${PROGRESS_ID}, .${NAMESPACE}-page-translation`);
  };

  // 判断元素是否在视窗中可见（用于决定是否加入 IntersectionObserver 观察）
  // 轻量版：仅检查 display / visibility / opacity / 尺寸，不递归祖先
  const isElementVisible = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none") return false;
    if (cs.visibility === "hidden" || cs.visibility === "collapse") return false;
    if (cs.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  };

  // 判断元素是否应该被翻译（增强版，包含隐藏元素）
  const shouldTranslateElement = (el) => {
    if (!el || !el.textContent) return false;
    if (isOwnUI(el)) return false;
    // 跳过特定标签
    let p = el;
    while (p && p !== document.body) {
      if (SKIP_TAGS.has(p.tagName)) return false;
      if (p.isContentEditable) return false;
      p = p.parentElement;
    }
    // 元素必须在视窗内可见或即将可见（用于隐藏弹窗）
    const cs = getComputedStyle(el);
    if (cs.display === "none") return false;
    if (cs.visibility === "collapse") return false;
    if (cs.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.bottom < -100 || rect.top > vh + 100) return false; // 扩大监控范围
    if (rect.right < -100 || rect.left > vw + 100) return false; // 扩大监控范围
    return true;
  };

  // 尊重页面声明的"不要翻译"标记（Google 翻译的通用约定）：
  // translate="no" 属性或 notranslate class
  const isNoTranslate = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.getAttribute && el.getAttribute("translate") === "no") return true;
    if (el.classList && el.classList.contains("notranslate")) return true;
    return false;
  };

  // SVG 内联 tooltip 元素（<svg><title>…</title></svg>）：
  // 与 title 属性不同，这是原生图标提示的另一种形态，走专用翻译管线。
  // 注意 SVG 元素的 tagName 保留小写 "title"，HTML <head><title> 是大写 "TITLE"。
  const isSvgTitleElement = (el) =>
    !!el &&
    el.nodeType === Node.ELEMENT_NODE &&
    String(el.tagName).toLowerCase() === "title" &&
    el.namespaceURI === "http://www.w3.org/2000/svg";

  // SVG 里真正"画出来"的文字：图表的轴标签、图例、图标字（<text> / <tspan>）。
  // 这些不能用普通文本管线：<font> 是 HTML 元素，放进 SVG 命名空间**不会被
  // 渲染**，译文永远看不见（页面看起来就是"标签没翻译"）。必须走专用管线
  // 改写 textContent（与 SVG <title> 同理）。
  const SVG_NS = "http://www.w3.org/2000/svg";
  const SVG_TEXT_TAGS = new Set(["text", "tspan"]);
  const isSvgTextElement = (el) =>
    !!el &&
    el.nodeType === Node.ELEMENT_NODE &&
    SVG_TEXT_TAGS.has(String(el.tagName).toLowerCase()) &&
    el.namespaceURI === SVG_NS;
  // 只处理"自身就是文本叶子"的元素：<text> 里嵌 <tspan> 时改写父级 textContent
  // 会把子结构整个拍平，只能处理最内层的那一层。
  const isSvgTextLeaf = (el) => {
    const kids = el.childNodes;
    if (!kids || kids.length === 0) return false;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].nodeType !== Node.TEXT_NODE) return false;
    }
    return true;
  };

  // 文本节点的"有效父元素"：
  // 直接挂在 shadow root 下的文本节点 parentElement 为 null（DocumentFragment
  // 没有 parentElement 语义），回退到 host 元素，否则整段 shadow 文本被漏翻。
  const effectiveParent = (node) => {
    if (!node) return null;
    const p = node.parentElement;
    if (p) return p;
    const pn = node.parentNode;
    if (!pn) return null;
    if (pn.nodeType === Node.ELEMENT_NODE) return pn;
    // shadow root（DocumentFragment）：返回其 host 元素
    if (pn.nodeType === Node.DOCUMENT_FRAGMENT_NODE && pn.host) return pn.host;
    return null;
  };

  // 判断文本节点是否应该被翻译
  const shouldTranslateTextNode = (node) => {
    if (!node || node.nodeType !== Node.TEXT_NODE) return false;
    const text = node.nodeValue;
    if (!text || !text.trim() || text.trim().length < 2) return false;
    const parent = effectiveParent(node);
    if (!parent || isOwnUI(parent)) return false;
    // SVG <title> 内的文本走专用管线（font 包裹会破坏原生 tooltip 渲染），
    // 普通文本管线必须放行，否则双管线打架互相破坏。
    if (isSvgTitleElement(parent)) return false;
    // SVG <text>/<tspan> 同理：必须用改写 textContent 的专用管线，
    // 在这里放行是防止往 SVG 里插入永不渲染的 <font>。
    if (isSvgTextElement(parent)) return false;
    // 跳过特定标签
    let p = parent;
    while (p && p !== document.body) {
      if (SKIP_TAGS.has(p.tagName)) return false;
      if (p.isContentEditable) return false;
      if (isNoTranslate(p)) return false;
      p = p.parentElement;
    }
    return true;
  };

  // ---------- 深度收集（穿透 Shadow DOM 与同源 iframe）----------
  // 原生 TreeWalker 无法越过 shadowRoot，导致所有使用 Web Components 的页面
  // （YouTube、各类 SPA）大段文本根本进不了收集器，整页翻译"认不全"。
  // 下面这组工具函数手动递归 childNodes，从而穿透 open shadow root 与同源 iframe。
  const getShadowRoot = (el) => {
    try {
      return (el && el.shadowRoot) || null;
    } catch (_) {
      return null;
    }
  };
  const getIframeDoc = (iframe) => {
    try {
      return iframe && iframe.contentDocument ? iframe.contentDocument : null;
    } catch (_) {
      return null;
    }
  };
  // 判断某个 document 内是否已注入本扩展（避免父子文档重复翻译）
  const isSubtreeLoaded = (doc) => {
    try {
      return !!(doc && doc.defaultView && doc.defaultView.__yufanTranslateLoaded);
    } catch (_) {
      return false;
    }
  };

  // 递归收集 root 下所有文本节点；accept(node) 决定纳入与否。
  // 自动穿透 open shadow root 与同源 iframe（iframe 内已加载扩展则跳过）。
  const collectTextNodesDeep = (root, accept) => {
    const out = [];
    const visit = (node) => {
      const kids = node.childNodes;
      if (!kids) return;
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        if (child.nodeType === Node.TEXT_NODE) {
          if (accept(child)) out.push(child);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          if (isOwnUI(child)) continue;
          if (child.tagName === "IFRAME") {
            const idoc = getIframeDoc(child);
            if (idoc && idoc.body && !isSubtreeLoaded(idoc)) visit(idoc.body);
            continue;
          }
          if (SKIP_TAGS.has(child.tagName)) continue;
          if (child.isContentEditable) continue;
          visit(child);
          const sr = getShadowRoot(child);
          if (sr) visit(sr);
        }
      }
    };
    visit(root);
    const rootSr = getShadowRoot(root);
    if (rootSr) visit(rootSr);
    return out;
  };

  const collectTextNodesDeepAsync = (root, accept) => {
    return new Promise((resolve) => {
      const out = [];
      const stack = [root];
      const rootSr = getShadowRoot(root);
      if (rootSr) stack.push(rootSr);

      const step = () => {
        const startTime = performance.now();
        while (stack.length > 0 && performance.now() - startTime < 16) {
          const node = stack.pop();
          const kids = node.childNodes;
          if (!kids) continue;
          for (let i = kids.length - 1; i >= 0; i--) {
            const child = kids[i];
            if (child.nodeType === Node.TEXT_NODE) {
              if (accept(child)) out.push(child);
            } else if (child.nodeType === Node.ELEMENT_NODE) {
              if (isOwnUI(child)) continue;
              if (child.tagName === "IFRAME") {
                const idoc = getIframeDoc(child);
                if (idoc && idoc.body && !isSubtreeLoaded(idoc)) stack.push(idoc.body);
                continue;
              }
              if (SKIP_TAGS.has(child.tagName)) continue;
              if (child.isContentEditable) continue;
              stack.push(child);
              const sr = getShadowRoot(child);
              if (sr) stack.push(sr);
            }
          }
        }
        if (stack.length > 0) {
          if (window.requestIdleCallback) {
            requestIdleCallback(step);
          } else {
            setTimeout(step, 1);
          }
        } else {
          resolve(out);
        }
      };
      step();
    });
  };

  // 递归遍历 root 下所有元素（穿透 shadow / iframe），对每个元素调用 cb。
  // 注意：child 必须压栈递归 —— 旧实现只对 root 的直接子元素调用 cb，
  // 普通嵌套子树根本不会被遍历（只有 shadow/iframe 会递归），
  // 真实页面上所有嵌套元素的 title / 属性 / SVG title 全部被漏掉，
  // 这是"整页翻译内容不全"的核心根因之一。
  const walkElementsDeep = (root, cb) => {
    const stack = [root];
    const rootSr = getShadowRoot(root);
    if (rootSr) stack.push(rootSr);
    while (stack.length) {
      const cur = stack.pop();
      const kids = cur.childNodes;
      if (!kids) continue;
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        cb(child);
        stack.push(child);
        const sr = getShadowRoot(child);
        if (sr) stack.push(sr);
        if (child.tagName === "IFRAME") {
          const idoc = getIframeDoc(child);
          if (idoc && idoc.body && !isSubtreeLoaded(idoc)) stack.push(idoc.body);
        }
      }
    }
  };

  const walkElementsDeepAsync = (root, cb) => {
    return new Promise((resolve) => {
      const stack = [root];
      const rootSr = getShadowRoot(root);
      if (rootSr) stack.push(rootSr);

      const step = () => {
        const startTime = performance.now();
        // 每帧最多运行 16ms，避免阻塞主线程
        while (stack.length > 0 && performance.now() - startTime < 16) {
          const cur = stack.pop();
          const kids = cur.childNodes;
          if (!kids) continue;
          for (let i = 0; i < kids.length; i++) {
            const child = kids[i];
            if (child.nodeType !== Node.ELEMENT_NODE) continue;
            cb(child);
            stack.push(child);
            const sr = getShadowRoot(child);
            if (sr) stack.push(sr);
            if (child.tagName === "IFRAME") {
              const idoc = getIframeDoc(child);
              if (idoc && idoc.body && !isSubtreeLoaded(idoc)) stack.push(idoc.body);
            }
          }
        }

        if (stack.length > 0) {
          if (window.requestIdleCallback) {
            requestIdleCallback(step);
          } else {
            setTimeout(step, 1);
          }
        } else {
          resolve();
        }
      };
      step();
    });
  };

  // ---------- 属性翻译（placeholder / aria-label / alt / 按钮型 input 的 value）----------
  // 整页翻译早期只翻文本节点，完全忽略了"写在属性里的文字"，
  // 例如搜索框的 placeholder、图标的 aria-label、图片的 alt、提交按钮的 value。
  // 另外主流 UI 框架把 tooltip 文本存在 data-* 属性里：
  //   Bootstrap：初始化时把 title 迁移到 data-original-title
  //   shadcn/ui（Radix）：data-tip
  //   flowbite / 其他：data-tooltip / data-title
  // 不监听这些属性，页面上大量 hover 提示就永远翻不到。
  // 写在属性里的"标签文案"。每个新增项都对应一类真实漏翻：
  //   aria-placeholder / aria-valuetext / aria-roledescription —— 无文本图标控件
  //     （滑块、评分、进度条）的无障碍标签，读屏与 tooltip 都靠它
  //   label —— <option>/<optgroup>/<track> 的显示文本（下拉项、字幕轨道名）
  //   data-content / data-bs-content —— Bootstrap popover 正文
  //   data-bs-original-title / data-bs-title —— Bootstrap 5 迁移后的 title
  //   data-hint —— 部分组件库的提示文案
  const TRANSLATE_ATTRS = [
    "placeholder", "aria-label", "aria-placeholder", "aria-valuetext",
    "aria-roledescription", "alt", "value", "label",
    "data-original-title", "data-tip", "data-tooltip", "data-title",
    "data-content", "data-bs-content", "data-bs-original-title", "data-bs-title",
    "data-hint",
  ];
  const ATTR_BACKUP_PREFIX = `data-${NAMESPACE}-attr-`;
  const ATTR_TRANSLATED_MARK = `data-${NAMESPACE}-attr-translated`;
  // 备份译文值用的 data 属性名（用于判断属性是否被外部覆盖、需要重译）
  const ATTR_TRANSLATED_VAL_PREFIX = `data-${NAMESPACE}-attr-val-`;
  // MutationObserver 的 attributeFilter（主观察器与 shadow 观察器共用，单一来源，
  // 避免"改了一处忘了另一处"——历史上 value 就是这么漏掉的）
  const MUTATION_ATTR_FILTER = ["title", ...TRANSLATE_ATTRS];

  const shouldAttrTranslate = (el, attr) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (!el.hasAttribute || !el.hasAttribute(attr)) return false;
    // 已翻译过（标记含该属性名）则跳过，避免重复
    const mark = el.getAttribute(ATTR_TRANSLATED_MARK) || "";
    if (mark.split(",").includes(attr)) return false;
    if (el.hasAttribute(ATTR_BACKUP_PREFIX + attr)) return false;
    const val = el.getAttribute(attr);
    if (!val || !val.trim() || val.trim().length < 2) return false;
    // 已含"原文 ｜ 译文"对比格式的值不翻：Bootstrap 初始化 tooltip 时会把
    // 我们翻译过的双语 title 值迁移进 data-original-title，再翻一次会变成
    // "原文 ｜ 译文 ｜ 译译文"的三段重复。
    if (val.includes(TITLE_SEPARATOR)) return false;
    if (isOwnUI(el)) return false;
    if (isNoTranslate(el)) return false;
    // value 仅翻译按钮类 input 与 <button>（避免改掉用户正在输入的内容）
    if (attr === "value") {
      const isButtonInput =
        el.tagName === "INPUT" &&
        ["button", "submit", "reset"].includes((el.getAttribute("type") || "submit").toLowerCase());
      // 不能在这里直接 return true：后面的祖先链检查（SKIP_TAGS / notranslate）还要走
      if (el.tagName !== "BUTTON" && !isButtonInput) return false;
    }
    // label 只对"用 label 属性作为显示文本"的标签生效：下拉项、分组、字幕轨道。
    // 不限定的话会翻到各类组件的配置属性（很多 Web Component 用 label 传配置）。
    if (attr === "label") {
      if (!["OPTION", "OPTGROUP", "TRACK"].includes(el.tagName)) return false;
    }
    // 注意：祖先链从"父级"开始，不要把元素自身算进去——
    // INPUT 本身在 SKIP_TAGS 里（避免翻输入框内的文本），但它身上的
    // placeholder / aria-label / value 这些属性是合法可翻译内容，必须放行。
    let p = el.parentElement;
    while (p && p !== document.body) {
      if (SKIP_TAGS.has(p.tagName)) return false;
      if (p.isContentEditable) return false;
      p = p.parentElement;
    }
    return true;
  };

  // 判断已翻译的属性是否被外部覆盖、需要重新翻译
  // 触发条件：属性已备份原文与译文，但当前值不等于我们设置的译文
  // （说明页面自身代码重新设置了该属性，需重新翻译新内容）
  const needsRetranslateAttr = (el, attr) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const backup = el.getAttribute(ATTR_BACKUP_PREFIX + attr);
    const translatedVal = el.getAttribute(ATTR_TRANSLATED_VAL_PREFIX + attr);
    if (backup == null || translatedVal == null) return false;
    const current = el.getAttribute(attr);
    if (current == null) return false;
    // 当前值仍等于我们设置的译文则无需重译
    return current !== translatedVal;
  };

  // 清除属性翻译标记（用于重译前重置状态）
  const clearAttrTranslationMark = (el, attr) => {
    el.removeAttribute(ATTR_BACKUP_PREFIX + attr);
    el.removeAttribute(ATTR_TRANSLATED_VAL_PREFIX + attr);
    const prev = el.getAttribute(ATTR_TRANSLATED_MARK) || "";
    const set = new Set(prev.split(",").filter(Boolean));
    set.delete(attr);
    if (set.size > 0) {
      el.setAttribute(ATTR_TRANSLATED_MARK, [...set].join(","));
    } else {
      el.removeAttribute(ATTR_TRANSLATED_MARK);
    }
  };

  const collectAttrTargets = (root) => {
    const out = [];
    walkElementsDeep(root, (el) => {
      for (const attr of TRANSLATE_ATTRS) {
        if (shouldAttrTranslate(el, attr)) out.push({ el, attr });
      }
    });
    return out;
  };

  const translateAttrBatch = async (targets, target, concurrency = 4, skipHidden = false) => {
    // 返回本轮真正写入的译文条数：补扫调度器靠它判断"还有没有活干"，
    // 从而收敛（否则页面上永远存在的隐藏节点会让补扫无限期跑下去）。
    if (!targets || !targets.length) return 0;
    const pending = [];
    for (const { el, attr } of targets) {
      if (!shouldAttrTranslate(el, attr)) continue;
      if (skipHidden && !isElementVisible(el)) continue;
      const original = el.getAttribute(attr);
      if (!original) continue;
      pending.push({ el, attr, original });
    }
    if (!pending.length) return 0;
    let done = 0;
    const CHUNK = Math.max(concurrency * 15, 60);
    for (let s = 0; s < pending.length; s += CHUNK) {
      const slice = pending.slice(s, s + CHUNK);
      const results = await translateTexts(slice.map((p) => p.original), target);
      for (let k = 0; k < slice.length; k++) {
        const { el, attr, original } = slice[k];
        const translated = String(results[k] || "").trim();
        if (translated && translated !== original) {
          el.setAttribute(ATTR_BACKUP_PREFIX + attr, original);
          el.setAttribute(ATTR_TRANSLATED_VAL_PREFIX + attr, translated);
          el.setAttribute(attr, translated);
          const prev = el.getAttribute(ATTR_TRANSLATED_MARK) || "";
          const set = new Set(prev.split(",").filter(Boolean));
          set.add(attr);
          el.setAttribute(ATTR_TRANSLATED_MARK, [...set].join(","));
          done++;
        }
      }
    }
    return done;
  };

  // 翻译文本缓存（整页翻译里重复串很多，缓存能省下大量请求与配额）
  const translationCache = new Map();
  const MAX_CACHE_SIZE = 2000;

  const cacheGet = (key) => {
    if (!translationCache.has(key)) return undefined;
    const v = translationCache.get(key);
    // LRU：命中后移到队尾
    translationCache.delete(key);
    translationCache.set(key, v);
    return v;
  };
  const cacheSet = (key, v) => {
    if (translationCache.size >= MAX_CACHE_SIZE) {
      const oldest = translationCache.keys().next().value;
      if (oldest !== undefined) translationCache.delete(oldest);
    }
    translationCache.set(key, v);
  };

  // 最近一次批次翻译的错误信息（由 background 透传：配额耗尽等）。
  // translateBatch 每翻完一批就检查：配额耗尽时立刻停后续批次并提示用户，
  // 而不是让页面"静悄悄什么都不翻"，或继续空跑几百次注定失败的请求。
  let lastBatchError = "";
  let lastBatchQuotaExhausted = false;
  // 服务端告知的额度恢复时间（分钟）。>0 时熔断后到点自动续翻剩余内容，
  // 而不是让用户手动再点一次右键菜单。
  let lastBatchRetryAfterMin = 0;
  // 频率限流（429）标记：暂时性失败，不熔断、不计失败次数，
  // 由补扫调度器自动重试。
  let lastBatchRateLimited = false;
  // 配额熔断后的静默暂停期：暂停期内补扫/观察器的所有批次直接空转
  // （不发消息、不弹进度、不重试），避免"失败→重试→失败"循环把提示
  // 气泡折腾得一闪一闪，也避免空跑无意义的请求。到点由自动续翻解除。
  let quotaSuspendedUntil = 0;

  // ---------- 流式结果通道（翻译一条显示一条）----------
  // chrome.runtime.sendMessage 只能"一问一答"，整批等待会让用户干等几十个请求。
  // 所以 background 每翻完一个桶就主动 chrome.tabs.sendMessage 推回来，
  // 这里按 batchId 路由到对应的批次，交给 onItem 立刻插入 DOM。
  // 最终响应仍会带回全量结果，用于兜底补齐（老版本 background / 推送丢失）。
  // 注意：**不另注册监听器**。content 只保留一个 onMessage 监听器（见文末），
  // 多注册一个会让"取第一个监听器"的调用方/测试拿到错误的对象。
  const partialHandlers = new Map(); // batchId -> { offset, onValue(uniqueIdx, val) }
  const handleBatchPartial = (msg) => {
    const h = partialHandlers.get(msg.batchId);
    if (!h || !Array.isArray(msg.items)) return false;
    for (const item of msg.items) {
      if (!item || typeof item.index !== "number") continue;
      const idx = h.offset + item.index;
      const val = String(item.text == null ? "" : item.text).trim();
      if (!val) continue;
      try {
        h.onValue(idx, val);
      } catch (_) {
        /* 单条失败不影响其余条目 */
      }
    }
    return false;
  };

  // 批量翻译：把一批短文本交给 background（内部会再拼块、去重），
  // 避免"一个文本节点一次 HTTP 往返"—— 那是整页翻译又慢又烧配额的根因。
  // onItem(localIdx, translated) 可选：每来一条译文立刻回调，调用方当场插入，
  // 不必等整批完成。返回与 texts 等长的结果数组（失败项为空串）。
  const translateTexts = async (texts, target, onItem) => {
    const out = new Array(texts.length).fill("");
    const uniqTexts = []; // 去重后的待翻文本
    const uniqGroups = []; // 每个待翻文本对应的原始下标（页面里重复串极多）
    const keyToUniq = new Map();
    for (let i = 0; i < texts.length; i++) {
      const key = `${texts[i]}|${target}`;
      const hit = cacheGet(key);
      if (hit !== undefined) {
        out[i] = hit;
        // 缓存命中也要通知：调用方可能正等着逐条插入
        if (onItem) onItem(i, hit);
        continue;
      }
      const seen = keyToUniq.get(key);
      if (seen !== undefined) {
        uniqGroups[seen].push(i);
        continue;
      }
      keyToUniq.set(key, uniqTexts.length);
      uniqGroups.push([i]);
      uniqTexts.push(texts[i]);
    }
    if (uniqTexts.length === 0) return out;
    // 配额熔断暂停期：直接返回原文，不发消息（补扫/观察器的重试在此被拦住）
    if (Date.now() < quotaSuspendedUntil) return out;

    // 一条译文落地：写回所有共享该文本的位置（含页面上的重复串）
    const applyValue = (uniqIdx, val) => {
      const group = uniqGroups[uniqIdx];
      if (!group) return;
      cacheSet(`${uniqTexts[uniqIdx]}|${target}`, val);
      for (const i of group) {
        out[i] = val;
        if (onItem) onItem(i, val);
      }
    };

    // 每批条数上限：控制单次 message 体积。120 条 × 平均 40 字符 ≈ 6 个拼块，
    // 恰好被 background 的并发 6 一波打完——60 条时同样 6 波却多一倍消息往返。
    // 批次超时按条数伸缩（20s + 250ms/条），120 条对应 50s 预算，足够。
    const CHUNK = 120;
    const baseId = `y${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const sendChunk = (start) => {
      const slice = uniqTexts.slice(start, start + CHUNK);
      const chunkId = `${baseId}:${start}`;
      partialHandlers.set(chunkId, {
        offset: start,
        onValue: (uniqIdx, val) => {
          if (!out[uniqGroups[uniqIdx][0]]) applyValue(uniqIdx, val);
        },
      });
      // chrome.runtime.sendMessage 在扩展上下文失效（更新/重载后的旧标签页）
      // 时会**同步抛错**，必须在调用点接住，否则整个翻译流程静默终止
      let p;
      try {
        p = chrome.runtime.sendMessage({
          type: "YUFAN_TRANSLATE_BATCH",
          // noDict：整页翻译一律走翻译通道。否则页面上的单个英文单词
          // （"Home" / "Sign in"）会被送进词典，返回英文释义而非译文。
          payload: {
            texts: slice,
            source: "auto",
            target,
            noDict: true,
            batchId: chunkId,
          },
        });
      } catch (err) {
        p = Promise.reject(err);
      }
      return p
        .then((resp) => {
          if (resp && resp.ok && resp.data && Array.isArray(resp.data.results)) {
            // 透传错误状态（配额耗尽 / 超时部分成功），给 translateBatch 决策
            lastBatchError = String(resp.data.error || "");
            lastBatchQuotaExhausted = !!resp.data.quotaExhausted;
            lastBatchRetryAfterMin = Number(resp.data.retryAfterMin) || 0;
            lastBatchRateLimited = !!resp.data.rateLimited;
            // 兜底回填：流式推送没覆盖到的（老版本 background / 推送丢失）
            for (let k = 0; k < slice.length; k++) {
              const u = start + k;
              const val = String(resp.data.results[k] || "").trim();
              if (val && !out[uniqGroups[u][0]]) applyValue(u, val);
            }
          }
          return resp;
        })
        .catch((err) => {
          // 扩展上下文失效：给出"请刷新页面"的明确提示（只提示一次），
          // 其余错误维持静默（网络抖动等由补扫机制重试）
          if (isCtxInvalidError(err)) notifyCtxInvalidated();
          return null;
        })
        .finally(() => {
          partialHandlers.delete(chunkId);
        });
    };
    // 双缓冲：等当前分片时下一分片的请求已经发出，避免"一波完再发下一波"
    let cursor = 0;
    let inflight = sendChunk(cursor);
    cursor += CHUNK;
    while (inflight) {
      await inflight;
      inflight = cursor < uniqTexts.length ? sendChunk(cursor) : null;
      cursor += CHUNK;
    }
    return out;
  };

  // 单条翻译（观察器兜底路径用），内部复用批量通道
  const translateText = async (text, target) => {
    const [r] = await translateTexts([text], target);
    return r || null;
  };

  // "紧凑型标签"宿主：链接、按钮、菜单项、徽标这类宽度固定的元素。
  // 它们的"原文 + 译文"并列显示会被 nowrap / overflow 裁掉，看起来像没翻译，
  // 因此打上标记，由 CSS 改为只显示译文（详见 content.css 的说明）。
  const TIGHT_LABEL_TAGS = new Set([
    "A", "BUTTON", "LABEL", "SUMMARY", "LEGEND", "OPTION", "OPTGROUP", "TH", "DT",
  ]);
  const TIGHT_LABEL_CLASS = `${NAMESPACE}-tight-label`;
  const isTightLabelHost = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (TIGHT_LABEL_TAGS.has(el.tagName)) return true;
    // 组件库里的紧凑标签：badge / chip / tag / 菜单项 / 标签页 / 按钮式元素
    const cls =
      (typeof el.className === "string" ? el.className : "") +
      " " +
      ((el.getAttribute && el.getAttribute("role")) || "");
    if (/\b(badge|chip|tag|pill|menu-?item|nav-?item|tab|btn|button)\b/i.test(cls)) return true;
    return false;
  };

  // 在文本节点后面插入译文
  // 方案：把原文文本节点替换成 <font>原文</font><font translate="no">译文</font>
  // 原文和译文同行显示，中间用 CSS margin-left 加间距
  const insertTranslationAfter = (textNode, translation) => {
    // 直接挂在 shadow root 下的文本节点 parentElement 为 null，
    // 回退到 parentNode（shadow root 本身也接受 insertBefore）
    const parent = textNode.parentElement || textNode.parentNode;
    if (!parent) return;
    // 紧凑型标签宿主（链接/按钮/菜单项…）打标记，CSS 改为只显示译文
    if (parent.nodeType === Node.ELEMENT_NODE && isTightLabelHost(parent) && parent.classList) {
      parent.classList.add(TIGHT_LABEL_CLASS);
    }
    // 用节点所属的 document 创建元素（兜底处理同源 iframe 时，
    // textNode 可能属于 iframe document，需用对应 doc 创建避免跨文档 adoption 问题）
    const doc = textNode.ownerDocument || document;
    // 用 <font> 包裹原文
    const originalFont = doc.createElement("font");
    originalFont.className = `${NAMESPACE}-page-original`;
    originalFont.setAttribute("data-yufan-original", "true");
    parent.insertBefore(originalFont, textNode);
    originalFont.appendChild(textNode);
    // 用 <font translate="no"> 包裹译文，紧跟在原文后面
    const transFont = doc.createElement("font");
    transFont.setAttribute("translate", "no");
    transFont.className = `${NAMESPACE}-page-translation`;
    transFont.setAttribute("data-yufan-translation", "true");
    transFont.textContent = translation;
    originalFont.after(transFont);
  };

  // 清理文本节点上的旧翻译（用于节点内容被外部修改、需要重新翻译时）
  // 移除译文兄弟节点，并把原文文本节点从 <font> 包裹器中还原。
  // 场景：复用的弹窗/tooltip 元素通过 nodeValue 修改了文本，
  // 旧译文已过期，需要清理后重新翻译。
  const cleanupNodeTranslation = (node) => {
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    const parent = node.parentElement;
    if (!parent || !parent.classList) return;
    // 仅处理被我们 <font class="yufan-page-original"> 包裹的节点
    if (!parent.classList.contains(`${NAMESPACE}-page-original`)) return;
    // 找到译文兄弟节点并移除
    const transFont = parent.nextElementSibling;
    if (
      transFont &&
      transFont.classList &&
      transFont.classList.contains(`${NAMESPACE}-page-translation`)
    ) {
      transFont.remove();
    }
    // 还原文本节点：把文本节点插到 <font> 前面，再移除 <font> 包裹器
    const grandparent = parent.parentElement;
    if (grandparent) {
      grandparent.insertBefore(node, parent);
      // 清理紧凑标签标记（该宿主可能还有别的翻译，只有全部移除后才摘标记；
      // 简化处理：摘掉标记不影响正确性——CSS 规则没有匹配的 font 时无副作用）
      if (grandparent.classList && grandparent.classList.contains(TIGHT_LABEL_CLASS)) {
        grandparent.classList.remove(TIGHT_LABEL_CLASS);
      }
      parent.remove();
    }
  };

  // 添加 CSS 动画样式，用于进度提示浮层和 loading 动效（右下角）
  const addProgressStyles = () => {
    const sr = getYufanShadowRoot();
    if (sr.querySelector(`#${NAMESPACE}-progress-styles`)) return;
    
    const style = document.createElement('style');
    style.id = `${NAMESPACE}-progress-styles`;
    style.textContent = `
      .${NAMESPACE}-page-progress {
        position: fixed;
        bottom: 20px;
        right: 20px;
        height: 40px;
        box-sizing: border-box;
        background: rgba(255, 255, 255, 0.98);
        border: 1px solid rgba(158, 179, 166, 0.3);
        border-radius: 999px;
        padding: 8px 14px 8px 10px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        color: #2a312d;
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
      }
      
      .${NAMESPACE}-page-progress-show {
        animation: ${NAMESPACE}-progress-fade-in 0.3s ease-out;
      }
      
      @keyframes ${NAMESPACE}-progress-fade-in {
        from {
          opacity: 0;
          transform: translateY(10px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      
      .${NAMESPACE}-progress-icon {
        width: 18px;
        height: 18px;
        flex-shrink: 0;
      }
      
      .${NAMESPACE}-progress-title {
        font-weight: 500;
        white-space: nowrap;
      }

      /* 错误状态：胶囊本体只显示一个红色角标，完整文案走 tooltip（见下），
         不再把长文案塞进胶囊——又丑又显示不全（用户反馈） */
      .${NAMESPACE}-progress-error-badge {
        display: none;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: #e0524f;
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        line-height: 1;
        flex-shrink: 0;
        cursor: help;
      }
      .${NAMESPACE}-page-progress.${NAMESPACE}-has-error .${NAMESPACE}-progress-error-badge {
        display: inline-flex;
      }
      .${NAMESPACE}-page-progress.${NAMESPACE}-has-error {
        border-color: rgba(224, 82, 79, 0.45);
      }

      /* 胶囊上方的提示气泡：完整错误/提示文案显示在这里 */
      .${NAMESPACE}-pill-tip {
        position: fixed;
        z-index: 2147483647;
        max-width: 300px;
        box-sizing: border-box;
        padding: 10px 12px;
        border-radius: 10px;
        background: rgba(28, 32, 30, 0.96);
        color: #f2f5f3;
        font-size: 12.5px;
        line-height: 1.6;
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
        pointer-events: none;
        opacity: 0;
        transform: translateY(4px);
        transition: opacity 0.18s ease, transform 0.18s ease;
      }
      .${NAMESPACE}-pill-tip.${NAMESPACE}-pill-tip-show {
        opacity: 1;
        transform: translateY(0);
      }

      .${NAMESPACE}-progress-spinner {
        width: 14px;
        height: 14px;
        border: 2px solid rgba(158, 179, 166, 0.3);
        border-top-color: #9eb3a6;
        border-radius: 50%;
        animation: ${NAMESPACE}-spinner 0.8s linear infinite;
        flex-shrink: 0;
      }
      
      @keyframes ${NAMESPACE}-spinner {
        to {
          transform: rotate(360deg);
        }
      }
      
      .${NAMESPACE}-progress-close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        margin-left: 2px;
        margin-right: -4px;
        border: none;
        border-radius: 50%;
        background: transparent;
        color: #6b7280;
        cursor: pointer;
        padding: 0;
        flex-shrink: 0;
        transition: background 0.15s ease, color 0.15s ease;
      }
      
      .${NAMESPACE}-progress-close:hover {
        background: rgba(158, 179, 166, 0.3);
        color: #2a312d;
      }
    `;
    getYufanShadowRoot().appendChild(style);
  };

  // 进度提示浮层 ID
  const PROGRESS_ID = "yufan-page-progress";

  // 胶囊上方的提示气泡（tooltip）。完整文案显示在这里，胶囊本体只放
  // 一个红色角标——长文案塞进胶囊又丑又显示不全（用户反馈）。
  let pillTipEl = null;
  let pillTipHideTimer = null;
  // 最后一条气泡消息：气泡隐藏后用户悬停/点击胶囊（含感叹号角标）时
  // 重新显示。必须独立于气泡 DOM 存活——自动隐藏会清掉 dataset。
  let pillTipLast = null;
  const showPillTip = (text, autoHideMs, kind = "info") => {
    if (!text) return;
    addProgressStyles();
    const sr = getYufanShadowRoot();
    const pill = sr.getElementById ? sr.getElementById(PROGRESS_ID) : sr.querySelector(`#${PROGRESS_ID}`);
    if (!pill) return;
    pillTipLast = { text: String(text), kind };
    if (!pillTipEl) {
      pillTipEl = document.createElement("div");
      pillTipEl.className = `${NAMESPACE}-pill-tip`;
      sr.appendChild(pillTipEl);
    }
    pillTipEl.textContent = text;
    pillTipEl.dataset.text = text;
    pillTipEl.dataset.kind = kind;
    // 定位在胶囊上方，右对齐（胶囊贴右下角，气泡向左展开）
    const r = pill.getBoundingClientRect();
    pillTipEl.style.visibility = "hidden";
    pillTipEl.classList.add(`${NAMESPACE}-pill-tip-show`);
    const tw = pillTipEl.offsetWidth;
    const th = pillTipEl.offsetHeight;
    const left = Math.max(8, Math.min(r.right - tw, window.innerWidth - tw - 8));
    pillTipEl.style.left = `${left}px`;
    pillTipEl.style.top = `${Math.max(8, r.top - th - 10)}px`;
    pillTipEl.style.visibility = "";
    if (pillTipHideTimer) clearTimeout(pillTipHideTimer);
    if (autoHideMs) {
      pillTipHideTimer = setTimeout(hidePillTip, autoHideMs);
    }
  };
  const hidePillTip = () => {
    if (pillTipHideTimer) {
      clearTimeout(pillTipHideTimer);
      pillTipHideTimer = null;
    }
    if (pillTipEl) {
      pillTipEl.classList.remove(`${NAMESPACE}-pill-tip-show`);
      pillTipEl.dataset.text = "";
      pillTipEl.dataset.kind = "";
    }
    // 注意：pillTipLast 不清空——用户悬停/点击胶囊时可随时重看最后一条
  };

  // 在 showProgress 函数中调用样式添加
  // 浮层常驻右下角：翻译进行中显示 loading，完成后隐藏 loading；带关闭按钮，点击恢复原文
  // loading=true 显示 spinner，loading=false 隐藏 spinner（浮层本身常驻）
  // errorText 可选：出错（配额耗尽等）时——胶囊本体只显示红色角标，完整文案
  // 以气泡形式显示在胶囊上方（自动停留 8s，悬停角标/胶囊可再看）。
  // 注意：**不显示"已翻/总数"这类统计数字**——用户明确反馈不需要，
  // 渐进式披露的推进感由译文逐批出现本身提供，数字只会添乱。
  // roundHasError：本轮（两次 showProgress(true) 之间）是否出现过错误。
  // 必须跨调用存活（模块级）：并发批次各自调用 showProgress，批次完成时
  // 要据此判断"本轮出过错，不能把错误气泡藏掉"。
  let roundHasError = false;
  const showProgress = (loading = true, errorText) => {
    // 确保样式已添加
    addProgressStyles();

    const sr = getYufanShadowRoot();
    let el = sr.getElementById ? sr.getElementById(PROGRESS_ID) : sr.querySelector(`#${PROGRESS_ID}`);
    if (!el) {
      el = document.createElement("div");
      el.id = PROGRESS_ID;
      el.className = `${NAMESPACE}-page-progress`;
      el.innerHTML = `
        <img class="${NAMESPACE}-progress-icon" src="${LOGO_URL}" alt="语翻" />
        <span class="${NAMESPACE}-progress-title">语翻</span>
        <span class="${NAMESPACE}-progress-error-badge" title="">!</span>
        <div class="${NAMESPACE}-progress-spinner"></div>
        <button class="${NAMESPACE}-progress-close" aria-label="关闭翻译" data-testid="yufan-progress-close">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      `;
      sr.appendChild(el);
      requestAnimationFrame(() => el.classList.add(`${NAMESPACE}-page-progress-show`));
      // 关闭按钮：恢复原文并关闭翻译功能
      el.querySelector(`.${NAMESPACE}-progress-close`).addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        translatePage(); // pageTranslated=true 时走恢复原文分支
      });
    } else {
      // 复用旧浮层：撤销 hideProgress 安排的移除（否则 300ms 后陈旧定时器
      // 会把正在使用的浮层删掉——"提示一闪而过/浮层中途消失"的元凶）
      delete el.dataset.yufanHiding;
    }
    if (progressRemoveTimer) {
      clearTimeout(progressRemoveTimer);
      progressRemoveTimer = null;
    }
    // 悬停/点击胶囊（含感叹号角标，事件冒泡到浮层）重新显示最后一条提示。
    // 用 on* 属性赋值：浮层被移除重建后自动重绑，也不会叠加监听器。
    // （旧实现 addEventListener 只在气泡首次创建时绑到当时的浮层上，
    // 浮层一重建监听器就丢了——表现为"悬停/点击感叹号没有任何反应"）
    el.onmouseenter = () => {
      if (pillTipLast) showPillTip(pillTipLast.text, 8000, pillTipLast.kind);
    };
    el.onmouseleave = hidePillTip;
    el.onclick = (e) => {
      // 关闭按钮有自己的 handler（stopPropagation），不会冒泡到这里
      if (pillTipLast) showPillTip(pillTipLast.text, 8000, pillTipLast.kind);
    };
    // roundHasError：本轮（两次 showProgress(true) 之间）是否出现过错误。
    // 并发批次（正文/title/attr/svg）各自调用 showProgress：
    // - 批次开始（loading=true）重置标记；
    // - 错误置位并弹气泡；
    // - 其他批次完成时若本轮出过错，**不能**把气泡藏掉——否则正文批刚弹的
    //   提示会被并行完成的批次立刻吃掉（"一闪而过"的真正机制）。
    if (loading) roundHasError = false;
    if (errorText) {
      roundHasError = true;
      el.classList.add(`${NAMESPACE}-has-error`);
      showPillTip(errorText, 15000, "error");
    } else {
      el.classList.remove(`${NAMESPACE}-has-error`);
      if (!loading && !roundHasError) {
        // 轮次干净地正常完成：清掉历史错误气泡（info 类气泡只靠自动计时消失）
        if (pillTipEl && pillTipEl.dataset.kind === "error") hidePillTip();
      }
    }
    // 切换 loading 显示状态：翻译中显示 spinner，完成后隐藏
    const spinner = el.querySelector(`.${NAMESPACE}-progress-spinner`);
    if (spinner) {
      spinner.style.display = loading ? "" : "none";
    }
  };

  // 移除所有页面翻译，恢复原文
  // 旧实现用 querySelectorAll —— 它不穿透 shadow DOM，Web Components 页面
  // （GitHub 等）取消翻译后 shadow 内的内容仍是双语。改用 walkElementsDeep
  // 深度遍历（穿透 shadow root 与同源 iframe）。
  // 注意"先收集后处理"：遍历过程中移动/删除节点会让 live 遍历错乱，
  // 必须先把所有目标元素收进静态数组，遍历结束后再统一处理。
  const removePageTranslations = () => {
    const transFonts = [];
    const origFonts = [];
    const titleEls = [];
    const attrEls = [];
    const svgTitleEls = [];
    const svgTextEls = [];
    walkElementsDeep(document.body, (el) => {
      if (!el.classList) return;
      if (el.classList.contains(`${NAMESPACE}-page-translation`)) {
        transFonts.push(el);
      } else if (el.classList.contains(`${NAMESPACE}-page-original`)) {
        origFonts.push(el);
      }
      if (el.hasAttribute && el.hasAttribute(TITLE_TRANSLATED_ATTR)) titleEls.push(el);
      if (el.hasAttribute && el.hasAttribute(ATTR_TRANSLATED_MARK)) attrEls.push(el);
      if (el.hasAttribute && el.hasAttribute(SVG_TITLE_TRANSLATED_ATTR)) svgTitleEls.push(el);
      // SVG 可见文字（<text>/<tspan>）：译文写在了 textContent 里，
      // 必须按备份属性还原，否则取消翻译后图表上残留的是译文
      if (el.hasAttribute && el.hasAttribute(SVG_TEXT_TRANSLATED_ATTR)) svgTextEls.push(el);
    });
    // 移除译文 <font>
    for (const el of transFonts) el.remove();
    // 把原文 <font> 还原成纯文本节点
    for (const el of origFonts) {
      // 用 parentNode 而非 parentElement：shadow 直挂文本的 <font> 的
      // 父节点是 shadow root（DocumentFragment），parentElement 为 null
      const parent = el.parentNode;
      if (!parent) continue;
      // 把 <font> 内的文本节点移到 <font> 外面，然后移除 <font>
      while (el.firstChild) {
        parent.insertBefore(el.firstChild, el);
      }
      el.remove();
      // 合并相邻的文本节点
      parent.normalize();
      // 摘掉紧凑标签标记（取消翻译后页面必须回到原生样式）
      if (
        parent.nodeType === Node.ELEMENT_NODE &&
        parent.classList &&
        parent.classList.contains(TIGHT_LABEL_CLASS)
      ) {
        parent.classList.remove(TIGHT_LABEL_CLASS);
      }
    }
    // 恢复 title 属性原文
    for (const el of titleEls) {
      const original = el.getAttribute(TITLE_BACKUP_ATTR);
      if (original != null) {
        el.setAttribute("title", original);
      }
      el.removeAttribute(TITLE_BACKUP_ATTR);
      el.removeAttribute(TITLE_TRANSLATED_TEXT_ATTR);
      el.removeAttribute(TITLE_TRANSLATED_ATTR);
    }
    // 恢复被翻译过的属性原文（placeholder / aria-label / alt / value / data-* 等）
    for (const el of attrEls) {
      const attrs = (el.getAttribute(ATTR_TRANSLATED_MARK) || "")
        .split(",")
        .filter(Boolean);
      for (const attr of attrs) {
        const backup = el.getAttribute(ATTR_BACKUP_PREFIX + attr);
        if (backup != null) el.setAttribute(attr, backup);
        el.removeAttribute(ATTR_BACKUP_PREFIX + attr);
        el.removeAttribute(ATTR_TRANSLATED_VAL_PREFIX + attr);
      }
      el.removeAttribute(ATTR_TRANSLATED_MARK);
    }
    // 恢复 SVG 可见文字原文（<text>/<tspan> 的译文也是写在 textContent 里）
    for (const el of svgTextEls) {
      const original = el.getAttribute(SVG_TEXT_BACKUP_ATTR);
      if (original != null) el.textContent = original;
      el.removeAttribute(SVG_TEXT_BACKUP_ATTR);
      el.removeAttribute(SVG_TEXT_TRANSLATED_ATTR);
    }
    // 恢复 SVG <title> 原文（改写的是 textContent，不是属性）
    for (const el of svgTitleEls) {
      const original = el.getAttribute(SVG_TITLE_BACKUP_ATTR);
      if (original != null) {
        el.textContent = original;
      }
      el.removeAttribute(SVG_TITLE_BACKUP_ATTR);
      el.removeAttribute(SVG_TITLE_TRANSLATED_TEXT_ATTR);
      el.removeAttribute(SVG_TITLE_TRANSLATED_ATTR);
    }
  };

  let progressRemoveTimer = null;
  const hideProgress = () => {
    const sr = getYufanShadowRoot();
    const el = sr.getElementById ? sr.getElementById(PROGRESS_ID) : sr.querySelector(`#${PROGRESS_ID}`);
    if (el) {
      el.classList.remove(`${NAMESPACE}-page-progress-show`);
      // 打上"正在隐藏"标记：300ms 定时器只删除仍带标记的浮层。
      // 若期间新一轮翻译复用了同一元素，showProgress 会摘掉标记，
      // 陈旧定时器就不会误删正在使用的浮层。
      el.dataset.yufanHiding = "true";
      if (progressRemoveTimer) clearTimeout(progressRemoveTimer);
      progressRemoveTimer = setTimeout(() => {
        progressRemoveTimer = null;
        const cur = sr.getElementById ? sr.getElementById(PROGRESS_ID) : sr.querySelector(`#${PROGRESS_ID}`);
        if (cur && cur.dataset && cur.dataset.yufanHiding === "true") {
          cur.remove();
        }
      }, 300);
    }
    hidePillTip();
  };

  // ---------- 额度恢复自动续翻 ----------
  // 配额熔断后不用让用户干等再手动点一次：background 透传了服务端告知的
  // 恢复时间（retryAfterMin），到点自动把剩余内容接着翻完。
  // 用户中途取消整页翻译（胶囊关闭按钮）则放弃续翻。
  let quotaResumeTimer = null;
  const cancelQuotaResume = () => {
    if (quotaResumeTimer) {
      clearTimeout(quotaResumeTimer);
      quotaResumeTimer = null;
    }
  };
  const formatResumeDelay = (min) => {
    if (min < 60) return `${min} 分钟`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  };
  const scheduleQuotaResume = (retryAfterMin) => {
    cancelQuotaResume();
    // 超过 3 小时（跨天窗口/疑似封禁）不设长定时器，只提示用户稍后手动重试
    if (!retryAfterMin || retryAfterMin <= 0 || retryAfterMin > 180) return;
    quotaResumeTimer = setTimeout(() => {
      quotaResumeTimer = null;
      // 用户已取消整页翻译，或新一轮翻译正在进行：放弃自动续翻
      if (!pageTranslated || pageTranslationInProgress) return;
      lastBatchError = "";
      lastBatchQuotaExhausted = false;
      lastBatchRetryAfterMin = 0;
      lastBatchRateLimited = false;
      quotaSuspendedUntil = 0; // 解除静默暂停
      showPillTip("翻译额度已恢复，正在继续翻译剩余内容…", 5000);
      Promise.resolve(translateAllVisible(pageTranslationTarget))
        .catch(() => {})
        .finally(() => {
          // 续翻完成后重启补扫：兜底剩余漏翻（首轮时仍隐藏的节点等）
          if (pageTranslated) startRescan();
        });
    }, retryAfterMin * 60 * 1000);
  };

  // 已翻译的文本节点（用 Set 以便恢复原文时清空；WeakSet 无 clear 方法，
  // 会导致第一次翻译的节点标记残留，第二次翻译时被误判为已翻译而跳过）
  let translatedNodes = new Set();

  // ---------- API 失败重试（"内容不全"的核心根因之一）----------
  // translateBatch 会在请求前就把节点加入 translatedNodes（防并发重复），
  // 一旦 background 返回失败/空结果，节点被永久标记为"已翻译"，从此再也不会
  // 重试 —— 用户看到的现象就是"整页翻译很多内容没翻"。
  // 修复：失败时把计数 +1 并从 translatedNodes 移除，让补扫/observer 重试；
  // 超过 MAX_NODE_RETRIES 次后保留标记，避免对死节点反复请求烧配额。
  let nodeFailCounts = new Map();
  const MAX_NODE_RETRIES = 3;

  // 判断文本节点所在元素是否当前可见（用于跳过隐藏弹窗内的即时翻译，
  // 交给 IntersectionObserver 在其显示后再触发，避免对隐藏 DOM 做无意义处理）
  const isTextNodeVisible = (node) => {
    // shadow 直挂文本节点 parentElement 为 null，回退到 host 元素判断可见性
    const parent = effectiveParent(node);
    if (!parent) return false;
    return isElementVisible(parent);
  };

  // ---------- 页面语言检测 ----------
  // 整页翻译前先判断页面主语言：如果页面本身就是目标语言（比如中文网页
  // 目标简体中文），逐节点翻译会全部"译出原文"，用户什么也看不到。
  // 检测交给 background 的 detectLang（与划词/弹窗共用同一套判定规则），
  // content script 只做"是否同语言"的比较与切换。
  const getZhRegion = (code) => {
    const c = String(code || "").toLowerCase();
    if (c === "zh-cn" || c === "zh-hans") return "zh-CN";
    if (c === "zh-tw" || c === "zh-hant") return "zh-TW";
    if (c === "zh-hk" || c === "zh-mo") return "zh-HK";
    if (c === "zh" || c === "chinese") return "zh-CN";
    return null;
  };
  // 同语言判定：主语言相同且（若为中文）地区也相同。
  // zh-CN vs zh-TW 不算同语言 —— 繁简互译是用户的真实需求，不能被切走。
  const sameLang = (a, b) => {
    const na = normalizeLang(a);
    const nb = normalizeLang(b);
    if (!na || !nb || na !== nb) return false;
    if (na === "zh") {
      const ra = getZhRegion(a);
      const rb = getZhRegion(b);
      return !!ra && !!rb && ra === rb;
    }
    return true;
  };

  // 采样页面可见文本（用于语言检测）
  const collectPageTextSample = (maxChars) => {
    let out = "";
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return shouldTranslateTextNode(node)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    let n;
    while ((n = walker.nextNode()) && out.length < maxChars) {
      out += " " + (n.nodeValue || "").trim();
    }
    return out.slice(0, maxChars);
  };

  // 整页翻译目标语言固定为简体中文：把页面上的其他语言统一译成中文。
  // 语言保护：仅当页面主语言已是简体中文 (zh-CN) 时返回 null 跳过，避免“译出原文”无效果。
  // 繁体中文 (zh-TW/zh-Hant/zh-HK) 仍视为“其他语言”，照常翻译为简体中文（繁简互译是合法需求）。
  const resolvePageTarget = async () => {
    // 目标语言锁定为简体中文，不做“源是中文就整页跳过”的判断：
    // 页面里只要混有外文（英文/日文/韩文等）就翻译它们；纯中文页无外文时，
    // translateAllVisible 内部会因没有可翻译节点自然跳过，无需在此提前 return。
    return "zh-CN";
  };

  // 翻译一个文本节点
  // skipHidden=true 时跳过当前不可见的节点（由 observer 后续兜底）
  const translateOneNode = async (node, target, skipHidden = false) => {
    if (translatedNodes.has(node)) return;
    const text = (node.nodeValue || "").trim();
    if (!text) return;
    if (skipHidden && !isTextNodeVisible(node)) return;
    translatedNodes.add(node);
    const translated = await translateText(text, target);
    if (translated && translated !== text) {
      insertTranslationAfter(node, translated);
      nodeFailCounts.delete(node);
    } else {
      // 翻译失败：移除标记让后续补扫有机会重试（受 MAX_NODE_RETRIES 约束）
      const fails = (nodeFailCounts.get(node) || 0) + 1;
      nodeFailCounts.set(node, fails);
      if (fails < MAX_NODE_RETRIES) translatedNodes.delete(node);
    }
  };

  // ---------- title 属性翻译 ----------
  // 备份原文用的 data 属性名（恢复原文时读取）
  const TITLE_BACKUP_ATTR = `data-${NAMESPACE}-title-original`;
  // 备份译文用的 data 属性名（用于判断 title 是否被外部覆盖、需要重译）
  const TITLE_TRANSLATED_TEXT_ATTR = `data-${NAMESPACE}-title-translated-text`;
  // 标记已翻译 title 的 data 属性名（避免重复翻译、用于恢复时定位）
  const TITLE_TRANSLATED_ATTR = `data-${NAMESPACE}-title-translated`;
  // 原文与译文的分隔符（原生 tooltip 只能显示纯文本，用分隔符做对比展示）
  const TITLE_SEPARATOR = " ｜ ";

  // 判断一个元素的 title 属性是否应该被翻译
  const shouldTranslateTitle = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (!el.hasAttribute || !el.hasAttribute("title")) return false;
    // 已经翻译过的跳过（双保险：标记或备份属性任一存在即视为已处理）
    if (el.hasAttribute(TITLE_TRANSLATED_ATTR)) return false;
    if (el.hasAttribute(TITLE_BACKUP_ATTR)) return false;
    const text = el.getAttribute("title");
    if (!text || !text.trim() || text.trim().length < 2) return false;
    if (isOwnUI(el)) return false;
    if (isNoTranslate(el)) return false;
    // 跳过特定标签内的元素（与文本节点规则一致）
    // 注意：祖先链从"父级"开始，不要把元素自身算进去 ——
    // INPUT 本身在 SKIP_TAGS 里（避免翻输入框内的文本），但表单控件
    // 自身的 title 属性是合法的原生 tooltip，必须放行（与 shouldAttrTranslate
    // 的祖先链规则对齐；旧版从 el 自身开始走，INPUT 的 tooltip 永远翻不到）
    let p = el.parentElement;
    while (p && p !== document.body) {
      if (SKIP_TAGS.has(p.tagName)) return false;
      if (p.isContentEditable) return false;
      if (isNoTranslate(p)) return false;
      p = p.parentElement;
    }
    return true;
  };

  // 判断已翻译元素的 title 是否被外部覆盖、需要重新翻译
  // 触发条件：元素已标记翻译，但当前 title 不等于我们设置的"原文 ｜ 译文"对比形式
  // （说明页面自身代码重新设置了 title，需重新翻译新内容）
  const needsRetranslateTitle = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (!el.hasAttribute(TITLE_TRANSLATED_ATTR)) return false;
    const original = el.getAttribute(TITLE_BACKUP_ATTR);
    const translatedText = el.getAttribute(TITLE_TRANSLATED_TEXT_ATTR);
    if (original == null || translatedText == null) return false;
    const current = el.getAttribute("title");
    if (current == null) return false;
    // 当前 title 仍是我们的对比形式则无需重译
    return current !== original + TITLE_SEPARATOR + translatedText;
  };

  // 收集页面内所有需要翻译 title 属性的元素（深度穿透 shadow / iframe）
  const collectAllTitleElements = () => {
    const elements = [];
    walkElementsDeep(document.body, (el) => {
      if (shouldTranslateTitle(el)) elements.push(el);
    });
    return elements;
  };

  // 批量翻译 title 属性
  // 旧实现让 concurrency 个 worker 各自遍历同一个 batch，完全靠
  // 内部的标记去重兜底 —— 纯属浪费且依赖时序。
  // 改为：先筛出待处理元素，再一次性走批量翻译通道。
  // retranslate=true 时处理已被外部覆盖、需要重新翻译的元素
  const translateTitleBatch = async (elements, target, concurrency = 4, skipHidden = false, retranslate = false) => {
    if (!elements.length) return 0;

    // 1) 筛出本轮真正要处理的元素，并读出原文
    const pending = [];
    for (const el of elements) {
      if (retranslate) {
        if (!needsRetranslateTitle(el)) continue;
        if (skipHidden && !isElementVisible(el)) continue;
        el.removeAttribute(TITLE_TRANSLATED_ATTR);
        el.removeAttribute(TITLE_BACKUP_ATTR);
        el.removeAttribute(TITLE_TRANSLATED_TEXT_ATTR);
      } else {
        if (!shouldTranslateTitle(el)) continue;
        if (skipHidden && !isElementVisible(el)) continue;
      }
      const original = el.getAttribute("title");
      if (!original) continue;
      // 先打标记，避免并发重复处理
      el.setAttribute(TITLE_TRANSLATED_ATTR, "true");
      pending.push({ el, original });
    }
    if (!pending.length) return 0;

    // 2) 分批走批量翻译通道
    let done = 0;
    const CHUNK = Math.max(concurrency * 15, 60);
    for (let s = 0; s < pending.length; s += CHUNK) {
      const slice = pending.slice(s, s + CHUNK);
      const results = await translateTexts(slice.map((p) => p.original), target);
      for (let k = 0; k < slice.length; k++) {
        const { el, original } = slice[k];
        const translated = String(results[k] || "").trim();
        if (translated && translated !== original) {
          el.setAttribute(TITLE_BACKUP_ATTR, original);
          el.setAttribute(TITLE_TRANSLATED_TEXT_ATTR, translated);
          el.setAttribute("title", original + TITLE_SEPARATOR + translated);
          done++;
        } else {
          // 未翻译成功，移除标记，下次可重试
          el.removeAttribute(TITLE_TRANSLATED_ATTR);
        }
      }
    }
    return done;
  };

  // ---------- SVG <title> 翻译（图标原生 tooltip 的另一种形态）----------
  // <svg><title>删除</title></svg> 的提示文本在 <title> 元素的 textContent 里，
  // 不是 title 属性。走普通文本管线会在 <svg> 内插 <font> 包裹器，
  // 破坏原生 tooltip 渲染，因此单独处理：直接改写 textContent 为"原文 ｜ 译文"。
  const SVG_TITLE_BACKUP_ATTR = `data-${NAMESPACE}-svg-title-original`;
  const SVG_TITLE_TRANSLATED_TEXT_ATTR = `data-${NAMESPACE}-svg-title-translated-text`;
  const SVG_TITLE_TRANSLATED_ATTR = `data-${NAMESPACE}-svg-title-translated`;

  const shouldTranslateSvgTitle = (el) => {
    if (!isSvgTitleElement(el)) return false;
    if (el.hasAttribute(SVG_TITLE_TRANSLATED_ATTR)) return false;
    if (el.hasAttribute(SVG_TITLE_BACKUP_ATTR)) return false;
    const text = (el.textContent || "").trim();
    if (!text || text.length < 2) return false;
    // 已是双语对比格式的不翻（防重复翻译）
    if (text.includes(TITLE_SEPARATOR)) return false;
    if (isNoTranslate(el)) return false;
    let p = el.parentElement;
    while (p && p !== document.body) {
      if (SKIP_TAGS.has(p.tagName)) return false;
      if (p.isContentEditable) return false;
      if (isNoTranslate(p)) return false;
      p = p.parentElement;
    }
    return true;
  };

  // 已翻译的 SVG title 被外部改写 textContent 后需要重译
  const needsRetranslateSvgTitle = (el) => {
    if (!isSvgTitleElement(el)) return false;
    if (!el.hasAttribute(SVG_TITLE_TRANSLATED_ATTR)) return false;
    const original = el.getAttribute(SVG_TITLE_BACKUP_ATTR);
    const translated = el.getAttribute(SVG_TITLE_TRANSLATED_TEXT_ATTR);
    if (original == null || translated == null) return false;
    return (el.textContent || "") !== original + TITLE_SEPARATOR + translated;
  };

  // 收集页面内所有需要翻译的 SVG <title>（穿透 shadow / iframe）
  const collectAllSvgTitleElements = () => {
    const elements = [];
    walkElementsDeep(document.body, (el) => {
      if (shouldTranslateSvgTitle(el)) elements.push(el);
    });
    return elements;
  };

  // 批量翻译 SVG <title>（结构与 translateTitleBatch 对齐）
  const translateSvgTitleBatch = async (elements, target, concurrency = 4, skipHidden = false, retranslate = false) => {
    if (!elements || !elements.length) return 0;
    const pending = [];
    for (const el of elements) {
      if (retranslate) {
        if (!needsRetranslateSvgTitle(el)) continue;
        if (skipHidden && !isElementVisible(el.parentElement)) continue;
        el.removeAttribute(SVG_TITLE_TRANSLATED_ATTR);
        el.removeAttribute(SVG_TITLE_BACKUP_ATTR);
        el.removeAttribute(SVG_TITLE_TRANSLATED_TEXT_ATTR);
      } else {
        if (!shouldTranslateSvgTitle(el)) continue;
        if (skipHidden && !isElementVisible(el.parentElement)) continue;
      }
      const original = (el.textContent || "").trim();
      if (!original) continue;
      // 先打标记，避免并发重复处理
      el.setAttribute(SVG_TITLE_TRANSLATED_ATTR, "true");
      pending.push({ el, original });
    }
    if (!pending.length) return 0;

    let done = 0;
    const CHUNK = Math.max(concurrency * 15, 60);
    for (let s = 0; s < pending.length; s += CHUNK) {
      const slice = pending.slice(s, s + CHUNK);
      const results = await translateTexts(slice.map((p) => p.original), target);
      for (let k = 0; k < slice.length; k++) {
        const { el, original } = slice[k];
        const translated = String(results[k] || "").trim();
        if (translated && translated !== original) {
          el.setAttribute(SVG_TITLE_BACKUP_ATTR, original);
          el.setAttribute(SVG_TITLE_TRANSLATED_TEXT_ATTR, translated);
          el.textContent = original + TITLE_SEPARATOR + translated;
          done++;
        } else {
          // 未翻译成功，移除标记，下次可重试
          el.removeAttribute(SVG_TITLE_TRANSLATED_ATTR);
        }
      }
    }
    return done;
  };

  // ---------- SVG 可见文字（<text> / <tspan>）专用管线 ----------
  // 与 SVG <title> 同理：不能用 <font> 包裹（SVG 里不渲染），改为改写
  // textContent 并把原文存进 data 属性，取消翻译时还原。
  const SVG_TEXT_BACKUP_ATTR = `data-${NAMESPACE}-svg-text-original`;
  const SVG_TEXT_TRANSLATED_ATTR = `data-${NAMESPACE}-svg-text-translated`;
  const shouldTranslateSvgText = (el) => {
    if (!isSvgTextElement(el) || !isSvgTextLeaf(el)) return false;
    if (el.hasAttribute(SVG_TEXT_TRANSLATED_ATTR)) return false;
    if (el.hasAttribute(SVG_TEXT_BACKUP_ATTR)) return false;
    if (isOwnUI(el)) return false;
    const text = (el.textContent || "").trim();
    if (!text || text.length < 2) return false;
    // 纯数字/符号（"1"、"%"、"→"）没有翻译价值，别浪费配额
    if (!/[A-Za-z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text)) return false;
    let p = el.parentElement;
    while (p && p !== document.body) {
      if (isNoTranslate(p)) return false;
      p = p.parentElement;
    }
    return true;
  };
  const collectAllSvgTextElements = () => {
    const elements = [];
    walkElementsDeep(document.body, (el) => {
      if (shouldTranslateSvgText(el)) elements.push(el);
    });
    return elements;
  };
  const translateSvgTextBatch = async (elements, target, concurrency = 4, skipHidden = false) => {
    if (!elements || !elements.length) return 0;
    const pending = [];
    for (const el of elements) {
      if (!shouldTranslateSvgText(el)) continue;
      if (skipHidden && !isElementVisible(el)) continue;
      const original = (el.textContent || "").trim();
      if (!original) continue;
      el.setAttribute(SVG_TEXT_TRANSLATED_ATTR, "true"); // 先打标记防并发重复
      pending.push({ el, original });
    }
    if (!pending.length) return 0;
    let done = 0;
    const CHUNK = Math.max(concurrency * 15, 60);
    for (let s = 0; s < pending.length; s += CHUNK) {
      const slice = pending.slice(s, s + CHUNK);
      const results = await translateTexts(slice.map((p) => p.original), target);
      for (let k = 0; k < slice.length; k++) {
        const { el, original } = slice[k];
        const translated = String(results[k] || "").trim();
        if (translated && translated !== original) {
          el.setAttribute(SVG_TEXT_BACKUP_ATTR, original);
          el.textContent = translated;
          done++;
        } else {
          el.removeAttribute(SVG_TEXT_TRANSLATED_ATTR); // 失败可重试
        }
      }
    }
    return done;
  };

  // 收集页面内所有需要翻译的文本节点（优先级排序）
  // 改用深度收集器：穿透 open shadow root 与同源 iframe，避免 Web Components 页面
  // 大片文本漏识别。
  const collectAllTextNodes = () => {
    const nodes = collectTextNodesDeep(document.body, (node) =>
      shouldTranslateTextNode(node) && !translatedNodes.has(node)
    );

    // 按优先级排序：标题 > 正文 > 其他
    const priorityOrder = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "span", "div", "a", "button", "label"];
    nodes.sort((a, b) => {
      const parentA = a.parentElement;
      const parentB = b.parentElement;
      if (!parentA || !parentB) return 0;

      const tagA = parentA.tagName.toLowerCase();
      const tagB = parentB.tagName.toLowerCase();

      const indexA = priorityOrder.indexOf(tagA);
      const indexB = priorityOrder.indexOf(tagB);

      if (indexA === -1 && indexB === -1) return 0;
      if (indexA === -1) return 1;
      if (indexB === -1) return -1;

      return indexA - indexB;
    });

    return nodes;
  };

  // 收集页面内所有需要翻译的元素（用于动态内容；深度穿透 shadow / iframe）
  const collectAllElements = () => {
    const elements = [];
    walkElementsDeep(document.body, (el) => {
      if (shouldTranslateElement(el)) elements.push(el);
    });
    return elements;
  };

  // 批量翻译文本节点
  // 旧实现让 concurrency 个 worker 各自遍历同一个 batch，靠 translateOneNode
  // 里的 translatedNodes 标记去重兜底 —— 每个节点都被重复检查 N 次，
  // 而且一旦某个 worker 抢先就会打乱处理顺序。改为"先收集、再批量"。
  // skipHidden=true 时跳过当前隐藏节点（交给 observer 后续兜底），
  // 避免对隐藏弹窗/下拉做无意义处理导致 DOM 闪烁
  const translateBatch = async (nodes, target, concurrency = 4, skipHidden = false) => {
    if (!nodes.length) return 0;

    // 1) 收集本轮待翻译的节点（跳过已处理 / 隐藏 / 空白）
    const pending = [];
    for (const node of nodes) {
      if (translatedNodes.has(node)) continue;
      const text = (node.nodeValue || "").trim();
      if (!text) continue;
      if (skipHidden && !isTextNodeVisible(node)) continue;
      translatedNodes.add(node);
      pending.push({ node, text });
    }
    if (!pending.length) return 0;

    // 配额熔断暂停期：整批直接空转（不发消息、不弹进度），防止"失败→重试→
    // 失败"循环反复触发 showProgress 把提示气泡折腾得一闪一闪
    if (Date.now() < quotaSuspendedUntil) return 0;

    showProgress(true);
    // 清掉上一批的陈旧错误状态：若某批请求网络异常没有响应，残留的
    // quotaExhausted=true 会让本批在结尾被误判为"配额耗尽"而熔断
    lastBatchError = "";
    lastBatchQuotaExhausted = false;
    lastBatchRetryAfterMin = 0;
    lastBatchRateLimited = false;

    let done = 0;

    // ---- 不做任何"量控"：整批一次交给 background，回来一条插一条 ----
    // 旧实现（固定 150 一批、慢启动 24→48→…）是"等整块翻完才插入"：
    // 用户要熬完一整块的 RTT 才看到第一条译文。现在 background 每翻完
    // 一个桶就推回来，onItem 里当场插入 DOM——真正的"翻译一条显示一条"。
    // 唯一保留的排序优化是"视口内优先"，它只影响谁先被发出请求。
    const vh = (typeof window !== "undefined" && window.innerHeight) || 800;
    const inViewport = (node) => {
      const el = node.parentElement;
      if (!el || typeof el.getBoundingClientRect !== "function") return false;
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh;
    };
    // 只读 getBoundingClientRect（不与写操作交错，浏览器会批量布局，不会抖动）
    pending.sort(
      (a, b) => (inViewport(b.node) ? 1 : 0) - (inViewport(a.node) ? 1 : 0)
    );

    const inserted = new Set();
    const results = await translateTexts(
      pending.map((p) => p.text),
      target,
      (i, val) => {
        const { node, text } = pending[i] || {};
        if (!node || inserted.has(node)) return;
        if (!val || val === text) return;
        // 译文一到就插入：不等整批、不等同批其他条目
        insertTranslationAfter(node, val);
        nodeFailCounts.delete(node);
        inserted.add(node);
        done++;
      }
    );

    // 兜底：流式推送没覆盖到的条目（老版本 background / 推送丢失）在这里补齐
    for (let k = 0; k < pending.length; k++) {
      const { node, text } = pending[k];
      if (inserted.has(node)) continue;
      const translated = String(results[k] || "").trim();
      if (translated && translated !== text) {
        insertTranslationAfter(node, translated);
        nodeFailCounts.delete(node);
        inserted.add(node);
        done++;
      } else {
        // 翻译失败（空结果/网络错误）：把节点从已翻译集合移除，
        // 让补扫调度器和 observer 有机会重试；超过上限则放弃，
        // 避免死循环请求烧配额（title/属性批次已有同等机制，这里对齐）
        if (lastBatchRateLimited && !lastBatchQuotaExhausted) {
          // 频率限流是暂时性失败：不计入失败次数（否则限流几轮就把节点
          // 判死，限流恢复后也没人再翻它们），交给补扫自动重试
          translatedNodes.delete(node);
        } else {
          const fails = (nodeFailCounts.get(node) || 0) + 1;
          nodeFailCounts.set(node, fails);
          if (fails < MAX_NODE_RETRIES) translatedNodes.delete(node);
        }
      }
    }

    // 频率限流（暂时性）：不熔断整页。失败节点已在上面去标记，
    // 由补扫调度器退避后自动重试；给用户一条 info 提示即可。
    if (lastBatchRateLimited && !lastBatchQuotaExhausted) {
      showProgress(false);
      showPillTip("翻译请求过于频繁，已自动降速，稍后自动重试剩余内容", 8000);
      return done;
    }

    // 配额熔断：background 明确说"额度耗尽"时告诉用户原因；
    // 服务端给了恢复时间（≤3 小时）则到点自动续翻剩余内容
    if (lastBatchQuotaExhausted) {
      let msg = lastBatchError || "今日免费翻译额度已用完";
      // 暂停期时长：优先用服务端恢复时间；没有则 10 分钟探测一次
      const waitMin =
        lastBatchRetryAfterMin > 0 && lastBatchRetryAfterMin <= 180
          ? lastBatchRetryAfterMin
          : 10;
      if (!lastBatchError && lastBatchRetryAfterMin > 0) {
        msg += `（约 ${formatResumeDelay(lastBatchRetryAfterMin)} 后恢复）`;
      }
      msg += "，恢复后将自动继续翻译剩余内容";
      // 关键：把没翻完的节点摘掉"已翻译"标记并清失败计数——否则自动续翻
      // 重新收集时它们被当成已翻译直接跳过，续翻沦为空转（2.3.3 回归根因）。
      for (const { node } of pending) {
        if (!inserted.has(node)) {
          translatedNodes.delete(node);
          nodeFailCounts.delete(node);
        }
      }
      // 进入静默暂停期：期间补扫/观察器空转（不发消息、不闪提示），
      // 到点由自动续翻解除并把剩余内容翻完
      quotaSuspendedUntil = Date.now() + waitMin * 60 * 1000;
      showProgress(false, msg);
      scheduleQuotaResume(waitMin);
      return done;
    }
    // 翻译完成：隐藏 loading（浮层+关闭按钮常驻）
    showProgress(false);
    return done;
  };

  // 翻译整个页面所有可见文本
  // 首轮只翻译当前可见节点（skipHidden=true），隐藏弹窗/下拉交给 observer 兜底，
  // 避免对隐藏 DOM 做无意义处理导致 DOM 闪烁、loading 频闪
  const translateAllVisible = async (target) => {
    // 采用异步扫描，避免阻塞主线程导致掉帧
    const textNodes = await collectTextNodesDeepAsync(document.body, (node) =>
      shouldTranslateTextNode(node) && !translatedNodes.has(node)
    );

    // 简单排序不需要异步
    const priorityOrder = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "span", "div", "a", "button", "label"];
    textNodes.sort((a, b) => {
      const parentA = a.parentElement;
      const parentB = b.parentElement;
      if (!parentA || !parentB) return 0;
      const indexA = priorityOrder.indexOf(parentA.tagName.toLowerCase());
      const indexB = priorityOrder.indexOf(parentB.tagName.toLowerCase());
      if (indexA === -1 && indexB === -1) return 0;
      if (indexA === -1) return 1;
      if (indexB === -1) return -1;
      return indexA - indexB;
    });

    const titleElements = [];
    await walkElementsDeepAsync(document.body, (el) => {
      if (shouldTranslateTitle(el)) titleElements.push(el);
    });

    const svgTitleElements = [];
    await walkElementsDeepAsync(document.body, (el) => {
      if (shouldTranslateSvgTitle(el)) svgTitleElements.push(el);
    });

    const attrTargets = [];
    await walkElementsDeepAsync(document.body, (el) => {
      for (const attr of TRANSLATE_ATTRS) {
        if (shouldAttrTranslate(el, attr)) attrTargets.push({ el, attr });
      }
    });

    const svgTextElements = [];
     await walkElementsDeepAsync(document.body, (el) => {
       if (shouldTranslateSvgText(el)) svgTextElements.push(el);
     });

     // 并发翻译文本节点、title 属性、SVG title 与可见属性，互不阻塞
     const tasks = [];
     if (textNodes.length > 0) {
       tasks.push(translateBatch(textNodes, target, 5, true));
     }
     if (titleElements.length > 0) {
       tasks.push(translateTitleBatch(titleElements, target, 4, true));
     }
     if (svgTitleElements.length > 0) {
       tasks.push(translateSvgTitleBatch(svgTitleElements, target, 4, true));
     }
     if (svgTextElements.length > 0) {
       tasks.push(translateSvgTextBatch(svgTextElements, target, 4, true));
     }
     if (attrTargets.length > 0) {
       tasks.push(translateAttrBatch(attrTargets, target, 4, true));
     }
    if (tasks.length === 0) return;
    await Promise.all(tasks);
  };

  // 执行页面翻译
  let pageObserver = null;
  let pageMutationObserver = null;
  // 节流 timer 用独立变量保存，不能挂到 observer 实例上
  // （原生 IntersectionObserver/MutationObserver 实例不允许自定义属性赋值，
  //  且 disconnect 后引用会被置 null，再赋值会抛 Cannot set properties of null）
  let intersectionThrottleTimer = null;
  let mutationThrottleTimer = null;
  // 暂存节流期间累积的新节点，避免丢失
  let mutationPendingNodes = [];

  // 观察新元素进入视窗（轻量版）
  // 用于兜底：首轮跳过的隐藏节点（弹窗/下拉内部），在其显示后触发翻译。
  // 现改为深度遍历，穿透 shadow root 与 iframe，并补全属性翻译。
  // 节流期间累积的待处理目标。**必须放在回调外累积**：旧实现把收集结果
  // 存在回调内的局部变量里，一旦节流 timer 已在跑，这一批 entry 收集到的
  // 内容就被直接丢弃了——连续滚动/快速展开时 IO 每帧都回调，而节流窗口
  // 是 200ms，绝大多数 entry 因此永久漏翻（动态内容"支持欠缺"的主因）。
  const ioPendingNodes = new Set();
  const ioPendingTitles = new Set();
  const ioPendingSvgTitles = new Set();
  const ioPendingSvgTexts = new Set();
  // 按元素对象分组（不能用模板字符串拼 key：DOM 元素会被 stringify 成
  // "[object HTMLDivElement]"，同类元素会互相覆盖）
  const ioPendingAttrs = new Map(); // el -> Set(attr)
  const addPendingAttr = (el, attr) => {
    let set = ioPendingAttrs.get(el);
    if (!set) {
      set = new Set();
      ioPendingAttrs.set(el, set);
    }
    set.add(attr);
  };
  const flushIoPending = () => {
    if (intersectionThrottleTimer) return; // 已有待执行的 flush，合并进那一批
    intersectionThrottleTimer = setTimeout(() => {
      intersectionThrottleTimer = null;
      const nodes = [...ioPendingNodes];
      const titles = [...ioPendingTitles];
      const svgTitles = [...ioPendingSvgTitles];
      const attrs = [];
      ioPendingAttrs.forEach((set, el) => {
        set.forEach((attr) => attrs.push({ el, attr }));
      });
      ioPendingNodes.clear();
      ioPendingTitles.clear();
      ioPendingSvgTitles.clear();
      ioPendingAttrs.clear();
      // 此时节点已进入视窗，skipHidden=false 直接翻译
      const tasks = [];
      if (nodes.length > 0) tasks.push(translateBatch(nodes, pageTranslationTarget, 3, false));
      if (titles.length > 0) tasks.push(translateTitleBatch(titles, pageTranslationTarget, 3, false));
      if (svgTitles.length > 0) tasks.push(translateSvgTitleBatch(svgTitles, pageTranslationTarget, 3, false));
      if (ioPendingSvgTexts.size > 0) {
        const svgTexts = [...ioPendingSvgTexts];
        ioPendingSvgTexts.clear();
        tasks.push(translateSvgTextBatch(svgTexts, pageTranslationTarget, 3, false));
      }
      if (attrs.length > 0) tasks.push(translateAttrBatch(attrs, pageTranslationTarget, 3, false));
      if (tasks.length > 0) Promise.all(tasks).catch(() => {});
    }, 120);
  };

  const setupIntersectionObserver = () => {
    pageObserver = new IntersectionObserver(
      (entries) => {
        if (!pageTranslated) return;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target;
          // 目标元素自身的 title / SVG title / 属性也要检查
          // （walkElementsDeep 只遍历子元素，不含根自身）
          if (shouldTranslateTitle(el)) ioPendingTitles.add(el);
          if (shouldTranslateSvgTitle(el)) ioPendingSvgTitles.add(el);
          if (shouldTranslateSvgText(el)) ioPendingSvgTexts.add(el);
          for (const attr of TRANSLATE_ATTRS) {
            if (shouldAttrTranslate(el, attr)) addPendingAttr(el, attr);
          }
          // 深度收集元素子树内的文本节点（穿透 shadow）
          collectTextNodesDeep(el, (node) =>
            shouldTranslateTextNode(node) && !translatedNodes.has(node)
          ).forEach((n) => ioPendingNodes.add(n));
          // 深度收集子树内的 title / SVG title 与可翻译属性（穿透 shadow）
          walkElementsDeep(el, (sub) => {
            if (shouldTranslateTitle(sub)) ioPendingTitles.add(sub);
            if (shouldTranslateSvgTitle(sub)) ioPendingSvgTitles.add(sub);
            if (shouldTranslateSvgText(sub)) ioPendingSvgTexts.add(sub);
            for (const attr of TRANSLATE_ATTRS) {
              if (shouldAttrTranslate(sub, attr)) addPendingAttr(sub, attr);
            }
          });
        }
        flushIoPending();
      },
      { rootMargin: "600px" }
    );
    // 观察所有"可能含可翻译内容"的元素（含 shadow / iframe 内部），
    // 用廉价判断（是否有文本子节点 / title / 可翻译属性）避免无谓开销。
    const observeIfNeeded = (el) => {
      // 我们注入的 <font> 包裹器不要再观察：IntersectionObserver 的观察列表
      // 会随每次插入译文无限增长，回调里又只能靠 translatedNodes 过滤掉，
      // 属于纯浪费（旧实现在长页面上会累积上千个无意义的观察目标）。
      if (isOwnUI(el)) return;
      const hasTitle = el.hasAttribute && el.hasAttribute("title");
      const hasAttr = TRANSLATE_ATTRS.some((a) => el.hasAttribute && el.hasAttribute(a));
      // el 自身是 SVG <title>（图标 tooltip）也要观察
      const hasSvgTitle = isSvgTitleElement(el);
      let hasText = false;
      const kids = el.childNodes;
      if (kids) {
        for (let i = 0; i < kids.length; i++) {
          const c = kids[i];
          if (c.nodeType === Node.TEXT_NODE && c.nodeValue && c.nodeValue.trim()) {
            hasText = true;
            break;
          }
        }
      }
      // 含 shadow root 的自定义组件（如 GitHub 的 tool-tip）：文本在 shadow 内，
      // light DOM 无文本子节点，仅靠上面的 hasText 会漏掉，导致组件不被观察、
      // hover 显示的 tooltip 永远不翻译。这里把 shadow 组件也纳入观察，
      // IntersectionObserver 回调会穿透 shadow 深度收集其文本。
      const hasShadow = !!getShadowRoot(el);
      if (hasTitle || hasAttr || hasText || hasShadow || hasSvgTitle) {
        try { pageObserver.observe(el); } catch (_) {}
      }
    };
    walkElementsDeep(document.body, observeIfNeeded);
  };

  // 监听 DOM 变化（新加载的内容，极速版）
  // 新增节点：可见的立即翻译，不可见的加入 IntersectionObserver 兜底
  // 属性变化：监听 title / placeholder / aria-label / alt 被动态设置/修改
  // 同时穿透 shadow root：发现 open shadow root 就挂一个子 MutationObserver。
  const observedShadows = new WeakSet();
  const attachShadowObserver = (sr) => {
    if (!sr || observedShadows.has(sr)) return;
    observedShadows.add(sr);
    try {
      new MutationObserver(onPageMutations).observe(sr, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: MUTATION_ATTR_FILTER,
        characterData: true,
      });
    } catch (_) {}
  };
  const attachShadowObserversDeep = (root) => {
    walkElementsDeep(root, (el) => {
      const sr = getShadowRoot(el);
      if (sr) attachShadowObserver(sr);
    });
  };

  // 复用的 DOM 变化回调（document.body 与各 shadow root 共用）
  const onPageMutations = (mutations) => {
    if (!pageTranslated) return;
    // 暂存本轮需要翻译 title 的元素（去重）
    const titlePending = new Set();
    // 暂存本轮需要重译 title 的元素（已被外部覆盖）
    const titleRetranslate = new Set();
    // 暂存本轮需要翻译的属性（placeholder / aria-label / alt / value）
    const attrPending = new Set();
    // 暂存本轮需要重译的属性（已被外部覆盖）
    const attrRetranslate = new Set();
    // 暂存本轮需要重译的文本节点（已翻译但内容被外部修改）
    const charDataRetranslate = new Set();
    // 暂存本轮需要翻译的 SVG <title>（图标原生 tooltip）
    const svgTitlePending = new Set();
    const svgTextPending = new Set();
    // 暂存本轮需要重译的 SVG <title>（textContent 被外部改写）
    const svgTitleRetranslate = new Set();
    for (const m of mutations) {
      // 处理新增节点
      for (const node of m.addedNodes) {
        // 直接添加的文本节点（textContent / createTextNode+appendChild / 框架渲染）
        // 旧代码只处理 ELEMENT_NODE，导致弹窗/下拉通过 textContent 设置的纯文本被跳过
        if (node.nodeType === Node.TEXT_NODE) {
          // 统一排队：可见与否在节流 flush 里判定（可见的立即翻，隐藏的交给 IO）
          if (shouldTranslateTextNode(node) && !translatedNodes.has(node)) {
            mutationPendingNodes.push(node);
          }
          continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        // 跳过我们自己的 UI
        if (isOwnUI(node)) continue;
        // 深度收集新元素内（含 shadow）的文本节点
        const newText = collectTextNodesDeep(node, (n) =>
          shouldTranslateTextNode(n) && !translatedNodes.has(n)
        );
        // 统一排队：可见与否在节流 flush 里判定（旧实现在这里会为每个新增
        // 元素单独发一批请求，React 一次渲染就是几十个消息；可见性判定
        // 也要等 flush 时才准——刚插入的节点往往还没布局完）
        for (const n of newText) mutationPendingNodes.push(n);
        // 深度收集新元素子树内的 title / SVG title 与属性（穿透 shadow）
        const titleList = [];
        const svgTitleList = [];
        const svgTextList = [];
        const attrList = [];
        walkElementsDeep(node, (sub) => {
          if (shouldTranslateTitle(sub)) titleList.push(sub);
          if (shouldTranslateSvgTitle(sub)) svgTitleList.push(sub);
          if (shouldTranslateSvgText(sub)) svgTextList.push(sub);
          for (const attr of TRANSLATE_ATTRS) {
            if (shouldAttrTranslate(sub, attr)) attrList.push({ el: sub, attr });
          }
        });
        for (const t of titleList) titlePending.add(t);
        for (const t of svgTitleList) svgTitlePending.add(t);
        for (const t of svgTextList) svgTextPending.add(t);
        for (const a of attrList) attrPending.add(a);
        // 把新元素加入 IntersectionObserver，隐藏内容显示后兜底翻译
        if (pageObserver && !isOwnUI(node)) {
          try { pageObserver.observe(node); } catch (_) {}
        }
        // 给新元素内部的 shadow root 挂子观察器，捕获 shadow 内的动态内容
        attachShadowObserversDeep(node);
        // 新元素自身的 shadow root 也要挂观察器（walkElementsDeep 只覆盖子孙的 shadow）
        const nodeShadow = getShadowRoot(node);
        if (nodeShadow) attachShadowObserver(nodeShadow);
      }
      // 处理属性变化（动态设置/修改 title / placeholder / aria-label / alt / value）
      if (m.type === "attributes") {
        const el = m.target;
        if (!el || el.nodeType !== Node.ELEMENT_NODE) continue;
        if (m.attributeName === "title") {
          if (shouldTranslateTitle(el)) titlePending.add(el);
          else if (needsRetranslateTitle(el)) titleRetranslate.add(el);
        } else if (TRANSLATE_ATTRS.includes(m.attributeName)) {
          if (shouldAttrTranslate(el, m.attributeName)) {
            attrPending.add({ el, attr: m.attributeName });
          } else if (needsRetranslateAttr(el, m.attributeName)) {
            attrRetranslate.add({ el, attr: m.attributeName });
          }
        }
      }
      // 处理文本内容变化（动态数据 textContent / innerText 更新，AJAX 填充场景）
      if (m.type === "characterData") {
        const node = m.target;
        if (node && node.nodeType === Node.TEXT_NODE) {
          const parent = effectiveParent(node);
          if (!parent || isOwnUI(parent)) continue;
          // SVG <title> 内的文本被外部修改（图标 tooltip 动态更新）：
          // 交给 SVG title 重译管线处理（改写的是整个 textContent）
          if (isSvgTitleElement(parent)) {
            if (parent.hasAttribute(SVG_TITLE_TRANSLATED_ATTR)) {
              svgTitleRetranslate.add(parent);
            } else if (shouldTranslateSvgTitle(parent)) {
              svgTitlePending.add(parent);
            }
            continue;
          }
          if (!shouldTranslateTextNode(node)) continue;
          if (!translatedNodes.has(node)) {
            // 新文本节点（未翻译过），累积到节流批处理
            mutationPendingNodes.push(node);
          } else {
            // 已翻译的节点内容被外部修改（复用的弹窗/tooltip 场景）：
            // 清理旧译文，从已翻译集合移除，重新排队翻译。
            // 注意：insertTranslationAfter 不修改 nodeValue（仅包裹+插入兄弟节点），
            // 所以我们的翻译不会触发 characterData → 无循环风险。
            charDataRetranslate.add(node);
          }
        }
      }
    }
    // 处理已翻译节点的重新翻译（内容被外部修改）
    if (charDataRetranslate.size > 0) {
      for (const node of charDataRetranslate) {
        cleanupNodeTranslation(node);
        translatedNodes.delete(node);
        mutationPendingNodes.push(node);
      }
    }
    // 立即翻译可见元素的 title（弹窗/下拉打开时的关键路径）
    if (titlePending.size > 0) {
      const visibleTitles = [];
      const hiddenTitles = [];
      for (const el of titlePending) {
        if (isElementVisible(el)) visibleTitles.push(el);
        else hiddenTitles.push(el);
      }
      if (visibleTitles.length > 0) {
        translateTitleBatch(visibleTitles, pageTranslationTarget, 4, false);
      }
      if (pageObserver && hiddenTitles.length > 0) {
        hiddenTitles.forEach((el) => pageObserver.observe(el));
      }
    }
    // 处理被外部覆盖、需要重译的 title
    if (titleRetranslate.size > 0) {
      const visibleRetranslate = [];
      const hiddenRetranslate = [];
      for (const el of titleRetranslate) {
        if (isElementVisible(el)) visibleRetranslate.push(el);
        else hiddenRetranslate.push(el);
      }
      if (visibleRetranslate.length > 0) {
        translateTitleBatch(visibleRetranslate, pageTranslationTarget, 4, false, true);
      }
      if (pageObserver && hiddenRetranslate.length > 0) {
        hiddenRetranslate.forEach((el) => pageObserver.observe(el));
      }
    }
    // 立即翻译可见元素的 SVG <title>（图标 tooltip 关键路径）
    if (svgTitlePending.size > 0) {
      const visibleSvg = [];
      const hiddenSvg = [];
      for (const el of svgTitlePending) {
        if (isElementVisible(el.parentElement)) visibleSvg.push(el);
        else hiddenSvg.push(el);
      }
      if (visibleSvg.length > 0) {
        translateSvgTitleBatch(visibleSvg, pageTranslationTarget, 4, false);
      }
      if (pageObserver && hiddenSvg.length > 0) {
        hiddenSvg.forEach((el) => pageObserver.observe(el));
      }
    }
    // 立即翻译新增的 SVG 可见文字（图表轴标签 / 图例）
    if (svgTextPending.size > 0) {
      const visibleSvgText = [];
      const hiddenSvgText = [];
      for (const el of svgTextPending) {
        if (isElementVisible(el)) visibleSvgText.push(el);
        else hiddenSvgText.push(el);
      }
      if (visibleSvgText.length > 0) {
        translateSvgTextBatch(visibleSvgText, pageTranslationTarget, 4, false).catch(() => {});
      }
      if (pageObserver && hiddenSvgText.length > 0) {
        hiddenSvgText.forEach((el) => {
          try { pageObserver.observe(el); } catch (_) {}
        });
      }
    }
    // 处理被外部改写、需要重译的 SVG <title>
    if (svgTitleRetranslate.size > 0) {
      const visibleSvg = [];
      const hiddenSvg = [];
      for (const el of svgTitleRetranslate) {
        if (isElementVisible(el.parentElement)) visibleSvg.push(el);
        else hiddenSvg.push(el);
      }
      if (visibleSvg.length > 0) {
        translateSvgTitleBatch(visibleSvg, pageTranslationTarget, 4, false, true);
      }
      if (pageObserver && hiddenSvg.length > 0) {
        hiddenSvg.forEach((el) => pageObserver.observe(el));
      }
    }
    // 立即翻译可见元素的属性（placeholder / aria-label / alt / value）
    if (attrPending.size > 0) {
      const visibleAttrs = [];
      const hiddenAttrs = [];
      for (const { el, attr } of attrPending) {
        if (isElementVisible(el)) visibleAttrs.push({ el, attr });
        else hiddenAttrs.push({ el, attr });
      }
      if (visibleAttrs.length > 0) {
        translateAttrBatch(visibleAttrs, pageTranslationTarget, 4, false);
      }
      if (pageObserver && hiddenAttrs.length > 0) {
        hiddenAttrs.forEach(({ el }) => pageObserver.observe(el));
      }
    }
    // 处理被外部覆盖、需要重译的属性
    if (attrRetranslate.size > 0) {
      const visibleAttrs = [];
      const hiddenAttrs = [];
      for (const { el, attr } of attrRetranslate) {
        if (isElementVisible(el)) visibleAttrs.push({ el, attr });
        else hiddenAttrs.push({ el, attr });
      }
      if (visibleAttrs.length > 0) {
        // 清除旧翻译标记，按新属性值重新翻译
        for (const { el, attr } of visibleAttrs) {
          clearAttrTranslationMark(el, attr);
        }
        translateAttrBatch(visibleAttrs, pageTranslationTarget, 4, false);
      }
      if (pageObserver && hiddenAttrs.length > 0) {
        hiddenAttrs.forEach(({ el }) => pageObserver.observe(el));
      }
    }
    // 节流批处理（用独立变量，不挂到 observer 实例上）
    if (mutationPendingNodes.length > 0 && !mutationThrottleTimer) {
      mutationThrottleTimer = setTimeout(() => {
        mutationThrottleTimer = null;
        const pending = mutationPendingNodes;
        mutationPendingNodes = [];
        const visibleNow = [];
        const stillHidden = [];
        for (const n of pending) {
          if (isTextNodeVisible(n)) visibleNow.push(n);
          else stillHidden.push(n);
        }
        // 可见的立即翻译
        if (visibleNow.length > 0) {
          translateBatch(visibleNow, pageTranslationTarget, 4, false).catch(() => {});
        }
        // 仍隐藏的：不能"跳过就算了"，否则它们永远没人再管（旧实现正是如此，
        // 表现为动态加载的隐藏区块滚出来后一片未翻译）。交给 IO：
        // 等其宿主元素真正可见时触发翻译。
        if (pageObserver) {
          for (const n of stillHidden) {
            const p = effectiveParent(n);
            if (!p) continue;
            try { pageObserver.observe(p); } catch (_) {}
          }
        }
      }, 120);
    }
  };

  const setupMutationObserver = () => {
    pageMutationObserver = new MutationObserver(onPageMutations);
    pageMutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: MUTATION_ATTR_FILTER,
      characterData: true,
    });
    // 首轮也给已存在的 shadow root 挂观察器
    attachShadowObserversDeep(document.body);
  };

  // ---------- 补扫调度器（"内容不全"的兜底防线）----------
  // 首轮翻译和 observer 都可能漏内容：API 失败的节点（已配合重试机制移除标记）、
  // 慢渲染框架（React 异步 hydration 后才出现的文本）、收集时机早于数据填充的
  // 节点等。定期补扫"仍未翻译"的目标做兜底。
  // 退避节奏：1s / 2s / 4s / 8s 各一次，之后每 10s 常驻，直到取消整页翻译。
  let rescanTimer = null;
  let rescanStep = 0;
  // 连续多少轮"一条新译文都没产生"就停止常驻补扫。
  // 旧实现每 10s 无条件全页深度遍历、永不停止：长开的页面上这是持续的
  // CPU / 主线程开销（大页面单次 walkElementsDeep 可达数万节点），
  // 而它兜底的场景（慢渲染、API 失败重试）在几轮内就会收敛。
  // 之后的新内容由 MutationObserver + IntersectionObserver 接管，不会漏。
  let rescanIdleRounds = 0;
  const RESCAN_MAX_IDLE = 4;
  const RESCAN_SCHEDULE = [1000, 2000, 4000, 8000];
  const RESCAN_INTERVAL = 10000;

  // 清理已被页面移除的节点引用。
  // translatedNodes 是强引用 Set：SPA 反复增删 DOM（虚拟列表、路由切换）时，
  // 被删掉的文本节点仍被它持有，连同整棵子树都无法被 GC —— 典型内存泄漏。
  // nodeFailCounts（Map）同理。只在超过阈值时才扫，避免每轮 O(n)。
  const PRUNE_THRESHOLD = 500;
  const pruneDetachedNodes = () => {
    if (translatedNodes.size >= PRUNE_THRESHOLD) {
      for (const node of translatedNodes) {
        if (!node.isConnected) translatedNodes.delete(node);
      }
    }
    if (nodeFailCounts.size >= PRUNE_THRESHOLD) {
      for (const node of nodeFailCounts.keys()) {
        if (!node.isConnected) nodeFailCounts.delete(node);
      }
    }
  };

  const runRescan = async () => {
    if (!pageTranslated) return;
    let produced = 0;
    try {
      pruneDetachedNodes();
      // 各收集器内部已按"未翻译"过滤，已翻译内容不会重复处理
      const textNodes = collectAllTextNodes();
      const titleElements = collectAllTitleElements();
      const svgTitleElements = collectAllSvgTitleElements();
      const attrTargets = collectAttrTargets(document.body);
      const tasks = [];
      if (textNodes.length > 0) tasks.push(translateBatch(textNodes, pageTranslationTarget, 4, true));
      if (titleElements.length > 0) tasks.push(translateTitleBatch(titleElements, pageTranslationTarget, 3, true));
      if (svgTitleElements.length > 0) tasks.push(translateSvgTitleBatch(svgTitleElements, pageTranslationTarget, 3, true));
      const svgTextElements = collectAllSvgTextElements();
      if (svgTextElements.length > 0) tasks.push(translateSvgTextBatch(svgTextElements, pageTranslationTarget, 3, true));
      if (attrTargets.length > 0) tasks.push(translateAttrBatch(attrTargets, pageTranslationTarget, 3, true));
      if (tasks.length > 0) {
        // 各翻译函数返回"本轮实际写入的译文条数"，用于判断补扫是否已收敛。
        // 注意不能拿待处理数量判断：页面上的隐藏节点（菜单/对话框）永远
        // 会被收集到、又永远被 skipHidden 跳过，数量恒 > 0，会导致补扫永不停止。
        const counts = await Promise.all(tasks);
        produced = counts.reduce((s, n) => s + (Number(n) || 0), 0);
      }
    } catch (_) {
      // 补扫失败不影响后续调度
    }
    if (produced > 0) rescanIdleRounds = 0;
    else rescanIdleRounds += 1;
    if (rescanIdleRounds >= RESCAN_MAX_IDLE) {
      // 已收敛：停止常驻补扫。后续新内容由 observer 兜底。
      rescanTimer = null;
      return;
    }
    scheduleRescan();
  };

  const scheduleRescan = () => {
    if (!pageTranslated) return;
    const delay = rescanStep < RESCAN_SCHEDULE.length ? RESCAN_SCHEDULE[rescanStep] : RESCAN_INTERVAL;
    rescanStep += 1;
    rescanTimer = setTimeout(runRescan, delay);
  };

  const startRescan = () => {
    stopRescan();
    rescanStep = 0;
    rescanIdleRounds = 0;
    scheduleRescan();
  };

  const stopRescan = () => {
    if (rescanTimer) {
      clearTimeout(rescanTimer);
      rescanTimer = null;
    }
  };

  const translatePage = async () => {
    // 如果已经翻译过，则恢复原文
    if (pageTranslated) {
      removePageTranslations();
      pageTranslated = false;
      pageTranslationInProgress = false;
      // 停止所有观察与补扫
      if (pageObserver) {
        pageObserver.disconnect();
        pageObserver = null;
      }
      if (pageMutationObserver) {
        pageMutationObserver.disconnect();
        pageMutationObserver = null;
      }
      stopRescan();
      // 取消"额度恢复自动续翻"——用户主动关掉了翻译，到点不要再翻
      cancelQuotaResume();
      quotaSuspendedUntil = 0;
      if (intersectionThrottleTimer) {
        clearTimeout(intersectionThrottleTimer);
        intersectionThrottleTimer = null;
      }
      if (mutationThrottleTimer) {
        clearTimeout(mutationThrottleTimer);
        mutationThrottleTimer = null;
      }
      mutationPendingNodes = [];
      // 清空已翻译节点标记，否则第二次翻译时这些节点会被误判为已翻译而跳过
      translatedNodes.clear();
      // 清空失败计数，重新翻译时重置重试额度
      nodeFailCounts.clear();
      hideProgress();
      return;
    }

    // 整页翻译固定译为简体中文（目标语言锁定，不跟随 popup/右键传入的语言）
    pageTranslationTarget = await resolvePageTarget();

    pageTranslated = true;
    pageTranslationInProgress = true;
    // 用户手动发起新一轮翻译：解除配额暂停、清掉上一轮的错误提示
    quotaSuspendedUntil = 0;
    hidePillTip();

    // 先把两个观察器挂上，再翻首屏：大页面首轮要跑几十秒，这期间新增/
    // 滚入视窗的内容必须有人接管（旧实现等首轮结束才挂，这段时间的动态
    // 内容全部漏翻，是"动态加载支持欠缺"的一处来源）。
    setupIntersectionObserver();

    // 设置 MutationObserver 监听 DOM 变化（动态加载的内容）
    setupMutationObserver();

    // 翻译整个页面所有可见文本（目标固定简体中文）
    await translateAllVisible(pageTranslationTarget);
    // 首轮结束必须复位：该标记是"额度恢复自动续翻"的守卫条件之一，
    // 永远为 true 会让续翻回调直接放弃（表现为额度恢复后什么都不发生）
    pageTranslationInProgress = false;

    // 启动补扫调度器：兜底 API 失败重试、慢渲染框架、时机性漏翻译
    startRescan();
  };

  // 监听来自 background 的页面翻译指令（content 唯一的 onMessage 监听器）
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // 流式回推：background 每翻完一个桶就推一次，逐条插入 DOM
    if (msg && msg.type === "YUFAN_TRANSLATE_BATCH_PARTIAL") {
      return handleBatchPartial(msg);
    }
    if (msg && msg.type === "YUFAN_TRANSLATE_PAGE") {
      // 整页翻译固定译为简体中文，忽略调用方传入的目标语言。
      // 捕获异常并打印到页面 console，避免整页翻译静默失败（右键点了毫无反应时，
      // 用户可在 DevTools Console 看到具体错误）。
      translatePage().catch((err) => {
        console.error("[yufan] 整页翻译失败:", (err && err.message) || err);
        pageTranslationInProgress = false;
        try { hideProgress(); } catch (_) {}
      });
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  document.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("touchend", onTouchEnd, { passive: true });
  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("keyup", onKeyUp);
  window.addEventListener("scroll", onScrollOrResize, { passive: true });
  window.addEventListener("resize", onScrollOrResize);
})();
