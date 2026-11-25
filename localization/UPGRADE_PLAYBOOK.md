# 长期汉化维护与升级手册 (Upgrade Playbook)

本仓库采用 **双上游追踪 + 最小化侵入 + 自动化审计门禁** 策略，确保 `elviscjn-cjn/antigravity-context-viewer` 与 `Antigravity-Chinese-Localization` 每次发布新版本时都能低成本同步并保持全简体中文体验。

## 分支策略

- `main`：干净镜像 `upstream/main`，不做任何本地修改。
- `zh-cn`：长期汉化主分支，承载全部汉化补丁、默认配置调整与 `localization/` 工具链。
- Release Tag：`v<上游版本>-zh.<序号>`（例如 `v0.9.3-zh.1`）。

## 首次关联个人 GitHub Fork

```powershell
git remote add origin https://github.com/<你的用户名>/antigravity-context-viewer.git
git push -u origin main zh-cn
```

## 上游发新版后的标准 4 步升级流程

### 方式 A：GitHub Actions 全自动同步（推荐）
1. 在 GitHub Fork 仓库的 **Actions** 页签找到 `Upstream Sync & Audit`（每日自动定时运行，也可点击 **Run workflow** 手动触发）。
2. 工作流会自动检测上游新版本、在同步分支尝试合并、同步最新客户端词典、运行渲染构建、全量漏翻审计与全部单元测试，并自动提一条指向 `zh-cn` 的 Pull Request（附带 `localization/audit-report.md`）。
3. 审阅 PR 中的漏翻报告并补齐新增英文后合并，打上新 Tag（如 `git tag v0.9.4-zh.1 && git push origin v0.9.4-zh.1`）即可自动触发 `Release` 工作流构建 6 平台 ZIP 并发布。

### 方式 B：本地同步
```powershell
# 1. 检查双上游是否有新版本
node localization/scripts/sync-upstream.js

# 2. 同步上游插件代码
git fetch upstream
git checkout main
git merge --ff-only upstream/main
git checkout zh-cn
git merge main

# 3. 同步最新客户端词典并构建审计
node localization/scripts/sync-upstream-dict.js --update-config
npm run build:renderer
node localization/scripts/audit-i18n.js --strict --report localization/audit-report.md

# 4. 全量测试验证
npm test
node --test localization/l10n-regression.test.js
```

## 推送前隐私与安全自检清单

1. 确认工作区内无硬编码绝对路径、个人 Token/PAT、内网 IP 或临时截图/日志。
2. 运行 `git status` 与 `git diff`，确认未误提交 `dist/`、`node_modules/` 或测试临时目录。
3. 确认 `THIRD_PARTY_NOTICES.md` 保留完整上游 MIT 许可证与署名信息。
