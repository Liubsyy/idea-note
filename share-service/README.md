# Idea Note 分享服务

[English](./README.en.md)

独立的 Markdown 分享服务，提供阅读页、发布 API 和管理后台。共享渲染源码位于 `renderer/`，桌面编辑器通过兼容入口使用同一份源码；此目录可以整体复制到其他仓库。

## 开发与运行

本机运行和自动化测试均不需要 Docker，也不需要 Cloudflare 账号。需要 Node.js 24 或更新版本；Docker 仅作为可选的部署方式。在 Idea Note 仓库根目录执行：

```sh
npm ci
npm run build:sharing
ADMIN_PASSWORD='设置至少12字符的随机管理员密码' npm start --workspace idea-note-share-service
```

访问 `http://localhost:8787/admin` 登录后台，创建发布密钥。桌面应用的“设置 → 分享服务”填写服务根地址 `http://localhost:8787` 和刚创建的密钥，然后在 Markdown 编辑区点击“分享”。HTTP 仅用于 localhost 开发；远程服务请配置 HTTPS。

自动化验证可在仓库根目录执行 `npm run test:sharing`。Cloudflare 测试使用本地 workerd 和模拟 B2 接口，无需登录或创建云端资源。

前端热更新：保留上面的后端进程，另开终端运行 `npm run dev --workspace idea-note-share-service`，访问 `http://localhost:1430`。开发时不要给后端设置不同来源的 `PUBLIC_ORIGIN`。

独立迁移代码：复制整个 `share-service/` 目录，在复制后的目录中执行 `npm ci && npm run build`。无需 Idea Note 的其他源码或 Tauri。目录内单独保留了 `package-lock.json`，仓库内的完整安装则使用根目录 workspace 锁文件。

## Cloudflare 部署

采用 Workers + Static Assets + D1 + 私有 Backblaze B2，阅读页与后台随 Worker 一起部署，无需开通 R2。D1 保存元数据，B2 保存正文和附件；Node/Docker 也可选择同一个 B2 适配器。

### 创建 B2 存储桶与密钥

1. 在 Backblaze B2 控制台创建 **Private** 存储桶，记录 Bucket ID 和 Bucket Name。不启用 Object Lock，以便取消后的清理能删除文件。
2. 在 Application Keys 创建只允许访问该桶的应用密钥，选择 **Read and Write**，保存 `keyID` 和只显示一次的 `applicationKey`。所需能力为 `listFiles`、`readFiles`、`writeFiles`、`deleteFiles`。可以将文件名前缀限制为 `idea-note-share/`。
3. 使用 B2 原生 API，不需要 S3 Endpoint、区域、主密钥、公开下载域名或浏览器 CORS 配置。参考 [B2 授权文档](https://www.backblaze.com/apidocs/b2-authorize-account)。

所有文件通过服务接口鉴权后读取。保持桶私有，避免原始下载地址绕过分享撤销。密钥只放在服务端环境变量或 Wrangler Secret 中，不填写在桌面应用或网页里。

### 部署 Worker

```sh
cd share-service
npm run build
npx wrangler login
npx wrangler d1 create idea-note-share
```

将 D1 返回的 database ID 填入 `wrangler.jsonc` 的 `database_id`，同时填写 `vars.B2_BUCKET_ID` 和 `vars.B2_BUCKET_NAME`。`B2_PREFIX` 默认 `idea-note-share/`；不同实例必须使用不同前缀或存储桶，避免清理任务互相删除文件。前缀必须是以 `/` 结尾的相对目录，段内可用字母、数字、下划线和连字符。

```sh
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put B2_APPLICATION_KEY_ID
npx wrangler secret put B2_APPLICATION_KEY
npm run migrate:remote
npm run deploy
```

`ADMIN_PASSWORD` 至少 12 个字符，应使用随机长密码。它只保存在部署环境，不会进入阅读页或后台的浏览器代码。部署输出的 Worker 地址可直接作为服务根地址，也可在 Cloudflare 中绑定自定义域名。

本地 Cloudflare 开发：复制 `.dev.vars.example` 为 `.dev.vars` 并填写密码和 B2 配置，执行 `npm run migrate:local` 和 `npm run dev:cloudflare`。**D1 是本地模拟，B2 仍访问真实云端**，必须使用独立开发桶或前缀；`.dev.vars` 不纳入版本控制。自动化测试中的 B2 完全模拟，不访问真实账号。每小时 Cron 运行清理，Cloudflare 版本每次最多处理 10 个对象名，积压文件在后续运行继续回收；每个对象的历史版本和隐藏标记一并永久删除。管理员登录限速使用 Cloudflare 提供的 `CF-Connecting-IP`。

如果原来已经在 R2/本地磁盘中存有分享，先在旧服务后台导出备份，再部署使用新 D1/SQLite 和空 B2 前缀的实例，通过后台恢复。仅更换存储配置不会自动搬运已有文件，不能直接让旧数据库指向空桶。迁移完成并核对内容后再切换域名。

### 后续更新部署
更新代码执行

```sh
npm run build
npm run migrate:remote -- --config wrangler.private.jsonc
npm run deploy -- --config wrangler.private.jsonc
```

密钥会保留，无需重复执行 `secret put`，也无需重新创建数据库或 B2 桶。没有新数据库迁移时会自动跳过。保持首次部署成功的 `wrangler.jsonc` 配置；如果依赖有变化，先在项目根目录执行 `npm ci`。

## Node / Docker 部署

```sh
cd share-service
cp .env.example .env
# 编辑 .env，设置 ADMIN_PASSWORD 和对外的 HTTPS PUBLIC_ORIGIN

docker compose up --build -d
```

默认仅将 8787 端口绑定到宿主机回环地址，生产环境通过反向代理提供 HTTPS。默认数据库和附件在 `share-data` 数据卷中；更新容器时保留该数据卷。

若云服务器也使用 B2，在 `.env` 中设置 `OBJECT_STORAGE=b2`，并填写 `B2_BUCKET_ID`、`B2_BUCKET_NAME`、`B2_PREFIX`、`B2_APPLICATION_KEY_ID`、`B2_APPLICATION_KEY`；Compose 已转发这些配置。SQLite 仍保存在 `share-data`，正文和附件写入 B2。默认 `OBJECT_STORAGE=local` 继续使用本地磁盘。直接 Node 运行时通过环境变量设置相同配置。

不使用 Docker 时，可直接运行：

```sh
ADMIN_PASSWORD='随机长密码' DATA_DIR=/path/to/share-data PUBLIC_ORIGIN=https://share.example.com node server/node.mjs
```

`PORT` 默认 8787，`DATA_DIR` 默认当前目录的 `data/`。`PUBLIC_ORIGIN` 是反向代理对外的来源地址，不带路径；管理员请求会校验来源。浏览器跨域发布客户端可按需设置逗号分隔的 `ALLOWED_ORIGINS`。桌面原生 HTTP 不需要配置浏览器 CORS。

Docker Compose 默认 `TRUST_PROXY=1`：端口只绑定在宿主机回环地址，只有本机的反向代理能访问，信任一层代理是安全的；如果改为对外暴露端口，请设为 `0`。直接运行 Node 时 `TRUST_PROXY` 默认不设置，此时管理员登录限速按 TCP 连接的对端地址计算。经反向代理访问时，该地址是代理本身，所有访客会共用一个限额，任何人连续输错密码都会让管理员无法登录。此时将 `TRUST_PROXY` 设为服务前方的代理层数，例如单个 nginx 或 Caddy 设为 `1`，Cloudflare 代理再加 nginx 设为 `2`。服务从 `X-Forwarded-For` 末尾倒数，取最外层可信代理记录的客户端地址，忽略更左侧可能由客户端伪造的条目。代理必须追加该请求头，例如 nginx 的 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`。只有在服务端口仅能被代理访问时才设置 `TRUST_PROXY`，否则直连的客户端可以伪造地址绕过限速。未设置却收到 `X-Forwarded-For` 时，服务会在日志中提示一次。

Node 启动时应用幂等数据库结构；后续结构变更应新增编号 SQL 迁移，并同步 Node 启动迁移逻辑。`0002_share_kind.sql` 记录分享类型（笔记或文件夹）：已部署的 Cloudflare 实例升级前需执行 `npm run migrate:remote`，Node 启动时自动应用；旧分享的类型在后台列表首次加载时补全。

## 使用与权限

- 公开分享链接格式为 `https://服务域名/share/分享ID`，更新分享时链接保持不变。
- 桌面 Git 工程将分享关联写入仓库根目录的 `.ideanote/shares.json` 并纳入 Git 跟踪，按 `origin` 远程和仓库内相对路径识别。提交并同步后，其他电脑配置相同服务与发布密钥即可继续更新原链接。旧路径 `.idea-note/shares.json` 会自动迁移到新路径，冲突时优先保留新路径的关联；旧本机关联在打开分享时自动迁移；无受支持远程的目录仍使用本机关联，密钥始终留在本机。文件夹发布始终排除 `.ideanote` 和旧版 `.idea-note` 元数据目录。
- 管理员签发多个密钥；每个发布者只能列出、修改或取消自己的分享。重置密钥保留发布者 ID 和已有分享。原密钥立即失效。
- 禁用或过期的密钥不能写入，已有公开链接继续可读。管理员可以单独下架分享或一键下架某发布者的全部分享。
- 分享默认永久，也可设置 1、7、30 天。更新时可保持原有效期。更新成功后链接不变；上传或版本检查失败时保留旧版本。
- 取消、到期、下架和关闭公开访问后，正文及附件的新请求失效。已被读者下载的副本不受远程取消操作影响。
- 取消或到期满 24 小时后，清理任务永久删除该分享的记录、正文和附件。此前管理员可以恢复已取消的分享，发布者可以更新已到期的分享并设置新的有效期。被管理员下架且未到期的分享保留到管理员删除或恢复。清理每小时运行一次，也可在后台手动执行，每次删除都会记入操作日志。
- 默认每发布者 100 篇、1 GiB；每附件 20 MiB、单篇总量 100 MiB。后台可调整限制，实际上传仍受部署平台的请求限制。已取消或到期的分享在被清理前仍占配额。
- 三个服务开关分别控制新建、更新和公开访问；持有效密钥的发布者仍可取消分享。后台始终可管理服务。
- 后台日志展示最近 100 条，保留 90 天，不记录原始密钥、管理员密码或正文。管理员会话为 8 小时的 HttpOnly、SameSite Cookie；HTTPS 下增加 Secure。
- 管理员登录按客户端限速：每个地址 15 分钟内最多尝试 10 次，IPv6 按 /64 网段合并计算，登录成功后计数清零。达到上限后，即使密码正确也需等待窗口结束；其他地址的失败尝试不影响管理员。反向代理部署需配置 `TRUST_PROXY`。
- 正文、资源和管理接口返回 `no-store`，B2 通过服务接口访问，避免缓存绕过撤销。管理员永久删除后立即停止访问，物理对象由垃圾清理任务回收。B2 删除时按文件版本 ID 永久删除；不使用仅隐藏文件的删除方式。保持每个实例的桶/前缀独立。

## 渲染与内容边界

支持与桌面只读编辑器相同的 Markdown、公式、Mermaid、HTML/SVG、折叠、表格、高亮、代码和图片尺寸。字体、颜色和排版随发布保存；设备缺失的字体使用回退字体。

在桌面侧栏右键文件夹（或工作区空白处）选择“分享文件夹”，可递归发布完整目录。隐藏项和符号链接默认排除，可独立开启；版本控制内部目录始终排除，循环链接会列在排除项中。发布前可检查目录、逐篇脱敏后的正文及敏感路径，内容变化时需重新预览。文件夹以一个分享手动更新，新增、修改和删除一起发布。

文件夹阅读页左侧提供可展开目录，右侧显示选中的文件。默认打开根目录 README，其次为第一篇 Markdown，再次为首个普通文件；支持 `?file=` 直达、刷新和前进后退。图片与常见文本可预览，HTML 和脚本只显示源码，其他文件可下载。窄屏点击“目录”展开导航。管理员预览使用相同布局。新服务兼容旧单篇快照，无需数据库迁移。

单篇分享中，本地图片、附件和结果引用的文件会上传。缺失文件会阻止发布。单篇分享的本地 Markdown 笔记链接不递归上传，需替换为该笔记自己的分享链接；目录不能作为附件。HTTP(S) 外部资源保留原链接。

分享正文会替换加密块与行内加密内容，不包含原始密文、密钥或已解锁明文。只上传当前代码匹配的成功运行结果，以及参数控件的当前值；不会上传终端输出、解释器配置或运行命令。结果快照和附件可能包含发布者主动写入的数据，因此发布前可审阅完整待分享内容。

参数只读，网页不执行任何代码。HTML/SVG 渲染通过共享的 DOMPurify 规则清洗，分享页另外移除 `<style>` 和表单控件，Mermaid 生成的 SVG 也经过同一套清洗；可执行附件采用下载响应，SVG 图片响应另加 sandbox CSP。后台预览在单独的 `/admin/preview/分享ID` 页面中渲染并嵌入弹窗，分享内容的样式无法覆盖后台的管理按钮。该页面禁止加载外部图片，发布者无法借此得知管理员何时预览。本文中的“渲染一致”指只读内容呈现，不包含桌面编辑操作或本机代码执行能力。

## 备份与迁移

后台“备份迁移”下载版本化 ZIP，包含清单、分享正文、附件、发布者与密钥摘要、设置和日志；不包含管理员密码、会话或桌面本地路径关联。后台先获取一致的元数据快照，再逐资源请求并生成 ZIP，避免一次 Worker 调用读取大量 B2 对象触及免费版 50 次外部请求限制。支持文件保存 API 的浏览器会直接写入选定文件；其他浏览器在内存中组装 ZIP，大备份建议使用支持直接写盘的浏览器。

在目标**空实例**登录后台，选择恢复备份。浏览器逐文件上传，最后原子提交元数据，因此大备份不需要单次上传整个 ZIP。单资源上限 100 MiB、清单上限 16 MiB；发布默认限制低于这些值。失败时中止暂存恢复并清理临时资源；Cloudflare 中止时最多立即删除 10 个对象，其余私有临时对象超过 24 小时后由清理回收。意外断线遗留的恢复任务在 24 小时后回收。

导入可在 Cloudflare 和 Node 之间往返，保留分享 ID、归属、密钥摘要、有效期与内容。把原域名切换到目标实例后，原分享链接保持不变；管理员密码需在目标部署独立设置。恢复期间阻止签发新密钥；恢复仅允许一次进入空实例，不覆盖已有业务数据。

## API 与验证

API 契约见 [API.md](./API.md)。

```sh
# 仓库根目录
npm run build
npm run build:sharing
npm run test:sharing
npm run test:worker --workspace idea-note-share-service
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml sharing::tests
```

服务测试包含 SQLite/D1 的权限、配额、生命周期、并发版本、撤销、附件安全和备份测试。B2 测试覆盖二进制与校验和、鉴权刷新、分页、历史版本删除及错误处理。集成测试运行本地 workerd D1、模拟 B2 和文件持久化的 Node SQLite，并验证双向备份迁移；Worker 成品测试拦截出站请求验证 B2 协议，不需要真实密钥或 R2。需要允许在本机监听端口。独立目录内运行 `npm test` 验证服务。
