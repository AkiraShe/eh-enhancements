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
- ✅ 状态标记 - 彩色图标快速识别：
  - `✓` 绿色 = 已在库中
  - `!` 蓝色 = 找到匹配作品
  - `?N` 紫色 = 发现N个可能匹配
  - `⚠` 红色 = 检查出错
- ✅ 详情预览 - 点击标记查看作品详情（封面、页数、标签等）
- ✅ 缓存优化 - 减少重复查询
- ✅ 简繁体转换 - 提升跨地区搜索准确率

📖 [详细说明](./scripts/lanraragi-checker/README.md)

## 🚀 快速开始

### 安装方法

详见 [脚本安装指南](./docs/installation-guide.md)

快速链接：
- [EhSearchEnhancer](./scripts/search-enhancer/EhSearchEnhancer.js)
- [AriaEh](./scripts/aria-helper/AriaEh.user.js)
- [ExHentai Lanraragi Checker](./scripts/lanraragi-checker/ExHentai_Lanraragi_Checker.user.js)

## ⚠️ 重要注意事项

1. **仅适配缩略图模式**
   - EhSearchEnhancer 仅在E-Hentai的缩略图（Thumb）模式下运行
   - 列表模式、Minimal模式等暂不支持

2. **登录要求**
   - 某些功能需要E-Hentai账号登录
   - 未登录时这些功能会被禁用

3. **归档下载消耗GP**
   - 发送到AB DM（归档）会消耗账户GP
   - 请谨慎使用，确认需要后再操作

4. **浏览器缓存**
   - 脚本使用浏览器LocalStorage存储数据
   - 清空浏览器缓存会丢失已保存的标记和数据

5. **性能和风控考虑** ⚠️
   - **并发限制**：单页100画廊时，建议并发数不超过5
   - **风控风险**：
     - 同时启用无限滚动 + 自动刷新 + 高并发 → 易触发E-Hentai风控
     - 多个浏览器标签页同时进行批量操作 → 易触发风控
     - 被风控后请及时调整参数或降低频率
   - **建议配置**：
     - 优先选择以下其一而非同时启用：
       - 单页100画廊或更少，禁用自动刷新（仅手动悬停刷新+按需批量刷新），并发数5或以下
       - 仅启用无限滚动（手动悬停刷新）
       - 仅启用自动刷新（单页面）
       - 多页面操作时降低并发数至3以下
     - 鼠标悬停刷新用于单画廊体验，不影响整体性能

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

详见 [CHANGELOG](./CHANGELOG.md)

---

**最后更新**：2026-01-15
