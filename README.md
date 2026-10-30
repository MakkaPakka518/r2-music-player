# R2 Music · Cloudflare R2 在线小型播放器

配合 Cloudflare R2 的在线音乐播放器。**单文件 Worker**:前端播放器与后端接口全部内嵌在 `worker.js`,粘贴到 Cloudflare Dashboard 即可部署,不依赖任何框架、数据库或第三方服务。

- **存储**:音频文件存 R2,免费额度 10GB / 月,流量(出口)免费
- **播放**:在线播放与进度条拖动(Range 206)、上一首/下一首、播放进度记忆、键盘快捷键(空格/←/→)
- **全屏播放页**:唱片机视觉、封面、进度拖动、队列、媒体会话(锁屏显示歌曲信息)
- **专辑管理**:歌曲/专辑双视图、封面图上传、歌曲元数据(标题/艺术家/专辑)编辑
- **排序**:自定义顺序,保存到 R2
- **上传**:网页直接上传,拖拽/多选,单文件 ≤ 50MB(mp3 / m4a / flac / ogg / wav / aac 等)
- **管理**:可选 `AUTH_TOKEN` 保护上传/删除/编辑;不配置则公开可传
- **站点个性化**:站点名称、logo、背景图可配置
- **主题**:深色/浅色切换,移动端优先

## 一、部署(约 3 分钟)

### 1. 创建 R2 Bucket

1. Cloudflare Dashboard → **R2** → **创建存储桶**
2. 名称随意,如 `music`(区域建议选近的,如 `APAC` 或 `ENAM`)
3. 创建完成

### 2. 创建 Worker 并绑定 R2

1. Dashboard → **Workers & Pages** → **创建 Worker** → 名称随意(如 `r2-music`)→ **部署**
2. 进入该 Worker → **设置** → **绑定** → **添加绑定**:
   - 类型:**R2 存储桶**
   - 变量名称:**`MUSIC_BUCKET`**(必须与代码一致)
   - 存储桶:选择刚才创建的桶
3. **编辑代码** → 清空 → 粘贴 `worker.js` 全部内容 → **保存并部署**

### 3. (可选)配置管理令牌

Worker → **设置** → **变量和机密** → **添加**:

| 类型 | 名称 | 值 |
|---|---|---|
| 文本变量 | `AUTH_TOKEN` | 任意随机串(建议 32 位以上,可用 `openssl rand -hex 16` 生成) |

> 配置后:上传/删除需在播放器右上角锁形按钮输入令牌;不配置则无需登录即可上传(适合个人自用)。
> 建议配置,避免公开 Worker 被他人滥用存储。

### 4. 完成

访问 `https://<你的worker>.workers.dev/` 即可使用。可自定义域名(Workers → 自定义域)。

## 二、接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 播放器页面 |
| GET | `/api/list` | 音频文件列表(`{files:[{name,size,uploaded,title,artist,album,cover}],order,version}`) |
| POST | `/api/upload?name=文件名` | 上传音频(raw body;≤50MB;需令牌) |
| GET | `/api/file/<name>` | 流式播放,支持 `Range` 请求(206) |
| DELETE | `/api/file/<name>` | 删除文件(需令牌) |
| POST | `/api/verify` | 校验令牌(前端登录用) |
| PUT | `/api/order` | 保存自定义播放顺序(需令牌) |
| PUT | `/api/meta/<name>` | 编辑歌曲元数据:标题/艺术家/专辑(需令牌) |
| GET/PUT | `/api/cover/<name>` | 获取/上传歌曲封面图(POST 上传、DELETE 删除;需令牌) |
| GET/PUT | `/api/site` | 读取/保存站点设置(名称、公告等;PUT 需令牌) |
| GET/POST/DELETE | `/api/site/logo` | 站点 logo(POST/DELETE 需令牌) |
| GET/POST/DELETE | `/api/site/background` | 站点背景图(POST/DELETE 需令牌) |

## 三、说明与限制

- R2 免费层:10GB 存储 / 月,出口流量免费,A 类操作 100 万次 / 月,B 类操作 1000 万次 / 月,超出按量计费
- 单文件上传上限 50MB(Worker 请求体限制),可自行修改 `MAX_UPLOAD_BYTES`
- 上传同名文件会覆盖旧文件
- 播放列表实时读 R2,无需后端存储;播放进度与播放列表在浏览器本地(IndexedDB)记忆
- 歌曲封面、站点 logo/背景图等附加资源同样存于 R2 桶内(以约定 key 前缀存储)

## 四、开发

```bash
# 语法校验(CF Worker 为 ESM,需复制为 .mjs 再 check)
cp worker.js /tmp/check.mjs && node --check /tmp/check.mjs

# 路由逻辑 mock 测试(内存 R2,无需真实桶)
node /tmp/r2m-mock-test.mjs
```

## 五、版本

见 [changelog.md](./changelog.md)。
