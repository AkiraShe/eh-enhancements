# 脚本安装指南

## 前置要求

### 脚本管理器
脚本需要运行在油猴脚本管理器中，请选择安装以下任意一个：

- **Tampermonkey**（推荐）
  - Chrome/Edge: https://www.tampermonkey.net/
  - Firefox: https://www.tampermonkey.net/
  - Safari: 通过 App Store 搜索 "Tampermonkey"

- **Greasemonkey**
  - Firefox: https://www.greasespot.net/

- **Violentmonkey**
  - Chrome/Edge/Firefox: https://violentmonkey.github.io/

## 快速安装

对于本项目的脚本，直接点击下方对应的安装链接：

- [EhSearchEnhancer](../scripts/search-enhancer/EhSearchEnhancer.js) - 搜索增强脚本
- [AriaEh](../scripts/aria-helper/AriaEh.user.js) - Aria2下载助手
- [ExHentai Lanraragi Checker](../scripts/lanraragi-checker/ExHentai_Lanraragi_Checker.user.js) - Lanraragi检查脚本

## 手动安装

如果直接安装链接不工作，可以手动安装：

1. **打开脚本管理器**
   - 点击浏览器工具栏中的脚本管理器图标
   - 选择"创建新脚本"或"新建脚本"

2. **复制脚本代码**
   - 打开对应脚本文件（.js 或 .user.js）
   - 全选并复制所有代码（Ctrl+A, Ctrl+C）

3. **粘贴并保存**
   - 将代码粘贴到脚本编辑器
   - 保存脚本（Ctrl+S）
   - 脚本自动启用

## 特殊依赖

### AriaEh - Aria2下载助手
需要搭配 Aria2 使用（可选但推荐）：

- **Aria2 安装**
  - GitHub: https://github.com/aria2/aria2/releases
  - 详细配置请查看 [AriaEh README](../scripts/aria-helper/README.md)

- **Aria2 Web UI**（可视化管理）
  - webui-aria2: https://github.com/ziahamza/webui-aria2
  - AriaNg: https://ariang.github.io/

### ExHentai Lanraragi Checker
需要搭配 Lanraragi 使用：

- **Lanraragi 安装**
  - GitHub: https://github.com/Difegue/LANraragi
  - 需要本地或远程服务器

## 常见问题

### Q: 脚本不工作怎么办？
A: 
1. 确保脚本管理器已安装并启用
2. 检查脚本是否已启用（管理器中查看）
3. 刷新页面重新加载脚本
4. 打开浏览器控制台（F12）查看是否有错误信息

### Q: 可以同时安装多个脚本吗？
A: 可以。本项目的脚本设计互相兼容：
- EhSearchEnhancer 和 AriaEh 无缝配合
- ExHentai Lanraragi Checker 独立运行

### Q: 更新脚本后旧设置会丢失吗？
A: 不会。脚本数据存储在浏览器 LocalStorage 中，更新脚本不会清除设置。

### Q: 如何卸载脚本？
A: 在脚本管理器中找到脚本，点击删除或关闭即可。

## 获取帮助

- 📝 查看各脚本详细说明：见各脚本目录的 README.md
- 🐛 报告问题：[GitHub Issues](https://github.com/AkiraShe/eh-enhancements/issues)
- 💬 讨论功能：[GitHub Discussions](https://github.com/AkiraShe/eh-enhancements/discussions)
