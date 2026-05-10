# 后端服务部署说明

这个项目现在可以把 `service/` 作为独立后端部署。Figma 插件只负责展示 UI、轮询任务和导入图片；Playwright、截图、任务队列、产物文件都在后端服务里完成。

## 服务能力

- `GET /api/health`: 健康检查与当前队列状态。
- `POST /api/validate`: 校验目标 URL 是否可访问。
- `POST /api/capture`: 创建截图任务。
- `GET /api/jobs/:jobId`: 查询任务状态与截图结果。
- `POST /api/jobs/:jobId/stop`: 停止排队或运行中的任务。
- `GET /artifacts/:jobId/:fileName`: 读取短期保留的 PNG 截图片段。

## 生产保护

- 默认阻止抓取 `localhost`、内网 IP、链路本地地址、保留网段和 IPv6 私有地址，避免服务变成 SSRF 代理。
- Playwright 运行时会拦截页面里的内网资源请求，不只检查用户输入的首个 URL。
- 任务走队列，默认最多 2 个并发、20 个排队任务。
- 产物默认保留 1 小时，到期后自动清理 `.capture-artifacts`。
- API 支持可选访问令牌、CORS 白名单、请求体限制和基础 IP 速率限制。

## 环境变量

复制 `.env.example` 后按部署环境调整：

```bash
PAGE_CAPTURE_HOST=0.0.0.0
PAGE_CAPTURE_PORT=3845
PAGE_CAPTURE_PUBLIC_BASE_URL=https://capture-api.example.com
PAGE_CAPTURE_ALLOWED_ORIGINS=*
PAGE_CAPTURE_MAX_RUNNING_JOBS=2
PAGE_CAPTURE_MAX_QUEUED_JOBS=20
PAGE_CAPTURE_ALLOW_PRIVATE_TARGETS=false
```

`PAGE_CAPTURE_PUBLIC_BASE_URL` 必须是用户浏览器能够访问到的 HTTPS 地址，因为插件会用它读取 `/artifacts/...` 图片。

`PAGE_CAPTURE_API_KEY` 只适合私有部署。公开发布到 Figma Community 时，不要把密钥硬编码进插件包；公开服务应依赖服务端限流、配额、登录态或你自己的账号系统。

## Docker

构建镜像：

```bash
docker build -t page-capture-service .
```

本地运行：

```bash
docker run --rm -p 3845:3845 --env-file .env page-capture-service
```

部署到云服务时，建议：

- 使用 HTTPS 反向代理或平台自带 HTTPS。
- 给容器挂载临时磁盘或对象存储缓存目录。
- 根据机器 CPU/内存调小或调大 `PAGE_CAPTURE_MAX_RUNNING_JOBS`。
- 把 `PAGE_CAPTURE_ALLOW_PRIVATE_TARGETS` 保持为 `false`。

## Figma 插件配置

发布前需要改两处：

1. 在 `ui.html` 的 `CONFIG` 里把服务地址改成你的线上 API：

   ```js
   const CONFIG = Object.assign(
     { serviceBaseUrl: 'https://capture-api.example.com', apiKey: '' },
     window.PAGE_CAPTURE_CONFIG || {},
   )
   ```

2. 在 `manifest.json` 里把正式域名加入 `allowedDomains`：

   ```json
   "networkAccess": {
     "allowedDomains": ["https://capture-api.example.com"],
     "reasoning": "用于校验用户输入的网页 URL、创建截图任务并读取生成的 PNG 截图片段。",
     "devAllowedDomains": ["http://localhost:3845"]
   }
   ```

如果你继续使用本地服务开发，保留 `devAllowedDomains` 即可。
