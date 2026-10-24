# 智小理·校园伴行：开发交接

更新时间：2026-10-24。项目一已按用户决定结束本阶段功能开发，转入比赛与路演展示准备。本文是当前交接入口，不代表实时服务健康状态。

## 接手先看

1. [README](README.md)：公开介绍、启动、配置、数据去向及能力边界。
2. [阶段总结](docs/PROJECT_SUMMARY_20261024.md)：本阶段产出、用户反馈、收尾决定和后续范围。
3. [源码地图](CAMPUS_SOURCE_MAP.md)：模块职责与真实调用链。
4. 按具体任务再读下表中的功能文档，不默认继续扩展项目。

## 已确定的范围

- 人物形象与交互到此收尾。不自动补图、调整头脸、重做动画或转向 Cubism。
- 校园业务继续调用学校 Agent 平台，其会话、规划和业务工具由平台管理。
- 通用学习由本地 LocalAgentRuntime 直接调用用户配置的兼容模型接口，自行管理上下文、工具循环与结果回传。目前只注册北京时间、个人课表、学习通指定课程作业三个只读工具。
- 用户于 2026-10-24 反馈学习通作业查询已经实现、项目可供比赛展示。记录为用户实际体验反馈，不能扩大成所有账号、课程或所有功能均通过验收。
- 本阶段停止扩功能。后续收到明确任务再处理比赛材料、演示问题或新需求，不自动开展搜索、文件操作、全课程扫描、定时任务或其他校园接入。

## 架构与数据契约

启动：`node start.js` → `package.json.main = main.js` → `preload.js` → `renderer/index.html`。

Electron + Node.js/CommonJS + 原生 HTML/CSS/JavaScript；Canvas 2D 分层与网格人物；Marked/DOMPurify；PDF.js；Cheerio；可选 Python edge-tts。Runtime 在主进程中作为模块运行，无独立 HTTP 服务、JDK 或额外 Agent 框架。

两个模式各自维护一个当前会话和进行中的请求。切换不取消旧任务，事件按 mode/sessionId/requestId 归属，旧模式回复不插入当前模式或自动朗读。停止和新会话只作用于选中的模式。每次重启两边都新建普通会话，同一进程内切换/刷新不重置。

长期记忆共用 `campus-memory.json`、开关、学生资料和摘要。启用时通用请求注入当前资料/摘要，成功原始问答进入共享待整理队列；注入背景、原始工具结果和推理正文不作为待整理问答。新会话首条消息前尝试整理积压，独立 25 秒上限；记忆整理使用独立百炼配置，不随聊天厂家切换。关闭后不注入、不采集新问答。普通上下文与长期记忆不是同一份历史。

课表原文件与确认表在本机保存；识别仅产生草稿，用户保存后才生效。校园每轮注入已确认课表，通用模式按需调用工具。资料不完整时不能断言无课。

默认数据目录兼容 `app.getPath('appData')/open-desktop-pet`；显式 `--user-data-dir` 继续生效。品牌改名不迁移或清空配置、记忆和课表。

## 学习通实现

参考用户提供的 Java ChaoxingClient/HomeworkTool，未修改或运行 Java 工程。Node 客户端独立负责登录、课程列表、签名和作业查询，Cheerio 固定为 1.0.0。

`list_homework(course, course_key?)` 优先精确匹配课程；多候选返回明确选择问题，Runtime 暂停本轮剩余工具，让用户确认，不让模型自行挑选。必须有可信空列表标志才表示无作业，解析失败不等于无作业。返回作业名称、原页面状态、进度和查询时间；没有全课程扫描、截止时间、题目读取或提交。

账号设置位于“设置 → 学习通”。密码由主进程 safeStorage 加密，页面不回填明文/密文，模型不接收凭据、Cookie 或动态签名。CHAOXING_PHONE/CHAOXING_PASSWORD 成对覆盖，禁止混用不同来源。Cookie 仅在内存；识别登录失效最多重登一次；额外验证明确提示。修改账号配置会停止当前通用请求并清理会话。

## 源码与品牌整理

已移除停用原版页面、模型/语音服务、Live2D 控制器和上游角色、Pixi/Cubism 库、旧 Logo 和 NSIS 定制。当前入口统一为 main.js/preload.js，保留适用版权与许可证。

品牌为智小理·校园伴行，package 为 zhixiaoli-campus-companion；窗口、托盘与构建配置使用 assets/brand 下自有 SVG/PNG/ICO。本地老目录名可继续保留，不影响产品名。

旧配置、源码整理备份和历史过程只用于本机回溯，不作为公开运行依赖。首次公开发布采用当前源码的干净快照，不上传原本 Git 历史、停用素材、真实凭据、用户数据、依赖或构建目录。

## 功能文档

| 文档 | 关注点 |
| --- | --- |
| [LOCAL_AGENT_RUNTIME.md](docs/LOCAL_AGENT_RUNTIME.md) | 模型适配、工具循环、上下文、预算、共享记忆 |
| [CHAOXING_TOOL.md](docs/CHAOXING_TOOL.md) | 学习通账号、查询流程、候选确认、错误和范围 |
| [CAMPUS_MEMORY.md](docs/CAMPUS_MEMORY.md) | 资料/摘要、独立记忆配置和开关 |
| [CAMPUS_TIMETABLE.md](docs/CAMPUS_TIMETABLE.md) | 识别草稿、编辑保存、周次与节次 |
| [CAMPUS_DEBUG_LOG.md](docs/CAMPUS_DEBUG_LOG.md) | 脱敏日志和定位入口 |
| [CAMPUS_LAYERED_PORTRAIT.md](docs/CAMPUS_LAYERED_PORTRAIT.md) | 已收尾的人物实现和历史效果证据 |
| [CAMPUS_PROMPT_BASELINE.md](docs/CAMPUS_PROMPT_BASELINE.md) | 用户给出的旧提示词参考，非平台部署快照 |
| [PUBLIC_RELEASE.md](docs/PUBLIC_RELEASE.md) | 公开仓库、发布范围与维护方式 |

## 证据与协作边界

用户于 10 月 23 日确认独立百炼记忆整理调用跑通，之后补接了通用模式；10 月 24 日反馈学习通作业查询可用。既往确认不能扩大到跨平台、所有模型、全量业务或新安装包。

本次收尾只整理文档、检查公开上传范围并发布源码；没有运行测试、构建、桌面验收或真实模型/校园/学习通请求。未生成新安装包。默认由用户负责体验，不主动加复杂校验流程。

校园写操作仍以真实工具业务结果为准；停止等待不代表撤销远端操作，结果不确定时先查询，不盲重试。
