# edit-restart（修改重发）

在会话里任意一条**用户消息**旁点「修改」，改完点发送：插件按这条消息之前的上下文
分出一个新的分支会话（原生 fork，切点=该消息所在轮次的 `turn/start`），把改过的文本
作为分支的第一条消息发出；原会话原样保留。

## 为什么这样实现

0.2.1-rc.5 的 Chat 没有对「用户消息操作行」开放挂载点，事件分发也只认本进程内的
EnhancedEventTarget，跨进程合成可信点击行不通。因此界面上只做一件安全的事：

- 只给官方气泡列（`*_userRow`）加 class 与属性，不往 Chat 里插陌生节点；
- 「修改」按钮、编辑框、「已修改」标记由应用内独立 React 根渲染，再搬进目标容器。

## 诊断（桌面端没有控制台）

客户端把面包屑 POST 到 Host 路由 `/api/edit-restart/rpc`，Host 写文件：

- 日志：`~/.dsh/storages/edit-restart/client.log`
- 草稿：`~/.dsh/storages/edit-restart/drafts.json`

## 装机前门禁

```bash
node edit-restart/test/layout-harness.cjs
```

加载真实 `client.js`，在复刻 0.2.1-rc.5 结构的假 DOM 上验证：结构识别、装饰落点、
切换会话、点击→定位→fork 切点→发首条消息。
