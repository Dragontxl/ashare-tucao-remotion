# -*- coding: utf-8 -*-
"""Step 2a：从 timeline.json 中自动提取股票名称，补入 config.stocks。

扫描分镜的 text 字段，提取连续中文片段作为候选股票名，
用新浪搜索接口（suggest3.sinajs.cn）匹配股票代码，
将新发现的股票追加到 config.stocks（不覆盖已有配置）。

这样后续 fetch_market_data.py 能抓取行情，make_charts.py 能生成个股图表，
StockVideo.tsx 的 matchChart 能将 text 场景中的股票名匹配到对应图表。

用法：
  python scripts/extract_stocks.py          # 扫描并补入股票
  python scripts/extract_stocks.py --dry   # 只扫描不写入
"""
import argparse
import os
import re
import sys
import json
import time
import urllib.request
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import SRC, load_config, save_config, load_json, log

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

# 停用词：这些词即使被拆分出来也不是股票名，直接过滤
STOP_WORDS = {
    "涨停", "跌停", "板块", "资金", "指数", "市场", "个股", "机构", "游资",
    "主力", "散户", "情绪", "方向", "主线", "龙头", "高位", "低位", "放量",
    "缩量", "突破", "回踩", "支撑", "压力", "成交", "涨幅", "跌幅", "上涨",
    "下跌", "封单", "竞价", "开盘", "收盘", "尾盘", "盘面", "复盘", "概念",
    "连板", "炸板", "飘红", "净流入", "净流出", "赚钱效应", "整数关口", "前高",
    "抄底", "避雷", "追高", "谨慎", "建议", "点赞", "关注", "银行", "光伏",
    "医药", "算力", "硬件", "半导体", "光通信", "液冷", "黄金", "贵金属",
    "股票", "证券", "大盘", "沪深", "深证", "上证", "创业板", "科创板",
    "证伪", "新股", "旧股", "牛股", "妖股", "黑马", "白马", "权重", "题材",
    "热点", "风口", "轮动", "补涨", "回调", "反弹", "探底", "冲高", "回落",
    "光头", "阳线", "阴线", "十字", "量能", "量增", "量缩",
    "封板", "开板", "破板", "回封",
    "A股", "H股", "美股", "港股", "中概", "富时", "道指", "纳指",
    "英伟达", "科技", "硬件",
    "全封板", "封单", "封死",
    "翻倍", "增倍", "同增", "同比",
    "集体", "集体发疯", "没人", "没人爱", "没人理",
    "可以", "别慌", "别去", "别碰", "注意", "小心",
    "依然", "还是", "结果", "这时候", "这时候",
    "点赞关注", "下周一见", "不构成", "仅为",
    "内容", "行情", "走势", "后市", "市看",
    "新高", "新低", "冲高", "探底", "回落",
    "市场情绪", "板块涨停", "批量涨停",
    "严重", "明显", "急剧", "瞬间", "还在",
    "抢筹", "抢算力", "抢糖", "发糖",
    "批量", "全线", "全线飘红",
    "今天", "明天", "昨天", "后天",
    "看医", "看医药",
    "光伏银行",
}

# 中文字符范围（用于校验候选名）
CJK_RE = re.compile(r'^[\u4e00-\u9fff]+$')


def search_stock(name, cache=None):
    """用新浪搜索接口匹配股票代码。

    返回 (code, std_name) 或 None。
    code 格式：sh600000 / sz000001 等。
    """
    if cache is not None and name in cache:
        return cache[name]
    # type=11 返回股票/基金等，格式：var suggestvalue="名称,11,数字代码,sh/sz代码,名称,..."
    url = f"http://suggest3.sinajs.cn/suggest/?key={urllib.parse.quote(name)}&type=11"
    try:
        req = urllib.request.Request(url, headers=UA)
        raw = urllib.request.urlopen(req, timeout=10).read().decode("gbk", errors="ignore")
        # 解析 var suggestvalue="...";
        m = re.search(r'suggestvalue\s*=\s*"([^"]*)"', raw)
        if not m:
            result = None
        else:
            fields = m.group(1).split(",")
            # field[3] = sh600183 / sz002156 等
            market_code = fields[3] if len(fields) > 3 else ""
            if re.match(r'^(sh|sz)\d{6}$', market_code):
                std_name = fields[0] if fields[0] else name
                result = (market_code, std_name)
            else:
                result = None
        if cache is not None:
            cache[name] = result
        return result
    except Exception:
        if cache is not None:
            cache[name] = None
        return None


def extract_candidates(timeline_data):
    """从 timeline.json 的 items 中提取候选股票名。

    策略：
      1. 提取所有连续中文字符段
      2. 长度 2-6 的整段直接作为候选
      3. 长度 > 6 的段，额外提取所有 2-4 字子串（多数股票名 2-4 字）
      4. 过滤停用词及停用词的子串（如"伟达"是停用词"英伟达"的子串）
    """
    candidates = set()
    items = timeline_data.get("items", [])
    for scene in items:
        text = scene.get("text", "")
        if not text:
            continue
        # 提取所有连续中文字符段
        runs = re.findall(r'[\u4e00-\u9fff]+', text)
        for run in runs:
            if len(run) < 2:
                continue
            candidates_for_run = []
            if 2 <= len(run) <= 6:
                candidates_for_run.append(run)
            if len(run) > 6:
                # 长段：尝试所有 2-4 字子串
                for start in range(len(run) - 1):
                    for length in (2, 3, 4):
                        sub = run[start:start + length]
                        if len(sub) < 2:
                            break
                        candidates_for_run.append(sub)
            for cand in candidates_for_run:
                if cand in STOP_WORDS:
                    continue
                # 过滤停用词的子串（如"伟达"是"英伟达"的子串）
                if any(cand in sw and cand != sw for sw in STOP_WORDS):
                    continue
                candidates.add(cand)
    return candidates


def main():
    ap = argparse.ArgumentParser(description="从 timeline.json 自动提取股票名称")
    ap.add_argument("--dry", action="store_true", help="只扫描不写入配置")
    args = ap.parse_args()

    cfg = load_config()
    timeline_path = os.path.join(SRC, "timeline.json")
    timeline_data = load_json(timeline_path)
    if not timeline_data:
        log("未找到 timeline.json，跳过股票提取")
        return 0

    candidates = extract_candidates(timeline_data)
    log(f"从 timeline.json 发现 {len(candidates)} 个候选名称")

    # 已配置的股票名称集合
    existing_stocks = cfg.get("stocks", [])
    existing_names = {s.get("name") for s in existing_stocks}

    cache = {}
    new_stocks = []
    for name in sorted(candidates):
        if name in existing_names:
            continue
        result = search_stock(name, cache)
        if result:
            code, std_name = result
            if std_name in existing_names:
                continue
            file_name = f"stock_{code}.png"
            new_stock = {
                "code": code,
                "name": std_name,
                "file": file_name,
                "label": "",
            }
            new_stocks.append(new_stock)
            existing_names.add(std_name)
            log(f"  匹配：{name} → {std_name}（{code}）")
        else:
            log(f"  未匹配：{name}")

    if new_stocks and not args.dry:
        cfg["stocks"] = list(existing_stocks) + new_stocks
        save_config(cfg)
        log(f"已追加 {len(new_stocks)} 只股票到 config.stocks（图表文件名：{', '.join(s['file'] for s in new_stocks)}）")
    elif new_stocks and args.dry:
        log(f"[DRY] 将追加 {len(new_stocks)} 只股票（未写入）")
    else:
        log("没有新发现的股票，无需更新配置")

    return 0


if __name__ == "__main__":
    sys.exit(main())
