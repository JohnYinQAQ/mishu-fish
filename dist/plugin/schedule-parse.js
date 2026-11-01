import { salvageField } from "./digest.js";
import { normalizeRepeat } from "./schedule.js";
const PARSE_TIMEOUT_MS = 30_000;
function weekdayOf(date) {
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()] ?? '';
}
async function callModel(llm, route, system, user) {
    const signal = AbortSignal.timeout(PARSE_TIMEOUT_MS);
    let text = '';
    let failure = '';
    const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
        temperature: 0,
        maxTokens: 300,
        signal,
    });
    for await (const chunk of stream) {
        const value = (chunk ?? {});
        if (value.type === 'finish') {
            const reason = (value.reason ?? {});
            if (reason.kind === 'error') {
                const fail = (reason.failure ?? {});
                failure = [fail.code, fail.message].filter(Boolean).join(': ') || '模型调用失败';
            }
        }
        if (value.type === 'text-delta' && typeof value.text === 'string')
            text += value.text;
    }
    if (failure)
        throw new Error(failure);
    return text.trim();
}
/** 从模型输出里取出 {title, due}；容忍代码块和多余文字 */
export function parseScheduleResult(raw) {
    const cleaned = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
    let title = '';
    let due = null;
    let repeat = null;
    try {
        const value = JSON.parse(cleaned);
        title = typeof value.title === 'string' ? value.title.trim() : '';
        due = value.due;
        repeat = value.repeat;
    }
    catch {
        title = salvageField(cleaned, 'title');
        due = salvageField(cleaned, 'due');
        try {
            repeat = JSON.parse(salvageField(cleaned, 'repeat') || 'null');
        }
        catch {
            repeat = null;
        }
    }
    if (!title)
        return null;
    const rule = normalizeRepeat(repeat);
    const dueText = typeof due === 'string' ? due.trim() : '';
    // 没有时区标记时按“本地时间”解析（模型常写 07:00Z，那会变成凌晨）；
    // 明确带了 Z / 偏移的就按绝对值走。
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(dueText);
    const local = hasZone ? null : /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(dueText);
    const time = local
        ? new Date(Number(local[1]), Number(local[2]) - 1, Number(local[3]), Number(local[4]), Number(local[5])).getTime()
        : dueText
            ? Date.parse(dueText)
            : Number.NaN;
    return {
        title: title.slice(0, 60),
        due: rule ? null : Number.isNaN(time) ? null : new Date(time).toISOString(),
        repeat: rule,
    };
}
/**
 * 把“周五交报告”解析成 {title, due}。
 *
 * 时间要靠模型是因为自然语言太花（周五/下周三/月底/今晚八点），
 * 但**解析失败绝不猜**：due 拿不到就是 null，由调用方决定要不要追问。
 */
export async function parseScheduleText(llm, route, text, options = {}) {
    const now = options.now ?? new Date();
    const offsetMinutes = -now.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const offset = `${sign}${String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0')}:${String(Math.abs(offsetMinutes) % 60).padStart(2, '0')}`;
    const system = [
        '你是一个日程解析器。把用户这句话拆成“做什么”和“什么时候”。只输出 JSON，不要解释，不要代码块：',
        '{"title": "要做的事", "due": "YYYY-MM-DDTHH:mm（本地时间，不要写 Z 或时区偏移）或 null", "repeat": null}',
        '',
        '规则：',
        `1. 现在是 ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${weekdayOf(now)} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}，时区偏移 ${offset}。`,
        '2. “周五”“下周三”这类相对说法要换算成具体日期；只说日期没说时刻，用当天 23:59。',
        '3. “下午三点”写成 15:00；“今晚”写成当天 20:00。',
        '4. 用户完全没提时间时，due 必须是 null，不要编一个时间。',
        '5. title 要精简：去掉“记一下”“提醒我”这类指令词，只留事情本身，不超过 20 个字。',
        '6. 拿不准的具体时间宁可给 null，也不要猜。',
        '7. 如果这是**重复习惯**（每天 / 每周几），repeat 写成 {"kind":"daily"|"weekly","time":"HH:mm","weekday":0-6}，同时 due 必须是 null。',
        '   · “每天 22:00 写作业” → {"kind":"daily","time":"22:00"}；',
        '   · “每周三 15:00 开会” → {"kind":"weekly","time":"15:00","weekday":3}；',
        '   · weekday 用 0=周日、1=周一 … 6=周六。',
        '8. 一次性的事 repeat 必须是 null。',
    ].join('\n');
    const raw = await callModel(llm, route, system, text);
    return parseScheduleResult(raw);
}
/** 解析“是不是在报告完成”的判定结果；解析不出来就当否 */
export function parseCompletionVerdict(raw) {
    const cleaned = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
    try {
        const value = JSON.parse(cleaned);
        return value.done === true;
    }
    catch {
        return /"done"\s*:\s*true/.test(cleaned);
    }
}
/**
 * 语气不明但标题对得上时，问模型一句“这是在报告完成吗”。
 * 只在有候选时调用，平时不花钱。
 */
export async function classifyCompletion(llm, route, text, titles) {
    const system = [
        '你在判断一句话是不是在“报告某件事已经做完了”。只输出 JSON，不要解释：',
        '{"done": true} 或 {"done": false}',
        '',
        '规则：',
        '1. 将来时、计划、打算（要 / 会 / 准备 / 明天）→ false',
        '2. 疑问、否定（吗 / 要不要 / 没 / 还没）→ false',
        '3. 描述已经发生、已经到达、已经完成的动作 → true',
        '4. 只是提到这件事、评价这件事，没说做完 → false',
    ].join('\n');
    const user = [`候选待办：`, ...titles.map((title) => `- ${title}`), '', `这句话：「${text}」`].join('\n');
    const raw = await callModel(llm, route, system, user);
    return parseCompletionVerdict(raw);
}
export function parseScheduleIntent(raw) {
    const cleaned = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
    try {
        const value = JSON.parse(cleaned);
        if (value.schedule !== true)
            return { isSchedule: false };
        const title = typeof value.title === 'string' ? value.title.trim() : '';
        if (!title)
            return { isSchedule: false };
        const rule = normalizeRepeat(value.repeat);
        const due = typeof value.due === 'string' ? value.due.trim() : '';
        const local = !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(due) ? /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(due) : null;
        const time = local
            ? new Date(Number(local[1]), Number(local[2]) - 1, Number(local[3]), Number(local[4]), Number(local[5])).getTime()
            : due
                ? Date.parse(due)
                : Number.NaN;
        return {
            isSchedule: true,
            title: title.slice(0, 60),
            due: rule ? null : Number.isNaN(time) ? null : new Date(time).toISOString(),
            repeat: rule,
        };
    }
    catch {
        return { isSchedule: false };
    }
}
/**
 * 没设触发词时，判断这句话是不是在“让我记一件事”。
 * 只在自动模式下调用，每条消息一次。
 */
export async function detectScheduleIntent(llm, route, text, options = {}) {
    const now = options.now ?? new Date();
    const system = [
        '你在判断：用户这句话是不是在“让秘书记住一件要做的/安排了的事”。只输出 JSON，不要解释：',
        '{"schedule": true, "title": "要做的事", "due": "YYYY-MM-DDTHH:mm（本地时间，不要 Z）或 null", "repeat": null}',
        '或 {"schedule": false}',
        '',
        '是（schedule=true）的例子：',
        '· “我明天下午三点要去医院”·“周五之前得把报告交了”·“记得提醒我买牛奶”',
        '不是（schedule=false）的例子：',
        '· 闲聊、吐槽、情绪：“今天好累”“烦死了”',
        '· 提问：“这个题怎么做”',
        '· 评价、复述：“那挺好的”',
        '· 已经在做了的事：“我在写作业”',
        '',
        `现在是 ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}。`,
        '拿不准就返回 {"schedule": false}——宁可漏记，也不要乱记。',
    ].join('\n');
    const raw = await callModel(llm, route, system, text);
    return parseScheduleIntent(raw);
}
export function parseHabitMention(raw) {
    const cleaned = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
    try {
        const value = JSON.parse(cleaned);
        if (value.habit !== true)
            return null;
        const label = typeof value.label === 'string' ? value.label.trim() : '';
        const rule = normalizeRepeat(value.rule);
        if (!label || !rule)
            return null;
        return { label: label.slice(0, 40), rule };
    }
    catch {
        return null;
    }
}
/**
 * 从聊天里认出“每周三 17:00 去滑冰”这类周期性安排。
 * 只在句子里出现“每 / 星期几 / 每天”时才调用，平时不花这个钱。
 */
export async function detectHabitMention(llm, route, text, options = {}) {
    const now = options.now ?? new Date();
    const system = [
        '判断这句话是不是在说“某个周期性安排”。只输出 JSON，不要解释：',
        '{"habit": true, "label": "滑冰", "rule": {"kind":"weekly","time":"17:00","weekday":3}}',
        '或 {"habit": false}',
        '',
        '规则：',
        '1. 只在明确是周期性安排时才算：每周三、每天、每个周末、星期二这种。',
        '2. 一次性的安排（明天下午三点）返回 false。',
        '3. time 用 24 小时制 HH:mm；没说时刻就用 09:00，并在 label 里保留原文。',
        '4. weekday：0=周日、1=周一 … 6=周六。',
        '5. label 只写这件事本身，不超过 12 个字。',
        `现在是 ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}。`,
        '拿不准就返回 {"habit": false}。',
    ].join('\n');
    const raw = await callModel(llm, route, system, text);
    return parseHabitMention(raw);
}
function parseLocalDue(dueText) {
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(dueText);
    const local = hasZone ? null : /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(dueText);
    if (local) {
        return new Date(Number(local[1]), Number(local[2]) - 1, Number(local[3]), Number(local[4]), Number(local[5])).getTime();
    }
    return dueText ? Date.parse(dueText) : Number.NaN;
}
export function parseMessageIntent(raw) {
    const cleaned = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
    try {
        const value = JSON.parse(cleaned);
        if (value.kind === 'habit') {
            const label = typeof value.label === 'string' ? value.label.trim() : '';
            const rule = normalizeRepeat(value.rule);
            if (label && rule)
                return { kind: 'habit', label: label.slice(0, 40), rule };
            return { kind: 'chat' };
        }
        if (value.kind === 'schedule') {
            const title = typeof value.title === 'string' ? value.title.trim() : '';
            if (!title)
                return { kind: 'chat' };
            const rule = normalizeRepeat(value.repeat);
            const dueText = typeof value.due === 'string' ? value.due.trim() : '';
            const time = parseLocalDue(dueText);
            return {
                kind: 'schedule',
                title: title.slice(0, 60),
                due: rule ? null : Number.isNaN(time) ? null : new Date(time).toISOString(),
                repeat: rule,
            };
        }
        return { kind: 'chat' };
    }
    catch {
        return { kind: 'chat' };
    }
}
/**
 * 一句话三分类：一次性日程 / 周期性习惯 / 闲聊。
 * 合并成一次调用，避免“日程判断”和“习惯判断”各花一次钱。
 */
export async function detectMessageIntent(llm, route, text, options = {}) {
    const now = options.now ?? new Date();
    const system = [
        '把用户这句话分成三类之一。只输出 JSON，不要解释。',
        '',
        '1) 一次性安排：{"kind":"schedule","title":"要做的事","due":"YYYY-MM-DDTHH:mm（本地时间，不要 Z）或 null","repeat":null}',
        '2) 周期性安排：{"kind":"habit","label":"滑冰","rule":{"kind":"weekly","time":"17:00","weekday":3}}',
        '3) 都不是：{"kind":"chat"}',
        '',
        '怎么分：',
        '· “我明天下午三点去医院”“周五前把报告交了”“记得提醒我买牛奶” → schedule',
        '· “每周三下午五点去滑冰”“每天六点跑步”“每隔一天练琴” → habit',
        '· 闲聊、吐槽、提问、评价、正在做的事（“我在写作业”）→ chat',
        '· 拿不准 → chat。宁可漏记，也不要乱记。',
        '',
        '字段要求：',
        '· due 用本地时间，不要写 Z；没说时刻就用 null。',
        '· habit 的 time 用 24 小时制；没说时刻就用 09:00。',
        '· weekday：0=周日、1=周一 … 6=周六。',
        '· label 只写事情本身，不超过 12 个字。',
        `现在是 ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}。`,
    ].join('\n');
    const raw = await callModel(llm, route, system, text);
    return parseMessageIntent(raw);
}
