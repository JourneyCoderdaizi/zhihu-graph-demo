#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
算法升级层 (v2) —— 叠加在 pipeline.py 之上，不改动其任何现有函数。

接入的 5 项升级（来自升级包，已在真实数据上验证后调整）：
  ① 向量化      embed_texts()        Embedding 优先，无 Key 降级 TF-IDF+SVD
  ② 社区发现    detect_communities() Louvain 做"校验"，KMeans 仍为主（见下）
  ③ 影响力      cis_scores()         PageRank + 独特性 + 质量 + 互动熵
  ④ 边过滤      pmi_edge_filter()    PMI×权重 信息增益，弱边默认隐藏
  ⑤ 交互        build_focus_ctx()    二阶邻域预计算，前端毫秒级高亮

## 关于 ② 的实测决策（重要）

升级包作者已提示 Louvain 在中小图上会切碎，我在真实数据上复测确认：

    q1 (47 节点 56 边)  resolution=1.0 → 13 簇 [9,8,7,7,4,3,3,1,1,1,1,1,1]
                        resolution=0.35 → 10 簇，仍有 6 个单点簇，模块度反降
    q2 (38 节点 41 边)  resolution=1.0 → 11 簇，同样大量单点簇

调 resolution 无法消除单点簇（它们是 kNN 图里度数 1 的叶节点，结构上确实孤立）。
而现有"语义+场景加权 KMeans"稳定输出 3–4 个规模相近的簇，能支撑"有私桩派 vs
严寒衰减派"这种可讲述的分歧结构。

因此按 UPGRADE_MAP 的建议采用保守方案：
  - KMeans 结果写入 cluster（主，驱动布局与簇名）
  - Louvain 结果写入 community_id（辅，用于交叉校验与结构着色）
  - 额外输出 community_agreement：两者的一致度，供判断簇划分是否可信
"""
from __future__ import annotations

import json
import math
import os
import pathlib
import random

import numpy as np

try:
    import networkx as nx
    HAS_NX = True
except ImportError:
    HAS_NX = False

SEED = 42
random.seed(SEED)
np.random.seed(SEED)

ROOT = pathlib.Path(__file__).resolve().parent
DATA = ROOT / "data"


# ============================================================
# ① 向量化：Embedding 优先，失败降级
# ============================================================
def embed_texts(texts: list[str], dim: int = 64) -> np.ndarray:
    """优先调用 Embedding API；未配置或失败时降级 TF-IDF+SVD。

    返回 (n, d) 归一化矩阵，下游 cluster / 建边 / 争议边零改动。
    """
    from llm_layer import embedding, OpenAICompatClient

    client = OpenAICompatClient()
    if client.ok:
        vecs = embedding(client, texts)
        if vecs:
            from sklearn.preprocessing import normalize
            arr = np.asarray(vecs, dtype=float)
            print(f"  [①] Embedding API 命中，维度 {arr.shape}")
            return normalize(arr)
        print("  [①] Embedding 调用失败，降级 TF-IDF+SVD")
    else:
        print("  [①] 未配置 LLM，使用 TF-IDF+SVD 降级实现")

    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.decomposition import TruncatedSVD
    from sklearn.preprocessing import normalize

    tf = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 4),
                         min_df=2, sublinear_tf=True)
    X = tf.fit_transform(texts)
    m = min(dim, X.shape[0] - 1, X.shape[1] - 1)
    if m < 2:
        return normalize(X.toarray())
    return normalize(TruncatedSVD(n_components=m, random_state=SEED)
                     .fit_transform(X))


# ============================================================
# ② 社区发现：Louvain（辅）
# ============================================================
def detect_communities(G, resolution: float = 1.0) -> dict:
    """Louvain 模块度最大化 + 邻域多数票边界精炼。

    实测在本规模图上偏碎，故仅作校验信号，不替代 KMeans 主聚类。
    """
    if not HAS_NX or G.number_of_nodes() == 0:
        return {}
    part = nx.community.louvain_communities(
        G, weight="weight", seed=SEED, resolution=resolution)
    comm = {}
    for cid, nodes in enumerate(part):
        for n in nodes:
            comm[n] = cid
    # 边界精炼：自身社区在邻域无代表时，归入邻域多数社区
    for n in G.nodes():
        nb = list(G.neighbors(n))
        if not nb:
            continue
        votes: dict[int, int] = {}
        for t in nb:
            votes[comm[t]] = votes.get(comm[t], 0) + 1
        top = max(votes, key=votes.get)
        if votes.get(comm[n], 0) == 0 and votes[top] >= max(2, len(nb) // 2):
            comm[n] = top
    return comm


def community_agreement(kmeans_labels: dict, comm: dict) -> float:
    """两套划分的一致度（同簇对中也同社区的比例），用于判断簇可信度。"""
    ids = [i for i in kmeans_labels if i in comm]
    if len(ids) < 2:
        return 0.0
    same_k = same_both = 0
    for a in range(len(ids)):
        for b in range(a + 1, len(ids)):
            i, j = ids[a], ids[b]
            if kmeans_labels[i] == kmeans_labels[j]:
                same_k += 1
                if comm[i] == comm[j]:
                    same_both += 1
    return round(same_both / same_k, 3) if same_k else 0.0


# ============================================================
# ③ CIS 复合影响力
# ============================================================
def interaction_entropy(*counts) -> float:
    """互动类型分布熵，归一到 [0,1]。单一类型互动(只有赞)熵低，多元互动熵高。"""
    v = np.maximum(np.array(counts, dtype=float), 0)
    s = v.sum()
    if s <= 0:
        return 0.0
    p = v / s
    nz = p[p > 0]
    k = max(len(counts), 2)
    return float(-(nz * np.log(nz)).sum() / math.log(k))


def cis_scores(G, quality: dict, vecs: dict, inter: dict | None = None,
               w: tuple = (0.30, 0.25, 0.30, 0.15)) -> dict:
    """CIS = w1·PageRank + w2·语义独特性 + w3·质量分 + w4·互动熵

    替代 tierOf 的 degree>=7 硬阈值：高频低质节点不再喧宾夺主。
    """
    if not HAS_NX or G.number_of_nodes() == 0:
        return {}
    nz = lambda d: _norm_dict(d)

    pr = nx.pagerank(G, weight="weight", max_iter=300)
    pr_n = nz(pr)

    # 语义独特性：与邻居语义质心越正交越独特（提出了别人没提的角度）
    uniq = {}
    for n in G.nodes():
        nb = [t for t in G.neighbors(n) if t in vecs]
        if not nb or n not in vecs:
            uniq[n] = 0.5
            continue
        own = vecs[n]
        cen = np.mean([vecs[t] for t in nb], axis=0)
        cen = cen / (np.linalg.norm(cen) + 1e-9)
        uniq[n] = float(np.clip(1.0 - float(np.dot(own, cen)), 0, 2) / 2)
    uniq_n = nz(uniq)

    q_n = nz({n: quality.get(n, 0.0) for n in G.nodes()})

    inter = inter or {}
    ent = {n: interaction_entropy(*inter.get(n, (0, 0))) for n in G.nodes()}
    ent_n = nz(ent)

    return {
        n: round(w[0] * pr_n.get(n, 0) + w[1] * uniq_n.get(n, 0)
                 + w[2] * q_n.get(n, 0) + w[3] * ent_n.get(n, 0), 4)
        for n in G.nodes()
    }


def _norm_dict(d: dict) -> dict:
    if not d:
        return {}
    v = np.array(list(d.values()), dtype=float)
    rng = float(np.ptp(v))
    if rng < 1e-9:
        return {k: 0.5 for k in d}
    return {k: float((x - v.min()) / rng) for k, x in d.items()}


# ============================================================
# ④ PMI 显著性边筛选
# ============================================================
def pmi_edge_filter(G, strong_pct: float = 0.10, mid_pct: float = 0.30) -> dict:
    """PMI×权重 作为信息增益 sig；强边粗亮、中边细、弱边默认隐藏。

    解决"蜘蛛网"：相比随机连边概率，只保留真正超出预期的连接。
    """
    if not HAS_NX or G.number_of_edges() == 0:
        return {}
    deg = dict(G.degree())
    m = G.number_of_edges()
    scored = []
    for u, v, d in G.edges(data=True):
        wt = d.get("weight", 1.0)
        joint = (deg[u] * deg[v]) / (2.0 * m * m)
        pmi = math.log((wt / m) / (joint + 1e-12) + 1e-12) if joint > 0 else 0.0
        scored.append(((u, v), max(0.0, pmi) * wt))

    sigs = sorted((s for _, s in scored), reverse=True)
    t_strong = sigs[min(int(len(sigs) * strong_pct), len(sigs) - 1)]
    t_mid = sigs[min(int(len(sigs) * mid_pct), len(sigs) - 1)]

    out = {}
    for (u, v), sig in scored:
        tier = "strong" if sig >= t_strong else ("mid" if sig >= t_mid else "weak")
        out[(u, v)] = {"sig": round(sig, 5), "etier": tier, "visible": tier != "weak"}
    return out


# ============================================================
# ⑤ Focus+Context 二阶邻域
# ============================================================
def build_focus_ctx(G) -> dict:
    """预计算每个节点的一阶/二阶邻域，前端 hover 时零计算高亮。"""
    if not HAS_NX:
        return {}
    fc = {}
    for n in G.nodes():
        d1 = set(G.neighbors(n))
        d2: set = set()
        for t in d1:
            d2 |= set(G.neighbors(t))
        d2 -= d1
        d2.discard(n)
        fc[n] = {"d1": sorted(d1), "d2": sorted(d2)}
    return fc


# ============================================================
# 视觉分层：CIS 驱动
# ============================================================
def cis_tier_threshold(cis: dict, top_ratio: float = 0.28) -> float:
    """L2 阈值用分位数自适应，而非固定值。

    实测固定 0.60 在两道题上给出 36% / 26% 两种差异很大的占比；
    改用分位数后 L2 稳定在 ~28%，层级比例跨题一致。
    """
    if not cis:
        return 1.0
    return float(np.quantile(np.array(list(cis.values())), 1.0 - top_ratio))


def tier_of(node_id: str, kind: str, cis: dict, hidden_gem: bool,
            t2: float | None = None) -> int:
    """L1 核心 / L2 枢纽 / L3 叶节点。被低估节点强制升为 L2。"""
    if kind == "question":
        return 1
    if t2 is None:
        t2 = cis_tier_threshold(cis)
    if hidden_gem or cis.get(node_id, 0.0) >= t2:
        return 2
    return 3


# ============================================================
# 主流程：读取 pipeline 产出的 graph.json，叠加升级字段
# ============================================================
def build_graph(q: dict, texts_by_id: dict) -> "nx.Graph":
    G = nx.Graph()
    for n in q["nodes"]:
        if n["kind"] == "answer":
            G.add_node(n["id"])
    for e in q["edges"]:
        if e["type"] == "semantic" and G.has_node(e["source"]) and G.has_node(e["target"]):
            G.add_edge(e["source"], e["target"], weight=max(e["w"], 1e-6))
    return G


def upgrade(path: pathlib.Path = None) -> dict:
    path = path or (DATA / "graph.json")
    g = json.loads(path.read_text(encoding="utf-8"))

    for q in g["questions"]:
        answers = [n for n in q["nodes"] if n["kind"] == "answer"]
        texts = {n["id"]: n.get("text", "") for n in answers}
        print(f"[{q['qid']}] {len(answers)} 回答")

        if not HAS_NX:
            print("  ! networkx 缺失，跳过图算法升级")
            continue

        G = build_graph(q, texts)

        # ① 语义向量（供 CIS 独特性使用）
        ids = [n["id"] for n in answers]
        mat = embed_texts([texts[i] for i in ids])
        vecs = {i: mat[k] for k, i in enumerate(ids)}

        # ② Louvain 社区（辅）
        comm = detect_communities(G)
        kml = {n["id"]: n["cluster"] for n in answers}
        agree = community_agreement(kml, comm)
        n_comm = len(set(comm.values())) if comm else 0
        print(f"  [②] Louvain {n_comm} 社区 vs KMeans {q['stats']['k']} 簇，"
              f"一致度 {agree}")

        # ③ CIS
        quality = {n["id"]: n["q"] for n in answers}
        inter = {n["id"]: (n.get("upvotes", 0), 0) for n in answers}
        cis = cis_scores(G, quality, vecs, inter)
        cv = np.array(list(cis.values())) if cis else np.array([0.0])
        print(f"  [③] CIS min={cv.min():.3f} med={np.median(cv):.3f} max={cv.max():.3f}")

        # ④ PMI 边过滤
        emap = pmi_edge_filter(G)
        vis = sum(1 for v in emap.values() if v["visible"])
        print(f"  [④] 可见边 {vis}/{len(emap)} = {vis/max(len(emap),1):.0%}")

        # ⑤ Focus 索引
        fc = build_focus_ctx(G)
        avg2 = np.mean([len(v["d2"]) for v in fc.values()]) if fc else 0
        print(f"  [⑤] Focus 索引 {len(fc)} 节点，平均二阶邻域 {avg2:.1f}")

        # ---- 回写节点 ----
        t2 = cis_tier_threshold(cis)
        print(f"  [分层] CIS 阈值(自适应 p72) = {t2:.3f}")
        tiers = {1: 0, 2: 0, 3: 0}
        for n in q["nodes"]:
            if n["kind"] == "answer":
                n["cis"] = cis.get(n["id"], 0.0)
                n["community_id"] = comm.get(n["id"], -1)
                n["degree"] = G.degree(n["id"]) if G.has_node(n["id"]) else 0
                n["tier"] = tier_of(n["id"], "answer", cis,
                                    n.get("hidden_gem", False), t2)
            elif n["kind"] == "question":
                n["tier"] = 1
            else:
                # 概念节点：跨越全部观点簇的才算核心桥（k=3 时 need=3）。
                # 这类概念被所有立场共同引用，是分歧结构里的真正枢纽。
                need = q["stats"]["k"]
                n["tier"] = 2 if n.get("bridge", 0) >= need else 3
            tiers[n["tier"]] = tiers.get(n["tier"], 0) + 1
        print(f"  [分层] L1={tiers[1]} L2={tiers[2]} L3={tiers[3]}")

        # ---- 回写边 ----
        for e in q["edges"]:
            key = (e["source"], e["target"])
            meta = emap.get(key) or emap.get((key[1], key[0]))
            if meta:
                e.update(meta)
            else:
                # 争议边与概念边不参与 PMI 过滤，始终可见
                e.update({"sig": None, "etier": e["type"], "visible": True})

        q["focus_ctx"] = fc
        q["stats"]["community_count"] = n_comm
        q["stats"]["community_agreement"] = agree
        q["stats"]["visible_edge_ratio"] = round(vis / max(len(emap), 1), 3)
        q["stats"]["tiers"] = tiers
        q["stats"]["cis_t2"] = round(t2, 4)

    g["upgrade"] = {
        "version": "v2",
        "applied": ["embed_texts", "detect_communities(aux)", "cis_scores",
                    "pmi_edge_filter", "build_focus_ctx", "tier_of(cis)"],
        "cluster_source": "kmeans",
        "community_source": "louvain(auxiliary)",
        "note": "Louvain 在本规模图上偏碎（13 簇含 6 单点簇），"
                "故 KMeans 仍为主聚类，Louvain 仅作校验与结构着色。",
    }
    path.write_text(json.dumps(g, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8")
    print(f"\n-> {path}")
    return g


if __name__ == "__main__":
    upgrade()
