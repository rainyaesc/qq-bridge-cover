# QQ Bridge Cover

本地短片段 AI 翻唱工作台，版本 **0.2.0**。歌曲资源来自网易云音乐，经片段截取、UVR 人声分离、RVC 音色转换和混音后，保存到 QQ Bridge 的语音库。提供独立中文设置页面，以及供现有 QQ Bridge / DSH 使用的四个 MCP 工具。

项目地址：<https://github.com/rainyaesc/qq-bridge-cover>

## 当前支持范围

- 单次翻唱 **5–45 秒**；默认 30 秒，可优先使用副歌或指定备用起点。
- UVR：具有对应 UVR hash metadata 的 **MDX ONNX** 模型；DirectML / CPU，GPU 编号 0–7，窗口重叠 0.25 / 0.5 / 0.75，正负推理降噪及自动 / 手动补偿。
- RVC：模型与可选索引、音高、`rmvpe` / `pm`、检索比例、辅音保护、RMS 包络混合和输出重采样。
- 混音：人声 / 伴奏增益、淡入 / 淡出及峰值上限。
- 设置保存后用于**下一次翻唱**；已创建任务持有不可变的配置快照，不受之后的设置修改影响。

目前 RVC 适配的是 **RVC20260718DML 的 `infer.vc` 模块、九参数 `vc_single` 接口**。其他 RVC 分支、版本及接口尚未验证；本项目不承诺适配任意 RVC 安装，也不支持直接使用任意 TTS 模型。UVR 的其他模型架构同样不在当前支持范围内。

## 部署前准备

使用 Windows、Node.js **22.13.0 或更新版本**，并准备：

1. 已可用的 RVC 环境，包括其 Python 运行时、所需依赖、FFmpeg，以及有权使用的 `.pth` 模型。使用 RMVPE 时也需准备对应资源。
2. UVR MDX `.onnx` 模型及匹配的 `model_data.json`。模型 hash 未被元数据识别时，不能在设置中选用。
3. 已运行的 QQ Bridge 和可用的 DSH profile。仅使用设置页面时可以暂不集成 MCP；完整翻唱入库流程仍需要正确配置现有桥接与语音库。
4. 可登录的网易云音乐账号和相应歌曲下载权限。

本仓库不提供 RVC / UVR 运行时、模型权重、歌曲音频或第三方账号。安装脚本不会替你取得模型使用授权。

## 安装与启动

在 PowerShell 中执行，示例路径请替换成自己的安装位置：

```powershell
git clone https://github.com/rainyaesc/qq-bridge-cover.git
cd qq-bridge-cover
npm ci --ignore-scripts

node scripts/setup.mjs --rvc-root "D:/RVC" --uvr-root "D:/UVR" --bridge-root "D:/qq-bridge" --voice "your-model.pth"
```

`setup` 根据已有目录创建本机 `config.local.json`，**不会覆盖已经存在的配置文件**。检查其模型、Python、UVR metadata、桥接地址和语音库路径；已有配置可对照 `config.example.json` 调整。配置中的 `enabled` 为翻唱开关，启用前应确认所有路径与权限正确。不要把本机配置提交到公开仓库。

登录网易云音乐：

```powershell
npm run login
```

按照终端提示访问本机 **3118** 端口的登录页面，使用实时二维码完成登录。登录信息使用 Windows **DPAPI** 加密保存。后续运行应使用**同一 Windows 用户**；换用户或换机器后，请重新登录，不要复制或公开登录数据。

启动设置工作台：

```powershell
npm start
```

打开 <http://127.0.0.1:3119>。可调整默认片段、UVR、RVC 和混音参数，查看近期任务并手动检测环境。端口可通过本机配置中的 `uiPort` 调整。恢复推荐值只修改草稿，仍需点击“保存设置”才会生效。

## 接入现有 QQ Bridge / DSH

```powershell
node scripts/integrate.mjs --dsh-home "D:/DSH/data" --profile desktop
```

集成脚本为指定 profile 配置 MCP，并维护固定四个工具的允许名称；修改现有守卫、preset 和 profile 前会备份。已有 QQ 控制台的设置入口可按脚本支持的选项接入。完成后应**完整退出并重启 DSH**，避免进程中的 ESM 缓存继续使用旧配置或旧模块。

本项目不更改 DSH / Codex 的模型提供商。MCP 首次启动时会自动确保设置服务运行；也可以单独运行 `npm start`。需要由其他 MCP 客户端启动时，入口为 `node mcp-cover.mjs`，使用 stdio 传输。

| MCP 工具 | 用途 |
| --- | --- |
| `search_song` | 按歌曲名 / 歌手搜索，返回至多五个歌曲 ID；同名歌曲应先确认 |
| `create_cover` | 创建翻唱任务；通常省略 `seconds`、`pitch`、`start`，由后端读取当前默认值 |
| `cover_status` | 查询当前会话任务，可有界等待完成 |
| `cancel_cover` | 取消当前会话的排队 / 运行任务 |

工具请求经过现有 QQ Bridge 的会话 key / token 授权与队列限制。工具不向 QQ 群暴露任意本地文件读取或命令执行能力。`create_cover` 完成后返回语音库名称，**不会自动发送 QQ 消息**；发送仍通过现有 `qq_send_voice` 和相应会话授权完成。任务仍在排队或运行时，不应声称已经完成。

## 本机设置 API

这些接口属于 **QQ Bridge Cover 本项目**，默认基址为 `http://127.0.0.1:3119`；不是其他插件、网易云或 RVC 的公共接口。服务仅监听回环地址，校验 Host 与 Origin。

先调用 `GET /api/session`，保留返回的会话 Cookie 与 `csrfToken`。其后的管理请求需使用同一会话，并携带 `X-Cover-CSRF: <csrfToken>`。

| 请求 | 说明 |
| --- | --- |
| `GET /api/bootstrap` | 获取 `revision`、当前设置、推荐值、模型目录与环境状态 |
| `PUT /api/settings` | JSON `{revision, settings}`，校验后保存并返回最新设置文档 |
| `GET /api/jobs` | 获取近期任务列表 |
| `POST /api/check` | 手动检查桥接、登录和运行时状态 |
| `GET /api/docs` | 查看项目接口摘要 |

保存遇到 HTTP **409** 表示其他窗口已修改配置，应重新加载最新版本再编辑，不能直接覆盖。API 可选模型使用目录中的模型 ID，而非接收任意文件路径。环境检测由用户手动触发，不会在后台反复请求网易云登录状态。

## 测试与已验证边界

```powershell
npm test
```

CI 使用 Node.js 22，执行 `npm ci --ignore-scripts` 和 `npm test`。测试为 JavaScript 单元测试及本机 API fixture，不需要 GPU、QQ / 网易云账号或外网服务，不代表真实模型推理、QQ 发送或所有安装环境均已验证。

发布前已完成的本机验收：

- HQ3 分离模型与 e500 音色模型的 30 秒基础流水线。
- 隔离设置 API 保存 8 秒片段及 UVR / RVC / 混音参数后，MCP 在未显式指定 `seconds` / `pitch` 时使用新默认值，生成 8 秒结果并入库。
- 九项 JavaScript 回归检查通过。

本轮没有自动发送 QQ 测试消息；浏览器视觉自动化访问被拒绝，界面视觉与交互验收**未实测**。其他 RVC 版本、其他设备及音色效果仍需部署者在自己的环境验证。

## 打包与公开发布

```powershell
npm run package
```

打包脚本生成源码 ZIP，使用代码 / 示例配置允许清单，不包含 `node_modules`、模型权重、原曲 / 输出音频、日志、账号 / SID、`config.local.json`、`data` 或私人验收资料。发布前仍应查看产物文件清单。

运行日志、任务记录、加密登录信息和配置备份属于本机私有运行数据。反馈问题时只提供必要且已脱敏的错误信息，勿直接上传这些目录。

## 授权与使用约定

本项目代码采用 [MIT License](LICENSE)。第三方代码、模型与音频不因本项目的 MIT 许可而获得额外授权，详见 [第三方说明](THIRD_PARTY_NOTICES.md)。

网易云相关能力使用社区维护的 **NetEaseAPIEnhanced** 包，属于非官方 SDK；歌曲是否可下载、可取得的音质由实际资源和会员权限决定。原曲可能需要整首下载，但分离与转换前会先截取片段，模型推理仅处理允许的 5–45 秒。

请自行取得歌曲、伴奏、音色模型及相关声线的使用与传播许可，并保留 AI 生成 / AI 翻唱身份说明。仓库不分发模型权重或音乐，也不代表模型作者、歌手或声线权利人授权。
