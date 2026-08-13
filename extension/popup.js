const LANGS = [
  { code: "auto", label: "自动检测" },
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

const $ = (id) => document.getElementById(id);

const populate = (select, langs, exclude = []) => {
  select.innerHTML = "";
  langs.forEach((l) => {
    if (exclude.includes(l.code)) return;
    const opt = document.createElement("option");
    opt.value = l.code;
    opt.textContent = l.label;
    select.appendChild(opt);
  });
};

// ---------- Custom select (replaces native <select> UI) ----------
// Keeps the native <select> in the DOM for form semantics & a11y,
// but renders a styled listbox inside the popup so it never gets clipped
// by the browser's native dropdown panel.
const setupCustomSelect = (selectId) => {
  const select = $(selectId);
  if (!select) return;
  const wrapper = select.closest(".yufan-select");
  if (!wrapper) return;
  const trigger = wrapper.querySelector(".yufan-select-trigger");
  const labelEl = wrapper.querySelector(".yufan-select-label");
  const menu = wrapper.querySelector(".yufan-select-menu");

  const renderMenu = () => {
    menu.innerHTML = "";
    Array.from(select.options).forEach((opt) => {
      const li = document.createElement("li");
      li.className = "yufan-select-option";
      li.setAttribute("role", "option");
      li.dataset.value = opt.value;
      li.innerHTML = `<span>${opt.textContent}</span><svg class="check" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
      li.addEventListener("click", (e) => {
        e.stopPropagation();
        select.value = opt.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        close();
      });
      menu.appendChild(li);
    });
    syncSelection();
  };

  const syncSelection = () => {
    const current = select.value;
    labelEl.textContent =
      (select.selectedOptions[0] && select.selectedOptions[0].textContent) ||
      "";
    menu.querySelectorAll(".yufan-select-option").forEach((li) => {
      li.classList.toggle("selected", li.dataset.value === current);
    });
  };

  const open = () => {
    // close any other open selects first
    document.querySelectorAll(".yufan-select.open").forEach((w) => {
      if (w !== wrapper) w.classList.remove("open");
    });
    wrapper.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
    // scroll selected option into view
    const selected = menu.querySelector(".yufan-select-option.selected");
    if (selected) {
      requestAnimationFrame(() =>
        selected.scrollIntoView({ block: "nearest" })
      );
    }
  };

  const close = () => {
    wrapper.classList.remove("open");
    trigger.setAttribute("aria-expanded", "false");
  };

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (wrapper.classList.contains("open")) close();
    else open();
  });

  // Keep custom UI in sync when <select> value changes externally
  // (e.g. swap button, doTranslate auto-adjust, storage restore)
  select.addEventListener("change", syncSelection);

  renderMenu();
  return { open, close, sync: syncSelection };
};

const initSelectors = async () => {
  populate($("source"), LANGS);
  populate($("target"), LANGS.filter((l) => l.code !== "auto"));
  // 先初始化自定义下拉，让 UI 立即可用；默认值先设上，storage 读取异步回填
  $("source").value = "auto";
  $("target").value = "zh-CN";
  setupCustomSelect("source");
  setupCustomSelect("target");
  // 异步读取已保存的语言偏好，不阻塞事件绑定与首屏交互
  chrome.storage.sync
    .get(["yufanSource", "yufanTarget"])
    .then((saved) => {
      if (saved.yufanSource) {
        $("source").value = saved.yufanSource;
        $("source").dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (saved.yufanTarget) {
        $("target").value = saved.yufanTarget;
        $("target").dispatchEvent(new Event("change", { bubbles: true }));
      }
    })
    .catch(() => {});
};

// Close all custom selects when clicking outside or pressing Escape
document.addEventListener("click", () => {
  document
    .querySelectorAll(".yufan-select.open")
    .forEach((w) => w.classList.remove("open"));
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document
      .querySelectorAll(".yufan-select.open")
      .forEach((w) => w.classList.remove("open"));
  }
});

const setLoading = (loading) => {
  const btn = $("translate");
  btn.disabled = loading;
  btn.querySelector("span").textContent = loading ? "翻译中" : "翻译";
  if (loading) {
    $("output").innerHTML = '<div class="dots"><span></span><span></span><span></span></div>';
    $("output").classList.remove("error");
  }
};

const doTranslate = async () => {
  const text = $("input").value.trim();
  if (!text) {
    $("output").innerHTML = '<span class="placeholder">请输入文本</span>';
    return;
  }
  let source = $("source").value;
  let target = $("target").value;
  // 同语言保护：源和目标不能相同
  // source 非 auto 且与 target 同语言 -> 自动切换 target
  // source 为 auto -> 用本地启发式预判，避免明显同语言请求（background 会再兜底）
  const normZh = (c) => String(c || "").toLowerCase().startsWith("zh");
  const normEq = (a, b) => {
    const na = String(a || "").toLowerCase().split("-")[0];
    const nb = String(b || "").toLowerCase().split("-")[0];
    return na === nb;
  };
  if (source !== "auto" && normEq(source, target)) {
    target = normZh(source) ? "en" : "zh-CN";
    $("target").value = target;
    $("target").dispatchEvent(new Event("change", { bubbles: true }));
  } else if (source === "auto") {
    const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const letters = (text.match(/[A-Za-z]/g) || []).length;
    const looksZh = cjk > 0 && cjk >= letters;
    if (looksZh && normZh(target)) {
      target = "en";
      $("target").value = target;
      $("target").dispatchEvent(new Event("change", { bubbles: true }));
    } else if (!looksZh && !normZh(target)) {
      target = "zh-CN";
      $("target").value = target;
      $("target").dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  setLoading(true);
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "YUFAN_TRANSLATE",
      payload: { text, source, target },
    });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || "翻译失败");
    $("output").textContent = resp.data.translated;
    $("output").classList.remove("error");
    $("provider").textContent = `来源：${resp.data.provider}${
      resp.data.detected ? " · 识别：" + resp.data.detected : ""
    }`;
  } catch (e) {
    $("output").textContent = "翻译失败：" + (e.message || "网络异常");
    $("output").classList.add("error");
    $("provider").textContent = "";
  } finally {
    setLoading(false);
  }
};

const doSwap = async () => {
  const s = $("source");
  const t = $("target");
  if (s.value === "auto") return; // cannot swap auto
  const tmp = s.value;
  s.value = t.value;
  t.value = tmp;
  // Trigger change so the custom dropdown UI & storage listeners stay in sync
  s.dispatchEvent(new Event("change", { bubbles: true }));
  t.dispatchEvent(new Event("change", { bubbles: true }));
  const swap = $("swap");
  swap.classList.add("spin");
  setTimeout(() => swap.classList.remove("spin"), 350);
  // also swap input/output text if both filled
  const inputVal = $("input").value.trim();
  const outVal = $("output").textContent.trim();
  if (outVal && outVal !== "请输入文本" && !$("output").classList.contains("error")) {
    $("input").value = outVal;
    $("output").innerHTML = inputVal
      ? inputVal
      : '<span class="placeholder">译文将在此显示</span>';
    updateCounter();
  }
  chrome.storage.sync.set({ yufanSource: s.value, yufanTarget: t.value }).catch(() => {});
};

const updateCounter = () => {
  const len = $("input").value.length;
  $("counter").textContent = `${len} / 1000`;
};

const doCopy = async () => {
  const txt = $("output").textContent.trim();
  if (!txt || $("output").querySelector(".placeholder")) return;
  try {
    await navigator.clipboard.writeText(txt);
    const label = $("copyLabel");
    const old = label.textContent;
    label.textContent = "已复制";
    setTimeout(() => (label.textContent = old), 1300);
  } catch (_) {}
};

document.addEventListener("DOMContentLoaded", () => {
  // 同步初始化 UI（populate + setupCustomSelect 不依赖网络），立即绑定事件，
  // 确保 popup 一出现就可交互；storage 读取在 initSelectors 内部异步进行
  initSelectors();
  updateCounter();
  $("input").addEventListener("input", updateCounter);
  $("translate").addEventListener("click", doTranslate);
  $("swap").addEventListener("click", doSwap);
  $("copy").addEventListener("click", doCopy);
  $("input").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") doTranslate();
  });
  $("source").addEventListener("change", () =>
    chrome.storage.sync.set({ yufanSource: $("source").value }).catch(() => {})
  );
  $("target").addEventListener("change", () =>
    chrome.storage.sync.set({ yufanTarget: $("target").value }).catch(() => {})
  );
});
