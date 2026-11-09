# 桌面角色实现

公开源码默认使用 Canvas 分层角色。Canvas 实现使用 `assets/zhixiaoli/layered/` 的已公开分层图和动作逻辑，点击角色可以打开云朵对话卡。

参赛演示环境启用了正面与侧面两套 Live2D 资源。正面负责待机、视线跟随、表情和口型，侧面用于行走。适配代码保留在 `renderer/portrait-live2d.js`，交互和回复表情由 `renderer/portrait-pet.js` 处理。运行时缺少 Live2D 资源或加载失败时，应用使用 Canvas 实现。

README 中的桌面截图来自参赛演示环境。模型、纹理和 Cubism 运行库有独立的分发范围，运行库来源见 [依赖说明](../libs/licenses/live2d-runtime-sources.md)。
