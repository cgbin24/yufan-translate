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

  // 同语言保护：根据文本内容预判目标语言，避免翻译前后同语言
  // 中文文本 -> 目标改英文；非中文文本 -> 目标改中文
  const resolveTargetForText = (text, target) => {
    const isZhTarget = isZhCode(target);
    if (looksLikeChinese(text)) {
      if (isZhTarget) return "en";
    } else {
      if (!isZhTarget) return "zh-CN";
    }
    return target;
  };

  const state = {
    selectedText: "",
    selectionRect: null,
    currentTarget: "zh-CN", // 当前面板使用的目标语言
  };

  // ---------- helpers ----------
  const removeEl = (id) => {
    const el = document.getElementById(id);
    if (el) el.remove();
  };

  const cleanSelection = (str) => (str || "").replace(/\s+/g, " ").trim();

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
    removeEl(PILL_ID);
    const pill = document.createElement("div");
    pill.id = PILL_ID;
    pill.className = `${NAMESPACE}-pill`;
    pill.setAttribute("data-testid", "yufan-select-pill");
    pill.innerHTML = `
      <img src="${chrome.runtime.getURL("icons/logo.svg")}" width="16" height="16" alt="Yufan Translate" />
      <span>翻译</span>
    `;
    document.body.appendChild(pill);
    // measure then position
    const { offsetWidth, offsetHeight } = pill;
    positionBelow(pill, rect, offsetWidth, offsetHeight);
    // trigger enter animation next frame
    requestAnimationFrame(() => pill.classList.add(`${NAMESPACE}-pill-in`));

    pill.addEventListener("mousedown", (e) => e.preventDefault()); // keep selection
    pill.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      openPanel(rect);
    });
  };

  const hidePill = () => removeEl(PILL_ID);
  const hidePanel = () => {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    // 走和关闭按钮一致的淡出动画，避免突兀消失
    panel.classList.remove(`${NAMESPACE}-panel-in`);
    setTimeout(() => panel.remove(), 180);
  };

  // ---------- Panel ----------
  const openPanel = async (rect) => {
    hidePill();
    removeEl(PANEL_ID);
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = `${NAMESPACE}-panel`;
    panel.setAttribute("data-testid", "yufan-translate-panel");
    panel.innerHTML = `
      <div class="${NAMESPACE}-panel-head">
        <div class="${NAMESPACE}-panel-brand">
          <img class="${NAMESPACE}-brand-logo" src="${chrome.runtime.getURL("icons/logo.svg")}" width="18" height="18" alt="语翻" />
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
    document.body.appendChild(panel);
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
    const initialTarget = resolveTargetForText(state.selectedText, "zh-CN");
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
    const doTranslate = async (target) => {
      const resultEl = panel.querySelector(`.${NAMESPACE}-panel-result`);
      const providerEl = panel.querySelector(`.${NAMESPACE}-panel-provider`);
      // 显示加载态
      resultEl.innerHTML = `<div class="${NAMESPACE}-loader"><span></span><span></span><span></span></div>`;
      providerEl.textContent = "";
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
          resultEl.innerHTML = `<div class="${NAMESPACE}-error">翻译失败：${escapeHtml((resp && resp.error) || "网络异常")}</div>`;
          return;
        }
        resultEl.textContent = resp.data.translated;
        const provider = resp.data.provider || "Yufan";
        const detected =
          resp.data.detected || resp.data.detectedSource || "";
        providerEl.textContent = detected
          ? `${provider} · 识别：${detected}`
          : provider;
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
        const txt = panel.querySelector(`.${NAMESPACE}-panel-result`).textContent || "";
        try {
          await navigator.clipboard.writeText(txt.trim());
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
  const onSelectionChange = () => {
    // debounce; only act on mouseup for stability
  };

  const onMouseUp = (e) => {
    // Ignore clicks inside our own UI（含进度浮层）
    if (
      e.target.closest(`#${PILL_ID}`) ||
      e.target.closest(`#${PANEL_ID}`) ||
      e.target.closest(`#${PROGRESS_ID}`)
    ) {
      return;
    }
    setTimeout(() => {
      const sel = window.getSelection();
      const text = cleanSelection(sel && sel.toString());
      if (!text || text.length < 1 || text.length > 800) {
        hidePill();
        return;
      }
      // hide previous panel when a new selection is made
      hidePanel();
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        hidePill();
        return;
      }
      state.selectedText = text;
      state.selectionRect = rect;
      showPill(rect);
    }, 10);
  };

  const onMouseDown = (e) => {
    if (
      e.target.closest(`#${PILL_ID}`) ||
      e.target.closest(`#${PANEL_ID}`) ||
      e.target.closest(`#${PROGRESS_ID}`)
    ) {
      return; // interacting with our own UI
    }
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
    const pill = document.getElementById(PILL_ID);
    if (pill) positionBelow(pill, rect, pill.offsetWidth, pill.offsetHeight);
    const panel = document.getElementById(PANEL_ID);
    // panel 未拖动时跟随划词位置（fixed 定位，视窗坐标）；拖动后固定不再重定位
    if (panel && !panel.dataset.dragged) {
      positionBelow(panel, rect, panel.offsetWidth, panel.offsetHeight);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      hidePill();
      hidePanel();
    }
  };

  // ---------- Page translation (from context menu) ----------
  // 全新策略：一次性翻译整个页面所有可见文本，并持续监控动态内容
  let pageTranslated = false;
  let pageTranslationTarget = "zh-CN"; // 当前页面的翻译目标语言
  let pageTranslationInProgress = false;

  // 跳过这些标签内的文本
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "OBJECT", "EMBED",
    "TEXTAREA", "INPUT", "SELECT", "OPTION",
    "CODE", "PRE", "KBD", "SAMP", "VAR",
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

  // 判断文本节点是否应该被翻译
  const shouldTranslateTextNode = (node) => {
    if (!node || node.nodeType !== Node.TEXT_NODE) return false;
    const text = node.nodeValue;
    if (!text || !text.trim() || text.trim().length < 2) return false;
    const parent = node.parentElement;
    if (!parent || isOwnUI(parent)) return false;
    // 跳过特定标签
    let p = parent;
    while (p && p !== document.body) {
      if (SKIP_TAGS.has(p.tagName)) return false;
      if (p.isContentEditable) return false;
      p = p.parentElement;
    }
    return true;
  };

  // 翻译文本缓存（简化版，减少内存占用）
  const translationCache = new Map();
  const MAX_CACHE_SIZE = 500; // 减少缓存大小

  // 翻译单个文本，返回译文（带缓存和节流）
  const translateText = async (text, target) => {
    // 检查缓存
    const cacheKey = `${text}|${target}`;
    if (translationCache.has(cacheKey)) {
      return translationCache.get(cacheKey);
    }

    try {
      const resp = await chrome.runtime.sendMessage({
        type: "YUFAN_TRANSLATE",
        payload: { text, source: "auto", target },
      });
      if (resp && resp.ok && resp.data && resp.data.translated) {
        const result = resp.data.translated;
        // 添加到缓存
        if (translationCache.size >= MAX_CACHE_SIZE) {
          // 清理最旧的缓存项
          const firstKey = translationCache.keys().next().value;
          translationCache.delete(firstKey);
        }
        translationCache.set(cacheKey, result);
        return result;
      }
      return null;
    } catch (_) {
      return null;
    }
  };

  // 在文本节点后面插入译文
  // 方案：把原文文本节点替换成 <font>原文</font><font translate="no">译文</font>
  // 原文和译文同行显示，中间用 CSS margin-left 加间距
  const insertTranslationAfter = (textNode, translation) => {
    const parent = textNode.parentElement;
    if (!parent) return;
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

  // 添加 CSS 动画样式，用于进度提示浮层和 loading 动效（右下角）
  const addProgressStyles = () => {
    if (document.getElementById(`${NAMESPACE}-progress-styles`)) return;
    
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
    document.head.appendChild(style);
  };

  // 进度提示浮层 ID
  const PROGRESS_ID = "yufan-page-progress";

  // 在 showProgress 函数中调用样式添加
  // 浮层常驻右下角：翻译进行中显示 loading，完成后隐藏 loading；带关闭按钮，点击恢复原文
  // loading=true 显示 spinner，loading=false 隐藏 spinner（浮层本身常驻）
  const showProgress = (loading = true) => {
    // 确保样式已添加
    addProgressStyles();
    
    let el = document.getElementById(PROGRESS_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = PROGRESS_ID;
      el.className = `${NAMESPACE}-page-progress`;
      el.innerHTML = `
        <img class="${NAMESPACE}-progress-icon" src="${chrome.runtime.getURL("icons/logo.svg")}" alt="语翻" />
        <span class="${NAMESPACE}-progress-title">语翻</span>
        <div class="${NAMESPACE}-progress-spinner"></div>
        <button class="${NAMESPACE}-progress-close" aria-label="关闭翻译" data-testid="yufan-progress-close">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      `;
      document.body.appendChild(el);
      requestAnimationFrame(() => el.classList.add(`${NAMESPACE}-page-progress-show`));
      // 关闭按钮：恢复原文并关闭翻译功能
      el.querySelector(`.${NAMESPACE}-progress-close`).addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        translatePage(); // pageTranslated=true 时走恢复原文分支
      });
    }
    // 切换 loading 显示状态：翻译中显示 spinner，完成后隐藏
    const spinner = el.querySelector(`.${NAMESPACE}-progress-spinner`);
    if (spinner) {
      spinner.style.display = loading ? "" : "none";
    }
  };

  // 移除所有页面翻译，恢复原文
  // 递归处理同源 iframe（兜底场景下父文档可能向 iframe 内插入了译文）
  const removePageTranslations = () => {
    const cleanDoc = (rootDoc) => {
      if (!rootDoc) return;
      // 移除译文 <font>
      rootDoc
        .querySelectorAll(`.${NAMESPACE}-page-translation`)
        .forEach((el) => el.remove());
      // 把原文 <font> 还原成纯文本节点
      rootDoc
        .querySelectorAll(`.${NAMESPACE}-page-original`)
        .forEach((el) => {
          const parent = el.parentElement;
          if (!parent) return;
          // 把 <font> 内的文本节点移到 <font> 外面，然后移除 <font>
          while (el.firstChild) {
            parent.insertBefore(el.firstChild, el);
          }
          el.remove();
          // 合并相邻的文本节点
          parent.normalize();
        });
      // 递归同源 iframe
      const iframes = rootDoc.querySelectorAll("iframe");
      for (const f of iframes) {
        let iframeDoc = null;
        try {
          iframeDoc = f.contentDocument;
        } catch (_) {
          iframeDoc = null;
        }
        if (iframeDoc) cleanDoc(iframeDoc);
      }
    };
    cleanDoc(document);
  };

  const hideProgress = () => {
    const el = document.getElementById(PROGRESS_ID);
    if (el) {
      el.classList.remove(`${NAMESPACE}-page-progress-show`);
      setTimeout(() => el.remove(), 300);
    }
  };

  // 已翻译的文本节点（用 Set 以便恢复原文时清空；WeakSet 无 clear 方法，
  // 会导致第一次翻译的节点标记残留，第二次翻译时被误判为已翻译而跳过）
  let translatedNodes = new Set();

  // 判断文本节点所在元素是否当前可见（用于跳过隐藏弹窗内的即时翻译，
  // 交给 IntersectionObserver 在其显示后再触发，避免对隐藏 DOM 做无意义处理）
  const isTextNodeVisible = (node) => {
    const parent = node && node.parentElement;
    if (!parent) return false;
    return isElementVisible(parent);
  };

  // 翻译一个文本节点
  // skipHidden=true 时跳过当前不可见的节点（由 observer 后续兜底）
  const translateOneNode = async (node, target, skipHidden = false) => {
    if (translatedNodes.has(node)) return;
    const text = node.nodeValue.trim();
    if (!text) return;
    if (skipHidden && !isTextNodeVisible(node)) return;
    translatedNodes.add(node);
    const translated = await translateText(text, target);
    if (translated && translated !== text) {
      insertTranslationAfter(node, translated);
    }
  };

  // 收集页面内所有需要翻译的文本节点（优先级排序）
  // 同源 iframe 兜底：若 iframe 内未注入本扩展 content script（如 sandbox 限制），
  // 则由父文档直接递归收集其文本节点；若已注入则跳过，避免重复翻译。
  const collectAllTextNodes = () => {
    const nodes = [];

    const walkDoc = (rootDoc) => {
      if (!rootDoc || !rootDoc.body) return;
      const walker = rootDoc.createTreeWalker(
        rootDoc.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            return shouldTranslateTextNode(node)
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_REJECT;
          },
        }
      );
      let n;
      while ((n = walker.nextNode())) {
        if (!translatedNodes.has(n)) nodes.push(n);
      }
      // 递归进入同源 iframe（跨源 iframe 访问 contentDocument 会抛错，try/catch 兜底）
      const iframes = rootDoc.querySelectorAll("iframe");
      for (const f of iframes) {
        let iframeDoc = null;
        try {
          iframeDoc = f.contentDocument;
        } catch (_) {
          iframeDoc = null;
        }
        if (!iframeDoc) continue; // 跨源或不可访问，交给 iframe 内自己的 content script
        // 若 iframe 内已加载本扩展脚本，则由它自己翻译，父文档跳过
        try {
          if (
            iframeDoc.defaultView &&
            iframeDoc.defaultView.__yufanTranslateLoaded
          ) {
            continue;
          }
        } catch (_) {
          // 跨源访问 defaultView 属性可能抛错，按"未加载"处理
        }
        walkDoc(iframeDoc);
      }
    };

    walkDoc(document);
    
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

  // 收集页面内所有需要翻译的元素（用于动态内容）
  const collectAllElements = () => {
    const elements = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          return shouldTranslateElement(node)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      }
    );
    let n;
    while ((n = walker.nextNode())) {
      if (!translatedNodes.has(n)) elements.push(n);
    }
    return elements;
  };

  // 并发翻译文本节点，限制并发数（极速版）
  // skipHidden=true 时跳过当前隐藏节点（交给 observer 后续兜底），
  // 避免对隐藏弹窗/下拉做无意义处理导致 DOM 闪烁
  const translateBatch = async (nodes, target, concurrency = 4, skipHidden = false) => {
    const total = nodes.length;
    if (total === 0) return;
    
    // 翻译进行中：显示 loading
    showProgress(true);
    
    // 分批处理，避免内存压力
    const batchSize = 40;
    
    for (let i = 0; i < nodes.length; i += batchSize) {
      const batch = nodes.slice(i, i + batchSize);
      const workers = Array.from(
        { length: Math.min(concurrency, batch.length) },
        async () => {
          for (const node of batch) {
            await translateOneNode(node, target, skipHidden);
          }
        }
      );
      await Promise.all(workers);
    }
    // 翻译完成：隐藏 loading（浮层+关闭按钮常驻）
    showProgress(false);
  };

  // 翻译整个页面所有可见文本
  // 首轮只翻译当前可见节点（skipHidden=true），隐藏弹窗/下拉交给 observer 兜底，
  // 避免对隐藏 DOM 做无意义处理导致 DOM 闪烁、loading 频闪
  const translateAllVisible = async (target) => {
    const textNodes = collectAllTextNodes();
    if (textNodes.length === 0) return;
    await translateBatch(textNodes, target, 5, true);
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
  // 用于兜底：首轮跳过的隐藏节点（弹窗/下拉内部），在其显示后触发翻译
  const setupIntersectionObserver = () => {
    pageObserver = new IntersectionObserver(
      (entries) => {
        if (!pageTranslated) return;
        const newNodes = [];
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target;
          // 收集元素内所有需要翻译的文本节点
          const walker = document.createTreeWalker(
            el,
            NodeFilter.SHOW_TEXT,
            {
              acceptNode(node) {
                return shouldTranslateTextNode(node)
                  ? NodeFilter.FILTER_ACCEPT
                  : NodeFilter.FILTER_REJECT;
              },
            }
          );
          let n;
          while ((n = walker.nextNode())) {
            if (!translatedNodes.has(n)) newNodes.push(n);
          }
        }
        if (newNodes.length > 0) {
          // 节流处理，避免频繁触发（用独立变量，不挂到 observer 实例上）
          if (!intersectionThrottleTimer) {
            intersectionThrottleTimer = setTimeout(() => {
              intersectionThrottleTimer = null;
              // 此时节点已可见，skipHidden=false 直接翻译
              translateBatch(newNodes, pageTranslationTarget, 3, false);
            }, 200);
          }
        }
      },
      { rootMargin: "600px" }
    );
    // 观察 body 下所有可能包含文本的元素，包括弹窗和对话框
    const observeTargets = document.body.querySelectorAll(
      "p, h1, h2, h3, h4, h5, h6, li, blockquote, div, section, article, main, aside, header, footer, nav, td, th, label, button, a, span, dialog, modal, popup, .modal, .dialog, .popup, .overlay"
    );
    observeTargets.forEach((el) => pageObserver.observe(el));
  };

  // 监听 DOM 变化（新加载的内容，极速版）
  // 新增节点：可见的立即翻译，不可见的加入 IntersectionObserver 兜底
  const setupMutationObserver = () => {
    pageMutationObserver = new MutationObserver((mutations) => {
      if (!pageTranslated) return;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          // 跳过我们自己的 UI
          if (isOwnUI(node)) continue;
          // 收集新元素内的文本节点
          const walker = document.createTreeWalker(
            node,
            NodeFilter.SHOW_TEXT,
            {
              acceptNode(n) {
                return shouldTranslateTextNode(n)
                  ? NodeFilter.FILTER_ACCEPT
                  : NodeFilter.FILTER_REJECT;
              },
            }
          );
          const visibleNodes = [];
          let n;
          while ((n = walker.nextNode())) {
            if (translatedNodes.has(n)) continue;
            // 可见节点立即处理，隐藏节点累积到 pending 交由节流批处理（skipHidden）
            if (isTextNodeVisible(n)) {
              visibleNodes.push(n);
            } else {
              mutationPendingNodes.push(n);
            }
          }
          // 可见节点立即翻译（弹窗/下拉打开时的关键路径）
          if (visibleNodes.length > 0) {
            translateBatch(visibleNodes, pageTranslationTarget, 4, false);
          }
          // 把新元素加入 IntersectionObserver 观察，隐藏子树显示后兜底翻译
          if (pageObserver && node.nodeType === Node.ELEMENT_NODE) {
            pageObserver.observe(node);
          }
        }
      }
      // 隐藏节点节流批处理（用独立变量，不挂到 observer 实例上）
      if (mutationPendingNodes.length > 0 && !mutationThrottleTimer) {
        mutationThrottleTimer = setTimeout(() => {
          mutationThrottleTimer = null;
          const pending = mutationPendingNodes;
          mutationPendingNodes = [];
          // 这些节点当前可能仍隐藏，skipHidden=true 跳过，由 observer 兜底
          translateBatch(pending, pageTranslationTarget, 4, true);
        }, 150);
      }
    });
    pageMutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  };

  const translatePage = async () => {
    // 如果已经翻译过，则恢复原文
    if (pageTranslated) {
      removePageTranslations();
      pageTranslated = false;
      pageTranslationInProgress = false;
      // 停止所有观察
      if (pageObserver) {
        pageObserver.disconnect();
        pageObserver = null;
      }
      if (pageMutationObserver) {
        pageMutationObserver.disconnect();
        pageMutationObserver = null;
      }
      // 清理节流 timer 和待处理节点，避免悬空引用/重复触发
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
      hideProgress();
      return;
    }

    pageTranslated = true;
    pageTranslationInProgress = true;

    // 翻译整个页面所有可见文本
    await translateAllVisible(pageTranslationTarget);

    // 设置 IntersectionObserver 监听新进入视窗的元素
    setupIntersectionObserver();

    // 设置 MutationObserver 监听 DOM 变化（动态加载的内容）
    setupMutationObserver();
  };

  // 监听来自 background 的页面翻译指令
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "YUFAN_TRANSLATE_PAGE") {
      // 如果有指定目标语言，则使用指定的语言
      if (msg.payload && msg.payload.target) {
        pageTranslationTarget = msg.payload.target;
      }
      translatePage();
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  document.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", onScrollOrResize, { passive: true });
  window.addEventListener("resize", onScrollOrResize);
})();
