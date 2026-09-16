# 验证提示词：中文语义检索词表扩充与召回评估（交给 GPT 复核）

> 用法：把下面 `===== 提示词开始 =====` 到 `===== 提示词结束 =====` 之间的全部内容
> 连同仓库一起交给具备代码执行能力的模型（Codex / ChatGPT with shell / Claude Code 等）。
> 若对方只能读代码、不能执行命令，请让它按「静态复核」路径作答，并明确标注哪些结论无法判定。

---

===== 提示词开始 =====

你是独立验证者。有人（以下称「作者」）在 Obsidian 中文插件市场项目里完成了一轮改动，
声称「中文功能词能召回正确插件，且不会因为泛词扩展让结果严重失真」，并提交了一份自评报告。

**你的任务是找出错误，不是确认结论。** 默认假设存在缺陷，直到可复现的证据证明没有。
凡是无法复现或无法判定的项目，必须写「无法判定」并说明缺什么，**不得默认通过**。
不要复述作者的报告当作你的结论；不要因为 `pnpm test` 通过就认为召回质量达标
（测试只覆盖机制，不覆盖召回质量）；不要为了让某项通过而修改生产代码
（允许做实验性修改，但必须还原，并用 `git diff` 证明已还原）。

## 一、背景

项目：`obsidian-chinese-plugin-market`（Obsidian 中文插件市场插件）。
检索链路：`expandQueryTerms`（中文功能词 → 英文别名，带权重）→ BM25 倒排召回（CJK 三元组分词）
→ 向量召回 → RRF 融合 → LLM 精排。本轮改动只涉及**关键词路的词表与权重**。

本轮之前的上一轮已修好「中文译名/译文进入检索语料」（`buildSemanticSearchPlugins`）与
「画布/无限画布/白板/流程图 的领域词锚点 + 长词优先」。**那些属于上一轮，不在本次验证范围**
（但如果本轮把它们改坏了，要报）。

## 二、作者声称的内容（逐条都要独立验证，不要采信）

1. `src/translation/lexicon/synonyms.ts` 新增约 130 个中文功能词（知识管理 / 可视化 / 生产力 /
   AI 检索 / 文献 / 写作 / 文件媒体 七类）+ 20 组精确短语。
2. 泛词权重拆成两张表：
   - `PLUGIN_GENERIC_ALIAS_TOKEN_WEIGHTS`（高风险泛词，0.4）：`笔记/链接/文件/时间/图表/代码/搜索/图片/同步`
     + `note/link/file/time/chart/code/search/image/sync/graph/management/manager/ai`。
     **别名短语内部的 token 也按它降权**（`vector search` 里的 `search`、`gantt chart` 里的 `chart`）。
   - 中泛化领域词 `画布/白板/canvas/whiteboard/freeform`：只在「命中中文泛词 key」和
     「用户直接输入英文」时降权，**不参与别名内部降权**。
3. 权重语义是 cap（`Math.min`）而不是相乘，因此同一个泛词被处理两次不会平方衰减
   （声称 `expandQueryTerms("AI")` 中 `ai` 权重是 0.4，不是 0.16）。
4. 新增 `compactAsciiCjkSpacing()`：匹配前抹掉 ASCII↔CJK 之间的空格，一份 key 同时覆盖
   「AI 写作」与「AI写作」、「PDF 标注」与「PDF标注」。
5. 35 个查询的评估结果：34 个前 3 精度 3/3，32 个前 10 ≥ 9/10，**没有任何一项指标低于基线**。
   典型改善：`卡片盒` 命中数 0→235；`时间线` 前 3 1/3→3/3；`双链笔记` 4536→158；
   `读书笔记` 4487→183；`卡片笔记` 4487→198；`本地 AI` 前 10 4/10→10/10。
6. 测试与构建：`tsc -noEmit` 通过；**67 个测试文件 / 942 条测试全部通过**；生产构建通过；
   `git diff --check` 无空白错误；评估脚本索引构建 398ms（6534 条插件），与改动前同量级。
7. 改动范围：生产代码只改了 `synonyms.ts`；测试改了 `synonyms.test.ts`、`ai.test.ts`；
   新增 `scripts/eval-synonym-recall.ts`、根目录报告 `SYNONYM-RECALL-REPORT.md`；
   `package.json` 加 1 个脚本、`.gitignore` 加 1 行。未改 lockfile、未改构建产物。
8. 作者自述的已知局限（**请独立判断这些局限是否成立、是否足以否定结论，以及是否还有没说的**）：
   - `kanban/vector/semantic/embedding/citation/meeting/compress/gantt/timeline` 等英文别名
     在中文译文语料里出现 0~1 次，无法离线独立验证。
   - 离线评估语料用插件 id 近似补齐英文侧（生产语料含原始英文名/描述）。
   - `向量搜索` 前 10 只有 5/10，作者归因于「语料内真·向量插件不足 10 条」。
   - **报告的「修复前」基线列不可逐位复现**：基线是用一份临时副本 + esbuild `--alias`
     生成的，副本已删除，且工作区在本轮开始前就带有上一轮未提交的改动，因此
     `git show HEAD:src/translation/lexicon/synonyms.ts` **不是**本轮的正确基线。

## 三、可执行命令（环境提示）

`pnpm` 可能不可用；下列写法等价：

- 测试：`pnpm test` 或 `node node_modules/vitest/vitest.mjs run`
- 类型检查：`npx tsc -noEmit -skipLibCheck` 或 `node node_modules/typescript/bin/tsc -noEmit -skipLibCheck`
- 生产构建：`node esbuild.config.mjs production`
- 空白检查：`git diff --check`
- 召回评估：`pnpm eval:recall` 或 `node scripts/eval-synonym-recall.mjs`
  （`--markdown` 输出 markdown 表；`--zh-only` 用纯中文语料）
- 评估语料：`seeded-translator-cache.json`（6534 条中文译名/译文）、`plugin-tags.json`

**消融（ablation）配方 —— 这是本轮验证最重要的手段，请优先使用：**
复制词表到临时文件、删掉/改掉某个条目，用 esbuild 别名替换后独立跑，**不动工作区源码**：

```bash
cp src/translation/lexicon/synonyms.ts /tmp/ablate.ts      # 然后编辑 /tmp/ablate.ts
./node_modules/.bin/esbuild scripts/eval-synonym-recall.ts --bundle --platform=node --format=esm \
  --external:obsidian --external:sql.js --external:@huggingface/transformers \
  --alias:@domain=./src/domain --alias:@translation=./src/translation --alias:@shared=./src/shared \
  --alias:@semantic=./src/semantic --alias:@data=./src/data --alias:@app=./src/app --alias:@ui=./src/ui \
  --alias:@translation/lexicon/synonyms=/tmp/ablate.ts --outfile=/tmp/ablate.mjs
node /tmp/ablate.mjs --markdown
```

注意：`--alias:@translation/lexicon/synonyms=...` 必须放在 `--alias:@translation=...` **之后**才生效；
请先用「删掉 `卡片盒` 条目后 `卡片盒` 命中数应回到 0」自检这套配方确实生效。

## 四、验证清单

### A. 交付范围与合规
- A1 `git status --short` / `git diff --stat`：列出实际改动文件，与作者声称的清单比对，找出多改/少改。
- A2 `src/domain/search/ai.ts` 的 diff 应**只**涉及精确短语倒排表（`phrasePostings` / `phraseDf` /
  `exactPhrases` / `countPhraseOccurrences`）与 import 变化 —— 那是上一轮遗留。若出现本轮词表逻辑
  （新增权重表、改 `expandQuery`/`expandQueryTerms` 调用等），说明越界，判不通过。
- A3 检查是否修改了 lockfile、`main.js`、`styles.css`、`embedding-worker.bundle.js` 等构建产物，
  或把本应忽略的产物强制入库。
- A4 `package.json` 是否只新增了 `eval:recall` 一个脚本、`.gitignore` 是否只新增一行。

### B. 机制正确性（提示词第二节的 6 条约束，逐条给判定方法）
- B1 长词优先：「无限画布」命中后不得再命中子词「画布」。判定：
  `expandQueryTerms("无限画布")` 中 `whiteboard` 与 `freeform` 的权重应为 1；
  若「画布」也被命中，它们会被泛词权重压到 0.35 并封顶。请自行打印实际值判断。
- B2 精确短语不被泛词稀释：构造合成语料，验证「描述含『无限画布』的插件」排在
  「只有 canvas 的插件」之前。
- B3 自然语言保留中文概念锚点：`expandQuery("我想找一个无限画布相关的插件")` 必须同时含
  「无限画布」「infinite canvas」「infinite whiteboard」「freeform canvas」。
- B4 ASCII 不因子串误匹配：`expandQuery("email")`、`expandQuery("detail")`、`expandQuery("storage")`
  必须原样返回（不得因 `ai` / `rag` 子串命中）。
- B5 空 query / 未命中 / 纯英文 query 旧行为不破：
  `expandQuery("")===""`、`expandQuery("   ")==="   "`、`expandQueryTerms("")` 为 `[]`、
  `expandQuery("Notion")==="Notion"`。
- B6 不做全局去重：检查是否把全部 alias 摊平成一个全局集合（那样会让每个概念的扩展不再局部可解释）。
- B7 权重语义确实是 cap：`expandQueryTerms("AI")` 中 `ai` 权重应为 0.4（不是 0.16）；
  并检查 `PLUGIN_GENERIC_ALIAS_TOKEN_WEIGHTS` **不含** `canvas/whiteboard/freeform`，
  而 `PLUGIN_GENERIC_WORD_WEIGHTS` 含全部高风险泛词。
- B8 空格归一：`expandQuery("AI 写作")` 与 `expandQuery("AI写作")` 应产生等价结果；
  `findMatchedExactPhrases("PDF 标注")` 应等于 `PLUGIN_EXACT_PHRASES["PDF标注"]`。
  另外请判断这个归一有没有副作用（例如把本应分开的两个词粘在一起）。

### C. 测试的区分力（最容易出现「假验证」，务必做）
- C1 **用消融法证明新测试有区分力**：删掉 `卡片盒` / `双链笔记` / `时间线` 的条目后，
  `synonyms.test.ts` 与 `ai.test.ts` 中对应的新增断言必须**失败**。若仍然全绿，说明测试无区分力，判不合格。
- C2 `ai.test.ts` 里那条「前提：QUERIES 不命中精确短语表」守卫：临时把「笔记」加进
  `PLUGIN_EXACT_PHRASES`，确认该守卫会失败（验证后还原）。
- C3 `ai.test.ts` 的「倒排索引 vs 逐条打分」对拍，参考实现已改为与生产同源（`expandQueryTerms`）。
  请判断它**是否还具备独立性**：故意把 `buildBm25Index` 的 `docLen` 或 `df` 写错，该对拍是否会失败？
  如果不会，请明确指出这条测试现在能发现什么、不能发现什么。
- C4 检查两条手算基准（`0.4×ln2`、k1/b 那条）的推导是否与生产公式一致，
  以及 `0.4` 这个 query 权重是否确实来自 `笔记` 的泛词封顶。

### D. 评估脚本自身的有效性（结论的地基）
- D1 逐条审查 `scripts/eval-synonym-recall.ts` 里 `QUERIES` 的相关性正则。**这些正则由作者编写，
  存在「自己给自己打分」的风险**：请指出哪些正则过宽（例如包含 `search`/`graph`/`note`/
  `project`/`task`/`brain` 这类泛词，或包含 `graph` 这种会把普通图形插件算作命中的词），
  收紧后重算对应查询的前 10 精度，并说明结论是否因此改变。
- D2 语料口径：`name = 中文译名 + 插件id`、`description = 中文译文`。请判断
  「把 kebab-case 的 id 塞进 name」是否会**虚增**英文别名的收益（例如 `obsidian-kanban` 让
  `kanban` 别名白拿命中），以及相对于生产语料（译名 + 原始英文名 / 译文 + 原始英文描述）
  这个近似是偏乐观还是偏保守。用 `--zh-only` 对照至少 5 个查询给出证据。
- D3 复核 `向量搜索` 的 5/10：统计语料中真正的向量/嵌入/相似度插件数量，
  判断这是「语料不足」还是「别名过宽」，并给出依据。
- D4 「无任何指标低于基线」这一结论**依赖作者不可复现的基线**。请改用消融法独立复核至少 8 个查询
  （覆盖：`卡片盒`、`时间线`、`双链笔记`、`读书笔记`、`本地 AI`、`PDF 标注`、`图片压缩`、`无限画布`），
  验证「改善确实来自新增条目」而不是评估口径或其它条目；若无法归因，判「无法判定」。

### E. 失真与候选池爆炸（作者承诺的重点）
- E1 单独查询 9 个高风险泛词（`笔记/链接/文件/时间/图表/代码/搜索/图片/同步`），
  报告命中数。作者承诺它们不应把候选池扩大到数千条；请用消融法（删掉对应泛词权重或条目）
  对比命中数，判断降权是否真的起作用。
- E2 断言 `双链笔记` / `读书笔记` / `卡片笔记` 的命中数远小于全库（作者称 158/183/198，全库 6534）。
- E3 扫描 `PLUGIN_SYNONYMS` 的**全部 key**，找出任何「过于泛化、没有明确功能边界」的新增 key
  （两字泛词、`管理`/`模型`/`助手`/`工具` 之类），给出命中数证据并判断是否应删除。
- E4 检查新增的 20 组精确短语是否让 BM25 索引构建变慢：测量 `buildBm25Index` 耗时，
  与「把 `PLUGIN_EXACT_PHRASES` 清空」对比，判断 398ms 这个数字与成本增幅是否可接受。

### F. 报告数字核对
- F1 重跑 `node scripts/eval-synonym-recall.mjs --markdown`，**逐格**比对
  `SYNONYM-RECALL-REPORT.md` 第四节表格的命中数与精度。任何一格不一致即判报告失实。
- F2 核对 942 条测试 / 67 个文件、索引构建耗时、`git diff --check` 结论。
- F3 检查报告里是否有「未经验证的断言」或「被表述成事实的推测」。

## 五、输出格式

先给结论表，再给证据，最后给总评。

```
| 编号 | 检查项 | 结论(通过/不通过/无法判定) | 证据（命令 + 原始输出片段） | 反例或修复建议 |
```

要求：
- 每一行的「证据」必须是**你自己跑出来的**原始输出片段或具体代码行号，不能是作者的转述。
- 总评三选一：**可接受** / **有条件接受（列出必须修复项）** / **不接受**，
  并单独回答一句话：**「中文功能词能否召回正确插件，且不因泛词扩展让结果严重失真」这个完成标准是否达成？**
- 最后列出「作者没有提到、但你发现的问题」，哪怕只是可疑但未能定论的。

===== 提示词结束 =====
