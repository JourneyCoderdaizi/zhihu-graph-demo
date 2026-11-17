#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
场景维度打分 — 本语料真实分歧轴的可解释表示

MVP 避坑结论：关键词立场三分类在"反驳式提及""条件句""政策陈述"上准确率
只有 ~75%，不足以作为布局主轴。本模块改用方案第 3 档的降级策略：
把立场降级为辅助标签，用 4 个可解释的场景维度作为分歧轴。

维度（每条回答给 -1 ~ +1 的倾向分）：
  charge   充电条件     有私桩(+) / 依赖公共桩(-)
  mileage  里程强度     高里程长途(+) / 低里程短途(-)
  horizon  持有周期     长期持有(+) / 短期换车(-)
  climate  气候友好度   温暖地区无影响(+) / 严寒衰减(-)

线上版本：这一层最适合用 LLM 批量结构化打标（单次 batch，离线完成），
本地实现用词典 + 句级反驳作用域作为无 API 环境下的等价替身。
"""
import re
import numpy as np

REFUTE = ["被严重放大", "被放大", "被高估", "被严重高估", "不用担心", "没必要担心",
          "是伪问题", "并不成立", "比大家以为的温和", "比大家想的", "没有任何悬念",
          "过时焦虑", "完全能", "足够支撑", "温和", "收窄"]

DIMS = {
    "charge": {
        "pos": ["有固定车位", "能装家充桩", "有私桩", "家充", "谷电", "分时电价",
                "晚上插枪", "早上满电", "私桩", "定时充电"],
        "neg": ["没桩", "没有私桩", "公共快充", "服务费", "排队", "老小区",
                "物业", "电容", "坏桩", "被油车占位", "可用率", "镇上排队"],
    },
    "mileage": {
        "pos": ["高里程", "年行驶", "八万公里", "日均", "网约车", "营运", "跑长途",
                "跨省", "三万公里", "35 万公里", "76800"],
        "neg": ["低里程", "通勤 18 公里", "每天通勤", "周末偶尔", "五千公里",
                "短途", "里程低", "低里程用户"],
    },
    "horizon": {
        "pos": ["开满十年", "十年", "长期持有", "全生命周期", "八年", "终身质保",
                "长期使用", "十年以上"],
        "neg": ["三年换车", "三年", "换车周期", "过保", "质保到期", "残值",
                "保值率", "二手", "转手", "折旧"],
    },
    "climate": {
        "pos": ["热泵", "电池自加热", "温暖", "南方", "深圳", "上海"],
        "neg": ["哈尔滨", "东北", "内蒙", "零下", "低温", "冬季续航", "严寒",
                "冬天", "衰减 35", "打折", "北方"],
    },
}


def score_dims(text):
    """返回 {dim: 倾向分(-1~1)}，句级反驳作用域内的信号取反。"""
    out = {}
    sents = [s for s in re.split(r"[。！？；\n]", text) if s.strip()]
    for dim, kw in DIMS.items():
        p = n = 0
        for s in sents:
            refuted = any(r in s for r in REFUTE)
            hp = sum(s.count(w) for w in kw["pos"])
            hn = sum(s.count(w) for w in kw["neg"])
            if refuted:
                p += hn      # 反驳负面信号 => 正向
                n += 0
            else:
                p += hp
                n += hn
        tot = p + n
        out[dim] = 0.0 if tot == 0 else round((p - n) / tot, 3)
    return out


def dim_matrix(texts):
    """场景维度矩阵 (n, 4)，作为可解释的分歧轴特征。"""
    rows = [score_dims(t) for t in texts]
    keys = list(DIMS.keys())
    M = np.array([[r[k] for k in keys] for r in rows], dtype=float)
    return M, keys, rows


def axis_summary(M, keys, labels, k):
    """给每个簇算维度均值，供前端生成可解释的簇描述。"""
    out = []
    for c in range(k):
        idx = np.where(labels == c)[0]
        out.append({keys[j]: round(float(M[idx, j].mean()), 3)
                    for j in range(len(keys))})
    return out


DIM_LABEL = {"charge": "充电条件", "mileage": "里程强度",
             "horizon": "持有周期", "climate": "气候友好"}
