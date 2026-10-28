# tvbox-bridge API 文档

面向第三方调用者的 HTTP 接口说明。服务把 TVBox 配置中的 CMS 站点与 CatVod Spider 站点统一成一组 JSON 接口，并提供 **一步解析出可播放地址** 的能力。

- 基础地址：`http://<host>:8787`（Docker 默认映射 8787）
- 全部接口返回 `application/json; charset=utf-8`
- 机器可读规范：[`openapi.yaml`](./openapi.yaml)

---

## 1. 鉴权

服务端通过环境变量启用鉴权：

| 环境变量 | 说明 |
|---|---|
| `BRIDGE_TOKEN` | 单个 token |
| `BRIDGE_TOKENS` | 多个 token，英文逗号分隔（设置后优先于 `BRIDGE_TOKEN`） |

**未设置时接口开放**（仅建议本机使用）；设置后所有 `/api/*` 接口（`/api/health` 除外）都需要 token。

三种传递方式，任选其一：

```http
Authorization: Bearer <token>
```
```http
X-API-Key: <token>
```
```text
GET /api/sites?token=<token>
```

> 查询参数方式（`?token=` 或简写 `?t=`）用于 `<video>`、hls.js、ffmpeg 这类无法自定义请求头的客户端。`/api/play` 与 `/api/resolve` 返回的 `stream` 已自动带上调用方的 token，子清单与分片会沿用同一个 token。

鉴权失败：

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="tvbox-bridge"
```
```json
{ "error": "缺少鉴权信息", "hint": "使用 Authorization: Bearer <token>、X-API-Key: <token> 或 ?token=<token>" }
```

---

## 2. 通用约定

### 2.1 错误格式

所有失败均返回 `{"error": "..."}`，部分接口附带上下文：

| HTTP | 含义 |
|---|---|
| 400 | 参数缺失 / 尚未加载配置 |
| 401 | 鉴权失败 |
| 403 | 禁止访问（如非本机访问 `/local/jar/`） |
| 404 | 站点或影片不存在 |
| 500 | 站点执行异常（Spider/CMS 报错） |
| 502 | 上游不可达、配置拉取失败、拉流失败 |
| 504 | Spider 调用超时（companion 看门狗） |

### 2.2 GET / POST

`/api/resolve` 同时支持 `GET`（查询参数）和 `POST`（JSON body），其余业务接口使用 `POST`。POST 时 `Content-Type: application/json`。

### 2.3 站点标识

`site` / `key` 参数可以传站点 `key`（如 `厂长`）或完整名称（如 `📔厂长┃不卡`），也支持名称子串匹配。

---

## 3. 快速上手

```bash
# 1) 加载配置（多仓会返回 entries，需再选一个仓库）
curl -X POST http://127.0.0.1:8787/api/config \
  -H 'Authorization: Bearer $TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://raw.githubusercontent.com/qist/tvbox/master/fty.json"}'

# 2) 一步解析：片名 → 可直接播放的地址
curl -X POST http://127.0.0.1:8787/api/resolve \
  -H 'Authorization: Bearer $TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"site":"荐片","name":"调音师"}'
```

响应（节选）：

```json
{
  "site": { "key": "荐片", "name": "🥝荐片┃多线", "type": 3, "api": "csp_JPJGuard" },
  "item": { "id": "16898", "name": "调音师", "pic": "https://..." },
  "source": { "index": 0, "name": "VIP线路", "episodeCount": 6 },
  "episode": { "index": 0, "name": "BD中字", "url": "..." },
  "url": "https://mv.gzlcl.com/api/v2/vip/normal/16898/index.m3u8",
  "type": "hls",
  "headers": { "Referer": "https://fan123.whhyn.com" },
  "needsParse": false,
  "stream": "/api/stream?u=...&h=...&t=...",
  "streamUrl": "http://127.0.0.1:8787/api/stream?u=...&h=...&t=...",
  "alternatives": [{ "index": 0, "name": "VIP线路", "episodeCount": 6 }],
  "elapsedMs": 4729
}
```

播放时**优先使用 `streamUrl`**：它经过本服务代理，会带上 UA/Referer 等请求头，并把 m3u8 的分片、子清单、AES key 一并重写为代理地址。直接使用 `url` 时需自行设置 `headers`，且分片可能因防盗链失败。

---

## 4. 接口

### 4.1 `GET /api/health`（公开）

健康检查，不需要鉴权，适合容器探针。

```json
{
  "status": "ok",
  "version": "1.0.0",
  "auth": true,
  "companion": { "running": true },
  "configLoaded": true,
  "sites": 49
}
```

---

### 4.2 `GET /api/status`

运行状态：companion 端口、已加载的 Spider 站点、配置地址。

```json
{
  "version": "1.0.0",
  "auth": true,
  "companion": { "running": true, "port": 2403, "startedAt": 1793109538772, "lastError": "" },
  "configLoaded": true,
  "configUrl": "https://raw.githubusercontent.com/qist/tvbox/master/fty.json",
  "sites": 49,
  "loadedSites": [{ "key": "厂长", "ok": true, "error": "", "at": 1793111661745 }]
}
```

---

### 4.3 `POST /api/config`

加载（或切换）TVBox 配置。支持 JSON、整体 Base64、`XXXXXXXX**Base64`、`<pre>` 包裹，以及多仓清单。

**请求**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `url` | string | 是 | 配置地址（http/https） |

**普通配置响应**

```json
{
  "kind": "config",
  "configUrl": "https://raw.githubusercontent.com/qist/tvbox/master/fty.json",
  "siteCount": 49,
  "parseCount": 0,
  "liveCount": 6,
  "spider": "https://raw.githubusercontent.com/qist/tvbox/master/jar/fan.txt;md5;b55978c4fe6d12e2fea9075f17c8a67a",
  "sites": [
    { "key": "厂长", "name": "📔厂长┃不卡", "type": 3, "api": "csp_NewCzGuard",
      "usesCompanion": true, "unsupported": false, "searchable": 1 }
  ]
}
```

**多仓响应**（`{"urls":[...]}`）：返回 `kind: "depot"`，需再次调用本接口加载选中的仓库地址。

```json
{
  "kind": "depot",
  "configUrl": "...",
  "entries": [{ "name": "仓库A", "url": "https://.../a.json" }]
}
```

> 加载新配置会清空已加载的 Spider 站点缓存（进程内），但磁盘上的载荷解密缓存（`~/.tvbox_bridge`）会保留。

---

### 4.4 `GET /api/sites`

当前配置的站点列表。

```json
{
  "configUrl": "https://...",
  "sites": [
    { "key": "荐片", "name": "🥝荐片┃多线", "type": 3, "api": "csp_JPJGuard",
      "usesCompanion": true, "unsupported": false, "searchable": 1, "loaded": true }
  ]
}
```

`type`：`0` = XML CMS，`1` = JSON CMS，`3` = Spider（`csp_*` / `.js` / `.py`）。
`usesCompanion`：需要本地 JVM 解析进程；`unsupported`：当前环境不支持（Python 源）。

---

### 4.5 `POST /api/site/load`

预热一个 Spider 站点（首次会下载并解密载荷、dex2jar，约 1 分钟；后续秒级）。不调用也可以，`/api/home` 等接口会自动触发加载。

**请求**：`{ "key": "厂长" }`

```json
{ "ok": true, "error": "", "at": 1793111661745, "site": "厂长" }
```

---

### 4.6 `POST /api/home`

站点首页：分类 + 推荐列表。

**请求**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `key` | string | — | 站点标识 |
| `filter` | bool | `true` | 是否请求筛选条件 |

**响应**

```json
{
  "page": 1,
  "pagecount": 1,
  "total": 57,
  "limit": 57,
  "categories": [{ "id": "movie_bt_series/guochanju", "name": "国产剧" }],
  "list": [{
    "id": "https://www.4kcz.com/movie/20294.html",
    "name": "峡谷",
    "pic": "https://...",
    "remarks": "1080P",
    "typeName": "",
    "year": "",
    "area": "",
    "score": "",
    "tag": ""
  }]
}
```

---

### 4.7 `POST /api/category`

分类分页。

**请求**：`{ "key": "厂长", "tid": "movie_bt_series/guochanju", "pg": 1, "filter": true }`
`tid` 取自 `/api/home` 的 `categories[].id`。响应结构同 `/api/home`（`categories` 可能为空）。

---

### 4.8 `POST /api/search`

关键词搜索。

**请求**：`{ "key": "厂长", "wd": "哪吒", "quick": false, "pg": 1 }`

```json
{
  "page": 1,
  "pagecount": 1,
  "total": 4,
  "list": [
    { "id": "movie/7173.html", "name": "哪吒闹海", "pic": "https://...", "remarks": "全1集" }
  ]
}
```

> 部分源不支持搜索（`searchable: 0`），会返回空列表而不是报错。

---

### 4.9 `POST /api/detail`

影片详情与播放线路。

**请求**：`{ "key": "厂长", "id": "movie/7173.html" }`

```json
{
  "item": {
    "id": "movie/7173.html", "name": "哪吒闹海", "pic": "https://...",
    "remarks": "全1集", "typeName": "动画片", "year": "1979", "area": "中国大陆",
    "actor": "...", "director": "...", "content": "简介...", "score": "9.0"
  },
  "sources": [
    { "name": "专线", "episodes": [{ "name": "HD", "url": "v_play/bXZfNzE3My1ubV8x.html" }] }
  ],
  "site": { "key": "厂长", "name": "📔厂长┃不卡" }
}
```

---

### 4.10 `POST /api/play`

按线路 + 选集取播放地址（底层 `playerContent`）。

**请求**

| 字段 | 类型 | 说明 |
|---|---|---|
| `key` | string | 站点标识 |
| `flag` | string | 线路名（`sources[].name`），CMS 站点可留空 |
| `id` | string | 选集地址（`sources[].episodes[].url`），CMS 站点即播放地址 |

**响应**

```json
{
  "url": "https://mv.gzlcl.com/api/v2/vip/normal/16898/index.m3u8",
  "type": "hls",
  "headers": { "Referer": "https://fan123.whhyn.com" },
  "needsParse": false,
  "stream": "/api/stream?u=...&h=...&t=...",
  "streamUrl": "http://127.0.0.1:8787/api/stream?u=...&h=...&t=..."
}
```

| 字段 | 说明 |
|---|---|
| `url` | 真实媒体地址（m3u8/mp4/flv/…） |
| `type` | `hls` / `mp4` / `flv` / `ts` / `rtmp` / `rtsp` / `other` |
| `headers` | 播放该地址所需的请求头（UA/Referer/Origin 等） |
| `needsParse` | 是否经过第三方 JSON 解析接口得到 |
| `stream` / `streamUrl` | 经本服务代理的地址（推荐使用） |

---

### 4.11 `POST|GET /api/resolve` ⭐ 一步解析

输入片名（或影片 ID）直接得到可播放地址，内部依次执行：搜索 → 详情 → 选线路/选集 → `playerContent`。

**请求**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `site` | string | 是 | 站点 key 或名称 |
| `name` | string | 二选一 | 片名（也接受 `wd` / `keyword` / `q`）；搜索接口不可用时自动回退到首页/首个分类做片名匹配 |
| `id` | string | 二选一 | 影片 ID（跳过搜索） |
| `pick` | int | 否 | 搜索结果第几条，默认 0 |
| `source` | string | 否 | 线路名（也接受 `flag`），默认第 0 条 |
| `sourceIndex` | int | 否 | 线路下标，优先级高于 `source` |
| `episode` | string/int | 否 | 集名或下标，默认 0 |
| `episodeUrl` | string | 否 | 直接指定选集地址 |

**响应**

```json
{
  "site": { "key": "荐片", "name": "🥝荐片┃多线", "type": 3, "api": "csp_JPJGuard" },
  "item": { "id": "16898", "name": "调音师", "pic": "https://...", "year": "2018" },
  "source": { "index": 0, "name": "VIP线路", "episodeCount": 6 },
  "episode": { "index": 0, "name": "BD中字", "url": "..." },
  "url": "https://mv.gzlcl.com/api/v2/vip/normal/16898/index.m3u8",
  "type": "hls",
  "headers": { "Referer": "https://fan123.whhyn.com" },
  "needsParse": false,
  "stream": "/api/stream?u=...&t=...",
  "streamUrl": "http://127.0.0.1:8787/api/stream?u=...&t=...",
  "alternatives": [
    { "index": 0, "name": "VIP线路", "episodeCount": 6 },
    { "index": 1, "name": "极速蓝光", "episodeCount": 6 }
  ],
  "elapsedMs": 4729
}
```

**GET 形式**

```text
GET /api/resolve?site=荐片&name=调音师&episode=1&token=<token>
```

---

### 4.12 `GET /api/stream`

媒体代理。参数由 `/api/play`、`/api/resolve` 生成，一般不需要手工拼接。

| 参数 | 说明 |
|---|---|
| `u` | base64url(真实媒体地址) |
| `h` | base64url(JSON 请求头)，可选 |
| `token` / `t` | 鉴权 token（开启鉴权时必填） |

行为：

- 透传 `Range`、`Content-Type`、`Content-Length`、`Content-Range`、`Accept-Ranges`，支持拖动进度条；
- 遇到 m3u8 会重写每个分片、子清单、`#EXT-X-KEY` / `#EXT-X-MAP` 的 URI，使 HLS 能通过本代理加载（含 AES-128 密钥）；
- 支持 `HEAD`。

```bash
curl -I 'http://127.0.0.1:8787/api/stream?u=<b64>&t=<token>'
```

---

### 4.13 `GET /api/img`

图片代理（解决海报防盗链）。参数 `u` 为 base64url(图片地址)，`r` 可选 Referer。

```text
GET /api/img?u=<base64url>&t=<token>
```

返回原始图片字节，`Cache-Control: public, max-age=86400`。

---

### 4.14 `GET /api/logs`

companion 进程最近 500 行日志（排查 Spider 问题用）。

```json
{ "logs": ["[COMPANION_READY] PORT=2403", "..."] }
```

---

## 5. 调用示例

### 5.1 JavaScript（Node 18+ / 浏览器）

```js
const BASE = 'http://127.0.0.1:8787';
const TOKEN = process.env.BRIDGE_TOKEN || '';

const api = async (path, body) => {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
};

await api('/api/config', { url: 'https://raw.githubusercontent.com/qist/tvbox/master/fty.json' });
const r = await api('/api/resolve', { site: '荐片', name: '调音师' });
console.log(r.streamUrl); // 交给 <video> / hls.js / ffmpeg
```

### 5.2 Python

```python
import os, requests

BASE = "http://127.0.0.1:8787"
H = {"Authorization": f"Bearer {os.environ['BRIDGE_TOKEN']}"}

requests.post(f"{BASE}/api/config", headers=H, json={
    "url": "https://raw.githubusercontent.com/qist/tvbox/master/fty.json"
}, timeout=60).raise_for_status()

r = requests.post(f"{BASE}/api/resolve", headers=H,
                 json={"site": "荐片", "name": "调音师"}, timeout=120)
r.raise_for_status()
print(r.json()["streamUrl"])
```

### 5.3 ffmpeg / mpv 播放

```bash
STREAM=$(curl -s -X POST http://127.0.0.1:8787/api/resolve \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"site":"荐片","name":"调音师"}' | jq -r .streamUrl)

ffplay "$STREAM"
```

### 5.4 浏览器播放 HLS

```html
<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
<script>
  // streamUrl 已包含 token；若使用无 token 模式则无需 &t=
  const src = 'http://127.0.0.1:8787/api/stream?u=...&t=<token>';
  const video = document.querySelector('video');
  const hls = new Hls();
  hls.loadSource(src);
  hls.attachMedia(video);
</script>
```

---

## 6. 性能与限制

| 项目 | 说明 |
|---|---|
| 首次 Spider 加载 | 下载加固壳 → unidbg 解密（约 9s）→ dex2jar（约 19s）→ 类加载，合计约 1 分钟；缓存后数秒 |
| 载荷缓存 | 容器内 `~/.tvbox_bridge`（本镜像映射到 `/data`），建议挂载持久卷 |
| 单次调用超时 | `playerContent` 等默认 120s，`/spider/load` 180s |
| 并发 | companion 最多 64 个在途调用，超出返回 503 |
| 支持范围 | JSON 解析接口；不支持网页嗅探（`playUrl`）与 Python 源 |
| 网盘类站点 | 夸克/阿里/UC 等需要各自登录授权，未纳入自动测试 |
| 配置切换 | 进程内站点缓存会重置，磁盘缓存保留 |

---

## 7. 常见问题

**401 缺少鉴权信息** → 服务端设置了 `BRIDGE_TOKEN`，请带上 `Authorization: Bearer <token>`，或在 URL 上加 `?token=<token>`。

**400 尚未加载配置** → 先调用 `POST /api/config`；进程重启后需要重新加载（配置不落盘）。

**502 配置拉取失败** → 检查容器网络；GitHub 需要代理时设置 `HTTPS_PROXY`。

**500 站点暂不可用 (stage=call)** → Spider 内部异常，`GET /api/logs` 查看 companion 日志；常见原因是源站变更或防盗链。

**播放 403/404** → 直接用 `url` 播放时缺少 `headers`；请改用 `streamUrl`。

**部分标题乱码** → 上游站点以 GBK 编码返回但未声明 charset，属于源侧问题。
