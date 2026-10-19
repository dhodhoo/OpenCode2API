# 🐳 Docker 部署

## 🚀 快速开始

```bash
git clone https://github.com/TiaraBasori/opencode2api.git
cd opencode2api
cp .env.example .env    # 编辑 .env，必填 API_KEY 与 OPENCODE_SERVER_PASSWORD
docker compose up -d

# 验证
curl http://127.0.0.1:10000/health
curl -H "Authorization: Bearer $API_KEY" http://127.0.0.1:10000/v1/models
```

## ⚙️ 配置

`.env` 常用项（完整列表见 [配置详解](./configuration.md)）：

```env
# 必填
API_KEY=change-me
OPENCODE_SERVER_PASSWORD=change-me-too

# 安全
OPENCODE_DISABLE_TOOLS=true

# 可选
OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true
OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS=true
```

## 📦 卷挂载

| 卷名 | 容器内路径 | 说明 |
|:-----|:----------|:-----|
| `opencode-data` | `/home/node/.local/share/opencode` | OpenCode 数据目录 |
| `opencode-config` | `/home/node/.config/opencode` | OpenCode 配置目录 |

项目源码在构建时复制到镜像内的 `/home/node/project`，默认不挂载宿主机目录，避免覆盖镜像内已安装的 `node_modules`。

## 🔨 自定义构建

```bash
# 构建镜像
docker build -t my-opencode2api .

# 运行单个容器
docker run -d \
  -p 10000:10000 \
  -e API_KEY=your-key \
  -e OPENCODE_SERVER_PASSWORD=your-password \
  -v opencode-data:/home/node/.local/share/opencode \
  -v opencode-config:/home/node/.config/opencode \
  my-opencode2api
```

## ☁️ Railway

开箱即用的文件：仓库根目录的 `railway.json`（Dockerfile 构建、`/health` 探测）以及
[`deploy/railway/`](../../deploy/railway/README.md)（变量模板 + 代理与 relay 两个服务的
分步说明）。

已发布的镜像可以直接作为 Railway 服务运行。

1. **New Project → Deploy from Docker Image** →
   `ghcr.io/tiarabasori/opencode2api:latest`，或使用自己 fork 的镜像
   （`ghcr.io/<owner>/opencode2api:latest`，需先跑过发布工作流）。
2. **Variables**：
   - `API_KEY=...` 与 `OPENCODE_SERVER_PASSWORD=...`（公网地址必须鉴权）
   - `OPENCODE_DISABLE_TOOLS=true`
   - 可选：`OPENCODE_WEB_PANEL_ENABLED=true`、`OPENCODE_METRICS_ENABLED=true`
   - 可选代理池：`OPENCODE_PROXY_POOL='[{"name":"direct","type":"direct"},{"name":"relay","type":"relay","url":"https://relay-xxxx.up.railway.app"}]'`
   - **不要**设置 `OPENCODE_PROXY_PORT`：Railway 会注入 `PORT`，代理监听该端口
     （若设置 `OPENCODE_PROXY_PORT` 会覆盖它并导致路由失败）。
3. **Settings → Networking → Generate Domain**，目标端口填注入的 `PORT`。
4. 可选 **Volume** 挂载到 `/home/node/.local/share/opencode`，用于持久化
   OpenCode 认证与会话存储。
5. 健康检查路径：`/health`。

从 fork 自行构建镜像：为 fork 启用 GitHub Actions，把分支合入 `main`，工作流会发布
`ghcr.io/<owner>/opencode2api:latest`。拉取前请把该 package 设为公开
（Package settings → Change visibility），或给 Railway 配置 registry 凭据。

**在 Railway 上跑 relay**：用同一个仓库再建一个服务，Root Directory 设为
`relay/railway`、Builder 选 Dockerfile，详见
[`relay/railway/README.md`](../../relay/railway/README.md)。然后把它的地址加入
`relay` 类型的池条目。注意：与代理处于同一项目/区域的 relay 共享同一批出口 IP，
只能提供故障转移，无法实现 IP 轮换。

**内存**：单个 `opencode serve` 后端约占 0.7–1 GB；N 个池条目会在同一容器内运行
N 个后端。

## 📊 日志管理

```bash
# 查看日志
docker compose logs -f
```

推荐在 Compose 中配置日志轮转：

```yaml
logging:
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "3"
```

## ✅ 健康检查

Compose 已内置健康检查：

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:10000/health"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 60s
```

## ❓ 常见问题

- **容器无法启动**：`docker compose logs` 查看日志，确认端口未被占用。
- **挂载权限问题**：确保 PUID/PGID 配置正确（默认 1000:1000）。
