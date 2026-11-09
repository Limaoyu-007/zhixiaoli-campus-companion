# 当前源码地图

2026-11-05更新。本文描述当前运行代码。最新输入区、独立凭据与内嵌课表编辑约定先读CONTEXT.md；10月24日阶段总结保留为历史背景。

## 阅读顺序

1. main.js：桌面生命周期、窗口、IPC和服务装配；配置规则在services/app-config.js，双模式对话在services/chat-coordinator.js。
2. preload.js：页面能用的IPC接口。
3. renderer/campus-chat.js：提问、切换、新会话、停止、进度与回复展示。
4. services/agent/local-agent-runtime.js：模型/工具循环。
5. services/agent/model-provider.js、study-tools.js、study-session-store.js：模型协议、工具和上下文。
6. services/memory-service.js：两种模式共用的长期记忆。

## 调用链

    聊天页面 → preload.js → chat-coordinator.js（由main.js装配）
      校园：memory + timetable背景 → campus-agent-service
            → 学校平台 → campus-response → 回复/业务反馈
      学习：memory背景 + 当前历史 → LocalAgentRuntime
            → model-provider → study-tools → 结果回传模型
            → 回答与完整成功轮次
    → 气泡、人物状态、可选朗读

普通会话和执行状态按模式隔离，长期记忆共用；两边重启均新建会话。校园首次把背景拼到query，通用每次启用时刷新记忆背景，均只把原始问答送入整理队列。

## 文件职责

| 模块 | 职责 |
| --- | --- |
| main.js / preload.js / start.js | 桌面入口、IPC桥、启动与服务装配 |
| services/app-config.js / config-store.js | 配置默认值、分发预置、设置校验、凭据加解密与密文级解密缓存、分类变更比对与公开视图；配置文件保存、备份、恢复与内存克隆缓存 |
| services/chat-coordinator.js | 双模式会话、请求生命周期、取消、记忆/课表编排与回复IPC；向主进程提供配置变更与退出时的取消入口 |
| renderer/campus-setup.js / .css | 首次使用引导、配置状态与设置入口 |
| renderer/index.html | 主窗口布局与268px居中云朵对话卡样式（上层无框输入行+下层26px微底栏合二为一，带指向人物脚底的气泡尖角） |
| renderer/campus-chat.js | 两种模式共用聊天控制、点击人物唤起/收起对话卡（openChatDock/closeChatDock/toggleChatDock） |
| renderer/campus-bubbles.js / campus-markdown.js | 气泡和Markdown |
| renderer/campus-feedback.js / services/campus-answer.js | 可信业务反馈、正文过滤 |
| renderer/campus-settings.* | 统一设置、明文独立API Key、资料及课表统一保存、日志入口 |
| renderer/campus-timetable.js | 设置页内的PDF/图片导入、识别草稿与核对编辑；CampusTimetableEditor协调草稿、忙碌状态与保存 |
| renderer/campus-speech.js | 音频播放/停止、音量与口型状态 |
| renderer/portrait-pet.js / .css | 人物交互、分区触摸微台词（.portrait-whisper）、回复语义神态联动、命中/穿透、展示优先级 |
| renderer/portrait-live2d.js | 正面/侧面模型切换、参数驱动、口腔UV补偿、Canvas回退 |
| services/portrait-asset.js | 旧默认图片URL归一化 |
| renderer/portrait-layered.js / portrait-mesh.js | 分层、网格、统一动作时钟 |
| renderer/portrait-blink.js / portrait-mouth.js / portrait-wave.js | 完整立绘模式眨眼、口型和挥手 |
| services/agent/local-agent-runtime.js | 系统提示词、记忆背景、工具循环和预算 |
| services/agent/model-provider.js | Chat Completions兼容接口与消息解析 |
| services/agent/study-tools.js | 时间/课表/学习通工具注册、参数与结构化结果 |
| services/chaoxing/client.js | 学习通登录、课程选择、动态签名和作业查询 |
| services/chaoxing/http-session.js | HTTPS、私有内存Cookie、重定向、超时及取消 |
| services/chaoxing/page-parser.js / errors.js | HTML结构化解析、歧义/空列表识别与明确错误 |
| services/agent/study-session-store.js | 学习会话、启动重置、有界完整轮次 |
| services/campus-agent-service.js / campus-response.js | 学校平台HTTP/SSE与业务结果 |
| services/campus-session-store.js | 平台会话与不确定结果提示 |
| services/memory-service.js | 本机资料/摘要、整理、注入、编辑清空；仅保留现行共享接口 |
| services/campus-timetable-service.js / timetable-utils.js | 课表存储、识别、周次/节次 |
| services/campus-debug-log.js | 日志轮转、脱敏与导出 |
| services/campus-tts-service.js | Python edge-tts进程管理 |
| assets/zhixiaoli/ | 当前立绘、五官、挥手和分层素材 |
| assets/brand/ / scripts/make-icons.js | 品牌SVG及PNG/ICO生成 |
| libs/ | Marked、DOMPurify浏览器文件和许可证 |

## 数据与兼容

配置、会话、长期记忆、课表和日志保存在userData。品牌改名后仍兼容open-desktop-pet目录，明确指定user-data-dir则尊重指定目录。

main-campus.js/preload-campus.js已统一为main.js/preload.js；原版旧同名入口先备份后删除。原聊天/设置/调试页与上游角色已移除；2026-11-03为智小理模型重新接入本地Pixi/Live2D库与portrait-live2d控制器。没有Vue、摄像头、截屏或旧多供应商语音链路。

2026-10-27收尾验证覆盖独立Electron交互、后端回归和脚本语法；真实外部模型/平台与安装包尚未验收。后端测试入口为tests/review-backend.test.cjs，可通过npm test运行。Runtime仍在主进程执行，未拆独立服务或工具子进程。

当前list_homework工具由main.js注入学习通客户端；设置页保存账号及safeStorage加密密码，不向模型传递凭据，也不向页面回填密码。工具参数只有课程关键词和可选候选编号，不接受账号、密码、URL或Cookie。HTML使用Cheerio解析，不加载页面脚本或额外资源。用户于2026-10-24反馈查询可用，代理未独立进行真实登录验收，详见docs/CHAOXING_TOOL.md。
