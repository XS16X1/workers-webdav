# r2-webdav

[![CI](https://github.com/XS16X1/r2-webdav/actions/workflows/ci.yml/badge.svg)](https://github.com/XS16X1/r2-webdav/actions/workflows/ci.yml)
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/XS16X1/r2-webdav)

在 Cloudflare Workers 上为 R2 存储桶提供标准 **WebDAV** 接口（Class 1 + Class 2，含 LOCK/UNLOCK）。
支持 Windows 网络驱动器映射、rclone、Cyberduck、Finder（macOS）等任意 WebDAV 客户端。

## ✨ 零配置一键部署

**不需要手动创建 R2 存储桶，不需要任何预先设置。** 两种全自动方式任选其一：

### 方式一：点击按钮直接部署

1. 把本仓库上传到你的 GitHub（或点击上方按钮）
2. 点击 README 顶部的 **Deploy to Cloudflare** 按钮
3. 登录 Cloudflare → 点击 **Deploy** → 完成

部署时 Cloudflare 会自动完成全部资源配置：

| 资源                         | 如何自动配置                                       |
| ---------------------------- | -------------------------------------------------- |
| **R2 存储桶**（`r2-webdav`） | 根据 `wrangler.toml` 自动创建，无需手动建桶        |
| **Worker 本体**              | 自动构建并部署                                     |
| **访问凭据**                 | 部署时随 `[vars]` 写入默认运行时变量（见「凭据」） |
| **日志观测**                 | `wrangler.toml` 内已预置                           |

### 方式二：Cloudflare 绑定 GitHub 仓库自动部署

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Import a repository**
2. 授权 GitHub 账号，选择本仓库
3. 保持默认构建设置（无需构建命令，直接 `npx wrangler deploy`）→ **Save and Deploy**

之后**每次 push 到 `main` 分支都会自动构建部署**，且同样根据 `wrangler.toml`
自动创建 R2 存储桶等全部资源（Workers Builds 自动签发的部署令牌自带
`Workers R2 Storage (edit)` 权限，创建桶无需额外配置）。

## 🔑 凭据：部署时自带默认值，之后自己改

**部署时**，`wrangler.toml [vars]` 中的 `USERNAME` / `PASSWORD` 会作为**运行时变量**直接写入
Worker，服务开箱即用（默认 `admin` / `admin`）。**部署完成后请立即改成你自己的值**
（默认值随仓库公开可见）。

**凭据只来自运行时变量与密钥**——Worker 不会生成任何凭据，也**不会往存储桶里写入任何凭据对象**：

| 配置状态                   | 实际生效的凭据                                       |
| -------------------------- | ---------------------------------------------------- |
| 运行时变量 / 密钥已设置    | **100% 使用该值**（默认值或你改过的值），即时生效    |
| 变量缺失或为空（异常情况） | 使用内置兜底默认值 `admin` / `admin`，并打印日志警告 |

### 修改凭据（任选一种，保存即生效，无需重新部署）

**方式 A：Dashboard 加密变量 / 密钥（推荐）**

Workers & Pages → 你的 Worker → **Settings → Variables and Secrets** → **Add**，
添加 `USERNAME`、`PASSWORD` 两个变量，类型选 **Encrypt**（加密即密钥）：

- 加密密钥**优先于同名明文变量**，且**不会被后续部署覆盖**——改完一直有效

> ⚠️ 使用 Git 集成部署时请注意：**Build variables 只在构建期可见，运行时读不到**。
> 凭据必须配置在 **Runtime** 分组（即上面的 Variables and Secrets 页面），否则 Worker 读不到。

**方式 B：wrangler secret（加密密钥）**

```bash
wrangler secret put USERNAME
wrangler secret put PASSWORD
```

**方式 C：直接修改 wrangler.toml 中的 [vars]**

```toml
[vars]
USERNAME = "你的一用户名"
PASSWORD = "你的密码"
```

改完 push，下次部署自动生效（Git 集成下每次 push 都会重新应用 `[vars]`）。

## 📁 使用

部署完成后得到形如 `https://r2-webdav.<你的子域>.workers.dev` 的地址，把它当作 WebDAV URL：

```bash
# rclone 示例
rclone config
#   storage → webdav
#   url → https://r2-webdav.<你的子域>.workers.dev
#   vendor → other
#   user / pass → 你的 USERNAME / PASSWORD（默认 admin/admin，建议先修改）

# Windows：资源管理器「映射网络驱动器」直接输入该地址
# macOS Finder：前往 → 连接服务器 → 该地址
```

浏览器直接访问根地址会看到文件列表网页（可直接下载）。

## ⚙️ 可选配置

全部配置都有安全默认值，**不配置也能直接用**：

| 变量                    | 默认值  | 说明                                               |
| ----------------------- | ------- | -------------------------------------------------- |
| `USERNAME` / `PASSWORD` | `admin` | 访问凭据，部署时随 `[vars]` 写入；**部署后请修改** |
| `MAX_LIST_ENTRIES`      | `10000` | 目录列表 / PROPFIND 返回条目上限，`0` 为不限制     |

## 🛠 本地开发

```bash
npm install
npm run dev        # 本地启动 http://localhost:8787（自动创建本地桶）
```

本地凭据可在 `.dev.vars` 中设置（已被 `.gitignore` 忽略）：

```
USERNAME=admin
PASSWORD=admin
```

## ✅ 质量校验

```bash
npm run typecheck  # TypeScript 严格类型检查
npm run lint       # ESLint
npm run check      # 以上全部 + 格式检查
```

CI 中还会用 [litmus](https://github.com/notroj/litmus) 官方一致性套件对
`wrangler dev --local` 运行 `basic`、`copymove`、`props`、`locks` 四组测试
（`http` 套件因本地 Workers 对 `Expect: 100-continue` 应答超时暂未启用）。

## 🔧 相对上游的修复与增强

- **锁系统外置**：锁记录存储在独立小对象（`.__webdav/locks/…`），大文件
  LOCK/UNLOCK 不再整读整写文件本体，加锁耗时与文件大小无关
- **流式上传**：PUT 直接把请求流管道写入 R2，不再整包缓冲进内存
- **凭据即运行时变量**：部署时随 `[vars]` 写入默认值开箱即用，之后用加密变量 /
  secret 自行修改；**不生成、不往桶里存任何凭据**
- **并发闸门**：递归 COPY/MOVE/DELETE 限流并发，大目录不再瞬间打爆 R2
- **`If` 头完整解析**：支持资源标签、`Not`、括号分组、etag 条件（RFC 4918 §10.4）
- **MOVE 锁迁移**：锁随资源移动且 `lockroot` 同步更新（RFC 4918 §9.9.1）
- **COPY 覆盖清理**：文件覆盖目录时先清空目标，不再遗留孤儿对象
- **UNLOCK 语义修正**：无效 token 返回 409（RFC 4918 §9.11.1）
- **`MS-Author-Via: DAV`**：Windows 网络驱动器映射兼容
- **健壮性**：损坏的元数据 JSON 不再导致 500；`resourcetype` 白名单防 XML 注入
- **隐藏内部对象**：`.__webdav/` 前缀永不对外暴露
- **工程质量**：ESLint + Prettier + 类型检查 + 双 workflow CI，日志采样率降为 10%

## 📄 License

[Apache License 2.0](LICENSE) © abersheeran
