# 更新日志

本文档记录所有脚本的版本更新信息。

## EhSearchEnhancer（搜索增强脚本）

### v2.0.2 (2026-01-15)
- 🔧 完全移除 LocalStorage 相关逻辑，数据仅通过 IndexedDB 管理
- 🐛 修复 IndexedDB 数据丢失问题：改进异步保存机制，确保数据完全写入
- 📢 优化导入流程：添加"导入中..."提示，增强用户体验
- 📊 改善"最近下载"菜单：按倒序排列，最新批次显示在顶部
- 🎨 修正菜单项中 emoji 与文字的对齐问题

**⚠️ 更新建议**：本版本修改了数据存储方式，建议更新前先通过"设置 → 导出设置"导出备份

### v2.0.1 (2026-01-13)
- 🐛 修复：收藏页面现在显示复选框，支持批量下载
- 📝 优化：更新功能说明和注意事项

### v2.0 (2026-01-12)
- ✨ 重大功能升级
- 🎨 UI优化和菜单重组
- 📋 添加完整功能说明系统
- ⚙️ 完善设置菜单
- 🔧 修复多项bug

### v1.0
- 初始版本
- 基础的多选和磁链显示功能

---

## AriaEh（Aria2下载助手）

### v1.3 (2026-01-13)
- 🔧 移除sleazyfork自动更新链接
- 🔗 更新项目主页和支持链接指向eh-enhancements

### v1.2
- ✨ 深度适配EhSearchEnhancer
- 🔧 修复了某些情况下获取不到压缩包名称的问题
- 🎨 优化菜单界面
- 📊 增强下载历史功能
- ⚙️ 完善配置系统

### 原始版本
- 基础的Aria2集成功能
- 种子管理功能
- 原作者：[SchneeHertz](https://github.com/SchneeHertz)

---

## ExHentai Lanraragi Checker（Lanraragi检查脚本）

### v1.5 (修改版, 2026-01-13)
- 🔧 移除sleazyfork自动更新链接
- 🔗 更新项目主页和支持链接
- 📝 完善功能说明和配置文档
- ✨ 支持简繁体转换、深度搜索、缓存优化

### 原始版本
- Putarku 和 AkiraShe 联合开发
- 原项目：[Putarku/LANraragi-scripts](https://github.com/Putarku/LANraragi-scripts)
- 基础的Lanraragi库检查功能

---

## 项目改动日志

### 2026-01-13
- 统一更新所有脚本元数据（homepage、supportURL）
- 创建集中的CHANGELOG.md管理所有版本信息
- 简化各脚本README结构，把更新日志移至CHANGELOG.md
- 创建统一的安装指南（installation-guide.md）

### 2026-01-12
- 发布eh-enhancements项目初始版本
- 包含EhSearchEnhancer v2.0、AriaEh v1.2、ExHentai Lanraragi Checker v1.5
- 清空项目Git历史，保留当前状态

---

## 版本对应表

| 脚本 | 当前版本 | 发布日期 | 状态 |
|------|--------|--------|------|
| EhSearchEnhancer | v2.0.2 | 2026-01-15 | ✅ 稳定 |
| AriaEh | v1.3 | 2026-01-13 | ✅ 稳定 |
| ExHentai Lanraragi Checker | v1.5 | 2026-01-13 | ✅ 稳定 |
