# CodeWhale GUI 重构规划（2026-07-04 起）

状态：D ✅ 收尾修复与清理完成。A ✅（基线 df76e8c）；B ✅（a4d0bb1）；
C ✅（视觉重写完成并验收：主窗/对话/对比窗三界面符合预览稿观感，工具卡去橙头、
侧栏两行卡、真开关、chip 统一、breathe 替换全部旧脉冲；Skills/模型/更新面板开合正常；
console 零报错；css 无裸色值/无 color-mix）。
D 阶段收尾：token URL 只移除 token 参数并保留其他 query/hash；CSS 选择器恢复标准 ID 写法；
旧 token 兼容别名已清理；cmp 对比后端日志加 8MB/2MB 轮转；主入口重复 cmpwin 首帧逻辑已删除。
分工：Claude(Fable) 规划+验收，Codex 实施
设计预览稿：docs/design-preview-v1.html；组件规范：docs/DESIGN-SPEC.md

B 期发现的**原有 bug**（非回归，D 阶段修）：URL 带 token 进对比窗时，api.js 的
history.replaceState(location.pathname) 把 compare=1&session 一并抹掉 → 对比窗只剩空壳。
修法：replaceState 应保留除 token 外的其余 query 参数。

## 一、产品概念（结构化）

CodeWhale GUI 的本质是一个**本地多模型 AI 工作台**，四种使用模式：

1. **单窗对话**——多会话、流式、工具审批、附件，8 个 provider 按需快切
   （deepseek / zai-GLM / moonshot-Kimi / openai-codex / claude-code / longcat / volcengine / custom）
2. **多模型对比**——独立对比窗，每列一个 provider 独立后端，横/竖/田三种布局，
   会话可保存恢复，逐列换模型/推理深度，队列发送
3. **深度研究**——研究面板路由 5 个引擎（deerflow / gptr / odr / storm / 自有方法论 skill），
   提交-轮询-出报告-留档（research_records.json）
4. **开发预览**——预览面板（phone/tablet/desktop 设备框），自动从消息里识别 localhost URL

支撑系统：签名验证双通道更新（GUI Ed25519 + 后端 codewhale update）、
token 鉴权反代（手机 PWA 同源访问）、Skills/MCP 连接器面板、余额显示、置顶/分组服务端同步。

## 二、现状病灶（审计结论）

- CSS 双真源：index.html 内联 3146 行 + styles.css 部分复制，改一处漏一处
- 补丁痕迹：同选择器重复定义（rgba 旧写法 + color-mix 新写法并存）、
  195 处硬编码色值绕过 token、17 处内联 style 属性、35 处 JS 直接写 .style
- 兼容债：color-mix() 在 macOS 12 WKWebView 不支持且无降级（installer 声称支持 macOS 12+）
- 单文件 3309 行 / 257KB，183 个 JS 函数、78 处 innerHTML
- 动画五种脉冲各自为政；无 prefers-reduced-motion
- cmp-*.log 无轮转（当前共 73MB，不紧急但要修）
- 部署目录无 git

## 三、设计规范 v1（预览稿已体现，待确认后细化成完整 spec）

方向：暖色极简精修（保留暖白纸面 + 鲸鱼橙 + 系统字体，做纪律不做特效）

- 色板：bg #FAF8F5 / side #F4F1EC / panel #FFF / ink #2A2520 / ink-2 #6E655B /
  ink-3 #A39A8F / line #E8E2D9 / accent #C2410C（唯一强调色，只用于小面积）/
  语义色 ok #3D8168, warn #B45309, err #B3261E（与强调色分离）
- 字阶：11 / 12.5 / 14(正文) / 16 / 20 / 24，系统字体栈；代码 SF Mono 栈
- 间距 4px 网格；圆角 6/10/14；阴影三级（暖墨色底，非纯黑）
- 动效：120ms hover / 200ms 展开，ease-out；唯一签名动画 = 运行态「呼吸点」
  （合并现有 5 种脉冲）；尊重 prefers-reduced-motion
- 关键组件改法：
  - 工具/结果卡：深橙重头卡 → 安静状态条（状态点+名称+摘要，默认折叠）
  - 侧栏会话卡：标题行（状态点+标题+右对齐 tabular-nums 时间）+ 元数据行
    （模型超 2 个折叠成 +N），hover 才浮出操作按钮
  - 对比窗：模型 chip 统一（选中=橙底白字），列头收敛，追问框与主输入同构

## 四、目标架构

无构建步骤，纯静态 ES modules（WKWebView = Safari 内核，原生支持）：

```
web/
  index.html          骨架 + 挂载点（<150 行）
  css/
    tokens.css        设计 token 唯一真源
    base.css          reset + 排版 + markdown
    components.css    全组件
    compare.css       对比窗专属
  js/
    api.js            HTTP/SSE/token 鉴权
    state.js          全局状态 + localStorage 键
    threads.js        会话列表/分组/置顶/乐观新建
    stream.js         SSE 消息流 + 快照 + 滚动跟随
    tools.js          工具卡/审批卡/运行状态/终端块
    compare.js        对比窗全部
    preview.js        预览面板
    panels.js         Skills/连接器/更新/模型切换/研究面板
    markdown.js       (保留现有)
    main.js           启动装配
```

注意：app 内更新只替换 web/ 整目录 + server.py + VERSION，tar 校验允许 web/**
子目录，架构兼容现有更新机制。server.py 本期不动结构（只在需要时小改）。

## 五、施工阶段（每阶段 Codex 实施、Claude 验收后才进下一阶段）

- **A 基线**（Claude）：git init + 提交现状；全部界面基线截图存档
- **B 无损拆分**（Codex）：把 index.html 的 JS/CSS 抽成上述模块，**行为零变化**，
  不改任何样式值。验收 = 逐界面截图与基线像素级一致 + 行为回归
- **C 视觉重写**（Codex）：按设计规范全量重写 css/*，清 17 处内联 style，
  35 处 JS .style 中 display 切换类改 class；color-mix 换兼容写法
- **D 收尾**（Codex+Claude）：五种脉冲合并呼吸点、日志轮转、死代码清除；
  同步 installer / ~/codewhale-gui-repo / 发版

验收回归清单（C 阶段）：滚动贴底方向判定、会话切换快照加载、审批卡可点、
工具卡折叠、对比窗三布局+队列、预览面板拖宽、手机宽度(390px)、字号 A-/A+、
模型切换软刷新、console 零报错、WKWebView 真机（CodeWhale.app）过一遍。

## 六、待确认

- [ ] felix 过目预览稿 v1（色板/组件改法/整体观感）
- [ ] 深色模式：本期不做（方向一），以后可在 tokens.css 上加
- [ ] server.py 模块化：明确本期不做，另立一期
