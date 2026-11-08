// Runtime configuration.
// 默认翻译 API 已迁移到 MyMemory（https://api.mymemory.translated.net），
// 端点常量与协议转换逻辑都在 background.js（service worker）中。
// 端点无需 API key；用户可在 popup 的"高级设置"中填入自定义 endpoint。
// 旧版本的 yufanApiBase 字段已弃用，storage key 改为 yufanApiEndpoint。
// 此文件保留用于兼容性，不再包含任何运行时逻辑。
