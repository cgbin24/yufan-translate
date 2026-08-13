import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Download,
  Sparkles,
  MousePointerClick,
  Languages,
  RefreshCw,
  Check,
  Github,
  FileText,
  Globe,
  Zap,
} from "lucide-react";

const easeSoft = [0.25, 1, 0.5, 1];

// 插件压缩包下载地址（构建时由 vite 打包 extension/ → public/extension.zip）
const EXTENSION_ZIP = "/extension.zip";
// GitHub 仓库地址
const GITHUB_URL = "https://github.com/cgbin24/yufan-translate";

// ---------- Blob illustration ----------
const HeroArt = () => (
  <motion.div
    aria-hidden
    className="relative w-[520px] h-[520px] max-w-full"
    initial={{ opacity: 0, scale: 0.94 }}
    animate={{ opacity: 1, scale: 1 }}
    transition={{ duration: 1.2, ease: easeSoft }}
  >
    <motion.div
      className="absolute inset-0"
      animate={{ rotate: [0, 6, 0] }}
      transition={{ duration: 22, repeat: Infinity, ease: "easeInOut" }}
    >
      <svg viewBox="0 0 520 520" className="w-full h-full">
        <defs>
          <radialGradient id="g1" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#c8d8cf" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#9eb3a6" stopOpacity="0.0" />
          </radialGradient>
          <radialGradient id="g2" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#c8d8ea" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#a2bce0" stopOpacity="0.0" />
          </radialGradient>
        </defs>
        <circle cx="220" cy="230" r="220" fill="url(#g1)" />
        <circle cx="330" cy="300" r="200" fill="url(#g2)" />
      </svg>
    </motion.div>

    {/* Floating cards */}
    <motion.div
      className="absolute left-6 top-10 select-none"
      initial={{ y: 12, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ delay: 0.4, duration: 0.8, ease: easeSoft }}
    >
      <div className="rounded-2xl bg-white/80 backdrop-blur-xl px-5 py-3 shadow-[0_10px_40px_rgba(58,78,68,0.14)] border border-white/70">
        <div className="text-[11px] tracking-[0.14em] uppercase text-[#8fa198]">Selected</div>
        <div className="mt-1 serif text-lg text-[#2a312d]">&ldquo;An elegant translation&rdquo;</div>
      </div>
    </motion.div>

    <motion.div
      className="absolute right-4 top-40 select-none"
      initial={{ y: 12, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ delay: 0.7, duration: 0.8, ease: easeSoft }}
    >
      <div className="inline-flex items-center gap-2 rounded-full px-4 py-2 bg-white/85 border border-[#e6e9e2] shadow-[0_10px_30px_rgba(74,96,84,0.18)]">
        {/* <Languages className="w-4 h-4 text-[#6d8a7b]" /> */}
        <img src="/logo.svg" alt="语翻" className="w-4 h-4 rounded-lg" />
        <span className="text-sm text-[#2a312d]">翻译</span>
      </div>
    </motion.div>

    <motion.div
      className="absolute left-4 bottom-8 select-none"
      initial={{ y: 12, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ delay: 1.0, duration: 0.8, ease: easeSoft }}
    >
      <div className="rounded-2xl bg-white/85 backdrop-blur-xl px-5 py-4 shadow-[0_14px_40px_rgba(58,78,68,0.14)] border border-white/70 w-[300px]">
        <div className="text-[11px] uppercase tracking-[0.14em] text-[#8fa198]">译文 · Result</div>
        <div className="serif mt-1 text-[22px] leading-snug text-[#2a312d]">
          一次优雅的翻译体验
        </div>
        <div className="mt-2 flex items-center gap-2 text-xs text-[#8fa198]">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#9eb3a6]" />
          <span>自动识别 · 开箱即用</span>
        </div>
      </div>
    </motion.div>
  </motion.div>
);

// ---------- Download success toast ----------
const DownloadToast = ({ show }) => (
  <AnimatePresence>
    {show && (
      <motion.div
        className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 20 }}
        transition={{ duration: 0.35, ease: easeSoft }}
      >
        <div className="flex items-center gap-2.5 rounded-full bg-[#2a312d] text-white px-6 py-3 shadow-[0_16px_40px_rgba(42,49,45,0.35)]">
          <Check className="w-4 h-4 text-[#9eb3a6]" />
          <span className="text-sm">下载已开始，解压后加载至 Chrome 即可使用</span>
        </div>
      </motion.div>
    )}
  </AnimatePresence>
);

// ---------- Feature card ----------
const Feature = ({ icon: Icon, title, text, delay = 0 }) => (
  <motion.div
    className="relative rounded-3xl bg-white/70 backdrop-blur-md border border-[#eaece8] p-6 md:p-7 shadow-[0_2px_0_rgba(0,0,0,0.02)]"
    initial={{ opacity: 0, y: 14 }}
    whileInView={{ opacity: 1, y: 0 }}
    viewport={{ once: true, margin: "-40px" }}
    transition={{ duration: 0.6, ease: easeSoft, delay }}
    data-testid={`feature-${title}`}
  >
    <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-[#f0f4ee] text-[#6d8a7b]">
      <Icon className="w-5 h-5" />
    </div>
    <h3 className="serif mt-4 text-xl text-[#2a312d]">{title}</h3>
    <p className="mt-2 text-[14px] leading-relaxed text-[#6b7c73]">{text}</p>
  </motion.div>
);

// ---------- Main Landing ----------
export default function Landing() {
  const [downloaded, setDownloaded] = useState(false);

  const handleDownload = () => {
    const a = document.createElement("a");
    a.href = EXTENSION_ZIP;
    a.download = "yufan-translate.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setDownloaded(true);
    setTimeout(() => setDownloaded(false), 3500);
  };

  return (
    <>
      <div className="grain" />
      <div className="relative z-10">
        {/* Nav */}
        <nav className="max-w-6xl mx-auto px-6 md:px-10 pt-8 flex items-center justify-between">
          <div className="flex items-center gap-2.5" data-testid="brand-logo">
            <img
              src="/logo.svg"
              alt="语翻"
              className="w-8 h-8 rounded-lg"
            />
            <div className="leading-none">
              <div className="serif text-[18px] font-semibold text-[#2a312d]">语翻</div>
              <div className="text-[10px] tracking-[0.24em] uppercase text-[#8fa198]">Yufan Translate</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center w-9 h-9 rounded-full border border-[#e6e9e2] bg-white/70 text-[#3a4a44] hover:border-[#9eb3a6]/60 hover:bg-[#f4f7f2] transition-colors"
              aria-label="GitHub 仓库"
              data-testid="github-link"
            >
              <Github className="w-4 h-4" />
            </a>
            <button
              onClick={handleDownload}
              className="hidden md:inline-flex items-center gap-1.5 text-[13px] px-4 py-2 rounded-full border border-[#e6e9e2] bg-white/70 text-[#3a4a44] hover:border-[#9eb3a6]/60 hover:bg-[#f4f7f2] transition-colors"
              data-testid="nav-download"
            >
              <Download className="w-3.5 h-3.5" /> 免费下载
            </button>
          </div>
        </nav>

        {/* Hero */}
        <header className="max-w-6xl mx-auto px-6 md:px-10 pt-16 md:pt-24 pb-16 md:pb-24 grid md:grid-cols-2 gap-10 md:gap-8 items-center">
          <div>
            <motion.div
              className="inline-flex items-center gap-2 text-[11px] tracking-[0.18em] uppercase text-[#6d8a7b] px-3 py-1 rounded-full border border-[#dfe6df] bg-[#f4f7f2]/60"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: easeSoft }}
            >
              <Sparkles className="w-3.5 h-3.5" />
              划词即译 · 整页翻译 · 动态翻译
            </motion.div>

            <motion.h1
              className="serif mt-5 text-[44px] md:text-[64px] leading-[1.05] tracking-tight text-[#2a312d]"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, ease: easeSoft, delay: 0.1 }}
            >
              为阅读而生的<br />
              <span className="italic" style={{ color: "#6d8a7b" }}>翻译体验</span>
            </motion.h1>

            <motion.p
              className="mt-6 max-w-[520px] text-[16px] md:text-[17px] leading-relaxed text-[#4a5951]"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, ease: easeSoft, delay: 0.2 }}
            >
              选中任意文字，一枚温柔的按钮悄然浮现于文字之下，轻点即译。
              也可右键整页翻译，自动识别源语言，14 种语言互译，
              动态加载的内容也会持续翻译，开箱即用。
            </motion.p>

            <motion.div
              className="mt-9 flex flex-wrap items-center gap-4"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, ease: easeSoft, delay: 0.3 }}
            >
              <button
                onClick={handleDownload}
                className="group inline-flex items-center gap-2 rounded-full px-7 py-3.5 text-white text-[15px] font-medium tracking-wide bg-gradient-to-b from-[#9eb3a6] to-[#8a9f92] hover:brightness-105 shadow-[0_16px_36px_rgba(138,159,146,0.4)] transition-[filter,transform] active:translate-y-[1px]"
                data-testid="hero-download-btn"
              >
                <Download className="w-4 h-4" />
                免费下载
              </button>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-[13px] text-[#6b7c73] hover:text-[#3a4a44] transition-colors"
              >
                <Github className="w-4 h-4" />
                查看源码
              </a>
            </motion.div>

            <motion.div
              className="mt-14 grid grid-cols-3 gap-4 max-w-[520px]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.9, ease: easeSoft, delay: 0.6 }}
            >
              {[
                ["14", "语言互译"],
                ["≤ 1s", "响应速度"],
                ["0", "遮挡感"],
              ].map(([n, t]) => (
                <div key={t}>
                  <div className="serif text-3xl text-[#2a312d]">{n}</div>
                  <div className="text-[11px] tracking-[0.12em] uppercase text-[#8fa198] mt-1">{t}</div>
                </div>
              ))}
            </motion.div>
          </div>

          <div className="flex justify-center md:justify-end">
            <HeroArt />
          </div>
        </header>

        {/* Features */}
        <section className="max-w-6xl mx-auto px-6 md:px-10 pb-24 md:pb-32">
          <div className="max-w-2xl">
            <div className="text-[11px] tracking-[0.18em] uppercase text-[#6d8a7b]">Why Yufan</div>
            <h2 className="serif mt-3 text-3xl md:text-4xl text-[#2a312d]">
              专注于阅读者的<span className="italic" style={{ color: "#6d8a7b" }}>细节</span>
            </h2>
          </div>
          <div className="mt-10 grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-6">
            <Feature
              icon={MousePointerClick}
              title="划词即译"
              text="选中文字后，温柔的翻译按钮出现在下方，绝不遮挡内容和视窗。轻点即出译文，可拖动面板到任意位置。"
              delay={0}
            />
            <Feature
              icon={FileText}
              title="整页翻译"
              text="右键页面任意位置选择「翻译此页面」，自动翻译所有可见文本，动态加载的内容也会持续翻译。"
              delay={0.08}
            />
            <Feature
              icon={Languages}
              title="多语互译"
              text="自动检测源语言，支持简繁中文、英、日、韩、法、德、西、俄、意、葡、阿拉伯、泰、越南共 14 种语言。"
              delay={0.16}
            />
          </div>

          {/* 第二行特性 */}
          <div className="mt-5 md:mt-6 grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-6">
            <Feature
              icon={Globe}
              title="弹窗翻译"
              text="点击工具栏图标打开独立翻译窗口，支持源/目标语言切换、一键交换、复制译文，最多 1000 字符。"
              delay={0}
            />
            <Feature
              icon={Zap}
              title="智能同语言保护"
              text="自动检测文本语种，源语言与目标语言相同时自动切换目标，避免「中文翻中文」的无效请求。"
              delay={0.08}
            />
            <Feature
              icon={RefreshCw}
              title="动态翻译"
              text="滚动加载、弹窗展开等动态出现的内容也会被持续翻译，无需手动触发，始终保持译文同步。"
              delay={0.16}
            />
          </div>
        </section>

        {/* CTA banner */}
        <section id="download" className="max-w-5xl mx-auto px-6 md:px-10 pb-28">
          <motion.div
            className="relative overflow-hidden rounded-[36px] border border-[#e0e4de] bg-white/70 backdrop-blur-xl p-10 md:p-14"
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-40px" }}
            transition={{ duration: 0.7, ease: easeSoft }}
          >
            <div className="absolute -top-16 -right-16 w-64 h-64 rounded-full bg-[#a2bce0]/25 blur-3xl" />
            <div className="absolute -bottom-16 -left-16 w-72 h-72 rounded-full bg-[#9eb3a6]/25 blur-3xl" />
            <div className="relative flex flex-col md:flex-row items-start md:items-center gap-6 md:gap-10 justify-between">
              <div>
                <div className="text-[11px] tracking-[0.18em] uppercase text-[#6d8a7b]">Download</div>
                <h3 className="serif mt-2 text-3xl md:text-[36px] leading-tight text-[#2a312d]">
                  轻装上阵，<span className="italic" style={{ color: "#6d8a7b" }}>随选随译</span>
                </h3>
                <p className="mt-3 text-[14.5px] text-[#4a5951] max-w-[520px]">
                  点击按钮直接下载插件压缩包，解压后在 Chrome 扩展页开启「开发者模式」→
                  选择「加载已解压的扩展程序」→ 选择 <span className="font-mono text-[13px]">extension/</span> 目录即可。
                </p>
              </div>
              <button
                onClick={handleDownload}
                className="inline-flex items-center gap-2 rounded-full px-7 py-3.5 text-white text-[15px] font-medium tracking-wide bg-gradient-to-b from-[#9eb3a6] to-[#8a9f92] hover:brightness-105 shadow-[0_16px_36px_rgba(138,159,146,0.4)] transition-[filter,transform] active:translate-y-[1px]"
                data-testid="cta-download-btn"
              >
                <Download className="w-4 h-4" />
                免费下载
              </button>
            </div>
          </motion.div>
        </section>

        <footer className="pb-10 text-center text-[12px] text-[#a3b0aa] tracking-[0.06em]">
          © 语翻 · Yufan Translate — 简约、柔和、专注于每一次阅读
        </footer>
      </div>

      <DownloadToast show={downloaded} />
    </>
  );
}
