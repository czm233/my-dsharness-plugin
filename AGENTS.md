# AGENTS.md — 本仓库开发规则

本仓库是 DeepSeek Harness(DSH)自定义插件的**唯一正式存放地**。
任何 AI 会话或开发者在本仓库工作时,必须遵守以下规则。

## 1. 路径唯一

- 本地开发路径**只有一个**:`/Users/czm/githubProject/my-dsharness-plugin/`
- 远程仓库**只有一个**:`https://github.com/czm233/my-dsharness-plugin`(公开;注意不要提交密钥等敏感信息)
- 任何其他位置(default-workspace、czm-personal-website 等)出现的插件副本都是过期残留:发现即删除,**绝不**在副本上改代码。
- DSH 的插件软链接在 `~/.dsh/profiles/desktop/node_modules/@local/<插件名>`,必须指向本仓库内的对应子目录。

## 2. 版本优先级

以内容新旧和归属判断,从高到低:

1. **项目/工作区文件夹内的插件**(临时覆盖版)——仅在明确处于某项目的临时测试期时存在,测试结束必须清理或转正;
2. **本仓库本地文件夹**(`/Users/czm/githubProject/my-dsharness-plugin/`)——日常开发与生效来源;
3. **云端**(GitHub 上的 main 分支)——正式版本的最终依据。

云端可随时 `git pull` 同步到本地;本地与云端冲突时,先确认哪边是要保留的结果,再决定合并方向,**不允许**两份长期分叉。

## 2.5 插件链接的登记表(2026-10-27 事故教训)

**软链接的源头不是 `ln -s`,而是 `~/.dsh/profiles/desktop/package.json` 的 `dependencies`(`@local/<名>: "link:<绝对路径>"`)+ `pnpm-lock.yaml`。**

- 任何时候跑 `pnpm install`(重启 DSH、装任何插件都会触发),pnpm 会**按登记表重建全部软链接**,手动 `ln -sfn` 改的链接会被无声覆盖回去。
- 因此:**搬家/迁移插件 = 改 package.json 里的 link: 条目(或用 plugin_manager 重装)→ 跑 pnpm install**,绝不是手改链接。
- 验证链接健康:所有 `@local/*` 都应指向本仓库对应子目录,且 `readlink` 目标存在。
- 本机捆绑的 pnpm 用法(和 DSH 内部完全一致):
  ```bash
  RUNTIME=~/.dsh/dsh-runtimes/dsh-primary-runtime
  export PATH="$RUNTIME/dependencies/node/bin:$PATH"
  cd ~/.dsh/profiles/desktop && node $RUNTIME/dependencies/pnpm/bin/pnpm.cjs install
  ```

## 3. 临时改动的生命周期

1. **临时测试**:可以直接在本仓库的插件目录里改文件覆盖生效(link 安装,重载界面即生效),快速验证想法;
2. **转正**:测试结果要保留时,必须走正规渠道——升 `package.json` 版本号 → `git commit` → `git push` 到云端;
3. **不允许**把临时改动长期留在本地不提交,也不允许绕过 git 直接"以后再说"。

## 3.5 热更新开发闭环(改完立刻看到,全程不重启 DSH)

每次改完代码,按下表走,**永远不需要重启 DeepSeek Harness**:

| 改了什么 | 要做什么 | 原理 |
|---|---|---|
| 只有 client.js / locale / icon | 重载界面即可;保险起见也可走重装 | Client 模块表在**页面加载时**注入(link 安装,文件即装的) |
| index.js / host.js / cordis.patch.yml / package.json | `plugin_manager` → `remove_bundle` → `install_bundle`(target=本仓库对应子目录) → 重载界面 | Host 半在**插件组合(compose)时**载入进程,remove+install 强制重新组合 |
| profile 的 cordis.patch.yml(市场源等应用级配置) | 才需要重启 DSH(与插件代码迭代无关) | 应用启动时读一次 |

**开发会话的强制动作**:
1. 动手前先确认本会话有没有 `plugin_manager` 工具;没有就不能承诺"自动生效",要明确告诉用户"请在 GUI 里点一次重装"。
2. 每轮改动结束,**主动**执行 remove+install(有工具时)并重载界面验收(见第 6 节红线:禁止让用户按 F5)——不要等用户发现"没生效"再来问。流程画布当年"改完自己就生效"的体感,就是这么来的:开发会话每轮都自动重装,用户只管验收;不是因为它是个 tab,也没有任何插件能"自己重启"。
3. 版本号显示来自安装时的组合元数据:只改文件不重装,页面上的版本号不会变——这也是验证"到底装没装上"的快捷办法。

## 4. 插件市场(index.json)

- 本仓库根目录的 `index.json` 是 DSH 插件市场的索引文件(format 1)。
- **新增或更新插件后必须同步更新 `index.json`**:新插件加一个条目;版本更新要在 `versions` 里追加一项,并填当时的 commit hash。
- 本地 profile 的插件市场配置(`~/.dsh/profiles/desktop/cordis.patch.yml` 的 `plugin-market.indexes`)已包含本仓库的 raw 地址;新机器配置时记得加上。

## 5. 新插件上手清单

1. 在本仓库建子目录,包含 `package.json`、`cordis.patch.yml`、`client.js`/`index.js`、`locale/`、`icon.svg`;
2. 更新根目录 `index.json`;
3. `git commit + push`;
4. plugin_manager install,目录填本仓库内路径;
5. 重载界面,用版本号确认生效。

## 6. 用户环境红线(永久有效,任何 AI 会话不得违反)

- **绝对不要让用户"按 F5 / 刷新页面"**。用户运行的是 **DeepSeek Harness 桌面客户端**,不是浏览器网页,界面上没有刷新手段,F5 无效。改完代码后的"刷新验证"一步由 AI 自己想办法(如通过工具触发重载),或明确告知用户需要**重启 DSH 应用**,禁止只说"刷新一下"。
- 用户不熟安装/配置操作,凡是要动 profile、软链接、pnpm 的事,默认由 AI 直接动手完成,只把最终需要用户做的一步(通常只剩"重启 DSH")讲清楚。
- **推送节奏**:改动先本地 `commit`,**等用户重启 DSH 验证通过后再 `git push`**。不许在用户还没看到效果时就急着 push;用户明确说"提交推送"或已确认效果,才推云端。

## 7. 踩坑记录索引

历史踩坑的完整"现象/根因/解法"汇总在 [PITFALLS.md](PITFALLS.md)(可见角标验证法、ESC 重建 DOM、asar 挖真实类名、flex order/row-reverse、React 节点搬移、槽位系统、重装机制、诊断命令等)。做插件遇到怪问题先翻它;本文件只放已升级为强制规则的条目,新坑一律先进 PITFALLS.md。

## 8. 反省协议(用户要求"反省"时必须按此执行)

反省 = **重走决策链,找到第一个能刹车的路口**,不是表决心。五步:

1. **摆事实链**:按时间列出"做了什么、依据是什么、结果是什么",每步带证据(commit 时刻、截图、命令输出),不带感想;
2. **错误分类**:知识错误(不知道→补知识进 AGENTS.md/PITFALLS.md)/ 方法错误(知道但顺序错→改动作顺序)/ 流程错误(流程必然导致犯错→加硬性关卡)。三类药的处方不同,不许混成一句"以后注意";
3. **找最早刹车点**:不问"哪步错了",问"最早哪一步本可拦住",反省落在那个点上;
4. **说具体的错**:指名具体行为(何时执行了什么、违反了哪条原则),禁止"太急了""会小心"这类空话;不甩锅环境,不空转自责;
5. **产出落盘**:每次反省必须以"改了什么"结尾——新坑写进 PITFALLS.md、升级成红线的进本文件、流程缺陷改成默认动作。**不落盘的反省视为没反省。**

## 现有插件

| 插件 | 版本 | 说明 |
|---|---|---|
| agent-workflow-board | 2.0.0 | 流程画布(详见其目录内 HANDOFF.md) |
| composer-usage-plus | 1.0.1 | 用量明细;1.0.1 修复额度进度条显示"剩余"而非"已用" |
| composer-effort-chips | 1.3.9 | 推理力度切换;1.3.9 官方模型选择器让位至最左,我们的组件贴发送按钮 |
| turn-cost | 1.15.1 | 单轮成本;1.15.1 修复 ESC 中断后金额 pill 跑偏 |

---
*规则制定于 2026-10-26,由用户口述、AI 整理。修改本文件本身也要 commit + push。*
