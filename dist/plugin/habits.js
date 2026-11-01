import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from "../config.js";
export const HABIT_CATEGORIES = ['运动', '学习', '工作', '社交', '家务', '健康', '其他'];
/** 默认提前量（分钟）；单个习惯可以覆盖 */
export const DEFAULT_LEAD_MINUTES = 30;
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export function ruleText(rule) {
    if (rule.kind === 'daily')
        return `每天 ${rule.time}`;
    return `每${WEEKDAY_NAMES[rule.weekday ?? 0]} ${rule.time}`;
}
export function normalizeRule(value) {
    if (!value || typeof value !== 'object')
        return null;
    const raw = value;
    const kind = raw.kind === 'weekly' ? 'weekly' : raw.kind === 'daily' ? 'daily' : null;
    if (!kind)
        return null;
    const match = /^(\d{1,2}):(\d{1,2})$/.exec(String(raw.time ?? '').trim());
    if (!match)
        return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59)
        return null;
    const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    if (kind === 'daily')
        return { kind, time };
    const weekday = Number(raw.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)
        return null;
    return { kind, time, weekday };
}
function normalizeCategory(value) {
    return HABIT_CATEGORIES.includes(value) ? value : '其他';
}
function normalizeHabit(value) {
    if (!value || typeof value !== 'object')
        return null;
    const raw = value;
    const rule = normalizeRule(raw.rule);
    if (!rule)
        return null;
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    if (!label)
        return null;
    const lead = Number(raw.leadMinutes);
    return {
        id: typeof raw.id === 'string' && raw.id ? raw.id : `h_${Math.random().toString(36).slice(2, 8)}`,
        label: label.slice(0, 40),
        category: normalizeCategory(raw.category),
        rule,
        leadMinutes: Number.isFinite(lead) ? Math.min(180, Math.max(0, Math.round(lead))) : DEFAULT_LEAD_MINUTES,
        status: raw.status === 'active' || raw.status === 'dismissed' ? raw.status : 'candidate',
        source: raw.source === 'explicit' || raw.source === 'repeated' ? raw.source : 'inferred',
        evidence: {
            count: Number(raw.evidence?.count) || 0,
            weeks: Number(raw.evidence?.weeks) || 0,
            lastSeen: Number(raw.evidence?.lastSeen) || undefined,
        },
        afterAsk: raw.afterAsk !== false,
        askEstimate: raw.askEstimate === true,
        createdAt: Number(raw.createdAt) || Date.now(),
        lastSentOn: typeof raw.lastSentOn === 'string' ? raw.lastSentOn : undefined,
        lastAfterAskOn: typeof raw.lastAfterAskOn === 'string' ? raw.lastAfterAskOn : undefined,
    };
}
function bigrams(text) {
    const clean = text.replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '').toLowerCase();
    const out = new Set();
    for (let index = 0; index < clean.length - 1; index++)
        out.add(clean.slice(index, index + 2));
    return out;
}
/** 标题相似度 0–1；用来判断两件事是不是同一件 */
export function titleSimilarity(a, b) {
    const left = bigrams(a);
    const right = bigrams(b);
    if (left.size === 0 || right.size === 0)
        return a === b ? 1 : 0;
    let shared = 0;
    for (const feature of left)
        if (right.has(feature))
            shared += 1;
    return shared / Math.min(left.size, right.size);
}
function weekdayOf(date) {
    return date.getDay();
}
function hoursOf(item) {
    if (!item.due)
        return null;
    return new Date(item.due).getHours();
}
/**
 * 从日程里发现习惯：
 *   1. 显式重复项 → 直接成为 active（你自己说过“每周三去滑冰”）
 *   2. 同一件事、同一个星期几，出现 ≥3 次且跨 ≥3 周 → candidate，等你确认
 */
export function discoverHabits(items, existing) {
    const known = new Set(existing.map((habit) => `${habit.label}|${habit.rule.kind}|${habit.rule.time}|${habit.rule.weekday ?? ''}`));
    const found = [];
    for (const item of items) {
        if (!item.repeat)
            continue;
        const time = item.repeat.time;
        const weekday = item.repeat.weekday;
        const key = `${item.title}|${item.repeat.kind}|${time}|${weekday ?? ''}`;
        if (known.has(key))
            continue;
        known.add(key);
        found.push({
            label: item.title,
            rule: { kind: item.repeat.kind, time, weekday },
            source: 'explicit',
            status: 'active',
            afterAsk: true,
            askEstimate: item.repeat.kind === 'daily' && /作业|学习|复习|背单词/.test(item.title),
        });
    }
    const groups = [];
    for (const item of items) {
        if (item.repeat || !item.due || item.status === 'done')
            continue;
        const date = new Date(item.due);
        const hour = date.getHours();
        const day = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
        const matched = groups.find((group) => group.weekday === date.getDay() && group.hour === hour && titleSimilarity(group.label, item.title) >= 0.5);
        if (matched) {
            matched.dates.add(day);
        }
        else {
            groups.push({ label: item.title, weekday: date.getDay(), hour, dates: new Set([day]) });
        }
    }
    for (const group of groups) {
        if (group.dates.size < 3)
            continue;
        const time = `${String(group.hour).padStart(2, '0')}:00`;
        const key = `${group.label}|weekly|${time}|${group.weekday}`;
        if (known.has(key))
            continue;
        known.add(key);
        found.push({
            label: group.label,
            rule: { kind: 'weekly', time, weekday: group.weekday },
            source: 'repeated',
            status: 'candidate',
            afterAsk: true,
            askEstimate: false,
        });
    }
    return found;
}
export function createHabitStore(baseDir) {
    const dir = baseDir ?? path.join(homeDir(), 'memory');
    const file = path.join(dir, 'habits.json');
    function read() {
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!Array.isArray(parsed.items))
                return [];
            return parsed.items.map(normalizeHabit).filter((habit) => habit !== null);
        }
        catch {
            return [];
        }
    }
    function write(items) {
        try {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            const tmp = `${file}.tmp-${process.pid}`;
            fs.writeFileSync(tmp, `${JSON.stringify({ items }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(tmp, file);
        }
        catch {
            /* ignore */
        }
    }
    return {
        file,
        list: () => read(),
        add(input) {
            const rule = normalizeRule(input.rule);
            if (!rule)
                throw new Error('习惯的时间不合法');
            const habit = {
                id: `h_${Math.random().toString(36).slice(2, 8)}`,
                label: input.label.trim().slice(0, 40),
                category: normalizeCategory(input.category),
                rule,
                leadMinutes: Number.isFinite(Number(input.leadMinutes)) && input.leadMinutes !== undefined
                    ? Math.min(180, Math.max(0, Math.round(Number(input.leadMinutes))))
                    : DEFAULT_LEAD_MINUTES,
                status: input.status ?? 'candidate',
                source: input.source ?? 'explicit',
                evidence: { count: 0, weeks: 0 },
                afterAsk: input.afterAsk !== false,
                askEstimate: input.askEstimate === true,
                createdAt: Date.now(),
            };
            write([...read(), habit]);
            return habit;
        },
        update(id, patch) {
            const items = read();
            const index = items.findIndex((habit) => habit.id === id);
            if (index < 0)
                return null;
            const next = { ...items[index], ...patch, id: items[index].id };
            if (patch.rule) {
                const rule = normalizeRule(patch.rule);
                if (rule)
                    next.rule = rule;
            }
            if (patch.category)
                next.category = normalizeCategory(patch.category);
            if (patch.leadMinutes !== undefined) {
                next.leadMinutes = Number.isFinite(Number(patch.leadMinutes))
                    ? Math.min(180, Math.max(0, Math.round(Number(patch.leadMinutes))))
                    : items[index].leadMinutes;
            }
            items[index] = next;
            write(items);
            return next;
        },
        remove(id) {
            const items = read();
            const next = items.filter((habit) => habit.id !== id);
            if (next.length === items.length)
                return false;
            write(next);
            return true;
        },
        upsertCandidate(input) {
            const items = read();
            const rule = normalizeRule(input.rule);
            if (!rule)
                return null;
            const exists = items.some((habit) => habit.label === input.label.trim() &&
                habit.rule.kind === rule.kind &&
                habit.rule.time === rule.time &&
                (habit.rule.weekday ?? -1) === (rule.weekday ?? -1));
            if (exists)
                return null;
            const habit = {
                id: `h_${Math.random().toString(36).slice(2, 8)}`,
                label: input.label.trim().slice(0, 40),
                category: normalizeCategory(input.category),
                rule,
                leadMinutes: input.leadMinutes ?? DEFAULT_LEAD_MINUTES,
                status: input.status ?? 'candidate',
                source: input.source ?? 'inferred',
                evidence: { count: 0, weeks: 0, lastSeen: Date.now() },
                afterAsk: input.afterAsk !== false,
                askEstimate: input.askEstimate === true,
                createdAt: Date.now(),
            };
            write([...items, habit]);
            return habit;
        },
        markSent(id, dateKey) {
            const items = read();
            const index = items.findIndex((habit) => habit.id === id);
            if (index < 0)
                return;
            items[index] = { ...items[index], lastSentOn: dateKey };
            write(items);
        },
        markAfterAsk(id, dateKey) {
            const items = read();
            const index = items.findIndex((habit) => habit.id === id);
            if (index < 0)
                return;
            items[index] = { ...items[index], lastAfterAskOn: dateKey };
            write(items);
        },
    };
}
/**
 * 现在有哪些习惯该动了。纯函数，方便测试，也把调度判断从 runtime 里拆出来。
 * 返回的每一条都还没标记为“已发”，由调用方决定发不发、发完再 mark。
 */
export function habitsDue(habits, now, todayKey) {
    const current = now.getHours() * 60 + now.getMinutes();
    const due = [];
    for (const habit of habits) {
        if (habit.status !== 'active')
            continue;
        if (habit.rule.kind === 'weekly' && habit.rule.weekday !== now.getDay())
            continue;
        const [hour, minute] = habit.rule.time.split(':').map(Number);
        const startAt = hour * 60 + minute;
        const remindAt = startAt - habit.leadMinutes;
        if (current >= remindAt && current < remindAt + 60 && habit.lastSentOn !== todayKey) {
            due.push({ habit, phase: 'remind' });
            continue;
        }
        if (habit.afterAsk &&
            current >= startAt + 60 &&
            current < startAt + 180 &&
            habit.lastAfterAskOn !== todayKey) {
            due.push({ habit, phase: 'after' });
        }
    }
    return due;
}
