#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
知乎问答关系图谱 — 离线流水线
输入: data/corpus.json
输出: data/graph.json  (前后端唯一契约)

阶段:
  1. 向量化        TF-IDF(char 2-4gram) -> SVD(32)  [线上替换为 Embedding API]
  2. 质量分 Q      赞数/信息密度/结构性/情绪化 四项加权
  3. 聚类          KMeans, 自动选 k in [3,5] (silhouette)
  4. 建边          互为 kNN + 相似度阈值
  5. 概念节点      字符 n-gram 候选词 -> 至少被 3 个回答共享
  6. 争议边        两个最远簇中语义最对立的一对回答
  7. 布局          固定随机种子的预计算坐标 (演示可复现)
"""
import json, math, re, pathlib, random, sys
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.decomposition import TruncatedSVD
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score
from sklearn.preprocessing import normalize

import scenario as sc

SEED = 42
random.seed(SEED); np.random.seed(SEED)
ROOT = pathlib.Path(__file__).resolve().parent
DATA = ROOT / "data"

# ---------- 词典 ----------
DIGIT = re.compile(r"\d")
NUMUNIT = re.compile(r"\d+\s*(?:元|度|公里|万|%|个百分点|次|小时|分钟|升|度电|年)")
TERMS = ["SOH", "磷酸铁锂", "三元锂", "循环寿命", "热泵", "质保", "残值", "保值率",
         "购置税", "减免税目录", "CLTC", "OTA", "域控", "激光雷达", "零整比",
         "分时电价", "谷电", "车网互动", "衰减", "标定", "电池包", "插混", "增程",
         "渗透率", "案均赔付", "持有成本", "现金流"]
EVID = ["我把", "我按", "实测", "我这台", "我收车", "我看了", "原始数据", "台架",
        "对照", "账单", "检测报告", "排除了", "我专门", "拆了", "费率表", "从修车端",
        "从运营侧", "归因", "做成了表", "亲测", "我算", "记录"]
EMO = ["真不想", "最烦", "吐槽", "智商税", "坑", "崩溃", "爱买买", "别被忽悠",
       "血泪", "劝退", "实话实说", "我不换", "没有任何悬念", "根本", "彻底"]
STANCE_POS = ["没有理由选燃油", "优势无可", "真香", "经济性没有任何悬念", "划算",
              "值得", "省钱利器", "总成本优势", "优势明显", "能省", "回本周期",
              "最优解", "放心选", "建议选纯电", "我会选纯电", "补不回来"]
REFUTE = ["被严重放大", "被放大", "被高估", "被严重高估", "不用担心", "没必要担心",
          "是伪问题", "并不成立", "比大家以为的温和", "比大家想的", "没有任何悬念",
          "这不是", "其实是", "被忽悠", "过时焦虑", "完全能", "足够", "温和"]
STANCE_COND = ["取决于", "这个前提", "前提不成立", "前提是", "分人群", "因人而异",
               "场景参数化", "参数化", "伪问题", "样本没对齐", "另一个世界",
               "不是同一道题", "这题对我就不存在", "要重写", "可以被三个变量解释",
               "持有周期", "而不是能源价格", "别只看结论", "结论就反过来"]
STANCE_NEG = ["智商税", "不省钱", "劝退", "隐性成本", "悬崖", "倒亏", "亏", "踩坑",
              "焦虑", "打折", "排队", "衰减", "残值低", "保值率低", "更贵更难修",
              "心智负担", "我不换", "别买", "慎选", "不推荐", "瓶颈", "负担"]


def load(name="corpus.json"):
    return json.loads((DATA / name).read_text(encoding="utf-8"))


# ---------- 1. 向量化 ----------
def vectorize(texts):
    """线上版本：替换为 Embedding API 批量调用，返回 (n, d) 归一化矩阵。"""
    tf = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 4),
                         min_df=2, sublinear_tf=True)
    X = tf.fit_transform(texts)
    d = min(32, X.shape[0] - 1, X.shape[1] - 1)
    X = TruncatedSVD(n_components=d, random_state=SEED).fit_transform(X)
    return normalize(X)


# ---------- 2. 质量分 ----------
def quality(answers):
    n = len(answers)
    L = np.array([math.log1p(a["upvotes"]) for a in answers])
    L = (L - L.min()) / (L.max() - L.min() + 1e-9)

    nz = lambda v: (v - v.min()) / (v.max() - v.min() + 1e-9)

    # D 拆成"量化密度"与"专业密度"两支分别归一化，避免纯定性深度分析被数字淹没
    Dq, Dt, S, E, V = (np.zeros(n) for _ in range(5))
    for i, a in enumerate(answers):
        t, ln = a["text"], max(len(a["text"]), 1)
        Dq[i] = len(DIGIT.findall(t)) / ln * 3 + len(NUMUNIT.findall(t)) / (ln / 100) * 0.3
        Dt[i] = sum(t.count(w) for w in TERMS) / (ln / 100)
        S[i] = min(1.0, (t.count("：") * 0.18 + t.count("；") * 0.15
                         + sum(t.count(w) for w in ["一是", "二是", "三是", "第一", "首先", "其次",
                                                    "核心", "关键", "结论", "本质", "区分", "前提"]) * 0.20
                         + (0.25 if ln > 220 else 0)))
        E[i] = min(1.0, sum(t.count(w) for w in EMO) * 0.3)
        V[i] = min(1.0, sum(t.count(w) for w in EVID) * 0.22)
    D = 0.55 * nz(Dq) + 0.45 * nz(Dt)
    S, V = nz(S), nz(V)
    Q = 0.20 * L + 0.34 * nz(D) + 0.18 * S + 0.21 * V - 0.15 * E
    return nz(Q), L


# ---------- 3. 聚类 ----------
def cluster(X):
    """k 的选择兼顾 silhouette 与簇平衡度：演示里 13/8/3 这种畸形分布讲不清故事。"""
    best = None
    for k in range(3, 6):
        km = KMeans(n_clusters=k, n_init=15, random_state=SEED).fit(X)
        sil = silhouette_score(X, km.labels_)
        sizes = np.bincount(km.labels_, minlength=k)
        balance = sizes.min() / sizes.max()
        score = 0.55 * sil + 0.45 * balance
        if best is None or score > best[0]:
            best = (score, km, k)
    return best[1], best[2]


# ---------- 5. 概念节点 ----------
def concepts(answers, labels, min_share=2, topn=12):
    cand = {}
    for w in TERMS + ["家充桩", "私桩", "公共快充", "冬季续航", "长途", "网约车",
                      "二手", "电池更换", "保费", "绿牌", "限牌", "通勤", "年里程"]:
        hit = [i for i, a in enumerate(answers) if w in a["text"]]
        if len(hit) >= min_share:
            cand[w] = hit
    # 优先保留跨簇的桥（连接的簇数越多越像桥）
    scored = sorted(cand.items(),
                    key=lambda kv: (-len({labels[i] for i in kv[1]}), -len(kv[1])))
    return scored[:topn]


# ---------- 主流程 ----------
def build_question(q):
    ans = q["answers"]
    texts = [a["text"] for a in ans]
    X = vectorize(texts)                  # 语义向量（用于相似度边）
    M, dim_keys, dim_rows = sc.dim_matrix(texts)   # 场景维度（可解释分歧轴）
    Q, Lnorm = quality(ans)

    # 聚类特征：语义 + 场景维度加权拼接。场景维度决定"分歧轴"，
    # 语义向量保证同轴内部的子话题仍能分开。
    F = normalize(np.hstack([normalize(X) * 0.6, M * 1.4]))
    km, k = cluster(F)
    labels = km.labels_
    S = X @ X.T                           # 相似度边仍只用语义，口径清晰

    # 立场倾向（用于簇命名的辅助信号）
    def polarity(t):
        """句级反驳作用域：若所在句含反驳框架，该句的负面词计为正面。

        解决"电池寿命焦虑被严重放大了"这类反驳式提及被误判为反方的问题。
        """
        p = m = flipped = 0
        for sent in re.split(r"[。！？；\n]", t):
            if not sent.strip():
                continue
            refuted = any(r in sent for r in REFUTE)
            p += sum(sent.count(w) for w in STANCE_POS)
            neg = sum(sent.count(w) for w in STANCE_NEG)
            if refuted:
                flipped += neg
            else:
                m += neg
        return p + flipped, m

    stance, stance_conf = [], []
    for t in texts:
        p, m = polarity(t)
        cond = sum(t.count(w) for w in STANCE_COND)
        tot = p + m + cond
        if tot == 0:
            stance.append("conditional"); stance_conf.append(0.0); continue
        # 条件派信号占优，或正反势均力敌 -> 判为条件派（避免强行二分造成误判）
        if cond >= max(p, m) + 1 or (p == m and cond > 0):
            stance.append("conditional")
            stance_conf.append(round(cond / tot, 2))
        elif p > m:
            stance.append("pro"); stance_conf.append(round((p - m) / tot, 2))
        else:
            stance.append("con"); stance_conf.append(round((m - p) / tot, 2))

    # --- 互为 kNN 建边 ---
    kk, tau = 4, 0.18
    knn = {i: set(np.argsort(-S[i])[1:kk + 1]) for i in range(len(ans))}
    edges = []
    for i in range(len(ans)):
        for j in knn[i]:
            if i < j and i in knn[j] and S[i, j] > tau:
                edges.append({"source": ans[i]["id"], "target": ans[j]["id"],
                              "w": round(float(S[i, j]), 4), "type": "semantic"})

    # --- 被低估 ---
    # --- 被低估：高质量 + 低赞 ---
    # 前提是赞数可信。搜索接口的 VoteUpCount 大量返回 0（接口不保证提供真实赞数），
    # 此时"低赞"判据失真，会把一半内容误标成"被低估"。因此先检验赞数可用性，
    # 不可用时关闭该功能并如实标记，不伪装成有效结果。
    ups = np.array([a["upvotes"] for a in ans], dtype=float)
    zero_ratio = float((ups <= 0).mean())
    upvote_reliable = zero_ratio < 0.35 and float(ups.max()) > 0
    if upvote_reliable:
        # 真实数据赞数呈重长尾（多数为个位数），仅用分位数会把近半内容标成"被低估"。
        # 改为双重判据：质量分进前 25%，且赞数显著低于本题中位水平。
        qt = np.quantile(Q, 0.75)
        med = float(np.median(ups))
        lt = max(med, 1.0)
        hidden = [i for i in range(len(ans))
                  if Q[i] >= qt and ups[i] <= lt]
    else:
        hidden = []

    # --- 簇信息 ---
    def dim_name(c):
        """按最突出的场景维度生成簇名，比词频簇名更贴合分歧轴。"""
        d = dim_stats[c]
        strong = max(d, key=lambda k: abs(d[k]))
        if abs(d[strong]) < 0.2:
            return "通用/综合考量"
        phrase = {
            ("charge", 1): "有私桩派", ("charge", -1): "无桩依赖公共充电",
            ("mileage", 1): "高里程长途", ("mileage", -1): "低里程短途",
            ("horizon", 1): "长期持有", ("horizon", -1): "短期换车看残值",
            ("climate", 1): "温暖地区", ("climate", -1): "严寒续航衰减",
        }
        return phrase[(strong, 1 if d[strong] > 0 else -1)]

    def cluster_name(idx):
        """用簇内相对突出的概念词生成簇名（线上可换 LLM 生成 6 字内标题）。"""
        pool = TERMS + ["家充桩", "私桩", "公共快充", "冬季续航", "长途", "网约车",
                        "二手", "电池更换", "保费", "绿牌", "限牌", "通勤", "年里程",
                        "维修", "售后", "智能化", "政策", "残值"]
        inside = " ".join(texts[i] for i in idx)
        outside = " ".join(texts[i] for i in range(len(texts)) if i not in idx)
        sc = {}
        for w in pool:
            a = inside.count(w) / max(len(inside), 1) * 1e4
            b = outside.count(w) / max(len(outside), 1) * 1e4
            if a > 0 and a - b > 0:
                sc[w] = a - b
        top = sorted(sc, key=lambda w: -sc[w])[:2]
        return " / ".join(top) if top else "其他观点"

    cents = km.cluster_centers_
    dim_stats = sc.axis_summary(M, dim_keys, labels, k)
    clusters = []
    for c in range(k):
        idx = [i for i in range(len(ans)) if labels[i] == c]
        maj = max(set(stance[i] for i in idx),
                  key=lambda s: sum(1 for i in idx if stance[i] == s))
        maj_share = round(sum(1 for i in idx if stance[i] == maj) / len(idx), 2)
        rep = max(idx, key=lambda i: Q[i])
        clusters.append({"cid": f"{q['qid']}-c{c}", "idx": c, "size": len(idx),
                         "name": f"{dim_name(c)}·{cluster_name(idx)}",
                         "axis": dim_name(c),
                         "keywords": cluster_name(idx),
                         "dims": dim_stats[c],
                         "stance": maj, "stance_share": maj_share,
                         "rep_author": ans[rep]["author"],
                         "members": [ans[i]["id"] for i in idx]})

    # --- 争议边：场景维度上最对立的跨簇一对 ---
    # 注意：不能用"语义最不相似"来找对立——低相似度通常只代表话题无关。
    # 真正的对立 = 在同一议题上场景取值相反，因此用维度向量的反向距离。
    cs = normalize(cents)
    CS = cs @ cs.T
    np.fill_diagonal(CS, 9)
    a_, b_ = np.unravel_index(np.argmin(CS), CS.shape)
    ia = [i for i in range(len(ans)) if labels[i] == a_]
    ib = [i for i in range(len(ans)) if labels[i] == b_]

    def opposition(i, j):
        """维度相反程度（越大越对立）× 话题相关度（避免选到无关的两条）。"""
        di, dj = M[i], M[j]
        active = (np.abs(di) > 0.1) & (np.abs(dj) > 0.1)
        if not active.any():
            return -1.0
        contra = float(np.mean(np.abs(di[active] - dj[active])))
        relevance = max(float(S[i, j]), 0.02)
        return contra * (relevance ** 0.3)

    pair = max(((i, j) for i in ia for j in ib), key=lambda p: opposition(*p))
    edges.append({"source": ans[pair[0]]["id"], "target": ans[pair[1]]["id"],
                  "w": round(float(S[pair]), 4), "type": "dispute",
                  "opposition": round(opposition(*pair), 4)})

    # --- 概念节点 + 桥边（坐标在布局后统一计算）---
    con_nodes, con_edges = [], []
    con_hits = concepts(ans, labels)

    # --- 7. 预计算布局（固定种子，演示每次打开形状一致）---
    rng = np.random.default_rng(SEED)
    # 主轴 = 方差最大的场景维度，次轴取第二大，构成可解释的二维平面
    var = M.var(axis=0)
    ax1, ax2 = np.argsort(-var)[:2]
    pos = {}
    for c in range(k):
        idx = [i for i in range(len(ans)) if labels[i] == c]
        cx = float(M[idx, ax1].mean()) * 420
        cy = float(M[idx, ax2].mean()) * 420
        ang0 = 2 * math.pi * c / k
        for t, i in enumerate(idx):
            r = 58 + 26 * (1 - Q[i])
            a = ang0 + 2 * math.pi * t / max(len(idx), 1)
            pos[ans[i]["id"]] = [round(cx + r * math.cos(a) + rng.normal(0, 9), 1),
                                 round(cy + r * math.sin(a) + rng.normal(0, 9), 1)]

    # 碰撞松弛（统一处理回答 + 中心问题 + 概念节点，避免任何两类节点互相压盖）
    rad = {a["id"]: 16 + float(Q[i]) * 30 for i, a in enumerate(ans)}

    # 中心问题节点占位：放在全部回答的质心，参与松弛
    qnid = q["qid"]
    pos[qnid] = [float(np.mean([pos[a["id"]][0] for a in ans])),
                 float(np.mean([pos[a["id"]][1] for a in ans]))]
    rad[qnid] = 54

    # 概念节点先落在所连回答的质心 —— 跨簇概念自然浮到簇之间成为视觉上的桥
    con_meta = []
    for w, hit in con_hits:
        cid = f"{q['qid']}-k-{w}"
        linked = sorted(hit, key=lambda i: -Q[i])[:4]
        pos[cid] = [float(np.mean([pos[ans[i]["id"]][0] for i in linked])),
                    float(np.mean([pos[ans[i]["id"]][1] for i in linked]))]
        rad[cid] = 9 + len(hit) * 1.5
        con_meta.append((cid, w, hit, linked))

    ids = list(pos.keys())
    for _ in range(260):
        moved = False
        for x in range(len(ids)):
            for y in range(x + 1, len(ids)):
                p1, p2 = pos[ids[x]], pos[ids[y]]
                dx, dy = p2[0] - p1[0], p2[1] - p1[1]
                d = math.hypot(dx, dy) or 0.01
                need = (rad[ids[x]] + rad[ids[y]]) * 0.62 + 36
                if d < need:
                    push = (need - d) / 2
                    ux, uy = dx / d, dy / d
                    # 中心问题节点权重更高，少被推动
                    w1 = 0.25 if ids[x] == qnid else 1.0
                    w2 = 0.25 if ids[y] == qnid else 1.0
                    p1[0] -= ux * push * w1; p1[1] -= uy * push * w1
                    p2[0] += ux * push * w2; p2[1] += uy * push * w2
                    moved = True
        if not moved:
            break
    for i in ids:
        pos[i] = [round(pos[i][0], 1), round(pos[i][1], 1)]

    for cid, w, hit, linked in con_meta:
        con_nodes.append({"id": cid, "name": w, "kind": "concept",
                          "share": len(hit),
                          "bridge": len({labels[i] for i in hit}),
                          "x": pos[cid][0], "y": pos[cid][1]})
        for i in linked:
            con_edges.append({"source": cid, "target": ans[i]["id"],
                              "w": 0.3, "type": "concept"})

    # --- 节点 ---
    nodes = [{"id": q["qid"], "name": q["title"], "kind": "question",
              "x": pos[qnid][0], "y": pos[qnid][1],
              "answer_count": q["answer_count_display"], "clusters": k}]
    for i, a in enumerate(ans):
        nodes.append({
            "id": a["id"], "name": a["author"], "kind": "answer",
            "badge": a["badge"], "upvotes": a["upvotes"],
            "q": round(float(Q[i]), 4), "cluster": int(labels[i]),
            "stance": stance[i], "stance_conf": stance_conf[i],
            "dims": dim_rows[i],
            "hidden_gem": i in hidden,
            "x": pos[a["id"]][0], "y": pos[a["id"]][1],
            "url": a.get("url", ""),
            "headline": a.get("headline", ""),
            "badge_text": a.get("badge_text", ""),
            "source_title": a.get("title", ""),
            "gist": a["text"][:46].rstrip("，。；、") + "…",
            "text": a["text"],
        })
    nodes += con_nodes

    return {"dim_keys": dim_keys, "dim_label": sc.DIM_LABEL,
            "layout_axes": [dim_keys[int(ax1)], dim_keys[int(ax2)]],
            "qid": q["qid"], "title": q["title"],
            "answer_count": q["answer_count_display"],
            "nodes": nodes, "edges": edges + con_edges,
            "clusters": clusters,
            "dispute_pair": [ans[pair[0]]["id"], ans[pair[1]]["id"]],
            "stats": {"answers": len(ans), "edges": len(edges) + len(con_edges),
                      "concepts": len(con_nodes), "hidden": len(hidden), "k": k,
                      "upvote_reliable": bool(upvote_reliable),
                      "upvote_zero_ratio": round(zero_ratio, 3)}}


def main():
    # 支持 `python pipeline.py corpus_live.json` 切换到真实知乎语料
    name = sys.argv[1] if len(sys.argv) > 1 else "corpus.json"
    src = load(name)

    # 真实数据可能缺赞数或正文过短，统一做一次入口清洗
    for q in src["questions"]:
        kept = []
        for a in q["answers"]:
            if a.get("upvotes") is None:
                a["upvotes"] = 0          # 缺失按 0 处理，不编造数值
            if len((a.get("text") or "").strip()) >= 60:
                kept.append(a)
        q["answers"] = kept

    out = {"meta": src["meta"], "seed": SEED, "source_corpus": name,
           "questions": [build_question(q) for q in src["questions"]]}
    (DATA / "graph.json").write_text(
        json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"语料: {name}（{src['meta'].get('data_nature')}）")
    for q in out["questions"]:
        print(f"[{q['qid']}] {q['title']}")
        print("   ", q["stats"])
        for c in q["clusters"]:
            d = " ".join(f"{k}{v:+.2f}" for k, v in c["dims"].items())
            print(f"    簇{c['idx']} n={c['size']:2d} {c['name']:22s} [{d}] 代表={c['rep_author']}")
        print("    争议对:", q["dispute_pair"])
        print("    被低估:", [n["name"] for n in q["nodes"]
                              if n.get("hidden_gem")])


if __name__ == "__main__":
    main()
