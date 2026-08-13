# 语翻 Yufan Translate

> 简约优雅的划词翻译 Chrome 扩展 — 划词即译，整页翻译，动态翻译，支持 14 种语言互译。

## 功能特性

- **划词即译** — 选中任意文字，温柔的翻译按钮浮现于文字下方，轻点即出译文，面板可拖动到任意位置
- **整页翻译** — 右键页面选择「语翻 · 翻译此页面」，自动翻译所有可见文本，动态加载的内容也会持续翻译
- **弹窗翻译** — 点击工具栏图标打开独立翻译窗口，支持源/目标语言切换、一键交换、复制译文（最多 1000 字符）
- **多语互译** — 自动检测源语言，支持简繁中文、英、日、韩、法、德、西、俄、意、葡、阿拉伯、泰、越南共 14 种语言
- **智能同语言保护** — 自动检测文本语种，源语言与目标语言相同时自动切换目标，避免无效请求
- **动态翻译** — 滚动加载、弹窗展开等动态出现的内容也会被持续翻译，无需手动触发，始终保持译文同步
- **开箱即用** — 翻译请求由扩展后台代理转发，不依赖额外网络配置

## 目录结构

```
yufan-translate/
├── extension/          Chrome 扩展源码 (Manifest V3)
│   ├── manifest.json   扩展配置
│   ├── background.js   Service Worker（翻译代理 + 右键菜单）
│   ├── content.js      内容脚本（划词翻译 + 整页翻译）
│   ├── content.css     内容脚本样式
│   ├── popup.html      工具栏弹窗页面
│   ├── popup.js        弹窗翻译逻辑
│   ├── popup.css       弹窗样式
│   ├── config.js       运行时配置（API 端点）
│   └── icons/          图标资源
├── src/                落地页源码 (React + Vite)
│   ├── main.jsx        入口
│   ├── App.jsx         路由
│   ├── pages/Landing.jsx  落地页组件
│   ├── App.css         落地页样式
│   └── index.css       全局样式
├── public/             静态资源
│   ├── logo.svg        品牌 Logo
│   └── extension.zip   构建时自动生成的插件压缩包
├── vite.config.js      Vite 配置（含 extension 打包插件）
├── tailwind.config.js  Tailwind CSS 配置
└── package.json
```

## 安装扩展

### 方式一：下载压缩包

1. 从 [落地页](https://yufan.cgbin.xyz) 或 [GitHub Releases](https://github.com/cgbin24/yufan-translate/releases) 下载 `yufan-translate.zip`
2. 解压压缩包
3. 打开 `chrome://extensions/`
4. 开启右上角「开发者模式」
5. 点击「加载已解压的扩展程序」，选择解压后的 `extension/` 目录

### 方式二：从源码加载

1. 克隆本仓库
2. 直接使用 `extension/` 目录按上述步骤 3-5 加载

## 运行落地页（开发）

```bash
npm install
npm run dev      # 启动开发服务器 http://localhost:5173
```

## 构建落地页

```bash
npm run build    # 构建到 dist/，同时自动打包 extension/ → public/extension.zip
npm run preview  # 预览构建产物
```

> 构建时 `vite.config.js` 中的 `packExtension` 插件会自动将 `extension/` 目录打包为 `public/extension.zip`，落地页的下载按钮直接提供该文件。

## 技术栈

- **扩展**：Chrome Extension Manifest V3、原生 JavaScript
- **落地页**：React 19、Vite 5、Tailwind CSS 3、Framer Motion

