(() => {
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // 版本号统一取自 manifest.json（chrome.runtime.getManifest().version），
  // 不再在代码里硬编码 —— 改 manifest 即同步到设置页头部与"关于"区。
  // 测试桩/非扩展环境（无 chrome.runtime.getManifest）降级到 manifest 兜底值。
  function readManifestVersion() {
    try {
      if (chrome.runtime && typeof chrome.runtime.getManifest === "function") {
        const v = chrome.runtime.getManifest().version;
        if (v) return v;
      }
    } catch (_) {}
    return "2.3.0";
  }
  const CURRENT_VERSION = "v" + readManifestVersion();

  // 版本说明（点击版本号弹出的悬浮面板内容）。
  // 新版本加到数组最前；每条 {version, date, features}，features 以列表形式展现。
  const CHANGELOG = [
    {
      version: "2.3.8",
      date: "2026-11-08",
      features: [
        "修复：划词胶囊完全无样式（裸奔/纵向堆叠）——content.css 未列入 web_accessible_resources，且误启用 use_dynamic_url 封死静态资源 URL，现恢复胶囊外观与 logo 加载",
        "修复：点击胶囊按钮（翻译/复制/搜索/打开）无反应——Shadow DOM 内事件在 document 层被重定位到宿主，旧判定 closest 永远匹配不到内部按钮而误删 UI；现改用 composedPath 还原真实路径判定",
        "新增：options 设置页、离线测试套件（logic/smoke/dynamic 共 337 项）与打包脚本",
      ],
    },
    {
      version: "2.3.7",
      date: "2026-09-09",
      features: [
        "修复：错误提示自动隐藏后，悬停/点击胶囊（含感叹号角标）无反应——旧监听器绑定在被重建前的浮层上已失效，现改为常驻绑定并可反复唤出最后一条提示",
        "改进：错误提示停留时长 12s → 15s",
      ],
    },
    {
      version: "2.3.6",
      date: "2026-09-09",
      features: [
        "严重修复：取消翻译后 300ms 内再次发起翻译，隐藏动画的旧定时器会把正在使用的进度浮层删掉——提示与浮层「一闪而过」的直接元凶",
        "严重修复：失败的翻译请求退还本地字符记账——此前反复重试会把本地额度闸门撑爆，服务端还有额度也被误判为「今日额度用完」导致整页罢工",
        "改进：额度熔断后进入静默暂停期——补扫重试完全空转（不发消息、不闪提示），提示气泡稳定显示，到点自动续翻一次性完成剩余内容",
        "改进：并发批次完成不再互相吞掉错误提示（按轮次错误状态判定）",
      ],
    },
    {
      version: "2.3.5",
      date: "2026-09-09",
      features: [
        "修复：扩展更新后旧标签页报「Extension context invalidated」、划词胶囊与整页翻译静默崩溃——现在会明确提示「请刷新页面」，界面不再报错",
        "修复：右键菜单并发创建的竞态（duplicate id 报错）",
        "改进：扩展资源 URL 在注入时缓存，上下文失效后划词/浮层 UI 仍可正常渲染",
      ],
    },
    {
      version: "2.3.4",
      date: "2026-09-09",
      features: [
        "严重修复：MyMemory 频率限流（429）不再被误判为每日额度耗尽——此前大页面翻译会被整体熔断，表现为「无法翻译整页」",
        "严重修复：限流时失败内容不计入重试上限，自动降速后由补扫机制续翻，不再整页放弃",
        "严重修复：额度熔断时正确摘除未完成节点的标记——此前「自动续翻」实际是空转，额度恢复后什么也不会发生",
        "修复：错误提示气泡被并发的其他批次完成事件立刻隐藏（「一闪而过」的根因）；错误提示延长到 12 秒，悬停胶囊可随时再看",
        "修复：首轮翻译完成后未复位的内部标记导致自动续翻永远不触发",
      ],
    },
    {
      version: "2.3.3",
      date: "2026-09-09",
      features: [
        "整页翻译：额度不足等错误提示改为胶囊上方气泡（tooltip）显示，胶囊本体保持简洁不再被长文案撑爆",
        "整页翻译：错误时胶囊显示红色角标，悬停胶囊可随时重看完整提示",
        "额度缓解：服务端告知恢复时间后，到点自动继续翻译剩余内容，无需手动重试（超过 3 小时仅提示）",
        "额度缓解：修复\"服务端说 1 小时后恢复，本地额度闸门却要等满 24 小时\"导致的无限冷却问题",
      ],
    },
    {
      version: "2.3.2",
      date: "2026-09-09",
      features: [
        "整页翻译：结果流式显示——翻译一条显示一条，不再等一整块翻完才插入",
        "整页翻译：取消慢启动与批量控制，整批一次提交，视口内容仍优先处理",
        "整页翻译：修复 IntersectionObserver 节流窗口内的内容被直接丢弃的严重缺陷（动态/滚动加载漏翻主因）",
        "整页翻译：新增内容统一排队后按可见性分流——可见的立即翻译，隐藏的交给 IntersectionObserver 兜底",
        "整页翻译：观察器在首屏翻译之前挂载，大页面首轮期间出现的动态内容不再无人接管",
        "标签内容：新增 SVG 图表文字（<text>/<tspan>）翻译管线，改写 textContent 而非插入不渲染的 <font>",
        "标签内容：超链接 <a> 文本（含嵌套 span）确认覆盖；紧凑型标签（链接/按钮/菜单项/表头）改为只显示译文，不再被固定宽度裁剪",
        "标签内容：无障碍标签补齐 aria-placeholder / aria-valuetext / aria-roledescription",
        "标签内容：下拉项 <option>/<optgroup>/<track> 的 label 属性与 <button> 的 value 可翻译",
        "标签内容：Bootstrap 5 popover 正文（data-content / data-bs-content / data-bs-title 等）与 data-hint 可翻译",
      ],
    },
    {
      version: "2.3.1",
      date: "2026-09-08",
      features: [
        "整页翻译：修复批次超时导致整页零译文的严重错误——超时不再整批作废，已翻好的部分照常显示",
        "整页翻译：渐进式披露——视口内容优先翻译、首批小批量快速出结果、译文逐批出现",
        "整页翻译：吞吐提速——并发 4→6、拼块 450→480 字符、批次流水线预取、配额记账防抖落盘，大页面墙钟时间约减半",
        "整页翻译：进度浮层不再显示统计数字，只保留品牌标识与加载状态",
        "整页翻译：免费额度耗尽时明确提示原因并立即停止，不再静默失败或空跑请求",
        "划词翻译：修复必应词典对无词条短语返回杂讯壳页面、被当成释义显示\"1. Dictionary\"的严重错误",
        "划词翻译：词典缓存脏数据强制失效（命名空间升级），历史错误结果不再被复用",
        "划词翻译：词典与例句一律走缓存封装，响应更快、配额消耗更低",
        "popup：请求超时全面收窄并按批次大小动态伸缩，弹窗响应更快且不再误杀大批量翻译",
        "options：翻译来源、数据流与接入协议说明与插件实际行为完全对齐",
      ],
    },
    {
      version: "2.3.0",
      date: "2026-09-02",
      features: [
        "整页翻译：修复元素遍历只走一层导致嵌套元素漏识别的核心缺陷（内容不全主因）",
        "整页翻译：API 翻译失败的节点不再被永久标记，补扫自动重试（内容不全主因）",
        "整页翻译：新增定期补扫调度器，慢渲染框架与时机性漏翻内容自动兜底",
        "悬浮提示：INPUT 表单控件的 title 属性可翻译（修复祖先链误判）",
        "悬浮提示：新增 SVG 图标原生 <title> 翻译管线，不破坏原生渲染",
        "悬浮提示：支持 Bootstrap data-original-title、shadcn data-tip 等 tooltip 属性",
        "兼容性：尊重 translate=\"no\" 与 notranslate 标记（与 Google 翻译约定一致）",
        "恢复原文：修复取消翻译不穿透 Shadow DOM、嵌套元素译文残留的问题",
      ],
    },
    {
      version: "2.2.0",
      date: "2026-09-02",
      features: [
        "整页翻译：修复弹窗/下拉通过 textContent 直接添加的文本节点被跳过的问题",
        "整页翻译：修复复用弹窗/tooltip 元素修改 nodeValue 后不重新翻译的问题",
        "整页翻译：修复已翻译属性（placeholder/aria-label/alt/value）被外部覆盖后不重新翻译的问题",
        "整页翻译：attributeFilter 纳入 value 属性，动态 button value 变化可被捕获",
        "整页翻译：新增旧译文清理机制，节点内容变更时自动清理过期译文并重新翻译",
      ],
    },
    {
      version: "2.1.0",
      date: "2026-09-01",
      features: [
        "内置 MyMemory 免费翻译，填邮箱可提升每日额度",
        "划词胶囊：搜索 / 打开链接按钮，可选搜索引擎",
        "自定义翻译端点：支持 Google、DeepL、Azure、自建反代",
        "划词例句内容过滤：自动丢弃露骨、脏话、庸俗辱骂例句，保留良好社会价值导向",
        "英文词查询：Free Dictionary 不可达时降级必应词典，仍提供释义与双语例句",
      ],
    },
    {
      version: "2.0.0",
      date: "2026-08-29",
      features: [
        "划词翻译、整页翻译、弹窗翻译三合一",
        "离线测试套件（逻辑 + 冒烟）",
      ],
    },
  ];

  // ---------- 版本说明悬浮面板 ----------
  let versionPopover = null;
  let versionPopoverOpen = false;

  function ensureVersionPopover() {
    if (versionPopover) return versionPopover;
    versionPopover = document.createElement("div");
    versionPopover.className = "version-popover";
    versionPopover.setAttribute("role", "dialog");
    versionPopover.setAttribute("aria-label", "版本说明");
    versionPopover.hidden = true;

    const head = document.createElement("div");
    head.className = "version-popover-header";
    const title = document.createElement("span");
    title.className = "version-popover-title";
    title.textContent = "版本说明";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "version-popover-close";
    close.setAttribute("aria-label", "关闭");
    close.textContent = "×";
    close.addEventListener("click", hideVersionPopover);
    head.appendChild(title);
    head.appendChild(close);

    const body = document.createElement("div");
    body.className = "version-popover-body";

    CHANGELOG.forEach((entry) => {
      const item = document.createElement("div");
      item.className = "version-entry";
      if (entry.version === readManifestVersion()) item.classList.add("is-current");

      const entryHead = document.createElement("div");
      entryHead.className = "version-entry-head";
      const tag = document.createElement("span");
      tag.className = "version-tag";
      tag.textContent = "v" + entry.version;
      const date = document.createElement("span");
      date.className = "version-date";
      date.textContent = entry.date || "";
      entryHead.appendChild(tag);
      entryHead.appendChild(date);

      const ul = document.createElement("ul");
      ul.className = "version-features";
      (entry.features || []).forEach((f) => {
        const li = document.createElement("li");
        li.textContent = f;
        ul.appendChild(li);
      });

      item.appendChild(entryHead);
      item.appendChild(ul);
      body.appendChild(item);
    });

    versionPopover.appendChild(head);
    versionPopover.appendChild(body);
    document.body.appendChild(versionPopover);
    return versionPopover;
  }

  function positionVersionPopover(trigger) {
    const pop = versionPopover;
    if (!pop || !trigger) return;
    const r = trigger.getBoundingClientRect();
    const POP_W = 340;
    let left = r.right - POP_W;
    if (left < 12) left = 12;
    let top = r.bottom + 8;
    // 避免溢出底部：粗估高度，超出则向上偏移到触发器上方
    const approxH = 360;
    const maxTop = window.innerHeight - approxH - 12;
    if (top > maxTop) top = Math.max(12, r.top - approxH - 8);
    pop.style.top = top + "px";
    pop.style.left = left + "px";
  }

  function showVersionPopover(trigger) {
    ensureVersionPopover();
    if (!versionPopover) return;
    versionPopover.hidden = false;
    versionPopoverOpen = true;
    positionVersionPopover(trigger);
    requestAnimationFrame(() => versionPopover.classList.add("open"));
  }

  function hideVersionPopover() {
    if (!versionPopover) return;
    versionPopover.classList.remove("open");
    versionPopoverOpen = false;
    // 等过渡动画结束再隐藏，避免闪烁
    setTimeout(() => {
      if (versionPopover && !versionPopoverOpen) versionPopover.hidden = true;
    }, 160);
  }

  function toggleVersionPopover(trigger) {
    if (versionPopoverOpen) hideVersionPopover();
    else showVersionPopover(trigger);
  }

  function initVersionPopover() {
    const triggers = [headerVersion, aboutVersion].filter(Boolean);
    triggers.forEach((el) => {
      // span 默认不可聚焦/无语义，补成可交互
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      el.title = "点击查看版本说明";
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleVersionPopover(el);
      });
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleVersionPopover(el);
        }
      });
    });
    // 点击面板外关闭
    document.addEventListener("click", (e) => {
      if (!versionPopoverOpen) return;
      if (versionPopover && versionPopover.contains(e.target)) return;
      if (triggers.some((t) => t.contains(e.target))) return;
      hideVersionPopover();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hideVersionPopover();
    });
    window.addEventListener("resize", () => {
      if (versionPopoverOpen) {
        const active = document.activeElement;
        if (active && triggers.includes(active)) positionVersionPopover(active);
      }
    });
  }

  // ---------- Elements ----------
  const headerVersion = $("headerVersion");
  const aboutVersion = $("aboutVersion");
  const menuItems = $$(".menu-item");
  const sections = $$(".section");

  const myMemoryEmail = $("myMemoryEmail");
  const testMyMemoryEmail = $("testMyMemoryEmail");
  const myMemoryEmailStatus = $("myMemoryEmailStatus");

  const quotaBanner = $("quotaBanner");
  const quotaBannerText = $("quotaBannerText");
  const quotaProvider = $("quotaProvider");
  const quotaBucket = $("quotaBucket");
  const quotaState = $("quotaState");

  const searchEnabled = $("searchEnabled");
  const searchEngine = $("searchEngine"); // hidden input
  const searchEngineWrap = $("searchEngineWrap");
  const searchEngineTrigger = $("searchEngineTrigger");
  const searchEngineMenu = $("searchEngineMenu");
  const searchEngineLabel = $("searchEngineLabel");
  const searchAutoJump = $("searchAutoJump");
  const openLinkEnabled = $("openLinkEnabled");
  const copyEnabled = $("copyEnabled");
  const selectionEnabled = $("selectionEnabled");
  const pillTempClose = $("pillTempClose");

  const endpointList = $("endpointList");
  const endpointEmpty = $("endpointEmpty");
  const addEndpointBtn = $("addEndpointBtn");
  const saveToast = $("saveToast");
  const blacklistInput = $("blacklistInput");
  const addBlacklistBtn = $("addBlacklistBtn");
  const blacklistList = $("blacklistList");
  const blacklistEmpty = $("blacklistEmpty");

  const editorTpl = $("endpointEditorTpl");
  const rowTpl = $("endpointRowTpl");

  // ---------- State ----------
  let endpoints = [];
  let blacklist = [];
  let activeEndpointId = "";
  let editingIds = new Set();
  let newIds = new Set();        // “添加端点”新建的临时表单（尚未保存），同一时刻只允许一个
  const draftValues = new Map(); // id -> { name, url, key } 编辑中的草稿值，防止重渲染 / 切页丢失
  let tempIdCounter = 1;

  // ---------- Helpers ----------
  function setText(el, text) {
    if (el) el.textContent = String(text || "");
  }

  function showToast(message = "已保存") {
    if (!saveToast) return;
    saveToast.textContent = message;
    saveToast.hidden = false;
    saveToast.classList.add("show");
    setTimeout(() => {
      saveToast.classList.remove("show");
      setTimeout(() => {
        saveToast.hidden = true;
      }, 200);
    }, 1600);
  }

  function setStatus(el, text, type = "") {
    if (!el) return;
    el.textContent = String(text || "");
    el.classList.remove("ok", "err");
    if (type) el.classList.add(type);
  }

  function switchSection(name) {
    // 更新菜单
    menuItems.forEach((btn) => {
      const active = btn.dataset.section === name;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    // 更新内容区
    sections.forEach((sec) => {
      const active = sec.dataset.section === name;
      sec.classList.toggle("active", active);
      sec.hidden = !active;
    });
    // 离开“自定义端点”时，清理尚未填写任何内容的空白新建表单；
    // 已填写内容的表单（在 draftValues 中有值）保留，不被误清。
    if (name !== "custom") cleanupEmptyNewForms();
  }

  function cleanupEmptyNewForms() {
    let changed = false;
    [...newIds].forEach((id) => {
      const draft = draftValues.get(id);
      const hasContent = !!(draft && (draft.name || draft.url || draft.key));
      if (!hasContent) {
        newIds.delete(id);
        editingIds.delete(id);
        draftValues.delete(id);
        changed = true;
      }
    });
    if (changed) renderEndpoints();
  }

  function isEmailLike(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());
  }

  // ---------- Settings ----------
  async function loadSettings() {
    try {
      const data = await chrome.storage.sync.get([
        "yufanMyMemoryEmail",
        "yufanSelectionEnabled",
        "yufanPillTempCloseEnabled",
        "yufanSearchEnabled",
        "yufanSearchEngine",
        "yufanOpenLinkEnabled",
        "yufanSearchAutoJump",
        "yufanCopyEnabled",
      ]);
      if (myMemoryEmail) {
        myMemoryEmail.value = String(data.yufanMyMemoryEmail || "");
      }
      if (selectionEnabled) {
        selectionEnabled.checked = data.yufanSelectionEnabled !== false;
      }
      if (pillTempClose) {
        pillTempClose.checked = data.yufanPillTempCloseEnabled !== false;
      }
      if (searchEnabled) {
        searchEnabled.checked = data.yufanSearchEnabled !== false;
      }
      if (copyEnabled) {
        copyEnabled.checked = data.yufanCopyEnabled !== false;
      }
      const engineValue = ["baidu", "google", "bing", "duckduckgo"].includes(data.yufanSearchEngine)
        ? data.yufanSearchEngine
        : "baidu";
      if (searchEngine) searchEngine.value = engineValue;
      setSearchEngineLabel(engineValue);
      if (searchAutoJump) {
        searchAutoJump.checked = data.yufanSearchAutoJump !== false;
      }
      if (openLinkEnabled) {
        openLinkEnabled.checked = data.yufanOpenLinkEnabled !== false;
      }
    } catch (_) {}
  }

  async function saveMyMemoryEmail() {
    if (!myMemoryEmail) return;
    const v = myMemoryEmail.value.trim();
    try {
      await chrome.storage.sync.set({ yufanMyMemoryEmail: v });
      showToast("已保存");
      updateQuotaStatus();
    } catch (e) {
      setStatus(myMemoryEmailStatus, "保存失败: " + (e.message || e), "err");
    }
  }

  async function savePillSettings() {
    try {
      await chrome.storage.sync.set({
        yufanSelectionEnabled: selectionEnabled ? !!selectionEnabled.checked : true,
        yufanPillTempCloseEnabled: pillTempClose ? !!pillTempClose.checked : true,
        yufanSearchEnabled: searchEnabled ? !!searchEnabled.checked : true,
        yufanSearchEngine: searchEngine ? searchEngine.value : "baidu",
        yufanSearchAutoJump: searchAutoJump ? !!searchAutoJump.checked : true,
        yufanOpenLinkEnabled: openLinkEnabled ? !!openLinkEnabled.checked : true,
        yufanCopyEnabled: copyEnabled ? !!copyEnabled.checked : true,
      });
      showToast("已保存");
    } catch (e) {
      console.error("save pill settings failed", e);
    }
  }

  // ---------- Custom select (search engine) ----------
  const ENGINE_LABELS = {
    baidu: "百度 Baidu",
    google: "Google",
    bing: "Bing",
    duckduckgo: "DuckDuckGo",
  };

  function setSearchEngineLabel(value) {
    if (searchEngineLabel) searchEngineLabel.textContent = ENGINE_LABELS[value] || ENGINE_LABELS.baidu;
    if (searchEngineMenu) {
      searchEngineMenu.querySelectorAll(".custom-select-option").forEach((opt) => {
        opt.classList.toggle("selected", opt.dataset.value === value);
      });
    }
  }

  function openSearchEngineMenu() {
    if (!searchEngineMenu || !searchEngineTrigger) return;
    const isOpen = searchEngineMenu.classList.contains("open");
    if (isOpen) {
      closeSearchEngineMenu();
      return;
    }
    searchEngineMenu.classList.add("open");
    searchEngineTrigger.setAttribute("aria-expanded", "true");
    const current = searchEngine ? searchEngine.value : "baidu";
    searchEngineMenu.querySelectorAll(".custom-select-option").forEach((opt) => {
      opt.classList.toggle("selected", opt.dataset.value === current);
    });
  }

  function closeSearchEngineMenu() {
    if (!searchEngineMenu || !searchEngineTrigger) return;
    searchEngineMenu.classList.remove("open");
    searchEngineTrigger.setAttribute("aria-expanded", "false");
  }

  function selectSearchEngine(value) {
    const valid = ["baidu", "google", "bing", "duckduckgo"];
    const v = valid.includes(value) ? value : "baidu";
    if (searchEngine) searchEngine.value = v;
    setSearchEngineLabel(v);
    closeSearchEngineMenu();
    savePillSettings();
  }

  function initSearchEngineSelect() {
    if (!searchEngineTrigger || !searchEngineMenu) return;

    searchEngineTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      openSearchEngineMenu();
    });

    searchEngineMenu.addEventListener("click", (e) => {
      const opt = e.target.closest(".custom-select-option");
      if (!opt) return;
      e.stopPropagation();
      selectSearchEngine(opt.dataset.value);
    });

    document.addEventListener("click", () => closeSearchEngineMenu());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeSearchEngineMenu();
    });
  }

  function updateQuotaStatus() {
    chrome.runtime.sendMessage({ type: "YUFAN_QUOTA_STATUS" }, (resp) => {
      if (chrome.runtime.lastError) return;
      if (resp && resp.ok && resp.data) {
        const d = resp.data;
        if (quotaProvider) quotaProvider.textContent = d.provider || "MyMemory";
        // 配了自定义端点时，MyMemory 的配额桶根本不会被消耗 ——
        // 继续显示"匿名/已填邮箱"和冷却状态会误导用户（还以为额度没了）。
        if (quotaBucket) {
          quotaBucket.textContent = d.customEndpoint
            ? "不适用（自定义端点）"
            : d.apiKeyConfigured
            ? "已填邮箱"
            : "匿名";
        }
        if (quotaState) {
          quotaState.textContent = d.customEndpoint
            ? "正常"
            : d.quotaExhausted
            ? "冷却中"
            : "正常";
          quotaState.classList.toggle("cooling", !!d.quotaExhausted && !d.customEndpoint);
        }
        if (d.quotaExhausted && !d.customEndpoint) {
          if (quotaBanner) quotaBanner.hidden = false;
          if (quotaBannerText) {
            quotaBannerText.textContent =
              "MyMemory 翻译配额已用完" + (d.remaining ? `（${d.remaining}）` : "") +
              "，请稍后再试或填写邮箱提升额度。";
          }
        } else {
          if (quotaBanner) quotaBanner.hidden = true;
        }
      }
    });
  }

  function testMyMemory() {
    setStatus(myMemoryEmailStatus, "测试中...", "");
    chrome.runtime.sendMessage({ type: "YUFAN_TEST_MYMEMORY" }, (resp) => {
      if (chrome.runtime.lastError) {
        setStatus(myMemoryEmailStatus, "连接失败: " + chrome.runtime.lastError.message, "err");
        return;
      }
      if (resp && resp.ok) {
        const t = resp.data && resp.data.translated ? resp.data.translated : "OK";
        setStatus(myMemoryEmailStatus, `连接正常 · ${t}`, "ok");
      } else {
        setStatus(myMemoryEmailStatus, (resp && resp.error) || "连接失败", "err");
      }
    });
  }

  // ---------- Endpoints ----------
  async function loadEndpoints() {
    try {
      const localData = await chrome.storage.local.get(["yufanEndpoints"]);
      endpoints = Array.isArray(localData.yufanEndpoints) ? localData.yufanEndpoints : [];
      const syncData = await chrome.storage.sync.get(["yufanActiveEndpointId"]);
      activeEndpointId = String(syncData.yufanActiveEndpointId || "").trim();
      renderEndpoints();
    } catch (e) {
      console.error("load endpoints failed", e);
    }
  }

  async function persistEndpoints() {
    await chrome.storage.local.set({ yufanEndpoints: endpoints });
  }

  function updateAddButtonState() {
    if (!addEndpointBtn) return;
    const hasOpen = newIds.size > 0;
    addEndpointBtn.disabled = hasOpen;
    addEndpointBtn.title = hasOpen
      ? "请先保存或取消当前端点，再添加新端点"
      : "新增一个自定义翻译端点";
  }

  function renderEndpoints() {
    if (!endpointList || !endpointEmpty) return;
    endpointList.innerHTML = "";

    if (endpoints.length === 0 && editingIds.size === 0) {
      endpointEmpty.hidden = false;
    } else {
      endpointEmpty.hidden = true;

      endpoints.forEach((ep) => {
        if (editingIds.has(ep.id)) {
          endpointList.appendChild(buildEditor(ep));
        } else {
          endpointList.appendChild(buildRow(ep));
        }
      });

      // 渲染尚未保存到 endpoints 的新建编辑器（临时 id）
      editingIds.forEach((id) => {
        if (!endpoints.some((e) => e.id === id)) {
          endpointList.appendChild(buildEditor({ id, name: "", url: "", key: "" }));
        }
      });
    }

    updateAddButtonState();
  }

  function buildRow(ep) {
    if (!rowTpl) return document.createElement("div");
    const node = rowTpl.content.cloneNode(true);
    const row = node.querySelector(".endpoint-row");
    row.dataset.id = ep.id;
    if (activeEndpointId === ep.id) row.classList.add("is-active");

    const nameEl = node.querySelector('[data-field="name"]');
    const urlEl = node.querySelector('[data-field="url"]');
    const radio = node.querySelector('[data-action="activate"]');
    if (nameEl) nameEl.textContent = ep.name || "未命名端点";
    if (urlEl) urlEl.textContent = ep.url || "";
    if (radio) {
      radio.checked = activeEndpointId === ep.id;
      radio.dataset.id = ep.id;
    }

    node.querySelectorAll("[data-action]").forEach((btn) => {
      btn.dataset.id = ep.id;
    });
    return row;
  }

  function buildEditor(ep) {
    if (!editorTpl) return document.createElement("div");
    const node = editorTpl.content.cloneNode(true);
    const editor = node.querySelector(".endpoint-editor");
    editor.dataset.id = ep.id;

    const nameInput = node.querySelector('[data-field="name"]');
    const urlInput = node.querySelector('[data-field="url"]');
    const keyInput = node.querySelector('[data-field="key"]');
    const radio = node.querySelector('[data-action="activate"]');

    const draft = draftValues.get(ep.id);
    if (nameInput) {
      nameInput.value = (draft && draft.name) || ep.name || "";
      nameInput.dataset.id = ep.id;
    }
    if (urlInput) {
      urlInput.value = (draft && draft.url) || ep.url || "";
      urlInput.dataset.id = ep.id;
    }
    if (keyInput) {
      keyInput.value = (draft && draft.key) || ep.key || "";
      keyInput.dataset.id = ep.id;
    }
    if (radio) {
      radio.checked = activeEndpointId === ep.id;
      radio.dataset.id = ep.id;
    }

    node.querySelectorAll("[data-action]").forEach((btn) => {
      btn.dataset.id = ep.id;
    });
    return editor;
  }

  function getEditorValues(id) {
    const editor = endpointList.querySelector(`.endpoint-editor[data-id="${id}"]`);
    if (!editor) return null;
    const name = (editor.querySelector('[data-field="name"]')?.value || "").trim();
    const url = (editor.querySelector('[data-field="url"]')?.value || "").trim();
    const key = (editor.querySelector('[data-field="key"]')?.value || "").trim();
    return { name, url, key };
  }

  function setEditorStatus(id, text, type = "") {
    const editor = endpointList.querySelector(`.endpoint-editor[data-id="${id}"]`);
    const status = editor?.querySelector('[data-field="status"]');
    setStatus(status, text, type);
  }

  function isTempId(id) {
    return String(id).startsWith("temp_");
  }

  async function saveEndpoint(id) {
    const vals = getEditorValues(id);
    if (!vals) return;
    if (!vals.url) {
      setEditorStatus(id, "请填写端点 URL", "err");
      return;
    }
    if (!/^https?:\/\/.+/.test(vals.url)) {
      setEditorStatus(id, "URL 需以 http:// 或 https:// 开头", "err");
      return;
    }

    const idx = endpoints.findIndex((e) => e.id === id);
    const now = Date.now();
    if (idx >= 0) {
      endpoints[idx] = {
        ...endpoints[idx],
        name: vals.name || "未命名端点",
        url: vals.url,
        key: vals.key,
        updatedAt: now,
      };
    } else {
      const newId = "ep_" + now.toString(36);
      endpoints.push({
        id: newId,
        name: vals.name || "未命名端点",
        url: vals.url,
        key: vals.key,
        createdAt: now,
      });
      // 如果是从临时编辑器保存，把 editingId 切换到新 id
      editingIds.delete(id);
      editingIds.add(newId);
      // 首次保存自动设为激活
      activeEndpointId = newId;
      await chrome.storage.sync.set({ yufanActiveEndpointId: newId });
    }

    await persistEndpoints();
    editingIds.clear();
    newIds.clear();
    draftValues.clear();
    await loadEndpoints();
    showToast("已保存");
  }

  async function deleteEndpoint(id) {
    if (isTempId(id)) {
      editingIds.delete(id);
      newIds.delete(id);
      draftValues.delete(id);
      renderEndpoints();
      return;
    }
    endpoints = endpoints.filter((e) => e.id !== id);
    if (activeEndpointId === id) {
      activeEndpointId = "";
      await chrome.storage.sync.set({ yufanActiveEndpointId: "" });
    }
    editingIds.delete(id);
    draftValues.delete(id);
    await persistEndpoints();
    await loadEndpoints();
    showToast("已删除");
  }

  async function activateEndpoint(id) {
    if (isTempId(id)) {
      setEditorStatus(id, "请先保存端点", "err");
      return;
    }
    activeEndpointId = id;
    await chrome.storage.sync.set({ yufanActiveEndpointId: id });
    renderEndpoints();
    showToast("已设为默认");
  }

  async function testEndpoint(id) {
    if (isTempId(id)) {
      setEditorStatus(id, "请先保存端点", "err");
      return;
    }
    const ep = endpoints.find((e) => e.id === id);
    if (!ep || !ep.url) {
      setEditorStatus(id, "端点信息不完整", "err");
      return;
    }

    // 临时设为激活再测试，测试完恢复
    const previousActive = activeEndpointId;
    setEditorStatus(id, "测试中...", "");
    try {
      activeEndpointId = id;
      await chrome.storage.sync.set({ yufanActiveEndpointId: id });

      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: "YUFAN_TRANSLATE", payload: { text: "hello", source: "en", target: "zh-CN" } },
          resolve
        );
      });

      if (resp && resp.ok) {
        const t = resp.data && resp.data.translated ? resp.data.translated : "OK";
        setEditorStatus(id, `连接正常 · ${t}`, "ok");
      } else {
        setEditorStatus(id, (resp && resp.error) || "连接失败", "err");
      }
    } catch (e) {
      setEditorStatus(id, "测试异常: " + (e.message || e), "err");
    } finally {
      activeEndpointId = previousActive;
      await chrome.storage.sync.set({ yufanActiveEndpointId: previousActive });
      renderEndpoints();
    }
  }

  function addEndpoint() {
    // 同一时刻只允许一个“添加端点”的新建表单：上一个未完成（未保存）时，聚焦它而非再开一个空表单
    if (newIds.size > 0) {
      const existing = [...newIds][0];
      const editor = endpointList.querySelector(`.endpoint-editor[data-id="${existing}"]`);
      if (editor) {
        const input = editor.querySelector('[data-field="name"]');
        if (input) input.focus();
      }
      showToast("请先完成当前端点的添加或取消");
      return;
    }
    const tempId = "temp_" + tempIdCounter++;
    editingIds.add(tempId);
    newIds.add(tempId);
    renderEndpoints();
    // 聚焦到名称输入框
    const input = endpointList.querySelector(`.endpoint-editor[data-id="${tempId}"] [data-field="name"]`);
    if (input) input.focus();
  }

  function startEdit(id) {
    if (isTempId(id)) return;
    editingIds.add(id);
    renderEndpoints();
  }

  // ---------- Event delegation ----------
  function initEvents() {
    // 侧边栏切换
    menuItems.forEach((btn) => {
      btn.addEventListener("click", () => switchSection(btn.dataset.section));
    });

    // MyMemory 邮箱
    if (myMemoryEmail) {
      myMemoryEmail.addEventListener("change", saveMyMemoryEmail);
      myMemoryEmail.addEventListener("blur", () => {
        const v = myMemoryEmail.value.trim();
        if (v && !isEmailLike(v)) {
          setStatus(myMemoryEmailStatus, "邮箱格式不完整，将不会生效", "err");
        }
      });
    }
    if (testMyMemoryEmail) {
      testMyMemoryEmail.addEventListener("click", testMyMemory);
    }

    // 划词胶囊设置
    if (selectionEnabled) selectionEnabled.addEventListener("change", savePillSettings);
    if (pillTempClose) pillTempClose.addEventListener("change", savePillSettings);
    if (searchEnabled) searchEnabled.addEventListener("change", savePillSettings);
    if (searchAutoJump) searchAutoJump.addEventListener("change", savePillSettings);
    if (openLinkEnabled) openLinkEnabled.addEventListener("change", savePillSettings);
    if (copyEnabled) copyEnabled.addEventListener("change", savePillSettings);
    initSearchEngineSelect();

    // 端点列表
    if (addEndpointBtn) {
      addEndpointBtn.addEventListener("click", addEndpoint);
    }
    if (endpointList) {
      endpointList.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-action]");
        if (!btn) return;
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        if (!id) return;

        switch (action) {
          case "save":
            saveEndpoint(id);
            break;
          case "test":
            testEndpoint(id);
            break;
          case "delete":
            deleteEndpoint(id);
            break;
          case "edit":
            startEdit(id);
            break;
          case "activate":
            // radio change
            if (btn.checked) activateEndpoint(id);
            break;
        }
      });

      // 实时把编辑器里的输入回写到草稿，避免重渲染 / 切页后内容丢失
      endpointList.addEventListener("input", (e) => {
        const editor = e.target.closest(".endpoint-editor");
        if (!editor) return;
        const id = editor.dataset.id;
        const cur = draftValues.get(id) || { name: "", url: "", key: "" };
        const nameEl = editor.querySelector('[data-field="name"]');
        const urlEl = editor.querySelector('[data-field="url"]');
        const keyEl = editor.querySelector('[data-field="key"]');
        draftValues.set(id, {
          name: nameEl ? nameEl.value : cur.name,
          url: urlEl ? urlEl.value : cur.url,
          key: keyEl ? keyEl.value : cur.key,
        });
      });
    }
  }

  // ---------- Init ----------
  function init() {
    setText(headerVersion, CURRENT_VERSION);
    setText(aboutVersion, CURRENT_VERSION);

    initEvents();
    initVersionPopover();
    loadSettings();
    updateQuotaStatus();
    loadEndpoints();
  }

  init();
})();
