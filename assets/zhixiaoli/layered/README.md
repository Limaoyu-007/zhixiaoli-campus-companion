# 智小理 PSD 分层素材

来源：用户于2026-10-24提供的 `seethrough_output.psd`，原始画布768×768、RGB、8bit。原PSD未修改。

从15个原图层提取PNG，应用原图层蒙版，并将眉毛、眼白、眼珠、睫毛、双臂、双腿、双鞋各按左右分开，共22个部件。裁去透明边缘后仍以 `rig.json` / `rig.js` 保留原画布坐标。没有放大、重新生成或补画素材。

`rig.js` 供无Node权限的渲染页直接加载；`rig.json` 是可读的同份素材清单。`renderer/portrait-layered.js` 配合 `portrait-mesh.js` 做Canvas三角网格变形与头发弹簧链动画，不包含Cubism工程或moc3，也不需要新增素材文件或外部运行库。

嘴只有闭口图；袖子和手掌尚未分开；头发只有前后两大块。完整Live2D制作仍需结合目标动作细分、补画、绑定与导出。源码与使用入口见 `docs/CAMPUS_LAYERED_PORTRAIT.md`。
