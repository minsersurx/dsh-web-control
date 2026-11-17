# DSH Remote Console

一个可部署到 GitHub Pages 的轻量网页控制台，以及一份可自托管的 Node.js 桥接服务。网页可经桥接服务连接兼容的 DSH Web API，创建会话、发送文字任务、请求停止并读取最近的纯文字消息。

> **重要边界：这不是 DSH Go 官方组件，也不是现成的手机遥控 API。** DSH Go 项目说明，手机读屏、点按和输入只对本机引擎开放；Android 本机 `dsh web` 默认绑定 `127.0.0.1`，官方客户端连接时不发送 `Origin`。GitHub Pages 的静态网页不能直接跨设备接入该本机服务。这个仓库提供的桥接程序必须由你放在能够合法、受信地访问 DSH 主机的环境中并自行保护；它不会给 DSH Go 手机端增加未提供的 API，也不会绕过 DSH Go 原生手机操控确认。

## 能力与限制

- 浏览器连接自托管桥接服务，列出 DSH 会话、创建会话、发送文字任务、停止当前任务并查看最近文字消息。
- 连接密钥只在当前网页标签页内存中；刷新或关闭标签页即清除。DSH 临时启动令牌和会话 Cookie 留在桥接服务端内存中，不放在网页代码、查询参数或公开仓库。
- 浏览器不接触 DSH 的原始令牌或 Cookie。桥接服务只允许精简的会话/任务 API，按精确的网页 Origin 开放 CORS。
- **不支持**文件/图片上传、工具审批代答、绕过安全模式，或从网页直接读取/点击另一台手机的屏幕。目标 DSH 如发起手机操作或敏感操作，仍需在有权的设备/应用中完成确认。
- 对 DSH Go 手机本机引擎，桥接服务能否与其本地服务互通取决于该 App/运行环境是否实际开放了可用接口及令牌；上游没有提供可供本网页启用的外部开关。请不要把下列通用桥接示例误认为已验证的 DSH Go 手机端方案。

来源：DSH Go [README](https://github.com/ccch1mneyyy/dsh-go#readme)、[架构说明](https://github.com/ccch1mneyyy/dsh-go/blob/main/docs/architecture.md#56-本地连接) 和[手机操控指南](https://github.com/ccch1mneyyy/dsh-go/blob/main/docs/guide/zh/04-phone-control.md)。

## GitHub Pages 部署

仓库的 GitHub Actions 会在推送到 `main` 后发布纯静态前端。到仓库 **Settings → Pages**，将 Build and deployment 的 Source 设为 **GitHub Actions**。工作流完成后，网页地址通常是 `https://<GitHub 用户名>.github.io/<仓库名>/`。

Pages 只托管静态页面；它不会运行 Node 桥接程序，也不会在 GitHub 保存用户的 DSH 凭据。未连接时仍可点“预览界面演示”，演示数据完全本地生成，不会访问网络或执行任务。

## 自托管桥接服务

需要 Node.js 20 或更新版本。请仅在你控制、且能够访问 DSH Web API 的主机或私有网络中运行桥接服务。桥接默认只监听 `127.0.0.1`；公开 GitHub Pages 若要访问它，必须通过你信任的 VPN/HTTPS 反向代理安全转发到本地端口，并在 `PANEL_ORIGIN` 中精确设置网页的 **Origin**（只有协议、主机和端口，不包含仓库路径）。

示例：

```bash
# 设置 DSH 页面来源（以本仓库 Pages 域名为例）
export PANEL_ORIGIN="https://minsersurx.github.io"
export PANEL_KEY="$(openssl rand -hex 32)"
export DSH_BASE_URL="http://127.0.0.1:3080"
export DSH_LAUNCH_TOKEN="<从你有权访问的 DSH 主机启动输出中取得的临时令牌>"

node bridge/server.mjs
```

启动令牌只对对应 DSH 进程有效。请勿把令牌写进静态网页、公开仓库、聊天记录或 URL；不要把桥接端口直接暴露到公网，也不要使用无访问控制的临时隧道。没有 HTTPS 的公网 HTTP 桥接地址会被浏览器拒绝。若 DSH 进程重启或桥接返回认证错误，先确认主机状态，再用新令牌重启桥接。

要在本机运行集成测试：

```bash
node --test bridge/server.test.mjs
```

## API

桥接程序只实现网页所需的这些路径：

- `GET /health`：不含设备信息的服务存活检查。
- `GET /v1/status`、`GET /v1/sessions`：需 `Authorization: Bearer <PANEL_KEY>`。
- `POST /v1/sessions`：创建空白会话。
- `GET /v1/sessions/:id/history`：读取最近最多 40 条会话中的纯文字消息。
- `POST /v1/sessions/:id/prompt`：发送最多 8,000 字符的文字任务。
- `POST /v1/sessions/:id/cancel`：发送停止请求。

桥接程序不会记录请求体、密钥、启动令牌或 Cookie。任务可能已经到达 DSH、但浏览器在结果返回前断线；这种情况下请先检查设备上的会话状态，不要盲目重复发送。

## 许可

本仓库新增代码采用 MIT 许可。DSH Go 与 DeepSeek Harness 属于各自维护者；本项目仅引用其公开 API 说明，不是其官方版本或背书产品。
