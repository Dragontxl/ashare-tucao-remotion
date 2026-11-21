# -*- coding: utf-8 -*-
"""Step 1：原始复盘文本 -> 犀利毒舌吐槽文稿 + 分镜 sentences.json。
优先调用 LLM（OpenAI 兼容接口）；无 API Key 时使用内置的确定性降级生成器。
"""
import os
import json
import re
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (ROOT, INPUT_DIR, SRC, CONFIG_DIR, load_config, save_config,
                    save_json, call_llm, extract_json, has_llm_key, llm_settings,
                    date8, cn_date_from_8, log)

VISUALS = ["hook", "title", "data", "punch", "topic", "text", "lesson", "outro"]
TONES = ["negative", "positive", "warn", "neutral"]

SYSTEM_PROMPT = """你是一名犀利毒舌、幽默风趣的A股财经吐槽博主，粉丝称你的节目为"盘面吐槽大会"。
你的风格：短句、有梗、节奏快、反讽尖锐、金句频出，但数据必须真实、不编造。
你会把枯燥的复盘数据变成让人又笑又心酸的口播稿。常使用的手法：反转、比喻、拟人、谐音、夸张对比。

你必须输出严格的 JSON（不要任何多余文字），结构如下：
{
  "article_title": "视频/文章标题，犀利有梗，10-16字",
  "hook_title": "开场主题大标题，如《如何优雅地亏钱》，4-10字",
  "date_label": "日期标签，如 11月20日",
  "market_mood": "市场情绪四字总结，如 极度冰点",
  "ticker": "底部滚动行情快讯文案，把原文中的关键指数/个股涨跌串成一行，用空格分隔，如：上证 3533.79 -1.22%  沪金 -6%  工商银行 +3%",
  "sentences": [
    {"id":1,"text":"口播文案（一句，20字以内最佳）","visual":"hook|title|data|punch|topic|text|lesson|outro","big":"大字（仅 data/title 需要，如 -1.41%）","label":"小标签（可选）","tone":"negative|positive|warn|neutral"}
  ]
}

规则：
1. 分镜 35-55 句，覆盖原文的：盘前预期、竞价、盘中走势、各板块表现、收盘数据、龙虎榜、后市建议。
2. visual 分配：开头1句 hook + 1句 title；板块介绍用 topic；关键数字用 data（必须填 big）；吐槽金句用 punch（text 要犀利）；过渡句用 text；结尾风险提示用 lesson 2-4句；最后一句 outro 引导点赞收藏。
3. 数据全部来自用户原文，禁止编造数字。
4. tone 遵循A股习惯：下跌/利空=negative，上涨/利好=positive，警示/反讽=warn，中性=neutral。
5. 每句 text 独立成句、口语化，适合配音朗读；不要出现 Markdown、括号注释、英文。
6. big 字段只放最核心的数字或短语，简短有力。"""


def generate_with_llm(cfg, article):
    run_date = os.environ.get("RUN_DATE") or date8()
    user = (f"日期上下文：{cn_date_from_8(run_date)}\n"
            f"以下是今日A股复盘原文，请据此生成毒舌吐槽口播稿：\n\n{article}")
    last_err = None
    for attempt in range(1, 3):
        try:
            reply = call_llm(cfg, SYSTEM_PROMPT, user, json_mode=True)
            data = extract_json(reply)
            return normalize(data, cfg)
        except Exception as e:  # noqa: BLE001
            last_err = e
            log(f"LLM 文稿解析失败（第 {attempt}/2 次）：{type(e).__name__} {e}")
            if attempt == 1:
                user += "\n\n重要：只输出一个合法 JSON 对象，不要 Markdown 代码围栏，不要任何解释文字。"
    raise last_err


def normalize(data, cfg):
    """校验/补全 LLM 输出，保证分镜结构合法。"""
    sentences = data.get("sentences") or []
    out = []
    for i, s in enumerate(sentences, 1):
        visual = s.get("visual", "text")
        if visual not in VISUALS:
            visual = "text"
        tone = s.get("tone", "neutral")
        if tone not in TONES:
            tone = "neutral"
        item = {"id": i, "text": str(s.get("text", "")).strip(),
                "visual": visual, "tone": tone}
        if s.get("big"):
            item["big"] = str(s["big"]).strip()
        if s.get("label"):
            item["label"] = str(s["label"]).strip()
        if not item["text"]:
            continue
        out.append(item)
    if not out:
        raise ValueError("LLM 未生成有效分镜")
    # 重新编号，保证连续
    for i, it in enumerate(out, 1):
        it["id"] = i
    # 确保有开头和结尾
    if out[0]["visual"] not in ("hook", "title"):
        out[0]["visual"] = "hook"
    out[-1]["visual"] = "outro"
    return {
        "article_title": data.get("article_title") or cfg.get("article_title", "盘面吐槽"),
        "hook_title": data.get("hook_title") or cfg.get("hook_title", "今天这盘面"),
        "date_label": data.get("date_label") or cfg.get("date_label", ""),
        "market_mood": data.get("market_mood") or cfg.get("market_mood", ""),
        "ticker": data.get("ticker") or cfg.get("ticker", ""),
        "sentences": out,
    }


def fallback_generate(cfg, article):
    """无 API Key 时的确定性降级生成器：基于规则把原文拆成吐槽分镜。"""
    log("未检测到 LLM API Key，使用内置降级生成器（质量低于 LLM，配置 API Key 可获得毒舌文稿）")
    # 抽句
    text = article.replace("\r", "")
    parts = re.split(r"(?<=[。！？；\n])", text)
    lines = [p.strip() for p in parts if p.strip() and len(p.strip()) > 4]
    # 去重、截断
    seen = set()
    uniq = []
    for ln in lines:
        ln = re.sub(r"[#=【】\[\]·—]{2,}", " ", ln).strip()
        if ln not in seen and len(ln) < 120:
            seen.add(ln)
            uniq.append(ln)
    if not uniq:
        uniq = [article[:100] or "今天A股又渡劫了。"]

    def tone_of(s):
        if any(k in s for k in ("跌", "崩", "亏", "跌停", "利空", "重挫", "下杀", "抛售")):
            return "negative"
        if any(k in s for k in ("涨", "反弹", "利好", "涨停", "拉升", "护盘", "回购")):
            return "positive"
        return "neutral"

    def visual_of(s, idx):
        if idx == 0:
            return "hook"
        if idx == 1:
            return "title"
        if idx == len(uniq) - 1:
            return "outro"
        if any(k in s for k in ("跌停", "跌", "涨", "%", "点", "亿", "连板", "成交")) and len(s) < 40:
            return "data"
        if idx % 4 == 0:
            return "punch"
        if idx % 5 == 0:
            return "topic"
        return "text"

    def big_of(s):
        m = re.search(r"(-?\d+\.?\d*\s*%|\d+\.?\d*\s*亿|\d+\s*连板|\d+\s*家)", s)
        return m.group(1) if m else ""

    sentences = []
    for i, ln in enumerate(uniq):
        visual = visual_of(ln, i)
        item = {"id": i + 1, "text": ln if len(ln) <= 40 else ln[:38] + "…",
                "visual": visual, "tone": tone_of(ln)}
        if visual == "data":
            b = big_of(ln)
            if b:
                item["big"] = b
                item["label"] = ln[:16]
        if visual == "topic":
            item["label"] = ln[:10].rstrip("，。")
        sentences.append(item)

    # 插入固定开场/金句/结尾
    head = [
        {"id": 1, "text": "家人们，今天这盘面又上演了一出好戏——", "visual": "hook", "tone": "neutral"},
        {"id": 2, "text": f"《{cfg.get('hook_title','如何优雅地亏钱')}》", "visual": "title",
         "big": cfg.get("hook_title", "如何优雅地亏钱"), "label": cfg.get("date_label", "今日复盘"), "tone": "warn"},
    ]
    tail = [
        {"text": "最后说句正经的：", "visual": "lesson", "tone": "neutral"},
        {"text": "数据不会骗人，情绪会。别急着抄底。", "visual": "lesson", "tone": "warn"},
        {"text": "活着，比什么都重要。", "visual": "punch", "tone": "warn"},
        {"text": "今天的吐槽就到这，点赞收藏，明天接着渡劫。", "visual": "outro", "tone": "neutral"},
    ]
    body = [s for s in sentences if s["visual"] not in ("hook", "title", "outro")]
    merged = head + body + tail
    for i, it in enumerate(merged, 1):
        it["id"] = i
    return {
        "article_title": cfg.get("article_title") or "今天这盘面输得很有节奏",
        "hook_title": cfg.get("hook_title") or "如何优雅地亏钱",
        "date_label": cfg.get("date_label") or "今日",
        "market_mood": cfg.get("market_mood") or "情绪冰点",
        "ticker": cfg.get("ticker") or "",
        "sentences": merged,
    }


def main():
    cfg = load_config()
    run_date = os.environ.get("RUN_DATE") or date8()
    # 期号与日期标签随运行日期自动更新（封面/角标使用）
    cfg["episode"] = "EP." + run_date[4:8]
    cfg["date_label"] = cn_date_from_8(run_date)

    article_path = os.environ.get("ARTICLE_PATH") or os.path.join(INPUT_DIR, "article.md")
    if not os.path.exists(article_path):
        raise FileNotFoundError(f"原始复盘文本不存在：{article_path}\n请放到 input/article.md 或先运行 fetch_article.py")
    with open(article_path, encoding="utf-8") as f:
        article = f.read()
    log(f"读取原始文本 {len(article)} 字：{article_path}")

    skip_llm = os.environ.get("SKIP_LLM", "").lower() in ("1", "true", "yes")
    use_llm = (not skip_llm) and has_llm_key(cfg)
    if use_llm:
        s = llm_settings(cfg)
        log(f"使用大模型：{s['model']} @ {s['base_url']}")
        try:
            result = generate_with_llm(cfg, article)
            log(f"LLM 生成成功：{len(result['sentences'])} 句分镜")
        except Exception as e:
            log(f"LLM 生成失败（{type(e).__name__}: {e}），回退到降级生成器")
            result = fallback_generate(cfg, article)
    else:
        result = fallback_generate(cfg, article)

    save_json(os.path.join(SRC, "sentences.json"), result["sentences"])
    # 把生成的元信息写回 config.json（供封面/简介/组件读取）
    for k in ("article_title", "hook_title", "date_label", "market_mood", "ticker"):
        if result.get(k):
            cfg[k] = result[k]
    save_config(cfg)
    log(f"文稿生成完成：{result['article_title']} | {len(result['sentences'])} 句")
    log("原始文稿已保存：src/sentences.json")


if __name__ == "__main__":
    main()
