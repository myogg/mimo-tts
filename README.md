# mimo-tts（xiaomi-tts-api）

小米 MiMo TTS（`mimo-v2.5-tts`）的 **Cloudflare Workers 纯 API 代理**。

- 只做一件事：接收「文本 + 音色」→ 调小米 → 把音频流直接返回
- **不存储、不缓存、不落 R2**（纯转发，wav/mp3/转码问题从根上消失）
- 默认输出 **mp3**，默认音色 **白桦**（中文男声）

## 接口

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/tts` | GET/POST | 直接返回音频二进制。`text`(必填) `voice` `format`(默认 mp3) `style`(可选) `model` |
| `/v1/audio/speech` | POST | OpenAI 兼容：`{ input, voice, response_format }` |
| `/voices` | GET | 返回可用音色 / 格式 / 模型（公开） |
| `/` | GET | 浏览器测试台 |

示例（未启用鉴权时）：
```bash
curl "https://<你的worker地址>/tts?text=你好&voice=白桦&format=mp3" -o out.mp3
```

启用鉴权后（推荐用 Header，避免 token 进日志）：
```bash
curl -H "Authorization: Bearer <ACCESS_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"text":"你好","voice":"白桦"}' \
     "https://<你的worker地址>/tts?format=mp3" -o out.mp3
```

## 部署（仓库 + Cloudflare Git 连接）

仓库：`https://github.com/myogg/mimo-tts`（分支 `main`）

- 登录 [dashboard.cloudflare.com](https://dashboard.cloudflare.com)（新账号）→ **Workers & Pages** → **Create** → **Workers** → **Connect to Git**
- 授权 GitHub，选 `myogg/mimo-tts`，分支 `main`
- 构建配置：Root directory 留空、**Build command 留空**（纯 JS 无构建，若强制要填就写 `npm install`）、Deploy command `npx wrangler deploy`
- Save and Deploy，等构建变绿

> 以后每次 push 到 main 自动重新部署。

## 密钥（Secret，不进代码）

在 CF Worker 详情页 → **Settings → Variables and Secrets** → Add → 类型选 **Secret**：

| Name | 必填 | 说明 |
| --- | --- | --- |
| `XIAOMI_API_KEY` | 是 | 小米 API Key，来自 platform.xiaomimimo.com |
| `ACCESS_TOKEN` | 否 | 防白嫖令牌，自己随机生成一串长字符 |

命令行等价：`wrangler secret put XIAOMI_API_KEY`、`wrangler secret put ACCESS_TOKEN`

## 防止别人盗用

小米 Key 只存在 Worker 端，别人拿不到；但 **Worker 地址一旦公开，任何人都能调用并消耗你的小米额度**。用 `ACCESS_TOKEN` 上锁：

- **未配置** `ACCESS_TOKEN`：接口保持开放 —— 便于先部署跑通、随时验证。
- **配置后**：`/tts` 与 `/v1/audio/speech` 必须带令牌，否则返回 401；测试台页面 `/` 与 `/voices` 仍公开（页面本身不含密钥）。
- 令牌传递三选一（推荐第 1 种）：
  1. `Authorization: Bearer <token>`
  2. `X-Access-Token: <token>`
  3. `?token=<token>`（GET/浏览器最方便，但 token 会进 URL 与访问日志）
- 测试台页面顶部有「访问令牌」输入框，填入后浏览器用 `Authorization` 头带上，仅存当前会话 sessionStorage，不写死在页面里。

**博客对接时的关键一点**：不要让浏览器直接调这个 Worker（那样 token 会暴露在前端）。应由博客的 Pages Function 在服务端读取环境变量并加 Header 转发，`token` 永不下发到浏览器。

可选的额外加固：CF WAF 对 `/tts` 做速率限制、或改用自定义域名 + 防火墙规则。

## 验证

浏览器打开 `https://xiaomi-tts.<你的子域>.workers.dev/` → 用测试台输入文字点「生成语音」，出声即成功。
`GET /voices` 能返回音色列表说明 Worker 本身正常（不受鉴权影响，方便排查）。

## 本地开发（可选）
```bash
npm install
wrangler dev        # 本地 http://localhost:8787
```

## 费用
`mimo-v2.5-tts` 官方标注「限时免费」，部署前请到 platform.xiaomimimo.com 确认当前仍免费。
若未来收费，只需把博客 `TTS_API_URL` 指回原来的微软 TTS 即可，本仓库代码无需改动。
