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
3. **入口必须永远激活**——见下一节，这是踩过最贵的一次坑。

## 铁律：入口必须永远激活

DSH 把「有入口没激活」当作**致命启动错误**。桌面壳在渲染进程启动后审计客户端树，只要有一个入口不是 `active` 就通过 IPC 上报 `bootFailed`：

```
Error: web boot: 1 entry did not activate
dsh-deepseek-status: failed
```

后果不是「这个插件不能用」，而是**整个界面起不来**；随后 DSH 做恢复性重置——把出问题的 bundle 从 profile 的 `dsh.profile.bundles` 移除，并把 `cordis.patch.yml` 重命名备份为 `.bak-<epoch-ms>` 后**重写为默认值**（用户设置因此丢失过一次）。

更麻烦的是审计代码**只报状态、不报原因**（`dsh-web-frontend/dist/assets/index-*.js`）：

```js
if (s.fiber === void 0)              o.push(`${name}: import failed: ${err.message}`)  // 只有导入失败带原因
else if (state === 'pending')        o.push(`${name}: pending (waiting for services: …)`)
else                                 o.push(`${name}: ${state}`)                       // ← "failed"：无原因
```

所以本项目两条规则：

1. **`inject` 只放必然存在的服务**（`slots`、`locale`）。可选服务一律用 `ctx.inject([...], cb)` 挂载子纤维——放进 `inject` 会让入口停在 `pending`，同样致命。
2. **每个半边、以及 Host 半边的路由注册，都包在 try/catch 里**：显示类插件永远不该拖垮启动。失败记录并降级，而不是冒泡。

Cordis 的语义值得记住（`@deepseek-ai/cordis/lib/index.js`）：

- **属性访问** `ctx.remote` 在未 `inject` 时抛 `cannot get property "remote" without inject`（proxy get 陷阱）；
- **`ctx.get(name, strict?)`** 才是「不需要 inject 也能读」的安全通道，`strict` 只影响是否要求提供方已激活；
- 因此「用 `ctx.get` 取出来传参」**不能**让半边内部继续按属性访问——这正是 2.0.1 修掉的那个回归。

### 客户端激活失败去哪找原因

审计不给原因，所以 `client.js` 在失败时把报告写进页面 Local Storage（健康时**不写**）：

```
%APPDATA%\@deepseek-ai\dsh-desktop\Local Storage\leveldb\*.log   ← 键 dsh-deepseek-status/diagnostics
```

Chromium 会独占这个文件，读取要带共享标志：

```powershell
$fs=[IO.File]::Open($path,'Open','Read','ReadWrite')
$r=New-Object System.IO.StreamReader($fs,[System.Text.Encoding]::UTF8); $r.ReadToEnd()
```

### 设置被重置时怎么恢复

DSH 重写 `cordis.patch.yml` 前会把它存成 `cordis.patch.yml.bak-<epoch-ms>`（epoch 毫秒即重置时刻，可直接换算）。恢复即把该文件里的条目合并回来，**但要去掉指向已卸载 bundle 的行**（那些 id 在树里已不存在）。

## 测试策略

```bash
node tools/test-data.mjs      # Host 数据层（100）
node tools/test-pricing.mjs   # 计费浏览器逻辑（75）
node tools/test-balance.mjs   # 余额浏览器逻辑（54）
node tools/test-host.mjs      # Host 端到端，需要网络（36）
node tools/test-bundle.mjs    # 整个 bundle 的无头冒烟（21）
```

合计 286 项。push/PR 会自动跑前四套（`.github/workflows/test.yml`），联网那套单独成 job 且非阻挡。

### DSH 升级检查清单

**升级后、重启前**按顺序做：

1. `node tools/preflight.mjs --live` —— 直接读 `app.asar` 核对 12 处契约；任一 FAIL 就先按它打印的方法禁用 bundle，别带着风险重启；
2. `pnpm test`（= 4 套离线测试，286 项里的 250 项）；
3. 重启后确认：两个徽标在、`/dsh-deepseek-status/data.json` 返回 200、`preflight --live` 通过。

失效时的表现分四种，照着判断自己遇到的是哪种：

| 现象 | 多半是什么 | 会不会崩 |
|---|---|---|
| 徽标凭空消失 | 槽位 key 改名/移除 | 不会（`preflight` 会报 FAIL） |
| 卡片显示「读取失败」 | Remote 契约（`getBalance`/信封字段）变了 | 不会，也不会给假数字 |
| **界面起不来** | 客户端入口未激活（**唯一致命项**） | 会；按 preflight 的方法禁用 bundle 即可恢复 |
| 数字过期但卡片标着来源时间 | 官方页面改版，需更新 `data.js` 的解析器 | 不会 |

- **`test-bundle.mjs` 是改结构后的必跑项**：它按页面加载器的方式评估整个 `client.js` 并驱动 `apply`，检查模块 id、四个槽位条目、两个命名空间、两张样式表、八个 effect、`ctx.inject` 的依赖清单，以及「某个半边抛错被隔离而不是冒泡」。它的桩上下文必须**忠实模拟真实语义**：服务以**属性**形式暴露（`ctx.remote`），并提供 `ctx.inject`——桩与真实语义不一致时，恰恰会放过 2.0.1 那类故障。

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
