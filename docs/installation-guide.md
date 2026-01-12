# 安装指南

本指南将帮助你快速安装和配置 eh-enhancements 脚本。

## 📋 前置要求

### 浏览器环境
- ✅ Chrome/Edge/Firefox/Safari 等现代浏览器
- ✅ Tampermonkey 或 Greasemonkey 脚本管理器

### 可选工具
- ⚙️ **Aria2** - 用于下载管理（推荐）
- 📦 **AB Download Manager** - 用于归档下载（可选）

## 🔧 步骤一：安装脚本管理器

### Chrome/Edge - 安装 Tampermonkey

1. 打开 Chrome Web Store
2. 搜索 "Tampermonkey"
3. 点击"添加至 Chrome"或"添加扩展"
4. 确认权限后安装

**直接链接**：https://chrome.google.com/webstore/search/tampermonkey

### Firefox - 安装 Greasemonkey 或 Tampermonkey

#### 方式一：Greasemonkey（推荐）
1. 打开 Firefox Add-ons
2. 搜索 "Greasemonkey"
3. 点击"添加到 Firefox"

**直接链接**：https://addons.mozilla.org/firefox/addon/greasemonkey/

#### 方式二：Tampermonkey
1. 打开 Firefox Add-ons
2. 搜索 "Tampermonkey"
3. 点击"添加到 Firefox"

### Safari - 安装 Userscripts

1. 打开 Mac App Store
2. 搜索 "Userscripts"
3. 点击"获取"并安装

## 🚀 步骤二：安装 EhSearchEnhancer

### 方式一：直接安装（推荐新手）

1. **打开脚本管理器**
   - 点击浏览器右上角的 Tampermonkey/Greasemonkey 图标
   - 选择"创建新脚本"

2. **复制脚本代码**
   - 打开 `eh-enhancements/scripts/search-enhancer/EhSearchEnhancer.js`
   - 全选所有代码（Ctrl+A 或 Cmd+A）
   - 复制代码（Ctrl+C 或 Cmd+C）

3. **粘贴到编辑器**
   - 在脚本编辑器中清空默认内容
   - 粘贴脚本代码
   - 按 Ctrl+S 或 Cmd+S 保存

4. **启用脚本**
   - 返回脚本管理器主界面
   - 找到 "EhSearchEnhancer"
   - 确保开关处于"启用"状态

### 方式二：从URL安装

1. 打开脚本管理器
2. 选择"从URL安装脚本"
3. 输入脚本URL
4. 确认安装

**后续支持的URL**：
- Greasy Fork: https://greasyfork.org/...（待上传）
- Sleazy Fork: https://sleazyfork.org/...（待上传）

### 方式三：Git克隆

```bash
# 克隆仓库
git clone https://github.com/[your-username]/eh-enhancements.git

# 手动复制脚本到脚本管理器
```

## 🔧 步骤三：安装 AriaEh（可选）

安装步骤与EhSearchEnhancer相同：

1. 打开脚本管理器
2. 点击"创建新脚本"
3. 复制 `eh-enhancements/scripts/aria-helper/AriaEh.user.js` 的内容
4. 粘贴并保存
5. 启用脚本

## ⚙️ 步骤四：配置Aria2（推荐）

### 4.1 安装Aria2

#### Windows
```bash
# 使用 Chocolatey
choco install aria2

# 或从官网下载
# https://github.com/aria2/aria2/releases
```

#### macOS
```bash
# 使用 Homebrew
brew install aria2
```

#### Linux
```bash
# Ubuntu/Debian
sudo apt-get install aria2

# Fedora/CentOS
sudo yum install aria2
```

### 4.2 启动Aria2

#### 简单启动
```bash
aria2c --enable-rpc --rpc-listen-port=6800
```

#### 后台运行（推荐）
```bash
# 生成配置文件
mkdir -p ~/.config/aria2
touch ~/.config/aria2/aria2.conf

# 添加配置内容（见下方）
aria2c --conf-path=~/.config/aria2/aria2.conf
```

#### aria2.conf 配置示例
```
# 监听地址和端口
rpc-listen-addr=127.0.0.1
rpc-listen-port=6800
enable-rpc=true

# 下载目录
dir=/path/to/downloads

# 最大并发数
max-concurrent-downloads=5

# 单个文件最大线程数
split=5

# 其他配置...
```

### 4.3 验证Aria2连接

在浏览器中打开：
```
http://127.0.0.1:6800
```

应该看到空白页面或错误信息（这是正常的）。

### 4.4 在脚本中配置Aria2

1. 打开任意E-Hentai搜索页面
2. 点击设置按钮（⚙️）
3. 在"种子抓取设置"中确认Aria2端口配置（默认6800）
4. 保存设置

## 📦 步骤五：配置AB DM（可选）

如果想使用AB Download Manager进行归档下载：

1. **下载安装AB DM**
   - 官网：https://abdownloadmanager.com/
   - 选择对应系统的版本

2. **启动AB DM**
   - 安装后启动应用
   - 记下监听端口（默认端口：15151）

3. **在脚本中配置**
   - 打开E-Hentai搜索页
   - 点击设置按钮（⚙️）
   - 找到 "AB DM 端口" 设置项
   - 输入端口号（默认 15151）
   - 保存设置

## ✅ 验证安装

### 检查脚本是否正常工作

1. **打开E-Hentai搜索页**
   ```
   https://e-hentai.org/?f_search=...（任意搜索）
   ```

2. **查看页面元素**
   - 画廊左侧应有复选框 ✓
   - 画廊右侧应有齿轮菜单（⚙️）✓
   - 页面右上/右下角应有操作按钮 ✓

3. **测试右键菜单**
   - 选中一个画廊
   - 在复选框上右键
   - 应弹出菜单 ✓

4. **测试齿轮菜单**
   - 点击任意画廊旁的⚙️
   - 应弹出快捷菜单 ✓

5. **查看浏览器控制台**
   - 打开开发者工具（F12）
   - 切换到"控制台"标签
   - 应无红色错误信息 ✓

### 常见问题

#### 脚本未加载
- **症状**：页面看不到任何脚本功能
- **解决**：
  1. 刷新页面
  2. 检查脚本管理器中脚本是否启用
  3. 查看浏览器控制台是否有错误

#### 菜单无法显示
- **症状**：右键没有菜单或菜单显示不全
- **解决**：
  1. 尝试在不同的搜索页面
  2. 清空浏览器缓存
  3. 禁用其他脚本并重试

#### 下载功能不工作
- **症状**：点击发送下载无反应
- **解决**：
  1. 确保Aria2/AB DM已启动
  2. 检查端口配置是否正确
  3. 查看浏览器控制台错误信息

## 🆘 获取帮助

### 查看脚本说明
- 点击设置 → "功能说明"
- 查看完整的功能介绍和使用方法

### 查看文档
- [EhSearchEnhancer README](../scripts/search-enhancer/README.md)
- [AriaEh README](../scripts/aria-helper/README.md)

### 报告问题
1. 提交 GitHub Issue
2. 在脚本站点留言
3. 包含以下信息：
   - 浏览器版本
   - 脚本版本
   - 错误信息/截图
   - 操作步骤

## 📝 进阶配置

### 自定义Aria2配置

更详细的Aria2配置请参考：
- [Aria2官方文档](https://aria2.github.io/manual/en/html/index.html)

### 配合代理使用

如需通过代理访问E-Hentai（仅在必要时）：
1. 在脚本管理器中配置代理
2. 或在浏览器扩展中配置代理

### 导入导出设置

脚本支持导入导出设置以便迁移：
1. 打开设置菜单
2. 点击"导出设置"保存JSON文件
3. 在新设备上点击"导入设置"
4. 选择之前导出的JSON文件

## 🎉 完成

恭喜！你已成功安装了eh-enhancements脚本。

### 快速开始
1. 打开E-Hentai搜索页
2. 点击"功能说明"了解所有功能
3. 开始使用脚本！

### 下一步
- 探索各种菜单和快捷方式
- 根据需要调整设置
- 享受增强的搜索体验！

---

有任何问题请参考文档或提交Issue。
