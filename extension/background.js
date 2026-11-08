// Service worker: orchestrates translation requests and routes them to the
// configured provider. Acts as a small dispatcher so content scripts and
// popup can stay provider-agnostic.
//
// 启动横幅：方便用户确认 background.js 是否为最新版本（MV3 service worker
// 不会自动 reload，必须手动到 chrome://extensions 点 🔄）。
console.log("[yufan bg v2026-09-02.2] language-detect + dict-merge + cache/concurrency + batch translate + 例句内容过滤 + title/popover动态翻译");
//
// Default providers:
//   - Sentence / phrase translation: MyMemory (https://api.mymemory.translated.net)
//       Free, no API key, generous anonymous quota (~5000 chars/day/IP).
//   - Single-word lookup: Free Dictionary API (https://api.dictionaryapi.dev)
//       Returns phonetics + multi partOfSpeech + multi definitions + examples.
//       English-only. Auto-fallback to MyMemory if the word is not found.
//   - CJK lookup: Bing Dictionary (cn.bing.com/dict) 零鉴权，支持中/日/韩。
//
// Optional: user can override the translation endpoint via
// chrome.storage.sync.yufanApiEndpoint. Dictionary lookup is not overridable.
//
// Protocol with caller (content.js / popup.js):
//   sendMessage({ type: "YUFAN_TRANSLATE", payload: { text, source, target, noDict? } })
//   -> { ok: true, data: { mode, translated, detected, provider, ... } }
//      mode: "translation" | "dictionary"
//      translation: { translated, detected, provider }
//      dictionary:  { translated, detected, provider, word, phonetic, meanings: [...] }
//   -> { ok: false, error: "<message>" }
//
//   sendMessage({ type: "YUFAN_TRANSLATE_BATCH", payload: { texts[], source, target } })
//   -> { ok: true, data: { results: string[], target, detected } }   // results 与 texts 等长
//
//   sendMessage({ type: "YUFAN_DETECT", payload: { text } })
//   -> { ok: true, data: { code, confident } }

// ========== Config ==========
// 前后台消息协议版本。**只**在消息结构发生不兼容变更时才 bump。
//
// 历史教训：早期让 popup 拿一个"迭代号"（v2026-09-02.2 这种日期串）和
// background 比对，不一致就 chrome.runtime.reload()。两个数字分处两个文件、
// 靠人工同步，一旦漏改，popup 每次打开都会 reload 扩展 —— 表现为扩展反复
// 重启、弹窗根本没法用。协议版本只在真正需要时才变，从根上消除这类漂移。
const MSG_PROTOCOL = "yufan-msg-1";

const DEFAULT_MYMEMORY = "https://api.mymemory.translated.net/get";
const DEFAULT_DICTIONARY = "https://api.dictionaryapi.dev/api/v2/entries/en";
const BING_DICT_URL = "https://cn.bing.com/dict/search";

// 单次请求硬超时。划词 / popup 输入都是"同步等一个结果"的交互场景：
// 用户能忍受的等待远低于"请求最终成功"的阈值。与其让 loading 转 15 秒，
// 不如早点放弃、走降级路径（词典失败 -> MyMemory；整页翻译 -> 保留原文）。
//
// 旧值（REQUEST 15000 / DICT 6000）是整页翻译时代的遗留：那时上千条批量请求
// 可以慢慢等。但 popup 查词是一次性等待，而 cn.bing.com 在网络不佳时经常
// 挂到超时才失败 —— 6 秒的词典超时直接把"查个单词"变成 6 秒白屏，
// 也是 popup "点下去半天没反应"的主因。
const REQUEST_TIMEOUT_MS = 8000;
const DICT_TIMEOUT_MS = 3000;
const AUDIO_TIMEOUT_MS = 10000;
// 例句是"锦上添花"，不值得为它拖慢主结果。cn.bing.com 的 sentenceSeg 常比
// 释义接口更慢，旧实现给它和主词典一样的 6s 超时 —— 用户查一个词的耗时
// 因此被最慢的那个可选请求决定。这里单独给一个短软超时：超时就当没例句，
// 释义和音标照常返回（实测可把"Bing 抽风"场景从 6s+ 压到 1.5s）。
const BING_EXAMPLES_TIMEOUT_MS = 1500;
// 整页翻译的批次超时。**绝不能**复用 REQUEST_TIMEOUT_MS：
// 一批最多 60~120 条短文本，background 内部再按 450 字符分桶、并发 4 打
// MyMemory，一个批次往往要跑几十个请求。之前这里用了交互场景的 8s 超时
// （为 popup 收窄 REQUEST_TIMEOUT_MS 时误伤），整批在 8s 被 abort、
// results 全空 —— 表现就是"右键整页翻译毫无反应"。
// 按批次规模给预算：基础 20s + 每条 250ms，上限 60s。
const BATCH_TIMEOUT_MS = 20000;
const BATCH_TIMEOUT_PER_TEXT_MS = 250;
const BATCH_TIMEOUT_MAX_MS = 60000;

// 语言代码 -> MyMemory langpair 格式
const LANG_TO_MM = {
  "zh": "zh-CN",
  "zh-CN": "zh-CN",
  "zh-Hans": "zh-CN",
  "zh-TW": "zh-TW",
  "zh-Hant": "zh-TW",
  "en": "en",
  "en-US": "en",
  "en-GB": "en",
  "ja": "ja",
  "ko": "ko",
  "fr": "fr",
  "de": "de",
  "es": "es",
  "ru": "ru",
  "it": "it",
  "pt": "pt",
  "ar": "ar",
  "th": "th",
  "vi": "vi",
};

// ========== 语言工具 ==========
const isZhCode = (code) => {
  const c = String(code || "").toLowerCase();
  return c === "zh" || c.startsWith("zh-") || c === "chinese";
};

// 归一化到主语言（zh-CN/zh-TW -> zh，en-US -> en）
const normalizeLang = (code) => {
  const c = String(code || "").toLowerCase();
  if (!c) return "";
  if (c.startsWith("zh")) return "zh";
  if (c.startsWith("en")) return "en";
  return c.split("-")[0] || c;
};

// 区分中文地区代码（zh-CN / zh-TW / zh-HK）
const getZhRegion = (code) => {
  const c = String(code || "").toLowerCase();
  if (c === "zh-cn" || c === "zh-hans" || c === "zh-hant-cn") return "zh-CN";
  if (c === "zh-tw" || c === "zh-hant" || c === "zh-hant-tw") return "zh-TW";
  if (c === "zh-hk" || c === "zh-mo") return "zh-HK";
  if (c === "zh" || c === "chinese") return "zh-CN"; // 不带地区的"中文"默认按简中
  return null;
};

// 是否繁体中文目标（zh-TW / zh-Hant）
const isTraditionalTarget = (code) => getZhRegion(code) === "zh-TW";

// 简体 -> 繁体（离线，零联网零配额）：复用简繁特征字表做 1:1 映射，见下方定义。
const toTraditional = (() => {
  let S2T_MAP = null;
  return (text) => {
    if (!text) return text;
    if (!S2T_MAP) {
      S2T_MAP = {};
      const n = Math.min(SIMP_SIG.length, TRAD_SIG.length);
      for (let i = 0; i < n; i++) S2T_MAP[SIMP_SIG[i]] = TRAD_SIG[i];
    }
    let out = "";
    for (const ch of String(text)) out += S2T_MAP[ch] || ch;
    return out;
  };
})();

// 简繁特征字：用于判断一段中文是简体还是繁体。
// 这两个串一一对应（后者是前者的繁体写法），保证判定对称、不偏袒某一侧。
const SIMP_SIG =
  "们个国这来时会说对开发过还经体图书长门问样东马语认识应边该设备论计划营业务产动实现关车电见觉记讲让卫击华汉级纪组织终统维络网货质责贫费资赛转轮输办帮广庆库厅厕历厉压厌亿仅从仓仪价份伙伟传伤伦伪伴佛佣佩佳使侦侧侨侮侵便促俄俊俏俘保信修俱倡候借倦值假偏做停健偷催像僚优偿储儿党兰兴养兽内冈册写军农冠冻净准凉凑减凭凯刘则刚创初删别刮到制刷券刺刻剑功加务助努劲势劝区协县参双发变叙叶号叹吗呀吨听吹吻吧咚呵";
const TRAD_SIG =
  "們個國這來時會說對開發過還經體圖書長門問樣東馬語認識應邊該設備論計劃營業務產動實現關車電見覺記講讓衛擊華漢級紀組織終統維絡網貨質責貧費資賽轉輪輸辦幫廣慶庫廳廁歷厲壓厭億僅從倉儀價份夥偉傳傷倫偽伴佛傭佩佳使偵側僑侮侵便促俄俊俏俘保信修俱倡候借倦值假偏做停健偷催像僚優償儲兒黨蘭興養獸內岡冊寫軍農冠凍淨準涼湊減憑凱劉則剛創初刪別颳到製刷券刺刻劍功加務助努勁勢勸區協縣參雙發變敘葉號嘆嗎呀噸聽吹吻吧咚呵";

// 拉丁字母语言的停用词表：英文/法文/德文/西文/意文/葡文/越南文。
// 单看字母无法区分这些语言（"Bonjour le monde" 和 "Hello the world"
// 长得一样），只能用停用词做概率判定 —— 判定不出语种就没法做同语言保护。
const LATIN_STOPWORDS = [
  {
    code: "en",
    words: new Set([
      "the", "be", "to", "of", "and", "in", "that", "have", "it", "for",
      "not", "on", "with", "he", "as", "you", "do", "at", "this", "but", "his",
      "by", "from", "they", "we", "say", "her", "she", "or", "an", "will", "my",
      "one", "all", "would", "there", "their", "what", "so", "up", "out", "if",
      "about", "who", "get", "which", "go", "me", "when", "make", "can", "like",
      "time", "no", "just", "him", "know", "take", "people", "into", "year",
      "your", "good", "some", "could", "them", "see", "other", "than", "then",
      "now", "look", "only", "come", "its", "over", "think", "also", "back",
      "after", "use", "two", "how", "our", "work", "first", "well", "way",
      "even", "new", "want", "because", "any", "these", "give", "day", "most",
      "us", "is", "are", "was", "were", "has", "had", "been", "being",
    ]),
  },
  {
    code: "fr",
    words: new Set([
      "le", "la", "les", "de", "des", "un", "une", "et", "est", "sont", "pour",
      "avec", "dans", "sur", "je", "tu", "il", "elle", "nous", "vous", "ils",
      "que", "qui", "ne", "pas", "ce", "cette", "au", "aux", "du", "comme",
      "mais", "ou", "où", "tout", "plus", "être", "avoir", "faire", "elle",
      "son", "ses", "leur", "leurs", "cette", "cet", "une", "très", "bien",
    ]),
  },
  {
    code: "de",
    words: new Set([
      "der", "die", "das", "und", "ist", "sind", "für", "mit", "auf", "ein",
      "eine", "nicht", "ich", "du", "er", "sie", "es", "wir", "ihr", "den",
      "dem", "des", "zu", "von", "bei", "aus", "als", "auch", "noch", "nur",
      "sehr", "kann", "haben", "hat", "werden", "wird", "war", "sein", "dass",
    ]),
  },
  {
    code: "es",
    words: new Set([
      "el", "los", "las", "del", "y", "son", "para", "con", "en", "como",
      "pero", "por", "una", "yo", "tú", "él", "ella", "nosotros", "ustedes",
      "no", "sí", "al", "más", "que", "se", "su", "sus", "este", "esta",
      "todo", "muy", "ser", "tener", "hacer", "hay", "era", "fue", "sobre",
    ]),
  },
  {
    code: "it",
    words: new Set([
      "il", "lo", "gli", "di", "da", "in", "con", "su", "per", "ed", "è",
      "sono", "che", "non", "uno", "questo", "questa", "molto", "anche",
      "tutti", "tutte", "del", "della", "dei", "delle", "al", "alla", "nel",
      "essere", "avere", "fare", "come", "più", "solo", "perché", "quando",
    ]),
  },
  {
    code: "pt",
    words: new Set([
      "os", "as", "do", "da", "dos", "das", "são", "com", "em", "mas",
      "uma", "não", "sim", "ao", "mais", "se", "seu", " seus", "este", "esta",
      "todo", "muito", "ser", "ter", "fazer", "há", "era", "foi", "sobre",
      "para", "por", "que", "como", "ele", "ela", "nós", "você", "eles",
    ]),
  },
  {
    code: "vi",
    words: new Set([
      "là", "và", "của", "các", "trong", "không", "có", "được", "với",
      "những", "này", "kia", "tôi", "bạn", "chúng", "để", "cho", "từ",
      "theo", "như", "khi", "nào", "một", "hai", "rất", "cũng", "đã", "sẽ",
      "đang", "về", "trên", "dưới", "nếu", "thì", "mà", "bởi", "nên",
    ]),
  },
];

const countMatches = (text, re) => {
  const m = String(text).match(re);
  return m ? m.length : 0;
};
const countSigChars = (text, sig) => {
  let n = 0;
  for (const ch of String(text)) {
    if (sig.indexOf(ch) !== -1) n++;
  }
  return n;
};

// 本地语言检测：按字符脚本 + 英文停用词启发式判断。
// 返回 { code, confident }：
//   code      — "zh-CN" / "zh-TW" / "ja" / "ko" / "ru" / "ar" / "th" / "en" / ""
//   confident — 是否有把握。false 表示"看起来是拉丁字母但分不清是英法德西"，
//               调用方遇到 confident=false 时不应据此改写用户选择的目标语言。
//
// 判定顺序很关键：日文含汉字，所以假名优先于汉字；韩文/西里尔/阿拉伯/泰文同理。
const detectLang = (text) => {
  const t = String(text || "");
  if (!t.trim()) return { code: "", confident: false };

  const kana = countMatches(t, /[\u3040-\u309f\u30a0-\u30ff]/g);
  const hangul = countMatches(t, /[\uac00-\ud7af]/g);
  const cjk = countMatches(t, /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g);
  const cyr = countMatches(t, /[\u0400-\u04ff]/g);
  const arab = countMatches(t, /[\u0600-\u06ff]/g);
  const thai = countMatches(t, /[\u0e00-\u0e7f]/g);
  const latin = countMatches(t, /[A-Za-z]/g);

  if (kana > 0) return { code: "ja", confident: true };
  if (hangul > 0) return { code: "ko", confident: true };
  if (cyr > 0 && cyr >= latin) return { code: "ru", confident: true };
  if (arab > 0 && arab >= latin) return { code: "ar", confident: true };
  if (thai > 0 && thai >= latin) return { code: "th", confident: true };

  if (cjk > 0) {
    const simp = countSigChars(t, SIMP_SIG);
    const trad = countSigChars(t, TRAD_SIG);
    // 都没有特征字（比如「山之石」）时按简体处理
    const code = trad > simp ? "zh-TW" : "zh-CN";
    return { code, confident: true };
  }

  if (latin > 0) {
    // 拉丁字母：按各语言停用词命中数打分，取最高分
    // （含重音字母，越南语/葡语的变音符号不能漏）
    const words = t.toLowerCase().match(/[a-z\u00e0-\u024f']+/g) || [];
    let best = "";
    let bestHits = 0;
    for (const { code, words: set } of LATIN_STOPWORDS) {
      let hits = 0;
      for (const w of words) if (set.has(w)) hits++;
      if (hits > bestHits) {
        bestHits = hits;
        best = code;
      }
    }
    // 长文本要求命中 2 个停用词；极短文本（1-2 词）命中 1 个即可
    if (best && (bestHits >= 2 || (words.length <= 2 && bestHits >= 1))) {
      return { code: best, confident: true };
    }
    return { code: best || "en", confident: false };
  }
  return { code: "", confident: false };
};

// 同语言判定：主语言相同，且（若为中文）地区也相同。
// zh-CN vs zh-TW 不算同语言 —— 繁简互译是合法翻译请求。
const sameLang = (a, b) => {
  const la = normalizeLang(a);
  const lb = normalizeLang(b);
  if (!la || !lb) return false;
  if (la !== lb) return false;
  if (la === "zh") {
    const ra = getZhRegion(a);
    const rb = getZhRegion(b);
    return !!ra && !!rb && ra === rb;
  }
  return true;
};

// 取"相反"的目标语言：中文 -> 英文；其他 -> 简体中文
const oppositeLang = (code) => (isZhCode(code) ? "en" : "zh-CN");

// 同语言保护：源和目标不能相同，相同则自动切换目标语言。
// source 为 auto/空 时用本地检测兜底（旧版本此处直接 return target，
// 导致"中文文本 + 目标中文"请求打到 MyMemory 变成 zh-CN|zh-CN 而硬报错）。
const resolveTarget = (text, source, target) => {
  if (source && source !== "auto") {
    return sameLang(source, target) ? oppositeLang(source) : target;
  }
  const d = detectLang(text);
  // confident=false（拉丁字母但分不清语种）时不动用户的选择，
  // 交给后面的"译文==原文"重试兜底。
  if (d.confident && sameLang(d.code, target)) return oppositeLang(d.code);
  return target;
};

// 把 MyMemory 的源语言解析成 langpair 可用的代码
const resolveMmSource = (text, source) => {
  if (source && source !== "auto") {
    return LANG_TO_MM[source] || LANG_TO_MM[normalizeLang(source)] || "en";
  }
  const d = detectLang(text);
  return LANG_TO_MM[d.code] || LANG_TO_MM[normalizeLang(d.code)] || "en";
};

// ========== 通用小工具 ==========
// 有限并发的 map：同一时刻最多 limit 个 worker，共享一个游标推进，
// 避免旧代码"每个 worker 都遍历整个批次"造成的重复劳动。
async function mapPool(items, limit, worker) {
  const n = items.length;
  const results = new Array(n);
  if (n === 0) return results;
  const size = Math.max(1, Math.min(limit, n));
  let cursor = 0;
  const runners = [];
  for (let r = 0; r < size; r++) {
    runners.push(
      (async () => {
        for (;;) {
          const i = cursor++;
          if (i >= n) return;
          results[i] = await worker(items[i], i);
        }
      })()
    );
  }
  await Promise.all(runners);
  return results;
}

const abortError = (msg) => {
  const e = new Error(msg || "请求被中止");
  e.name = "AbortError";
  return e;
};

// 让调用方的 signal 只影响自己，不打断被共享的 in-flight 请求
function withLocalSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() =>
      signal.removeEventListener("abort", onAbort)
    );
  });
}

// 用于"译文是否等于原文"的比较：忽略大小写、空白、标点
const normalizeCompare = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");

// ========== 缓存 ==========
// service worker 会被浏览器休眠，缓存随之失效 —— 这正好符合预期：
// 短时间内的重复查询（整页翻译的大量重复串、反复查同一个词）命中缓存，
// worker 重启后自动重新取最新数据。
const CACHE_MAX = 500;
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map(); // key -> { v, exp }
// 同一 key 的并发请求共享同一个 Promise，避免重复打 API
const inflight = new Map();

const cacheGet = (key) => {
  const e = cache.get(key);
  if (!e) return undefined;
  if (Date.now() > e.exp) {
    cache.delete(key);
    return undefined;
  }
  // LRU：命中后移到队尾
  cache.delete(key);
  cache.set(key, e);
  return e.v;
};
const cacheSet = (key, v, ttl = CACHE_TTL_MS) => {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  // ttl 缺省时回落到 CACHE_TTL_MS：否则 exp 会算成 NaN，条目下一秒就判为过期，
  // 缓存形同虚设（调用方很容易漏传 ttl）。
  cache.set(key, { v, exp: Date.now() + (ttl || CACHE_TTL_MS) });
};

// 带缓存 + 请求去重的异步调用包装
// 查询顺序：内存 LRU -> 持久化缓存 -> 真正发请求
// accept(v)：可选谓词，返回 false 时"用这次结果但不写缓存"。
// 用于 fetchBingExamples 这类"失败也返回空值、从不抛错"的 producer ——
// 若把空结果缓存进去，一次网络抖动会让这个词永久查不到例句。
async function cached(key, producer, signal, ttl, accept) {
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  // 内存未命中时查持久化缓存：SW 休眠后内存缓存已经没了，
  // 但同一页面/同一批词的译文在几天内不会变，没必要重新烧配额。
  const persisted = await persistCacheGet(key);
  if (persisted !== undefined) {
    cacheSet(key, persisted, ttl); // 提升进内存 LRU，后续命中无需再读盘
    return persisted;
  }

  const pending = inflight.get(key);
  if (pending) return withLocalSignal(pending, signal);
  const p = producer()
    .then((v) => {
      if (!accept || accept(v)) {
        cacheSet(key, v, ttl);
        persistCacheSet(key, v);
      }
      inflight.delete(key);
      return v;
    })
    .catch((e) => {
      inflight.delete(key);
      throw e;
    });
  inflight.set(key, p);
  return withLocalSignal(p, signal);
}

// ========== 持久化缓存（跨 service worker 休眠复用译文）==========
// 为什么必须有：MV3 的 service worker 空闲约 30s 就被浏览器杀掉，上面的内存
// Map 随之清空。整页翻译一个中等页面要发上千条短文本，隔几分钟再翻同一个页面
// 就得原样重发一遍 —— MyMemory 匿名配额只有 5000 字符/日，翻两页就见底，
// 用户看到的就是"今日额度已用完"。落到 chrome.storage.local 后，
// 重复内容（同一页面、常见词、反复划的词）只消耗一次配额。
const PERSIST_CACHE_KEY = "yufanTLCache";
const PERSIST_CACHE_MAX = 10000; // 条目上限，超出按 LRU 淘汰
const PERSIST_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const PERSIST_FLUSH_DELAY_MS = 2000; // 批量写盘，避免整页翻译时疯狂写 storage
// storage.local 的配额在申请 unlimitedStorage 后不再限制于 10MB。
// 提高上限以支持更大规模的离线翻译缓存。
const PERSIST_CACHE_MAX_BYTES = 50 * 1024 * 1024; // 50MB
const PERSIST_MAX_ENTRY_BYTES = 64 * 1024; // 单条上限提高到 64KB
// 词典缓存的键命名空间（带版本号）。
//
// 为什么需要：cached() 读缓存时**不做任何校验**。旧版本把必应壳页面的垃圾
// （查"管理员登录成功" → "Dictionary"）写进了这里，而持久化条目有 30 天 TTL、
// 存在 chrome.storage.local —— 重新加载扩展只清内存缓存，磁盘上的脏数据照旧命中，
// 连请求都不发。用户看到的就是"明明修好了却还是错"。换命名空间即一次性作废
// 全部旧词典缓存；ensurePersistCache 会顺手把旧键剔出 Map，下次 flush 写不回去。
const DICT_CACHE_NS = "dict2";

// 用稳定的 Map 引用（懒填充而不是懒创建），这样它和上面的 cache/inflight
// 一样能被测试直接 clear()，不需要为测试单独开后门函数。
const persistCache = new Map(); // key -> {v, exp, size}
let persistCacheLoaded = false;
let persistFlushTimer = null;
let persistDirty = false;
let persistBytes = 0; // 已落盘条目的字节估算，用于按体积淘汰

const approxBytes = (v) => {
  try {
    return JSON.stringify(v).length;
  } catch (_) {
    return 0;
  }
};

async function ensurePersistCache() {
  if (persistCacheLoaded) return persistCache;
  persistCacheLoaded = true;
  try {
    const got = await chrome.storage.local.get(PERSIST_CACHE_KEY);
    const raw = (got && got[PERSIST_CACHE_KEY]) || null;
    if (raw && typeof raw === "object") {
      const now = Date.now();
      persistBytes = 0;
      let legacyDropped = false;
      for (const k of Object.keys(raw)) {
        // 旧命名空间（dict:*）的词典缓存一律丢弃：可能是壳页面的垃圾结果
        if (k.startsWith("dict:")) {
          legacyDropped = true;
          continue;
        }
        const e = raw[k];
        // 兼容旧格式（裸值）与新格式（{v, exp}）
        const exp = e && typeof e === "object" && "exp" in e ? e.exp : now + PERSIST_CACHE_TTL_MS;
        const v = e && typeof e === "object" && "v" in e ? e.v : e;
        if (typeof exp !== "number" || now > exp) continue;
        if (v === undefined || v === null) continue;
        const size = typeof (e && e.size) === "number" ? e.size : approxBytes(v);
        persistCache.set(k, { v, exp, size });
        persistBytes += size;
      }
      // 剔掉旧键后要立刻写回一次，否则它们会一直占着磁盘配额
      // （flush 只在有脏数据时触发，光剔除不会置 dirty）
      if (legacyDropped) {
        persistDirty = true;
        flushPersistCache();
      }
    }
  } catch (_) {
    // 读盘失败不影响功能：退化成"只有内存缓存"
  }
  return persistCache;
}

// 按"条数 + 字节"双上限淘汰最旧的条目，返回被淘汰的 key（供调用方记账）
function evictPersistUntilFit(m) {
  const evicted = [];
  if (m.size === 0) {
    persistBytes = 0;
    return evicted;
  }
  // persistBytes 是增量维护的计数器，一旦 Map 被旁路改动（测试里的 clear()、
  // 或将来某个直接 delete 的调用点）就会与实际脱节。脱节时若直接拿它当判据，
  // 会把刚写进来的新条目也一起误淘汰。超预算时先按 Map 现状重算一次。
  if (persistBytes > PERSIST_CACHE_MAX_BYTES) {
    let s = 0;
    for (const e of m.values()) s += (e && e.size) || 0;
    persistBytes = s;
  }
  while (m.size > PERSIST_CACHE_MAX || persistBytes > PERSIST_CACHE_MAX_BYTES) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    const e = m.get(oldest);
    m.delete(oldest);
    persistBytes -= (e && e.size) || 0;
    evicted.push(oldest);
  }
  if (persistBytes < 0) persistBytes = 0;
  return evicted;
}

async function persistCacheGet(key) {
  try {
    const m = await ensurePersistCache();
    const e = m.get(key);
    if (!e) return undefined;
    if (Date.now() > e.exp) {
      m.delete(key);
      persistBytes -= e.size || 0;
      if (persistBytes < 0) persistBytes = 0;
      persistDirty = true;
      return undefined;
    }
    // LRU：命中后移到队尾
    m.delete(key);
    m.set(key, e);
    return e.v;
  } catch (_) {
    return undefined;
  }
}

function schedulePersistFlush() {
  if (persistFlushTimer) return;
  persistFlushTimer = setTimeout(() => {
    persistFlushTimer = null;
    flushPersistCache();
  }, PERSIST_FLUSH_DELAY_MS);
}

async function flushPersistCache() {
  if (!persistCache || !persistDirty) return;
  persistDirty = false;
  try {
    // 超出上限时从最旧的条目开始淘汰（Map 保持插入顺序 = LRU 顺序）
    evictPersistUntilFit(persistCache);
    const obj = {};
    for (const [k, e] of persistCache) obj[k] = e;
    await chrome.storage.local.set({ [PERSIST_CACHE_KEY]: obj });
  } catch (_) {
    // 写盘失败（配额满/隐私模式）不阻断翻译流程
  }
}

async function persistCacheSet(key, v) {
  try {
    const m = await ensurePersistCache();
    const size = approxBytes(v);
    const prev = m.get(key);
    // 超大的单条（词典结果、整页翻译的长段落）不落盘：一条就能吃掉配额的
    // 百分之几，命中率却不比普通译文高。留在内存 LRU 里（内存无配额限制）。
    if (size > PERSIST_MAX_ENTRY_BYTES) {
      if (prev) {
        m.delete(key);
        persistBytes -= prev.size || 0;
        if (persistBytes < 0) persistBytes = 0;
        persistDirty = true;
      }
      return;
    }
    if (prev) persistBytes -= prev.size || 0;
    m.set(key, { v, exp: Date.now() + PERSIST_CACHE_TTL_MS, size });
    persistBytes += size;
    evictPersistUntilFit(m);
    persistDirty = true;
    schedulePersistFlush();
  } catch (_) {
    /* 忽略 */
  }
}

// ========== 每日字符预算（客户端配额记账）==========
// MyMemory 匿名 5000 字符/日、填邮箱 50000 字符/日，且窗口是"首次请求后滚动
// 24 小时"。服务端配额耗尽后只会回一条 MYMEMORY WARNING，客户端如果继续打，
// 会在冷却期内白白消耗用户等待时间。这里自己记账：接近上限时提前给出明确的
// 中文提示，而不是等到服务端 429。
const QUOTA_USAGE_KEY = "yufanQuotaUsage";
const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;
const DAILY_CHARS_ANONYMOUS = 5000;
const DAILY_CHARS_WITH_EMAIL = 50000;
const quotaUsage = { start: 0, chars: 0, loaded: false, serverResetAt: 0 };

const quotaLimitFor = (email) =>
  email ? DAILY_CHARS_WITH_EMAIL : DAILY_CHARS_ANONYMOUS;

async function ensureQuotaUsage() {
  if (quotaUsage.loaded) {
    applyServerResetIfNeeded();
    return quotaUsage;
  }
  try {
    const got = await chrome.storage.local.get(QUOTA_USAGE_KEY);
    const u = (got && got[QUOTA_USAGE_KEY]) || null;
    const now = Date.now();
    if (u && typeof u.start === "number" && now - u.start < QUOTA_WINDOW_MS) {
      quotaUsage.start = u.start;
      quotaUsage.chars = Number(u.chars) || 0;
      quotaUsage.serverResetAt = Number(u.serverResetAt) || 0;
    } else {
      // 窗口过期：重新计时（与 MyMemory 的滚动 24h 窗口近似对齐）
      quotaUsage.start = now;
      quotaUsage.chars = 0;
      quotaUsage.serverResetAt = 0;
    }
  } catch (_) {
    quotaUsage.start = Date.now();
    quotaUsage.chars = 0;
  }
  quotaUsage.loaded = true;
  applyServerResetIfNeeded();
  return quotaUsage;
}

// 配额记账的写盘必须防抖：整页翻译一次就是几十上百次 MyMemory 请求，
// 每个请求都 storage.local.set 等于给每个翻译请求白加一轮 storage 往返，
// 而且 MV3 service worker 里 storage 写是全局串行的，还会阻塞其他读写。
// 记账放内存，1s 防抖批量落盘——SW 若被杀丢失最多 1s 的记账，可接受
// （服务端 MyMemory 自己还有配额强制作兜底）。
let quotaPersistTimer = null;
const persistQuotaUsage = () => {
  if (quotaPersistTimer) return; // 已有一笔待落盘，合并
  quotaPersistTimer = setTimeout(() => {
    quotaPersistTimer = null;
    try {
      chrome.storage.local.set({
        [QUOTA_USAGE_KEY]: {
          start: quotaUsage.start,
          chars: quotaUsage.chars,
          serverResetAt: quotaUsage.serverResetAt || 0,
        },
      });
    } catch (_) {
      /* 忽略 */
    }
  }, 1000);
};

// 记一笔字符消耗；返回本窗口剩余字符数
async function accountQuota(chars) {
  const u = await ensureQuotaUsage();
  u.chars += Math.max(0, Number(chars) || 0);
  persistQuotaUsage();
  return u.chars;
}

// 失败退费：请求失败（网络错误/限流/4xx）时服务端并不计费，预扣的字符
// 必须退还。否则限流期间的反复重试会把本地 24h 闸门撑爆——明明服务端
// 还有额度，本地却判"今日额度用完"，表现为整页翻译彻底罢工。
async function refundQuota(chars) {
  const u = await ensureQuotaUsage();
  u.chars = Math.max(0, u.chars - Math.max(0, Number(chars) || 0));
  persistQuotaUsage();
}

// 服务端（429/WARNING）明确说"N 分钟后恢复"时，本地 24h 记账必须跟着恢复：
// 否则冷却到期后字符闸门仍然拦截，还会再设 60 分钟冷却 —— 无限循环，
// 表现为"额度提示说 1 小时后重置，但等到第二天也翻不了"。
// serverResetAt：服务端承诺的恢复时间点，到点把本地记账清零重新计时。
const applyServerResetIfNeeded = () => {
  if (
    quotaUsage.serverResetAt &&
    Date.now() >= quotaUsage.serverResetAt
  ) {
    quotaUsage.serverResetAt = 0;
    quotaUsage.chars = 0;
    quotaUsage.start = Date.now();
    persistQuotaUsage();
  }
};

const quotaRemaining = async (email) => {
  const u = await ensureQuotaUsage();
  return Math.max(0, quotaLimitFor(email) - u.chars);
};

const quotaResetLabel = () => {
  const u = quotaUsage;
  if (!u.start) return "";
  const resetAt = u.start + QUOTA_WINDOW_MS;
  const ms = resetAt - Date.now();
  if (ms <= 0) return "即将重置";
  const totalMin = Math.ceil(ms / 60000);
  if (totalMin < 60) return `${totalMin} 分钟后重置`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h} 小时 ${m} 分钟后重置` : `${h} 小时后重置`;
};

// ========== Storage helpers ==========
// 每次 MyMemory 调用都读一次 storage 会在整页翻译时放大成几十次读盘，
// 这里做 60s 短缓存。
const settingsCache = { email: null, endpoint: null, key: null, at: 0 };
const SETTINGS_TTL_MS = 60 * 1000;
async function loadSettings() {
  const now = Date.now();
  if (settingsCache.at && now - settingsCache.at < SETTINGS_TTL_MS) {
    return settingsCache;
  }
  try {
    // 一次 sync.get 取回全部 sync 侧字段。旧实现分 3 次串行 await
    // （email / activeEndpointId / legacy 两项），SW 刚被唤醒时每次都是
    // 一次跨进程往返，累加起来直接落在"点翻译"的等待里。
    const syncAll = await chrome.storage.sync.get([
      "yufanMyMemoryEmail",
      "yufanActiveEndpointId",
      "yufanApiEndpoint",
      "yufanApiKey",
    ]);
    let email = String(syncAll.yufanMyMemoryEmail || "").trim();
    // MyMemory 不校验邮箱格式，但乱填会触发异常，这里做极简校验
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) email = "";

    const id = (syncAll.yufanActiveEndpointId || "").trim();
    let endpoint = "";
    let key = "";
    if (id) {
      // 只有在真的配了端点时才读 local（端点列表存 local，多数用户为空）
      const { yufanEndpoints } = await chrome.storage.local.get("yufanEndpoints");
      const list = Array.isArray(yufanEndpoints) ? yufanEndpoints : [];
      const ep = list.find((e) => e && e.id === id);
      if (ep) {
        endpoint = String(ep.url || "").trim();
        key = String(ep.key || "").trim();
      }
    }
    if (!endpoint) {
      // 回退到旧字段
      endpoint = String(syncAll.yufanApiEndpoint || "").trim();
      key = String(syncAll.yufanApiKey || "").trim();
    }
    settingsCache.email = email;
    settingsCache.endpoint = endpoint;
    settingsCache.key = key;
    settingsCache.at = now;
  } catch (_) {
    settingsCache.email = settingsCache.email || "";
    settingsCache.endpoint = settingsCache.endpoint || "";
    settingsCache.key = settingsCache.key || "";
    settingsCache.at = now;
  }
  return settingsCache;
}

// 解析 MyMemory 警告文本里的"倒计时"片段，格式：
//   NEXT AVAILABLE IN  00 HOURS 24 MINUTES 31 SECONDS
// 返回"还差多少分钟重置"。旧实现的正则要求 HOURS/MINUTES/SECONDS 三者同时出现，
// 遇到 "24 MINUTES 31 SECONDS" 这种缺小时的情况就解析失败、冷却时间丢失。
const parseRetryAfterMinutes = (text) => {
  if (!text) return 0;
  const s = String(text).toUpperCase();
  const h = /(\d+)\s*HOURS?/.exec(s);
  const m = /(\d+)\s*MINUTES?/.exec(s);
  const sec = /(\d+)\s*SECONDS?/.exec(s);
  if (!h && !m && !sec) return 0;
  const hours = h ? parseInt(h[1], 10) || 0 : 0;
  const mins = m ? parseInt(m[1], 10) || 0 : 0;
  if (hours === 0 && mins === 0) return 1; // 只剩几秒，按 1 分钟冷却
  return hours * 60 + mins;
};

// ========== Quota cooldown ==========
// 匿名配额耗尽时，避免在冷却期内继续打 MyMemory 浪费请求。
const quotaCooldown = new Map(); // key: "MyMemory:anonymous" | "MyMemory:<email>" -> expiresAt(ms)

// ---------- 频率限流（与每日配额耗尽是两回事）----------
// MyMemory 的 HTTP 429 绝大多数是“请求过于频繁”（大页面并发 6 很容易触发），
// 只需短暂退避后自动重试；把它当成“今日额度用完”会熔断整页翻译，
// 用户看到的就是“完全翻不了 + 提示一闪而过”（2.3.3 回归的根因）。
const rateLimitState = { until: 0 };
const rateLimitError = () => {
  const e = new Error("翻译请求过于频繁，已自动降速，稍后自动重试剩余内容");
  e.code = "RATE_LIMITED";
  return e;
};
const isRateLimited = () => Date.now() < rateLimitState.until;
const markRateLimited = (ms) => {
  rateLimitState.until = Math.max(rateLimitState.until, Date.now() + ms);
};

const markQuotaExhausted = (key, durationMin, source) => {
  if (!key || !durationMin || durationMin <= 0) return;
  quotaCooldown.set(key, Date.now() + durationMin * 60 * 1000);
  // source="server"：服务端 429/WARNING 明确给出了恢复时间——本地记账到点
  // 同步清零（见 applyServerResetIfNeeded）。客户端闸门自己设的冷却不触发，
  // 否则等于闸门给自己发通行证。
  if (source === "server") {
    quotaUsage.serverResetAt = Date.now() + durationMin * 60 * 1000;
    persistQuotaUsage();
  }
};
const isQuotaCoolingDown = (key) => {
  const exp = quotaCooldown.get(key);
  if (!exp) return false;
  if (Date.now() >= exp) {
    quotaCooldown.delete(key);
    return false;
  }
  return true;
};
const formatCooldownRemaining = (key) => {
  const exp = quotaCooldown.get(key);
  if (!exp) return "";
  const ms = exp - Date.now();
  if (ms <= 0) return "";
  const totalMin = Math.ceil(ms / 60000);
  if (totalMin < 60) return `${totalMin} 分钟后重置`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h} 小时 ${m} 分钟后重置` : `${h} 小时后重置`;
};

const quotaHint = (apiKey) =>
  apiKey
    ? "请稍后再试，或在高级设置中换一个 email 重置配额桶"
    : "请稍后再试，或在高级设置中填入邮箱以将每日额度从 5,000 字符提升到 50,000 字符";

const quotaError = (cacheKey, apiKey) => {
  const remain = formatCooldownRemaining(cacheKey) || "稍后";
  const e = new Error(`MyMemory 今日免费翻译额度已用完（${remain}）。${quotaHint(apiKey)}`);
  e.code = "QUOTA_EXHAUSTED";
  e.quotaCacheKey = cacheKey;
  // 数值形式的冷却时长（分钟）：content 拿它安排"到点自动续翻"，
  // 不用让用户盯着页面手动重试
  const exp = quotaCooldown.get(cacheKey);
  e.retryAfterMin = exp
    ? Math.max(1, Math.ceil((exp - Date.now()) / 60000))
    : 0;
  return e;
};

// ========== 单词判定 ==========
// 判断文本是否像一个"单词"（用于决定走词典还是翻译）
// 注意：整页翻译会传 noDict，不会走到这里。
const looksLikeWord = (text) => {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/\s/.test(t)) return false; // 任何空白都算句子
  if (t.length > 30 || t.length < 1) return false;
  if (/^\d+$/.test(t)) return false;
  // 含句末标点/问号/叹号/逗号 -> 一律当句子
  if (/[.?!]/.test(t) || /[。？！，、；：]/.test(t)) return false;
  // 英文（Free Dictionary 只收英文，含重音字母的法语/西语词直接走翻译）
  if (/^[A-Za-z][A-Za-z'\-\.]*[A-Za-z']?$/.test(t) || /^[A-Za-z]$/.test(t)) return true;
  // 中文：CJK 统一汉字 + 全角点，1~6 字（单字也是词，如「翻」）
  if (/^[\u3400-\u9fff\uf900-\ufaff・]+$/.test(t) && t.length <= 6) return true;
  // 日文假名 + 汉字混合（如 "分かります"）
  if (/^[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]+$/.test(t) && t.length <= 8) return true;
  // 韩文
  if (/^[\uac00-\ud7af]+$/.test(t) && t.length <= 8) return true;
  return false;
};

const isCJKText = (text) =>
  /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(String(text || ""));

// ========== Dictionary provider (Free Dictionary API) ==========
// Free Dictionary API 对同一个词可能返回多个 entry（同形异义，如 bank 的
// 「银行 / 河岸 / 倾斜」分属不同词源）。旧实现只取 json[0]，直接丢掉后
// 面所有 entry —— 这正是"一词多义扩展不足"的原因。这里合并全部 entry。
const MAX_DEFS_PER_POS = 10;
const MAX_TOTAL_DEFS = 48;

const pickPhonetic = (entries) => {
  for (const entry of entries) {
    const phonetics = Array.isArray(entry.phonetics) ? entry.phonetics : [];
    const withBoth = phonetics.find((p) => p && p.text && p.audio);
    if (withBoth) return { phonetic: withBoth.text, audio: withBoth.audio };
  }
  for (const entry of entries) {
    const phonetics = Array.isArray(entry.phonetics) ? entry.phonetics : [];
    const withText = phonetics.find((p) => p && p.text);
    if (withText) return { phonetic: withText.text, audio: withText.audio || "" };
  }
  for (const entry of entries) {
    const phonetics = Array.isArray(entry.phonetics) ? entry.phonetics : [];
    const withAudio = phonetics.find((p) => p && p.audio);
    if (withAudio) return { phonetic: "", audio: withAudio.audio };
  }
  return { phonetic: "", audio: "" };
};

// 合并多个 entry 的 meanings：按 partOfSpeech 归组，跨 entry 累加释义
function mergeMeanings(entries, word) {
  const order = [];
  const byPos = new Map(); // pos -> { definitions: [], synonyms: Set, antonyms: Set }
  const seenDef = new Set();
  let total = 0;

  for (const entry of entries) {
    for (const m of entry.meanings || []) {
      if (!m || !Array.isArray(m.definitions) || m.definitions.length === 0) continue;
      const pos = String(m.partOfSpeech || "").trim();
      if (!byPos.has(pos)) {
        byPos.set(pos, { definitions: [], synonyms: [], antonyms: [] });
        order.push(pos);
      }
      const bucket = byPos.get(pos);
      // 词性级的同/反义词：随后补进缺该项的 definition
      for (const s of Array.isArray(m.synonyms) ? m.synonyms : []) {
        if (s && bucket.synonyms.indexOf(s) === -1) bucket.synonyms.push(String(s));
      }
      for (const a of Array.isArray(m.antonyms) ? m.antonyms : []) {
        if (a && bucket.antonyms.indexOf(a) === -1) bucket.antonyms.push(String(a));
      }
      for (const d of m.definitions) {
        if (total >= MAX_TOTAL_DEFS) break;
        if (!d || !d.definition) continue;
        const definition = String(d.definition).trim();
        if (!definition) continue;
        // 去重键：释义 + 例句。只按释义去重会把"同形异义词里释义文字恰好
        // 相同但例句不同的义项"误删（一词多义缺陷）；把例句也纳入键后，
        // 真正相同的义项仍会被去重，不同义项则各自保留。
        const exKey = d.example ? d.example.toLowerCase().replace(/[.\s]+$/g, "") : "";
        const key = `${definition.toLowerCase().replace(/[.\s]+$/g, "")}\u0001${exKey}`;
        if (seenDef.has(key)) continue;
        // 释义就是词本身（Free Dictionary 偶尔返回的噪声）跳过
        if (key === String(word || "").toLowerCase()) continue;
        seenDef.add(key);
        bucket.definitions.push({
          definition,
          example: d.example ? String(d.example).trim().slice(0, 240) : "",
          synonyms: Array.isArray(d.synonyms) ? d.synonyms.slice(0, 6) : [],
          antonyms: Array.isArray(d.antonyms) ? d.antonyms.slice(0, 6) : [],
        });
        total++;
      }
    }
  }

  const meanings = [];
  for (const pos of order) {
    const bucket = byPos.get(pos);
    if (!bucket.definitions.length) continue;
    const defs = bucket.definitions.slice(0, MAX_DEFS_PER_POS).map((d) => ({
      definition: d.definition,
      example: d.example,
      synonyms: d.synonyms.length ? d.synonyms : bucket.synonyms.slice(0, 6),
      antonyms: d.antonyms.length ? d.antonyms : bucket.antonyms.slice(0, 6),
    }));
    meanings.push({ partOfSpeech: pos, definitions: defs });
  }
  return meanings;
}

async function callDictionary(word, signal) {
  const url = `${DEFAULT_DICTIONARY}/${encodeURIComponent(word)}`;
  // Free Dictionary API 在某些地区被 Cloudflare 拦截，5xx / 超时能拖 20s+。
  // 加硬超时，超时后由上层 fallback 到 MyMemory。
  const ac = new AbortController();
  const onOuterAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(abortError("Dictionary 词典超时")), DICT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { method: "GET", signal: ac.signal });
  } catch (e) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
    const isAbort = e && e.name === "AbortError";
    const err = new Error(isAbort ? e.message || "Dictionary 词典超时" : `Dictionary 网络错误: ${e && e.message}`);
    err.code = "DICT_NOT_FOUND"; // 让上层 fallback 到 MyMemory
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }

  if (res.status === 404) {
    const err = new Error("词典未收录该单词");
    err.code = "DICT_NOT_FOUND";
    throw err;
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    if (res.status >= 500) {
      const err = new Error(`Dictionary HTTP ${res.status}`);
      err.code = "DICT_NOT_FOUND";
      throw err;
    }
    throw new Error(`Dictionary HTTP ${res.status}: ${t.slice(0, 200)}`);
  }

  const json = await res.json();
  const entries = Array.isArray(json) ? json.filter((e) => e && typeof e === "object") : [];
  if (entries.length === 0) {
    const err = new Error("词典未收录该单词");
    err.code = "DICT_NOT_FOUND";
    throw err;
  }
  const { phonetic, audio } = pickPhonetic(entries);
  const meanings = mergeMeanings(entries, word);
  if (meanings.length === 0) {
    const err = new Error("词典未返回有效释义");
    err.code = "DICT_NOT_FOUND";
    throw err;
  }
  return {
    mode: "dictionary",
    translated: meanings[0].definitions[0].definition, // 兼容字段
    detected: "en",
    provider: "Dictionary",
    word: (entries[0] && entries[0].word) || word,
    phonetic: phonetic || "",
    audio: audio || "",
    meanings,
    examples: [],
  };
}

// ========== Bing Dictionary (cn.bing.com) ==========
// 中文 / 英文 / 日文 / 韩文都能查，零鉴权。
const stripTags = (s) =>
  String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();

// 解析 meta description
// 例：
//   必应词典为您提供hello的释义，美[heˈləʊ]，英[həˈləʊ]，int. 你好；喂；您好；哈喽； 网络释义： 哈罗；哈啰；大家好；
//   必应词典为您提供翻译的释义，拼音[fān yì]，n. translation; translator； v. translate; interpret; render； 网络释义： Translator; version; interpreter；
function parseBingDesc(desc) {
  if (!desc) return { phonetic: "", meanings: [] };
  let s = desc.replace(/^必应词典为您提供.*?的释义[，,]\s*/, "");
  const pyMatch = s.match(/拼音\[([^\]]+)\]/);
  const usMatch = s.match(/美\[([^\]]+)\]/);
  const ukMatch = s.match(/英\[([^\]]+)\]/);
  const phonetic = (pyMatch && pyMatch[1]) || (usMatch && usMatch[1]) || "";
  s = s.replace(/拼音\[[^\]]+\][，,]\s*/, "");
  s = s.replace(/美\[[^\]]+\][，,]\s*/, "");
  s = s.replace(/英\[[^\]]+\][，,]\s*/, "");

  let webPart = "";
  const webMatch = s.match(/网络释义[：:]\s*([\s\S]+?)$/);
  if (webMatch) {
    webPart = webMatch[1];
    s = s.slice(0, webMatch.index).replace(/[，,;；\s]+$/, "");
  }

  const POS = /(?:^|[，,;；\s])(n|v|adj|adv|int|prep|conj|pron|art|aux|num|vi|vt|aux\.v)\.\s*/g;
  const posMatches = [];
  let m;
  while ((m = POS.exec(s)) !== null) {
    posMatches.push({ pos: m[1] + ".", start: m.index, end: m.index + m[0].length });
  }

  const meanings = [];
  if (posMatches.length === 0) {
    const text = s.replace(/[，,;；]+/g, "；").trim();
    if (text) meanings.push({ partOfSpeech: "", definitions: [{ definition: text, example: "" }] });
  } else {
    for (let i = 0; i < posMatches.length; i++) {
      const cur = posMatches[i];
      const segStart = cur.end;
      const segEnd = i + 1 < posMatches.length ? posMatches[i + 1].start + 1 : s.length;
      let seg = s.slice(segStart, segEnd);
      if (i === posMatches.length - 1 && webPart) seg = seg.split("网络释义")[0];
      seg = seg.replace(/^[，,;；\s]+|[，,;；\s]+$/g, "");
      const defs = seg
        .split(/[；;]/)
        .map((d) => d.trim())
        .filter(Boolean)
        .slice(0, MAX_DEFS_PER_POS)
        .map((d) => ({ definition: d, example: "", synonyms: [], antonyms: [] }));
      if (defs.length) meanings.push({ partOfSpeech: cur.pos, definitions: defs });
    }
  }
  if (webPart) {
    const webDefs = webPart
      .split(/[；;]/)
      .map((d) => d.trim())
      .filter(Boolean)
      .slice(0, MAX_DEFS_PER_POS)
      .map((d) => ({ definition: d, example: "", synonyms: [], antonyms: [] }));
    if (webDefs.length) meanings.push({ partOfSpeech: "网络", definitions: webDefs });
  }
  // 防御性清洗：Bing 偶发返回异常 desc（音标段缺逗号/缺右括号等）时，
  // 旧的剥离正则会残留 "英[" / "美[" / "拼音[" 之类片段混进释义。
  // 这里对每条 definition 再过一遍，彻底杜绝音标碎片当释义。
  // 同时丢弃空串与纯标点。
  for (const m of meanings) {
    if (!Array.isArray(m.definitions)) continue;
    m.definitions = m.definitions
      .map((d) => {
        let def = (d && d.definition) || "";
        // 去掉首尾空白与多余标点
        def = def.replace(/^[，,;；\s]+|[，,;；\s]+$/g, "").trim();
        return { ...d, definition: def };
      })
      .filter((d) => {
        const def = d.definition || "";
        if (!def) return false;
        // 音标残留：以 英/美/拼音 紧跟左括号开头，或整条就是 [..] 形式
        if (/^(英|美|拼音)\s*\[/.test(def)) return false;
        if (/^\[[^\]]*\]$/.test(def)) return false;
        // 单个孤立括号片段 "英[" / "美[" / "拼音["
        if (/^(英|美|拼音)\[$/.test(def)) return false;
        // 纯标点 / 纯空白
        if (/^[，,;；\s.\-]+$/.test(def)) return false;
        // 脚本/代码碎片：真实词典释义不可能长这样（function( / => / window. /
        // .includes( / }} / );）。这是第二道闸 —— 即使上游漏放壳页面进来，
        // 也不会把 JS 杂讯当释义渲染给用户。
        if (
          /(function\s*\(|=>|javascript:|window\.|document\.|\bCSPEL\b|\}\}|\)\s*;|\.\s*(includes|some|push|forEach|map|filter|replace|match|slice|join|indexOf)\s*\()/i.test(
            def
          )
        )
          return false;
        return true;
      });
  }
  // 释义被清空的词性块整块丢弃，避免出现空列表
  const cleaned = meanings.filter(
    (m) => Array.isArray(m.definitions) && m.definitions.length > 0
  );
  return { phonetic, meanings: cleaned };
}

// 例句内容过滤：Bing 双语例句库会混入庸俗/低俗/劣质例句（如
//   "I've never been promiscuous. ... lengthy sex sessions ..."
//   "我从来不乱交...性爱..."），既无良好社会价值导向、也严重影响划词体验。
// 这里用关键词黑名单在解析阶段直接丢弃此类例句，确保面板里不会渲染。
// 覆盖范围：露骨性相关 / 粗口脏话 / 庸俗辱骂 / 暴力犯罪美化 等。
// 英文按词边界匹配（避免误伤 Middlesex / sextant / Sussex / analysis 等），
// 中文按子串匹配（中文无词边界；多选用歧义小的多字词，避免单字误伤）。
const EXPLICIT_EN = [
  // 露骨性相关
  "sex", "sexual", "sexy", "promiscuous", "horny", "libido", "intercourse",
  "masturbat", "orgasm", "ejaculat", "erection", "genital", "vagina", "penis",
  "nude", "naked", "erotic", "porn", "slut", "whore", "dick", "cock", "pussy",
  "cunt", "boob", "handjob", "blowjob", "anal sex", "oral sex", "condom",
  "virginity", "orgy", "fetish", "bondage", "hentai", "incest", "rape",
  "molest", "pedophil", "paedophil", "striptease", "prostitut", "lustful",
  "seduce", "sensual", "milf",
  // 粗口脏话
  "fuck", "motherfucker", "shit", "bullshit", "bitch", "bastard", "asshole",
  "arsehole", "dickhead", "wanker", "prick", "twat", "bollocks", "bugger",
  "son of a bitch", "douchebag", "jackoff", "jerkoff", "piss off", "screw you",
];
const EXPLICIT_ZH = [
  // 露骨性相关
  "性爱", "性交", "乱交", "性欲", "性高潮", "自慰", "手淫", "色情", "妓", "娼",
  "卖淫", "避孕套", "鸡巴", "屄", "奶子", "淫荡", "发情", "性虐", "强奸", "猥亵",
  "嫖", "龟头", "情色", "春宫", "性器", "做爱", "插入阴道", "阴道", "阴茎",
  "裸体", "裸露", "色情业", "荡妇", "破鞋", "婊子", "骚货", "贱货",
  // 粗口脏话 / 庸俗辱骂
  "他妈的", "妈的", "草泥马", "操你", "日你", "草你", "滚蛋", "混蛋", "王八蛋",
  "狗屎", "放屁", "扯淡", "贱人", "烂货", "杂种", "龟孙", "废物", "废柴",
  "臭傻逼", "傻逼", "牛逼", "装逼", "苦逼", "屁眼",
];
function isExplicitExample(en, cn) {
  const enLow = (en || "").toLowerCase();
  const cnStr = cn || "";
  for (const w of EXPLICIT_EN) {
    if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(enLow)) return true;
  }
  for (const w of EXPLICIT_ZH) {
    if (cnStr.includes(w)) return true;
  }
  return false;
}

// 从 sentenceSeg 抽例句
function parseBingExamples(html) {
  const out = [];
  const segStart = html.indexOf('id="sentenceSeg"');
  if (segStart === -1) return out;
  let pos = segStart;
  const seen = new Set();
  for (let i = 0; i < 10; i++) {
    const liStart = html.indexOf('<div class="se_li">', pos);
    if (liStart === -1) break;
    const liEnd = html.indexOf('<div class="se_li">', liStart + 1);
    const block = html.slice(liStart, liEnd === -1 ? liStart + 4000 : liEnd);
    const enMatch = block.match(/<div class="sen_en[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const cnMatch = block.match(/<div class="sen_cn[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (enMatch && cnMatch) {
      const en = stripTags(enMatch[1]);
      const cn = stripTags(cnMatch[1]);
      if (en && cn && !seen.has(en) && !isExplicitExample(en, cn)) {
        out.push({ en, cn });
        seen.add(en);
      }
    }
    pos = liStart + 1;
  }
  return out;
}

async function callBingDict(word, signal) {
  const url = `${BING_DICT_URL}?q=${encodeURIComponent(word)}&FORM=BDVSP6&cc=cn`;
  const ac = new AbortController();
  const onOuterAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(abortError("必应词典超时")), DICT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      signal: ac.signal,
      credentials: "omit",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });
  } catch (e) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
    if (e && e.name === "AbortError") throw e;
    throw new Error(`必应词典请求失败: ${(e && e.message) || e}`);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`必应词典 HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const html = await res.text();
  // content 属性的值可能用 " 或 ' 作定界符。旧正则 content=["']([^"']+)["']
  // 会在"另一种"引号处错误截断 —— Bing 的美/英音标里常有字面撇号
  // （如 英['seʃ(ə)n]），双引号属性的撇号是合法字符，旧正则却把它当结束符，
  // 导致 desc 被截在 "英[" 处，释义全丢。这里用反向引用匹配真正的定界符。
  const descMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=(["'])([\s\S]*?)\1/i
  );
  if (!descMatch) {
    const err = new Error("必应词典返回结构异常");
    err.code = "DICT_NOT_FOUND";
    throw err;
  }
  const desc = descMatch[2]
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  // 只信"真的词典结果页"。必应对没有词条的短语/伪词会返回一个内嵌大量脚本
  // 的壳页面（实测 209KB vs 真词条 343~384KB），meta description 只剩「词典」
  // 或 "Dictionary"（随 locale 变）。旧逻辑对任何非空 desc 都照单全收，壳页面
  // 的杂讯就被当成释义渲染 —— 用户查「管理员登录成功」会看到 "1. Dictionary"
  // 这种严重错误。判据（对真词条页与壳页面各抓样本验证过）：
  //   真结果页 desc 恒为「必应词典为您提供…的释义…」，且带 id="sentenceSeg" 例句区；
  //   壳页面两者皆无。判为未收录后上层自动降级 MyMemory，用户拿到真正的整句翻译。
  //   额外校验：如果 desc 仅包含 "Dictionary" 或 "词典" 且没有具体释义，也视为未收录。
  const isShellDesc = /^Dictionary\s*$/i.test(desc) || /^词典\s*$/.test(desc);
  if ((!/的释义/.test(desc) && !html.includes('id="sentenceSeg"')) || isShellDesc) {
    const err = new Error("必应词典未收录该短语");
    err.code = "DICT_NOT_FOUND";
    throw err;
  }
  const { phonetic, meanings } = parseBingDesc(desc);
  if (meanings.length === 0) {
    const err = new Error("必应词典未收录该词");
    err.code = "DICT_NOT_FOUND";
    throw err;
  }
  // Bing 对"伪词"会返回有结构但全空的释义，判为未收录
  const allEmpty = meanings.every(
    (m) => !m.partOfSpeech && (m.definitions || []).every((d) => !d.definition)
  );
  if (allEmpty) {
    const err = new Error("必应词典未收录该词");
    err.code = "DICT_NOT_FOUND";
    throw err;
  }
  const examples = parseBingExamples(html);
  const detected = /[\u4e00-\u9fff]/.test(word) ? "zh-CN" : "en";
  return {
    mode: "dictionary",
    translated: meanings[0].definitions[0].definition,
    detected,
    provider: "Bing Dict",
    word,
    phonetic,
    audio: "",
    meanings,
    examples,
  };
}

// 仅拉取必应词典的例句（sentenceSeg），不拉释义。
// 用于给 Free Dictionary（英文词）补足双语例句——Free Dictionary 不提供例句列表。
// 失败一律返回 []，绝不影响主流程。
async function fetchBingExamples(word, signal) {
  const url = `${BING_DICT_URL}?q=${encodeURIComponent(word)}&FORM=BDVSP6&cc=cn`;
  const ac = new AbortController();
  const onOuterAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  const timer = setTimeout(
    () => ac.abort(abortError("必应例句超时")),
    BING_EXAMPLES_TIMEOUT_MS
  );
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: ac.signal,
      credentials: "omit",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });
    if (!res.ok) return [];
    const html = await res.text();
    return parseBingExamples(html);
  } catch (_) {
    return [];
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }
}

// ========== MyMemory provider ==========
// source 必须是具体语言（调用前已 resolve）；支持缓存与请求去重。
async function callMyMemoryRaw(text, source, target, signal) {
  const settings = await loadSettings();
  const mmSource = LANG_TO_MM[source] || LANG_TO_MM[normalizeLang(source)] || "en";
  const mmTarget = LANG_TO_MM[target] || LANG_TO_MM[normalizeLang(target)] || "en";
  const apiKey = settings.email || "";
  const cacheKey = `MyMemory:${apiKey || "anonymous"}`;

  if (isQuotaCoolingDown(cacheKey)) throw quotaError(cacheKey, apiKey);
  // 频率限流退避期内不发请求（本地直接失败，由上层自动重试）
  if (isRateLimited()) throw rateLimitError();

  // 源 == 目标：不再抛错（旧实现会抛"源语言和目标语言相同"，用户看到硬报错），
  // 改为原样返回并打 noop 标记，由上层"译文==原文"重试逻辑切成相反语言。
  if (mmSource === mmTarget) {
    return { translated: text, detected: mmSource, provider: "MyMemory", noop: true };
  }

  // 客户端配额闸门：先记账再发请求。
  // 不这么做的话，配额耗尽后每个请求都要等服务端回一条 WARNING 才知道失败，
  // 整页翻译会连着几百次空跑，用户只看到"一直在转圈"，最后还是一片空白。
  const cost = String(text || "").length;
  await ensureQuotaUsage();
  const limit = quotaLimitFor(apiKey);
  if (quotaUsage.chars + cost > limit) {
    markQuotaExhausted(cacheKey, 60, "client");
    throw quotaError(cacheKey, apiKey);
  }
  await accountQuota(cost);

  const params = new URLSearchParams({ q: text, langpair: `${mmSource}|${mmTarget}` });
  if (apiKey) params.set("de", apiKey);
  // 请求阶段任何失败都要退还预扣的字符额度（见 refundQuota 注释）
  try {
    return await requestMyMemoryOnce(text, mmSource, mmTarget, params, signal, apiKey, cacheKey, cost);
  } catch (err) {
    await refundQuota(cost);
    throw err;
  }
}

async function requestMyMemoryOnce(text, mmSource, mmTarget, params, signal, apiKey, cacheKey, cost) {
  const res = await fetch(`${DEFAULT_MYMEMORY}?${params.toString()}`, {
    method: "GET",
    signal,
  });

  if (!res.ok) {
    if (res.status === 429) {
      // 429 带“NEXT AVAILABLE IN X HOURS/MINUTES”说明要等很久（额度类），按配额
      // 处理（熔断 + 到点自动续翻）；否则就是普通频率限流：短暂退避后自动重试，
      // 绝不能熔断整页（“无法翻译整页”的根因）。
      let retryMin = 0;
      try {
        retryMin = parseRetryAfterMinutes(await res.text());
      } catch (_) {}
      if (retryMin > 2) {
        markQuotaExhausted(cacheKey, retryMin, "server");
        throw quotaError(cacheKey, apiKey);
      }
      markRateLimited(8000);
      throw rateLimitError();
    }
    throw new Error(`MyMemory HTTP ${res.status}：请求失败，请稍后再试`);
  }

  const json = await res.json();
  const rs = json && json.responseStatus;
  if (rs !== undefined && rs !== 200 && rs !== "200") {
    const detail = (json && (json.responseDetails || json.responseStatus)) || "unknown";
    if (String(detail).toUpperCase().includes("MYMEMORY WARNING")) {
      const up = String(detail).toUpperCase();
      const retryMin = parseRetryAfterMinutes(detail);
      // 只有“额度用完/告知恢复时间”的 WARNING 才熔断；其他 WARNING
      // （如单条超长）按普通错误处理，让失败节点走正常重试。
      if (retryMin > 0 || /USED ALL|FOR TODAY/.test(up)) {
        markQuotaExhausted(cacheKey, retryMin || 60, "server");
        throw quotaError(cacheKey, apiKey);
      }
      throw new Error(`MyMemory WARNING：${String(detail).slice(0, 80)}`);
    }
    throw new Error(`MyMemory 业务错误 ${rs}：${String(detail).slice(0, 80)}`);
  }

  const translated = json && json.responseData && json.responseData.translatedText;
  if (!translated) throw new Error("MyMemory 返回空结果（可能该语种暂不支持）");
  // 防御性：HTTP 200 + responseStatus 200，但 translatedText 是 WARNING 文本的"假成功"
  if (String(translated).toUpperCase().includes("MYMEMORY WARNING")) {
    const up = String(translated).toUpperCase();
    const retryMin = parseRetryAfterMinutes(translated);
    if (retryMin > 0 || /USED ALL|FOR TODAY/.test(up)) {
      markQuotaExhausted(cacheKey, retryMin || 60, "server");
      throw quotaError(cacheKey, apiKey);
    }
    throw new Error(`MyMemory WARNING：${String(translated).slice(0, 80)}`);
  }

  return { translated, detected: mmSource, provider: "MyMemory" };
}

// 带缓存的 MyMemory 调用
const callMyMemory = (text, source, target, signal) =>
  cached(
    `mm|${source}|${target}|${text}`,
    () => callMyMemoryRaw(text, source, target, signal),
    signal
  );

// ========== Custom endpoint provider ==========
async function callCustomEndpoint(endpoint, payload, signal) {
  const settings = await loadSettings();
  const headers = { "Content-Type": "application/json" };
  if (settings.key) headers["Authorization"] = `Bearer ${settings.key}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`自定义端点 HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const json = await res.json();
  const translated = (json && (json.translated || json.translation || json.data)) || "";
  if (!translated) throw new Error("自定义端点返回结果缺少 translated 字段");
  return {
    translated: String(translated),
    detected: String((json && (json.detected || json.detectedSource)) || ""),
    provider: String((json && json.provider) || "Custom"),
  };
}

// ========== 释义翻译 ==========
// 把词典的多词性多释义整体翻译成目标语言。
//
// 协议：每条待翻内容编码成一行 "p:词性" / "d:释义" / "e:例句"，按组（英文段走
// en→target、中文段走 src→target）切块后并发翻译，再按行回填。
//
// 稳定性关键（旧版最大的问题）：MyMemory 常把多行合并成一行返回，
// 一旦行数对不上，[k] 下标回填就会把释义和例句错位串在一起。
// 这里采用「对齐优先，错位降级」：
//   - 返回行数 == 发送行数  -> 直接对齐回填（快）
//   - 行数对不上            -> 该块逐条重翻（慢但绝不会串位）
// 这样既保留了分块的低请求量，又消除了串行错位。
//
// 输入：[{partOfSpeech, definitions:[{definition, example}]}]
// 输出：[{partOfSpeech, definitions:[{definition, example, exampleOriginal}]}]
async function translateDefinitionsToTarget(meanings, src, target, signal) {
  if (!Array.isArray(meanings) || meanings.length === 0) return null;

  // 判断 partOfSpeech 是不是英文缩写（n. / v. / adj. / ...）
  const isEnglishPos = (pos) => {
    if (!pos) return false;
    const s = String(pos).trim();
    return s.length > 0 && s.length <= 8 && /^[A-Za-z.]+$/.test(s);
  };
  const isEnglishWord = (s) => {
    const t = String(s || "").trim();
    if (!t || t.length > 30) return false;
    return /^[A-Za-z][A-Za-z\s\-'.&]*$/.test(t);
  };

  // ---- 1) 构建 lines + refs（旧实现整段缺失，导致 ReferenceError） ----
  const lines = [];
  const refs = [];
  for (let i = 0; i < meanings.length; i++) {
    const m = meanings[i];
    if (m.partOfSpeech) {
      lines.push(`p:${m.partOfSpeech}`);
      refs.push({ kind: "pos", idx: i });
    }
    for (let j = 0; j < (m.definitions || []).length; j++) {
      const d = m.definitions[j];
      lines.push(`d:${d.definition}`);
      refs.push({ kind: "def", idx: i, defIdx: j });
      if (d.example) {
        lines.push(`e:${d.example}`);
        refs.push({ kind: "ex", idx: i, defIdx: j });
      }
    }
  }
  if (lines.length === 0) return null;

  // ---- 2) 按"源语言"分组 ----
  //   英文缩写段（n./v./adj.）及其中的英文 def -> en 组
  //   中文 / 网络段                            -> src 组
  // 混在一起送 MyMemory 会因为语系混杂被原样退回。
  const groupEn = { lines: [], refs: [] };
  const groupSrc = { lines: [], refs: [] };
  for (let k = 0; k < lines.length; k++) {
    const ref = refs[k];
    const segPos = meanings[ref.idx] && meanings[ref.idx].partOfSpeech;
    let grp = isEnglishPos(segPos) ? groupEn : groupSrc;
    // 中文段里的单条英文 def（Bing「网络释义」常见）升级到 en 组
    if (grp === groupSrc && ref.kind === "def") {
      const defText = String(lines[k] || "").replace(/^d\s*[:：]\s*/i, "").trim();
      if (isEnglishWord(defText)) grp = groupEn;
    }
    grp.lines.push(lines[k]);
    grp.refs.push(ref);
  }
  const groups = [];
  if (groupEn.lines.length) groups.push({ ...groupEn, srcFor: "en" });
  if (groupSrc.lines.length) groups.push({ ...groupSrc, srcFor: src });

  // ---- 3) 切块（MyMemory 限制 500 字符，留 100 余量） ----
  // 例句单独成块：例句带句号引号，和释义混在一块时极易被合并成一行。
  const MAX_BLOCK = 400;
  const blocks = [];
  for (const grp of groups) {
    let curLines = [];
    let curRefs = [];
    let curLen = 0;
    const flush = () => {
      if (curLines.length) blocks.push({ lines: curLines, refs: curRefs, srcFor: grp.srcFor });
      curLines = [];
      curRefs = [];
      curLen = 0;
    };
    for (let k = 0; k < grp.lines.length; k++) {
      const line = grp.lines[k];
      const ref = grp.refs[k];
      if (ref.kind === "ex" || line.length >= MAX_BLOCK) {
        flush();
        blocks.push({ lines: [line], refs: [ref], srcFor: grp.srcFor });
        continue;
      }
      if (curLen + line.length + (curLines.length ? 1 : 0) > MAX_BLOCK) flush();
      curLines.push(line);
      curRefs.push(ref);
      curLen += line.length + (curLines.length > 1 ? 1 : 0);
    }
    flush();
  }

  // ---- 4) 深拷贝输出，并备份原始例句 ----
  const out = JSON.parse(JSON.stringify(meanings));
  for (let i = 0; i < out.length; i++) {
    for (let j = 0; j < (out[i].definitions || []).length; j++) {
      const orig = meanings[i].definitions[j] && meanings[i].definitions[j].example;
      out[i].definitions[j].exampleOriginal = orig ? String(orig).trim() : "";
    }
  }

  // 清洗一行翻译结果：反转义 MyMemory 的实体、去掉我们的协议前缀
  const cleanLine = (s) =>
    String(s == null ? "" : s)
      .replace(/&#10;/g, "\n")
      .replace(/&#13;/g, "\r")
      .replace(/&#9;/g, "\t")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/^[pde][\s]*[:：][\s]*/i, "")
      .replace(/\s+/g, " ")
      .trim();

  // 判断这一行翻译结果是否可信；不可信就保留原文
  const isUsable = (cleaned, origCleaned) => {
    if (!cleaned) return false;
    if (origCleaned && cleaned === origCleaned) return false; // 没翻译
    if (origCleaned && cleaned.length > origCleaned.length * 3 + 20) return false; // 粘了别行
    if (/^[pde][\s]*[:：]\s*\S.*[pde][\s]*[:：]/i.test(cleaned)) return false; // 多行没分开
    return true;
  };

  const assign = (ref, value) => {
    if (ref.kind === "pos") {
      if (out[ref.idx]) out[ref.idx].partOfSpeech = value;
    } else if (ref.kind === "def") {
      const d = out[ref.idx] && out[ref.idx].definitions && out[ref.idx].definitions[ref.defIdx];
      if (d) d.definition = value;
    } else if (ref.kind === "ex") {
      const d = out[ref.idx] && out[ref.idx].definitions && out[ref.idx].definitions[ref.defIdx];
      // 译文写 example，原文已备份在 exampleOriginal
      if (d) d.example = value;
    }
  };

  // ---- 5) 并发翻译所有块；对齐失败则逐条降级 ----
  await mapPool(blocks, 4, async (block) => {
    const origCleaned = block.lines.map((l) => l.replace(/^[pde][\s]*[:：][\s]*/i, "").trim());
    let translatedLines = [];
    try {
      const r = await callMyMemory(block.lines.join("\n"), block.srcFor, target, signal);
      translatedLines = String(r.translated || "").split(/\r?\n/);
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      translatedLines = [];
    }

    if (translatedLines.length === block.refs.length) {
      // 快路径：行数对齐，直接回填
      block.refs.forEach((ref, k) => {
        const cleaned = cleanLine(translatedLines[k]);
        if (isUsable(cleaned, origCleaned[k])) assign(ref, cleaned);
      });
      return;
    }

    // 降级路径：MyMemory 合并/拆分了行，逐条重翻，保证不串位
    await mapPool(
      block.refs.map((_, k) => k),
      3,
      async (k) => {
        const ref = block.refs[k];
        try {
          const r = await callMyMemory(origCleaned[k], block.srcFor, target, signal);
          const cleaned = cleanLine(String(r.translated || "").split(/\r?\n/)[0]);
          if (isUsable(cleaned, origCleaned[k])) assign(ref, cleaned);
        } catch (err) {
          if (err && err.name === "AbortError") throw err;
          // 单条失败：保留原文
        }
      }
    );
  });

  return out;
}

// 把 Bing 双语例句（{en, cn}）按目标语言重组为「目标语言例句 + 源语言翻译」。
// 输出 [{ex, tr}]：ex = 例句（目标语言，主显示），tr = 同句译文（源语言，附显示）。
//
// 关键改进（直接回应"例句没有中文翻译 / 例句还是英文 / 响应慢"）：
//   - 中文词 -> 英文：ex=en（英文例句），tr=cn（中文翻译）。Bing 本就双语，无需联网。
//   - 中文词 -> 简中：ex=cn（中文例句），tr=en（英文对照）。无需联网。
//   - 中文词 -> 繁中：ex=cn 转繁体，tr=cn（简体对照）。离线转繁，无需联网、不耗配额。
//   - 英文词 -> 中文：ex=cn，tr=en。无需联网。
//   - 其他目标语言 / 某侧缺失：才走 MyMemory 翻译缺失侧（极少数情况）。
// 即：最常见的英<->中互译例句路径，一次 MyMemory 都不发 —— 又快又不会被 403。
const translateExamplesToTarget = async (examples, srcLang, target, signal) => {
  if (!Array.isArray(examples) || !examples.length) return null;
  const t = normalizeLang(target);
  const isEnTarget = t === "en";
  const isZhTarget = t === "zh";
  const isTrad = isTraditionalTarget(target);
  const srcIsZh = !!srcLang && String(srcLang).toLowerCase().startsWith("zh");

  const out = [];
  const pending = []; // 仅"其他目标语言"才需要联网翻译的条目 {i, srcText, src}
  for (let i = 0; i < examples.length; i++) {
    const e = examples[i] || {};
    const en = String(e.en || "").trim();
    const cn = String(e.cn || "").trim();
    if (isEnTarget) {
      // 主显示英文例句，翻译=中文（Bing 已双语，零联网）
      out.push({ ex: en || cn, tr: en ? cn : "" });
    } else if (isZhTarget) {
      // 主显示中文例句（繁体目标转繁体）。翻译侧：
      //  - 简中目标：tr = 英文对照（看中文例句时也能对照原文）
      //  - 繁中目标：tr = 简体（用户要"繁体例句 + 简体翻译"对照）
      let zh = cn || en;
      if (isTrad && zh) zh = toTraditional(zh);
      out.push({ ex: zh, tr: isTrad ? (cn || en) : (en || cn) });
    } else {
      // 其他目标语言（ja/ko/fr/de/...）：按例句实际含有的语种逐条决定翻译哪一侧，
      // 避免旧实现对 Bing 中文源（dictSrc=zh-CN）直接把英文例句整句丢弃。
      // 优先把英文例句翻成目标语言（英文是例句源语言，最自然），中文作对照。
      if (en && cn) {
        out.push({ ex: en, tr: cn });
        pending.push({ i, srcText: en, src: "en" });
      } else if (en) {
        out.push({ ex: en, tr: "" });
        pending.push({ i, srcText: en, src: "en" });
      } else if (cn) {
        out.push({ ex: cn, tr: "" });
        pending.push({ i, srcText: cn, src: "zh-CN" });
      } else {
        const fb = en || cn;
        out.push({ ex: fb, tr: fb });
        if (fb) pending.push({ i, srcText: fb, src: srcIsZh ? "zh-CN" : "en" });
      }
    }
  }

  if (!pending.length) return out;

  // 仅其他目标语言：把源语言侧翻成 target
  const MAX_BLOCK = 400;
  const blocks = [];
  let cur = [];
  let curLen = 0;
  for (const p of pending) {
    if (p.srcText.length >= MAX_BLOCK) {
      if (cur.length) blocks.push(cur);
      blocks.push([p]);
      cur = [];
      curLen = 0;
      continue;
    }
    if (curLen + p.srcText.length + (cur.length ? 1 : 0) > MAX_BLOCK) {
      blocks.push(cur);
      cur = [p];
      curLen = p.srcText.length;
      continue;
    }
    cur.push(p);
    curLen += p.srcText.length + (cur.length > 1 ? 1 : 0);
  }
  if (cur.length) blocks.push(cur);

  await mapPool(blocks, 3, async (block) => {
    const joined = block.map((p) => p.srcText).join("\n");
    let lines = [];
    try {
      const r = await callMyMemory(joined, block[0].src, target, signal);
      lines = String(r.translated || "").split(/\r?\n/);
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      return; // 翻译失败：保留源语言，不阻断
    }
    if (lines.length === block.length) {
      block.forEach((p, k) => {
        const v = String(lines[k] || "").trim();
        if (v) out[p.i].ex = v;
      });
      return;
    }
    await mapPool(block, 3, async (p) => {
      try {
        const r = await callMyMemory(p.srcText, p.src, target, signal);
        const v = String(r.translated || "").split(/\r?\n/)[0].trim();
        if (v) out[p.i].ex = v;
      } catch (err) {
        if (err && err.name === "AbortError") throw err;
      }
    });
  });

  return out;
};

// ========== 词典结果缓存（省配额 + 跨 SW 休眠复用）==========
// 单词的释义/音标/双语例句在几天内不会变，重复划同一个词没必要每次都打
// Free Dictionary / 必应。用 cached() 包裹后：内存 LRU 命中即返回，未命中再查
// 持久化缓存（chrome.storage.local），都没有才发网络请求；失败（DICT_NOT_FOUND）
// 不会写入缓存 —— cached() 在 producer 抛错时只清 in-flight、不落盘。
// 注意 producer 不传 signal：外部 abort（关弹窗）只让调用方 promise 拒绝，
// 不打断正在共享的 in-flight 请求（与缓存去重的设计一致）。
const lookupFreeDictionary = (word, signal) =>
  cached(`${DICT_CACHE_NS}:fd:${word}`, () => callDictionary(word), signal);
const lookupBingDict = (word, signal) =>
  cached(`${DICT_CACHE_NS}:bing:${word}`, () => callBingDict(word), signal);
// 英文词的例句来自 Bing sentenceSeg，此前完全没走缓存 —— 同一个词反复划词 /
// 反复在 popup 里查，每次都重新打一次 cn.bing.com（慢，还容易被限流）。
// 空结果不缓存（accept 谓词）：它失败时也返回 []，缓存进去会让该词永久无例句。
const lookupBingExamples = (word, signal) =>
  cached(
    `${DICT_CACHE_NS}:bingex:${word}`,
    () => fetchBingExamples(word),
    signal,
    CACHE_TTL_MS,
    (v) => Array.isArray(v) && v.length > 0
  );

// ========== Unified translate() ==========
//   - 自定义 endpoint：直接走用户后端（不尝试词典）
//   - noDict=true（整页翻译）：一律走翻译，避免把页面上的单词送进词典
//       返回英文释义而非译文
//   - 否则：单词走词典，句子走 MyMemory；词典失败自动 fallback
async function translateWith(text, source, target, signal, opts = {}) {
  const settings = await loadSettings();
  if (settings.endpoint) {
    const r = await callCustomEndpoint(settings.endpoint, { text, source, target }, signal);
    return { ...r, mode: "translation" };
  }

  if (!opts.noDict && looksLikeWord(text)) {
    const isCJK = isCJKText(text);
    try {
      let dict;
      let bingExamples = [];
      let bingDictUsed = false; // 是否走了 Bing 词典（Bing 的释义与例句都是中文侧）
      if (isCJK) {
        dict = await lookupBingDict(text, signal);
        bingDictUsed = true;
      } else {
        // 英文词：Free Dictionary 只给释义、不给例句列表，例句需另取。
        // 与词典请求并行拉 Bing 的 sentenceSeg（双语例句），失败不致命。
        const [dRes, exRes] = await Promise.allSettled([
          lookupFreeDictionary(text, signal),
          lookupBingExamples(text, signal),
        ]);
        if (dRes.status === "fulfilled") {
          dict = dRes.value;
          bingExamples = exRes.status === "fulfilled" ? exRes.value : [];
        } else {
          // Free Dictionary 不可达（网络受限/超时）→ 降级用 Bing 词典查英文词，
          // 仍能给用户准确释义 + 双语例句，而不是掉到 MyMemory 的生硬翻译（无例句）。
          dict = await lookupBingDict(text, signal);
          bingDictUsed = true;
          bingExamples = Array.isArray(dict.examples) ? dict.examples : [];
        }
      }

      // 中文词经 Bing 查询后可能只剩一段"网络释义"且全是英文关键词
      // （如「分层服务」返回 "Tiers; service based on role"），
      // 对中文用户毫无价值 —— 判为未收录，fallback 到 MyMemory。
      if (isCJK) {
        const onlyWeb =
          dict.meanings.length > 0 &&
          dict.meanings.every(
            (m) => m.partOfSpeech === "网络" || m.partOfSpeech === "网路" || m.partOfSpeech === "web"
          );
        const allNoCJK = dict.meanings.every((m) =>
          (m.definitions || []).every(
            (d) => !/[\u3400-\u9fff\uf900-\ufaff]/.test(d.definition || "")
          )
        );
        const noExamples = !Array.isArray(dict.examples) || dict.examples.length === 0;
        if (onlyWeb && allNoCJK && noExamples) {
          throw Object.assign(new Error("必应词典未收录该词主释义"), { code: "DICT_NOT_FOUND" });
        }
      }

      // 例句来源：英文词用 Bing sentenceSeg；中文词用 Bing 自带。
      const examples = !isCJK && bingExamples.length
        ? bingExamples
        : Array.isArray(dict.examples) ? dict.examples : [];

      // 例句：始终按目标语言重组（常见情况 Bing 已双语，零联网、不耗配额）。
      // 释义：仅当源 != 目标时才翻译；同语言（如英文词看英文释义）保留原文。
      // Bing 词典（无论中/英文词）返回的释义与例句都是中文侧，dictSrc 按"中文"处理，
      // 避免把已是中文的释义再拿去翻译；Free Dictionary 的英文释义才用其 detected 语言。
      const dictSrc = bingDictUsed
        ? "zh-CN"
        : dict.detected || (isCJK ? "zh-CN" : "en");
      let translated = null;
      let translatedExamples = null;
      try {
        // 例句翻译与释义翻译互不依赖，却曾在这里串行 await —— 白白多付一次
        // MyMemory 往返（实测 p50 ≈ 600ms，非中/英目标语言时是纯浪费）。
        // 并发后两者共享同一轮网络；中英互译的例句本来就离线重组（0 成本），
        // 不会因此变慢。
        const jobs = [];
        if (examples.length) {
          jobs.push(
            translateExamplesToTarget(examples, dictSrc, target, signal).then((v) => {
              translatedExamples = v;
            })
          );
        }
        if (!sameLang(dictSrc, target)) {
          jobs.push(
            translateDefinitionsToTarget(dict.meanings, dictSrc, target, signal).then((v) => {
              translated = v;
            })
          );
        }
        await Promise.all(jobs);
      } catch (e) {
        if (e && e.name === "AbortError") throw e;
        // 部分失败：尽量保留已得到的内容，不整体报错
      }
      return { ...dict, examples, translatedMeanings: translated, translatedExamples, target };
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      // 词典失败/未收录 -> fallback 到 MyMemory
    }
  }

  const mmSource = resolveMmSource(text, source);
  const r = await callMyMemory(text, mmSource, target, signal);
  return { ...r, mode: "translation" };
}

// ========== 批量翻译（整页翻译用） ==========
// 整页翻译如果每个文本节点发一次请求，一个中等页面就是几百次 HTTP 往返，
// 既慢又瞬间打满 MyMemory 的日配额。这里把短文本拼成 ≤450 字符的块，
// 一次请求翻一堆，再按行拆回。
// 对齐策略与释义翻译一致：行数匹配直接拆，不匹配则该块逐条降级。
//
// 返回 { results, aborted, error }：
// - aborted：signal 超时被 abort（此时 results 里已完成的部分仍然有效，
//   未完成的回填原文）。**绝不整批抛掉**——旧实现在 abort 时 throw，
//   调用方拿到 {ok:false}，整页翻译前面积累的译文全部作废，页面一片空白，
//   这正是"右键整页翻译点了没反应"的直接原因。
// - error：本批次里出现过的最后一个错误（配额耗尽等），用于给用户明确提示，
//   而不是让页面静悄悄地什么都不翻。
// - onPartial(items)：可选。每翻完一个桶立刻回调 [{index, text}]（index 为
//   原始 list 下标），content 用它做"翻译一条显示一条"的流式插入。
async function translateBatchTexts(texts, source, target, signal, onPartial) {
  const list = Array.isArray(texts) ? texts : [];
  const results = new Array(list.length).fill("");
  let aborted = false;
  let lastError = null;

  // 归一化 + 去重（页面上重复串很多，去重能省下大量配额）
  const pairs = [];
  const firstSeen = new Map();
  for (let i = 0; i < list.length; i++) {
    const t = String(list[i] == null ? "" : list[i]).replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (firstSeen.has(t)) {
      pairs.push({ idx: i, text: t, dupOf: firstSeen.get(t) });
      continue;
    }
    firstSeen.set(t, i);
    pairs.push({ idx: i, text: t });
  }

  const uniquePairs = pairs.filter((p) => p.dupOf === undefined);
  if (uniquePairs.length === 0) return { results, aborted: false, error: "", quotaExhausted: false, rateLimited: false, retryAfterMin: 0 };

  // 用全部文本的拼接样本统一判定源语言（比逐条判定稳定得多）
  const sample = uniquePairs.slice(0, 60).map((p) => p.text).join("\n");
  let mmSource = resolveMmSource(sample, source);
  // 整页翻译修正：样本若因混入少量 CJK 字符被 detectLang 判成中文、而目标也是中文，
  // mmSource===mmTarget 会让 callMyMemoryRaw 走 noop（原样返回、不插入译文）。
  // 此时按"主要语言"复核：拉丁字母占多数则改用英文作源语言，
  // 让页面里的英文文本仍能翻成中文；纯中文页（CJK 为主）保持原判定、自然跳过。
  {
    const mmTargetCode = LANG_TO_MM[target] || LANG_TO_MM[normalizeLang(target)] || "en";
    if (mmSource === mmTargetCode) {
      const latinCount = (sample.match(/[A-Za-z]/g) || []).length;
      const cjkCount = (sample.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
      if (latinCount > cjkCount) mmSource = "en";
    }
  }

  // 拼块上限：MyMemory q 参数上限 500 字节，留一点余量（URL 编码/多字节字符）。
  // 块越大请求数越少——每少一个请求就少一整轮 RTT，是整页翻译提速的关键。
  const MAX_BATCH_CHARS = 480;
  const buckets = [];
  let cur = [];
  let curLen = 0;
  for (const p of uniquePairs) {
    const len = p.text.length;
    if (len >= MAX_BATCH_CHARS) {
      if (cur.length) buckets.push(cur);
      buckets.push([p]);
      cur = [];
      curLen = 0;
      continue;
    }
    if (curLen + len + (cur.length ? 1 : 0) > MAX_BATCH_CHARS) {
      buckets.push(cur);
      cur = [p];
      curLen = len;
      continue;
    }
    cur.push(p);
    curLen += len + (cur.length ? 1 : 0);
  }
  if (cur.length) buckets.push(cur);

  const put = (p, value) => {
    const v = String(value == null ? "" : value).trim();
    // 译文为空或与原文本质相同 -> 回填原文，让调用方跳过（不插入重复内容）
    results[p.idx] = !v || normalizeCompare(v) === normalizeCompare(p.text) ? p.text : v;
  };

  // 流式回推：一个桶（十几条）翻好就立刻通知调用方，让 content 逐条插入，
  // 而不是等整批全部完成。用户要的是"翻译一条显示一条"。
  // items 的下标是"原始 list 里的位置"，content 用它映射回自己的节点。
  const emit = (bucket) => {
    if (!onPartial) return;
    try {
      onPartial(bucket.map((p) => ({ index: p.idx, text: results[p.idx] })));
    } catch (_) {
      /* 回推失败不影响主流程（最终响应仍带全量结果） */
    }
  };

  // 并发 6：整页翻译的瓶颈是 MyMemory 的 RTT（400~800ms/次），不是本地计算。
  // 4 并发时 10 个块要 3 波；6 并发时 2 波。配合 content 侧的流水线预取
  // （两批消息在途），页面级有效并发约 12——MyMemory 按字符计配额，
  // 这个量级不会触发服务端限流（429 有 quotaError 兜底）。
  await mapPool(buckets, 6, async (bucket) => {
    // 已经超时就别再开新请求了（继续打只会白烧配额、拖长用户等待）
    if (aborted) {
      bucket.forEach((p) => put(p, p.text));
      return;
    }
    let lines = [];
    try {
      const r = await callMyMemory(bucket.map((p) => p.text).join("\n"), mmSource, target, signal);
      lines = String(r.translated || "").split(/\r?\n/);
    } catch (err) {
      if (err && err.name === "AbortError") {
        aborted = true;
        bucket.forEach((p) => put(p, p.text));
        return;
      }
      lastError = err;
      lines = [];
    }
    if (lines.length === bucket.length) {
      bucket.forEach((p, k) => put(p, lines[k]));
      emit(bucket); // 整桶对齐成功，立刻回推
      return;
    }
    // 降级：逐条重翻，保证译文与原文一一对应
    await mapPool(bucket, 3, async (p) => {
      if (aborted) {
        put(p, p.text);
        return;
      }
      try {
        const r = await callMyMemory(p.text, mmSource, target, signal);
        put(p, String(r.translated || "").split(/\r?\n/)[0]);
      } catch (err) {
        if (err && err.name === "AbortError") {
          aborted = true;
          put(p, p.text);
          return;
        }
        lastError = err;
        put(p, p.text);
      }
    });
    emit(bucket); // 降级路径同样回推（每条可能迟到，但绝不缺席）
  });

  // 未覆盖到的位置统一回填原文（超时/异常都不会留空串给调用方）
  for (const p of pairs) {
    if (!results[p.idx]) results[p.idx] = p.text;
  }
  // 回填去重命中的副本（页面上的重复串跟着首个出现位置一起显示）
  const dupPairs = [];
  for (const p of pairs) {
    if (p.dupOf !== undefined) {
      results[p.idx] = results[p.dupOf] || p.text;
      dupPairs.push(p);
    }
  }
  if (dupPairs.length > 0) emit(dupPairs);
  return {
    results,
    aborted,
    error: lastError ? normalizeError(lastError) : "",
    quotaExhausted: !!(lastError && lastError.code === "QUOTA_EXHAUSTED"),
    rateLimited: !!(lastError && lastError.code === "RATE_LIMITED"),
    retryAfterMin: (lastError && lastError.retryAfterMin) || 0,
  };
}

// ========== Timeout helper ==========
const withTimeoutSignal = (ms = REQUEST_TIMEOUT_MS) => {
  const ac = new AbortController();
  const reason = new Error(`翻译超时（>${ms / 1000}s）`);
  const timer = setTimeout(() => ac.abort(reason), ms);
  return { signal: ac.signal, cancel: () => clearTimeout(timer), reason };
};

// 把 AbortError 翻译成可读错误信息
const normalizeError = (err) => {
  if (!err) return "翻译失败";
  if (err.name === "AbortError") {
    const m = String(err.message || "");
    if (m.includes("超时")) return m;
    if (m === "signal is aborted without reason" || m === "This operation was aborted") {
      return "请求被中止（可能是超时或用户关闭了弹窗）";
    }
    return m || "请求被中止";
  }
  return err.message || "翻译失败";
};

// ========== Audio ==========
const AUDIO_MAX_BYTES = 1.5 * 1024 * 1024;
const audioMimeFromUrl = (url) => {
  const u = String(url || "").toLowerCase();
  if (u.endsWith(".mp3")) return "audio/mpeg";
  if (u.endsWith(".wav")) return "audio/wav";
  if (u.endsWith(".ogg") || u.endsWith(".oga")) return "audio/ogg";
  if (u.endsWith(".m4a") || u.endsWith(".aac")) return "audio/aac";
  return "audio/mpeg";
};
const arrayBufferToBase64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
};
async function fetchAudioAsDataUrl(audioUrl, signal) {
  let parsed;
  try {
    parsed = new URL(audioUrl);
  } catch (_) {
    throw new Error("音频地址非法");
  }
  // 只允许词典 API 的音频，避免被扩展成一个开放的音频代理
  if (
    parsed.hostname !== "api.dictionaryapi.dev" ||
    !parsed.pathname.startsWith("/media/pronunciations/")
  ) {
    throw new Error("不允许的音频来源");
  }
  const res = await fetch(parsed.toString(), { method: "GET", signal });
  if (!res.ok) throw new Error(`音频 HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len && len > AUDIO_MAX_BYTES) throw new Error("音频过大（>1.5MB）");
  const buf = await res.arrayBuffer();
  if (buf.byteLength > AUDIO_MAX_BYTES) throw new Error("音频过大（>1.5MB）");
  const mime =
    (res.headers.get("content-type") || "").split(";")[0].trim() || audioMimeFromUrl(audioUrl);
  return `data:${mime};base64,${arrayBufferToBase64(buf)}`;
}

// ========== Message handler ==========
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === "YUFAN_FETCH_AUDIO") {
    const audioUrl = String((msg.payload && msg.payload.url) || "");
    const t = withTimeoutSignal(AUDIO_TIMEOUT_MS);
    fetchAudioAsDataUrl(audioUrl, t.signal)
      .then((dataUrl) => {
        t.cancel();
        sendResponse({ ok: true, data: { dataUrl } });
      })
      .catch((err) => {
        t.cancel();
        sendResponse({ ok: false, error: normalizeError(err) });
      });
    return true;
  }

  if (msg.type === "YUFAN_RELOAD") {
    sendResponse({ ok: true });
    setTimeout(() => {
      try {
        chrome.runtime.reload();
      } catch (_) {}
    }, 50);
    return true;
  }

  // 在后台打开新标签页（content script 无法直接调用 chrome.tabs）
  if (msg.type === "YUFAN_OPEN_URL") {
    const url = String((msg.payload && msg.payload.url) || "").trim();
    const active = (msg.payload && msg.payload.active) !== false;
    if (url && /^https?:\/\//i.test(url)) {
      try {
        chrome.tabs.create({ url, active });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: normalizeError(err) });
      }
    } else {
      sendResponse({ ok: false, error: "无效链接" });
    }
    return true;
  }

  // Popup 启动时 ping：回传消息协议版本（决定是否兼容）+ 便于排障的构建信息
  if (msg.type === "YUFAN_PING") {
    sendResponse({
      ok: true,
      protocol: MSG_PROTOCOL,
      build: "v2026-11-08.1",
      version: (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || "",
    });
    // 顺手预热：SW 刚被唤醒时，settings 与持久化缓存都还没读。
    // 用户从"打开弹窗"到"输入完点翻译"至少几百毫秒，足够把这两次读盘
    // 挪出关键路径 —— 否则它们会算进用户盯着看的那次等待里。
    // 不 await：预热失败不影响任何功能，正式请求仍会自己再读一次。
    Promise.resolve()
      .then(() => Promise.all([loadSettings(), ensurePersistCache()]))
      .catch(() => {});
    return true;
  }

  // 语言检测（整页翻译启动时用一次，决定目标语言）
  if (msg.type === "YUFAN_DETECT") {
    const text = String((msg.payload && msg.payload.text) || "");
    sendResponse({ ok: true, data: detectLang(text) });
    return true;
  }

  // 配额状态查询（popup 启动时调用，决定是否显示配额警告横幅）
  if (msg.type === "YUFAN_QUOTA_STATUS") {
    (async () => {
      const settings = await loadSettings();
      const cacheKey = `MyMemory:${settings.email || "anonymous"}`;
      const cooling = isQuotaCoolingDown(cacheKey);
      await ensureQuotaUsage();
      const limit = quotaLimitFor(settings.email || "");
      const left = Math.max(0, limit - quotaUsage.chars);
      sendResponse({
        ok: true,
        data: {
          // 必须反映"实际在用哪个翻译源"：配了自定义端点时所有请求都走它，
          // 若这里仍硬编码 MyMemory，设置页会显示"服务：MyMemory"，
          // 与真实行为不符（用户据此判断额度/排查问题就会被误导）。
          provider: settings.endpoint ? "自定义端点" : "MyMemory",
          customEndpoint: !!settings.endpoint,
          apiKeyConfigured: !!settings.email,
          quotaExhausted: cooling || left <= 0,
          remaining: cooling ? formatCooldownRemaining(cacheKey) : "",
          // 客户端记账的剩余额度：让用户提前知道"快没了"，而不是等 429
          charsUsed: quotaUsage.chars,
          charsLimit: limit,
          charsLeft: left,
          resetIn: cooling ? formatCooldownRemaining(cacheKey) : quotaResetLabel(),
        },
      });
    })();
    return true;
  }

  if (msg.type === "YUFAN_TEST_MYMEMORY") {
    const t = withTimeoutSignal();
    callMyMemory("hello", "en", "zh-CN", t.signal)
      .then((r) => {
        t.cancel();
        sendResponse({ ok: true, data: r });
      })
      .catch((err) => {
        t.cancel();
        sendResponse({ ok: false, error: normalizeError(err) });
      });
    return true;
  }

  // 整页翻译批量接口：一次请求翻一批短文本
  if (msg.type === "YUFAN_TRANSLATE_BATCH") {
    (async () => {
      const { texts, source, target, batchId } = msg.payload || {};
      // 流式回推：每翻完一个桶就立刻推给发起页，content 逐条插入，
      // 用户体感是"译文一条条长出来"，而不是等整批返回。
      const tabId = sender && sender.tab && typeof sender.tab.id === "number"
        ? sender.tab.id
        : null;
      const onPartial = (items) => {
        if (!batchId || tabId == null || !chrome.tabs || !chrome.tabs.sendMessage) return;
        try {
          chrome.tabs
            .sendMessage(tabId, { type: "YUFAN_TRANSLATE_BATCH_PARTIAL", batchId, items })
            .catch(() => {});
        } catch (_) {
          /* content 已卸载等情况：忽略，最终响应仍带全量结果 */
        }
      };
      // 批次越大给的时间越多（见 BATCH_TIMEOUT_MS 注释）
      const batchSize = Array.isArray(texts) ? texts.length : 0;
      const budget = Math.min(
        BATCH_TIMEOUT_MAX_MS,
        BATCH_TIMEOUT_MS + batchSize * BATCH_TIMEOUT_PER_TEXT_MS
      );
      const t = withTimeoutSignal(budget);
      try {
        const sample = Array.isArray(texts) ? texts.join("\n") : "";
        // 整页翻译：目标语言已由 content 锁定为简体中文，不在此翻转。
        // （翻转会把中文页翻成英文，违背"只翻成简体中文"；同语言条目由
        //  translateBatchTexts 的降级回填处理，不会插入重复译文）
        const safeTarget = target;
        const out = await translateBatchTexts(texts, source, safeTarget, t.signal, onPartial);
        t.cancel();
        // 超时只意味着"后面的没翻完"，前面翻好的照样可用 —— 依旧返回 ok:true，
        // 由 content 决定要不要继续下一批/提示用户。旧实现整批 ok:false，
        // 页面因此一条译文都出不来。
        sendResponse({
          ok: true,
          data: {
            results: (out && out.results) || [],
            target: safeTarget,
            detected: detectLang(sample).code,
            partial: !!(out && out.aborted),
            error: (out && out.error) || "",
            quotaExhausted: !!(out && out.quotaExhausted),
            rateLimited: !!(out && out.rateLimited),
            retryAfterMin: (out && out.retryAfterMin) || 0,
          },
        });
      } catch (err) {
        t.cancel();
        sendResponse({ ok: false, error: normalizeError(err) });
      }
    })();
    return true;
  }

  if (msg.type !== "YUFAN_TRANSLATE") return false;

  (async () => {
    const { text, source, target, noDict } = msg.payload || {};
    const originalText = String(text || "").trim();
    let safeTarget = resolveTarget(originalText, source, target);

    // 单词模式的语言保护：用户选的目标语言恰好等于单词本身的语言时，
    // 不要强制翻成"相反语言"——用户想看的是单词本义（如英文词看英文释义）。
    // 仅对拉丁字母单词（英文等）生效；中文文本一律走原翻转逻辑
    // （中文短句/词组也会被 looksLikeWord 命中，若 here 也撤销翻转会让
    // "中文句子+目标中文"无法翻译成英文，反而更混乱）。
    if (!noDict && looksLikeWord(originalText) && !isCJKText(originalText)) {
      const wordLang = resolveMmSource(originalText, source);
      if (sameLang(wordLang, target)) {
        safeTarget = target; // 撤销 resolveTarget 的翻转，保留单词本义
      }
    }

    // 1) 主请求
    const t1 = withTimeoutSignal();
    let data;
    try {
      data = await translateWith(originalText, source, safeTarget, t1.signal, { noDict: !!noDict });
    } catch (err) {
      t1.cancel();
      sendResponse({ ok: false, error: normalizeError(err) });
      return;
    }
    t1.cancel();

    // 2) 同语言重试（仅翻译模式；词典模式自带多释义，不存在"翻译==原文"问题）
    if (data && data.mode === "translation") {
      const translated = String((data && data.translated) || "").trim();
      const detected = detectLang(originalText);
      const sameByDetected =
        detected.confident && safeTarget && sameLang(detected.code, safeTarget);
      // 用归一化比较：MyMemory 常只改个大小写/标点，严格相等会漏判
      const sameByResult =
        !!originalText && !!translated && normalizeCompare(originalText) === normalizeCompare(translated);

      if (sameByDetected || sameByResult) {
        const retrySource = detected.confident ? detected.code : data.detected || safeTarget;
        const retryTarget = oppositeLang(retrySource);
        if (retryTarget !== safeTarget) {
          const t2 = withTimeoutSignal();
          try {
            const d2 = await translateWith(originalText, source, retryTarget, t2.signal, {
              noDict: !!noDict,
            });
            t2.cancel();
            sendResponse({ ok: true, data: { ...d2, target: retryTarget } });
          } catch (err) {
            t2.cancel();
            // 重试失败：降级返回第一次的结果（总比完全失败好）
            sendResponse({ ok: true, data: { ...data, _warning: normalizeError(err) } });
          }
          return;
        }
      }
    }
    sendResponse({ ok: true, data: { ...data, target: safeTarget } });
  })();

  return true; // async
});

// ========== Context menu: translate page ==========
async function migrateLegacyEndpoint() {
  try {
    const [syncAll, localAll] = await Promise.all([
      chrome.storage.sync.get([
        "yufanApiEndpoint",
        "yufanApiKey",
        "yufanActiveEndpointId",
        "yufanMigrationV2",
      ]),
      chrome.storage.local.get(["yufanEndpoints"]),
    ]);
    if (syncAll.yufanMigrationV2) return;
    const legacyUrl = (syncAll.yufanApiEndpoint || "").trim();
    const legacyKey = (syncAll.yufanApiKey || "").trim();
    const pool = Array.isArray(localAll.yufanEndpoints) ? localAll.yufanEndpoints : [];
    let newActiveId = syncAll.yufanActiveEndpointId || "";
    if (legacyUrl) {
      const newId = "ep_migrated_" + Date.now().toString(36);
      pool.push({
        id: newId,
        name: "已迁移的自定义端点",
        url: legacyUrl,
        key: legacyKey,
        createdAt: Date.now(),
      });
      newActiveId = newActiveId || newId;
      await chrome.storage.local.set({ yufanEndpoints: pool });
    }
    await chrome.storage.sync.set({
      yufanActiveEndpointId: newActiveId,
      yufanMigrationV2: true,
    });
  } catch (_) {
    // 静默失败，不影响菜单创建
  }
}

// setupContextMenu 会被并发调用三次（SW 唤醒顶层 + onInstalled + onStartup），
// removeAll 是异步的：两次调用交错时 create 会撞出
// "Cannot create item with duplicate id"。用序号保证只有最后一次调用真正建菜单。
let menuSetupSeq = 0;
const setupContextMenu = () => {
  const seq = ++menuSetupSeq;
  chrome.contextMenus.removeAll(() => {
    if (seq !== menuSetupSeq) return; // 已有更新的调用接管，跳过本次
    chrome.contextMenus.create(
      {
        id: "yufan-translate-page",
        title: "语翻 · 翻译此页面",
        contexts: ["page", "selection"],
      },
      // 显式读 lastError：标记"已检查"，消除 Unchecked runtime.lastError 报错
      () => void chrome.runtime.lastError
    );
  });
  migrateLegacyEndpoint();
};

chrome.runtime.onInstalled.addListener(setupContextMenu);
chrome.runtime.onStartup.addListener(setupContextMenu);
// service worker 每次唤醒都会重新执行顶层代码：直接注册一次，确保即使
// onInstalled 不触发（例如用户只是刷新扩展），右键菜单也一定存在。
setupContextMenu();

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "yufan-translate-page" && tab && tab.id) {
    broadcastTranslatePage(tab.id, info.frameId);
  }
});

// 向指定 tab 的所有 frame 广播页面翻译指令。
async function broadcastTranslatePage(tabId, _targetFrameId) {
  const payload = { type: "YUFAN_TRANSLATE_PAGE" };
  let frames = [];
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch (_) {
    frames = [];
  }
  if (!frames || frames.length === 0) frames = [{ frameId: 0 }];

  for (const f of frames) {
    const frameId = f.frameId;
    chrome.tabs.sendMessage(tabId, payload, { frameId }, () => {
      if (chrome.runtime.lastError) {
        chrome.scripting
          .executeScript({ target: { tabId, frameIds: [frameId] }, files: ["content.js"] })
          .then(() => {
            chrome.tabs.sendMessage(tabId, payload, { frameId }, () => {
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
