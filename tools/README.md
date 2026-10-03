# tools

四套测试、测试样本与样本再生成脚本。这个目录**不会**发到 npm（`package.json` 的 `files` 白名单不含它），但会随 git 仓库公开。

```bash
node tools/test-data.mjs      # Host 数据层（100 项）
node tools/test-pricing.mjs   # 计费浏览器逻辑（75 项）
node tools/test-balance.mjs   # 余额浏览器逻辑（54 项）
node tools/test-host.mjs      # Host 端到端，需要网络（36 项）
node tools/test-bundle.mjs    # 整个 bundle 的无头冒烟（17 项）
```

## 各测什么

**`test-data.mjs`** — 用抓取当天的真实页面存档驱动解析器：中英文价格页的规则与价格表、两套节假日数据集、逐项校验，以及**故意破坏**的用例（去掉一个窗口、把峰谷两列对调、把中英窗口或星期改成不一致、年份空壳、残缺钱包…）。还包括降级链：离线、只有单一语言、镜像回退、独立数据源不一致。

**`test-pricing.mjs` / `test-balance.mjs`** — 把 `client.js` 里**不依赖 React/DOM 的那一段**抽出来直接执行（按各功能自己的 `const NS = '…'` 标记与 `* Translation` 注释切分）。计费侧覆盖窗口边界、下次切换计算、内置快照与实时数据的合并语义、节假日名本地化；余额侧覆盖金额格式化（两位小数、千分位、正的不足 1 分显示 `<0.01`、负数最小量级）、多币种分组合计、**可花费总额（充值 + 赠送）**、以及账号 Remote 信封四种形态的映射。

**`test-host.mjs`** — 按 Loader 的方式导入 `index.js`，用桩上下文激活，断言注册了那条路由，再用假 `req/res` 打通路由：HEAD/POST 处理、真联网抓取、数据集落盘与校验。联网检查只断言**不变量**（两个窗口、谷价=峰价÷2、双源一致），离线时报 `SKIP` 而非失败。

它通过 `DSH_DEEPSEEK_STATUS_CACHE_DIR` 使用**每次独立的临时缓存目录**，跑完即删——因此**不会碰部署中实例的数据**。

**`test-bundle.mjs`** — 按页面模块加载器的方式评估**整个** `client.js`（同样的 `window` 契约、同样的工厂调用、同样的 `apply(ctx)`），断言激活后注册了什么：模块 id 等于包名、两个徽标 + 两个详情卡、四个槽位 id 与顺序、两个 locale 命名空间、两张样式表、八个可释放的 effect；以及**可选依赖降级**——没有账号命名空间时只挂计费半边并打印一条说明。

这套测试专门抓「bundle 能加载但什么都没挂上」这类故障：纯逻辑测试看不见它，而在界面里表现为徽标凭空消失，只能靠刷新/重启反复试。**改动 bundle 结构（新增功能、改命名空间、改槽位）后必须跑它。**

## fixtures 是怎么来的

- **价格页样本不是文档页的拷贝**，而是 `node tools/make-fixtures.mjs` 从实时页面**裁剪**出的最小文档：只保留价格表 + 写明规则的那一段脚注（约 3 KB，而不是原页 24 KB）。
- **节假日样本**是两份 MIT 许可公开数据集的原文（`holiday-cn`、`chinese-days`），保留原样是因为解析器就是对着它们的形状写的。
- **刻意没有「未发布年份」样本文件**：`parseHolidayYear({ year: 2027, papers: [], days: [] })` 直接在测试里合成——CDN 一旦发布次年数据，样本文件会变成噪音，而合成对象永远表达「200 + 空数组」这一种情况。
- 页面改版后：重新运行 `make-fixtures.mjs` 并同步更新 `test-data.mjs` 里对具体价格数字的断言。

## 改契约时需要核对

余额字段来自 DSH 生成的 Remote 契约（宿主安装目录里的 `@deepseek-ai/dsh-api-account-controller`）：

```bash
# 在能浏览 app.asar 的环境里核对 getBalance 的参数与返回 schema
grep -n "account_getBalance" "<DSH 安装目录>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-api-account-controller/lib/typert.remote-client.js"
```

同时同步 `client.js` 里余额功能的 `CLIENT_VERSION`。
