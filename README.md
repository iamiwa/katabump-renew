# Katabump Docker 自动续期

用于运行 Katabump 自动续期的独立 Docker 项目。本项目不运行代理节点。

## 部署

适用于已安装 Docker Engine 和 Compose 插件的 Linux 主机。镜像支持 `linux/arm64` 和 `linux/amd64`，自动选择宿主机架构，不要强制 ARM 主机模拟 AMD64。

克隆仓库后进入项目根目录，然后执行：

```sh
git clone <仓库地址> katabump-renew
cd katabump-renew
cp login.json.example login.json
nano login.json
```

填写真实的 Katabump 登录账号，支持多个账号：

```json
[
  { "username": "你的邮箱", "password": "你的密码" }
]
```

启动前构建并检查。`--check` 会校验账号格式、启动 Chromium 加载本地测试页面，不登录或续期：

```sh
docker compose build
docker compose run --rm renew --check
docker compose up -d
docker compose logs -f --tail=100
```

容器内使用非 root 的 `pwuser`。若账号文件读取权限报错，先查询 UID，再给文件所有者读取权限：

```sh
docker compose run --rm --entrypoint id renew pwuser
# 将下面的 UID 替换为上一步实际输出的 uid 数字
sudo chown UID login.json
sudo chmod 600 login.json
```

项目根目录只保留 Compose 文件、部署说明和账号模板；应用代码及 Docker 构建文件集中在 `app/`。Compose 从 `app/` 构建镜像，账号文件以只读方式单独挂载，不复制进镜像。

无需开放入站端口，也无需映射 9222。程序使用出站 HTTPS 访问 Katabump；启用 Telegram 后还会访问 Telegram API。Chromium 的运行内存高于纯 Node 脚本，建议主机至少有 1 GB 内存并观察实际占用；128 MB 不适用于本项目。共享内存配置为 256 MB，可按主机容量调整。

## 配置与行为

直接编辑 `docker-compose.yaml` 的 `environment` 配置，由 Compose 注入环境变量，无需 `.env` 文件：

| 参数 | 默认值 / 用途 |
| --- | --- |
| `ACCOUNT_DELAY_MIN_SECONDS`、`ACCOUNT_DELAY_MAX_SECONDS` | 默认 `300`、`600`；相邻账号之间随机等待 5～10 分钟，范围为 0–3600 秒且最小值不大于最大值 |
| `TZ` | 容器默认 `Asia/Shanghai`；续期日期及每日 10:00 调度固定使用北京时间，不受此参数修改影响。日志带 `Z` 的部分仍为 UTC |
| `HTTP_PROXY` | 可选浏览器 HTTP/HTTPS 代理，支持用户名密码 |
| `TG_BOT_TOKEN`、`TG_CHAT_ID` | 同时填写后发送账号结果和截图；默认不发送 |

- 启动先检查本地日期记录。没有记录的账号先登录读取 Expiry；已有记录且未到可尝试日期的账号直接跳过，不启动浏览器、不登录。
- 第一次登录成功后按账号保存登录状态。下次需要访问网站时先恢复该账号状态并打开控制台，仍有效就跳过填写密码和提交登录；网站跳回登录页时自动重新登录。损坏的状态文件会重新生成，网络或页面验证失败不会直接删除已有状态。会话有效期由网站决定，不能保证永久免登录。
- 此后固定在北京时间每天 10:00 开始一轮。到了可尝试日期也要等 10:00；10 点前首次登录只记录日期，不提交续期。容器在 10 点后启动时，会补做当天尚未处理的账号。
- 每个账号在 10 点后的尝试开始前，先保存当天处理标志；失败或中途停止也不会因当天重启而重复登录，下一天 10:00 再检查。首次读取日期跨过 10 点时，会补做已到时间但尚未处理的账号。
- 每个页面操作前独立随机等待 2～5 秒：打开登录页、检查验证、填写邮箱、填写密码、提交登录、进入服务器、打开续期弹窗、检查续期验证和提交续期；重试同样等待。日志显示下一步操作及等待秒数，不输出账号密码。状态轮询沿用原间隔，停止容器会中断等待；账号之间仍随机等待 300～600 秒。
- 每个账号仅续期首页第一个 `See` 入口对应的服务器。
- 进入详情页后读取并保存 `Expiry`，当前支持页面标注的 `YYYY-MM-DD` 日期。例如 `2026-10-05` 到期，本地从北京时间 `2026-10-04 10:00` 起允许尝试；这是本地尝试计划，网站仍会最终判断能否续期。日期缺失、格式不支持、无效或出现多个 Expiry 时记录失败并保留截图，不点击按钮。
- 账号按 `login.json` 的顺序串行处理，10:00 是本轮开始时间，后面的账号依次执行。实际登录的账号之间随机等待 300～600 秒，间隔期间浏览器已关闭；纯缓存跳过的账号不增加间隔，最后一个实际登录账号之后不额外等待。整个批次不会并发运行。
- 账号间隔可调整，例如填 `300`、`600` 表示随机 5～10 分钟；两项相同则固定等待，两项都为 `0` 则不额外等待。等待时日志显示随机时长和预计开始时间，可以正常停止容器。
- 每个账号使用独立浏览器，间隔期间浏览器已关闭；已完成账号的结果会及时写入 `last-run.json`。
- 登录使用 Turnstile 验证交互；续期弹窗分别检查 ALTCHA 和 Turnstile。Turnstile 的复选框在组件 iframe 内，每次点击前重新读取可见方框位置，不缓存比例；没有出现 token 时每 5 秒重试一次、最多 4 次（约 20 秒），已勾选或控件消失时只等待结果，不重复点击。ALTCHA 使用[组件公开的 `getState()`、`verify()` 方法](https://altcha.org/docs/integration/widget/)，等待组件加载和计算完成，最长约 2 分钟；验证中不重复触发，失败或超时不提交。只读取当前弹窗的验证状态，避免误用其他表单的旧 token。
- 提交后才出现验证时保留当前页面，等待验证完成后再提交；最多提交 3 次，每个账号处理上限 15 分钟（账号间等待不计入）。验证码、页面变化或账号错误会导致失败，不保证线上验证必然通过。
- 网站明确提示未到续期时间时，记录提示并跳过提交；能进入服务器详情时仍会读取并保存 Expiry。页面提供 `as of ...` 时间时记录原文，不自行换算平台时区。
- 只有页面明确报告续期成功才记录 `renewed`；未到续期时间为 `skipped`；提交后无明确结果为 `unconfirmed`，需要检查截图。仅弹窗关闭不会被当作成功。
- 续期成功后重新打开详情页读取新 Expiry。只有读到比原来更晚的有效日期才保存；读取失败或日期尚未更新时清除旧日期，下一天 10:00 重新读取，不自行推算新到期日。
- 账号配置读取或浏览器启动失败也会更新本轮结果，并发送已配置的 Telegram 批次失败通知；主动停止记录为 `interrupted`，不发送失败告警。
- Xvfb 异常退出时，入口会停止 Node 并以非零状态退出，由 Compose 的重启策略恢复显示器和调度器；正常停止会转发信号并清理子进程。
- 单次运行失败返回非零退出码；常驻模式记录失败后等待下一轮，避免无间隔重试。
- `docker-compose.yaml` 环境变量修改后执行 `docker compose up -d --force-recreate`；`login.json` 每轮重新读取，替换账号文件后建议重建容器挂载。

手动执行一次（同样遵守缓存、10:00 及当天去重规则；先停止常驻实例，避免两个进程同时续期）：

```sh
docker compose stop renew
docker compose run --rm renew --once
docker compose up -d
```

查看运行状态和资源占用：

```sh
docker compose ps
docker compose stats --no-stream
```

## 截图与结果

使用命名卷 `renew-data` 持久保存 `/app/data`。每个账号仅保留一张最新截图，文件名使用账号哈希；`last-run.json` 原子更新最近一轮的起止时间、状态、完成标志和账号结果；启动失败不会继续显示上一轮成功。截图可能包含个人信息。普通 `docker compose down` 保留数据；`down -v` 会删除数据卷。

`accounts.json` 按账号哈希保存 Expiry 和最近一次尝试的北京时间日期，不存邮箱、密码或登录会话。原子写入，重启后继续使用。缓存格式损坏时停止本轮并提示检查，不覆盖原文件。若在网页上更换了服务器或手动调整了到期日，需要更新或清除对应账号的本地记录，才能立即重新获取。纯缓存跳过时只更新日志和结果，不发送 Telegram，也不覆盖上一张截图。

`sessions/<账号哈希>.json` 使用 [Playwright 登录状态保存功能](https://playwright.dev/docs/auth) 独立保存各账号的 Cookie、localStorage 和 IndexedDB，确认登录后及任务结束时更新。文件权限为 `600`，跟随数据卷保留，容器重建后可继续使用；不需要一直运行浏览器。文件包含可用于登录的敏感凭据，不要上传、分享或提交到仓库。删除某账号的状态文件后，下次实际访问会重新登录；`login.json` 中的密码仍需保留，以便会话失效时使用。

导出截图、结果与状态（也包含敏感登录状态，请妥善保管）：

```sh
docker compose cp renew:/app/data ./results
```

Telegram 使用 Node 原生 HTTP 请求发送，不拼接 shell 命令；浏览器代理仅作用于浏览器，Telegram 请求直接访问 API。

## 实现、依赖与验证

Playwright 管理 Chromium 的启动和清理，Xvfb 提供虚拟显示器。应用源码、`Dockerfile`、npm 清单和锁文件都放在 `app/`；使用官方 [Playwright Docker 镜像](https://playwright.dev/docs/docker)，镜像与 npm 包固定到相同版本 `1.63.0`。Compose 开启 init 管理进程回收和日志轮转。

项目使用 `playwright-extra` 4.3.6 与 `puppeteer-extra-plugin-stealth` 2.11.2，未再增加调度或 HTTP 库。Playwright 使用 Apache-2.0，两个插件使用 MIT；插件版本较旧，不承诺长期适配网站。Playwright npm 包约 5 MB，两插件合计约 0.6 MB（均未含传递依赖）；主要磁盘和内存成本来自浏览器。验证交互集中在 `app/challenge.js`。

部署检查：

```sh
docker compose run --rm renew --check
```

此检查会校验账号文件并启动 Chromium 打开本地页面，不访问 Katabump、不登录也不续期。

真实 Katabump 登录、Cloudflare 页面验证、续期成功及 Telegram 通知，需要在目标实例填入真实配置后验证。容器启动或模拟测试通过不等于线上续期已成功。
