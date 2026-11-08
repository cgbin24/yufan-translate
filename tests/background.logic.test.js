// 离线逻辑自测：把 background.js 放进沙箱执行，用 mock MyMemory 复现
// 线上那些"脏行为"（合并行、保留协议前缀、原样回显），验证修复后的健壮性。
// 跑法（项目根）： node tests/background.logic.test.js
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = path.resolve(__dirname, "../extension/background.js");
const source = fs.readFileSync(SRC, "utf8");

// ---------- Mock 环境 ----------
let mockMode = "normal"; // normal | mergeLines | echoBack | quota | http500 | defer
const mockCalls = [];
// mockMode=defer 时挂起的 MyMemory 响应：用于断言"哪些请求已经发出、哪些还在等"
// （并发 vs 串行只能这样观察 —— 同步 mock 下两者耗时都是 0）。
const pendingMm = [];
function releaseMm() {
  const list = pendingMm.splice(0);
  list.forEach((fn) => fn());
}

function mockFetch(url, opts) {
  mockCalls.push({ url: String(url), opts });
  const u = new URL(String(url));

  if (u.hostname === "api.mymemory.translated.net") {
    const q = u.searchParams.get("q") || "";
    const langpair = u.searchParams.get("langpair") || "";
    const [src, tgt] = langpair.split("|");

    if (mockMode === "defer") {
      // 不立即 resolve：让调用方停在"已发出请求、等响应"的状态
      return new Promise((resolve) => {
        pendingMm.push(() => {
          const lines = q.split("\n");
          const out = lines.map((l) => translateMock(l, src, tgt)).join("\n");
          resolve(
            jsonResponse({
              responseStatus: 200,
              responseData: { translatedText: out },
              matches: [{ source: src }],
            })
          );
        });
      });
    }

    if (mockMode === "quota") {
      return Promise.resolve({
        ok: false,
        status: 429,
        text: () => Promise.resolve("MYMEMORY WARNING: NEXT AVAILABLE IN 00 HOURS 24 MINUTES 31 SECONDS"),
        json: () => Promise.resolve({}),
      });
    }
    if (mockMode === "rate429") {
      // 频率限流：429 但响应体没有可解析的恢复时间（大页面并发的常见场景）
      return Promise.resolve({
        ok: false,
        status: 429,
        text: () => Promise.resolve("too many requests, slow down"),
        json: () => Promise.resolve({}),
      });
    }
    if (mockMode === "warnNoTime") {
      // 与额度无关的 WARNING（如单条超长）：不该触发配额熔断
      return jsonResponse({
        responseStatus: 400,
        responseDetails: "MYMEMORY WARNING: QUERY LENGTH LIMIT EXCEEDED (MAX 500 BYTES)",
        responseData: { translatedText: "" },
      });
    }
    if (mockMode === "http500") {
      return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("err") });
    }
    if (mockMode === "mergeLines") {
      // 把多行合并成一行 —— 真实 MyMemory 最常见的脏行为
      const joined = q.split("\n").join(" ");
      return jsonResponse({
        responseStatus: 200,
        responseData: { translatedText: translateMock(joined, src, tgt) },
        matches: [{ source: src }],
      });
    }
    if (mockMode === "echoBack") {
      // 完全不翻译，原样回显（配额将尽 / 同语系时的行为）
      return jsonResponse({
        responseStatus: 200,
        responseData: { translatedText: q },
        matches: [{ source: src }],
      });
    }
    // normal：逐行翻译，保持行数
    const lines = q.split("\n");
    const out = lines.map((l) => translateMock(l, src, tgt)).join("\n");
    return jsonResponse({
      responseStatus: 200,
      responseData: { translatedText: out },
      matches: [{ source: src }],
    });
  }

  if (u.hostname === "api.dictionaryapi.dev") {
    const word = decodeURIComponent(u.pathname.split("/").pop() || "");
    if (DICT_FIXTURES[word]) return jsonResponse(DICT_FIXTURES[word], 200);
    return jsonResponse({ title: "No Definitions Found" }, 404);
  }

  if (u.hostname === "cn.bing.com") {
    // 必应词典：返回带 sentenceSeg 的 HTML，供 fetchBingExamples 抽双语例句。
    // 同时带 meta description，保证 callBingDict（中文词）也能解析（不报错）。
    const q = (u.searchParams.get("q") || "").toLowerCase();
    let html;
    if (q === "noexamples") {
      // 没有 sentenceSeg 区块的页面：用于验证"空例句不写缓存"
      html = `<html><head><meta name="description" content="必应词典为您提供noexamples的释义，美[nəʊ]，n. 无；"></head><body>（该词暂无例句）</body></html>`;
    } else if (q === "管理员登录成功" || q === "shellpage") {
      // 必应"壳页面"：对没有词条的短语/伪词，返回的是内嵌大量脚本的杂讯页
      // （真实抓取样本：meta description 只剩「词典」两个字、没有 sentenceSeg）。
      // 旧实现把任何非空 desc 都当释义，用户会看到 "1. Dictionary" 这种严重错误。
      html = `<html><head><meta name="description" content="词典"></head><body><script>var bd_nd_=1;window.CSPEL=[];sourceFile.includes(t)})||["javascript:void(0)"].some(function(t){return }});</script></body></html>`;
    } else if (q === "enshell") {
      // 壳页面的英文 locale 变体：desc 只剩 "Dictionary"
      html = `<html><head><meta name="description" content="Dictionary"></head><body></body></html>`;
    } else if (q === "sessions") {
      // 回归样本：音标里含字面撇号 英['seʃ(ə)n]（双引号属性内的撇号是合法字符）。
      // 旧提取正则 content=["']([^"']+)["'] 会在这里错误截断 → desc 残留 "英[" → 释义全空。
      // 用这个样本锁定"按定界符匹配"的修复。
      html = `<html><head><meta name="description" content="必应词典为您提供sessions的释义，美[ˈseʃ(ə)n]，英['seʃ(ə)n]，n. 环节；阶段；(正式)会议；(法院)开庭； adj. 为录音的歌手或乐队伴奏的； 网络释义： 会期；研讨；会话数； "></head><body>
      <div id="sentenceSeg">
        <div class="se_li"><div class="sen_en">Coaching sessions are done over the phone.</div><div class="sen_cn">培训课程是通过电话完成的。</div></div>
        <div class="se_li"><div class="sen_en">I used to find lengthy sex sessions boring.</div><div class="sen_cn">过去我认为持续几小时的性爱有点令人乏味。</div></div>
        <div class="se_li"><div class="sen_en">The session was recorded.</div><div class="sen_cn">会议被记录下来了。</div></div>
      </div></body></html>`;
    } else {
      html = `<html><head><meta name="description" content="必应词典为您提供test的释义，美[tɛst]，n. 测试； v. 测试；"></head><body>
      <div id="sentenceSeg">
        <div class="se_li"><div class="sen_en">This is a <b>test</b> of the system.</div><div class="sen_cn">这是对系统的一次测试。</div></div>
        <div class="se_li"><div class="sen_en">We passed the final test.</div><div class="sen_cn">我们通过了期末考试。</div></div>
        <div class="se_li"><div class="sen_en">The teacher will test us tomorrow.</div><div class="sen_cn">老师明天要考我们。</div></div>
      </div></body></html>`;
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error("not json")),
      text: () => Promise.resolve(html),
    });
  }
  return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve("") });
}

// 极简"翻译"：给每行加个目标语言标记，方便断言是否真的走了翻译
function translateMock(line, src, tgt) {
  const body = String(line).replace(/^[pde][\s]*[:：][\s]*/i, "");
  return `[${tgt}] ${body}`;
}

function jsonResponse(obj, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(obj),
    text: () => Promise.resolve(JSON.stringify(obj)),
  });
}

// 多 entry 词典样本（同形异义：bank 的「银行 / 河岸」）
const DICT_FIXTURES = {
  bank: [
    {
      word: "bank",
      phonetics: [{ text: "/bæŋk/", audio: "https://api.dictionaryapi.dev/media/pronunciations/en/bank-uk.mp3" }],
      meanings: [
        {
          partOfSpeech: "noun",
          synonyms: ["financial institution"],
          antonyms: [],
          definitions: [
            { definition: "An institution where one can place and borrow money.", example: "I went to the bank." },
            { definition: "A branch office of such an institution." },
          ],
        },
        {
          partOfSpeech: "verb",
          definitions: [{ definition: "To deal with a bank or financial institution.", example: "He banked the money." }],
        },
      ],
    },
    {
      // 第二个 entry：河岸 / 倾斜（旧实现只取 json[0]，这部分全丢）
      word: "bank",
      phonetics: [{ text: "/bæŋk/" }],
      meanings: [
        {
          partOfSpeech: "noun",
          definitions: [
            { definition: "The slope of land adjoining a river.", example: "We sat on the river bank." },
            { definition: "An elevated area of a sea floor." },
          ],
        },
        {
          partOfSpeech: "verb",
          definitions: [{ definition: "To incline or tilt sideways." }],
        },
      ],
    },
  ],
  hello: [
    {
      word: "hello",
      phonetics: [{ text: "/həˈləʊ/", audio: "https://api.dictionaryapi.dev/media/pronunciations/en/hello-uk.mp3" }],
      meanings: [
        { partOfSpeech: "noun", definitions: [{ definition: "A greeting.", example: "She said hello." }] },
        { partOfSpeech: "verb", definitions: [{ definition: "To greet with a hello." }] },
        { partOfSpeech: "interjection", definitions: [{ definition: "Used as a greeting." }] },
      ],
    },
  ],
};

const storageData = {};
// background 主动推送给 tab 的消息（chrome.tabs.sendMessage），
// 用于验证"每翻完一个桶就回推一次"的流式通道
const tabMessages = [];
// 捕获 background 注册的消息处理器，用于端到端测试
let messageListener = null;
const chromeStub = {
  runtime: {
    id: "test",
    onMessage: {
      addListener: (fn) => {
        if (!messageListener) messageListener = fn;
      },
    },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    reload: () => {},
    lastError: null,
  },
  storage: {
    sync: { get: (k) => Promise.resolve(pick(storageData, k)), set: (o) => { Object.assign(storageData, o); return Promise.resolve(); }, remove: () => Promise.resolve() },
    local: { get: (k) => Promise.resolve(pick(storageData, k)), set: (o) => { Object.assign(storageData, o); return Promise.resolve(); } },
  },
  contextMenus: {
    removeAll: (cb) => cb && cb(),
    create: () => {},
    onClicked: { addListener: () => {} },
  },
  scripting: { executeScript: () => Promise.resolve() },
  tabs: {
    // 捕获流式回推，供"翻译一条显示一条"的用例断言
    sendMessage: (tabId, msg) => {
      tabMessages.push({ tabId, msg });
      return Promise.resolve();
    },
  },
  webNavigation: { getAllFrames: () => Promise.resolve([]) },
};
function pick(obj, k) {
  const keys = Array.isArray(k) ? k : [k];
  const out = {};
  for (const key of keys) if (key in obj) out[key] = obj[key];
  return out;
}

const sandbox = {
  chrome: chromeStub,
  fetch: mockFetch,
  console,
  setTimeout,
  clearTimeout,
  Date,
  URL,
  URLSearchParams,
  AbortController,
  AbortSignal,
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  TextEncoder,
  Promise,
  JSON,
  Math,
  Map,
  Set,
  Array,
  Object,
  String,
  Number,
  RegExp,
  Error,
  globalThis: null,
};
sandbox.globalThis = sandbox;

const EXPORTS = [
  "detectLang", "sameLang", "resolveTarget", "oppositeLang", "resolveMmSource",
  "translateDefinitionsToTarget", "translateExamplesToTarget", "translateBatchTexts",
  "translateWith", "parseRetryAfterMinutes", "normalizeCompare", "looksLikeWord",
  "mergeMeanings", "parseBingDesc", "parseBingExamples", "mapPool", "getZhRegion", "normalizeLang",
  "fetchBingExamples", "isExplicitExample", "callBingDict", "callMyMemory", "ensureQuotaUsage",
  "lookupFreeDictionary", "lookupBingDict", "lookupBingExamples", "persistCacheSet",
  // 缓存/去重容器：测试里切换 mockMode 后必须清空，否则会命中上一轮的缓存
  // persistCache 是跨 SW 休眠的磁盘缓存副本，同样必须清 —— 否则换了 mock
  // 行为却拿到上一轮写入的译文，断言会莫名其妙地失败。
  "cache", "inflight", "persistCache", "quotaUsage", "quotaCooldown", "rateLimitState",
];
function resetMocks() {
  api.cache.clear();
  api.inflight.clear();
  api.persistCache.clear();
  delete storageData.yufanTLCache;
  // 客户端配额记账也要归零：测试会跑上百次请求，累计字符数足以触发配额闸门
  api.quotaUsage.chars = 0;
  api.quotaUsage.start = Date.now();
  // 429 冷却也要清：quota mock 会设置 24 分钟冷却，不清会让后续所有
  // MyMemory 请求在闸门处直接抛错，污染后面的用例
  if (api.quotaCooldown) api.quotaCooldown.clear();
  // 频率限流退避也要清：rate429 mock 会设置 8s 退避，不清会让后续用例
  // 全部在 isRateLimited() 处直接失败
  if (api.rateLimitState) api.rateLimitState.until = 0;
  mockCalls.length = 0;
  // defer 模式遗留的挂起回调也要清：上个用例 abort 后没放行的 deferred
  // 请求会让下个用例数出虚高的"在途并发"（pending=7 而非 6）
  pendingMm.length = 0;
}
vm.createContext(sandbox);
vm.runInContext(source + `\n;globalThis.__api = {${EXPORTS.join(",")}};`, sandbox, {
  filename: "background.js",
});
const api = sandbox.__api;

// ---------- 断言 ----------
let pass = 0;
let fail = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) {
    pass++;
    results.push(`  ✓ ${name}`);
  } else {
    fail++;
    results.push(`  ✗ ${name}${detail ? "  ->  " + detail : ""}`);
  }
}
function section(t) {
  results.push(`\n${t}`);
}

async function run() {
  // ============ 1. 语言检测 ============
  section("语言检测 detectLang");
  check("简体中文", api.detectLang("这是一段简体中文文本").code === "zh-CN", api.detectLang("这是一段简体中文文本").code);
  check("繁体中文", api.detectLang("這是一段繁體中文文本").code === "zh-TW", api.detectLang("這是一段繁體中文文本").code);
  check("日文（假名）", api.detectLang("これは日本語のテキストです").code === "ja");
  check("韩文", api.detectLang("이것은 한국어 텍스트입니다").code === "ko");
  check("俄文", api.detectLang("Это русский текст").code === "ru");
  check("英文长句", api.detectLang("This is a very long English sentence about the weather").code === "en");
  check(
    "英文长句 confident",
    api.detectLang("This is a very long English sentence about the weather").confident === true
  );
  check("单个英文单词不自信", api.detectLang("hello").confident === false);
  check("纯数字无结论", api.detectLang("12345").code === "");

  // ============ 2. 同语言保护 ============
  section("同语言保护 resolveTarget / sameLang");
  check("中文文本 + 目标中文 -> 切英文", api.resolveTarget("这是一段中文", "auto", "zh-CN") === "en");
  check("英文文本 + 目标英文 -> 切中文", api.resolveTarget("this is english text", "auto", "en") === "zh-CN");
  check("中文文本 + 目标英文 -> 保持", api.resolveTarget("这是一段中文", "auto", "en") === "en");
  check(
    "简中 -> 繁中 不被切走（繁简互译合法）",
    api.resolveTarget("这是一段中文", "auto", "zh-TW") === "zh-TW"
  );
  check("显式 source=zh-CN, target=zh-CN -> en", api.resolveTarget("x", "zh-CN", "zh-CN") === "en");
  check("显式 source=en, target=en-US -> zh-CN", api.resolveTarget("x", "en", "en-US") === "zh-CN");
  check("显式 source=zh-CN, target=zh-TW -> 保持", api.resolveTarget("x", "zh-CN", "zh-TW") === "zh-TW");
  check("法文文本 + 目标法文 -> 切中文", api.resolveTarget("Bonjour le monde comment allez vous", "auto", "fr") === "zh-CN");
  check("sameLang: zh-CN vs zh-TW = false", api.sameLang("zh-CN", "zh-TW") === false);
  check("sameLang: zh-CN vs zh-CN = true", api.sameLang("zh-CN", "zh-CN") === true);
  check("sameLang: en vs en-US = true", api.sameLang("en", "en-US") === true);
  check("sameLang: en vs zh = false", api.sameLang("en", "zh-CN") === false);

  // ============ 3. 冷却时间解析 ============
  section("MyMemory 冷却时间解析");
  check(
    "完整 '00 HOURS 24 MINUTES 31 SECONDS'",
    api.parseRetryAfterMinutes("NEXT AVAILABLE IN 00 HOURS 24 MINUTES 31 SECONDS") === 24
  );
  check(
    "缺小时 '24 MINUTES 31 SECONDS'（旧实现解析失败）",
    api.parseRetryAfterMinutes("NEXT AVAILABLE IN 24 MINUTES 31 SECONDS") === 24
  );
  check("只有秒 -> 至少 1 分钟", api.parseRetryAfterMinutes("IN 45 SECONDS") === 1);
  check("无匹配 -> 0", api.parseRetryAfterMinutes("no info here") === 0);

  // ============ 4. 词典多 entry 合并（一词多义） ============
  section("词典多 entry 合并");
  const merged = api.mergeMeanings(DICT_FIXTURES.bank, "bank");
  const noun = merged.find((m) => m.partOfSpeech === "noun");
  const verb = merged.find((m) => m.partOfSpeech === "verb");
  check("noun 段合并了 4 条释义（旧实现只有 2 条）", noun && noun.definitions.length === 4, noun && noun.definitions.length);
  check("verb 段合并了 2 条释义", verb && verb.definitions.length === 2, verb && verb.definitions.length);
  check(
    "含「河岸」释义（来自第二个 entry）",
    JSON.stringify(merged).includes("slope of land adjoining a river")
  );
  check("词性级同义词已下放到 def", noun && noun.definitions[0].synonyms.length > 0);

  // 一词多义去重改进：释义相同但例句不同 -> 视为不同义项，都保留；
  // 释义+例句完全相同 -> 去重只留一条。
  const dupMerged = api.mergeMeanings(
    [
      {
        word: "lead",
        meanings: [
          {
            partOfSpeech: "noun",
            definitions: [
              { definition: "Same definition.", example: "Example A about metal." },
              { definition: "Same definition.", example: "Example B about guiding." },
              { definition: "Same definition.", example: "Example A about metal." }, // 完全重复
            ],
          },
        ],
      },
    ],
    "lead"
  );
  const leadNoun = dupMerged.find((m) => m.partOfSpeech === "noun");
  check(
    "同释义不同例句 -> 保留为 2 条（一词多义不再被误删）",
    leadNoun && leadNoun.definitions.length === 2,
    leadNoun && leadNoun.definitions.length
  );
  check(
    "完全重复的释义+例句 -> 去重到 1 条",
    JSON.stringify(dupMerged).includes("Example A about metal.") &&
      (leadNoun.definitions.filter((d) => d.example === "Example A about metal.").length === 1),
    leadNoun && JSON.stringify(leadNoun.definitions.map((d) => d.example))
  );

  // ============ 5. 释义翻译：正常路径 ============
  section("释义翻译 translateDefinitionsToTarget（正常）");
  const meanings = [
    { partOfSpeech: "noun", definitions: [{ definition: "A greeting.", example: "She said hello." }] },
    { partOfSpeech: "verb", definitions: [{ definition: "To greet." }] },
  ];
  mockMode = "normal";
  resetMocks();
  let out = await api.translateDefinitionsToTarget(meanings, "en", "zh-CN", null);
  check("返回结构段数一致", out.length === 2);
  check(
    "noun 释义已翻译",
    out[0].definitions[0].definition === "[zh-CN] A greeting.",
    out[0].definitions[0].definition
  );
  check("词性已翻译", out[0].partOfSpeech === "[zh-CN] noun", out[0].partOfSpeech);
  check(
    "例句译文写入 example",
    out[0].definitions[0].example === "[zh-CN] She said hello.",
    out[0].definitions[0].example
  );
  check(
    "例句原文保留在 exampleOriginal",
    out[0].definitions[0].exampleOriginal === "She said hello.",
    out[0].definitions[0].exampleOriginal
  );
  check("第二词性也翻译了", out[1].definitions[0].definition === "[zh-CN] To greet.");
  check("无协议前缀残留", !/^[pde]\s*[:：]/.test(out[0].definitions[0].definition));

  // ============ 6. 释义翻译：MyMemory 合并行（关键回归） ============
  section("释义翻译（MyMemory 把多行合并成一行 —— 旧实现会串行错位）");
  const meanings2 = [
    { partOfSpeech: "noun", definitions: [{ definition: "Alpha def.", example: "Alpha example." }] },
    { partOfSpeech: "verb", definitions: [{ definition: "Beta def.", example: "Beta example." }] },
    { partOfSpeech: "adjective", definitions: [{ definition: "Gamma def." }] },
  ];
  mockMode = "mergeLines";
  resetMocks();
  out = await api.translateDefinitionsToTarget(meanings2, "en", "zh-CN", null);
  check("段数仍为 3", out.length === 3);
  check("noun 释义不含 beta（没串位）", !out[0].definitions[0].definition.toLowerCase().includes("beta"), out[0].definitions[0].definition);
  check("verb 释义不含 alpha（没串位）", !out[1].definitions[0].definition.toLowerCase().includes("alpha"), out[1].definitions[0].definition);
  check("adjective 释义不含 alpha/beta", !/alpha|beta/i.test(out[2].definitions[0].definition), out[2].definitions[0].definition);
  check(
    "每条译文都带上了目标语言标记（说明确实逐条重翻）",
    out.every((m) => (m.definitions[0].definition || "").includes("[zh-CN]")),
    JSON.stringify(out.map((m) => m.definitions[0].definition))
  );
  check("例句与释义未混淆", out[0].definitions[0].example.includes("Alpha example"), out[0].definitions[0].example);

  // ============ 7. 释义翻译：原样回显 ============
  section("释义翻译（MyMemory 完全不翻译，原样回显）");
  mockMode = "echoBack";
  resetMocks();
  out = await api.translateDefinitionsToTarget(meanings2, "en", "zh-CN", null);
  check("结构完整", out.length === 3);
  check(
    "回退保留原始英文释义（不出现空壳）",
    out[0].definitions[0].definition === "Alpha def.",
    out[0].definitions[0].definition
  );
  check("例句原文仍在", out[0].definitions[0].exampleOriginal === "Alpha example.");

  // ============ 8. 批量翻译（整页翻译） ============
  section("批量翻译 translateBatchTexts");
  mockMode = "normal";
  resetMocks();
  const texts = ["Hello world", "Home", "", "Contact us", "Hello world", "About"];
  let batchOut = await api.translateBatchTexts(texts, "auto", "zh-CN", null);
  check("批次返回 {results, aborted, error} 结构", batchOut && Array.isArray(batchOut.results), JSON.stringify(batchOut));
  let res = batchOut.results;
  check("结果长度与输入一致", res.length === texts.length, res.length);
  check("空串不报错", res[2] === "");
  check("去重副本拿到相同译文", res[4] === res[0], `${res[4]} vs ${res[0]}`);
  check("译文已翻译", res[0] === "[zh-CN] Hello world", res[0]);
  check("第二条也翻译了", res[1] === "[zh-CN] Home", res[1]);

  // 合并行场景
  mockMode = "mergeLines";
  resetMocks();
  res = (await api.translateBatchTexts(["Hello world", "Home", "Contact us", "About"], "auto", "zh-CN", null)).results;
  check("合并行时逐条降级，译文不串位", res[0] === "[zh-CN] Hello world" && res[1] === "[zh-CN] Home", JSON.stringify(res));
  check("合并行时长度仍对齐", res.length === 4);

  // ============ 8b. 批次超时/配额：绝不整批作废 ============
  // 回归背景：旧实现在批次超时 abort 时整批 throw -> 消息层回 {ok:false}
  // -> content 一条译文都拿不到 -> "右键整页翻译点了没反应"。
  section("批次超时/配额异常（部分结果保留 + 错误上报）");
  {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // --- 场景一：超时 abort。defer 模式下请求挂起，放行第一批后 abort，
    // 已完成的桶必须保留译文，未完成的回填原文 ---
    mockMode = "defer";
    resetMocks();
    const ac = new AbortController();
    const manyTexts = [];
    for (let i = 0; i < 120; i++) manyTexts.push(`Line number ${i} of the page`);
    const abortP = api.translateBatchTexts(manyTexts, "auto", "zh-CN", ac.signal);
    await sleep(20); // 等 4 个并发请求挂起
    releaseMm(); // 放行第一波（这些会翻好）
    await sleep(20); // runners 取下一批、又挂起
    ac.abort(); // 模拟批次超时
    const out = await abortP;
    check(
      "超时不再整批作废：正常返回 results",
      !!out && Array.isArray(out.results),
      JSON.stringify(out).slice(0, 120)
    );
    check("aborted 标记为 true", out.aborted === true, out.aborted);
    check("结果与输入等长", out.results.length === manyTexts.length, out.results && out.results.length);
    const translatedCount = out.results.filter((v, i) => v !== manyTexts[i]).length;
    const origCount = out.results.filter((v, i) => v === manyTexts[i]).length;
    check("已完成部分保留译文", translatedCount > 0, translatedCount);
    check("未完成部分回填原文（无空串）", origCount > 0 && out.results.every((v) => !!v), origCount);

    // --- 场景二：配额耗尽（429）。必须显式上报，而不是静默回填原文 ---
    mockMode = "quota";
    resetMocks();
    const q = await api.translateBatchTexts(["Hello world", "Home"], "auto", "zh-CN", null);
    check("配额耗尽：quotaExhausted=true", q.quotaExhausted === true, q.quotaExhausted);
    check("配额耗尽：error 带中文提示", /额度/.test(q.error || ""), q.error);
    check(
      "配额耗尽：回填原文不留空",
      q.results[0] === "Hello world" && q.results[1] === "Home",
      JSON.stringify(q.results)
    );
    check(
      "配额耗尽：rateLimited=false（长冷却 429 属于额度类）",
      q.rateLimited === false,
      q.rateLimited
    );

    // --- 场景二 b：频率限流（429 无恢复时间）。绝不熔断整页 ---
    mockMode = "rate429";
    resetMocks();
    const rl = await api.translateBatchTexts(["Rate limit probe one", "Rate limit probe two"], "auto", "zh-CN", null);
    check("频率限流：rateLimited=true", rl.rateLimited === true, rl.rateLimited);
    check("频率限流：quotaExhausted=false（不熔断）", rl.quotaExhausted === false, rl.quotaExhausted);
    check("频率限流：不设配额冷却", api.quotaCooldown.size === 0, api.quotaCooldown.size);
    check("频率限流：进入短暂退避", api.rateLimitState.until > Date.now(), api.rateLimitState.until);
    check(
      "频率限流：error 带中文提示",
      /频繁|限流|降速/.test(rl.error || ""),
      rl.error
    );

    // --- 场景二 c：与额度无关的 WARNING。按普通错误处理，不熔断 ---
    mockMode = "warnNoTime";
    resetMocks();
    const wn = await api.translateBatchTexts(["Warn no time probe"], "auto", "zh-CN", null);
    check("普通 WARNING：quotaExhausted=false", wn.quotaExhausted === false, wn.quotaExhausted);
    check("普通 WARNING：不设配额冷却", api.quotaCooldown.size === 0, api.quotaCooldown.size);
    check("普通 WARNING：error 透传详情", /WARNING/.test(wn.error || ""), wn.error);

    // --- 场景二 d：失败退费。失败请求不计入本地 24h 闸门 ---
    mockMode = "http500";
    resetMocks();
    const fr = await api.translateBatchTexts(
      ["Refund probe one", "Refund probe two"],
      "auto",
      "zh-CN",
      null
    );
    check(
      "失败请求退还本地记账（重试不撑爆闸门）",
      api.quotaUsage.chars === 0,
      "失败后记账=" + api.quotaUsage.chars
    );
    check("失败退费：错误正常上报", /HTTP 500/.test(fr.error || ""), fr.error);

    mockMode = "normal";
    resetMocks();
  }

  // ============ 8c. 批次吞吐（整页翻译提速的回归锁）============
  // 整页翻译的瓶颈是 MyMemory RTT（400~800ms/次）：并发度、拼块大小、
  // 以及"每请求一次 storage 写"直接决定墙钟时间。这些数值回退一点，
  // 用户体感就是"整页翻译又慢回去了"。
  section("批次吞吐优化（并发 6 / 拼块 480 / 配额防抖落盘）");
  {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // --- 并发 6：defer 模式下数在途请求数 ---
    mockMode = "defer";
    resetMocks();
    const manyTexts = [];
    for (let i = 0; i < 120; i++) manyTexts.push(`Throughput probe line ${i} please`);
    const concP = api.translateBatchTexts(manyTexts, "auto", "zh-CN", null);
    await sleep(30); // 等第一波请求挂起
    check(
      "批次并发为 6（RTT 是瓶颈，4 并发白白多等一整波）",
      pendingMm.length === 6,
      `pending=${pendingMm.length}`
    );
    // 分批放行直到全部完成（块数 > 并发数时会有第二波挂起，
    // 单次 releaseMm 放不完全部，promise 挂起会让 node 静默退出！）
    let concDone = false;
    concP.then(() => { concDone = true; });
    const deadline = Date.now() + 5000;
    while (!concDone && Date.now() < deadline) {
      releaseMm();
      await sleep(15);
    }
    const concOut = await concP;
    check(
      "并发批次正常完成且对齐",
      Array.isArray(concOut.results) && concOut.results.length === 120,
      concOut.results && concOut.results.length
    );

    // --- 拼块上限：单请求 q 不得超过 MyMemory 500 字节硬上限 ---
    mockMode = "normal";
    resetMocks();
    const bucketTexts = [];
    for (let i = 0; i < 40; i++) bucketTexts.push(`Bucket size check item ${i} with some padding`);
    await api.translateBatchTexts(bucketTexts, "auto", "zh-CN", null);
    const tooLong = mockCalls
      .filter((c) => c.url.includes("mymemory"))
      .filter((c) => (new URL(c.url).searchParams.get("q") || "").length > 500);
    check("拼块后单个请求 q 不超过 500 字节", tooLong.length === 0, `${tooLong.length} 个超限`);

    // --- 配额记账防抖：N 次请求不该有 N 次 storage 写 ---
    mockMode = "normal";
    resetMocks();
    let quotaWrites = 0;
    const origSet = chromeStub.storage.local.set;
    chromeStub.storage.local.set = (o) => {
      if (o && Object.prototype.hasOwnProperty.call(o, "yufanQuotaUsage")) quotaWrites++;
      return origSet(o);
    };
    for (let i = 0; i < 5; i++) {
      await api.callMyMemory(`quota debounce probe ${i}`, "en", "zh-CN", null);
    }
    chromeStub.storage.local.set = origSet;
    check(
      "配额记账防抖：5 次请求最多 1 次写盘（不再每请求一次）",
      quotaWrites <= 1,
      `writes=${quotaWrites}`
    );

    mockMode = "normal";
    resetMocks();
  }

  // ============ 8d. 流式回推（翻译一条显示一条）============
  // 只等整批返回 = 用户要熬完所有请求才看到第一条译文。这里锁定"每翻完
  // 一个桶就回推一次"，content 才能在回推里逐条插入 DOM。
  section("流式回推 onPartial（逐条显示的数据通道）");
  {
    mockMode = "normal";
    resetMocks();
    const partials = [];
    const streamTexts = [];
    for (let i = 0; i < 40; i++) streamTexts.push(`Stream item number ${i} here`);
    const out = await api.translateBatchTexts(streamTexts, "auto", "zh-CN", null, (items) => {
      partials.push(items);
    });
    check("有桶回推（不是最后一次性给全量）", partials.length > 0, `partials=${partials.length}`);
    const totalPushed = partials.reduce((s, it) => s + it.length, 0);
    check(
      "回推条目数与输入一致（一条不落）",
      totalPushed === streamTexts.length,
      `${totalPushed} vs ${streamTexts.length}`
    );
    const idxSeen = new Set();
    let idxOk = true;
    for (const it of partials) {
      for (const item of it) {
        if (
          typeof item.index !== "number" ||
          item.index < 0 ||
          item.index >= streamTexts.length ||
          idxSeen.has(item.index)
        ) {
          idxOk = false;
        }
        idxSeen.add(item.index);
      }
    }
    check("回推下标合法且不重复", idxOk);
    check(
      "回推内容与最终结果完全一致",
      partials.every((it) => it.every((item) => out.results[item.index] === item.text)),
      "回推值与最终结果不符"
    );

    mockMode = "normal";
    resetMocks();
  }

  // ============ 9. 整页翻译不进词典（noDict） ============
  section("整页翻译 noDict（单词不再被送进词典）");
  mockMode = "normal";
  resetMocks();
  const dictResult = await api.translateWith("hello", "auto", "zh-CN", null, {});
  check("不加 noDict 时走词典", dictResult.mode === "dictionary", dictResult.mode);
  const pageResult = await api.translateWith("hello", "auto", "zh-CN", null, { noDict: true });
  check("加 noDict 时走翻译", pageResult.mode === "translation", pageResult.mode);
  check("noDict 结果是译文而非英文释义", pageResult.translated === "[zh-CN] hello", pageResult.translated);

  // ============ 10. 单词判定 ============
  section("单词判定 looksLikeWord");
  check("英文单词", api.looksLikeWord("hello") === true);
  check("带撇号", api.looksLikeWord("don't") === true);
  check("带连字符", api.looksLikeWord("state-of-the-art") === true);
  check("单字中文", api.looksLikeWord("翻") === true);
  check("中文词", api.looksLikeWord("翻译") === true);
  check("句子（含空格）", api.looksLikeWord("hello world") === false);
  check("带句号", api.looksLikeWord("end.") === false);
  check("纯数字", api.looksLikeWord("12345") === false);
  check("超长串", api.looksLikeWord("a".repeat(31)) === false);

  // ============ 11. 并发池 ============
  section("并发池 mapPool");
  const order = [];
  await api.mapPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    order.push(n);
    return n * 2;
  });
  check("所有任务都被执行一次（无重复劳动）", order.length === 7 && new Set(order).size === 7, JSON.stringify(order));
  const mapped = await api.mapPool([1, 2, 3], 2, async (n) => n * 10);
  check("结果按序返回", JSON.stringify(mapped) === "[10,20,30]", JSON.stringify(mapped));

  // ============ 12. Bing description 解析 ============
  section("必应词典 meta description 解析");
  const bing = api.parseBingDesc(
    "必应词典为您提供翻译的释义，拼音[fān yì]，n. translation; translator； v. translate; interpret; render； 网络释义： Translator; version; interpreter；"
  );
  check("抽出拼音", bing.phonetic === "fān yì", bing.phonetic);
  check("解析出 n. 段", bing.meanings.some((m) => m.partOfSpeech === "n."), JSON.stringify(bing.meanings.map((m) => m.partOfSpeech)));
  check("解析出 v. 段", bing.meanings.some((m) => m.partOfSpeech === "v."));
  check("解析出网络释义段", bing.meanings.some((m) => m.partOfSpeech === "网络"));

  // fetchBingExamples：英文词的双语例句来源（best-effort，失败返回 []）
  const bingEx = await api.fetchBingExamples("test", null);
  check("fetchBingExamples 抽出双语例句", Array.isArray(bingEx) && bingEx.length > 0, JSON.stringify(bingEx && bingEx.length));
  check(
    "例句结构为 {en, cn}",
    bingEx.length > 0 && !!bingEx[0].en && !!bingEx[0].cn,
    JSON.stringify(bingEx[0])
  );

  // translateExamplesToTarget：把 Bing 双语例句 {en, cn} 按目标语言重组为 {ex, tr}。
  // 关键：常见情况（en/zh 目标）Bing 已自带双语，零联网、不耗配额、不报错。
  mockMode = "normal";
  resetMocks();
  const pair = [{ en: "This is a test.", cn: "我们测试。" }];

  // 中文 -> 英文：ex=英文例句，tr=中文翻译（不再把中文翻成英文）
  const exEn = await api.translateExamplesToTarget(pair, "zh-CN", "en", null);
  check("中文->英文：ex 是英文例句", exEn && exEn[0] && exEn[0].ex === "This is a test.");
  check("中文->英文：tr 是中文翻译", exEn && exEn[0] && exEn[0].tr === "我们测试。");
  check("中文->英文：未发 MyMemory 请求（零配额）", mockCalls.every((c) => !String(c.url).includes("mymemory")));
  resetMocks();

  // 中文 -> 简中：ex=中文例句，tr=英文对照
  const exZh = await api.translateExamplesToTarget(pair, "zh-CN", "zh-CN", null);
  check("中文->简中：ex 是中文例句", exZh && exZh[0] && exZh[0].ex === "我们测试。");
  check("中文->简中：tr 是英文对照", exZh && exZh[0] && exZh[0].tr === "This is a test.");

  // 中文 -> 繁中：ex=繁体（离线转），tr=简体
  const exTw = await api.translateExamplesToTarget(pair, "zh-CN", "zh-TW", null);
  check("中文->繁中：ex 已转繁体（们->們）", exTw && exTw[0] && exTw[0].ex.includes("們"));
  check("中文->繁中：tr 仍是简体", exTw && exTw[0] && exTw[0].tr === "我们测试。");

  // 其他目标语言（ja/ko/fr/de）：不能把英文例句整句丢弃。
  // 旧实现对非中英文目标、dictSrc=zh-CN 时只渲染 cn、en 直接丢掉。
  resetMocks();
  const pairJa = [{ en: "This is a test.", cn: "我们测试。" }];
  const exJa = await api.translateExamplesToTarget(pairJa, "zh-CN", "ja", null);
  check(
    "日文目标：英文例句被翻成日文（ex 含 [ja] 标记）",
    exJa && exJa[0] && exJa[0].ex.includes("[ja]"),
    JSON.stringify(exJa && exJa[0])
  );
  check(
    "日文目标：英文原文未被丢弃（tr 保留英文）",
    exJa && exJa[0] && exJa[0].tr === "我们测试。",
    JSON.stringify(exJa && exJa[0])
  );

  // ============ 12b. 词典结果缓存（省配额 + 跨 SW 休眠复用）============
  section("词典结果缓存");
  mockMode = "normal";
  resetMocks();
  const before = mockCalls.length;
  const d1 = await api.lookupFreeDictionary("hello", null);
  const d2 = await api.lookupFreeDictionary("hello", null);
  const dictCalls = mockCalls.slice(before).filter((c) => String(c.url).includes("dictionaryapi.dev")).length;
  check("Free Dictionary 结果被缓存（二次查询不再发网络）", dictCalls === 1, `calls=${dictCalls}`);
  check("两次查询结果一致", JSON.stringify(d1) === JSON.stringify(d2));
  // 跨 SW 休眠：结果应已进入持久化副本。
  // 注意 storage.local 的写入是 schedulePersistFlush 防抖的，此刻未必落盘，
  // 所以内存镜像 persistCache 与磁盘副本任一命中即算通过（与下方 12c 的写法一致）。
  const persistedNow =
    api.persistCache.has("dict2:fd:hello") ||
    (!!storageData.yufanTLCache && Object.keys(storageData.yufanTLCache).some((k) => k.startsWith("dict2:fd:hello")));
  check(
    "词典结果已写入持久化缓存（SW 休眠后可复用）",
    persistedNow,
    `persistCache.size=${api.persistCache.size}`
  );
  check(
    "缓存的是真实词条而非空壳（空结果不缓存）",
    !!(d1 && d1.meanings && d1.meanings.length > 0),
    JSON.stringify(d1 && (d1.meanings || []).length)
  );

  // ============ 12c. popup 响应速度（并行化 / 超时 / 落盘体积）============
  // 这些是"弹窗点下去半天没反应"的直接成因，回归了就会重新变慢。
  section("响应速度");
  {
    const grab = (name) => {
      const m = source.match(new RegExp(`const ${name} = (\\d+);`));
      return m ? Number(m[1]) : NaN;
    };
    check(
      "词典超时 ≤3s（旧值 6s：Bing 挂住时查词要白屏 6 秒）",
      grab("DICT_TIMEOUT_MS") <= 3000,
      `DICT_TIMEOUT_MS=${grab("DICT_TIMEOUT_MS")}`
    );
    check(
      "普通请求超时 ≤8s（旧值 15s）",
      grab("REQUEST_TIMEOUT_MS") <= 8000,
      `REQUEST_TIMEOUT_MS=${grab("REQUEST_TIMEOUT_MS")}`
    );
    check(
      "可选例句的软超时严格短于主词典超时（例句不该拖慢主结果）",
      grab("BING_EXAMPLES_TIMEOUT_MS") < grab("DICT_TIMEOUT_MS"),
      `examples=${grab("BING_EXAMPLES_TIMEOUT_MS")} dict=${grab("DICT_TIMEOUT_MS")}`
    );
  }

  // 例句与释义的翻译必须并发：串行会多付一整轮 MyMemory 往返（实测 p50 ≈ 600ms，
  // 网络差时可到 2.5s）。用 defer 模式观察"哪些请求已经发出"来区分两者。
  mockMode = "defer";
  resetMocks();
  pendingMm.length = 0;
  {
    const p = api.translateWith("hello", "auto", "ja", null);
    // 等到"两个翻译任务的请求都发出去"或超时。串行实现一次只发一个，
    // 这里会等到上限 —— 所以下面必须对挂起请求做有界放行，
    // 否则一旦实现回退，测试会永久挂住而不是失败。
    for (let i = 0; i < 50 && pendingMm.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    const mmCalls = mockCalls.filter((c) => String(c.url).includes("mymemory"));
    const qOf = (c) => new URL(String(c.url)).searchParams.get("q") || "";
    const hasEx = mmCalls.some((c) => /This is a|We passed|The teacher/.test(qOf(c)));
    const hasDef = mmCalls.some((c) => /A greeting|To greet|Used as a greeting/.test(qOf(c)));
    check(
      "例句与释义的翻译并发发出（串行时这里只能看到其中之一）",
      hasEx && hasDef,
      `mm=${mmCalls.length} ex=${hasEx} def=${hasDef}`
    );
    // 有界放行：串行实现会一批接一批地产生新挂起请求
    for (let i = 0; i < 30 && pendingMm.length; i++) {
      releaseMm();
      await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, 500))]);
  }
  mockMode = "normal";

  // 空例句不写缓存：fetchBingExamples 失败时也返回 []，若缓存进去，
  // 一次网络抖动会让这个词永久查不到例句。
  resetMocks();
  {
    const bingHits = (from) =>
      mockCalls.slice(from).filter((c) => String(c.url).includes("cn.bing.com")).length;
    const s1 = mockCalls.length;
    await api.lookupBingExamples("noexamples", null);
    const n1 = bingHits(s1);
    const s2 = mockCalls.length;
    await api.lookupBingExamples("noexamples", null);
    const n2 = bingHits(s2);
    check(
      "例句为空时不写缓存（否则一次抖动会让该词永久无例句）",
      n1 === 1 && n2 === 1,
      `first=${n1} second=${n2}`
    );
  }

  // 落盘体积上限：storage.local 只有 10MB（manifest 未申请 unlimitedStorage），
  // 一条几十 KB 的词典结果不该进持久化缓存。
  resetMocks();
  {
    await api.persistCacheSet("perf:huge", { blob: "x".repeat(64 * 1024) });
    check(
      "超大条目不落盘（避免撑爆 storage.local 的 10MB 配额）",
      !api.persistCache.has("perf:huge"),
      `persistCache.size=${api.persistCache.size}`
    );
    await api.persistCacheSet("perf:small", { a: 1 });
    check("普通条目照常落盘", api.persistCache.has("perf:small"));
    // 外部清空过 Map 后计数器必须自愈，否则新条目会被误淘汰
    api.persistCache.clear();
    await api.persistCacheSet("perf:after-clear", { b: 2 });
    check(
      "Map 被外部清空后字节计数自愈（新条目不会被误淘汰）",
      api.persistCache.has("perf:after-clear"),
      `persistCache.size=${api.persistCache.size}`
    );
  }

  // ============ 12d. 必应壳页面防御 ============
  // 无词条短语返回的杂讯壳页面曾被当成词典结果渲染（"1. Dictionary" 严重错误）。
  section("必应壳页面防御");
  resetMocks();
  {
    let err = null;
    try {
      await api.callBingDict("管理员登录成功", null);
    } catch (e) {
      err = e;
    }
    check(
      "壳页面按未收录处理（抛 DICT_NOT_FOUND，上层降级 MyMemory 整句翻译）",
      !!err && err.code === "DICT_NOT_FOUND",
      err && err.message
    );
    err = null;
    try {
      await api.callBingDict("enshell", null);
    } catch (e) {
      err = e;
    }
    check(
      "英文 locale 壳页面（desc=Dictionary）同样拒绝",
      !!err && err.code === "DICT_NOT_FOUND",
      err && err.message
    );
    // 第二道闸：即使杂讯漏进解析层，形似代码的碎片也不得成为释义
    const g = api.parseBingDesc(
      "必应词典为您提供x的释义，n. sourceFile.includes(t)})||[\"javascript:void(0)\"].some(function(t){return }})； v. sample.includes(t)})?!0:window.CSPEL.includes(n.sample)；"
    );
    check("形似代码的碎片不当作释义", g.meanings.length === 0, JSON.stringify(g.meanings).slice(0, 80));
    // 误伤检查：普通英文释义（含 return/back 等日常词）不受代码过滤影响
    const ok = api.parseBingDesc("必应词典为您提供return的释义，n. give back； v. come back；");
    check(
      "正常释义不被代码过滤误伤",
      ok.meanings.length === 2 && ok.meanings[0].definitions[0].definition === "give back",
      JSON.stringify(ok.meanings)
    );
    // 光修解析还不够：旧版本已经把垃圾写进了持久化缓存（TTL 30 天、存磁盘），
    // cached() 读缓存不做校验，重装扩展也照样命中 —— "修好了却还是错"。
    // 词典缓存必须用带版本号的命名空间与旧键彻底隔离。
    const ns = (source.match(/const DICT_CACHE_NS = "([^"]+)"/) || [, ""])[1];
    check(
      "词典缓存命名空间已升版（退回 dict 会让旧脏数据复活）",
      ns === "dict2",
      `DICT_CACHE_NS=${ns}`
    );
    resetMocks();
    await api.lookupBingDict("sessions", null);
    const ck = [...api.persistCache.keys()];
    check(
      "词典缓存落到新命名空间，且不再产生旧 dict: 键",
      ck.some((k) => k.startsWith("dict2:bing:sessions")) && !ck.some((k) => k.startsWith("dict:")),
      JSON.stringify(ck.slice(0, 5))
    );
  }
  mockMode = "normal";

  // ============ 13. 端到端：走真实的消息处理器 ============
  section("端到端（chrome.runtime.onMessage）");
  // sender 可选：流式回推按 sender.tab.id 定向，需要构造带 tab 的 sender
  const send = (msg, sender = {}) =>
    new Promise((resolve) => {
      const keep = messageListener(msg, sender, resolve);
      if (!keep) resolve(undefined);
    });

  // PING 的消息协议必须与 popup.js 里 expectedProtocol 一致。
  // 注意断言的是 protocol 而不是迭代号：迭代号每次发版都要手工同步两处，
  // 漏改就会让 popup 打开即 reload（扩展反复重启）。协议只在消息结构变化时 bump。
  const ping = await send({ type: "YUFAN_PING" });
  check("YUFAN_PING 有响应", !!(ping && ping.ok));
  check("YUFAN_PING 返回协议版本", !!(ping && ping.protocol), JSON.stringify(ping));
  const popupSrc = fs.readFileSync(path.resolve(__dirname, "../extension/popup.js"), "utf8");
  const expectedInPopup = (popupSrc.match(/const expectedProtocol = "([^"]+)"/) || [])[1];
  check(
    `PING 协议与 popup.js 期望值一致 (${ping && ping.protocol} / ${expectedInPopup})`,
    !!(ping && ping.protocol) && ping.protocol === expectedInPopup
  );
  check(
    "popup.js 不再按迭代号 reload（避免循环重启）",
    !/const expected = "v/.test(popupSrc)
  );

  // DETECT
  const det = await send({ type: "YUFAN_DETECT", payload: { text: "这是一段简体中文网页内容" } });
  check("YUFAN_DETECT 识别简中", det && det.data && det.data.code === "zh-CN", JSON.stringify(det && det.data));

  // 同语言保护：中文文本 + 目标简中 -> 自动翻成英文（旧实现在这里会硬报错）
  mockMode = "normal";
  resetMocks();
  const zhToZh = await send({
    type: "YUFAN_TRANSLATE",
    payload: { text: "这是一段中文", source: "auto", target: "zh-CN" },
  });
  check("中文文本 + 目标简中：不再报『源语言和目标语言相同』", !!(zhToZh && zhToZh.ok), JSON.stringify(zhToZh));
  check(
    "自动切换到英文目标",
    zhToZh && zhToZh.ok && zhToZh.data && zhToZh.data.target === "en",
    zhToZh && zhToZh.data && zhToZh.data.target
  );

  // 单词 + 目标中文 -> 词典模式且释义已翻译
  mockMode = "normal";
  resetMocks();
  const wordZh = await send({
    type: "YUFAN_TRANSLATE",
    payload: { text: "hello", source: "auto", target: "zh-CN" },
  });
  check("单词走词典模式", wordZh && wordZh.data && wordZh.data.mode === "dictionary", wordZh && wordZh.data && wordZh.data.mode);
  check(
    "translatedMeanings 不为 null（旧实现恒为 null）",
    !!(wordZh && wordZh.data && wordZh.data.translatedMeanings),
    JSON.stringify(wordZh && wordZh.data && wordZh.data.translatedMeanings)
  );
  check(
    "释义已译成目标语言",
    JSON.stringify(wordZh.data.translatedMeanings).includes("[zh-CN]"),
    JSON.stringify(wordZh.data.translatedMeanings)
  );
  // 英文词现在也有例句（来自 Bing sentenceSeg）—— 这是旧实现完全没有的
  check(
    "英文词返回了双语例句（旧实现 examples 恒为空）",
    Array.isArray(wordZh.data.examples) && wordZh.data.examples.length > 0,
    JSON.stringify(wordZh.data.examples && wordZh.data.examples.length)
  );
  check(
    "例句含英文原文 + 中文译文",
    wordZh.data.examples[0] && wordZh.data.examples[0].en && wordZh.data.examples[0].cn,
    JSON.stringify(wordZh.data.examples && wordZh.data.examples[0])
  );
  check(
    "例句已重组为 {ex, tr}（中文目标：ex=中文例句，tr=英文对照）",
    Array.isArray(wordZh.data.translatedExamples) &&
      wordZh.data.translatedExamples.length > 0 &&
      wordZh.data.translatedExamples.every((e) => e.ex && e.tr && /[一-鿿]/.test(e.ex) && /[A-Za-z]/.test(e.tr)),
    JSON.stringify(wordZh.data.translatedExamples && wordZh.data.translatedExamples.map((e) => ({ ex: e.ex, tr: e.tr })))
  );

  // 单词 + 目标繁中 -> 例句译文应翻成繁中（验证 translateExamplesToTarget 真的跑了）
  mockMode = "normal";
  resetMocks();
  const wordTw = await send({
    type: "YUFAN_TRANSLATE",
    payload: { text: "hello", source: "auto", target: "zh-TW" },
  });
  check("zh-TW 目标：释义已翻成繁中", JSON.stringify(wordTw.data.translatedMeanings).includes("[zh-TW]"));
  check(
    "zh-TW 目标：例句 ex 已转繁体、tr 为简体对照（用户要繁体+简体）",
    Array.isArray(wordTw.data.translatedExamples) &&
      wordTw.data.translatedExamples.length > 0 &&
      wordTw.data.translatedExamples.every(
        (e) => /[們個國這對統測試師課們]/.test(e.ex || "") && /[一-鿿]/.test(e.tr || "") && e.ex !== e.tr
      ),
    JSON.stringify(wordTw.data.translatedExamples && wordTw.data.translatedExamples.map((e) => ({ ex: e.ex, tr: e.tr })))
  );

  // 单词 + 目标英文 -> 词典模式，但不做无谓翻译；例句仍取回（看单词本义）
  mockMode = "normal";
  resetMocks();
  const wordEn = await send({
    type: "YUFAN_TRANSLATE",
    payload: { text: "hello", source: "auto", target: "en" },
  });
  check(
    "en->en 时 translatedMeanings 为 null（不该浪费配额）",
    wordEn && wordEn.data && wordEn.data.translatedMeanings === null,
    JSON.stringify(wordEn && wordEn.data && wordEn.data.translatedMeanings)
  );
  check("en->en 仍返回英文释义", wordEn.data.meanings[0].definitions[0].definition === "A greeting.");
  check(
    "en->en 仍取回双语例句（用户看单词本义时也能读到例句）",
    Array.isArray(wordEn.data.examples) && wordEn.data.examples.length > 0,
    JSON.stringify(wordEn.data.examples && wordEn.data.examples.length)
  );
  check(
    "en->en：例句 ex 英文 / tr 中文（看单词本义也能读到中文翻译）",
    Array.isArray(wordEn.data.translatedExamples) &&
      wordEn.data.translatedExamples.length > 0 &&
      wordEn.data.translatedExamples.every((e) => /[A-Za-z]/.test(e.ex || "") && /[一-鿿]/.test(e.tr || "")),
    JSON.stringify(wordEn.data.translatedExamples && wordEn.data.translatedExamples.map((e) => ({ ex: e.ex, tr: e.tr })))
  );

  // 中文词 + 目标英文 -> 例句 ex 应为英文、tr 应为中文翻译（投诉1：例句没有中文翻译）
  mockMode = "normal";
  resetMocks();
  const wordCn2En = await send({
    type: "YUFAN_TRANSLATE",
    payload: { text: "测试", source: "auto", target: "en" },
  });
  check(
    "中文->英文：例句 ex 是英文、tr 是中文翻译",
    Array.isArray(wordCn2En.data.translatedExamples) &&
      wordCn2En.data.translatedExamples.length > 0 &&
      wordCn2En.data.translatedExamples.every((e) => /[A-Za-z]/.test(e.ex || "") && /[一-鿿]/.test(e.tr || "")),
    JSON.stringify(wordCn2En.data.translatedExamples && wordCn2En.data.translatedExamples.map((e) => ({ ex: e.ex, tr: e.tr })))
  );

  // 单词语言保护：英文词选目标=英文，不应被强制翻成中文
  check(
    "英文词 + 目标英文：target 保持 en（不被语言保护翻转成 zh-CN）",
    wordEn && wordEn.data && wordEn.data.target === "en",
    wordEn && wordEn.data && wordEn.data.target
  );

  // 英文词 + Free Dictionary 未收录/不可达 -> 降级 Bing 词典（仍有释义+例句，不掉到 MyMemory）
  mockMode = "normal";
  resetMocks();
  const wordBingFb = await send({
    type: "YUFAN_TRANSLATE",
    payload: { text: "check", source: "auto", target: "zh-CN" },
  });
  check(
    "Free Dictionary 未命中：降级 Bing 词典（dictionary 模式 + Bing Dict）",
    wordBingFb && wordBingFb.data && wordBingFb.data.mode === "dictionary" && wordBingFb.data.provider === "Bing Dict",
    JSON.stringify(wordBingFb && wordBingFb.data && { mode: wordBingFb.data.mode, provider: wordBingFb.data.provider })
  );
  check(
    "Bing 降级：返回了双语例句",
    Array.isArray(wordBingFb.data.examples) && wordBingFb.data.examples.length > 0,
    JSON.stringify(wordBingFb.data.examples && wordBingFb.data.examples.length)
  );

  // 整页翻译批量接口
  mockMode = "normal";
  resetMocks();
  const batch = await send({
    type: "YUFAN_TRANSLATE_BATCH",
    payload: { texts: ["Hello world", "Sign in", "Home"], source: "auto", target: "zh-CN" },
  });
  check("批量接口返回 3 条结果", batch && batch.data && batch.data.results.length === 3, JSON.stringify(batch && batch.data));
  check(
    "批量结果是译文而非英文释义",
    batch.data.results[0] === "[zh-CN] Hello world",
    JSON.stringify(batch.data.results)
  );
  check(
    "页面上的单词没有被塞进词典",
    batch.data.results[1] === "[zh-CN] Sign in",
    batch.data.results[1]
  );

  // 整页翻译：中文页 + 目标简中 -> 不应被翻转成英文（用户要"只翻成简体中文"）
  mockMode = "normal";
  resetMocks();
  const batchZh = await send({
    type: "YUFAN_TRANSLATE_BATCH",
    payload: { texts: ["你好世界", "Hello world"], source: "auto", target: "zh-CN" },
  });
  check(
    "整页翻译中文页：target 不被翻转成英文",
    batchZh && batchZh.data && batchZh.data.target === "zh-CN",
    batchZh && batchZh.data && batchZh.data.target
  );

  // 整页翻译：英文为主混入少量中文 -> 英文条目仍被翻译成中文
  // （修复前：sample 含 CJK 被 detectLang 判成 zh-CN=target，mmSource===mmTarget 触发 noop，整批回填原文）
  mockMode = "normal";
  resetMocks();
  const batchMixed = await send({
    type: "YUFAN_TRANSLATE_BATCH",
    payload: { texts: ["Hello world", "Sign in", "你好", "Welcome home"], source: "auto", target: "zh-CN" },
  });
  check(
    "英文为主混入中文：英文条目被翻译（非整批 noop 回填原文）",
    batchMixed && batchMixed.data && batchMixed.data.results[0] === "[zh-CN] Hello world",
    JSON.stringify(batchMixed && batchMixed.data && batchMixed.data.results)
  );

  // 批量接口在配额耗尽时也必须 ok:true + quotaExhausted 标记（而不是 ok:false），
  // 让 content 能拿到回填结果并给用户明确提示
  mockMode = "quota";
  resetMocks();
  const batchQuota = await send({
    type: "YUFAN_TRANSLATE_BATCH",
    payload: { texts: ["Hello world", "Sign in"], source: "auto", target: "zh-CN" },
  });
  check(
    "批量接口配额耗尽仍返回 ok:true（部分结果可用）",
    batchQuota && batchQuota.ok === true && Array.isArray(batchQuota.data.results),
    JSON.stringify(batchQuota).slice(0, 160)
  );
  check(
    "批量接口透传 quotaExhausted 标记",
    batchQuota && batchQuota.data && batchQuota.data.quotaExhausted === true,
    JSON.stringify(batchQuota && batchQuota.data && batchQuota.data.quotaExhausted)
  );
  check(
    "批量接口透传错误文案",
    batchQuota && batchQuota.data && /额度/.test(batchQuota.data.error || ""),
    batchQuota && batchQuota.data && batchQuota.data.error
  );

  // 流式回推：带 batchId 的批次必须把分片结果推回发起页（翻译一条显示一条）
  mockMode = "normal";
  resetMocks();
  tabMessages.length = 0;
  const partialMsg = await send(
    {
      type: "YUFAN_TRANSLATE_BATCH",
      payload: {
        texts: ["Hello world", "Sign in", "Home", "About us"],
        source: "auto",
        target: "zh-CN",
        batchId: "stream-1",
      },
    },
    { tab: { id: 42 } }
  );
  check(
    "流式批次仍返回 ok",
    partialMsg && partialMsg.ok === true,
    JSON.stringify(partialMsg).slice(0, 120)
  );
  const pushed = tabMessages.filter((m) => m.msg && m.msg.type === "YUFAN_TRANSLATE_BATCH_PARTIAL");
  check(
    "带 batchId 时向发起 tab 回推",
    pushed.length > 0 && pushed[0].tabId === 42 && pushed[0].msg.batchId === "stream-1",
    JSON.stringify(tabMessages.slice(0, 1))
  );
  check(
    "回推内容带 index/text",
    Array.isArray(pushed[0].msg.items) && pushed[0].msg.items[0].text === "[zh-CN] Hello world",
    JSON.stringify(pushed[0] && pushed[0].msg.items)
  );

  // 老版本 content 不带 batchId：不能回推，也不能报错
  mockMode = "normal";
  resetMocks();
  tabMessages.length = 0;
  await send({
    type: "YUFAN_TRANSLATE_BATCH",
    payload: { texts: ["Hello world"], source: "auto", target: "zh-CN" },
  });
  check(
    "无 batchId 时不回推（兼容老版本且不报错）",
    tabMessages.length === 0,
    JSON.stringify(tabMessages)
  );
  mockMode = "normal";
  resetMocks();

  // ============ 划词释义：音标残留清洗 ============
  // Bing 偶发返回异常 desc（音标段缺逗号/缺右括号）时，旧剥离正则会把 "英[" / "美["
  // 残留进释义。这里对真实 sessions desc 与若干异常 desc 断言"绝无音标残留"。
  section("划词释义：parseBingDesc 音标残留清洗");
  {
    const realDesc =
      "必应词典为您提供sessions的释义，美[ˈseʃ(ə)n]，英['seʃ(ə)n]，n. 环节；阶段；(正式)会议；(法院)开庭； adj. 为录音的歌手或乐队伴奏的； 网络释义： 会期；研讨；会话数； ";
    const r = api.parseBingDesc(realDesc);
    const blob = JSON.stringify(r);
    check(
      "sessions 真实 desc：释义含「环节」",
      blob.includes("环节"),
      blob
    );
    check(
      "sessions 真实 desc：无 英[/美[/拼音[ 残留",
      !blob.includes("英[") && !blob.includes("美[") && !blob.includes("拼音["),
      blob
    );
    check(
      "sessions 真实 desc：音标正确提取",
      r.phonetic === "ˈseʃ(ə)n" || r.phonetic === "'seʃ(ə)n",
      r.phonetic
    );

    // 异常 desc：音标段后缺逗号，旧正则不剥离 -> 释义里会混进 "英[def]n. ..."
    // 这种 desc 已严重畸形（POS 也无法识别），清洗后返回空 meanings，
    // 由 callBingDict 判 DICT_NOT_FOUND 降级到 MyMemory 翻译 —— 宁可翻译也不给垃圾释义。
    const malformed1 = "必应词典为您提供foo的释义，美[abc]英[def]n. 某物; 其它;";
    const r1 = api.parseBingDesc(malformed1);
    const b1 = JSON.stringify(r1);
    check(
      "异常 desc(缺逗号)：无 英[ 残留",
      !b1.includes("英[") && !b1.includes("美["),
      b1
    );
    check(
      "异常 desc(缺逗号)：返回空 meanings（触发降级翻译，不给垃圾释义）",
      Array.isArray(r1.meanings) && r1.meanings.length === 0,
      JSON.stringify(r1.meanings)
    );

    // 真实畸形场景：音标段偶发多一个孤立括号片段，但主体逗号分隔正常
    // —— 这种情况下真实义项必须保留，只清掉残留片段。
    const semiMalformed =
      "必应词典为您提供foo的释义，美[abc]，英[def]，英[，n. 某物；其它；";
    const r1b = api.parseBingDesc(semiMalformed);
    const b1b = JSON.stringify(r1b);
    check(
      "半畸形 desc：无 英[ 残留",
      !b1b.includes("英[") && !b1b.includes("美["),
      b1b
    );
    check(
      "半畸形 desc：真实义项「某物」保留",
      b1b.includes("某物"),
      b1b
    );

    // 异常 desc：音标段缺右括号
    const malformed2 = "必应词典为您提供bar的释义，美[abc英[defn. 东西; 事物;";
    const r2 = api.parseBingDesc(malformed2);
    const b2 = JSON.stringify(r2);
    check(
      "异常 desc(缺右括号)：无 英[ 残留进释义",
      !b2.includes("英["),
      b2
    );

    // 异常 desc：释义为空时返回空 meanings（不返回空词性块）
    const emptyDesc = "必应词典为您提供baz的释义，美[abc]，英[def]，";
    const r3 = api.parseBingDesc(emptyDesc);
    check(
      "异常 desc(全空释义)：返回空 meanings",
      Array.isArray(r3.meanings) && r3.meanings.length === 0,
      JSON.stringify(r3.meanings)
    );
  }

  // ============ 划词例句：露骨内容过滤 ============
  // Bing 双语例句库会混入性相关例句（如 "sex sessions" / "性爱"），
  // parseBingExamples 在解析阶段直接丢弃，面板永不渲染。
  section("划词例句：isExplicitExample 露骨过滤");
  check(
    "sex sessions + 性爱 -> 判为露骨",
    api.isExplicitExample(
      "I used to find lengthy sex sessions that went on for hours a bit boring.",
      "过去我认为持续几小时的性爱有点令人乏味。"
    ) === true
  );
  check(
    "正常会议例句 -> 不误杀",
    api.isExplicitExample(
      "We had a productive session today.",
      "我们今天开了一个高效的会议。"
    ) === false
  );
  check(
    "Middlesex(子串陷阱) -> 不误杀",
    api.isExplicitExample("He lives in Middlesex county.", "他住在米德尔塞克斯县。") === false
  );
  check(
    "sextant(子串陷阱) -> 不误杀",
    api.isExplicitExample("The captain used a sextant to navigate.", "船长用六分仪导航。") === false
  );
  check(
    "英文 fuck -> 判为露骨",
    api.isExplicitExample("What the fuck is going on.", "到底怎么回事。") === true
  );
  check(
    "英文 shit(脏话) -> 判为劣质",
    api.isExplicitExample("This is a piece of shit.", "这东西真是垃圾。") === true
  );
  check(
    "英文 bullshit(脏话) -> 判为劣质",
    api.isExplicitExample("That's complete bullshit.", "那纯属胡说八道。") === true
  );
  check(
    "中文 婊子(辱骂) -> 判为劣质",
    api.isExplicitExample("He called her a name.", "他骂她婊子。") === true
  );
  check(
    "中文 他妈的(脏话) -> 判为劣质",
    api.isExplicitExample("He was so angry.", "他气得他妈的直跺脚。") === true
  );
  // 子串陷阱：黑名单含 "anal sex"，不能误伤 "analysis" / "analogy"
  check(
    "analysis(子串陷阱) -> 不误杀",
    api.isExplicitExample("The analysis was thorough.", "分析很彻底。") === false
  );
  check(
    "assassin(子串陷阱) -> 不误杀",
    api.isExplicitExample("The assassin fled the scene.", "刺客逃离了现场。") === false
  );
  check(
    "中文 阴道 -> 判为露骨",
    api.isExplicitExample("The doctor explained the procedure.", "医生解释了阴道的检查流程。") === true
  );

  // parseBingExamples 端到端：mock HTML 含一条露骨例句，应被丢弃
  {
    const explicitHtml = `<div id="sentenceSeg">
      <div class="se_li"><div class="sen_en">We had a productive session.</div><div class="sen_cn">我们开了高效的会议。</div></div>
      <div class="se_li"><div class="sen_en">I used to find lengthy sex sessions boring.</div><div class="sen_cn">过去我认为持续几小时的性爱有点令人乏味。</div></div>
      <div class="se_li"><div class="sen_en">The session was recorded.</div><div class="sen_cn">会议被记录下来了。</div></div>
    </div>`;
    const ex = api.parseBingExamples(explicitHtml);
    check(
      "parseBingExamples：露骨例句被丢弃(剩 2 条)",
      Array.isArray(ex) && ex.length === 2,
      JSON.stringify(ex)
    );
    check(
      "parseBingExamples：剩余例句无 sex/性爱",
      !JSON.stringify(ex).includes("sex") && !JSON.stringify(ex).includes("性爱"),
      JSON.stringify(ex)
    );
  }

  // ============ 端到端：sessions 真实样本（音标撇号 + 露骨例句）============
  // 这是用户实际报的 case：划词 "sessions" 显示 "1. 英["（释义残缺）
  // + "sex sessions/性爱"（露骨例句）。两个问题在 callBingDict 端到端一起验证：
  //   - 提取正则按定界符匹配 → 不在 英['seʃ(ə)n] 的撇号处截断 → desc 完整 → 真实义项
  //   - parseBingExamples 过滤 → 露骨例句不进面板
  section("端到端：sessions 真实样本（英['seʃ(ə)n] 撇号 + 露骨例句）");
  {
    resetMocks();
    const dict = await api.callBingDict("sessions", null);
    const blob = JSON.stringify(dict);
    check(
      "callBingDict(sessions)：未抛错且返回 dictionary 模式",
      dict && dict.mode === "dictionary",
      blob.slice(0, 200)
    );
    check(
      "sessions：释义含真实义项「环节」（未被撇号截断成空）",
      blob.includes("环节"),
      blob
    );
    check(
      "sessions：释义无 英[ 残留",
      !blob.includes("英[") && !blob.includes("美["),
      blob
    );
    check(
      "sessions：音标正确提取（非截断的 英[ 片段）",
      typeof dict.phonetic === "string" && dict.phonetic.length > 0 && !dict.phonetic.includes("["),
      dict.phonetic
    );
    check(
      "sessions：例句已过滤露骨内容（无 sex/性爱）",
      !blob.toLowerCase().includes("sex sessions") && !blob.includes("性爱") && !blob.includes("乱交"),
      blob.slice(-300)
    );
    check(
      "sessions：仍返回了非露骨例句",
      Array.isArray(dict.examples) && dict.examples.length > 0,
      JSON.stringify(dict.examples)
    );
  }

  // ============ 持久化缓存：跨 service worker 休眠复用译文 ============
  // MV3 的 SW 空闲 30s 就被杀，内存缓存全丢。没有持久化缓存时，
  // 整页翻译同一个页面两遍 = 烧两遍 MyMemory 日配额（匿名仅 5000 字符/日）。
  section("持久化缓存（跨 SW 休眠复用，省配额）");
  {
    resetMocks();
    mockMode = "normal";
    const first = await api.callMyMemory("persistent cache probe", "en", "zh-CN", null);
    check("首次翻译拿到译文", !!(first && first.translated), JSON.stringify(first));
    const callsAfterFirst = mockCalls.length;

    // 模拟 SW 被浏览器杀掉：内存缓存清空，但持久化副本还在
    api.cache.clear();
    api.inflight.clear();
    const second = await api.callMyMemory("persistent cache probe", "en", "zh-CN", null);
    check(
      "SW 重启后仍命中持久化缓存（译文一致）",
      !!(second && second.translated) && second.translated === first.translated,
      `${first && first.translated} vs ${second && second.translated}`
    );
    check(
      "命中持久化缓存时不再发请求（零配额消耗）",
      mockCalls.length === callsAfterFirst,
      `before=${callsAfterFirst} after=${mockCalls.length}`
    );
    check(
      "持久化缓存真的写进了 storage.local",
      !!(storageData.yufanTLCache && Object.keys(storageData.yufanTLCache).length > 0) ||
        api.persistCache.size > 0,
      `persistCache.size=${api.persistCache.size}`
    );
  }

  // ============ 客户端配额闸门 ============
  // 没有本地记账时，配额耗尽后每个请求都要等服务端回 WARNING 才知道失败，
  // 整页翻译会连着几百次空跑。这里验证本地闸门会提前拦住。
  section("客户端配额记账（提前拦截，不等服务端 429）");
  {
    resetMocks();
    mockMode = "normal";
    api.quotaUsage.start = Date.now();
    api.quotaUsage.chars = 5000; // 匿名上限 5000 字符，直接顶满
    const callsBefore = mockCalls.length;
    let blocked = false;
    let errCode = "";
    try {
      await api.callMyMemory("quota gate probe", "en", "zh-CN", null);
    } catch (e) {
      blocked = true;
      errCode = (e && e.code) || "";
    }
    check("额度用尽时本地直接拦截", blocked);
    check("错误码是 QUOTA_EXHAUSTED（UI 能给出明确提示）", errCode === "QUOTA_EXHAUSTED", errCode);
    check(
      "被拦截时一个请求都没发出去",
      mockCalls.length === callsBefore,
      `before=${callsBefore} after=${mockCalls.length}`
    );

    // 窗口滚动：storage 里 24 小时前记的账应当作废，用户不该被永久锁死。
    // 注意：storage 才是权威来源，所以要改 storageData 而不是内存对象。
    storageData.yufanQuotaUsage = { start: Date.now() - 25 * 60 * 60 * 1000, chars: 9999 };
    api.quotaUsage.loaded = false;
    await api.ensureQuotaUsage();
    check(
      "超过 24 小时窗口后额度重置",
      api.quotaUsage.chars === 0 && api.quotaUsage.start > Date.now() - 60 * 1000,
      `chars=${api.quotaUsage.chars} start=${api.quotaUsage.start}`
    );
  }

  console.log(results.join("\n"));
  console.log(`\n${fail === 0 ? "✅" : "❌"} 通过 ${pass} / 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => {
  console.log(results.join("\n"));
  console.error("\n❌ 测试异常:", e);
  process.exit(1);
});
