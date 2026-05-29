# Nakiri Electricity (GitHub Pages Version)

[![Daily Electricity Check](https://github.com/Dainsleif233/NakiriElectricity/actions/workflows/daily_check.yml/badge.svg)](https://github.com/Dainsleif233/NakiriElectricity/actions/workflows/daily_check.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

这是一个基于 **React** 和 **GitHub Actions** 的无服务器电量监测系统。
特点：**零成本**、**无需服务器**、**自动爬虫**、**美观图表**。

![统计面板](assets/Dashboard.png)

## ✨ 功能特性

- 📊 **深度数据分析**：实时电量、近3小时消耗、单日最大/最小消耗。
- 📈 **交互式图表**：支持平滑曲线、数据点交互、多时间维度（24h/3天/7天/30天）。
- 🎨 **现代化 UI**：基于 Tailwind CSS，完美适配移动端，支持深色模式 (Dark Mode)。
- 🤖 **全自动运行**：利用 GitHub Actions 每小时自动抓取数据，无需人工干预。
- ⚡ **智能预测**：基于历史数据估算剩余可用天数，检测充值记录。

## 🚀 快速部署 (Fork & Run)

你不需要任何服务器，只需要一个 GitHub 账号。

### 1. Fork 本仓库
点击右上角的 **Fork** 按钮，将本项目复制到你的 GitHub 账号下。

### 2. 配置环境变量 (Secrets)
进入你 Fork 后的仓库，点击 `Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`。

添加以下 5 个 Secret（必须大写）：

| Secret Name | 说明 | 示例 |
|Data | Description | Example |
|---|---|---|
| `TOKEN` | 令牌 | `eyXXX` |
| `CAMPUS` | 校区 | `校本部` |
| `BUILDING` | 区域 | `C区` |
| `FLOOR` | 楼栋 | `1` |
| `ROOM` | 房间 | `1-1-101` |

**房间信息需要和小程序中的房间信息一致。**

#### 令牌获取方式：

- 打开 [综合门户](http://ehall.ujs.edu.cn/) 登入账号。
- 搜索打开 `一卡通服务`，右上角打开用户设置。
- 此时 URL 中 `synjones-auth` 值就是需要的令牌，注意不要泄露。

### 3. 启用 GitHub Actions
进入 `Actions` 标签页，点击 `I understand my workflows, go ahead and enable them`。
然后点击左侧的 `Daily Electricity Check`，点击 `Run workflow` 手动触发一次，确保配置正确。

### 4. 开启 GitHub Pages
进入 `Settings` -> `Pages`。
- **Source**: 选择 `Deploy from a branch`
- **Branch**: 选择 `main`，文件夹选择 `/`
- 点击 **Save**。

等待几分钟，你的专属电量监控页面就上线了！🎉

## 🛠️ 本地开发

如果你想修改代码或贡献功能：

1. **克隆仓库**
   ```bash
   git clone https://github.com/Dainsleif233/NakiriElectricity.git
   cd NakiriElectricity
   ```

2. **安装依赖**
   ```bash
   npm install
   ```

3. **配置环境变量**
   在根目录创建 `.env` 文件（参考 `.env.example`），填入你的测试房间信息。

4. **启动开发服务器**
   ```bash
   npm run dev
   ```

## ❓ 常见问题 (FAQ)

**Q: 数据多久更新一次？**
A: 默认每3小时更新一次（GitHub Actions 定时任务）。你也可以在 Actions 页面手动触发更新。

**Q: 为什么图表显示“暂无数据”？**
A: 刚部署时没有历史数据。请等待 Actions 运行几次，或者手动触发几次以积累数据。

**Q: 部署失败怎么办？**
A: 检查 Actions 日志，通常是环境变量配置错误。

## 📄 许可证

本项目采用 [MIT 许可证](LICENSE)。

---
*注意：本项目仅供学习交流使用，请勿用于商业用途或恶意爬取。*
