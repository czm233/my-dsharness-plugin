# PITFALLS.md — 插件开发踩坑记录

> 这不是规则文件,规则在 [AGENTS.md](AGENTS.md)。这里只汇总实际踩过的坑:现象 → 根因 → 解法,
> 供以后做插件遇到怪问题时翻查。不强制遵守,但撞到同款症状时先来这里对照。
>
> 记录格式:每坑一节,标注日期和涉及的插件/版本。新坑往末尾追加,不要改写旧坑(保留当时 autopsy 的原貌)。

---

## 目录

1. [界面改动"没生效"?先用可见角标判定代码有没有被加载](#1-界面改动没生效先用可见角标判定代码有没有被加载)
2. [ESC 中断会重建轮次尾部 DOM——一次性锚点必坏](#2-esc-中断会重建轮次尾部-dom一次性锚点必坏)
3. [官方组件的 DOM 结构和类名不要猜,从 app.asar 里挖](#3-官方组件的-dom-结构和类名不要猜从-appasar-里挖)
4. [flex `order` 只对同一容器的兄弟生效,命中 ≠ 生效](#4-flex-order-只对同一容器的兄弟生效命中--生效)
5. [row-reverse:DOM 顺序动不了时的整行翻转法](#5-row-reversedom-顺序动不了时的整行翻转法)
6. [搬 React 管理的 DOM 节点:只重定位、不摘除,且必须和 CSS 互斥](#6搬-react-管理的-dom-节点只重定位不摘除且必须和-css-互斥)
7. [槽位(slot)系统要点:多注册共存、id 复用即替换、order 升序](#7-槽位slot系统要点)
8. [插件删除/重装的真实机制:GUI 改的是 package.json,链接靠 pnpm install](#8-插件删除重装的真实机制)
9. [桌面客户端诊断手段清单](#9-桌面客户端诊断手段清单)
10. [时间线比对:commit 时间 vs 应用重启时间](#10-时间线比对commit-时间-vs-应用重启时间)
11. [不要在全盘目录上跑宽 grep](#11-不要在全盘目录上跑宽-grep)
12. [DSH 升级后 CSS-module 哈希会变,布局规则会失效——重挖即可](#12-dsh-升级后-css-module-哈希会变布局规则会失效重挖即可)
13. [悬浮面板在 display:none 时量高必为 0——先显示再定位](#13-悬浮面板在-displaynone-时量高必为-0先显示再定位)
14. [两个 AI 会话并行写同一插件必撞车——动手前先查最近 commit 时间](#14-两个-ai-会话并行写同一插件必撞车动手前先查最近-commit-时间)
15. [原生 select 的弹层是系统菜单,CSS 管不到——要完全自控就换自绘组件](#15-原生-select-的弹层是系统菜单css-管不到要完全自控就换自绘组件)

---

## 1. 界面改动"没生效"?先用可见角标判定代码有没有被加载

**日期**:2026-10-27 · **涉及**:composer-effort-chips 1.3.2→1.3.5

**现象**:连续改了三版 client.js,用户反复说"还是老样子",无法判断是代码没加载还是代码写错了。

**根因**:桌面客户端里 client.js 只在界面(重)加载时执行;"没生效"有两种完全不同的原因——
代码没被加载 vs 代码加载了但写错了。不区分这两者,调试就是瞎猜。

**解法**:**可见构建角标**。在插件渲染输出里塞一个肉眼可见的小徽章(写上版本号),一次重启即可判定:

- 角标出现 → 代码管道通,是逻辑 bug,专心修逻辑;
- 角标不出现 → 应用在跑冻结的旧代码,去查缓存/组合,不要改逻辑。

进阶:**信号灯 CSS**。往插件注入的样式表里加规则给角标改色(如红色 `!important`)——
角标变色 = 样式表活着;给目标元素加 `outline` = 选择器命中了它。一张截图同时回答
"样式表活没活""选择器中没中""元素在哪"三个问题,把用户的重启次数压到最少。

**教训**:调试成本要尽量从"用户重启"转移到"AI 看一张截图"。

---

## 2. ESC 中断会重建轮次尾部 DOM——一次性锚点必坏

**日期**:2026-10-27 · **涉及**:turn-cost 1.15.1

**现象**:回答中途按 ESC 停止后,金额 pill 跑到行最右边(掉进 fallback 分支)。

**根因**:插件的 portal 占位 span 用 `useLayoutEffect(fn, [])` 只在挂载时插入一次。
ESC 中断、轮次状态翻转、虚拟化重渲染都会**重建 actions 行的 DOM**,原生用量按钮换了位置/身份,
旧占位失联后逻辑走进"找不到锚点"的兜底行(整行右对齐),视觉上就是"跑到右边"。

**解法**:占位插入改成 **MutationObserver 持续重锚定**——每次 DOM 变动都重新定位原生按钮,
占位不在"紧贴其左"的正确位置就重新插入;fallback 只在真找不到锚点时使用;
`setSlot(prev => ...)` 函数式更新保证幂等,不因闭包里的旧 state 反复触发渲染。

**教训**:**插件插入的任何 DOM 座位都不能假设"插一次就永远在"**。宿主随时可能重建周围 DOM,
凡是"贴着官方组件放东西"的需求,一律配 MutationObserver 做持续纠位。
参考实现:turn-cost `client.js` 的 `useLayoutEffect` + `MutationObserver` 段。

---

## 3. 官方组件的 DOM 结构和类名不要猜,从 app.asar 里挖

**日期**:2026-10-27 · **涉及**:composer-effort-chips 1.3.3→1.3.9

**现象**:对着官方模型选择器写 `[class*="triggerEffort"]`、`button:has(...)` 一堆选择器,
有的命中(`outline` 能描上)但 `order` 就是不动,反复试错三轮。

**根因**:全是猜的。官方组件的真实类名是 CSS-module 哈希名(如 `htuFrW_triggerEffort`),
容器类名(`JZLxKW_standardControls`)、JSX 层级(slot 是否包 wrapper)不看源码根本不知道。

**解法**:应用装在 `/Applications/DeepSeek Harness.app`,全部前端代码在 app.asar 里,直接挖:

```bash
# 找类名:CSS-module 会保留原始名作后缀,mapping 也找得到
strings "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar" | grep -n "triggerEffort"
# grep -n 给出的是 strings 输出的行号,接着用 sed 读上下文看 JSX 结构:
strings ".../app.asar" | sed -n '450285,450315p'
```

挖出来的事实(2026-10-27 构建,哈希**随版本变**,见第 12 条):

- 模型选择器(ModelSelect 模块):根 `htuFrW_root` > 按钮 `htuFrW_trigger` >
  [`htuFrW_triggerLabel`(模型名) + `htuFrW_triggerEffort`(思考程度) + chevron];
- 输入框(InputBar 模块):`trailing` = [`standardControls`([右侧槽各项…, 模型座位]),
  activity, 发送按钮]。

**教训**:选择器调试的前置步骤永远是"先拿到真实 DOM 形状",猜一次的代价大于挖一次。

---

## 4. flex `order` 只对同一容器的兄弟生效,命中 ≠ 生效

**日期**:2026-10-27 · **涉及**:composer-effort-chips 1.3.3/1.3.6

**现象**:`.htuFrW_root` 的 `outline` 规则明明命中了(橙色描边出现),`order: -1` 却毫无效果。

**根因**:`order` 只在**同一个 flex 容器的直接兄弟之间**排序。目标元素若被包装层套着
(它在自己包装层里是独生子女),或和参照物不在同一个容器,`order` 就是哑弹。
**选择器命中只说明规则匹配上了,不说明它有排版效果。**

**解法**:
- 要动谁,就动"公共弹性容器的直接子层"(从目标向上爬到公共祖先那一层);
- 用 `*:has(> 目标)` 这类**容器无关**写法代替类名匹配容器;
- 或者干脆换思路,见第 5 条。

---

## 5. row-reverse:DOM 顺序动不了时的整行翻转法

**日期**:2026-10-27 · **涉及**:composer-effort-chips 1.3.8(最终生效方案)

**背景**:要把[我们的组件…, 官方模型选择器]变成[官方模型选择器, 我们的组件…],
但 `order` 打不中(第 4 条),搬 DOM 又有风险(第 6 条)。

**解法**:`flex-direction: row-reverse` 把整行**倒序显示**。DOM 顺序不动,
视觉上首尾互换——正好等价于"把最后一个挪到最前"。选择器不依赖任何哈希类名,
只依赖"这行直接装着我们的组件、且包含官方选择器"这个结构事实:

```css
*:has(> [data-composer-effort-chips]):has(.htuFrW_root) {
  flex-direction: row-reverse;
}
```

**注意**:两个 `:has()` 缺一不可——只用`:has(.htuFrW_root)`会匹配到更高的祖先
(如 trailing,连发送按钮都在里面),整行倒序会把发送按钮也翻到左边。
必须用"直接子级含我们的组件"把匹配钉在最内层的行容器上。

**教训**:当"重排兄弟"走不通时,"翻转整行"是零 DOM 副作用的替代;代价是行内所有直接子级一起反向,
所以要求行里除了这两组没有别的敏感兄弟(发送按钮在行外,不受影响,正好满足)。

---

## 6.搬 React 管理的 DOM 节点:只重定位、不摘除,且必须和 CSS 互斥

**日期**:2026-10-27 · **涉及**:composer-effort-chips 1.3.7→1.3.9

**要点**(作为 CSS 失效时的兜底手段):
- **只 `insertBefore` 重定位,绝不 `removeChild` + 重新插入**:节点保持挂在原父元素上,
  React 之后拿它当 `insertBefore`/`removeChild` 的引用依然合法,不易崩;
- 搬**外层包装**而不是内层节点(内层可能是独生子女,搬了等于没搬);
- 搬完要用 `compareDocumentPosition` 判断方向,只在"确实排错边"时动手,天然幂等;
- **必须和 CSS 方案互斥**:动手前 `getComputedStyle(row).flexDirection === 'row-reverse'`
  就直接放弃。否则 CSS 翻转 + JS 搬移会互相"再修一次",来回打架;
- 遍历 `querySelectorAll` 而不是 `querySelector`:页面里可能有多个(含隐藏的)同根组件实例,
  第一个未必是可见的那个;
- 插入**外来节点**(自己创建的 span)是最安全的手法,React 完全不管它——turn-cost 的
  portal 座位就是这么干的;搬 React 自己的节点是次选。

---

## 7. 槽位(slot)系统要点

**日期**:2026-10-27 · **来源**:app.asar 内 `dsh-client-modules` 契约文档

- list 槽接受多个注册项,**不同 id 共存**,按 `order` **升序**排列(`order` 越大越靠右/越靠后);
- **id 复用官方的 id = 顶替那个格子**;用自己的新 id = 在旁边新增;
- 同一个插件可以对同一个槽名多次 `slots.inject` + `register`(各用各的 id),不会互相顶掉;
- slot 契约文档就埋在 asar 里(`grep -n "conversation.input.right"` 能找到含
  registerOptions/summary 的完整说明),写槽位代码前先读它。

---

## 8. 插件删除/重装的真实机制

**日期**:2026-10-27 · **涉及**:turn-cost 被用户从 GUI 删除后重装

- GUI 插件管理器的删除/安装,本质就是改 `~/.dsh/profiles/desktop/package.json`
  的 `dependencies`(增删 `link:` 条目)和 `dsh.profile.bundles` 列表,然后跑捆绑的 pnpm;
- 所以**重装 = 把 link 条目和 bundles 加回去 + pnpm install**,不需要手点 GUI;
  捆绑 pnpm 用法见 AGENTS.md §2.5;
- `.plugin-manager/logs/operation-*/pnpm.log` 记录了 GUI 每次操作的增删明细,
  排查"用户到底点了什么"时先看这里;
- `cordis.yml` 是组合产物(空列表 + 注释),**不要编辑**;用户配置层是 `cordis.patch.yml`。

---

## 9. 桌面客户端诊断手段清单

- **应用是否重启过**:runtime context 里的 GUI URL **端口变了 = 重启过**
  (Electron 每次启动换端口);也可以看
  `~/Library/Application Support/@deepseek-ai/dsh-desktop/Singleton*` 的 mtime;
- **进程结构**:主进程跑 `app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`,
  参数里带 profile 路径;renderer 是 Electron(自定义 `dsh-app://` scheme,
  带 `--code-cache-schemes`),不是浏览器网页——没有 F5;
- **web GUI 有鉴权**:直接 curl 127.0.0.1:PORT 会 401(`DSH_WEB_URL` 环境变量里没有 token),
  `/plugins` 等资源路由路径未知时探测基本是 404——**别在"绕过鉴权抓 bundle"上花时间**,
  用第 1 条的可见角标法替代;
- **配置层**:`~/.dsh/profiles/desktop/cordis.patch.yml` 是用户配置(LLM 渠道、市场源、MCP 等),
  与插件代码内容无关;排查插件问题不要浪费时间翻它;
- **asar 内有全部契约文档**:slot 契约、client-modules 说明、甚至插件开发模板
  (`templates/decoration/`)都在里面,`strings` + `grep` 就是文档检索。

---

## 10. 时间线比对:commit 时间 vs 应用重启时间

**用途**:用户说"还是老样子"时,先确认重启是否发生在改动落盘**之后**。

```bash
git log --format="%h %ci %s" -4          # 改动落盘时刻
stat -f "%Sm" -t "%H:%M:%S" ~/Library/Application\ Support/@deepseek-ai/dsh-desktop/SingletonLock
```

本次案例:代码 03:54:12 落盘,应用 03:55:51 重启 → host 必然读过新代码,
从而把怀疑点从"没加载"引向"代码逻辑/容器结构"。反过来说,若重启早于落盘,
"没生效"就只是没加载,别冤枉自己的代码。

---

## 11. 不要在全盘目录上跑宽 grep

**日期**:2026-10-27

`grep -rl "关键字" /var/folders/... ~/Library/Caches ~/.dsh` 会跑 5 分钟以上拖成后台任务,
而且撞上 minified 大文件时单行输出几 MB,刷屏且无用。

**教训**:
- 找"代码副本"这类问题,先缩小到可信位置(`~/.dsh`、asar、profile),别全盘扫;
- 对 asar 这类二进制用 `strings` + `grep -n` + `sed -n` 三段式,直接 grep 二进制会撞巨行;
- 后台任务跑起来前先估摸数据量,宁可分步窄搜。

---

## 12. DSH 升级后 CSS-module 哈希会变,布局规则会失效——重挖即可

**日期**:2026-10-27 · **涉及**:composer-effort-chips 1.3.9

composer 布局最终方案依赖两个锚点:我们自己的 `data-composer-effort-chips` 属性(永远稳定)
和官方的 `htuFrW_root` 类(**哈希随 DSH 构建变**)。DSH 升级后若发现"官方选择器又跑到发送键旁边了",
不是插件坏了,是哈希变了:

```bash
strings "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar" | grep -n "triggerEffort"
```

从输出里拿到新的 `<hash>_root`,替换 `client.js` 样式表和 JS mover 里的 `.htuFrW_root` 即可。

---

## 13. 悬浮面板在 display:none 时量高必为 0——先显示再定位

**日期**:2026-10-27 · **涉及**:quote-selection 0.4.2→0.4.3

**现象**:点批注胶囊展开列表面板,面板从输入框**正下方**弹开,超出屏幕底边。

**根因**:定位逻辑是 `top = 锚点.top - panel.offsetHeight - 8`,但量高时面板还是
`display: none`,`offsetHeight === 0`,于是 top ≈ 锚点正下方,显示时整个面板向下展开。
输入框本来就贴着屏幕底,向下必然超屏。

**解法**:`quote-selection/client.js` 的 renderPanel——三步顺序不可颠倒:
1. 先按锚点上方可用空间给面板**限高**(`maxHeight = 锚点.top - 16`);
2. 再 `display: block` 让它参与布局;
3. 最后量 `offsetHeight` 算 `top` 并 clamp 到 ≥ 8px。
要求"永远朝上展开"的面板都必须走这个顺序,不能在隐藏状态下量尺寸。

**教训**:凡是"量完再摆"的浮层,测量前先确认它可见;不可见的元素所有几何值都是 0,
按 0 摆位等于"默认往锚点下方怼"。

---

## 14. 两个 AI 会话并行写同一插件必撞车——动手前先查最近 commit 时间

**日期**:2026-10-28 · **涉及**:agent-workflow-board 2.3.1→2.5.0(双会话并行开发)

**现象**:会话 A(本会话)在改下拉样式,会话 B 在同一小时里高频提交同一插件
(10:15 交 2.4.0、10:27 留半成品、10:29 交 2.4.1)。A 恢复一个 locale 键的编辑
被 B 的 2.4.1 提交**扫了进去**(提交时工作区是共享的,git add 整文件不分作者),
留下一个没人引用的死键;A 看到的"半成品"其实是 B 尚未完成的中间态,差点被误判成 bug 清掉。

**根因**:两个会话共享同一个工作区和 git index。`git add` 按文件收录,分不清
"这行是谁改的";A 读文件到 B 提交之间任何一方写入,另一方的 diff 就被污染。

**解法**:
1. 动手前先跑 `git log --format="%h %ci %s" -3` 看最近提交时间——几分钟内有别人的
   提交 = 高危,先问用户"是不是还有另一个会话在干活";
2. 工作区有**来历不明的未提交改动**时,不要 `git checkout --` 清掉,先 `git diff`
   判断是不是另一个会话的 WIP;
3. 用户确认"那边收工了"再动文件;
4. 修复撞车残留(死键等)要在自己的提交里顺手清干净,不留尾巴。

**教训**:插件目录是共享可变状态。"我这边没改"不等于"文件没变"——另一个会话、
甚至 pnpm install 都可能动它。任何一次提交前都值得再看一眼 `git status` + `git diff`。

---

## 15. 原生 select 的弹层是系统菜单,CSS 管不到——要完全自控就换自绘组件

**日期**:2026-10-28 · **涉及**:agent-workflow-board 2.3.1→2.5.0

**现象**:给 `<select>` 铺了自定义背景/圆角/箭头(`appearance:none`),用户仍反馈
"弹开的列表还是原生的"——macOS 上原生 select 弹出的选项列表是系统级菜单(NSMenu),
任何 CSS 都作用不到它;深色主题里弹出一个白底系统列表,观感割裂。

**根因**:`appearance:none` + 自定义样式只能控制 select 的**收起态**;展开态
在 macOS Chromium 里走原生菜单渲染路径,与文档样式系统完全隔离。

**解法**:要完全掌控观感就别用原生 select。`agent-workflow-board/client.js` 的
`Dropdown` 组件:触发按钮 + `position:fixed` 浮层(fixed 逃出父级 `overflow:auto`
裁剪)+ `useLayoutEffect` 绘制前定位(避免闪跳)+ 下方放不下自动向上弹 +
浮层外 scroll/wheel/resize/Esc/点击即收起。参考 workflow-lite:它零原生 select。

**教训**:表单原生控件(input/select/原生日历)的"展开态"都不完全受 CSS 管;
设计稿要求统一观感时,第一天就上自绘组件,别在原生控件上做样式修补。

---

## 维护约定

- 新坑追加到目录之后、按序编号,并同步更新顶部目录;
- 每条必须有"现象/根因/解法"三段,最好带可复制的命令;
- 坑被 AGENTS.md 吸收为正式规则后,本文件保留原文并在开头标注"已升级为规则,见 AGENTS.md §x"。
