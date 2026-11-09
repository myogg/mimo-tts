# xiaomi-tts-api

小米 MiMo TTS（`mimo-v2.5-tts`）的 **Cloudflare Workers 纯 API 代理**。

- 只做一件事：接收「文本 + 音色」→ 调小米 → 把音频流直接返回
- **不存储、不缓存、不落 R2**（纯转发，wav/mp3/转码问题从根上消失）
- 默认输出 **mp3**

## 接口

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/tts` | GET/POST | 直接返回音频二进制。`text`(必填) `voice` `format`(默认 mp3) `style`(可选) `model` |
| `/v1/audio/speech` | POST | OpenAI 兼容：`{ input, voice, response_format }` |
| `/voices` | GET | 返回可用音色 / 格式 / 模型 |
| `/` | GET | 浏览器测试台 |

示例：

```bash
curl "https://<你的worker地址>/tts?text=你好&voice=Chloe&format=mp3" -o out.mp3
```

## 部署（仓库 + Cloudflare Git 连接）

### 1. 在 GitHub 建空仓库
去 github.com → New repository → 命名 `xiaomi-tts-api` → **不要**勾选 README/.gitignore（保持空）→ Create。
仓库创建后复制它的 HTTPS 地址，形如 `https://github.com/myogg/xiaomi-tts-api.git`。

### 2. 本地推送到该仓库
```bash
cd xiaomi-tts-api
git remote add origin https://github.com/myogg/xiaomi-tts-api.git
git branch -M main
git push -u origin main
```

### 3. 在 Cloudflare 用 Git 连接部署
- 登录 [dashboard.cloudflare.com](https://dashboard.cloudflare.com)（新账号）→ **Workers & Pages** → **Create** → 选 **Workers**
- 输入名称 `xiaomi-tts` → 创建后会进入编辑器，**直接跳过**（我们用 Git 部署）
- 或在创建时选择 **Connect to Git**（连接 GitHub 账号 → 选 `xiaomi-tts-api` 仓库），CF 会自动拉取并部署，以后每次 push 自动重新部署

### 4. 注入小米 Key（Secret，不进代码）
在 CF Worker 详情页 → **Settings → Variables** → 添加 Secret：
- Name：`XIAOMI_API_KEY`
- Value：你的小米 API Key（来自 platform.xiaomimimo.com）

> 如果用 `wrangler` 命令行也可：`wrangler secret put XIAOMI_API_KEY`

### 5. 验证
浏览器打开 `https://xiaomi-tts.<你的子域>.workers.dev/` → 用测试台输入文字点「生成语音」，出声即成功。

## 本地开发（可选）
```bash
npm install
wrangler dev        # 本地 http://localhost:8787
```

## 费用
`mimo-v2.5-tts` 官方标注「限时免费」，部署前请到 platform.xiaomimimo.com 确认当前仍免费。
若未来收费，只需把博客 `TTS_API_URL` 指回原来的微软 TTS 即可，本仓库代码无需改动。

## 注意事项
- 本 Worker 对外接口未做鉴权，任何人都能调用并消耗你的小米额度。若公开部署，建议在 `src/index.js` 顶部加一个 `?token=` 校验（再存一个 Secret）。
- 密钥只在 CF 网页端 / 本地 `secret put` 填，绝不进 git、不发聊天。
