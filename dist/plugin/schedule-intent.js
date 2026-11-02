import { dayRange, doneToday, occursToday, repeatText } from "./schedule.js";
/** 去掉“记一下：”之后的部分；返回 null 表示这条消息不是新增日程 */
export function matchTrigger(text, word) {
    const trigger = word.trim();
    if (!trigger)
        return null;
    const trimmed = text.trim();
    // 允许前面带称呼：“秘书鱼，记一下…”“鱼鱼 记一下…” 也算
    const withoutAddress = trimmed.replace(/^(?:(?:秘书鱼|小秘书|鱼鱼|鱼|你)[，,：:、\s]*)+/, '');
    const target = withoutAddress.startsWith(trigger) ? withoutAddress : trimmed;
    if (!target.startsWith(trigger))
        return null;
    return target.slice(trigger.length).replace(/^[\s：:，,、]+/, '').trim();
}
const TIME_WORDS = /(今天|明天|后天|大后天|周[一二三四五六日天]|星期[一二三四五六日天]|下周|这周|本周|\d{1,2}\s*[月号]|\d{1,2}\s*点|\d{1,2}:\d{2}|今晚|明晚|早上|上午|中午|下午|晚上)/;
/** 话里有没有“时间”的痕迹；用来判断解析失败时该不该追问 */
export function looksLikeItHasTime(text) {
    return TIME_WORDS.test(text);
}
const QUERY_WORDS = /(安排|日程|待办|有什么事|要做什么|有什么要做)/;
/** “今天有什么安排” / “明天的日程” → 对应范围；不是查询就返回 null */
export function detectQuery(text) {
    const trimmed = text.trim();
    if (!QUERY_WORDS.test(trimmed))
        return null;
    const hasTimeWord = /(今天|今日|明天|明日|这周|本周|这星期|这个星期)/.test(trimmed);
    // 既没时间词也不是问句，就别当成查询（“帮我安排一下”不是查日程）
    if (!hasTimeWord && !/[吗呢？?]\s*$/.test(trimmed))
        return null;
    if (/(明天|明日)/.test(trimmed))
        return 'tomorrow';
    if (/(这周|本周|这星期|这个星期)/.test(trimmed))
        return 'week';
    if (/(今天|今日|现在)/.test(trimmed))
        return 'today';
    return 'today';
}
const DONE_WORDS = /(做完了|完成了|做完了|交了|搞定了|弄完了|办完了)$/;
/** “报告交了” → 报告；不是完成句就返回 null */
export function detectDone(text) {
    const trimmed = text.trim();
    if (!DONE_WORDS.test(trimmed))
        return null;
    const keyword = trimmed.replace(DONE_WORDS, '').replace(/[，,、\s]+$/, '').trim();
    // 太短的关键词容易误伤（比如“事了”），要求至少两个字
    if (keyword.length < 2)
        return null;
    return keyword;
}
/** 按标题模糊匹配待办；命中多条时返回全部，让调用方决定要不要追问 */
export function matchPending(items, keyword) {
    const needle = keyword.trim();
    if (!needle)
        return [];
    return items.filter((item) => {
        if (item.status !== 'pending')
            return false;
        if (item.repeat && doneToday(item))
            return false;
        return item.title.includes(needle) || needle.includes(item.title);
    });
}
// 完成语气：既认明确动词，也认“我到图书馆了”这种以“了/啦”收尾的叙述
const COMPLETION_CUE = /(已经|完成|做完|弄完|搞定|办完|交上|交了|写完|看完|问过|发过|弄好|做好|带了|送到|带到|买到|到了|到达|抵达|来到)/;
const ENDS_WITH_DONE = /(了|啦)\s*[。.!！]?$/;
// 将来时/否定会被误判成完成，先排除
const FUTURE_CUE = /(要|会|打算|准备|明天|后天|下次|待会|等会|还没|没|别)/;
function bigrams(text) {
    const clean = text.replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '').toLowerCase();
    const out = new Set();
    for (let index = 0; index < clean.length - 1; index++)
        out.add(clean.slice(index, index + 2));
    return out;
}
/**
 * 判断“这条消息是不是在报告某件事做完了”。
 *
 * 不能只认“交了/做完了”这类固定词——真实说法是“我木条已经带到学校了”。
 * 做法：先看有没有完成语气，再拿待办标题和消息做二元组重合度比较。
 * 重合不够就当作普通聊天，不硬猜。
 */
/** 只看标题重合的候选，不管语气——给“问模型”那条路用 */
export function completionCandidates(text, items) {
    const trimmed = text.trim();
    if (!trimmed)
        return [];
    const messageFeatures = bigrams(trimmed);
    const pending = items.filter((item) => item.status === 'pending');
    const scored = pending
        .map((item) => {
        const titleFeatures = bigrams(item.title);
        let shared = 0;
        for (const feature of titleFeatures)
            if (messageFeatures.has(feature))
                shared += 1;
        return { item, score: shared, need: Math.max(1, Math.ceil(titleFeatures.size * 0.3)) };
    })
        .filter((entry) => entry.score >= entry.need)
        .sort((a, b) => b.score - a.score);
    return scored.map(({ item, score }) => ({ item, score }));
}
export function detectCompletion(text, items) {
    const trimmed = text.trim();
    const explicit = COMPLETION_CUE.test(trimmed);
    const narrative = ENDS_WITH_DONE.test(trimmed) && !FUTURE_CUE.test(trimmed);
    if (!explicit && !narrative)
        return [];
    if (FUTURE_CUE.test(trimmed) && !explicit)
        return [];
    return completionCandidates(trimmed, items);
}
/** 疑问句不算完成报告（“图书馆你去吗？”） */
export function isQuestion(text) {
    return /[吗呢？?]\s*$/.test(text.trim());
}
export function rangeLabel(range) {
    return range === 'today' ? '今天' : range === 'tomorrow' ? '明天' : '这周';
}
function clockOf(item) {
    if (!item.due)
        return '无期限';
    const date = new Date(item.due);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
/** 一句话确认新增 */
export function formatAdded(item, note) {
    if (!item.due)
        return `记下了：${item.title}（${note ?? '无期限'}）`;
    const date = new Date(item.due);
    const day = `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
    return `记下了：${item.title} · ${day} ${clockOf(item)}${note ? `（${note}）` : ''}`;
}
/** 查询结果：没有就明说没有，别列空表 */
export function formatList(items, range) {
    const label = rangeLabel(range);
    const pending = items.filter((item) => item.status === 'pending');
    if (pending.length === 0)
        return `${label}没有安排。`;
    const lines = pending.map((item) => {
        if (item.repeat)
            return `· ${repeatText(item)} ${item.title}`;
        return `· ${item.due ? `${clockOf(item)} ` : ''}${item.title}`;
    });
    return `${label}有 ${pending.length} 件事：\n${lines.join('\n')}`;
}
export function itemsInRange(items, range) {
    const pending = items.filter((item) => item.status === 'pending');
    if (range === 'week') {
        return pending.filter((item) => {
            if (item.repeat) {
                // 重复习惯：未来 7 天内至少会命中一次
                if (item.repeat.kind === 'daily')
                    return !doneToday(item);
                return true;
            }
            if (!item.due)
                return false;
            const time = Date.parse(item.due);
            return time >= dayRange(0).start && time < dayRange(7).start;
        });
    }
    const offset = range === 'tomorrow' ? 1 : 0;
    const target = new Date();
    target.setDate(target.getDate() + offset);
    const { start, end } = dayRange(offset);
    return pending.filter((item) => {
        if (item.repeat)
            return occursToday(item, target) && !doneToday(item, target);
        if (!item.due)
            return false;
        const time = Date.parse(item.due);
        return time >= start && time < end;
    });
}
/**
 * 从“明天 / 后天 / 周三”这类词里推出日期，用作模型没给时间时的兜底。
 * 只到“天”这一级，时刻一律取当天 23:59。
 */
export function inferDueFromText(text, now = new Date()) {
    const base = new Date(now);
    base.setHours(23, 59, 0, 0);
    // 没说具体几点，但说了“早上/下午”这类时段，就按该时段的默认时刻
    const segments = [
        [/清晨|早上|早晨|上午/, 8, '早上'],
        [/中午|正午/, 12, '中午'],
        [/下午|午后/, 15, '下午'],
        [/傍晚|晚上|夜里|今晚|明晚/, 20, '晚上'],
    ];
    const segment = segments.find(([pattern]) => pattern.test(text));
    if (segment) {
        base.setHours(segment[1], 0, 0, 0);
    }
    const dayOffset = [
        [/明晚/, 1, '明天'],
        [/今晚/, 0, '今天'],
        [/大后天/, 3, '大后天'],
        [/后天/, 2, '后天'],
        [/明天|明日/, 1, '明天'],
        [/今天|今日/, 0, '今天'],
    ];
    for (const [pattern, offset, label] of dayOffset) {
        if (!pattern.test(text))
            continue;
        const date = new Date(base);
        date.setDate(date.getDate() + offset);
        return { date, label: segment ? `${label}${segment[2]}` : label };
    }
    const weekday = /(?:下)?(?:周|星期|礼拜)([一二三四五六日天])/.exec(text);
    if (weekday) {
        const names = '日一二三四五六';
        const target = names.indexOf(weekday[1]);
        if (target >= 0) {
            const date = new Date(base);
            let delta = (target - date.getDay() + 7) % 7;
            if (delta === 0)
                delta = 7;
            if (/^下/.test(weekday[0]))
                delta += 7;
            date.setDate(date.getDate() + delta);
            return { date, label: `${/^下/.test(weekday[0]) ? '下周' : '这周'}${weekday[1]}` };
        }
    }
    return null;
}
