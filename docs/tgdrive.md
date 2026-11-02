# 接入已有 TGDrive 后端

TGDrive负责Telegram账号、群频道来源、媒体索引与流式传输。音乐Worker只浏览音频，并把导入歌曲的自定义信息保存到D1。

## 1. 更新现有TGDrive后端

使用支持 `/v1/music/*` 接口的TGDrive版本，在该后端 `.env` 添加：

```dotenv
MUSIC_SERVICE_TOKEN=填写单独生成的随机令牌
MUSIC_FRONTEND_ORIGIN=https://music.example.com
```

`MUSIC_FRONTEND_ORIGIN` 填音乐网页的真实 origin，不带路径。重启TGDrive后端使其生效。可用 `openssl rand -hex 32` 生成专用令牌；不要复用TGDrive管理令牌，也不要提交真实值。

这个令牌只能访问音频集成接口，不能登录/退出TG账号、增删网盘来源或浏览视频。共享已有后端和已建立的索引，不需要第二台服务器。

## 2. 创建D1并执行迁移

创建一个专供音乐元数据使用的D1，例如 `music-metadata`，将 `migrations/0001_tg_tracks.sql` 应用到该库。

```bash
npx wrangler d1 create music-metadata
npx wrangler d1 execute music-metadata --remote --file migrations/0001_tg_tracks.sql
```

将数据库绑定到音乐Worker，变量名为 **`MUSIC_DB`**。保留已有 `MUSIC_BUCKET`、`AUTH_TOKEN`、域名和其他绑定。

## 3. 配置音乐Worker

| 配置 | 值 |
| --- | --- |
| `MUSIC_BUCKET` | 原有R2桶 |
| `AUTH_TOKEN` | 原有管理令牌；TG导入和编辑必须配置管理令牌 |
| `MUSIC_DB` | 上一步创建的D1 |
| `TGDRIVE_URL` | 已有后端基址，例如 `https://api.example.com/tgdrive-api` |
| `TGDRIVE_TOKEN` | 与后端 `MUSIC_SERVICE_TOKEN` 相同，作为Worker secret保存 |

在仓库根目录执行：

```bash
npm ci
npm run build
```

普通版部署 `dist/worker.js`，拾音主题版部署 `dist/zt-worker.js`。这些是可直接粘贴的单文件构建产物。使用Wrangler源码部署时可以参考 `wrangler.example.jsonc`，把实际配置保存在已忽略的 `wrangler.local.jsonc`。

## 4. 导入与编辑

1. 在音乐网页用原有管理令牌登录。
2. 点击「从 TGDrive 添加歌曲 · 仅音频」。
3. 选择来源、搜索歌曲，跨页勾选需要的音频。
4. 可在导入行修改歌名，并为本批歌曲填写专辑和海报HTTPS链接。
5. 导入后，使用原有歌曲编辑按钮修改歌名、艺术家、专辑，或上传海报。

网页自动按每请求10首分批导入，以兼容Worker请求限额。重复导入不会覆盖已编辑的歌曲信息。

海报可使用HTTPS链接，或上传图片。上传图片沿用原有的600px压缩流程，TG海报限512KiB，二进制写入D1，不占用R2；R2歌曲的原有5MiB封面规则保持原样。

## 存储与播放

- D1：TG音频引用、原文件名、歌曲名、艺术家、专辑、海报URL/图片、歌词。
- 原有R2：已有音乐、原有歌曲元数据、站点设置、背景、自定义播放顺序。
- TGDrive：真实Telegram会话、来源索引和音频内容。

音乐列表不会保存即将过期的播放地址。每次播放会从TGDrive获取新的音频专用签名，然后让浏览器直连后端；Range拖动与标签读取通过后端CORS配置支持。

音乐Worker和后端都会检查音频类型，视频不能导入或通过音乐接口播放。移除音乐库中的TG歌曲不会删除Telegram原始消息或TGDrive索引。

## 持续播放检查

后端会将浏览器任意字节范围对齐到Telegram下载分块，再裁剪为请求范围，避免Safari/WebKit续读时音频流提前截断。升级2.2.1时应同时更新TGDrive后端。

```bash
npm run build
npx playwright install --with-deps webkit
node tests/browser.mjs --webkit --long-playback
```
