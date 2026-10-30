# BACKLOG — 备选需求清单（无人值守可执行）

> **用途**：记录"有意义但现在不做"的候选需求。将来用户有多余 token（如额度到期）时，
> 会说「把备选需求全部实现」——届时按本文件逐项执行，无需再问需求细节。
> 制定：2026-10-30，源自对市面优秀作品整理布局功能的调研（来源链接见文末）。
> 状态：**全部未实现**。每完成一项：版本号 +0.1.0、单独 commit、跑 render-harness、更新本文件勾选。

## 执行规范（无人值守会话必读）

1. **顺序**：按下方优先级 ⭐ 数从多到少逐项做；每项独立成版（版本号 +0.1.0）、独立 commit。
2. **门禁**：凡改 client.js 渲染路径，装机前必须 `node test/render-harness.cjs` 全绿（AGENTS.md §3.5 第4条）。
3. **自查**：整理布局类改动必须用 `node test/canvas-snapshot.cjs <画布json> <输出svg>` 离线渲染 + 自查视觉效果（qlmanage 记得加超时，见 PITFALLS #23）。
4. **验证**：每项完成后在真实画布上重载界面验收；**push 需用户批准**，不要主动 push。
5. **不做超出清单的事**；发现清单缺陷记回本文件，不顺手改。

---

## B1. 整理后自动"适应视图" ⭐⭐⭐

- **需求**：整理布局完成后自动执行 fit-to-content（视口缩放平移到正好框住全部节点并留 40px 边距、居中）。
- **实现提示**：`autoLayout()`（client.js）完成后调用已有的视口适配逻辑（工具栏已有"适应"按钮的函数，搜 `fit`）；或用 `centerOn` 变体计算 scale。
- **验收**：任何画布点整理后，无需手动缩放即可一眼看完所有节点。
- **工作量**：极小。

## B2. 行/列间距可选（紧凑/标准/宽松）⭐⭐⭐

- **需求**：整理布局支持三档间距（紧凑：列 40/行 80；标准：列 64/行 88，即现行；宽松：列 96/行 120），选择**持久记住**（存 localStorage 或 WORKBENCH，键按画布无关全局）。
- **实现提示**：`autoLayout()` 内 `rowH`/`colGap` 改为从设置读取；工具栏"整理布局"旁加一个小下拉（三档），UI 上只放选项本身不加说明文字（UI 禁写注释规则 §1）。
- **验收**：切换档位后再整理，间距明显变化且重启 DSH 后记住选择。
- **工作量**：小。

## B3. 分支顺序保持（是上/否下）⭐⭐⭐

- **需求**：整理布局时，同一判断节点的多条出线分支**顺序稳定**：「是」分支的下游一律排在「否」分支下游的**上侧/前侧**（吸取 Dify issue #34134 教训，也与红绿配色语义一致）。
- **实现提示**：`autoLayout()` 的行内排序（现有"父节点均值"排序处）给比较键加权：比较键相同或接近时，按「来源边的 label（是=0/否=1/其他=2）」次级排序。
- **验收**：含 是/否 分支的画布整理后，绿线目标恒在红线目标上方（垂直布局时在前方）。
- **工作量**：小-中。

## B4. 多选对齐/等距分布 ⭐⭐

- **需求**：框选 ≥2 个节点后，右键菜单出现对齐操作：左/右/上/下/水平居中/垂直居中对齐 + 水平/垂直等间距分布（Figma / ComfyUI Draftsman 式）。
- **实现提示**：`multiIds` 已存在；对齐=改各节点 x/y 至参照值；等距=排序后按 (总宽/总高) 均分间隙；接入现有右键菜单（`openNodeMenu` 需支持多选场景）。
- **验收**：散乱选 4 个节点 → 垂直居中对齐 → x 一致；等距分布后间隙相等。
- **工作量**：中。

## B5. 交叉最小化（barycenter 迭代）⭐⭐

- **需求**：整理布局的行内排序在现有"父节点均值"基础上，再做 1~2 轮相邻行迭代（ELK 的 layer-sweep / barycenter 思想），减少连线交叉。
- **实现提示**：现有排序按"父节点均值"，升级为正向+反向两轮（先按父均值，再按子均值），迭代至排序稳定或 2 轮为止。
- **验收**：分支回流多的画布（如含 判断回边）整理后连线交叉数明显少于现状。
- **工作量**：中。

## B6. 布局预设可选（横向分层/纵向分层/紧凑树）⭐

- **需求**：整理布局支持三种预设：横向分层（现行蛇形）、纵向分层（列换行改行换列）、紧凑树（无蛇形、严格层级行），记住上次选择。
- **实现提示**：`autoLayout()` 加 direction 参数；纵向=横竖互换；紧凑树=去掉蛇形往返、每层严格居中对齐。
- **验收**：三种预设各有明显不同的排布效果，均无穿卡连线。
- **工作量**：中。

## B7. 选中区域整理 ⭐

- **需求**：框选若干节点后执行整理，只重排选中的节点，其余节点位置完全不动（n8n 的 layout('selection') 模式）。
- **实现提示**：`autoLayout()` 接受 id 白名单：BFS 遍历、行列分配都只在白名单内进行；锚定节点（未选中的）参与碰撞计算但不移动。
- **验收**：大画布上选中一个子图整理，其余区域像素级不动。
- **工作量**：中。

## B8. 组/折叠（Canvas Groups）⭐

- **需求**：n8n Canvas Groups 式的分组：把若干节点圈成命名组、可整体拖动/整理（组作为布局单元）、可折叠隐藏成员。参考 [n8n Canvas Groups](https://docs.n8n.io/build/understand-workflows/workflow-components/canvas-groups.md)。
- **实现提示**：新数据结构 groups（{id,name,nodeIds,collapsed}）；渲染层画组框；整理时组当单元；**工作量最大，建议拆独立版本做**。
- **验收**：建组→拖组整体动→折叠后成员隐藏、连线仍指向组框。
- **工作量**：大。

---

## 市场调研参考（2026-10-30 检索）

- n8n Tidy up：组作为布局单元 / 增量整理 — [PR #37509](https://github.com/n8n-io/n8n/pull/37509)、[PR #25905](https://github.com/n8n-io/n8n/pull/25905)、[Canvas Groups](https://docs.n8n.io/build/understand-workflows/workflow-components/canvas-groups.md)
- Dify 自动排列（Cmd+O）+ 分支顺序教训 — [issue #34134](https://github.com/langgenius/dify/issues/34134)、[快捷键文档](https://docs.dify.ai/zh/self-host/use-dify/build/shortcut-key)
- draw.io 多预设布局（Flow/Tree/Radial/Organic，ELK 引擎，记住参数）— [官方博客](https://www.drawio.com/blog/auto-layouts/)、[ELK Layered](https://eclipse.dev/elk/blog/posts/2025/25-08-21-layered.html)
- ComfyUI 对齐分布生态 — [LVO-Node-Aligner](https://github.com/LVOcode/ComfyUI-LVO-Node-Aligner)、[Node Organizer](https://github.com/PBandDev/comfyui-node-organizer)、[Draftsman](https://github.com/ScrudgMcDack/ComfyUI-Draftsman)
