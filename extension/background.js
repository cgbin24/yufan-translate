// Service worker: proxies translation calls so content scripts don't hit
// third-party CORS. Handles messages from content.js and popup.js.

// ---- API 配置（仅存在于 service worker 中，页面无法读取）----
// 注意：客户端混淆只能提高门槛，无法绝对防止逆向。
// 校验签名 + 时间戳防重放 + 按扩展 ID 限流。
const DEFAULT_API = "https://myhdphrunruqdbqeznjg.supabase.co/functions/v1/translate";
// 签名密钥：用于 HMAC 签名校验
const API_SECRET = "yufan_sk_2024_a8f3b2e1c9d7";

// 中文相关语言代码（含简体/繁体变体），用于同语言判断
const ZH_CODES = new Set(["zh", "zh-CN", "zh-TW", "zh-Hans", "zh-Hant", "chinese"]);
const EN_CODES = new Set(["en", "en-US", "en-GB", "english"]);

const isZhCode = (code) => ZH_CODES.has(String(code || "").toLowerCase());

// 归一化语言代码到主语言（zh-CN/zh-TW -> zh，en-US -> en）
const normalizeLang = (code) => {
  const c = String(code || "").toLowerCase();
  if (c.startsWith("zh")) return "zh";
  if (c.startsWith("en")) return "en";
  return c.split("-")[0] || c;
};

// 本地兜底：通过中文字符占比判断文本是否为中文
// 改进：用占比（而非绝对数量比较），更可靠地处理中英混排
const looksLikeChinese = (text) => {
  const t = String(text || "");
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  const total = cjk + letters;
  if (total === 0) return false;
  // 中文字符占比超过 30% 即判定为中文（容忍少量英文单词混排）
  return cjk / total > 0.3;
};

// 同语言保护：源和目标不能相同。相同则自动切换目标语言
// 规则：源是中文 -> 目标改英文；源非中文 -> 目标改中文
const resolveTarget = (text, source, target) => {
  // source 明确时直接比较归一化后的主语言
  if (source && source !== "auto") {
    if (normalizeLang(source) === normalizeLang(target)) {
      return isZhCode(source) ? "en" : "zh-CN";
    }
    return target;
  }
  // source 为 auto：先用本地启发式做一次预判，避免明显同语言请求
  if (looksLikeChinese(text)) {
    if (isZhCode(target)) return "en";
  } else {
    if (!isZhCode(target)) return "zh-CN";
  }
  return target;
};

// ---- 请求签名：防止 API 被外部直接调用 ----
// 生成 HMAC-SHA256 签名，后端用相同密钥校验
// 包含时间戳（防重放）+ 随机数（防预测）+ 扩展 ID（标识来源）
async function hmacSha256(key, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function buildAuthHeaders() {
  const ts = Date.now();
  const nonce = crypto.getRandomValues(new Uint8Array(8));
  const nonceStr = Array.from(nonce)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // 扩展 ID（已安装扩展才有，开发模式下可能为空）
  const extId = chrome.runtime.id || "dev";
  // 签名内容：时间戳 + 随机数 + 扩展 ID
  const signContent = `${ts}.${nonceStr}.${extId}`;
  const signature = await hmacSha256(API_SECRET, signContent);
  return {
    "Content-Type": "application/json",
    "X-Yufan-Ts": String(ts),
    "X-Yufan-Nonce": nonceStr,
    "X-Yufan-Ext-Id": extId,
    "X-Yufan-Sig": signature,
  };
}

async function getApiBase() {
  try {
    const { yufanApiBase } = await chrome.storage.sync.get("yufanApiBase");
    return (yufanApiBase && yufanApiBase.trim()) || DEFAULT_API;
  } catch (_) {
    return DEFAULT_API;
  }
}

async function translate(payload) {
  const base = await getApiBase();
  const headers = await buildAuthHeaders();
  const res = await fetch(`${base}/translate`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${errText}`);
  }
  return await res.json();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "YUFAN_TRANSLATE") {
    const { text, source, target } = msg.payload || {};
    const safeTarget = resolveTarget(text, source, target);
    const finalPayload = { ...msg.payload, target: safeTarget };
    const originalText = String(text || "").trim();

    const finalize = (data) => {
      // 统一字段映射：后端用 detectedSource，前端统一用 detected
      const detected = (data && (data.detectedSource || data.detected)) || "";
      if (detected) data.detected = detected;
      // 后端不返回 provider，补默认标识，避免前端显示 undefined
      if (!data.provider) data.provider = "Yufan";
      return { data, detected };
    };

    translate(finalPayload)
      .then((raw) => {
        const { data, detected } = finalize(raw);
        const translated = String((data && data.translated) || "").trim();

        // 同语言检测：满足任一条件即需要重译
        // 1) 后端返回的 detectedSource 与目标同语言
        // 2) 翻译结果与原文完全相同（最可靠的兜底，防止「中文翻成中文」）
        const sameByDetected =
          detected && normalizeLang(detected) === normalizeLang(safeTarget);
        const sameByResult =
          originalText && translated && originalText === translated;

        if (sameByDetected || sameByResult) {
          // 根据检测到的源语言选择一个不同的目标语言
          const retryTarget = isZhCode(detected || safeTarget)
            ? "en"
            : "zh-CN";
          if (retryTarget !== safeTarget) {
            return translate({ ...finalPayload, target: retryTarget }).then(
              (raw2) => {
                const { data: d2, detected: d2Detected } = finalize(raw2);
                const t2 = String((d2 && d2.translated) || "").trim();
                // 重译后仍和原文相同：再尝试英文兜底（覆盖所有非中文场景）
                if (originalText && t2 && t2 === originalText) {
                  const finalRetry = isZhCode(d2Detected || retryTarget)
                    ? "en"
                    : "zh-CN";
                  if (finalRetry !== retryTarget) {
                    return translate({
                      ...finalPayload,
                      target: finalRetry,
                    }).then((raw3) => {
                      const { data: d3 } = finalize(raw3);
                      sendResponse({ ok: true, data: d3 });
                    });
                  }
                }
                sendResponse({ ok: true, data: d2 });
              }
            );
          }
        }
        sendResponse({ ok: true, data });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message || "翻译失败" }));
    return true; // async
  }
  return false;
});

// ---------- Context menu: translate page ----------
// MV3 service worker 可能在休眠后重启，每次启动都重新创建菜单（用 removeAll 避免重复）
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "yufan-translate-page",
    title: "语翻 · 翻译此页面",
    contexts: ["page", "selection"],
  });
});
// service worker 重启时也要重新创建
chrome.runtime.onStartup.addListener(() => {
  chrome.contextMenus.create({
    id: "yufan-translate-page",
    title: "语翻 · 翻译此页面",
    contexts: ["page", "selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "yufan-translate-page" && tab && tab.id) {
    // 向当前页面所有 frame（含 iframe）的 content script 发送翻译指令。
    // 每个帧内都有独立的 content.js 实例（manifest all_frames:true），
    // 各自翻译自己 document 内的文本节点。
    broadcastTranslatePage(tab.id, info.frameId);
  }
});

// 向指定 tab 的所有 frame 广播页面翻译指令。
// targetFrameId: 右键菜单触发时所在的 frame（info.frameId），
//   传 0/undefined 表示从 top frame 开始；实际会广播到全部 frame。
async function broadcastTranslatePage(tabId, _targetFrameId) {
  const payload = { type: "YUFAN_TRANSLATE_PAGE" };

  // 先尝试拿到该 tab 下所有 frame（含跨源 iframe）
  let frames = [];
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch (_) {
    frames = [];
  }

  // 没拿到 frame 列表（如缺少 webNavigation 权限），退化为只发 top frame
  if (!frames || frames.length === 0) {
    frames = [{ frameId: 0 }];
  }

  // 逐 frame 发送；对未加载 content script 的帧先注入再重试
  for (const f of frames) {
    const frameId = f.frameId;
    chrome.tabs.sendMessage(tabId, payload, { frameId }, () => {
      if (chrome.runtime.lastError) {
        // 该帧尚未注入 content script，注入后重发
        chrome.scripting
          .executeScript({
            target: { tabId, frameIds: [frameId] },
            files: ["content.js"],
          })
          .then(() => {
            chrome.tabs.sendMessage(tabId, payload, { frameId }, () => {
              // 注入后仍可能因跨源策略失败，忽略 lastError
              void chrome.runtime.lastError;
            });
          })
          .catch(() => {
            // 部分帧（如 about:blank、chrome:// 内嵌）无法注入，忽略
          });
      }
    });
  }
}
