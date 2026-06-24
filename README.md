# MCP HTML 部署服务器 (Nginx 静态文件托管)

这是一个企业级的 Model Context Protocol (MCP) 服务端，支持大语言模型 (LLM) 或客户端直接上传、部署、更新和管理服务器上的静态前端 HTML/CSS/JS/媒体文件。

本项目支持 **API 密钥鉴权** 以及 **自定义静态网站存活时间 (TTL)**，并在后台自动执行过期站点的清理。

---

## 架构设计

为了避免每次部署都动态生成 Nginx 配置文件并重新加载 Nginx 服务（这会带来复杂的权限安全隐患和 Nginx 重启开销），本项目采用了 **共享 URL 前缀模式 (Shared URL Prefix Pattern)**：

1. **一次性 Nginx 配置**：在 Nginx 中配置一个固定的前缀路径（如 `/sites/`）并指向存放静态网站的根目录。
2. **动态文件夹部署**：MCP 服务端直接在网站根目录下，为每次部署生成唯一的站点 ID（如 `_J9EqMQT`），解压并存放静态网页文件（如 `/var/www/mcp-sites/_J9EqMQT/`）。
3. **即时访问**：网页上传后即可通过对应的公网 URL（如 `http://yourdomain.com/sites/_J9EqMQT/`）进行实时访问，无需修改任何 Nginx 配置。

```
LLM / 客户端 ---[MCP 协议]---> MCP 服务端 (Streamable HTTP 或 SSE)
                                        |
                                        v (解压/拷贝至子目录)
                               /var/www/mcp-sites/
                                    |-- _J9EqMQT/ (index.html, css/, js/)
                                    `-- k8mP9a/ (index.html)
                                        ^
Nginx ---[转发 /sites/]-----------------| (静态文件托管)
```

---

## 环境配置

您可以通过环境变量或在根目录下创建 `.env` 文件来定制配置：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `MCP_PORT` | `3000` | MCP 服务绑定的 HTTP 端口 |
| `MCP_HOST` | `0.0.0.0` | 监听的主机 IP 地址 |
| `MCP_DATA_DIR` | `./data` | 存放元数据和站点文件夹的父级目录 |
| `MCP_SITES_DIR` | `<DATA_DIR>/sites` | 部署的静态站点的物理存储绝对路径 |
| `MCP_BASE_URL` | `http://localhost/sites` | 访问静态站点的公网 URL 前缀（需与 Nginx 路径匹配） |
| `MCP_DB_PATH` | `<DATA_DIR>/db.json` | 站点元数据 JSON 数据库路径 |
| `MCP_MAX_UPLOAD_BYTES` | `52428800` (50MB) | 允许的最大上传大小（单文件/ZIP） |
| `MCP_ALLOWED_EXTENSIONS` | `.html,.css,.js...` | 允许上传的文件后缀列表（以逗号分隔） |
| `MCP_API_KEY` | 无 | 可选的安全密钥。若设置，客户端连接及消息发送必须携带该密钥。 |
| `MCP_DEFAULT_TTL` | 无 | 可选的默认站点存活时间（秒数或格式化字符串如 `'30m'`, `'12h'`, `'7d'`）。 |
| `MCP_MAX_TTL` | 无 | 可选的最大站点存活时间，用于限制用户侧 `ttl` 不能超过企业策略。 |
| `MCP_CLEANUP_INTERVAL` | `60000` | 定时清理过期站点的检测间隔时间（毫秒）。 |

---

## 如何部署到服务器上？

推荐使用 **Docker Compose** 部署。这样服务器不需要安装 Node.js、pnpm 或 PM2，只需要有 Docker 即可运行 MCP 服务。

### 方案一：Docker Compose 部署（推荐）

#### 1. 环境准备
服务器需要安装 Docker 和 Docker Compose 插件：

```bash
docker --version
docker compose version
```

#### 2. 准备静态站点目录
该目录需要同时被 MCP 容器写入、被 Nginx 读取：

```bash
sudo mkdir -p /var/www/mcp-sites
sudo chown -R 10001:10001 /var/www/mcp-sites
```

镜像内的默认运行用户 UID 是 `10001`。核心要求是：容器内 `/sites` 可写，Nginx 可读。

#### 3. 克隆项目
```bash
git clone <您的仓库地址> mcp-html-mcp-nginx
cd mcp-html-mcp-nginx
```

#### 4. 修改 Compose 配置
编辑 `compose.yaml`，至少修改以下配置：

```yaml
environment:
  MCP_BASE_URL: "https://yourdomain.com/sites"
  MCP_API_KEY: "请改成一段足够长的随机密钥"
  MCP_DEFAULT_TTL: "24h"
  MCP_MAX_TTL: "30d"
volumes:
  - ./data:/data
  - /var/www/mcp-sites:/sites
```

其中：

* `MCP_BASE_URL` 必须与 Nginx 暴露给用户访问的共同前缀一致。
* `MCP_API_KEY` 是 MCP 访问密钥，生产环境必须修改。
* `MCP_DEFAULT_TTL` 是用户未指定时的默认站点存活时间。
* `MCP_MAX_TTL` 是允许用户设置的最大站点存活时间。
* `/var/www/mcp-sites:/sites` 表示容器将网页部署到宿主机 `/var/www/mcp-sites`。

#### 5. 启动服务

```bash
docker compose up -d --build
```

查看运行状态：

```bash
docker compose ps
docker compose logs -f
```

如果日志出现 `EACCES: permission denied, open '/data/db.json'`，说明宿主机挂载的 `./data` 目录不可写。新版镜像会在启动时自动修正 `/data` 和 `/sites` 的权限；更新代码后请重新构建：

```bash
docker compose up -d --build
```

如果仍然失败，可以手动修复宿主机目录权限：

```bash
sudo mkdir -p ./data /var/www/mcp-sites
sudo chown -R 10001:10001 ./data /var/www/mcp-sites
docker compose restart
```

健康检查：

```bash
curl http://127.0.0.1:3091/health
```

#### 6. 配置 Nginx 一次性静态目录
在您的 Nginx 配置文件（例如 `/etc/nginx/sites-available/default`）中添加以下 `location` 块：

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    # MCP 协议入口，可选：如果您希望通过域名访问 MCP，而不是直接开放 3091 端口
    location /mcp/ {
        proxy_pass http://127.0.0.1:3091/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }

    # SSE 传输会回调 /messages，必须代理到 MCP 服务
    location /messages {
        proxy_pass http://127.0.0.1:3091/messages;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }

    # 真实文件上传入口，支持 multipart/form-data 多文件/文件夹上传
    location /upload/ {
        proxy_pass http://127.0.0.1:3091/upload/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # 所有部署网页共用这个前缀。
    # HTML 入口必须禁用强缓存，避免浏览器保留旧 index.html 后继续请求已删除的旧 assets。
    location /sites/ {
        alias /var/www/mcp-sites/;
        index index.html;
        try_files $uri $uri/ =404;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
    }

    # 带内容哈希的前端构建产物可以长期缓存。
    # Vite / Vue / React 等构建产物通常位于 /assets/ 下，文件名变化即可触发缓存更新。
    location ~ ^/sites/(.+\.(?:js|css|png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|eot|map))$ {
        alias /var/www/mcp-sites/$1;
        expires 1y;
        add_header Cache-Control "public, immutable, no-transform" always;
    }
}
```

> 如果部署的是 Vue Router / React Router 这类 history 模式 SPA，深链接刷新可能需要额外的 `index.html` fallback；否则 `/sites/<siteId>/admin/users` 这类地址会被 Nginx 当成真实文件路径而返回 404。共享 `/sites/` 前缀下最稳妥的方案是前端使用正确的 base 路径或 hash history；MCP 工具返回的 `validation.spa_hint` 会提示这类风险。

重新加载 Nginx：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

如果配置了上面的 `/mcp/` 代理，则客户端连接地址通常是：

* Streamable HTTP: `https://yourdomain.com/mcp/mcp`
* SSE: `https://yourdomain.com/mcp/sse?apiKey=your_super_secret_key`

上传接口地址：

* 文件上传: `https://yourdomain.com/upload/files`
* ZIP 上传: `https://yourdomain.com/upload/zip`

如果不通过 Nginx 代理 MCP，只开放 `3091` 端口，则连接地址是：

* Streamable HTTP: `http://<服务器IP>:3091/mcp`
* SSE: `http://<服务器IP>:3091/sse?apiKey=your_super_secret_key`
* 文件上传: `http://<服务器IP>:3091/upload/files`
* ZIP 上传: `http://<服务器IP>:3091/upload/zip`

### 方案二：Node.js + PM2 部署（备选）

如果您希望直接在服务器上运行 Node.js，可以使用下面的方式。

#### 1. 环境准备
确保服务器已安装 **Node.js >= 20.0.0** 及包管理器 **pnpm**。

#### 2. 克隆项目与安装依赖
```bash
git clone <您的仓库地址> mcp-html-mcp-nginx
cd mcp-html-mcp-nginx
pnpm install
```

#### 3. 编译项目
```bash
pnpm run build
```
编译后的入口文件将生成在 `dist/index.js`。

#### 4. 编写配置文件
在项目根目录下创建 `.env` 文件，填入您的配置参数：
```ini
MCP_PORT=3000
MCP_HOST=0.0.0.0
MCP_BASE_URL=https://yourdomain.com/sites
MCP_SITES_DIR=/var/www/mcp-sites
MCP_API_KEY=your_super_secret_key
MCP_DEFAULT_TTL=24h
MCP_MAX_TTL=30d
MCP_CLEANUP_INTERVAL=60000
```
确保运行 Node.js 进程的用户有权读写 `MCP_SITES_DIR` 和 `MCP_DATA_DIR`。

#### 5. 使用 PM2 进行守护运行
在生产环境中，建议使用 PM2 启动和守护该服务，以便于开机自启和故障恢复。
```bash
# 全局安装 PM2
npm install -g pm2

# 启动服务
pm2 start dist/index.js --name "mcp-html-nginx" --update-env

# 保存当前列表以实现开机自启
pm2 save
pm2 startup
```

---

## 用户怎么用？

由于该服务是一个 MCP 服务，用户一般不需要直接调用其 API，而是通过 **大语言模型客户端 (Cursor / Claude Desktop 等)** 间接使用。

### 1. 在 Cursor 中配置 (SSE 模式)
1. 打开 **Cursor** 客户端，进入设置界面：`Settings` -> `Features` -> `MCP`。
2. 点击 **+ Add New MCP Server**。
3. 在弹出的对话框中进行配置：
   - **Name**: `mcp-html-nginx`
   - **Type**: `SSE`
   - **URL**: `https://yourdomain.com/mcp/sse?apiKey=your_super_secret_key` (请替换为您的实际域名和密钥)
4. 点击 **Save**。如果连接成功，Cursor 面板中会显示绿色的连接状态，并列出可用的工具列表。

> 如果 MCP 客户端支持自定义请求头，生产环境建议使用 `Authorization: Bearer your_super_secret_key` 或 `x-api-key: your_super_secret_key`，避免密钥出现在 URL、代理日志或浏览器历史中。SSE 初始化认证成功后，服务端会按 session 放行后续 `/messages` 请求，不会再把密钥写回 SSE endpoint 事件。

### 2. 在 Claude Desktop 中配置 (SSE 模式)
1. 编辑 Claude Desktop 的配置文件：
   - **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
   - **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
2. 在 `mcpServers` 字段下添加 SSE 连接配置：
   ```json
   {
     "mcpServers": {
       "mcp-html-nginx": {
         "sse": {
          "url": "https://yourdomain.com/mcp/sse?apiKey=your_super_secret_key"
         }
       }
     }
   }
   ```
3. 重启 Claude Desktop。

### 3. LLM 交互与实战
当客户端连接上此 MCP 服务后，您的 AI 助手便拥有部署网页、查询站点、更新 TTL、删除站点的能力。

对于真实前端文件或文件夹，推荐走 HTTP 文件上传接口，不要让 AI 把大量 HTML/JS/CSS 内容塞进 MCP 参数。

```bash
curl -X POST 'https://yourdomain.com/upload/files' \
  -H 'Authorization: Bearer your_super_secret_key' \
  -F 'name=my-site' \
  -F 'ttl=72h' \
  -F 'paths=index.html' -F 'file=@./index.html;filename=index.html' \
  -F 'paths=assets/app.js' -F 'file=@./assets/app.js;filename=app.js'
```

对于 Vite / Vue / React 等完整构建产物，推荐先压缩 `dist` 目录内容，再直接上传 ZIP，避免 MCP JSON 参数中传输大体积 base64：

```bash
cd dist
zip -r ../dist.zip .
curl -X POST 'https://yourdomain.com/upload/zip?name=my-site&ttl=72h&spa=true' \
  -H 'Authorization: Bearer your_super_secret_key' \
  -H 'Content-Type: application/zip' \
  --data-binary '@../dist.zip'
```

上传成功后返回：

```json
{
  "status": "deployed",
  "site_id": "abc12345",
  "url": "https://yourdomain.com/sites/abc12345/",
  "entry_url": "https://yourdomain.com/sites/abc12345/index.html",
  "expires_at": "2026-06-26T10:24:33.035Z",
  "validation": {
    "entry_file": "index.html",
    "asset_count": 2,
    "missing_assets": [],
    "warnings": [],
    "cache_hint": "Use no-cache for index.html and long immutable caching for hashed assets."
  }
}
```

LLM 交互示例：

- **用户**: *"我有一个前端文件夹要部署，告诉我怎么上传。"*
- **AI (自动分析)**: 
  1. 调用 `get_upload_instructions` 获取上传入口和字段说明。
  2. 指导用户或客户端把真实文件以 `multipart/form-data` 上传到 `/upload/files`。
  3. 上传成功后展示返回的 `url`。
  
- **用户**: *"把这个网站的存活时间缩短到 30 分钟，并更新一下标题。"*
- **AI (自动分析)**:
  1. 自动调用 `update_site`，传入 `site_id` 并将 `ttl` 设为 `"30m"`。
  2. 报告更新成功。

---

## MCP 工具接口详细说明

### 1. `get_upload_instructions` (获取真实文件上传说明)
返回 `/upload/files` 上传接口说明。适合用户已有本地文件、文件夹、构建产物时使用。

上传接口支持：
* 多个 `file` 文件字段。
* 可选多个 `paths` 字段，用于指定文件在站点中的相对路径。
* 可选 `name` 字段，指定站点名称。
* 可选 `ttl` 字段，指定存活时间。

### 2. `deploy_site` (通过 MCP 参数部署静态站点)
通过 MCP 工具参数部署静态网页。适合小型 LLM 生成页面、服务端已有路径或程序化 base64 场景。真实文件/文件夹上传优先使用 `get_upload_instructions` + `/upload/files`。接受三种部署源模式之一（互斥，三选一）：
*   `files`: 文件对象数组，每个对象包含 `path`（相对路径）和 `content`（Base64 编码的文本或二进制内容），适合单页应用或少量文件。
*   `zip_base64`: 整个站点的 Base64 编码 ZIP 压缩包，适合复杂的完整网站及带有多媒体资源的站点。
*   `source_path`: 服务器本地已存在的静态文件夹绝对路径。

**输入参数：**
*   `name` (string, 可选): 网站的友好名称。若缺省则自动生成。
*   `files` (array, 可选): `[{ path: "index.html", content: "..." }]`
*   `zip_base64` (string, 可选): Base64 编码的 ZIP 压缩包。
*   `source_path` (string, 可选): 服务器本地的绝对路径。
*   `ttl` (number | string, 可选): 网站的存活时间（生命周期）。例如：`3600`（代表3600秒）、`"30m"`（30分钟）、`"12h"`（12小时）、`"7d"`（7天）、`"never"`（永久）。若不填，则遵循默认存活时间（若未配置默认值，则永久存活）。若服务端配置了 `MCP_MAX_TTL`，则不能超过该上限。

### 3. `update_site` (更新静态站点)
更新一个已经存在的站点，支持增量更新或清空覆盖。

**输入参数：**
*   `site_id` (string, 必填): 目标站点的唯一 ID。
*   `files` (array, 可选): 要更新或新增的文件列表。
*   `zip_base64` (string, 可选): 用于更新的 Base64 ZIP 包（可解包覆盖或追加）。
*   `clean` (boolean, 可选, 默认 false): 设置为 `true` 时，会在写入新文件前清空该站点的旧目录。
*   `ttl` (number | string, 可选): 更新或延长网站的存活时间。可以只传 `site_id` 和 `ttl` 来续期，也可以传 `"never"` 取消过期时间。若服务端配置了 `MCP_MAX_TTL`，则不能超过该上限。

### 4. `list_sites` (列出静态站点)
列出当前所有已部署的静态网站信息（包括 ID、名称、URL、文件数量等）。

**输入参数：**
*   `keyword` (string, 可选): 站点 ID 或站点名称的模糊匹配过滤关键字（不区分大小写）。

### 4. `delete_site` (删除静态站点)
完全删除一个站点。从磁盘上移除对应文件夹，并从数据库中删除该条记录。

**输入参数：**
*   `site_id` (string, 必填): 目标站点的唯一 ID。

---

## 自动化测试
项目中提供了一个完整的集成测试脚本，模拟了标准的 SSE 协议交互与全部工具链调用：
```bash
node test_mcp.cjs
```
