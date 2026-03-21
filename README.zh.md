# Xbin

**_[English](./README.md)_**

[![Codecov](https://codecov.io/github/xixu-me/xbin/graph/badge.svg?token=K95DX723UT)](https://codecov.io/github/xixu-me/xbin)
[![CI](https://github.com/xixu-me/xbin/actions/workflows/ci.yml/badge.svg)](https://github.com/xixu-me/xbin/actions/workflows/ci.yml)
[![CodeQL](https://github.com/xixu-me/xbin/actions/workflows/github-code-scanning/codeql/badge.svg)](https://github.com/xixu-me/xbin/actions/workflows/github-code-scanning/codeql)
[![Deploy](https://github.com/xixu-me/xbin/actions/workflows/deploy.yml/badge.svg)](https://github.com/xixu-me/xbin/actions/workflows/deploy.yml)

Xbin 是一个构建在 Cloudflare Workers 之上的、类似 PrivateBin 的端到端加密 Pastebin。它包含一个用于创建和读取加密内容的浏览器应用、一个现代 JSON API，以及一个兼容旧版 PrivateBin 的接口层，方便迁移和互操作。

所有内容都会先在浏览器中完成加密，再上传到服务端。Worker 仅将加密后的载荷存储到 R2，将生命周期元数据存储到 D1，并借助 Durable Objects 与 Queues 处理阅后即焚声明和后台清理任务。

## 特性亮点

- 浏览器端加密，分享密钥通过 URL fragment 传递
- 支持可选密码、过期时间、阅后即焚链接，以及每条内容独立的删除令牌
- 支持纯文本、代码高亮和 Markdown 渲染
- 支持加密附件上传、下载与预览
- 支持兼容粘贴内容的讨论线程
- 提供位于 `/api/v1/*` 的现代 REST API
- 支持兼容旧版 PrivateBin 的 API，以及文件系统导入工具
- 原生运行在 Cloudflare 平台之上，使用 Workers、D1、R2、Durable Objects、Queues 和定时清理

## 安全模型

1. 浏览器生成随机密钥，并在上传前完成内容加密。
2. Worker 仅在 R2 中保存加密信封，在 D1 中保存元数据。
3. 分享链接通过查询参数携带 paste id，通过 URL fragment 携带解密密钥，例如 `https://paste.example.com/?abcdef1234567890#secretKey`。fragment 不会发送给服务器。
4. 如果设置了可选密码，客户端会在解密前使用 PBKDF2 将密码与 fragment 密钥组合。
5. 任何拿到完整分享 URL 的人都可以解密内容。删除令牌与分享链接分离，且仅在创建或导入 paste 时返回。

## 架构

| 组件              | 职责                                                       |
| ----------------- | ---------------------------------------------------------- |
| Cloudflare Worker | HTTP API、静态资源分发、SEO 元数据重写、配置接口和导入鉴权 |
| Durable Object    | 串行化处理阅后即焚的声明与消费操作                         |
| D1                | Paste 和评论的元数据、生命周期状态、删除令牌哈希、焚毁声明 |
| R2                | 加密后的 paste 与评论载荷 blob                             |
| Queue             | 异步清理已过期、已删除和已焚毁的内容                       |
| Cron trigger      | 每分钟释放过期的焚毁声明并扫描已过期的 paste               |
| `assets/` SPA     | 在浏览器中完成加密、解密、渲染和分享                       |

## 快速开始

### 前置条件

- [Bun](https://bun.sh/)
- 一个可使用 Workers、D1、R2、Queues 和 Durable Objects 的 Cloudflare 账号
- 如果你计划在本机部署，需要本地已完成 Wrangler 登录认证

### 安装依赖

```sh
bun install
```

### 创建 Cloudflare 资源

首次部署前，请先创建你自己的资源，然后将 [`wrangler.jsonc`](./wrangler.jsonc) 中的名称和 ID 替换为你账号下的值。

```sh
bunx wrangler d1 create xbin
bunx wrangler r2 bucket create xbin-pastes
bunx wrangler queues create xbin-gc
```

说明：

- 当前存储库中的 `wrangler.jsonc` 已包含具体的 D1 和 R2 标识符。如果你要 fork 或部署自己的实例，请务必替换成你自己账号中的值。
- 你只需要手动创建 D1、R2 和 Queue。Durable Object 绑定以及对应的 SQLite 类已经在 `wrangler.jsonc` 中声明，会在部署和迁移时自动创建。
- 当前存储库设置了 `workers_dev = false`。部署你自己的 fork 前，请先在 `wrangler.jsonc` 中配置自己的路由或自定义域名，或者将其改为 `workers_dev = true`，这样应用才会有可访问的主机名。
- 变更绑定或环境变量后，请重新生成 Worker 类型：

```sh
bun run cf-typegen
```

### 配置本地密钥

将 [`.dev.vars.example`](./.dev.vars.example) 复制为 `.dev.vars`，并填写你要使用的可选密钥：

```sh
Copy-Item .dev.vars.example .dev.vars
```

可用密钥：

- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET_KEY`
- `IMPORT_TOKEN`

大多数非敏感的运行时默认值都位于 [`wrangler.jsonc`](./wrangler.jsonc) 的 `vars` 段中。

### 本地运行

```sh
bun run dev
```

Wrangler 会通过同一个 Worker 入口同时提供 SPA 和 API。

### 通过 GitHub Actions 部署

默认的部署路径是 GitHub Actions。如果你要部署自己的实例，建议从 [xixu-me/xbin](https://github.com/xixu-me/xbin/fork) fork 开始。

发布流程如下：

1. 在你的 fork 中，把 `CLOUDFLARE_ACCOUNT_ID` 和 `CLOUDFLARE_API_TOKEN` 配置为 GitHub Actions secrets。
2. 向你 fork 的 `main` 分支推送代码。
3. [`CI`](./.github/workflows/ci.yml) 会运行格式检查、类型检查、Wrangler 类型校验、带覆盖率的测试，以及 Wrangler 部署 dry run。
4. 如果该次 `main` 推送通过了 CI，[`Deploy`](./.github/workflows/deploy.yml) 会发布通过校验的同一份提交。

Pull Request 同样会运行 CI，但不会自动部署。你也可以在自己的 fork 中通过 `workflow_dispatch` 手动触发部署流程。

部署工作流最终执行的是：

```sh
bunx wrangler deploy --keep-vars --message "GitHub Actions deploy for ${GITHUB_SHA}"
```

`--keep-vars` 表示除非你有意在 Cloudflare 或部署配置中修改，否则远端 Worker 变量会被保留。

### 本地手动部署

如果你需要绕过 GitHub Actions，在本地直接部署：

```sh
bun run deploy
```

## 常用命令

| 命令                    | 用途                               |
| ----------------------- | ---------------------------------- |
| `bun run dev`           | 使用 Wrangler 在本地运行 Worker    |
| `bun run start`         | 本地 Wrangler 开发的别名           |
| `bun run check`         | 对 TypeScript 代码库执行类型检查   |
| `bun run test`          | 使用 Vitest 运行 Worker 集成测试   |
| `bun run test:coverage` | 运行测试并输出 Istanbul 覆盖率报告 |
| `bun run format`        | 使用 Prettier 格式化整个存储库     |
| `bun run format:check`  | 检查格式但不修改文件               |
| `bun run cf-typegen`    | 在配置变化后刷新 Worker 绑定类型   |
| `bun run deploy`        | 发布 Worker                        |

## 配置项

| 变量                          | 默认值                                                      | 用途                                                |
| ----------------------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| `XBIN_APP_NAME`               | `Xbin`                                                      | UI 和元数据中显示的品牌名                           |
| `XBIN_APP_VERSION`            | `1.0.0`                                                     | 在应用配置接口和页脚中暴露的版本号                  |
| `XBIN_PROJECT_PAGE_URL`       | `https://github.com/xixu-me/xbin`                           | UI 中显示的项目链接                                 |
| `XBIN_BASE_PATH`              | `/`                                                         | 用于构建分享链接、规范 URL 和站点地图链接的挂载路径 |
| `XBIN_MAX_PASTE_BYTES`        | `10000000`                                                  | 加密 paste 载荷的最大字节数                         |
| `XBIN_DEFAULT_EXPIRATION`     | `1hour`                                                     | UI 和 API 使用的默认过期键                          |
| `XBIN_SUPPORTED_EXPIRATIONS`  | `5min,10min,30min,1hour,3hour,6hour,12hour,1day,3day,1week` | 应用暴露的过期键列表，逗号分隔                      |
| `XBIN_ENABLE_LEGACY_API`      | `true`                                                      | 是否启用兼容 PrivateBin 的旧版 JSON API             |
| `XBIN_REQUIRE_TURNSTILE`      | `false`                                                     | 是否要求在创建 paste 和评论时传入 `turnstileToken`  |
| `XBIN_BURN_CLAIM_TTL_SECONDS` | `120`                                                       | 阅后即焚声明在释放前可保留的秒数                    |
| `TURNSTILE_SITE_KEY`          | 未设置                                                      | 启用 Turnstile 时暴露给客户端的站点密钥             |
| `TURNSTILE_SECRET_KEY`        | 未设置                                                      | Worker 用于校验 Turnstile 令牌的密钥                |
| `IMPORT_TOKEN`                | 未设置                                                      | 启用并保护 PrivateBin 导入接口                      |

配置解析器还支持 `1month`、`1year` 和 `never` 这些过期键，只要你愿意将它们暴露给客户端即可。

## API 概览

写入 API 接收的是经过加密的、PrivateBin 风格的信封对象，而不是明文内容。一个最小创建请求示例如下：

```json
{
	"v": 2,
	"adata": [["iv", "salt", 100000, 256, 128, "aes", "gcm", "none"], "plaintext", 0, 0],
	"ct": "ciphertext",
	"meta": { "expire": "1day" }
}
```

核心接口：

| 方法     | 路径                              | 用途                                                |
| -------- | --------------------------------- | --------------------------------------------------- |
| `GET`    | `/api/v1/config`                  | 返回运行时 UI 和功能配置                            |
| `POST`   | `/api/v1/pastes`                  | 创建 paste，并返回 `{ id, shareUrl, deleteToken }`  |
| `GET`    | `/api/v1/pastes/:id`              | 返回加密 paste 信封和评论                           |
| `DELETE` | `/api/v1/pastes/:id`              | 在提供 `{ "deleteToken": "..." }` 时删除 paste      |
| `POST`   | `/api/v1/pastes/:id/comments`     | 为启用讨论的 paste 创建评论                         |
| `POST`   | `/api/v1/pastes/:id/consume`      | 使用 `{ "claimToken": "..." }` 完成一次阅后即焚读取 |
| `POST`   | `/api/v1/admin/import/privatebin` | 在授权后导入 PrivateBin 文件系统数据                |

说明：

- 对于阅后即焚的 paste，`GET /api/v1/pastes/:id` 会返回一个 `claimToken`。客户端在成功解密后必须继续调用 `/consume`。
- 启用 Turnstile 后，在创建 paste 和创建评论的请求体中都需要包含 `turnstileToken`。
- 阅后即焚 paste 不支持评论。

## PrivateBin 兼容性与导入

Xbin 提供两种兼容路径：

- 通过 `X-Requested-With: JSONHttpRequest` 识别旧版 JSON API 调用。
- 对于 `/api/v1/pastes?<pasteId>` 这类旧版浏览器分享 URL，返回 SPA 外壳页面，让客户端在本地恢复分享内容。

如果要从 PrivateBin 的文件系统导出中导入数据，先为 Worker 设置 `IMPORT_TOKEN`，然后执行：

```sh
bun run import:privatebin:fs -- --source /path/to/privatebin/data --base-url https://paste.example.com --token your-import-token --report ./import-report.json
```

导入器会：

- 遍历 `*.php` paste 文件及其相邻的 `.discussion/` 目录
- 在可用时保留创建时间和过期时间元数据
- 跳过已经过期的 paste
- 为每条导入后的 paste 返回一个新的 `deleteToken`，因为 Xbin 会在导入时重新生成删除凭证

## 存储库结构

| 路径                             | 用途                                                          |
| -------------------------------- | ------------------------------------------------------------- |
| [`src/index.ts`](./src/index.ts) | Worker 入口，负责 HTTP 路由、静态资源分发、定时清理和队列处理 |
| [`src/lib/`](./src/lib)          | 配置解析、校验、数据访问、Schema 和共享类型                   |
| [`assets/`](./assets)            | 浏览器应用、HTML 外壳、CSS 和 vendored 客户端库               |
| [`scripts/`](./scripts)          | 一次性工具，例如 PrivateBin 文件系统导入器                    |
| [`migrations/`](./migrations)    | D1 Schema 迁移                                                |
| [`test/`](./test)                | Worker 集成测试和仓储层测试                                   |

## 测试与质量

本存储库使用带 Cloudflare Workers 运行池的 Vitest、TypeScript 类型检查、Wrangler 类型校验和 Prettier 格式化。CI 还会在允许生产部署前执行一次 Wrangler 部署 dry run。Codecov 配置了 95% 的项目覆盖率和 90% 的补丁覆盖率目标，因此除文档外，代码改动通常都应附带测试。

与主要 CI 质量门槛一致的一组本地校验命令如下：

```sh
bun run format:check
bun run check
bunx wrangler types --check
bun run test:coverage
```

## 相关文档

- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [SECURITY.md](./SECURITY.md)
- [SUPPORT.md](./SUPPORT.md)
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)

## 许可证

本项目基于 GNU Affero General Public License v3.0 发布。完整条款请参见 [`LICENSE`](./LICENSE)。
