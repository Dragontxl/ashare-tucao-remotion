/**
 * 镜头画面 -> 图表 的匹配逻辑（纯函数，便于单元测试）。
 *
 * 设计原则：
 * 1. 只有 data / text 场景才配图表；hook/title/punch/topic/lesson/outro
 *    保留各自版式，避免标题页、金句卡、风险提示被不相关的图表顶掉。
 * 2. 大模型显式指定的 chart 优先（generate_script.py 已做场景与文件名校验）。
 * 3. 个股图表最具体，其次才按加权关键词选择通用图表。
 * 4. 没有足够把握就不配图，宁可留白也不配错图（不再兜底 breadth）。
 */

export type ChartItem = {
  visual: string;
  text?: string;
  big?: string;
  label?: string;
  chart?: string;
};

export type StockRef = { name?: string; code?: string; file?: string };

export type ChartRule = { file: string; strong: string[]; weak: string[]; priority: number };

// strong 命中权重 3，weak 命中权重 1；priority 用于同分时优先选更具体的图
// （板块/个股/贵金属/外围/情绪 优先于宽基指数的分时/K线）
export const CHART_RULES: ChartRule[] = [
  {
    file: "charts/timeline.png",
    strong: ["分时", "分时图", "低开", "高开", "深V", "探底回升", "尾盘拉升", "尾盘跳水", "指数点位"],
    weak: ["开盘", "收盘", "指数", "反弹", "冲高", "回落"],
    priority: 1,
  },
  {
    file: "charts/kline.png",
    strong: ["日K", "K线", "下影线", "上影线", "二次探底", "技术面", "支撑位", "压力位", "均线"],
    weak: ["支撑", "压力", "技术"],
    priority: 1,
  },
  {
    file: "charts/global.png",
    strong: ["日经", "韩国", "台湾", "亚太", "港股", "美股", "道指", "纳指", "外围市场", "全球市场"],
    weak: ["全球", "外围"],
    priority: 2,
  },
  {
    file: "charts/gold.png",
    strong: ["黄金", "沪金", "沪银", "贵金属", "金价", "现货金", "白银"],
    weak: [],
    priority: 2,
  },
  {
    file: "charts/breadth.png",
    strong: ["涨跌家数", "上涨家数", "下跌家数", "涨停家数", "跌停家数", "炸板率", "赚钱效应", "连板家数"],
    weak: ["涨停", "跌停", "连板", "炸板", "情绪"],
    priority: 2,
  },
  {
    file: "charts/sectors.png",
    strong: ["板块涨跌", "板块分化", "行业涨跌", "个股涨跌", "板块表现", "资金流向"],
    weak: ["银行", "护盘", "板块", "ETF", "保险", "芯片", "机器人", "半导体", "光伏", "医药", "算力", "液冷", "光通信"],
    priority: 2,
  },
];

export function chartFiles(stocks: StockRef[] = []): string[] {
  return [
    "charts/timeline.png",
    "charts/kline.png",
    "charts/global.png",
    "charts/gold.png",
    "charts/sectors.png",
    "charts/breadth.png",
    ...stocks.filter((s) => s.file).map((s) => `charts/${s.file}`),
  ];
}

export function matchChart(item: ChartItem, stocks: StockRef[] = []): string | null {
  if (item.visual !== "data" && item.visual !== "text") return null;

  // 1. 大模型显式指定的图表优先
  if (item.chart && chartFiles(stocks).includes(item.chart)) return item.chart;

  const hay = `${item.label || ""} ${item.big || ""} ${item.text || ""}`;

  // 2. 个股图表最具体：取文字中出现位置最靠前的个股
  let stock: { file: string; pos: number } | null = null;
  for (const s of stocks) {
    for (const key of [s.name, s.code]) {
      if (!key) continue;
      const pos = hay.indexOf(key);
      if (pos >= 0 && (!stock || pos < stock.pos)) {
        stock = { file: `charts/${s.file}`, pos };
      }
    }
  }
  if (stock) return stock.file;

  // 3. 通用图表按加权得分选择；同分时优先更具体的板块/个股/贵金属图
  let bestFile: string | null = null;
  let bestScore = 0;
  let bestPriority = -1;
  for (const r of CHART_RULES) {
    let score = 0;
    for (const k of r.strong) if (hay.includes(k)) score += 3;
    for (const k of r.weak) if (hay.includes(k)) score += 1;
    if (score > 0 && (score > bestScore || (score === bestScore && r.priority > bestPriority))) {
      bestScore = score;
      bestFile = r.file;
      bestPriority = r.priority;
    }
  }
  // data 场景本身就在讲数字，命中一个关键词即可；text 场景要求更高把握
  const threshold = item.visual === "text" ? 2 : 1;
  return bestScore >= threshold ? bestFile : null;
}
