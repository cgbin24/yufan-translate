// 端到端测试：模拟 background.js 的 callDictionary + translateDefinitionsToTarget
// 跑通整个 flow，验证返回结构 + 对齐逻辑
// 跑法（在项目根）： node tests/dict.test.js
//
// 注意：测试文件放在 tests/ 而非 extension/，因为 Chrome MV3 不允许加载
// 以下划线（__）开头的文件，且不希望测试文件污染扩展目录。
const assert = require("node:assert/strict");

const BASE_DICT = "https://api.dictionaryapi.dev/api/v2/entries/en";
const BASE_MM = "https://api.mymemory.translated.net/get";

// 复制 background.js 中的 normalizeMeanings（保持一致）
function normalizeMeanings(rawMeanings, maxPerPOS = 5) {
  return (rawMeanings || []).map((m) => ({
    partOfSpeech: m.partOfSpeech || "",
    definitions: (m.definitions || []).slice(0, maxPerPOS).map((d) => ({
      definition: d.definition || "",
      example: d.example || "",
      synonyms: Array.isArray(d.synonyms) ? d.synonyms.slice(0, 6) : [],
      antonyms: Array.isArray(d.antonyms) ? d.antonyms.slice(0, 6) : [],
    })),
    // 不保留顶层 synonyms/antonyms，因为前端只展示 per-definition
  }));
}

function pickPhonetic(phonetics) {
  if (!Array.isArray(phonetics) || phonetics.length === 0) return { text: "", audio: "" };
  // 优先找同时有 text 和 audio 的项
  const withBoth = phonetics.find((p) => p && p.text && p.audio);
  if (withBoth) return { text: withBoth.text, audio: withBoth.audio };
  const withText = phonetics.find((p) => p && p.text);
  const withAudio = phonetics.find((p) => p && p.audio);
  return {
    text: (withText && withText.text) || "",
    audio: (withAudio && withAudio.audio) || "",
  };
}

// 简化版 callDictionary（只测关键路径）
async function callDictionary(word, signal) {
  const url = `${BASE_DICT}/${encodeURIComponent(word)}`;
  const resp = await fetch(url, { signal, headers: { "User-Agent": "Mozilla/5.0" } });
  if (resp.status === 404) {
    const err = new Error("Dictionary: word not found");
    err.code = "DICT_NOT_FOUND";
    throw err;
  }
  if (!resp.ok) throw new Error(`Dictionary: HTTP ${resp.status}`);
  const arr = await resp.json();
  if (!Array.isArray(arr) || arr.length === 0) {
    const err = new Error("Dictionary: empty response");
    err.code = "DICT_NOT_FOUND";
    throw err;
  }
  const entry = arr[0];
  const phon = pickPhonetic(entry.phonetics);
  return {
    mode: "dictionary",
    provider: "Free Dictionary",
    word: entry.word || word,
    phonetic: phon.text,
    audio: phon.audio,
    detected: "en",
    translated: entry.word || word, // 占位（前端 dictionary 模式不用）
    meanings: normalizeMeanings(entry.meanings),
  };
}

// 简化版 callMyMemory
// 注意：MyMemory 命中每日免费配额后会原样回显输入并嵌入 WARNING 文本，
// 测试层通过 __quotaExhausted 标记让上层做宽松判定（结构对齐仍要正确）。
async function callMyMemory(text, source, target, signal) {
  // 展开 auto：测试用启发式（与 background.js 一致）
  let realSource = source;
  if (!realSource || realSource === "auto") {
    const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    realSource = cjk > 0 ? "zh-CN" : "en";
  }
  const url = `${BASE_MM}?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(`${realSource}|${target}`)}`;
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`MyMemory: HTTP ${resp.status}`);
  const data = await resp.json();
  // MyMemory 配额耗尽：HTTP 200 + responseStatus 429 + 警告文本嵌入 translatedText。
  // 不要按"翻译失败"抛错 —— 上游已知行为，应让上层做宽松判定。
  if (String(data.responseStatus) === "429" || /MYMEMORY WARNING.*USED ALL AVAILABLE FREE TRANSLATIONS/i.test(data.responseData?.translatedText || "")) {
    return {
      translated: data.responseData?.translatedText || "",
      detected: "",
      provider: "MyMemory",
      __quotaExhausted: true,
    };
  }
  if (data.responseStatus && String(data.responseStatus) !== "200") {
    throw new Error(`MyMemory: ${data.responseDetails || data.responseStatus}`);
  }
  const translated = data.responseData?.translatedText || "";
  const quotaExhausted = /MYMEMORY WARNING.*USED ALL AVAILABLE FREE TRANSLATIONS/i.test(translated);
  return {
    translated,
    detected: data.responseData?.match ? "en" : "",
    provider: "MyMemory",
    __quotaExhausted: quotaExhausted,
  };
}

// 完整复刻 background.js 的 translateDefinitionsToTarget（分块版）
// target: 任意 MyMemory 支持的语言代码（zh-CN / ja / ko / fr / de / ...）
async function translateDefinitionsToTarget(meanings, target, signal) {
  const lines = [];
  const refs = [];
  for (let i = 0; i < meanings.length; i++) {
    const m = meanings[i];
    if (m.partOfSpeech) {
      lines.push(`p:${m.partOfSpeech}`);
      refs.push({ kind: "pos", idx: i });
    }
    for (let j = 0; j < m.definitions.length; j++) {
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
  const MAX_BLOCK = 400;
  const blocks = [];
  let curLines = [];
  let curRefs = [];
  let curLen = 0;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    if (line.length >= MAX_BLOCK) {
      if (curLines.length) {
        blocks.push({ lines: curLines, refs: curRefs });
        curLines = [];
        curRefs = [];
        curLen = 0;
      }
      blocks.push({ lines: [line], refs: [refs[k]] });
      continue;
    }
    if (curLen + line.length + (curLines.length ? 1 : 0) > MAX_BLOCK) {
      blocks.push({ lines: curLines, refs: curRefs });
      curLines = [line];
      curRefs = [refs[k]];
      curLen = line.length;
      continue;
    }
    curLines.push(line);
    curRefs.push(refs[k]);
    curLen += line.length + (curLines.length > 1 ? 1 : 0);
  }
  if (curLines.length) blocks.push({ lines: curLines, refs: curRefs });

  const out = JSON.parse(JSON.stringify(meanings));
  // 翻译前先把每个 definition 的原始 example 备份到 exampleOriginal（双语例句支持）
  for (let i = 0; i < out.length; i++) {
    for (let j = 0; j < (out[i].definitions || []).length; j++) {
      const orig = meanings[i].definitions[j] && meanings[i].definitions[j].example;
      out[i].definitions[j].exampleOriginal = orig ? String(orig).trim() : "";
    }
  }
  let quotaExhausted = false;
  for (const block of blocks) {
    const joined = block.lines.join("\n");
    let translated = "";
    try {
      const r = await callMyMemory(joined, "en", target, signal);
      translated = r.translated || "";
      if (r.__quotaExhausted) quotaExhausted = true;
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      continue;
    }
    const translatedLines = String(translated).split(/\r?\n/);
    for (let k = 0; k < block.refs.length; k++) {
      const ref = block.refs[k];
      const tl = translatedLines[k];
      if (tl == null) continue;
      const cleaned = tl.replace(/^[pde][\s]*[:：][\s]*/i, "").trim();
      if (ref.kind === "pos" && out[ref.idx]) {
        out[ref.idx].partOfSpeech = cleaned;
      } else if (ref.kind === "def" && out[ref.idx] && out[ref.idx].definitions[ref.defIdx]) {
        out[ref.idx].definitions[ref.defIdx].definition = cleaned;
      } else if (ref.kind === "ex" && out[ref.idx] && out[ref.idx].definitions[ref.defIdx]) {
        // 译文写入 example，原文已备份到 exampleOriginal
        out[ref.idx].definitions[ref.defIdx].example = cleaned;
      }
    }
  }
  return { meanings: out, __quotaExhausted: quotaExhausted };
}

// 简化版 translateWith（复刻 background.js 的 fallback 行为）
// 同主语言判断：zh/zh-CN/zh-TW 视为 zh
const isZhCode = (code) => String(code || "").toLowerCase().startsWith("zh");
const normalizeLang = (code) => {
  const c = String(code || "").toLowerCase();
  if (c.startsWith("zh")) return "zh";
  if (c.startsWith("en")) return "en";
  return c.split("-")[0] || c;
};
async function translateWith(text, source, target, signal) {
  const isWord = /^[A-Za-z][A-Za-z'\-\.]*[A-Za-z']?$/.test(text) && text.length <= 30;
  if (isWord) {
    try {
      const dict = await callDictionary(text, signal);
      // 目标 != 英文：把整个释义列表整体翻成目标语言
      // 目标 == 英文：直接返回英文释义
      if (normalizeLang(target) !== "en") {
        const result = await translateDefinitionsToTarget(dict.meanings, target, signal);
        return { ...dict, translatedMeanings: result.meanings, target, mode: "dictionary", __quotaExhausted: result.__quotaExhausted };
      }
      return { ...dict, target, mode: "dictionary" };
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      // 词典失败，fallback 到翻译
    }
  }
  // resolveTarget：source 非 auto 且与 target 同主语言 -> 切换
  let effectiveTarget = target;
  if (source && source !== "auto" && normalizeLang(source) === normalizeLang(target)) {
    effectiveTarget = isZhCode(source) ? "en" : "zh-CN";
  }
  const r = await callMyMemory(text, source, effectiveTarget, signal);
  return { ...r, target: effectiveTarget, mode: "translation" };
}

async function testResolveTargetRespectsUserChoice() {
  // 回归测试：source=auto + target=ko 时，effectiveTarget 必须仍是 ko，
  // 绝不能因为某些 fallback 启发式被改回 zh-CN
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30000);
  try {
    // contributor 是英文单词 -> 走词典分支
    const r = await translateWith("contributor", "auto", "ko", ac.signal);
    assert.equal(r.target, "ko", `target must stay ko, got ${r.target}`);
    assert.equal(r.mode, "dictionary", "contributor should be dictionary mode");
    // 验证：用了用户选的韩语，而不是被静默改回中文
    assert.ok(r.translatedMeanings, "should have translatedMeanings");
    if (r.__quotaExhausted) {
      console.log("⚠ testResolveTargetRespectsUserChoice: MyMemory quota exhausted, skipping script check");
    } else {
      const flat = JSON.stringify(r.translatedMeanings);
      assert.ok(
        /[\uac00-\ud7af]/.test(flat),
        `dictionary meanings should be translated to Korean, got: ${flat.slice(0, 200)}`
      );
    }
    console.log("✓ testResolveTargetRespectsUserChoice: target=ko honored");
  } finally {
    clearTimeout(t);
  }
}

async function testFallback() {
  // 用一个怪词触发词典失败 -> 应该 fallback 到 MyMemory
  // timeout 放宽到 30s，匹配 background.js 的 REQUEST_TIMEOUT_MS（25s）+ 缓冲
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30000);
  try {
    const r = await translateWith("qqqzzznotrealword", "en", "zh-CN", ac.signal);
    // 不管词典成功/失败，最终必须返回 mode=translation 或 mode=dictionary
    assert.ok(["translation", "dictionary"].includes(r.mode), `bad mode: ${r.mode}`);
    if (r.mode === "translation") {
      // fallback 路径：translated 应包含 MyMemory 的结果
      assert.ok(r.translated.length > 0, "fallback translated should not be empty");
      console.log("✓ testFallback: fallback path -> MyMemory:", r.translated.slice(0, 60));
    } else {
      console.log("✓ testFallback: 词典居然有结果", r.word);
    }
  } finally {
    clearTimeout(t);
  }
}

// ============= Tests =============
async function testHello() {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15000);
  try {
    const dict = await callDictionary("hello", ac.signal);
    assert.equal(dict.mode, "dictionary");
    assert.equal(dict.word, "hello");
    assert.ok(dict.phonetic.length > 0, "should have phonetic");
    assert.ok(dict.audio.length > 0, "should have audio");
    assert.ok(dict.meanings.length > 0, "should have at least one meaning");
    const allDefs = dict.meanings.flatMap((m) => m.definitions);
    assert.ok(allDefs.length > 0, "should have at least one definition");
    console.log("✓ testHello: dict =", {
      word: dict.word,
      phonetic: dict.phonetic,
      audio: dict.audio,
      meaningsCount: dict.meanings.length,
      defsCount: allDefs.length,
    });
    return dict;
  } finally {
    clearTimeout(t);
  }
}

async function testTranslateToTarget(target, expectScript) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30000);
  try {
    const dict = await callDictionary("hello", ac.signal);
    const result = await translateDefinitionsToTarget(dict.meanings, target, ac.signal);
    const translated = result.meanings;
    assert.ok(translated, "translated should not be null");
    assert.equal(translated.length, dict.meanings.length, "POS count must match");
    for (let i = 0; i < translated.length; i++) {
      const orig = dict.meanings[i];
      const tr = translated[i];
      assert.equal(tr.definitions.length, orig.definitions.length, `def count for POS[${i}]`);
      for (let j = 0; j < tr.definitions.length; j++) {
        assert.ok(tr.definitions[j].definition.length > 0, `def[${i}][${j}] not empty`);
        const origEx = orig.definitions[j].example;
        if (origEx && origEx.trim()) {
          assert.equal(typeof tr.definitions[j].exampleOriginal, "string", `def[${i}][${j}] should have exampleOriginal`);
          assert.ok(tr.definitions[j].exampleOriginal.length > 0, `def[${i}][${j}] exampleOriginal should be preserved`);
          assert.equal(tr.definitions[j].exampleOriginal, String(origEx).trim(), `def[${i}][${j}] exampleOriginal matches original`);
        }
      }
      assert.ok(tr.partOfSpeech.length > 0, `POS[${i}] not empty after translation`);
    }
    // 配额耗尽时 MyMemory 会回显原文（含 WARNING 文本）—— 上游已知行为，
    // 跳过 script 检查，仅保留结构对齐校验。
    if (result.__quotaExhausted) {
      console.log(`⚠ testTranslateToTarget(${target}): MyMemory quota exhausted, skipping script check`);
    } else {
      const flat = JSON.stringify(translated);
      assert.ok(
        expectScript.test(flat),
        `expected target script in translation, got: ${flat.slice(0, 200)}`
      );
    }
    console.log(`✓ testTranslateToTarget(${target}): translated[0] =`, {
      pos: translated[0].partOfSpeech,
      def0: translated[0].definitions[0]?.definition,
    });
  } finally {
    clearTimeout(t);
  }
}

async function testNotFound() {
  const ac = new AbortController();
  // 20s：词典上游偶发 5xx + 网络抖动
  const t = setTimeout(() => ac.abort(), 20000);
  try {
    // 用一个明显不存在的词（API 返回 404）
    // 避免怪字符以免触发上游反爬/限流
    await callDictionary("qqqzzznotrealword", ac.signal);
    assert.fail("should have thrown");
  } catch (err) {
    // 允许 404 (DICT_NOT_FOUND) 或 5xx（上游限流），关键是抛错
    // background.js 的 translateWith 会 fallback 到 MyMemory
    assert.ok(
      err.code === "DICT_NOT_FOUND" || /HTTP 5/.test(err.message),
      `expected DICT_NOT_FOUND or HTTP 5xx, got: ${err.message}`
    );
    console.log("✓ testNotFound: error path works (code=" + (err.code || err.message) + ")");
  } finally {
    clearTimeout(t);
  }
}

async function testNormalSentence() {
  // 句子走 MyMemory（不走词典）
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await callMyMemory("How are you?", "auto", "zh-CN", ac.signal);
    assert.ok(r.translated.length > 0, "translation should not be empty");
    if (r.__quotaExhausted) {
      console.log("⚠ testNormalSentence: MyMemory quota exhausted, skipping script check");
    } else {
      assert.ok(/[\u4e00-\u9fff]/.test(r.translated), "should contain Chinese");
    }
    console.log("✓ testNormalSentence:", r.translated.slice(0, 80));
  } finally {
    clearTimeout(t);
  }
}

(async () => {
  console.log("Running dictionary E2E tests...");
  try {
    await testHello();
    // 目标 = 简体中文（中文）
    await testTranslateToTarget("zh-CN", /[\u4e00-\u9fff]/);
    // 目标 = 韩语（关键场景：用户手动选韩语后必须真的翻成韩语）
    await testTranslateToTarget("ko", /[\uac00-\ud7af]/);
    await testNotFound();
    await testNormalSentence();
    await testFallback();
    await testResolveTargetRespectsUserChoice();
    console.log("\n✅ All tests passed");
  } catch (e) {
    console.error("\n❌ Test failed:", e.message);
    process.exit(1);
  }
})();
