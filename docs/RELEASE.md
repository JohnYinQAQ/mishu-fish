# 发布清单

## 一、截图（需要你自己截）

README 顶部要有 2–3 张图，别人一眼就知道这是什么。建议：

| 文件 | 内容 | 怎么截 |
|---|---|---|
| `docs/images/chat.png` | 微信里的一段对话（早间问候 + 记日程 + 催作业） | 手机截图，或用微信桌面版窗口截图 |
| `docs/images/settings-persona.png` | 设置页「人设 + 表达」 | `Cmd+Shift+4` 区域截图 |
| `docs/images/settings-habits.png` | 设置页「习惯」列表 | 同上 |

**必须打码**：微信昵称、头像、二维码、`credentials.json`、任何真实聊天内容里的姓名/地址/学号。

截完把文件放进 `docs/images/`，README 里这样引用：

```markdown
![微信对话](docs/images/chat.png)
```

## 二、发布前检查

- [ ] `pnpm test` 全绿
- [ ] `pnpm typecheck` 无错
- [ ] `docs/SMOKE.md` 走一遍
- [ ] `CHANGELOG.md` 有本次改动
- [ ] README 无个人绝对路径
- [ ] `.data/`、`.tmp/` 不在提交里

## 三、打 tag

对外版本号与 `package.json` 的构建号是两套：

```bash
# package.json 里可能是 0.10.5，对外叫 v0.2.0
git tag v0.2.0
git push --tags
```

## 四、做一个下载网站（不用买服务器）

两条都免费，配合使用：

**1. GitHub Releases = 下载页**

```bash
git tag v0.2.0
git push --tags
```

然后 GitHub → Releases → Draft a new release → 选 tag → 上传 `mishu-fish-0.2.0.zip`（打包时排除 `node_modules/ .data/ .tmp/`）→ Publish。
链接就是 `https://github.com/你的用户名/mishu-fish/releases/latest`，永远指向最新版。

**2. GitHub Pages = 介绍页**

仓库 Settings → Pages → Source 选 `Deploy from a branch` → Branch 选 `main`、目录选 `/docs` → Save。
一分钟后 `https://你的用户名.github.io/mishu-fish/` 就能打开 `docs/index.html`。

发布前把 `docs/index.html` 里的 `YOUR_NAME` 全替换成你的用户名（共 5 处）。

**3. 想用自己的域名**

- Cloudflare Pages / Vercel / Netlify：连 GitHub 仓库，构建输出目录填 `docs`，绑定域名即可
- 或者在域名服务商加 CNAME 指向 `你的用户名.github.io`

## 五、要不要发 npm

`package.json` 里 `"private": true` 会阻止 `npm publish`。

- 只发 GitHub / Release 压缩包 → 保持现状
- 要发 npm → 改成 `false`，并把 `files` 白名单再检查一遍
