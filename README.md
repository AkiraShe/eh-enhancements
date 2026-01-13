# eh-enhancements

E-Hentai/ExHentai 增强脚本集合 - 为E站提供更强大的功能和更好的用户体验。

本项目的功能和修改为vibe coding实现。

## 📦 包含的脚本

### 1. **EhSearchEnhancer** - 搜索页增强脚本
在E-Hentai搜索页提供强大的多选、批量操作、磁链显示等功能。

- ✅ 多选画廊（单选、Shift范围选、条件过滤）
- ✅ 批量操作（刷新、复制链接、发送下载、标记/忽略）
- ✅ 磁力链接显示和快速复制
- ✅ 种子链接和磁力链接双通道
- ✅ 归档查询和下载功能
- ✅ 自动刷新和鼠标悬停刷新
- ✅ 完整的快捷菜单和操作系统

📖 [详细说明](./scripts/search-enhancer/README.md)

### 2. **AriaEh** - Aria2下载助手（修改版）
与EhSearchEnhancer深度适配的Aria2下载管理脚本。

- ✅ 支持磁链、种链下载、归档下载。修复了归档下载、有时文件名获取失败的问题。
- ✅ 种子信息快速访问
- ✅ 归档下载支持（消耗GP）
- ✅ 修复了某些情况下获取不到压缩包名称的问题

📖 [详细说明](./scripts/aria-helper/README.md)

### 3. **ExHentai Lanraragi Checker** - Lanraragi检查脚本（修改版）
自动检查E-Hentai/ExHentai上的画廊是否已在您的Lanraragi库中。

- ✅ 自动检查 - 浏览时自动检查每个画廊
- ✅ 状态标记 - 绿色✔已收集、紫色！相似作品、红色❓出错
- ✅ 缓存优化 - 减少重复查询
- ✅ 简繁体转换 - 提升跨地区搜索准确率
- ✅ 深度搜索 - 通过作者+标题搜索相似作品

📖 [详细说明](./scripts/lanraragi-checker/README.md)

## 🚀 快速开始

### 安装方法

1. **通过Tampermonkey/Greasemonkey安装**
   - 打开 [Tampermonkey 扩展](https://www.tampermonkey.net/)
   - 点击"创建新脚本"或"新建脚本"
   - 复制对应脚本的代码粘贴进去
   - 保存并启用

2. **或者通过脚本站点**
   - 直接访问 GreasyFork/Sleazy Fork 上的脚本页面（待上传）

### 系统要求

- 浏览器：Chrome、Firefox、Edge 等（需安装Tampermonkey或Greasemonkey）
- E-Hentai/ExHentai 账号（可选，某些功能需要登录）
- 支持的页面：E-Hentai 搜索页（缩略图模式）、收藏页、主页、详情页

## 📖 使用指南

### EhSearchEnhancer 主要功能

#### 选择操作
- **单选**：点击复选框勾选单个画廊
- **范围选**：Shift + 点击进行范围选择
- **条件过滤**：按已下载、已忽略、无种子、种子过时等条件过滤
- **全选/反选**：右键菜单中的快捷操作

#### 批量操作
在任意复选框上**右键**打开菜单，支持：
- 🔃 刷新/强制刷新
- 🧲 复制磁链/种链
- 📤 发送下载（支持Aria2和 DM）
- 📌 标记/忽略画廊
- 📋 查询归档信息
- 💾 导出/导入选择

或点击页面右上角的"其它功能"菜单访问这些操作

#### 单画廊操作
在画廊行右侧的 ⚙️ 齿轮菜单中：
- 📌 标记/取消标记
- 🚫 忽略/取消忽略
- 🔃 刷新/强制刷新
- 📤 发送到 DM（消耗GP）

#### 种子菜单
在种子信息上**右键**打开菜单：
- 📌 标记/取消标记
- 🧲 复制磁链
- 🌱 复制种链
- ⬇️ 下载种子
- 🚫 忽略

## ⚙️ 配置说明

### EhSearchEnhancer 设置

在设置菜单中可调整：
- 🔄 自动刷新 - 打开页面时自动获取种子信息
- 👆 鼠标悬停刷新 - 悬停时自动刷新画廊
- 🔧 种子抓取设置 - 配置并发数、缓存超时等
- 📊 最近下载记录上限 - 最多可保存999个批次记录
- 🔌  DM 端口 - 配置本地下载管理器端口

### AriaEh 配置

详见 [AriaEh README](./scripts/aria-helper/README.md)

## ⚠️ 注意事项

- **EhSearchEnhancer 仅适配E-Hentai缩略图（Thumb）模式**
- 某些功能需要E-Hentai账号登录
- AB DM（归档下载）功能需要消耗GP，请谨慎使用
- 建议在现代浏览器上使用，以获得最佳体验

## 🔗 相关项目

本项目参考了以下优秀的开源脚本：

- [E-Hentai & ExHentai Fade or hide viewed galleries](https://sleazyfork.org/en/scripts/36314-e-hentai-exhentai-fade-or-hide-viewed-galleries) - 隐藏已查看画廊的实现
- [EH-UserScripts by SchneeHertz](https://github.com/SchneeHertz/EH-UserScripts) - 种子信息菜单布局参考
- [Putarku/LANraragi-scripts](https://github.com/Putarku/LANraragi-scripts) - ExHentai Lanraragi Checker 原版脚本

## 📝 开源协议

本项目采用 **MIT License** - 详见 [LICENSE](./LICENSE)

## 反馈和建议
欢迎通过以下方式提供反馈：
- **提交Issue** - 报告bug或提出功能建议

## 📄 更新日志

详见各脚本的 [CHANGELOG](./CHANGELOG.md)

---

**最后更新**：2026-01-12
