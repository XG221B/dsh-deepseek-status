# dsh-deepseek-status

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的一个插件：在输入框旁边常驻两个徽标。

- **计费时段**：现在是峰价还是谷价，还有多久切换，当前各模型的价格
- **账户余额**：账号里还有多少钱（充值 + 赠送）

数据自动更新，装完不用管。

## 安装

**桌面版（desktop profile）**：`dsh plugin` 不管这个 profile，命令行会直接停下：

```
error: profile "desktop" is managed exclusively by the Electron application
```

两条路，任选一条：

- 侧边栏 Plugins → Add plugin，填 `github:XG221B/dsh-deepseek-status`；
- 或者用仓库自带的安装器。它做的是 DSH 自己做的那两步——在 profile 目录里 `pnpm add`，再把真实包名并入 `dsh.profile.bundles`——只是绕开了那句拒绝。需要先克隆本仓库，在仓库目录里运行：

```sh
node tools/install.mjs --profile desktop
```

**其它 profile**（web / tui / headless …）：命令行本来就能用。

```sh
dsh plugin --profile <你的 profile> add github:XG221B/dsh-deepseek-status
```

卸载：前者把 `add` 换成 `remove`；安装器加 `--remove`。

`github:` 这类 spec 要经 git 访问 github.com，网络到不了时改用同一个提交的 tarball，两种方式都认：

```sh
node tools/install.mjs --profile desktop \
  --spec https://codeload.github.com/XG221B/dsh-deepseek-status/tar.gz/refs/heads/main
```

装完刷新一次页面；覆盖安装旧版本则要重启一次 Harness（Host 代码缓存在进程里）。

## 长什么样

```
● 谷价 · 距峰价 5天15小时        ● 余额 ¥110.00
```

点计费徽标：当前规则、下次切换时间、价格表、数据来源和核对时间。
点余额徽标：充值余额、赠送余额、合计，以及去充值、查看用量两个入口。

颜色跟随 Harness 主题，中英文跟随界面语言。

## 使用前要知道的三件事

**余额需要登录 DeepSeek 账号。** 只用 API key、没登录账号时，Harness 的账号服务里没有钱包，余额徽标就不会显示（计费徽标不受影响，它不需要账号）。

**插件不碰你的密钥。** 余额是向 Harness 自带的账号服务要的，令牌始终留在 Host 进程里，页面只拿到金额数字。余额不写磁盘、不打印、不外发。

**只有计费功能联网。** Host 半边会定时抓官方价格页和节假日数据，做交叉校验后缓存到插件目录下的 `cache/dataset.json`，并在本机回环上开一条只读路由 `/dsh-deepseek-status/data.json` 给页面读。路由里只有公开数据；如果你把 Harness 绑到 `0.0.0.0`，同网段的人也能读到它。

余额相关的读取最快每分钟一次（页面切到后台就暂停），计费数据每 6 小时刷新一次。

## 开发

```sh
node tools/test-data.mjs      # 数据层解析与校验
node tools/test-pricing.mjs   # 计费逻辑
node tools/test-balance.mjs   # 余额逻辑
node tools/test-bundle.mjs    # 整个浏览器 bundle 的挂载冒烟
node tools/test-install.mjs   # profile 安装器（本机有 pnpm 时多跑 9 项真实安装）
node tools/test-host.mjs      # Host 端到端，需要联网
```

共 335 项检查，前五套不需要网络，push 时自动跑。架构说明见 [DEVELOPING.md](./DEVELOPING.md)。

DSH 升级后先跑一次契约检查，再决定要不要重启（一个入口没激活会让界面起不来，这条命令能提前发现）：

```sh
node tools/preflight.mjs --live
```

真出问题时，把 `dsh-deepseek-status` 从 `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 里删掉再启动即可恢复。

## 数据来源

计费规则和价格取 [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)；节假日取 [holiday-cn](https://github.com/NateScarlet/holiday-cn) 与 [chinese-days](https://github.com/vsme/chinese-days)（都是 MIT），两者必须一致才采用。

在 DSH `0.2.0-rc.2` 上开发验证。

## 许可

[MIT](./LICENSE)
