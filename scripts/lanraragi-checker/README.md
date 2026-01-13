# ExHentai Lanraragi Checker（修改版）

在E-Hentai/ExHentai页面上自动检查画廊是否已存在于您的Lanraragi库中，并在标题前显示状态标记。

## 主要功能

- 🔍 自动检查 - 在浏览画廊列表时自动检查每个画廊是否在您的Lanraragi库中
- ✔️ 状态标记 - 显示不同的标记以表示检查结果：
  - `✓` - 绿色：画廊已在库中
  - `!` - 蓝色：通过作者+标题搜索找到匹配作品
  - `?N` - 紫色：发现N个可能匹配的作品
  - `🔄` - 灰色：未找到匹配，点击刷新搜索
  - `⚠` - 红色：检查出错或网络错误
  - `⏳` - 灰色：搜索中...
- 📋 详情预览 - 点击标记显示库中对应作品的详细信息：
  - 📸 作品封面缩略图
  - 📄 页数信息
  - 🏷️ 标签和元数据
  - 🔗 快速访问库中的作品
- 🔄 缓存机制 - 对检查结果进行缓存，减少重复查询
- 🔐 配置菜单 - 通过脚本菜单配置服务器地址、API密钥等

## 安装

1. 确保已安装Tampermonkey或Violentmonkey等油猴扩展
2. 点击[安装脚本](./ExHentai_Lanraragi_Checker.user.js)

## 配置

### 基础配置

在脚本顶部修改以下常量（或通过脚本菜单设置）：

```javascript
const LRR_SERVER_URL = 'http://localhost:3000'; // 替换为您的 Lanraragi 服务器地址
const LRR_API_KEY = ''; // 如果您的 Lanraragi API 需要密钥，请填写
```

### 脚本菜单选项

访问页面时，脚本菜单（通常在浏览器工具栏）中会显示"[LRR] 设置"选项，可以配置：

- 🔗 Lanraragi 服务器地址
- 🔑 API 密钥
- 🔄 并发请求数（提升检查速度，但可能增加服务器负担）
- 📅 缓存过期时间（天数）
- 🔎 深度搜索（通过作者+标题搜索）
- 🏷️ 关键词管理（白名单/黑名单）

## 相对于原版的改动

- ✨ 添加了简繁体转换支持，提升跨地区搜索准确率
- 🎯 优化了深度搜索算法和缓存机制
- 🛠️ 改进了UI和菜单逻辑
- 🔧 完善了关键词过滤和白名单功能
- 📝 添加了详细的配置说明

## 效果示例

![示例截图描述]
- 在画廊列表中，每个画廊标题前会显示Lanraragi检查的结果标记
- 鼠标悬停标记可查看详细信息
- 通过脚本菜单可快速访问配置页面

## Credits / 致谢

Forked and modified from [Putarku/LANraragi-scripts](https://github.com/Putarku/LANraragi-scripts)

原版脚本由 Putarku 开发，本版本由 AkiraShe 修改并维护。

## 许可证

MIT License
