# 学习通指定课程作业查询

2026-10-24。用户授权参考其Java客户端实现接入本地工具，并在本日反馈作业查询已经实现、项目可供比赛展示。该反馈属于用户本机体验，不扩大为所有账号/课程均验收。代理编写源码时没有启动应用、测试、构建、登录或查询真实账号。

## 使用

1. 重新启动智小理，打开设置 → 学习通。
2. 启用查询，填写手机号/账号与密码，点击固定页脚“保存更改”。保存本身不发起登录。
3. 切到通用学习模式，例如提问“查一下计算机网络的学习通作业”。普通聊天模型也需已配置且支持工具调用。
4. 匹配多个课程时，根据候选确认具体课程；随后使用返回的course_key再次查询。

当前返回作业名称、原页面提交状态、完成进度和查询时间。不是全部课程扫描，不包含截止时间，不读取作业题目，也不提交、修改作业。状态无法读取时明确为未知。

## 账号与会话

账号在userData/config.json的chaoxing.phone保存，密码通过Electron safeStorage加密后以password_encrypted保存。页面只得到账号、是否已保存密码及环境配置状态，不回填密码/密文。更换账号自动清除旧账号密码，须重新填写；删除密码后不会保留明文副本。

也支持CHAOXING_PHONE和CHAOXING_PASSWORD环境变量。只要其中一项存在，整对凭据都从环境读取；缺少另一项就报配置不完整，不与设置中的密码混用。删除设置密码不删除外部环境变量。

按当前Electron 33使用safeStorage同步API，参见[官方说明](https://www.electronjs.org/docs/latest/api/safe-storage)。系统安全存储不可用时不退回明文密码，使用环境变量即可。加密数据与当前操作系统用户环境有关，迁移电脑后可能需要重新保存密码。

Cookie只保留在学习通客户端内存，不与普通浏览器共享，不写入磁盘；重启后首次查询重新登录。学习通配置变更会停止当前通用学习请求并清理Cookie，避免旧请求在新账号下自动继续。识别到登录页时最多重登一次；服务器要求验证码/额外验证时明确返回错误，不自动处理挑战。工具只接收课程参数，凭据、Cookie及动态签名不进入模型或日志。

## 源码与调用链

- services/agent/study-tools.js：注册list_homework，校验course与course_key，返回结构化结果。
- services/chaoxing/client.js：按Java流程登录、查课程、获取workEnc/openc/enc、查作业；维护一次失效重登。
- services/chaoxing/http-session.js：私有Cookie管理、仅学习通HTTPS域名、有限重定向、单请求20秒/响应3MB上限及取消。
- services/chaoxing/page-parser.js：课程名称与编号、隐藏签名、作业条目和明确空列表解析。
- services/chaoxing/errors.js：稳定错误码及可展示信息。
- main.js：本地配置、safeStorage、凭据来源、客户端注入、修改/退出清理及日志脱敏。
- renderer/campus-settings.*：账号配置与保存，使用既有preload受限IPC，不增加模型权限。

HTTP端点、AES/CBC表单参数及作业签名取自用户提供的ChaoxingClient.java。没有运行Java程序，也不需要给桌面应用增加JDK。HTML使用固定1.0.0版本Cheerio，避免依赖完整浏览器；解析不会执行页面脚本，见[Cheerio说明](https://cheerio.js.org/docs/intro/)。包与锁文件已更新。

## 明确结果与错误

成功返回ok/source/fetchedAt/course/progress/items/confirmedEmpty。课程只在当前登录用户的课程列表内选择，course_key不能指定列表外课程。

- COURSE_AMBIGUOUS：返回候选name/course_key及数量，并标记requires_user_input；Runtime直接展示选择问题，暂停剩余工具，不让模型在同一轮自动挑选。所有已声明工具调用仍补齐对应返回，以保留下一轮协议一致性。最多展示30项，不冒充完整扫描；界面标为待确认。
- COURSE_NOT_FOUND：已解析课程名称中没有匹配项。若部分名称未读出，则返回解析失败，不声称课程不存在。
- AUTH_EXPIRED：识别到登录页面，最多重登一次；仍失败则返回错误。
- AUTH_CHALLENGE_REQUIRED：服务端要求额外验证。
- COURSE_SIGNATURE_MISSING / SIGNATURE_REJECTED：缺失或无效签名，不当成无作业。
- HOMEWORK_PARSE_FAILED：未识别条目，也没有可信的空列表标记，或进度与条目明显矛盾。
- REQUEST_TIMEOUT / CANCELLED / CONFIG_CHANGED：超时、停止或配置变化；不继续把旧会话结果拼进新查询。

页面结构变化可能影响解析，实际兼容性以各自环境为准。用户已反馈本机查询可用；代理没有采集真实页面或保存包含账号数据的调试样本，没有独立复现真实登录查询。
