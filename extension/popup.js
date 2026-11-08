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
  // 弹窗每次打开都重置选项/输入/翻译结果（保持清爽），仅保留系统配置
  // （自定义 API 端点等"高级设置"项不受影响 —— 见 initSettings 的 chrome.storage.sync.get）。
  $("source").value = "auto";
  $("target").value = "zh-CN";
  $("input").value = "";
  $("output").innerHTML = '<span class="placeholder">译文将在此显示</span>';
  $("output").classList.remove("error", "output-text");
  const dh = $("dictHead");
  if (dh) dh.hidden = true;
  $("provider").textContent = "";
  delete $("output").dataset.mode;
  delete $("output").__lastData;
  // 字符计数重置
  const counter = $("counter");
  if (counter) counter.textContent = "0 / 1000";
  setupCustomSelect("source");
  setupCustomSelect("target");
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
    // 隐藏词典头，等新结果回来再决定
    const dh = $("dictHead");
    if (dh) dh.hidden = true;
  }
};

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// ============== Popup 端独立翻译兜底 ==============
// 不依赖 background service worker 版本的释义翻译逻辑。
// 直接在浏览器 fetch MyMemory，绕过整个 background 端 translateDefinitionsToTarget。
// 用于 background 是旧版本（脏数据 / translatedMeanings=null）时的兜底。
const isEnglishPos = (pos) => {
  if (!pos) return false;
  const s = String(pos).trim();
  if (s.length === 0 || s.length > 8) return false;
  return /^[A-Za-z.]+$/.test(s);
};
const isEnglishWord = (s) => {
  const t = String(s || "").trim();
  if (!t) return false;
  if (t.length > 30) return false;
  return /^[A-Za-z][A-Za-z\s\-'.&]*$/.test(t);
};
// popup 端 MyMemory 配额冷却：403 / 业务配额耗尽后，
// 短时间内不再发兜底请求，避免刷屏并报错。
let popupMyMemoryCooldownUntil = 0;
const isPopupMyMemoryCooling = () => Date.now() < popupMyMemoryCooldownUntil;
const markPopupMyMemoryCooldown = (minutes = 10) => {
  popupMyMemoryCooldownUntil = Date.now() + minutes * 60 * 1000;
};

const popupCallMyMemory = async (text, source, target) => {
  if (!text || !String(text).trim()) return "";
  if (isPopupMyMemoryCooling()) {
    throw new Error("MyMemory 配额冷却中（popup 兜底暂停）");
  }
  // 读邮箱配额（用户可选设置）。不设也能走，但配额较低。
  let de = "";
  try {
    const got = await chrome.storage.sync.get("yufanMyMemoryEmail");
    de = String((got && got.yufanMyMemoryEmail) || "").trim();
    if (de && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(de)) de = "";
  } catch (_) {}
  let url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(source)}|${encodeURIComponent(target)}`;
  if (de) url += `&de=${encodeURIComponent(de)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    if (resp.status === 429 || resp.status === 403) markPopupMyMemoryCooldown();
    throw new Error(`MyMemory HTTP ${resp.status}`);
  }
  const j = await resp.json();
  if (j && j.responseStatus && j.responseStatus !== 200 && j.responseStatus !== "200") {
    const detail = String(j.responseDetails || "");
    if (detail.toUpperCase().includes("MYMEMORY WARNING") || detail.includes("配额") || detail.includes("QUOTA")) {
      const min = parseInt(detail.match(/(\d+)\s*min/i)?.[1], 10) || 10;
      markPopupMyMemoryCooldown(min);
    }
    throw new Error(`MyMemory 业务错误 ${j.responseStatus}`);
  }
  const translated = (j && j.responseData && j.responseData.translatedText) || "";
  if (String(translated).toUpperCase().includes("MYMEMORY WARNING")) {
    const min = parseInt(String(translated).match(/(\d+)\s*min/i)?.[1], 10) || 10;
    markPopupMyMemoryCooldown(min);
    throw new Error(`MyMemory 业务错误（配额）`);
  }
  return translated;
};
// 同语言判定：主语言相同，且（若为中文）地区也相同。
// zh-CN 与 zh-TW 不算同语言 —— 繁简互译是用户的真实需求。
const popupSameLang = (a, b) => {
  const na = String(a || "").toLowerCase().split("-")[0];
  const nb = String(b || "").toLowerCase().split("-")[0];
  if (!na || !nb || na !== nb) return false;
  if (na !== "zh") return true;
  // 中文按地区细分：简体 / 繁体 / 港澳
  const region = (c) => {
    const s = String(c || "").toLowerCase();
    if (s === "zh-cn" || s === "zh-hans" || s === "zh") return "zh-CN";
    if (s === "zh-tw" || s === "zh-hant") return "zh-TW";
    if (s === "zh-hk" || s === "zh-mo") return "zh-HK";
    return "";
  };
  const ra = region(a);
  const rb = region(b);
  return !!ra && !!rb && ra === rb;
};

// 简繁特征字（与 background.js 同源）：用于判断一段中文该往哪个方向转
const SIMP_SIG =
  "们个国这来时会说对开发过还经体图书长门问样东马语认识应边该设备论计划营业务产动实现关车电见觉记讲让卫击华汉级纪组织终统维络网货质责贫费资赛转轮输办帮广庆库厅厕";
const TRAD_SIG =
  "們個國這來時會說對開發過還經體圖書長門問樣東馬語認識應邊該設備論計劃營業務產動實現關車電見覺記講讓衛擊華漢級紀組織終統維絡網貨質責貧費資賽轉輪輸辦幫廣慶庫廳廁";
const countSigChars = (text, sig) => {
  let n = 0;
  for (const ch of String(text || "")) if (sig.indexOf(ch) !== -1) n++;
  return n;
};
// 简体 -> 繁体（离线，零联网）：复用上面的简繁特征字表做 1:1 映射。
const S2T_MAP = (() => {
  const m = {};
  const n = Math.min(SIMP_SIG.length, TRAD_SIG.length);
  for (let i = 0; i < n; i++) m[SIMP_SIG[i]] = TRAD_SIG[i];
  return m;
})();
const popupToTraditional = (text) => {
  if (!text) return text;
  let out = "";
  for (const ch of String(text)) out += S2T_MAP[ch] || ch;
  return out;
};
const popupIsTraditionalTarget = (code) => {
  const s = String(code || "").toLowerCase();
  return s === "zh-tw" || s === "zh-hant" || s === "zh-hant-tw";
};
const popupNormalizeLang = (code) => {
  const c = String(code || "").toLowerCase();
  if (!c) return "";
  if (c.startsWith("zh")) return "zh";
  if (c.startsWith("en")) return "en";
  return c.split("-")[0] || c;
};

// 主入口：把 meanings 数组翻译成 target 语言，结构保持不变。
// 分组策略：英文 POS + 英文 def → en group（en→target 翻译）；
//          中文 POS / 中文 def → source group（source→target 翻译）。
const popupTranslateMeanings = async (meanings, source, target) => {
  if (!Array.isArray(meanings) || !meanings.length) return null;
  // 收集 lines + refs
  const lines = [];
  const refs = [];
  for (let i = 0; i < meanings.length; i++) {
    if (meanings[i].partOfSpeech) {
      lines.push(`p:${meanings[i].partOfSpeech}`);
      refs.push({ kind: "pos", idx: i });
    }
    for (let j = 0; j < (meanings[i].definitions || []).length; j++) {
      lines.push(`d:${meanings[i].definitions[j].definition}`);
      refs.push({ kind: "def", idx: i, defIdx: j });
    }
  }
  // 分组
  const groupEn = { lines: [], refs: [] };
  const groupSrc = { lines: [], refs: [] };
  for (let k = 0; k < lines.length; k++) {
    const ref = refs[k];
    const segPos = meanings[ref.idx] && meanings[ref.idx].partOfSpeech;
    let grp = isEnglishPos(segPos) ? groupEn : groupSrc;
    if (grp === groupSrc && ref.kind === "def") {
      const defText = String(lines[k] || "").replace(/^d\s*[:：]\s*/i, "").trim();
      if (isEnglishWord(defText)) grp = groupEn;
    }
    grp.lines.push(lines[k]);
    grp.refs.push(ref);
  }
  const groups = [];
  if (groupEn.lines.length) groups.push({ lines: groupEn.lines, refs: groupEn.refs, srcFor: "en" });
  if (groupSrc.lines.length) groups.push({ lines: groupSrc.lines, refs: groupSrc.refs, srcFor: source || "zh-CN" });
  // 切块（避免超 500 字符限制）
  const MAX_BLOCK = 400;
  const blocks = [];
  for (const grp of groups) {
    let curLines = [], curRefs = [], curLen = 0;
    for (let k = 0; k < grp.lines.length; k++) {
      const line = grp.lines[k];
      const ref = grp.refs[k];
      if (line.length >= MAX_BLOCK) {
        if (curLines.length) blocks.push({ lines: curLines, refs: curRefs, srcFor: grp.srcFor });
        blocks.push({ lines: [line], refs: [ref], srcFor: grp.srcFor });
        curLines = []; curRefs = []; curLen = 0;
        continue;
      }
      if (curLen + line.length + (curLines.length ? 1 : 0) > MAX_BLOCK) {
        blocks.push({ lines: curLines, refs: curRefs, srcFor: grp.srcFor });
        curLines = [line]; curRefs = [ref]; curLen = line.length;
        continue;
      }
      curLines.push(line);
      curRefs.push(ref);
      curLen += line.length + (curLines.length > 1 ? 1 : 0);
    }
    if (curLines.length) blocks.push({ lines: curLines, refs: curRefs, srcFor: grp.srcFor });
  }
  // 深拷贝输出
  const out = JSON.parse(JSON.stringify(meanings));
  // 翻译每块（并发，避免逐块串行把兜底时间拉成 N 倍）
  await Promise.all(blocks.map(async (block) => {
    const joined = block.lines.join("\n");
    let translated = "";
    try {
      translated = await popupCallMyMemory(joined, block.srcFor, target);
    } catch (e) {
      // 整块失败（如 403）：单条再试，避免一条 en→zh-TW 配额耗尽导致整段英文 defs 全部回退
      console.warn(`[yufan popup] fallback block fail (${block.srcFor}->${target}):`, e && e.message);
      await Promise.all(block.refs.map(async (ref) => {
        const origLine = block.lines[block.refs.indexOf(ref)] || "";
        const origCleaned = origLine.replace(/^[pde][\s]*[:：][\s]*/i, "").trim();
        try {
          const single = await popupCallMyMemory(origCleaned, block.srcFor, target);
          if (!single) return;
          const cleaned = String(single).trim().replace(/^[pde][\s]*[:：][\s]*/i, "").trim();
          if (!cleaned || cleaned === origCleaned) return;
          if (ref.kind === "pos" && out[ref.idx]) out[ref.idx].partOfSpeech = cleaned;
          else if (ref.kind === "def" && out[ref.idx] && out[ref.idx].definitions[ref.defIdx]) {
            out[ref.idx].definitions[ref.defIdx].definition = cleaned;
          }
        } catch (_) {}
      }));
      return;
    }
    const translatedLines = String(translated).split(/\r?\n/);
    for (let k = 0; k < block.refs.length; k++) {
      const ref = block.refs[k];
      const tl = translatedLines[k];
      if (tl == null) continue;
      const tlTrim = String(tl).trim();
      const origLine = block.lines[k] || "";
      const cleaned = tlTrim.replace(/^[pde][\s]*[:：][\s]*/i, "").trim();
      const origCleaned = origLine.replace(/^[pde][\s]*[:：][\s]*/i, "").trim();
      if (!cleaned) continue;
      if (origCleaned && cleaned === origCleaned) continue;
      if (origCleaned && cleaned.length > origCleaned.length * 3 + 20) continue;
      if (ref.kind === "pos" && out[ref.idx]) out[ref.idx].partOfSpeech = cleaned;
      else if (ref.kind === "def" && out[ref.idx] && out[ref.idx].definitions[ref.defIdx]) {
        out[ref.idx].definitions[ref.defIdx].definition = cleaned;
      }
    }
  }));
  return out;
};

// 兜底重组例句为 {ex, tr}（与 background 的 translateExamplesToTarget 同源逻辑）。
// 输入：[{en, cn}]（Bing 双语例句）；输出：[{ex, tr}]
//   ex = 例句（目标语言，主显示），tr = 同句译文（源语言，附显示）。
// 常见情况（en/zh 目标）Bing 已双语，纯本地重组，零联网、不耗配额、不报错。
// 仅"其他目标语言"才走 MyMemory（配额冷却时跳过）。
const popupTranslateExamples = async (examples, target, source = "zh-CN") => {
  if (!Array.isArray(examples) || !examples.length) return null;
  const t = popupNormalizeLang(target);
  const isEnTarget = t === "en";
  const isZhTarget = t === "zh";
  const isTrad = popupIsTraditionalTarget(target);
  const srcIsZh = !!source && String(source).toLowerCase().startsWith("zh");

  const out = examples.map((e) => {
    const en = (e && e.en ? String(e.en) : "").trim();
    const cn = (e && e.cn ? String(e.cn) : "").trim();
    if (isEnTarget) return { ex: en || cn, tr: en ? cn : "" };
    if (isZhTarget) {
      let zh = cn || en;
      if (isTrad && zh) zh = popupToTraditional(zh);
      return { ex: zh, tr: isTrad ? (cn || en) : (en || cn) };
    }
    return { ex: srcIsZh ? cn : en, tr: srcIsZh ? cn : en };
  });

  // 仅"其他目标语言"才需要联网翻译缺失侧
  if (!isEnTarget && !isZhTarget && !isPopupMyMemoryCooling()) {
    const src = srcIsZh ? "zh-CN" : "en";
    const texts = out.map((o) => o.ex).filter(Boolean);
    if (texts.length) {
      const MAX_BLOCK = 400;
      const blocks = [];
      let cur = [], curLen = 0;
      for (const p of out) {
        const line = p.ex;
        if (!line) continue;
        if (line.length >= MAX_BLOCK) {
          if (cur.length) blocks.push(cur);
          blocks.push([p]); cur = []; curLen = 0; continue;
        }
        if (curLen + line.length + (cur.length ? 1 : 0) > MAX_BLOCK) {
          blocks.push(cur); cur = [p]; curLen = line.length; continue;
        }
        cur.push(p); curLen += line.length + (cur.length > 1 ? 1 : 0);
      }
      if (cur.length) blocks.push(cur);
      await Promise.all(blocks.map(async (block) => {
        const joined = block.map((p) => p.ex).join("\n");
        try {
          const translated = await popupCallMyMemory(joined, src, target);
          const lines = String(translated).split(/\r?\n/);
          block.forEach((p, k) => {
            const v = String(lines[k] || "").trim();
            if (v) p.ex = v;
          });
        } catch (e) {
          console.log("[yufan popup] examples fallback translate failed:", e && e.message);
        }
      }));
    }
  }
  return out;
};

// 播放单词发音（popup 端）：与 content script 同一套 background fetch data URL 模式
const playPronunciationPopup = async (audioUrl, audioBtn) => {
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
  } catch (_) {}
  try {
    const src = dataUrl || audioUrl;
    const a = new Audio(src);
    a.preload = "auto";
    a.onplaying = () => setState("playing");
    a.onended = () => setState("idle");
    a.onerror = () => setState("error");
    await a.play();
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

// 渲染词典结果到 popup 面板
const renderDictResult = (data) => {
  const head = $("dictHead");
  if (!head) return;
  // 音标从 dictHead 行拿出来，合并到"翻译结果"标题位，避免单独占行。
  // 形式："fú wù  服务"  （音标在前，词在后；如无音标则不显示音标）
  $("dictWord").hidden = true;
  $("dictPhonetic").textContent = data.phonetic || "";
  const audioBtn = $("dictAudio");
  const hasAudio = !!data.audio;
  if (hasAudio) {
    audioBtn.hidden = false;
    audioBtn.dataset.state = "idle";
    audioBtn.disabled = false;
    audioBtn.onclick = () => playPronunciationPopup(data.audio, audioBtn);
  } else {
    audioBtn.hidden = true;
    audioBtn.onclick = null;
    audioBtn.dataset.state = "";
  }
  const label = $("outputLabel");
  if (label) {
    const word = (data.word || data.detectedWord || "").trim();
    const phonetic = (data.phonetic || "").trim();
    // 词头去重：textarea 里已经输过源词了，标题位不再重复显示。
    // 避免"释义面板上方再出现一次源文"造成重复视觉。
    const inputVal = ($("input") && $("input").value || "").trim();
    const wordDup = word && inputVal && word === inputVal;
    if (phonetic || (word && !wordDup)) {
      const parts = [];
      if (phonetic) parts.push(`<span class="output-label-phonetic">${escapeHtml(phonetic)}</span>`);
      if (word && !wordDup) parts.push(`<span class="output-label-word">${escapeHtml(word)}</span>`);
      if (parts.length) {
        label.innerHTML = parts.join(" ");
        label.classList.add("is-dict");
      } else {
        label.textContent = "翻译结果";
        label.classList.remove("is-dict");
      }
    } else {
      label.textContent = "翻译结果";
      label.classList.remove("is-dict");
    }
  }
  // dictHead 整行已合并到标题位，不再单独显示
  head.hidden = true;

  // 主体
  const list = (data.translatedMeanings && data.translatedMeanings.length)
    ? data.translatedMeanings
    : data.meanings || [];
  // 翻译未生效提示：词典模式但释义没被翻译成目标语言。
  // 只在"确实该翻译却没翻译"时出现 —— 英文单词 + 目标英语 属于正常情况，
  // 不该报警（旧代码只判断繁中目标，其余语种的同类问题反而被漏掉，
  // 而 en->en 又从不报警，两个方向都不对）。
  // 注意：用 UI 上当前选中的 target 判断，不要用 data.target（语言保护重试后
  // data.target 可能被改成 "en"，会让"释义未翻译成目标语言"提示条被错误吞掉）。
  const targetOnUI = $("target").value || data.target;
  // 释义语言与目标语言是否属于"同一种语言"（此时不翻译是正常的）
  const sameAsDictSrc = popupSameLang(data.detected || "en", targetOnUI);
  let translateMissingHint = "";
  if (
    data.mode === "dictionary" &&
    (!data.translatedMeanings || !data.translatedMeanings.length) &&
    targetOnUI &&
    !sameAsDictSrc
  ) {
    translateMissingHint = `<div class="dict-translate-hint" data-testid="dict-translate-hint">
      <strong>释义未翻译为目标语言</strong> · 当前显示的是词典原始释义。
      通常是翻译额度用尽或网络异常，可稍后重试，或在高级设置中填入邮箱提升额度。
    </div>`;
  }
  if (!list.length) {
    $("output").innerHTML = '<div class="output-error">未找到该单词的释义。</div>';
    return;
  }
  const html = list.map((m) => {
    // 必应词典把网络释义标成「网络 / 网路 / web」，统一本地化为「网络释义」更专业。
    const POS_LABEL_MAP = { 网络: "网络释义", 网路: "网络释义", web: "网络释义" };
    const normPos = (p) => POS_LABEL_MAP[String(p || "").trim().toLowerCase()] || p;
    const pos = m.partOfSpeech ? `<span class="dict-pos">${escapeHtml(normPos(m.partOfSpeech))}</span>` : "";
    const defs = (m.definitions || []).map((d, i) => {
      const defText = d.definition || "";
      // 例句双语显示
      const exOrig = (d.exampleOriginal || "").trim();
      const exTrans = (d.example || "").trim();
      let exampleBlock = "";
      if (exOrig && exTrans && exOrig !== exTrans) {
        exampleBlock = `<div class="dict-example">
          <div class="dict-ex-orig">${escapeHtml(exOrig)}</div>
          <div class="dict-ex-trans">例：${escapeHtml(exTrans)}</div>
        </div>`;
      } else if (exOrig) {
        exampleBlock = `<div class="dict-example"><div class="dict-ex-orig">例：${escapeHtml(exOrig)}</div></div>`;
      } else if (exTrans) {
        exampleBlock = `<div class="dict-example"><div class="dict-ex-trans">例：${escapeHtml(exTrans)}</div></div>`;
      }
      const syn = (d.synonyms && d.synonyms.length)
        ? `<div class="dict-chips"><span class="dict-chip-label">同义</span>${d.synonyms.slice(0, 5).map((s) => `<span class="dict-chip">${escapeHtml(s)}</span>`).join("")}</div>`
        : "";
      const ant = (d.antonyms && d.antonyms.length)
        ? `<div class="dict-chips"><span class="dict-chip-label">反义</span>${d.antonyms.slice(0, 5).map((s) => `<span class="dict-chip">${escapeHtml(s)}</span>`).join("")}</div>`
        : "";
      return `<li class="dict-def"><span class="dict-def-num">${i + 1}.</span><div class="dict-def-body">${escapeHtml(defText)}${exampleBlock}${syn}${ant}</div></li>`;
    }).join("");
    return `<div class="dict-pos-block">${pos}<ol class="dict-defs">${defs}</ol></div>`;
  }).join("");
  // 必应词典会带回 10 条例句（en/cn 双语），单列一个"例句"块
  // popup 高度有限（13 寸 Mac 视窗 ≈ 800-900px），默认只显示前 2 条例句 +
  // 展开按钮（避免装不下 9 条把 popup 撑出屏幕）
  // 用 <button> + JS 控制显示，不用 <details>/<summary>，因为 Chrome popup 内
  // <details> 的折叠状态在高度锁定后不可靠。
  let examplesBlock = "";
  // 优先用 background 翻译后的 translatedExamples（target 语言），
  // 否则回退到原始 examples。MV3 service worker 跑旧版时 translatedExamples=null，
  // 上面 popup 兜底已写入 data.translatedExamples。
  const renderExamples = (data.translatedExamples && data.translatedExamples.length)
    ? data.translatedExamples
    : (Array.isArray(data.examples) ? data.examples : []);
  // 归一化：新结构 {ex, tr} 直接渲染；旧结构 {en, cn}（来自 data.examples 兜底）
  // 按"中文目标"展示（en 主显 + cn 对照），与 Bing 双语一致。
  const normalizeEx = (e) => {
    if (!e) return { ex: "", tr: "" };
    if (e.ex !== undefined || e.tr !== undefined) return { ex: e.ex || "", tr: e.tr || "" };
    const en = (e.en || "").trim();
    const cn = (e.cn || "").trim();
    return { ex: cn || en, tr: en || cn };
  };
  const normExamples = (Array.isArray(renderExamples) ? renderExamples : []).map(normalizeEx);
  if (normExamples.length) {
    const preview = normExamples.slice(0, 2);
    const rest = normExamples.slice(2);
    const renderItem = (e) => {
      const ex = e.ex || "";
      const tr = e.tr || "";
      if (!ex && !tr) return "";
      // ex = 例句（目标语言，主显示）；tr = 同句译文（源语言，附显示）
      return `
        <li class="dict-ex-item">
          <div class="dict-ex-main">${escapeHtml(ex)}</div>
          ${tr ? `<div class="dict-ex-tr">${escapeHtml(tr)}</div>` : ""}
        </li>`;
    };
    if (rest.length > 0) {
      // 用 button 控制：默认隐藏剩余例句，点击后展开
      const moreId = `dictExMore_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      examplesBlock = `<div class="dict-examples-block">
        <div class="dict-examples-title">例句 · ${normExamples.length} 条</div>
        <ol class="dict-examples-list">${preview.map(renderItem).join("")}</ol>
        <ol class="dict-examples-list dict-examples-rest" id="${moreId}" hidden>${rest.map(renderItem).join("")}</ol>
        <button type="button" class="dict-examples-toggle" data-target="${moreId}" aria-expanded="false">
          <span class="dict-examples-toggle-text">展开剩余 ${rest.length} 条例句</span>
          <svg class="dict-examples-toggle-caret" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </button>
      </div>`;
    } else {
      examplesBlock = `<div class="dict-examples-block">
        <div class="dict-examples-title">例句</div>
        <ol class="dict-examples-list">${normExamples.map(renderItem).join("")}</ol>
      </div>`;
    }
  }
  $("output").innerHTML = translateMissingHint + html + examplesBlock;
  // 绑定展开按钮的点击事件（不用 <details>，因为 popup 高度锁后状态不可靠）
  // 只有 examples > 2 才有展开按钮（rest 变量才存在），避免 ReferenceError
  if (Array.isArray(normExamples) && normExamples.length > 2) {
    const restCount = normExamples.length - 2;
    $("output").querySelectorAll(".dict-examples-toggle").forEach((btn) => {
      const textEl = btn.querySelector(".dict-examples-toggle-text");
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
        if (textEl) {
          textEl.textContent = expanded
            ? btn.dataset.collapsedText || textEl.textContent
            : btn.dataset.expandedText || textEl.textContent;
        }
        btn.classList.toggle("is-expanded", !expanded);
      });
    });
  }
  $("output").classList.remove("error");
};

// 把结果数据转成可复制纯文本
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

const doTranslate = async () => {
  const text = $("input").value.trim();
  if (!text) {
    $("output").innerHTML = '<span class="placeholder">请输入文本</span>';
    const dh = $("dictHead");
    if (dh) dh.hidden = true;
    return;
  }
  let source = $("source").value;
  let target = $("target").value;
  // 锁定"用户在 UI 上原始选中的目标语言"。后续任何"语言保护"重试、
  // popup 兜底翻译、MyMemory 调用都必须用这个值，不能用 data.target
  // （会被重试改写成 "en"）。这是修"简中→繁中变成 en->en 403"的关键。
  const userTarget = target;
  // 语言保护（前置）：仅当用户**显式**指定了 source 且与 target 同主语言时自动切换。
  // source === "auto" 不做猜测 —— 因为我们无法在客户端可靠判断文本语言。
  // 真正"auto 检测到与 target 同语言"的重试放在后置：根据 background 返回的 `detected` 自动调整。
  const normZh = (c) => String(c || "").toLowerCase().startsWith("zh");
  const normEq = (a, b) => {
    const na = String(a || "").toLowerCase().split("-")[0];
    const nb = String(b || "").toLowerCase().split("-")[0];
    return na === nb;
  };
  // 中文地区区分（zh-CN / zh-TW / zh-HK），同地区才算同语言。
  // 繁简互译（zh-CN <-> zh-TW）属于合法翻译请求，不应被自动切走。
  const getZhRegion = (c) => {
    const s = String(c || "").toLowerCase();
    if (s === "zh-cn" || s === "zh-hans") return "zh-CN";
    if (s === "zh-tw" || s === "zh-hant") return "zh-TW";
    if (s === "zh-hk" || s === "zh-mo") return "zh-HK";
    if (s === "zh" || s === "chinese") return "zh-CN";
    return null;
  };
  const zhEq = (a, b) => {
    const ra = getZhRegion(a);
    const rb = getZhRegion(b);
    if (ra && rb) return ra === rb;
    return false; // 非中文或缺少地区信息时不算"同中文"
  };
  // 切换目标：仅当确实同语言（同主语言且同中文地区）才切走。
  const pickOpposite = (code) => (normZh(code) ? "en" : "zh-CN");
  if (source !== "auto" && (normEq(source, target) || zhEq(source, target))) {
    target = pickOpposite(source);
    $("target").value = target;
    $("target").dispatchEvent(new Event("change", { bubbles: true }));
  } else if (source === "auto" && normEq(target, "zh")) {
    // target=zh 时启发式判断文本是否像中文：是则把 target 切到 en，
    // 避免 background 那边的"源==目标"防御抛错。
    // 例外：target=zh-TW / zh-Hant / zh-HK 时跳过——繁简互译是合法请求，
    // 交给 background 的 getZhRegion 地区比较走 zh-CN -> zh-TW 翻译路径。
    const tgtLow = String(target || "").toLowerCase();
    const isTraditionalTarget = tgtLow === "zh-tw" || tgtLow === "zh-hant" || tgtLow === "zh-hk";
    if (!isTraditionalTarget) {
      const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
      const letters = (text.match(/[A-Za-z]/g) || []).length;
      if (cjk > letters) {
        target = "en";
        $("target").value = target;
        $("target").dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  }
  setLoading(true);
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "YUFAN_TRANSLATE",
      payload: { text, source, target },
    });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || "翻译失败");
    let data = resp.data || {};
    // 诊断：popup 收到的 data 关键字段，排查"释义未翻译为目标语言"提示条触发原因
    try {
      console.log(`[yufan popup] data.mode=${data.mode} data.detected=${data.detected} data.target=${data.target} translatedMeanings=${data.translatedMeanings ? `Array(${data.translatedMeanings.length}) firstDef=${data.translatedMeanings[0] && data.translatedMeanings[0].definitions && data.translatedMeanings[0].definitions[0] && data.translatedMeanings[0].definitions[0].definition}` : "null"}`);
    } catch (e) { console.log("[yufan popup] data log failed", e); }
    const out = $("output");
    if (data.mode === "dictionary") {
      // 单词走词典：渲染多词性多释义（含例句、同反义词、必应词典的双语例句）
      out.classList.remove("output-text");
      // === Popup 端兜底翻译 ===
      // background 现在在 source≠target 时一定会翻译释义（translateDefinitionsToTarget），
      // 所以绝大多数情况 translatedMeanings 已经就位，无需兜底。
      // 只在 background 确实没翻译（画像为 null/空，通常是 MyMemory 额度用尽或
      // 网络异常导致翻译接口抛错）时，popup 才直接在浏览器里 fetch MyMemory 补翻一次。
      // 不再用"译文仍含英文 / 与原文逐条相同"之类的脆弱字符串启发式——
      // 它们既会误触发（白白多打一次请求、拖慢响应），又依赖不可靠的正则判定。
      // background 是唯一事实来源，popup 只补不判。
      // 用 userTarget（doTranslate 入口锁定的用户原始目标）作为补翻目标，
      // 逃过一切语言保护重试对 target 的改写。
      const dictSrc = data.detected || "en";
      const noTranslateExpected = normZh(dictSrc)
        ? zhEq(dictSrc, userTarget)
        : normEq(dictSrc, userTarget);
      const wantTranslate = !!userTarget && !noTranslateExpected;

      // 释义兜底：仅当 background 确实没给译文时补翻。
      const needFallback = wantTranslate && (!data.translatedMeanings || !data.translatedMeanings.length);
      if (needFallback) {
        try {
          const fixed = await popupTranslateMeanings(data.meanings, dictSrc, userTarget);
          if (fixed && fixed.length) {
            data = { ...data, translatedMeanings: fixed };
            console.log("[yufan popup] fallback translate OK, def[0]=" + fixed[0].definitions[0].definition);
          }
        } catch (e) {
          console.log("[yufan popup] fallback translate failed:", e && e.message);
        }
      }
      // 例句兜底：background 没给 translatedExamples（旧 service worker / 异常）时，
      // 用原始 examples（Bing 双语 {en,cn}）本地重组为 {ex,tr}。
      // 常见 en/zh 目标纯本地、零联网；其他目标才走 MyMemory（配额冷却时跳过）。
      const haveTranslated = !!(data.translatedExamples && data.translatedExamples.length && data.translatedExamples[0] && data.translatedExamples[0].ex);
      if (!haveTranslated && Array.isArray(data.examples) && data.examples.length) {
        try {
          const fixedEx = await popupTranslateExamples(data.examples, userTarget, data.detected || "zh-CN");
          if (fixedEx && fixedEx.length) {
            data = { ...data, translatedExamples: fixedEx };
            console.log("[yufan popup] examples fallback rebuilt, count=" + fixedEx.length);
          }
        } catch (e) {
          console.log("[yufan popup] examples fallback failed:", e && e.message);
        }
      }
      renderDictResult(data);
    } else {
      // 句子 / 词典未命中：纯翻译
      const dh = $("dictHead");
      if (dh) dh.hidden = true;
      const lbl = $("outputLabel");
      if (lbl) {
        lbl.textContent = "翻译结果";
        lbl.classList.remove("is-dict");
      }
      const audioBtn = $("dictAudio");
      if (audioBtn) audioBtn.hidden = true;
      out.classList.add("output-text");
      out.textContent = data.translated || "";
      out.classList.remove("error");
    }
    $("provider").textContent = `来源：${data.provider}${
      data.detected ? " · 识别：" + data.detected : ""
    }`;
    $("output").dataset.mode = data.mode || "translation";
    $("output").__lastData = data;
  } catch (e) {
    // 安全网：source=auto + 前置启发式漏判（比如 CJK 与拉丁字符数量相当）
    // 导致 background 抛"源语言和目标语言相同"。在这里再翻一次目标语言
    // 并重试，绝不让用户看到这条错误。
    const msg = e && e.message ? e.message : "";
    const sameLangErr = msg.includes("源语言和目标语言相同");
    if (sameLangErr && source === "auto" && !["zh-TW", "zh-Hant", "zh-HK"].includes(target)) {
      const newTarget = normZh(target) ? "en" : "zh-CN";
      if (newTarget !== target) {
        target = newTarget;
        $("target").value = target;
        $("target").dispatchEvent(new Event("change", { bubbles: true }));
        try {
          const resp2 = await chrome.runtime.sendMessage({
            type: "YUFAN_TRANSLATE",
            payload: { text, source, target },
          });
          if (resp2 && resp2.ok) {
            const data2 = resp2.data || {};
            const out = $("output");
            if (data2.mode === "dictionary") {
              out.classList.remove("output-text");
              renderDictResult(data2);
            } else {
              const dh = $("dictHead");
              if (dh) dh.hidden = true;
              out.classList.add("output-text");
              out.textContent = data2.translated || "";
              out.classList.remove("error");
            }
            $("provider").textContent = `来源：${data2.provider}${
              data2.detected ? " · 识别：" + data2.detected : ""
            }`;
            out.dataset.mode = data2.mode || "translation";
            out.__lastData = data2;
            return; // 成功路径走 finally
          }
        } catch (_) {
          // 重试也失败 -> 落到下面的默认错误显示
        }
      }
    }
    $("output").textContent = "翻译失败：" + (msg || "网络异常");
    $("output").classList.add("error");
    // 错误态加 output-text（pre-wrap 保留错误消息里的换行）
    $("output").classList.add("output-text");
    $("provider").textContent = "";
    const dh = $("dictHead");
    if (dh) dh.hidden = true;
    // 配额相关错误：立即刷新横幅，让用户看到"填邮箱可解锁"的入口
    if (msg && (msg.includes("今日免费翻译额度已用完") || msg.includes("MYMEMORY WARNING"))) {
      refreshQuotaBanner();
    }
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
  // Trigger change so the custom dropdown UI stays in sync with the <select> value
  s.dispatchEvent(new Event("change", { bubbles: true }));
  t.dispatchEvent(new Event("change", { bubbles: true }));
  const swap = $("swap");
  swap.classList.add("spin");
  setTimeout(() => swap.classList.remove("spin"), 350);
  // also swap input/output text if both filled
  // 字典模式（结构化结果）不参与 swap，避免把多行释义塞回 input
  const out = $("output");
  if (out.dataset.mode !== "dictionary") {
    const inputVal = $("input").value.trim();
    const outVal = out.textContent.trim();
    if (outVal && outVal !== "请输入文本" && !out.classList.contains("error")) {
      $("input").value = outVal;
      out.innerHTML = inputVal
        ? inputVal
        : '<span class="placeholder">译文将在此显示</span>';
      updateCounter();
    }
  }
  // 源/目标语言不持久化（每次打开重置），无需写 storage
};

const updateCounter = () => {
  const len = $("input").value.length;
  $("counter").textContent = `${len} / 1000`;
};

const doCopy = async () => {
  const out = $("output");
  if (out.querySelector(".placeholder")) return;
  const data = out.__lastData;
  const txt = collectCopyText(data || {}) || out.textContent.trim();
  if (!txt) return;
  try {
    await navigator.clipboard.writeText(String(txt).trim());
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
  initSettings();
  updateCounter();
  $("input").addEventListener("input", updateCounter);
  $("translate").addEventListener("click", doTranslate);
  $("swap").addEventListener("click", doSwap);
  $("copy").addEventListener("click", doCopy);
  $("input").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") doTranslate();
  });
  // 源/目标语言、输入文本、翻译结果都不持久化 —— 弹窗每次打开都是默认状态。
  // 系统配置（自定义 API 端点）由 initSettings() 独立从 storage 读取。

  // 检查 background 的消息协议是否兼容：只有在消息结构真的变了
  // （protocol 不一致）时才静默 reload 一次。
  //
  // 旧实现比对的是一个"迭代号"字符串（v2026-09-02.2），它硬编码在 popup.js
  // 里、又必须与 background.js 手工同步。漏改一次，popup 每次打开都会判定
  // "版本不一致"并触发 chrome.runtime.reload()，扩展陷入反复重启、弹窗不可用。
  // 改成协议版本后，常规发版不再触发 reload，漂移风险消失。
  chrome.runtime.sendMessage({ type: "YUFAN_PING" })
    .then(async (resp) => {
      if (!resp || !resp.ok) return;
      // 必须与 background.js 的 MSG_PROTOCOL 一致
      const expectedProtocol = "yufan-msg-1";
      if (resp.protocol === expectedProtocol) return;
      // 拿不到 session storage 就放弃 reload —— 宁可不重启，也不能冒重载循环的风险
      if (!chrome.storage || !chrome.storage.session) return;
      let guard = null;
      try {
        guard = await chrome.storage.session.get("yufanReloadGuard");
      } catch (_) {
        return;
      }
      // 每个浏览器会话最多 reload 一次：即使协议判定本身有误，也不会循环重启
      if (guard && guard.yufanReloadGuard) return;
      try {
        await chrome.storage.session.set({ yufanReloadGuard: Date.now() });
      } catch (_) {
        return;
      }
      console.log(
        `[yufan popup] bg protocol mismatch: got=${resp.protocol} expected=${expectedProtocol}, reload once…`
      );
      try { chrome.runtime.reload(); } catch (_) {}
    })
    .catch(() => {});
});

// ---------- Settings (custom API endpoint) ----------
// 留空 = 用 background 内置的 MyMemory 翻译。
// 填了非空 URL = 走用户自定义端点（POST {text,source,target} -> {translated,detected?,provider?}）。
// 查询 background 的冷却状态，决定是否显示配额警告横幅
// 在 initSettings 之外定义，供 doTranslate 错误分支也能调用。
const refreshQuotaBanner = () => {
  const banner = $("quotaBanner");
  const bannerText = $("quotaBannerText");
  if (!banner || !bannerText) return;
  chrome.runtime
    .sendMessage({ type: "YUFAN_QUOTA_STATUS" })
    .then((resp) => {
      if (!resp || !resp.ok) {
        banner.hidden = true;
        return;
      }
      const d = resp.data || {};
      if (d.quotaExhausted) {
        const remain = d.remaining || "稍后";
        if (d.apiKeyConfigured) {
          bannerText.innerHTML = `MyMemory 今日免费额度已用完（<strong>${escapeHtml(remain)}</strong>）。换一个邮箱即可重置配额桶，或在自定义端点里接入自己的翻译服务。`;
        } else {
          bannerText.innerHTML = `MyMemory 今日免费额度已用完（<strong>${escapeHtml(remain)}</strong>）。在下方填一个邮箱可将额度从 5,000 字符提升到 50,000 字符。`;
        }
        banner.hidden = false;
      } else {
        // 未耗尽，但剩余不到 20% 时提前给个温和提醒，
        // 让用户不至于毫无预期地撞上 429（旧逻辑只有彻底耗尽才提示）。
        const left = typeof d.charsLeft === "number" ? d.charsLeft : Infinity;
        const limit = typeof d.charsLimit === "number" ? d.charsLimit : 5000;
        if (left < limit * 0.2) {
          bannerText.innerHTML = `MyMemory 免费额度快用完了（今日剩余 <strong>${left.toLocaleString()}</strong> / ${limit.toLocaleString()} 字符）。填一个邮箱可提升到 50,000 字符。`;
          banner.hidden = false;
        } else {
          banner.hidden = true;
        }
      }
    })
    .catch(() => {
      banner.hidden = true;
    });
};

// settings-toggle / 高级设置按钮 -> 跳转到独立 settings page
const initSettings = () => {
  const toggle = $("settingsToggle");
  if (!toggle) return;
  toggle.addEventListener("click", (e) => {
    e.preventDefault();
    if (chrome.runtime && chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      // 退化方案：直接打开 options.html
      window.open(chrome.runtime.getURL("options.html"), "_blank");
    }
  });
  // 重新加载 service worker 按钮：用户遇到"释义没翻译成目标语言"时点击，
  // MV3 service worker 一旦加载会常驻 5 分钟，仅刷新 popup 不会重载后台代码。
  // chrome.runtime.reload() 会重启整个 extension（包括 service worker），
  // reload 后所有 JS 重新解析，新代码生效。
  const reloadBtn = $("reloadServiceBtn");
  if (reloadBtn) {
    reloadBtn.addEventListener("click", (e) => {
      e.preventDefault();
      // 视觉反馈
      reloadBtn.disabled = true;
      reloadBtn.style.opacity = "0.5";
      reloadBtn.title = "正在重启翻译服务…";
      // 调 chrome.runtime.reload() —— 会立即重启整个 extension
      // （包括 service worker），popup 也会被关闭。用户重新点扩展图标即可。
      try {
        chrome.runtime.reload();
      } catch (err) {
        // 退化方案：发个 message 让 background 自己 reload
        chrome.runtime.sendMessage({ type: "YUFAN_RELOAD" }).catch(() => {});
        // 给一个明显提示
        alert("请点击 chrome://extensions → 找到『语翻 Yufan』→ 点 🔄 刷新按钮");
      }
    });
  }
  // 首次检查配额状态（横幅仍由 popup 渲染）
  refreshQuotaBanner();
  // 清理旧版本遗留的语言偏好键（不再持久化）
  chrome.storage.sync.remove(["yufanSource", "yufanTarget"]).catch(() => {});
};
