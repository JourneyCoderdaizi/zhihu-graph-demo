#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
大模型能力层 —— ALGORITHM.md 里 6 个"改进入口"的可插拔 LLM 实现。

统一特征：① 离线批量跑一次 ② 磁盘缓存 ③ 无 API Key 自动降级回原规则，绝不断链。

杠杆点（按投入产出比排序）：
  L1 向量化    vectorize()   -> embedding()             语义理解，收益最高
  L2 场景打标  score_dims()  -> llm_label_dimensions()  告别手写 DIMS 词典
  L3 立场判定  polarity()    -> llm_polarity()          75% -> 接近人工
  L4 簇命名    cluster_name  -> llm_name_cluster()      自动可读派别名
  L5 被低估解释 hidden 段    -> llm_explain_gem()       "为什么这条被低估"
  L6 全文增强  摘要→要点     -> llm_comprehend()        补足摘要判别力

接入：设置三个环境变量即可切换厂商（OpenAI / 通义 / DeepSeek / 本地 Ollama）
    LLM_BASE_URL   例 https://api.deepseek.com/v1
    LLM_API_KEY    你的 key
    LLM_MODEL      例 deepseek-chat
    LLM_EMB_MODEL  例 text-embedding-3-small（仅 L1 需要）
"""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import typing as T

CACHE_DIR = pathlib.Path(__file__).resolve().parent / ".llm_cache"
CACHE_DIR.mkdir(exist_ok=True)

# 运行计数：便于判断本次有多少走了 LLM、多少降级
STATS = {"hit_cache": 0, "called": 0, "degraded": 0}


class LLMClient(T.Protocol):
    def chat(self, system: str, user: str, json_mode: bool = False) -> str: ...


class OpenAICompatClient:
    """兼容 OpenAI / 通义 / DeepSeek / Moonshot / 本地 Ollama(/v1) 的通用实现。"""

    def __init__(self) -> None:
        self.base = os.environ.get("LLM_BASE_URL", "").rstrip("/")
        self.key = os.environ.get("LLM_API_KEY", "")
        self.model = os.environ.get("LLM_MODEL", "gpt-4o-mini")
        self.ok = bool(self.base and self.key)

    def chat(self, system: str, user: str, json_mode: bool = False) -> str:
        if not self.ok:
            raise RuntimeError("LLM 未配置")
        import urllib.request

        body: dict = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0.2,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        req = urllib.request.Request(
            f"{self.base}/chat/completions",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {self.key}"},
        )
        with urllib.request.urlopen(req, timeout=90) as r:
            return json.loads(r.read())["choices"][0]["message"]["content"]


def _cached(key: str, fn):
    fp = CACHE_DIR / (hashlib.md5(key.encode()).hexdigest() + ".json")
    if fp.exists():
        STATS["hit_cache"] += 1
        return json.loads(fp.read_text(encoding="utf-8"))
    out = fn()
    fp.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    return out


# ---------- L1 向量化 ----------
def embedding(client: LLMClient, texts: list[str],
              batch: int = 64) -> list | None:
    """批量取 Embedding；失败返回 None，调用方降级 TF-IDF。"""
    if not getattr(client, "ok", False):
        return None
    import urllib.request

    base = os.environ.get("LLM_BASE_URL", "").rstrip("/")
    key = os.environ.get("LLM_API_KEY", "")
    model = os.environ.get("LLM_EMB_MODEL", "text-embedding-3-small")
    out: list = []
    try:
        for i in range(0, len(texts), batch):
            chunk = texts[i:i + batch]
            req = urllib.request.Request(
                f"{base}/embeddings",
                data=json.dumps({"model": model, "input": chunk}).encode(),
                headers={"Content-Type": "application/json",
                         "Authorization": f"Bearer {key}"},
            )
            with urllib.request.urlopen(req, timeout=120) as r:
                data = json.loads(r.read())["data"]
            out.extend(d["embedding"] for d in sorted(data, key=lambda x: x["index"]))
        STATS["called"] += 1
        return out
    except Exception:
        STATS["degraded"] += 1
        return None


# ---------- L2 场景打标 ----------
def llm_label_dimensions(client: LLMClient, snippet: str,
                         dims: list[str]) -> dict:
    """对一条回答打 [-1,1] 多维倾向。换话题只需换 dims，无需重写词典。"""
    key = f"dim|{','.join(dims)}|{snippet[:600]}"

    def _do():
        sys = ("你是中文语义标注器。对给定文本，就每个维度输出 [-1,1] 倾向分："
               "1=强烈正向，-1=强烈负向，0=未涉及。"
               "注意反驳式表述（含负面词但实为正向）应判正。只输出 JSON。")
        usr = json.dumps({"text": snippet[:1200], "dims": dims}, ensure_ascii=False)
        try:
            res = json.loads(client.chat(sys, usr, json_mode=True))
            STATS["called"] += 1
            return res
        except Exception:
            STATS["degraded"] += 1
            return {}

    return _cached(key, _do)


# ---------- L3 立场判定 ----------
def llm_polarity(client: LLMClient, question: str, snippet: str) -> dict:
    """pro / con / conditional + 置信度。针对关键词法的三类硬伤做了提示。"""
    key = f"pol|{question}|{snippet[:600]}"

    def _do():
        sys = ("判断回答对问题的立场，三选一：pro/con/conditional，并给 0..1 置信度。"
               "特别注意三种易错情形："
               "① 反驳式提及（含负面词却是正方，如『电池焦虑被严重放大了』）；"
               "② 条件句（『有桩就买，没桩别碰』应判 conditional）；"
               "③ 纯政策陈述（无立场应判 conditional）。"
               '只输出 JSON：{"label":"...","confidence":0.0}')
        usr = json.dumps({"question": question, "answer": snippet[:1200]},
                         ensure_ascii=False)
        try:
            res = json.loads(client.chat(sys, usr, json_mode=True))
            STATS["called"] += 1
            return res
        except Exception:
            STATS["degraded"] += 1
            return {"label": "conditional", "confidence": 0.0}

    return _cached(key, _do)


# ---------- L4 簇命名 ----------
def llm_name_cluster(client: LLMClient, members: list[str],
                     dims: dict | None = None) -> str:
    """用 6–12 字概括派别名，如「有私桩派·谷电党」。"""
    joined = "\n".join(m[:200] for m in members[:12])
    key = f"name|{hashlib.md5(joined.encode()).hexdigest()}"

    def _do():
        sys = ("你是观点聚类命名器。用 6-12 个汉字概括这组回答的共同立场派别，"
               "形如『有私桩派·谷电党』或『严寒续航怀疑派』。只输出名称，不要解释。")
        usr = joined
        if dims:
            usr = f"场景维度均值：{json.dumps(dims, ensure_ascii=False)}\n\n{usr}"
        try:
            res = client.chat(sys, usr).strip().strip('"').strip()[:24]
            STATS["called"] += 1
            return res
        except Exception:
            STATS["degraded"] += 1
            return ""

    return _cached(key, _do)


# ---------- L5 被低估解释 ----------
def llm_explain_gem(client: LLMClient, snippet: str, upvotes: int,
                    q: float) -> str:
    """一句话说明这条高质低赞回答为什么被低估。"""
    key = f"gem|{snippet[:600]}|{upvotes}"

    def _do():
        sys = ("用一句不超过 40 字的中文，说明这条『高质量但低赞』的回答"
               "为什么被低估：先点出它的独特干货，再说被埋没的原因。不要客套。")
        try:
            res = client.chat(sys, f"赞数 {upvotes}，质量分 {q:.2f}\n\n{snippet[:1200]}")
            STATS["called"] += 1
            return res.strip()
        except Exception:
            STATS["degraded"] += 1
            return ""

    return _cached(key, _do)


# ---------- L6 全文增强 ----------
def llm_comprehend(client: LLMClient, snippet: str) -> dict:
    """把搜索摘要压成结构化要点，提升聚类判别力（弥补非全文的短板）。"""
    key = f"compr|{snippet[:600]}"

    def _do():
        sys = ("抽取这条回答的核心信息，只输出 JSON："
               '{"claims":["核心主张,最多3条"],'
               '"evidence":["具体数据或亲历证据,最多3条"],'
               '"conditions":["成立前提,最多2条"]}')
        try:
            res = json.loads(client.chat(sys, snippet[:1500], json_mode=True))
            STATS["called"] += 1
            return res
        except Exception:
            STATS["degraded"] += 1
            return {"claims": [], "evidence": [], "conditions": []}

    return _cached(key, _do)


# ---------- 装配：对 graph.json 做 LLM 增强 ----------
def enrich_graph(path: pathlib.Path | None = None) -> dict:
    """无 Key 时全部走降级分支，图数据原样保留，管线不断链。"""
    path = path or (pathlib.Path(__file__).resolve().parent / "data" / "graph.json")
    g = json.loads(path.read_text(encoding="utf-8"))
    client = OpenAICompatClient()

    if not client.ok:
        print("LLM 未配置 —— 跳过增强，保留规则层结果（管线不断链）")
        g["llm"] = {"enabled": False, "reason": "LLM_BASE_URL / LLM_API_KEY 未设置"}
        path.write_text(json.dumps(g, ensure_ascii=False, separators=(",", ":")),
                        encoding="utf-8")
        return g

    print(f"LLM 已配置：{client.model}")
    for q in g["questions"]:
        answers = [n for n in q["nodes"] if n["kind"] == "answer"]
        dims = q.get("dim_keys", ["charge", "mileage", "horizon", "climate"])

        for n in answers:
            text = n.get("text", "")
            pol = llm_polarity(client, q["title"], text)
            if pol.get("label"):
                n["stance_llm"] = pol["label"]
                n["stance_llm_conf"] = round(float(pol.get("confidence", 0)), 2)
            lab = llm_label_dimensions(client, text, dims)
            if lab:
                n["dims_llm"] = {k: round(float(v), 3)
                                 for k, v in lab.items() if k in dims}
            if n.get("hidden_gem"):
                note = llm_explain_gem(client, text, n.get("upvotes", 0), n.get("q", 0))
                if note:
                    n["gem_note"] = note

        for c in q["clusters"]:
            members = [n["text"] for n in answers if n["id"] in c.get("members", [])]
            if members:
                name = llm_name_cluster(client, members, c.get("dims"))
                if name:
                    c["name_llm"] = name

    g["llm"] = {"enabled": True, "model": client.model, "stats": dict(STATS)}
    path.write_text(json.dumps(g, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8")
    print(f"LLM 增强完成：{STATS}")
    return g


if __name__ == "__main__":
    c = OpenAICompatClient()
    print("LLM 配置状态:", "已配置" if c.ok else "未配置（全部降级回规则）")
    if c.ok:
        enrich_graph()
