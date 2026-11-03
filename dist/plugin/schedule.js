import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from "../config.js";
function newId() {
    return `s_${Math.random().toString(36).slice(2, 8)}`;
}
function cleanTitle(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.slice(0, 60);
}
/** 只接受能解析成时间的字符串；空串 / 非法值都变成 null（无期限） */
export function normalizeDue(value) {
    if (typeof value !== 'string' || !value.trim())
        return null;
    const time = Date.parse(value);
    if (Number.isNaN(time))
        return null;
    return new Date(time).toISOString();
}
/** 校验重复规则：时间必须是 HH:MM，weekday 必须是 0–6 */
export function normalizeRepeat(value) {
    if (!value || typeof value !== 'object')
        return null;
    const raw = value;
    const kind = raw.kind === 'weekly' ? 'weekly' : raw.kind === 'daily' ? 'daily' : null;
    if (!kind)
        return null;
    const time = typeof raw.time === 'string' ? raw.time.trim() : '';
    if (!/^\d{1,2}:\d{1,2}$/.test(time))
        return null;
    const [hour, minute] = time.split(':').map(Number);
    if (hour > 23 || minute > 59)
        return null;
    const clock = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    if (kind === 'daily')
        return { kind, time: clock };
    const weekday = Number(raw.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)
        return null;
    return { kind, time: clock, weekday };
}
export function todayKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
/** 这条重复习惯今天该不该做 */
export function occursToday(item, date = new Date()) {
    if (!item.repeat)
        return false;
    if (item.repeat.kind === 'daily')
        return true;
    return item.repeat.weekday === date.getDay();
}
/** 今天是否已经完成过（重复习惯用 lastDoneOn 判断） */
export function doneToday(item, date = new Date()) {
    if (!item.repeat)
        return item.status === 'done';
    return item.lastDoneOn === todayKey(date);
}
function sortItems(items) {
    return [...items].sort((a, b) => {
        if (a.status !== b.status)
            return a.status === 'pending' ? -1 : 1;
        if (a.due && b.due)
            return Date.parse(a.due) - Date.parse(b.due);
        if (a.due)
            return -1;
        if (b.due)
            return 1;
        return b.createdAt - a.createdAt;
    });
}
/**
 * 日程存储。一份 JSON，人可读、可手改。
 * 刻意不放进事实卡：日程有期限，事实卡是无期限的“你是谁”。
 */
export function createScheduleStore(baseDir) {
    const dir = baseDir ?? path.join(homeDir(), 'memory');
    const file = path.join(dir, 'schedule.json');
    function read() {
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!Array.isArray(parsed.items))
                return [];
            return parsed.items
                .filter((item) => Boolean(item) && typeof item === 'object')
                .map((item) => ({
                id: String(item.id ?? newId()),
                title: cleanTitle(item.title),
                due: normalizeDue(item.due),
                status: (item.status === 'done' || item.status === 'dropped' ? item.status : 'pending'),
                source: (item.source === 'chat' ? 'chat' : 'manual'),
                sourceText: typeof item.sourceText === 'string' ? item.sourceText.slice(0, 200) : undefined,
                createdAt: Number(item.createdAt) || Date.now(),
                doneAt: typeof item.doneAt === 'number' ? item.doneAt : null,
                lastReminded: typeof item.lastReminded === 'string' ? item.lastReminded : undefined,
                repeat: normalizeRepeat(item.repeat) ?? undefined,
                lastDoneOn: typeof item.lastDoneOn === 'string' ? item.lastDoneOn : undefined,
                overdueAskedAt: typeof item.overdueAskedAt === 'number' ? item.overdueAskedAt : undefined,
            }))
                .filter((item) => item.title.length > 0);
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
            /* 写失败不能影响主流程；调用方拿到的仍是内存里的结果 */
        }
    }
    return {
        file,
        list: () => sortItems(read()),
        add(input) {
            const title = cleanTitle(input?.title);
            if (!title)
                throw new Error('标题不能为空');
            const item = {
                id: newId(),
                title,
                due: normalizeDue(input?.due),
                status: 'pending',
                source: input?.source === 'chat' ? 'chat' : 'manual',
                sourceText: typeof input?.sourceText === 'string' ? input.sourceText.slice(0, 200) : undefined,
                createdAt: Date.now(),
                doneAt: null,
                repeat: normalizeRepeat(input?.repeat) ?? undefined,
            };
            write([...read(), item]);
            return item;
        },
        update(id, patch) {
            const items = read();
            const index = items.findIndex((item) => item.id === id);
            if (index < 0)
                return null;
            const current = items[index];
            const next = {
                ...current,
                title: patch.title === undefined ? current.title : cleanTitle(patch.title) || current.title,
                due: patch.due === undefined ? current.due : normalizeDue(patch.due),
                status: patch.status ?? current.status,
                repeat: patch.repeat === undefined ? current.repeat : normalizeRepeat(patch.repeat) ?? undefined,
                lastReminded: patch.lastReminded === undefined ? current.lastReminded : patch.lastReminded,
            };
            items[index] = next;
            write(items);
            return next;
        },
        remove(id) {
            const items = read();
            const next = items.filter((item) => item.id !== id);
            if (next.length === items.length)
                return false;
            write(next);
            return true;
        },
        markOverdueAsked(id) {
            const items = read();
            const index = items.findIndex((item) => item.id === id);
            if (index < 0)
                return;
            items[index] = { ...items[index], overdueAskedAt: Date.now() };
            write(items);
        },
        drop(id) {
            const items = read();
            const index = items.findIndex((item) => item.id === id);
            if (index < 0)
                return null;
            items[index] = { ...items[index], status: 'dropped' };
            write(items);
            return items[index];
        },
        done(id) {
            const items = read();
            const index = items.findIndex((item) => item.id === id);
            if (index < 0)
                return null;
            const current = items[index];
            // 重复习惯：只记“今天做过了”，任务本身明天还在
            if (current.repeat) {
                items[index] = { ...current, doneAt: Date.now(), lastDoneOn: todayKey() };
            }
            else {
                items[index] = { ...current, status: 'done', doneAt: Date.now() };
            }
            write(items);
            return items[index];
        },
    };
}
/** 某一天的时间范围（本地时区，00:00 开始） */
export function dayRange(offsetDays = 0) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() + offsetDays);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start: start.getTime(), end: end.getTime() };
}
export function inDay(item, offsetDays = 0) {
    if (!item.due)
        return false;
    const time = Date.parse(item.due);
    const { start, end } = dayRange(offsetDays);
    return time >= start && time < end;
}
/** 重复规则的文字描述：每天 22:00 / 每周三 15:00 */
export function repeatText(item) {
    if (!item.repeat)
        return '';
    if (item.repeat.kind === 'daily')
        return `每天 ${item.repeat.time}`;
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return `每${names[item.repeat.weekday ?? 0]} ${item.repeat.time}`;
}
export function dueText(item) {
    if (!item.due)
        return '无期限';
    const date = new Date(item.due);
    const time = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    return time;
}
