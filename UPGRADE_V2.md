# 算法升级 v2 落地报告

> 基于你提供的升级包（`upgrade_pipeline.py` / `llm_layer.py` / `graph.upgrade.ts` /
> `focus-context.ts`）接入，所有结论来自真实数据实测，非合成语料。
>
> 落地文件：`upgrade.py`（后端升级层）、`llm_layer.py`（LLM 能力层）、
> `web/src/graph.ts`（渲染层接入）、`web/src/types.ts`（契约扩展）

---

## 一句话结论

**5 项升级中 4 项直接采纳并已跑通，1 项（Louvain 社区）在真实数据上验证后降级为辅助信号。**
LLM 层 6 个杠杆点全部实现，无 Key 自动降级，管线不断链。

---

## 升级项逐条实测

### ① 向量化 Embedding — 已接入，当前降级运行

`upgrade.py :: embed_texts()`

```
[①] 未配置 LLM，使用 TF-IDF+SVD 降级实现
```

Embedding 优先、失败降级的双通道已就位。**当前环境无 `LLM_API_KEY`，所以跑的是降级分支。**
配好三个环境变量后自动切换，下游零改动——这仍是投入产出比最高的一处，但需要你提供 Key 才能激活。

### ② 社区发现 Louvain — **降级为辅助信号（与升级包建议一致）**

你的 `UPGRADE_MAP.md` 已预警"合成 20 节点自检时切得过碎（9 簇），真实 47 节点会好很多"。
我在真实数据上复测，**结论是真实数据同样碎**：

| 数据 | resolution=1.0 | resolution=0.35 |
|---|---|---|
| q1（47 节点 56 边） | 13 簇 `[9,8,7,7,4,3,3,1,1,1,1,1,1]` 模块度 0.655 | 10 簇，仍 6 个单点簇，模块度降到 0.572 |
| q2（38 节点 41 边） | 11 簇 `[11,7,6,5,3,1,1,1,1,1,1]` 模块度 0.614 | 9 簇，模块度降到 0.500 |

调低 resolution 无法消除单点簇——它们是互为 kNN 图里度数为 1 的叶节点，**结构上确实孤立**，
这不是调参问题。

更关键的是 **Louvain 与 KMeans 的一致度只有 0.17**（同簇对中也同社区的比例）。
两套划分几乎正交，说明 Louvain 捕捉的是"谁和谁连边"的结构紧密性，
而 KMeans + 场景维度捕捉的是"谁和谁处境相同"的人群划分。**后者才是本产品要讲的分歧结构。**

**采纳方案**（按 UPGRADE_MAP 第 25 行建议）：

```
cluster         ← KMeans（主，驱动布局、簇名、争议边）
community_id    ← Louvain（辅，结构着色与交叉校验）
community_agreement ← 两者一致度，写入 stats 供判断簇可信度
```

### ③ CIS 复合影响力 — 已采纳，阈值改为自适应

`upgrade.py :: cis_scores()`

\[
\mathrm{CIS}=0.30\,\widehat{\mathrm{PR}}+0.25\,\widehat{U}+0.30\,\hat{Q}+0.15\,\hat{H}
\]

\(\widehat{\mathrm{PR}}\) PageRank，\(\widehat U\) 语义独特性（与邻居质心的正交度），
\(\hat Q\) 质量分，\(\hat H\) 互动熵。

实测分布：q1 `min=0.252 med=0.563 max=0.736`，q2 `min=0.357 med=0.502 max=0.725`。

**我改了一处**：升级包用固定阈值 `cis >= 0.6`，实测在两道题上给出 **36% vs 26%** 两种差异很大的
L2 占比。改为分位数自适应（取 top 28%）后，L2 稳定在 **32% / 29%**，层级比例跨题一致。

```python
def cis_tier_threshold(cis, top_ratio=0.28):
    return float(np.quantile(np.array(list(cis.values())), 1.0 - top_ratio))
```

对比原规则：`degree>=7` 给出 9 个 L2，CIS 给出 15 个且构成更合理——高频低质节点被压下去了。

### ④ PMI 边过滤 — 已采纳，效果最直接

`upgrade.py :: pmi_edge_filter()`

\[
\mathrm{sig}_{ij}=\max\left(0,\ \log\frac{w_{ij}/m}{\frac{d_i d_j}{2m^2}}\right)\cdot w_{ij}
\]

即边权相对"随机连边概率"的信息增益。实测分级：

| 数据 | strong | mid | weak（隐藏） | 可见率 |
|---|---|---|---|---|
| q1 | 6 | 12 | 39 | **30%** |
| q2 | 4 | 9 | 28 | **32%** |

和你自检的 31% 几乎一致。这是本轮**成本最低、去杂乱最明显**的一项。

渲染层按 `etier` 分级：strong 1.5px/0.5 透明度、mid 0.8px/0.24、weak 透明度 0（hover 才显形）。

### ⑤ Focus+Context — 已采纳并实现前端交互

`upgrade.py :: build_focus_ctx()` + `graph.ts :: applyFocus()`

后端预计算每个节点的一阶/二阶邻域（q1 47 条索引、平均二阶邻域 4.0），
前端 hover 时零图遍历，**常数时间响应**。

真实鼠标 hover 实测的四级透明度：

| 层 | 透明度 | 实测 |
|---|---|---|
| 自身 | 1.0 | ✓ |
| 一阶邻域 | 0.92 | ✓ |
| 二阶邻域 | 0.40 | ✓ |
| 其余 | 0.06 | ✓ 55 个节点压暗 |

关联边变白加粗到 1.9px（实测点亮 4 条），其余压到 0.02。移开后自动恢复。

---

## LLM 能力层

`llm_layer.py` — 6 个杠杆点全部实现，统一 `LLMClient` 接口，磁盘缓存，无 Key 自动降级。

| 杠杆 | 函数 | 解决什么 | 状态 |
|---|---|---|---|
| L1 向量化 | `embedding()` | "省电费≠用车成本低"的语义盲区 | 已实现，待 Key |
| L2 场景打标 | `llm_label_dimensions()` | 告别手写 `DIMS` 词典，换话题只换维度列表 | 已实现，待 Key |
| L3 立场判定 | `llm_polarity()` | 关键词法 75% 准确率 | 已实现，待 Key |
| L4 簇命名 | `llm_name_cluster()` | 自动生成可读派别名 | 已实现，待 Key |
| L5 被低估解释 | `llm_explain_gem()` | "为什么这条被低估" | 已实现，待 Key |
| L6 全文增强 | `llm_comprehend()` | 摘要判别力不足 | 已实现，待 Key |

**相比升级包原版我补了三处**：

1. **补上 L4 / L6** — 原版只实现了 L1/L2/L3/L5，`llm_name_cluster` 未接 dims、`llm_comprehend` 缺失
2. **Embedding 分批** — 原版单次提交全部文本，长语料会超 token 上限；改为 64 条一批
3. **运行计数** `STATS` — 区分 `hit_cache` / `called` / `degraded`，便于判断本次有多少真走了 LLM

**L3 的提示词我按实测失败案例强化了**，明确点出三类硬伤：

```
① 反驳式提及（含负面词却是正方，如"电池焦虑被严重放大了"）
② 条件句（"有桩就买，没桩别碰"应判 conditional）
③ 纯政策陈述（无立场应判 conditional）
```

### 启用方式

```bash
export LLM_BASE_URL=https://api.deepseek.com/v1
export LLM_API_KEY=sk-xxx
export LLM_MODEL=deepseek-chat
export LLM_EMB_MODEL=text-embedding-3-small   # 仅 L1 需要

python pipeline.py corpus_live.json   # 基础管线
python upgrade.py                     # v2 升级层（① 自动走 Embedding）
python llm_layer.py                   # L2–L6 增强
```

无 Key 时 `llm_layer.py` 输出 `LLM 未配置 —— 跳过增强，保留规则层结果`，
`graph.json` 原样保留，**管线不断链**。

---

## graph.json 新增字段

```jsonc
node: {
  cis: 0.6082,            // 复合影响力
  community_id: 5,        // Louvain 社区（辅）
  degree: 3,
  tier: 2,                // 1/2/3 视觉层级（CIS 驱动）
  stance_llm: "con",      // L3 产出（有 Key 时）
  dims_llm: {...},        // L2 产出
  gem_note: "..."         // L5 产出
}
edge: { sig: 0.314, etier: "strong", visible: true }
question: {
  focus_ctx: { "node_id": { d1: [...], d2: [...] } },
  stats: { community_count, community_agreement, visible_edge_ratio, cis_t2, tiers }
}
graph: { upgrade: {...}, llm: { enabled, model, stats } }
```

---

## 验证记录

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | 零错误 |
| `vite build` | 通过 |
| 控制台 | 零错误 |
| 后端五项升级 | q1/q2 全部跑通 |
| CIS 分层 | L1=1 / L2=25 / L3=34（回答节点 L2 占 32%） |
| PMI 可见率 | 30% / 32% |
| Focus 索引 | 47 / 38 条，平均二阶邻域 4.0 / 3.6 |
| Focus 真实 hover | 四级透明度 1 / 0.92 / 0.4 / 0.06 正确 |
| 节点越界 | 0 |

---

## 未采纳项说明

**Node2Vec 图嵌入**（升级包 `node2vec_embed()`）未接入。
它的用途是为 Louvain 做边界精炼，而 Louvain 已降级为辅助信号，
再叠一层纯 numpy 的随机游走 + PPMI + SVD（当前规模下约 47×40 次游走）
收益不明确。**代码保留在升级包中，待 Louvain 真正做主聚类时再启用。**

---

## 建议的下一步

1. **提供 LLM Key** — ① 和 L2/L3 是当前最大短板，有 Key 才能真正解决
2. 若想让 Louvain 做主聚类，需先提高图连通性（放宽 kNN 的 `kk` 到 6–8），
   把度数为 1 的叶节点减少，再重新评估模块度
3. L6 全文增强需配合 `me content` 级别的完整正文，当前搜索摘要 500 字左右上限明显
