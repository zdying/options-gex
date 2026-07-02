const logger = require('../utils/logger')('economicCalendarRegime');

const BASE_SCORE = 100;
const HARD_DEDUCTION = 40;
const SOFT_CAP = 25;
const TOTAL_CAP = 60;
const FINVIZ_URL = 'https://finviz.com/api/calendar/economic';

const HARD_RULES = [
  { key: 'nfp', label: 'NFP / Employment Block', words: ['non farm payrolls', 'nonfarm payrolls', 'unemployment rate', 'average hourly earnings', 'average weekly hours', 'government payrolls', 'manufacturing payrolls', 'participation rate', 'u-6 unemployment rate'] },
  { key: 'cpi', label: 'CPI Block', words: ['cpi', 'core cpi', 'consumer price index'] },
  { key: 'ppi', label: 'PPI Block', words: ['ppi', 'core ppi', 'producer price index'] },
  { key: 'fomc', label: 'FOMC Block', words: ['fomc', 'fed interest rate decision', 'fed rate decision', 'fomc statement', 'fed press conference'] }
];

const SOFT_RULES = [
  { key: 'adp', label: 'ADP Employment Change', points: 10, words: ['adp employment change'] },
  { key: 'ism', label: 'ISM', points: 15, words: ['ism manufacturing pmi', 'ism services pmi', 'ism manufacturing employment', 'ism manufacturing new orders', 'ism manufacturing prices', 'ism services employment', 'ism services prices'] },
  { key: 'fed_speech', label: 'Fed Speech', points: 15, words: ['fed chair', 'fed powell', 'fed warsh', 'fed waller', 'fed speech'] },
  { key: 'jolts_jobless', label: 'JOLTS / Jobless Claims', points: 10, words: ['jolts job openings', 'initial jobless claims', 'continuing jobless claims'] }
];

/** 获取当前美东日期，避免服务器本地时区影响交易日判断。 */
function getEstDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

/** 把 Date 格式化为 YYYY-MM-DD，用于 Finviz 参数和当天事件匹配。 */
function formatDate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** 计算当前美东周一到周五，Finviz 按这个区间一次返回一周经济日历。 */
function getWeekRange() {
  const today = getEstDate();
  const day = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() + (day === 0 ? -6 : 1 - day));
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  return { from: formatDate(monday), to: formatDate(friday), today: formatDate(today) };
}

/** 请求 Finviz 一周经济日历；不缓存，每次调用都重新请求。 */
async function fetchWeeklyEvents() {
  const range = getWeekRange();
  const url = `${FINVIZ_URL}?dateFrom=${range.from}&dateTo=${range.to}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Finviz calendar HTTP ${res.status}`);
  const events = await res.json();
  return { range, events: Array.isArray(events) ? events : [] };
}

/** 把事件名称和分类合并成小写文本，方便关键词匹配。 */
function textOf(event) {
  return `${event.event || ''} ${event.category || ''}`.toLowerCase();
}

/** 精简事件字段，只保留日志和前端排查需要的信息。 */
function pickEvent(event) {
  return {
    event: event.event || '',
    category: event.category || '',
    date: event.date || null,
    importance: Number(event.importance) || 0,
    actual: event.actual || null,
    forecast: event.forecast || null,
    previous: event.previous || null
  };
}

/** 判断某条规则在当天事件中命中了哪些行。 */
function matchRule(events, rule) {
  return events.filter(event => rule.words.some(word => textOf(event).includes(word)));
}

/** 传入一周事件和目标日期，计算当天经济日历扣分。 */
function evaluateEvents(events, targetDate) {
  const dayEvents = events.filter(event => String(event.date || '').slice(0, 10) === targetDate);
  const hardEvents = HARD_RULES.map(rule => ({ ...rule, events: matchRule(dayEvents, rule).map(pickEvent) })).filter(item => item.events.length);
  const hardKeys = new Set(hardEvents.map(item => item.key));
  const softEvents = SOFT_RULES
    .filter(rule => !(hardKeys.has('nfp') && rule.key === 'jolts_jobless'))
    .map(rule => ({ ...rule, events: matchRule(dayEvents, rule).map(pickEvent) }))
    .filter(item => item.events.length);

  const hardDeduction = Math.min(hardEvents.length * HARD_DEDUCTION, TOTAL_CAP);
  const softDeduction = Math.min(softEvents.reduce((sum, item) => sum + item.points, 0), SOFT_CAP, TOTAL_CAP - hardDeduction);
  const totalDeduction = Math.min(hardDeduction + softDeduction, TOTAL_CAP);
  const score = BASE_SCORE - totalDeduction;
  const reasons = [...hardEvents, ...softEvents].map(item => item.label);

  return {
    date: targetDate,
    score,
    totalDeduction,
    hardDeduction,
    softDeduction,
    reasons,
    hardEvents: hardEvents.map(({ key, label, events }) => ({ key, label, events })),
    softEvents: softEvents.map(({ key, label, points, events }) => ({ key, label, points, events })),
    events: dayEvents.map(pickEvent),
    message: hardEvents.length
      ? '重大事件前后，引力位可能快速失效。'
      : (softEvents.length ? '今日有重要事件，引力位需要结合盘面确认。' : '当前引力位参考性较高。')
  };
}

/** 无参数入口：模块自己取当前美东日期、请求 Finviz，并返回当天评分。 */
async function getCurrentRegime() {
  const range = getWeekRange();
  try {
    const result = evaluateEvents((await fetchWeeklyEvents()).events, range.today);
    logger.info(`[EconomicCalendar] ${range.from} to ${range.to}, today=${range.today}, events=${result.events.length}, score=${result.score}`);
    logger.info(`[EconomicCalendar] Hard: ${result.hardEvents.map(item => item.label).join(', ') || 'none'}; Soft: ${result.softEvents.map(item => item.label).join(', ') || 'none'}`);
    return result;
  } catch (err) {
    logger.error('[EconomicCalendar] Failed to evaluate current regime:', err.message);
    return {
      date: range.today,
      score: BASE_SCORE,
      totalDeduction: 0,
      hardDeduction: 0,
      softDeduction: 0,
      reasons: [],
      hardEvents: [],
      softEvents: [],
      events: [],
      message: '经济日历暂时不可用，引力位仅作观察。'
    };
  }
}

module.exports = {
  getCurrentRegime,
  evaluateEvents
};
