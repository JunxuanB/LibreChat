# sub2api 聊天端

基于 LibreChat `main` 的 `f10b1d91f`，定制版本 `1.0.2`。源码：<https://github.com/JunxuanB/LibreChat/tree/sub2api>。

## 部署

将同目录的 `compose.yaml` 保存到服务器一个单独目录，执行：

```sh
docker compose up -d
```

浏览器打开 <http://192.168.2.29:3080>，输入现有 sub2api API Key 即可使用。无需注册邮箱或密码。同 Key 在手机、电脑上共享聊天记录；任何持有该 Key 的人都能查看这些记录。不同 Key 的记录与附件相互隔离。

默认与 sub2api 部署在同一台 Linux 主机，sub2api 的宿主机端口为 `7777`。如需调整地址，仅修改 YAML 的 `SUB2API_URL`（容器访问网关地址）、`SUB2API_PUBLIC_URL`（用户浏览器访问主站地址）、`DOMAIN_CLIENT` / `DOMAIN_SERVER`（用户浏览器访问聊天端地址）及端口映射。使用域名或反向代理时将两个 DOMAIN 值设置为同一外部 HTTPS 地址。远程公开访问时请使用 HTTPS。

镜像 `junxuanb/librechat:1.0.2` 支持 Linux amd64 和 arm64。仅启动聊天端、初始化容器及独立 MongoDB，不需要 Meilisearch、向量数据库或邮件服务，不改动现有 sub2api 数据库。

## 使用

- 默认简体中文，已有语言偏好仍会保留。首次默认选择 `gpt-6.1-sol`（需该 Key 可用），之后保留用户主动选择。GPT-6 模型在输入框下方可直接选择推理强度（自动、低、中、高），切换后即时更新显示；旧记录中高于“高”的设置按“高”发送。隐藏完整自定义参数面板。
- 登录时校验 Key，自动载入该 Key 可用的模型；模型请求直接使用该 Key，额度、分组和计费遵从 sub2api。
- 自动同步主站名称、简介与受支持的图片 Logo，设置缓存最多一分钟。
- Key 被禁用后，已有会话的后续访问最多在 30 秒内被阻止；余额耗尽但 Key 仍有效时可以查看历史，发送新消息由 sub2api 判断余额。
- 菜单中的“API Key / 余额”跳转到主站管理页；更换 Key 使用“切换 API Key / 退出”，进入新 Key 的聊天空间。替换或重建 Key 不会迁移旧 Key 的历史。
- `gpt-image-*` 模型自动调用图片生成接口；上传 PNG/JPEG/WebP 参考图时自动调用图片编辑接口。生成图片持久保存，可预览、下载和跨设备恢复，下载按 Key 校验权限。每次生成一张，默认最长等待五分钟，失败不自动重试。
- 输入框的“技能”菜单可以选择 Skill，或将当前对话总结为 Skill 的请求填入输入框，检查后发送。也可以直接说“把这次对话总结为 Skill 并保存”，或输入 `$` 手动选择。AI 使用工具实际保存到当前 Key 的聊天空间，后续对话按需调用；侧栏的技能面板可查看、编辑、停用和删除。仅支持指令与附属文件的保存、读取，不执行 Skill 中的脚本；需要支持工具调用的聊天模型。不同 Key 默认互不可见，不启用公开分享。`sub2api.skillsEnabled` 控制聊天中的 Skill 能力，部署配置默认为 `true`；完整配置还通过 `interface.skills` 设置使用/创建权限。
- 支持流式聊天、聊天导出、附件上传及下载。单文件最多 25 MB，每次最多 5 个、合计 50 MB。文档转换为文本上下文，图片交由支持视觉的模型；实际解析格式和识图能力取决于解析器与所选模型。不包含沙箱代码执行或自动生成 Office/PDF 文件的服务。

## 数据与升级

Compose 使用持久卷保存 `config`、`mongodb`、`uploads`、`images`、`logs`。`config` 中的密钥首次自动生成、之后复用；API Key 使用 LibreChat 的服务端加密凭据存储，身份由 HMAC 派生，不写入普通部署 YAML。请同时备份 `config`、MongoDB 和附件卷；丢失或重新生成 config 密钥会导致历史无法正常关联或凭据无法解密。

```sh
docker compose pull
docker compose up -d
```

升级时在 YAML 中更新两个聊天端镜像标签，沿用原目录与卷。不要执行 `docker compose down -v`。初始化容器每次启动根据当前地址生成配置，但不会覆盖已有密钥。

## 本地验证

新增身份并发、授权、禁用 Key、跨 Key 隔离及中文登录表单的定向 Jest 测试；运行各修改工作区的 `npx tsc --noEmit`、`npm run frontend` 与 Lighthouse。`deploy/sub2api/tests/smoke.cjs` 使用独立的模拟网关和真实 MongoDB 验证流式聊天、上传下载、权限隔离、推理强度的 UI/请求同步、Skill 的工具保存/自动调用/手动选择/跨 Key 隔离，以及手机、电脑独立登录后的同 Key 历史恢复，不会调用真实付费模型。

```sh
# 先使用独立测试 MongoDB，端口默认 37017
SUB2API_SMOKE_BROWSER=true node deploy/sub2api/tests/smoke.cjs
```

上游 LibreChat 许可证与原有说明保留。本分支手动发布，不自动更新服务器。
