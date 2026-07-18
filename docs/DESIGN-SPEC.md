# CodeWhale GUI 设计规范 v1（C 阶段施工依据）

参照物：`docs/design-preview-v1.html`（felix 已过目认可的预览稿，所有数值以本文档为准，
观感以预览稿为准；两者冲突时以预览稿的视觉效果为目标）。

## 0. 总原则

1. **强调色只用于小面积**：状态点、选中态、主按钮、开关 ON。禁止大面积橙色填充/渐变头部。
2. **一切数值来自 token**：新 CSS 里除 token 定义外不得出现裸色值（#/rgba）、裸阴影、裸圆角。
3. **语义色与强调色分离**：ok/warn/err 只表达状态，不做装饰。
4. **动效只有两档时长**，唯一的循环动画是「呼吸点」。
5. 行为零变化：所有 ID、事件、DOM 结构语义不变（允许为样式加 class，允许微调 JS 里
   拼 DOM 的模板加 class/包一层 span，禁止改逻辑）。

## 1. tokens.css（唯一真源，:root 定义）

```css
:root{
  /* 面 */
  --bg:#FAF8F5; --side:#F4F1EC; --panel:#FFFFFF;
  /* 墨 */
  --ink:#2A2520; --ink-2:#6E655B; --ink-3:#A39A8F;
  /* 线 */
  --line:#E8E2D9; --line-soft:#F0EBE3;
  /* 强调（鲸鱼橙） */
  --accent:#C2410C; --accent-deep:#9A3412;
  --accent-tint:rgba(194,65,12,.08); --accent-tint-2:rgba(194,65,12,.14);
  /* 语义 */
  --ok:#3D8168; --warn:#B45309; --err:#B3261E;
  --ok-tint:rgba(61,129,104,.12); --warn-tint:#FDF8F0; --err-tint:rgba(179,38,30,.08);
  /* 阴影（暖墨底，禁纯黑） */
  --sh-1:0 1px 2px rgba(42,37,32,.05);
  --sh-2:0 4px 14px rgba(42,37,32,.07);
  --sh-3:0 18px 48px rgba(42,37,32,.14);
  /* 圆角 */
  --r-s:6px; --r-m:10px; --r-l:14px; --r-full:99px;
  /* 字 */
  --font:-apple-system,BlinkMacSystemFont,"SF Pro SC","PingFang SC","Helvetica Neue",sans-serif;
  --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace;
  --fs-caption:11px; --fs-ui:12.5px; --fs-body:14px; --fs-title:16px; --fs-h2:20px; --fs-h1:24px;
  /* 动效 */
  --t-fast:120ms ease-out; --t-slow:200ms ease-out;
}
```

- 现有 `color-mix(...)` 全部替换为上表预计算值（macOS 12 WKWebView 兼容）。
- 同选择器重复定义（rgba 旧写法 + color-mix 新写法并存的补丁对）删旧留一。

## 2. 动效

- hover/按下 → var(--t-fast)；展开/折叠/面板出现 → var(--t-slow)。
- 删除 5 个循环 keyframes（pulse / runpulse / cmppulse / cmptabPulse 以及任何脉冲阴影），
  统一为一个：
  ```css
  @keyframes breathe{50%{opacity:.35;transform:scale(.8)}}
  .live.run{animation:breathe 1.6s ease-in-out infinite}
  @media (prefers-reduced-motion:reduce){ *{animation:none!important} }
  ```
- spin（加载圈）和 blink（光标）保留。

## 3. 组件规范

### 3.1 侧栏（--side 底）
- 会话卡：两行结构。第 1 行 = 状态点(6px) + 标题(13px/550, ellipsis) + 时间
  (11px/--ink-3/tabular-nums，右对齐，**不折行**)。第 2 行 = 元数据(11.5px/--ink-3,
  ellipsis)；模型列表超过 2 个显示为「N 模型 · 前两个 +N」（拼模板处小改，纯展示）。
- 状态点颜色：idle=--ink-3 40%透明、ok=--ok、err=--err、running=--accent+breathe、
  stalled=--warn。
- hover 操作按钮（✎/📌/🗑）：默认隐藏，hover 才出现，白底(--panel)+--line 边+--sh-2
  的浮条，绝对定位右上；触屏(@media hover:none)常显。
- active 卡：--panel 底 + --line 边 + --sh-1（当前是色块高亮 → 改为「浮起」）。
- 分组标题：11px 大写 letter-spacing .08em --ink-3。
- 底部：模型 chip + 余额同行（tabular-nums），连接状态一行。

### 3.2 顶栏（--panel 底，--line-soft 下边线，高 48px）
- 标题 14px/600；provider/agent 徽章 = --bg 底 + --line 边 + --r-full，11px。
- Shell/自动批准 → 真开关样式：30×18 圆胶囊，OFF=#DDD5C9，ON=--accent，
  滑块 14px 白圆 + --sh-1 + left var(--t-slow)。
- A-/A+/预览 = 幽灵按钮（--line 边，hover 变 --ink）。

### 3.3 消息流（--panel 底，正文列 max-width 720px 居中）
- 用户消息：--accent-tint 底 + rgba(194,65,12,.14) 边 + --r-l（右下角 4px），右对齐，
  最宽 78%。
- 助手消息：无气泡直排，14.5px/1.72；上方 who 行（20px 头像 + 12px --ink-3）。
- 消息操作栏（复制/编辑）：hover 出现，样式同侧栏浮条。

### 3.4 工具卡/结果卡（核心改造——去橙头）
- 统一结构 `.tool`：--bg 底 + --line 边 + --r-m + --sh-1。
- 头行 `.hd`：8px 状态点 + 名称(12.5px/600/--ink) + 摘要(--ink-3, ellipsis) + caret。
  **删除现有深橙/渐变大头**（含 STORM/研究结果卡、runstatus 卡的橙色头）。
- 体 `.bd`：--panel 底 + --line-soft 上边线；折叠逻辑不变。
- 底注 `.ft`：11px --mono --ink-3（LLM/用时/状态）。
- 终端块：保持深底浅字，但底色统一 #26211C（暖黑），圆角 --r-s，失败标 --err。
- 审批卡：--warn-tint 底 + rgba(180,83,9,.35) 边 + 左侧 3px --warn 竖条；
  「允许」= 主按钮（--accent 底白字，hover --accent-deep），「拒绝」= 幽灵按钮。
  **审批卡不折叠、常展开**（现状保持）。

### 3.5 输入区
- 输入框：--bg 底 + --line 边 + 12px 圆角，focus 时边框 --accent + 外圈
  0 0 0 3px var(--accent-tint)。
- 发送按钮：36px 方圆(--r-m) --accent 底白箭头；禁用态 --line 底。
- ＋/📎 = 36px 幽灵方按钮。附件 chip 沿用现结构，按 token 重着色。

### 3.6 多模型对比窗
- 顶栏模型 chip 统一唯一形态：--r-full，未选=--panel 底+--line 边+--ink-2，
  选中=--accent 底白字 550。**删除现在深浅不一的第二种选中样式**。
- 布局切换（横/竖/田）与字号按钮：幽灵按钮组，选中项 --accent-tint 底+--accent-deep 字。
- 列头：--bg 底 + 状态点 + 模型名(12.5px/600) + effort 标签(11px --mono --ink-3)。
- 列间分隔 --line-soft；每列追问输入框与主输入框同构（3.5）。
- 「清排队/停止全部」：幽灵按钮 + --err 文字（危险动作不用实底）。

### 3.7 模态（更新/Skills/连接器/模型切换/研究面板）
- 面板：--panel + --r-l + --sh-3，遮罩 rgba(42,37,32,.32)。
- 列表行 hover --bg；主操作按钮同 3.4 审批卡按钮规范。
- toast：--ink 底 + --panel 字 + --r-m + --sh-2（深底浅字小条，替代现浅底）。

## 4. 施工范围与红线

- 改：`web/css/*`（重组为 tokens.css/base.css/components.css/compare.css，index.html
  对应 4 个 link，顺序 tokens→base→components→compare）；index.html 里 17 处内联
  style **属于纯装饰的**移入 CSS（`display:none` 之类初始状态保留原样）；JS 模板里
  拼 DOM 处允许加 class/span 以及 3.1 的「+N」展示，**不许动任何逻辑/ID/事件**。
- 不改：js 模块逻辑、server.py、markdown.js、任何行为。
- JS 里 35 处 `.style.*` 本阶段**不动**（D 阶段再收敛 display 切换）。
- 手机端（@media max-width:900px/640px）现有断点行为全部保留，只换配色/间距 token。
- 完成后自测：CW_PORT=3011 起实例 curl 全资源 200；grep 确认 components.css/compare.css
  中无裸 #hex/rgba（tokens.css 除外）、无 color-mix、无被删 keyframes 残留引用。
