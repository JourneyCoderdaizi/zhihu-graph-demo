#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
真实知乎数据采集 —— 通过知乎官方 CLI 取代此前的改写演示语料。

输出: data/corpus_live.json（与 corpus.json 同契约，可直接喂给 pipeline.py）

设计要点:
  - 多关键词覆盖同一议题的不同立场面，避免单次检索只拿到一边的观点
  - 按 ContentID 去重
  - 身份属性从 Headline(答主签名) 启发式推断，不伪造认证信息
  - 赞数字段若服务端未提供则置 None，由 pipeline 侧降级处理，绝不编造
"""
import json
import pathlib
import re
import subprocess
import sys

CLI = r"C:\Users\25115\.box-agent-kanshan\cli\zhihu\current\zhihu-cli.exe"
ROOT = pathlib.Path(__file__).resolve().parent
DATA = ROOT / "data"

# 每道题用多个关键词覆盖不同立场，避免样本偏到一侧
TOPICS = [
    {
        "qid": "q1",
        "title": "2026 年买车，该选新能源还是燃油车？",
        "queries": [
            "新能源车 还是 燃油车 怎么选",
            "电车 冬天 续航 衰减 真实体验",
            "没有固定车位 没有家充桩 电车 值得买吗",
            "电车 保值率 残值 三年 亏多少",
            "纯电 长途 高速 补能 体验",
        ],
    },
    {
        "qid": "q2",
        "title": "新能源车是省钱神器还是隐形坑？",
        "queries": [
            "电车 省钱 吗 用车成本 算账",
            "电车 隐形成本 保险 电池更换 贵",
            "家充桩 谷电 电费 一公里 多少钱",
            "网约车 跑车 纯电 回本",
        ],
    },
]

ORG_HINT = re.compile(r"(公司|官方|机构|研究院|实验室|集团|日报|周刊|传媒|工作室)")


def run_cli(args, timeout=120):
    p = subprocess.run([CLI, *args], capture_output=True, text=True,
                       encoding="utf-8", timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError(f"CLI 失败: {' '.join(args)}\n{p.stderr[:400]}")
    return json.loads(p.stdout)


def strip_em(s):
    """去掉搜索高亮标签，保留纯文本。"""
    return re.sub(r"</?em>", "", s or "").strip()


def guess_badge(badge_text, authority_level, author):
    """身份属性优先采用平台返回的真实字段，不做主观臆测。

    AuthorBadgeText: 平台认证信息（如「汽车话题下的优秀答主」）
    AuthorityLevel : 平台权威等级，数值越小越权威（实测 4 为普通）
    """
    bt = (badge_text or "").strip()
    if ORG_HINT.search(author or ""):
        return "org"
    if bt:                      # 有平台认证徽章 -> 权威
        return "authority"
    try:
        if authority_level is not None and int(authority_level) <= 2:
            return "authority"
    except (TypeError, ValueError):
        pass
    return "normal"


def collect(topic):
    seen, answers = set(), []
    for q in topic["queries"]:
        try:
            res = run_cli(["search", "zhihu", "--query", q, "--count", "10"])
        except Exception as e:
            print(f"  ! 关键词失败 {q}: {e}", file=sys.stderr)
            continue
        items = (res.get("Data") or {}).get("Items") or []
        for it in items:
            cid = str(it.get("ContentID") or "")
            text = strip_em(it.get("ContentText"))
            # 回答与文章都保留（两者都是知乎社区观点载体）；摘要过短无法支撑语义聚类
            if not cid or cid in seen:
                continue
            if it.get("ContentType") not in ("Answer", "Article"):
                continue
            if len(text) < 80:
                continue
            seen.add(cid)
            # AuthorName 实测可能为空，退回 AuthorSignature，再退回占位
            author = (strip_em(it.get("AuthorName"))
                      or strip_em(it.get("AuthorSignature"))
                      or "知乎用户")
            headline = strip_em(it.get("Headline"))
            badge_text = strip_em(it.get("AuthorBadgeText"))
            # 赞数：服务端字段为 VoteUpCount（字符串），缺失则为 None，绝不编造
            raw_up = it.get("VoteUpCount")
            try:
                up = int(raw_up) if raw_up not in (None, "") else None
            except (TypeError, ValueError):
                up = None
            answers.append({
                "id": f"{topic['qid']}-{cid[-10:].lstrip('-')}",
                "author": author,
                "headline": headline,
                "badge_text": badge_text,
                "badge": guess_badge(badge_text, it.get("AuthorityLevel"), author),
                "upvotes": up,
                "content_type": it.get("ContentType"),
                "text": text,
                "url": it.get("Url") or "",
                "title": strip_em(it.get("Title")),
                "query": q,
            })
    return answers


def main():
    out = {
        "meta": {
            "data_nature": "live_zhihu",
            "source": "知乎开放平台 CLI (zhihu-cli search zhihu)",
            "disclaimer": "本语料为知乎开放平台搜索接口返回的真实社区内容摘要（非完整正文）。"
                          "赞数字段仅在服务端提供时填充，缺失时为 null，不做任何补全或估算。"
                          "身份属性由答主签名启发式推断，不代表平台认证。",
        },
        "questions": [],
    }
    for t in TOPICS:
        print(f"[{t['qid']}] {t['title']}")
        ans = collect(t)
        print(f"    采集到 {len(ans)} 条去重回答")
        up_n = sum(1 for a in ans if a["upvotes"] is not None)
        print(f"    其中带赞数字段: {up_n}")
        out["questions"].append({
            "qid": t["qid"],
            "title": t["title"],
            "answer_count_display": len(ans),
            "answers": ans,
        })
    p = DATA / "corpus_live.json"
    p.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print("->", p)


if __name__ == "__main__":
    main()
