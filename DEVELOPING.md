# 开发与发布

面向维护者。用户向说明在 [README.md](./README.md)。

## 目录

```
index.js     Host 半边：计费功能的定时抓取 + 校验 + 磁盘缓存 + 一条同源 HTTP 路由
data.js      Host 纯函数层：解析官方价格页、解析两套节假日数据、逐项校验、组装数据集
client.js    浏览器半边：一个 bundle 内两个功能工厂（计费徽标/详情 + 余额徽标/详情）
cordis.patch.yml  这个 bundle 唯一的一行 Loader 行
locale/      插件卡片在「Plugins」页显示的标题与描述（中英）
tools/       四套测试、测试样本与样本再生成脚本（不随 npm 发布）
```

余额功能**没有 Host 代码**：它通过 Harness 账号 Remote 在浏览器侧读取，令牌始终留在 Host。

## 为什么是一个包而不是两个

DSH 的加载模型决定了这件事：

| 约束 | 含义 |
|---|---|
| **包名 = Loader 行的 `name` = `client.js` 里 `window.__ModuleLoader__.load({ id })`** | 三者必须逐字一致；浏览器模块 id 由行 specifier 推导（会解析 `<specifier>/client`） |
| **一个包只有一行、只有一个浏览器模块 id** | 两个功能不能各占一行，否则模块 id 冲突、`<specifier>/client` 解析也会错 |
| **所以** | 两个功能共用一个 `client.js`，各自注册自己的槽位条目 |

实现方式是**两个独立作用域的工厂**：

```js
factory(require) {
  const React = require('react'); const h = React.createElement;
  const pricing = createPricing({ React, h });      // 计费功能：自己的 NS/DICT/CSS/store/组件
  const balance = createBalance({ React, h });      // 余额功能：同样自成一域
  return { inject: ['slots','locale'], apply(ctx) { … } };
}
```

好处是合并时**两个已验收的半边一行未改**（不需要重命名内部变量，也不可能互相遮蔽状态），只需在工厂外层换掉标识与路由路径。

**加第三个功能**：在 `client.js` 里再加一个 `createXxx({ React, h })` 工厂，给它自己的 locale 命名空间、自己的 `DICT`/`CSS`、自己的 store 与展开状态，然后在 `apply` 里注册槽位。**不要**新建 Loader 行。

## 三条硬约束

1. **包名 = Loader 行 = 浏览器模块 id**，改名要三处一起改（`package.json` / `cordis.patch.yml` / `client.js` 里 `load({ id })`）。
2. **Host 代码改动需要重启 Harness 才生效**：Host 按解析后的 URL 缓存已导入的模块，重新启用插件不会重新导入。开发时可以直接跑 `tools/test-host.mjs`——它用桩上下文加载 `index.js` 并驱动真实抓取路径，不需要启动界面。
3. **余额功能是可选挂载**：`apply` 先用 `ctx.get('remote')` 探测账号命名空间，缺失时只跳过余额半边并发一条 console 说明，**不能让计费徽标跟着消失**。加新功能时保持这个原则：可选依赖不能拖垮必需功能。

## 测试策略

```bash
node tools/test-data.mjs      # Host 数据层（100）
node tools/test-pricing.mjs   # 计费浏览器逻辑（75）
node tools/test-balance.mjs   # 余额浏览器逻辑（54）
node tools/test-host.mjs      # Host 端到端，需要网络（36）
node tools/test-bundle.mjs    # 整个 bundle 的无头冒烟（17）
```

合计 282 项。

- **`test-bundle.mjs` 是改结构后的必跑项**：它按页面加载器的方式评估整个 `client.js` 并驱动 `apply`，检查模块 id、四个槽位条目、两个命名空间、两张样式表、八个 effect，以及「没有账号命名空间时只挂计费半边」。纯逻辑测试看不见「能加载但什么都没挂上」，那类故障在界面里只表现为徽标消失。

- 纯逻辑测试**从 `client.js` 里按标记切出无依赖区间**再执行（区间边界是各功能自己的 `const NS = '…'` 与 `* Translation` 注释），所以测的是随包发布的那份代码，而不是副本。改这两个标记要同步改对应测试。
- 故意破坏的用例是重点：未知 status、残缺钱包数组、被拒绝的调用、峰谷两列对调、中英窗口不一致、星期范围不一致——验证的是**读不出来就明说，绝不给模糊值**。
- `test-host.mjs` 用独立临时缓存目录（`DSH_DEEPSEEK_STATUS_CACHE_DIR`），**不会动部署态数据**；联网检查只断言不变量（两个窗口、谷价=峰价÷2、双源一致），具体价格由 `tools/fixtures/` 钉住。
- `tools/fixtures/` 里的价格页样本是从公开页面**裁剪**出来的最小文档（表格 + 规则段），节假日样本是 MIT 许可的公开数据原文。见 [tools/README.md](./tools/README.md)。

## 打包与发布

```bash
pnpm pack            # 产出 dsh-deepseek-status-2.0.0.tgz
```

本包**没有** `install`/`prepare` 脚本，因此 git 安装与 npm 安装都不需要用户授予 `allowBuilds` 构建权限。

**分发渠道的现实情况**（2026-10 核实）：DSH **没有官方插件市场**可投稿。官方《打包与安装插件》只规定四种安装形态——npm 包、Git 仓库、tarball、本地绝对路径；桌面端「Plugins」页的 Official 组只列**随安装自带**的 bundle。想更大曝光只能发 npm、公开 GitHub 仓库，或投稿到**第三方**社区市场（如 [dsh-market](https://github.com/dsh-market/dsh-market)、[dsh-plugin-market](https://github.com/chnjames/dsh-plugin-market)），审核与可信度由那家负责。

## 提交隐私清单（每次发布前过一遍）

公开仓库会永久保留 git 历史。

**必须避免**

- 任何 API key、token、cookie 或凭据。**特别地：余额数据永远不进仓库、不进测试、不进日志**——它只在页面内存里。
- 个人身份信息：真实姓名、学校/单位、私人邮箱、截图里的窗口标题。
- 本机绝对路径（`C:\Users\<用户名>\…`、`/home/<用户名>/…`），包括注释与文档里。
- `cache/`、`*.tgz`、日志等运行时/构建产物（`.gitignore` 已排除）。

**提交身份：最容易忽略的泄露点**

```bash
git config user.name  'XG221B'
git config user.email '<你的数字ID>+XG221B@users.noreply.github.com'   # 在仓库内执行，只影响本仓库
git log -1 --format='%an <%ae>'      # 提交前复核
```

未设置身份时，git 会用 `<系统用户名>@<主机名>` 兜底，把机器用户名写进每条提交。

**踩过的坑：空仓库的第一个提交**

用 GitHub Contents API 往**空仓库**写第一个文件时，服务端会用你账号资料里的**真实姓名与主邮箱**署名那条提交（公开可见），即使你本地配了 noreply。正确做法二选一：

- 用 Contents API 建立首个提交时**显式传 `author`/`committer`**（对象里给 noreply 的 name/email）；或
- 先在一个已有提交的仓库里用 git-data API 建 blob/tree/commit，避免走 Contents API。

推送前用 `gh api repos/<owner>/<repo>/commits` 核对每一条提交的 `author.email`。

**本地自检**

```bash
grep -rInE 'sk-|api[_-]?key|password|secret|Bearer |[A-Za-z]:\\\\Users|/home/' \
  --exclude-dir=.git --exclude-dir=node_modules .
```

（`token` 一词在本仓库只作为「计费 token」出现，不要盲目加入扫描。）

## 设计要点（改动时保持不退化）

- **不静默降级**：任何"读不出来就用模糊值"的改动都应视为缺陷。宁可显示旧数据并标注。
- **数据与元信息同源**：价格表必须和它的币种一起来自同一页；借用时元信息一起借。
- **不硬编码会变的东西**：价格、窗口、节假日运行时获取；仓库里唯一时间敏感的是内置快照，只在完全无法联网时显示。
- **可选依赖不拖垮必需功能**（见硬约束 3）。
- **金额只进内存**：余额相关的任何缓存/日志/上报都是隐私缺陷。
