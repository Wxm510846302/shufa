# 书法作业 AI 点评 Demo

一个单页 Web Demo：上传书法作业图片，选择书法类型，后端调用 Gemini 多模态模型返回结构化点评，并用 `sharp` 在原图上绘制标注框。

## 交付说明

这个包可以本地运行，也可以部署到 Vercel / Render / 自有 Node.js 服务器。不要把真实 `GEMINI_API_KEY` 写进代码仓库，部署时请放到环境变量里。

## 本地启动

```bash
npm install
npm start
```

打开：

```text
http://localhost:3000
```

## Gemini 配置

复制 `.env.example` 为 `.env`，填入 Google AI Studio API Key：

```bash
GEMINI_API_KEY=your_google_ai_studio_api_key
GEMINI_MODEL=gemini-2.5-flash-lite
GEMINI_FALLBACK_MODELS=gemini-2.5-flash,gemini-3.5-flash
GEMINI_API_BASE_URL=https://generativelanguage.googleapis.com/v1beta
PORT=3000
```

未配置 `GEMINI_API_KEY` 时，Demo 会自动使用本地 mock 点评数据，上传、标注图生成和下载流程仍然可用。

页面右上角会显示当前模式：

- `Gemini 已接入`: 正在调用真实 Gemini API
- `Mock 模式`: 没有读取到 `GEMINI_API_KEY`，返回的是本地演示数据

如果线上出现 `This model is currently experiencing high demand`，说明 Google Gemini 当前模型拥堵。代码已支持按 `GEMINI_MODEL`、`GEMINI_FALLBACK_MODELS` 顺序自动重试其他模型；技术同事也可以在部署平台调整这两个环境变量。

如果 uniCloud 云函数报 `connect ETIMEDOUT ...:443`，说明云函数运行环境无法直连 Google Gemini。解决方式二选一：

- 将后端部署到可以访问 Google 的 Node/Vercel/Render/自有服务器。
- 配置一个兼容 Gemini REST API 的代理地址，并在云函数环境变量里设置：

```text
GEMINI_API_BASE_URL=https://你的代理域名/v1beta
```

默认值是 `https://generativelanguage.googleapis.com/v1beta`。

## 接口

```http
POST /api/calligraphy-review
Content-Type: multipart/form-data
```

字段：

- `image`: JPG / PNG / WEBP，最大 10MB
- `style`: `kaishu` / `xingshu` / `lishu` / `zhuanshu` / `caoshu` / `hard_pen`

返回包含原图地址、标注图地址、整体点评、标注点明细和练习建议。

## 部署要点

- Node.js 建议使用 20+。
- 启动命令：`npm start`
- 生产环境变量至少配置：`GEMINI_API_KEY`
- 推荐环境变量：
  - `GEMINI_MODEL=gemini-2.5-flash-lite`
  - `GEMINI_FALLBACK_MODELS=gemini-2.5-flash,gemini-3.5-flash`
  - `GEMINI_API_BASE_URL=https://generativelanguage.googleapis.com/v1beta`
- Vercel 已包含 `vercel.json`。
- Render 已包含 `render.yaml`。
- 上传图片会临时写入 `/tmp` 或 `public/uploads/tmp`，请求结束后自动清理。

## 验证命令

```bash
curl http://localhost:3000/api/status
```

返回 `provider: "gemini"` 表示真实 Gemini Key 已生效；返回 `provider: "mock"` 表示未配置 Key。

## HBuilderX / uniCloud 云函数获取 Key

已提供 HBuilderX 可识别的云函数目录：

```text
uniCloud-aliyun/cloudfunctions/get-gemini-api-key/
```

使用步骤：

1. 用 HBuilderX 打开项目目录。
2. 关联或创建 `uniCloud` 阿里云服务空间。
3. 右键 `uniCloud-aliyun/cloudfunctions/get-gemini-api-key`，选择“上传并运行”或“上传部署”。
4. 在 uniCloud 控制台给该云函数配置环境变量：

```text
GEMINI_API_KEY=你的 Google AI Studio API Key
```

前端临时调用示例：

```js
const res = await uniCloud.callFunction({
  name: 'get-gemini-api-key'
});

if (!res.result.success) {
  throw new Error(res.result.message || '获取 Gemini Key 失败');
}

const apiKey = res.result.data.apiKey;
```

注意：让云函数把 API Key 返回给前端只适合临时调试，线上仍然会暴露 Key。正式上线建议改成“前端上传图片到云函数，云函数调用 Gemini，前端只拿点评结果”，不要把 `apiKey` 返回给浏览器或 App。

## GitHub Pages 调用 uniCloud 云函数

GitHub Pages 只能托管静态页面，不能读取 uniCloud 控制台里的环境变量。要让 Pages 页面使用 uniCloud 的 `GEMINI_API_KEY`，需要部署这个 HTTP 云函数：

```text
uniCloud-aliyun/cloudfunctions/calligraphy-review-api/
```

操作步骤：

1. 在 HBuilderX 里右键 `calligraphy-review-api`，上传部署。
2. 在 uniCloud 控制台给 `calligraphy-review-api` 配置环境变量：

```text
GEMINI_API_KEY=你的 Google AI Studio API Key
GEMINI_MODEL=gemini-2.5-flash-lite
GEMINI_API_BASE_URL=https://generativelanguage.googleapis.com/v1beta
```

3. 在 `calligraphy-review-api` 的“云函数URL化”里开启 HTTP 访问，复制 URL，例如：

```text
https://fc-xxx.next.bspapp.com
```

4. 如果想让 `https://wxm510846302.github.io/shufa/` 裸链接直接可用，把云函数 URL 写到 `public/config.js`：

```js
window.CALLIGRAPHY_API_BASE_URL = 'https://fc-xxx.next.bspapp.com';
window.CALLIGRAPHY_API_MODE = 'json';
```

然后重新发布 `public/` 到 GitHub Pages。

也可以临时用下面格式打开 GitHub Pages：

```text
https://wxm510846302.github.io/shufa/?api=https://fc-xxx.next.bspapp.com&apiMode=json
```

`apiMode=json` 表示前端会把压缩后的图片用 base64 JSON 发给 uniCloud 云函数，由云函数内部调用 Gemini。不要把 `get-gemini-api-key` 的返回值暴露给正式页面。
