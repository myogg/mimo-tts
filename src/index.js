/**
 * xiaomi-tts-api —— 小米 MiMo TTS 的 Cloudflare Workers 纯 API 代理
 *
 * 只做一件事：接收「文本 + 音色」，把小米 TTS 的音频流直接返回。
 * 不存储、不缓存、不落 R2 —— 纯粹的转发 API。
 *
 * 接口：
 *   GET/POST /tts?text=...&voice=Chloe&format=mp3   直接返回音频二进制（默认 mp3）
 *   POST      /v1/audio/speech (OpenAI 兼容)         直接返回音频二进制
 *   GET       /voices                                返回可用音色 / 格式列表
 *   GET       /                                      浏览器测试台
 *
 * 密钥：XIAOMI_API_KEY（wrangler secret put 注入，不进代码、不暴露给前端）
 */

const API_BASE = "https://api.xiaomimimo.com";

// 官方文档：仅 chat/completions 可用（/v1/audio/speech 实测 404）；无独立 speed 参数，
// 语速靠文本标签 [语速加快] 或 user 风格指令控制。
const VALID_VOICES = [
  "mimo_default", "冰糖", "茉莉", "苏打", "白桦",
  "Mia", "Chloe", "Milo", "Dean"
];
const DEFAULT_VOICE = "Chloe";
const DEFAULT_MODEL = "mimo-v2.5-tts";
const VALID_FORMATS = ["mp3", "wav", "pcm", "pcm16"];
const MAX_TEXT = 8000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      if (path === "/" || path === "/index.html") {
        return new Response(TEST_PAGE, {
          headers: { "Content-Type": "text/html; charset=utf-8", ...CORS_HEADERS }
        });
      }
      if (path === "/tts") {
        return await handleSimple(request, env, url);
      }
      if (path === "/v1/audio/speech") {
        return await handleOpenAI(request, env);
      }
      if (path === "/voices") {
        return json(200, { voices: VALID_VOICES, formats: VALID_FORMATS, model: DEFAULT_MODEL });
      }
      return jsonError(404, "Not Found. Try /tts, /v1/audio/speech or /");
    } catch (e) {
      return jsonError(500, "Worker error: " + (e && e.message ? e.message : String(e)));
    }
  }
};

async function handleSimple(request, env, url) {
  let params = {};
  if (request.method === "POST") {
    const ct = request.headers.get("content-type") || "";
    try {
      if (ct.includes("application/json")) {
        params = await request.json();
      } else if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
        const fd = await request.formData();
        for (const [k, v] of fd.entries()) params[k] = v;
      }
    } catch (_) { /* 解析失败则按空处理 */ }
  } else {
    for (const [k, v] of url.searchParams.entries()) params[k] = v;
  }

  const text = params.text || params.input || params.content || "";
  const voice = params.voice || DEFAULT_VOICE;
  const format = (params.format || params.response_format || "mp3").toLowerCase();
  const model = params.model || DEFAULT_MODEL;
  const style = params.style || "";

  return validateAndSynthesize({ text, voice, format, model, style, env });
}

async function handleOpenAI(request, env) {
  if (request.method !== "POST") return jsonError(405, "Method Not Allowed");
  let body;
  try { body = await request.json(); } catch (_) { body = null; }
  if (!body) return jsonError(400, "Invalid JSON body");

  const text = body.input || "";
  const voice = body.voice || DEFAULT_VOICE;
  const format = (body.response_format || "mp3").toLowerCase();
  const model = body.model || DEFAULT_MODEL;
  const style = body.style || "";

  return validateAndSynthesize({ text, voice, format, model, style, env });
}

async function validateAndSynthesize({ text, voice, format, model, style, env }) {
  text = String(text || "");
  if (!text.trim()) return jsonError(400, "Missing text/input parameter");
  if (text.length > MAX_TEXT) return jsonError(400, `Text too long (max ${MAX_TEXT} chars)`);
  if (!VALID_VOICES.includes(voice)) {
    return jsonError(400, `Invalid voice '${voice}'. Valid: ${VALID_VOICES.join(", ")}`);
  }
  if (!VALID_FORMATS.includes(format)) {
    return jsonError(400, `Invalid format '${format}'. Valid: ${VALID_FORMATS.join(", ")}`);
  }
  return callUpstream({ text, voice, format, model, style, env });
}

async function callUpstream({ text, voice, format, model, style, env }) {
  const apiKey = env.XIAOMI_API_KEY;
  if (!apiKey) {
    return jsonError(500, "XIAOMI_API_KEY not set. Run: wrangler secret put XIAOMI_API_KEY");
  }

  // 官方确认：小米 TTS 仅支持 OpenAI 兼容的 chat/completions（/v1/audio/speech 实测 404）。
  // 文本必须放在 assistant 角色；user 角色可放风格 / 指令（可选，不出声）。
  const upstreamPath = "/v1/chat/completions";
  const upstreamBody = {
    model,
    messages: [
      { role: "user", content: style || "" },
      { role: "assistant", content: text }
    ],
    audio: { format, voice }
  };

  const resp = await fetch(API_BASE + upstreamPath, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(upstreamBody)
  });

  const ct = resp.headers.get("content-type") || "";
  let audioBuffer = null;
  let outCt = contentTypeFor(format);

  if (!ct.includes("application/json") && resp.status === 200) {
    // 情况 A：上游直接返回音频二进制
    audioBuffer = await resp.arrayBuffer();
    outCt = ct || outCt;
  } else {
    // 情况 B：上游返回 JSON（可能是音频 base64 / 音频 URL，也可能是错误信息）
    const data = await resp.json().catch(() => null);
    if (!data) return jsonError(502, `Upstream returned non-JSON (status ${resp.status})`);

    const audioB64 =
      data?.choices?.[0]?.message?.audio?.data ||
      data?.audio?.data ||
      data?.audio?.url ||
      (isBase64Audio(data?.choices?.[0]?.message?.content) ? data.choices[0].message.content : null);

    if (audioB64 && !String(audioB64).startsWith("http")) {
      const bin = atob(audioB64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      audioBuffer = bytes.buffer;
    } else if (audioB64 && String(audioB64).startsWith("http")) {
      const ar = await fetch(audioB64);
      audioBuffer = await ar.arrayBuffer();
      outCt = ar.headers.get("content-type") || outCt;
    } else {
      // 没拿到音频，把上游 JSON（多半是错误）原样返回，方便排查
      return new Response(JSON.stringify(data), {
        status: resp.status === 200 ? 502 : resp.status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }
  }

  return new Response(audioBuffer, {
    status: 200,
    headers: {
      "Content-Type": outCt,
      ...CORS_HEADERS,
      "X-Upstream-Mode": "chat"
    }
  });
}

function isBase64Audio(s) {
  return typeof s === "string" && /^[A-Za-z0-9+/=]+$/.test(s) && s.length > 100;
}

function contentTypeFor(format) {
  switch (format) {
    case "wav": return "audio/wav";
    case "pcm":
    case "pcm16": return "audio/pcm";
    default: return "audio/mpeg";
  }
}

function json(code, obj) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

function jsonError(code, msg) {
  return json(code, { error: msg });
}

const TEST_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MiMo TTS 测试台</title>
<style>
  body{font-family:system-ui,-apple-system,"PingFang SC",sans-serif;max-width:680px;margin:40px auto;padding:0 16px;color:#222}
  h1{font-size:20px;margin-bottom:4px}
  textarea{width:100%;height:120px;padding:8px;box-sizing:border-box;font-size:14px}
  select,button,input{padding:6px 10px;font-size:14px}
  button{cursor:pointer;background:#0b69ff;color:#fff;border:none;border-radius:6px}
  .row{margin:12px 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  audio{width:100%;margin-top:12px}
  #status{margin-top:10px;font-size:13px;color:#666;white-space:pre-wrap}
  code{background:#f3f3f3;padding:2px 4px;border-radius:3px}
  .tip{font-size:12px;color:#999}
</style>
</head>
<body>
<h1>🎙️ MiMo TTS 测试台</h1>
<p class="tip">本页由你的 Worker 直接托管，调用的是你自己的 API（Key 在 Worker 端）。纯转发，不存储。</p>
<textarea id="text" placeholder="输入要合成的文字...">你好，欢迎使用小米大模型语音合成服务。</textarea>
<div class="row">
  <label>音色 <select id="voice"></select></label>
  <label>格式
    <select id="format">
      <option>mp3</option><option>wav</option><option>pcm</option><option>pcm16</option>
    </select>
  </label>
  <label>风格(可选) <input id="style" placeholder="如：温柔 慢速" size="14"></label>
  <button id="go">生成语音</button>
</div>
<audio id="player" controls></audio>
<div id="status"></div>
<script>
const VOICES = ["mimo_default","冰糖","茉莉","苏打","白桦","Mia","Chloe","Milo","Dean"];
const sel = document.getElementById('voice');
VOICES.forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o); });
sel.value = "Chloe";
const status = document.getElementById('status');
const player = document.getElementById('player');
document.getElementById('go').onclick = async () => {
  const text = document.getElementById('text').value;
  status.textContent = '请求中...';
  try {
    const r = await fetch('/tts?format=' + document.getElementById('format').value, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: sel.value, style: document.getElementById('style').value })
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({ error: r.statusText }));
      status.textContent = '错误：' + (e.error || r.status);
      return;
    }
    const blob = await r.blob();
    player.src = URL.createObjectURL(blob);
    const kb = (blob.size / 1024).toFixed(1);
    status.textContent = '完成 ✅ 大小 ' + kb + ' KB';
  } catch (err) {
    status.textContent = '请求失败：' + err.message;
  }
};
</script>
</body></html>`;
