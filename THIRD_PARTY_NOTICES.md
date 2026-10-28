# 第三方组件与资源说明

QQ Bridge Cover 自有代码采用根目录的 MIT 许可证。第三方组件保留各自作者、版权与许可证；本项目许可证不替代其条款。安装依赖或准备运行时后，应同时保留对应发行包内的 LICENSE / NOTICE。

## 直接 JavaScript 依赖

以下版本对应 0.2.0 的 `package.json`；实际完整依赖树与版本以 `package-lock.json` 为准。

| 组件 | 版本 | 许可 | 来源 / 归属 |
| --- | --- | --- | --- |
| `@neteasecloudmusicapienhanced/api` | 4.41.1 | MIT | NetEaseAPIEnhanced；Binaryify 原项目及 MoeFurina 等社区维护者 / 贡献者 |
| `@modelcontextprotocol/sdk` | 1.30.0 | MIT | Model Context Protocol TypeScript SDK 的作者 / 贡献者 |
| `zod` | 4.4.3 | MIT | Colin McDonnell 及 Zod 贡献者 |

NetEaseAPIEnhanced 为**社区非官方网易云音乐 API 实现**。使用该依赖不表示获得网易云音乐官方认证，也不授予歌曲、会员资源或账号的额外访问 / 传播权利。

上述组件及其传递依赖的完整许可文本随 npm 包提供。源码分发不包含 `node_modules`；如另行分发预装依赖的发行物，分发者须一并保留相应第三方许可与通知。

## 外部运行时与适配项目

本项目调用部署者自行安装的外部环境，不在源码 ZIP 中分发它们：

- **Ultimate Vocal Remover（UVR）**：Anjok07 及相关作者 / 贡献者，项目代码采用 MIT。各模型、模型元数据及依赖的权利与许可需按其实际来源核对。
- **Retrieval-based Voice Conversion（RVC）**：RVC-Project、liujing04 等作者 / 贡献者，相关上游项目代码采用 MIT。本项目当前适配特定 RVC20260718DML 接口；该分支、运行时及其依赖仍以实际安装副本所附许可为准。
- **Python、ONNX Runtime / DirectML、PyTorch、FFmpeg 等**：由部署者的 RVC / UVR 环境提供，适用各自版本与构建的许可证。本项目不将这些组件的许可证统一声明为 MIT。
- **QQ Bridge / DSH**：使用部署者已有安装与配置，不随本仓库分发；适用其原有许可和访问规则。

## 模型、音色与音频

本仓库及源码打包产物**不分发** RVC `.pth` 权重、检索 `.index`、UVR `.onnx`、RMVPE 权重、原曲、伴奏、转换音频、账号信息或登录凭据。

模型许可、训练数据授权及声线使用许可取决于具体下载 / 训练来源，不能从本项目的 MIT 许可证推导。部署者需要分别确认模型、歌曲录音、词曲、伴奏及相关人格 / 声音权益的使用和传播授权，并保留 AI 生成 / AI 翻唱身份说明。本项目不声称取得任何特定歌手、角色或声线的许可。

如需要分发包含第三方软件或资源的派生发行物，请先核对其实际许可证及通知要求，再保留相应文本和署名。
