import { dayRange, doneToday, occursToday, repeatText } from "./schedule.js";
/** 两个窗口各给 2 小时的容错：睡眠/错过整点也能补发 */
const WINDOW_SPAN_MINUTES = 120;
export function clockMinutes(clock) {
    const match = /^(\d{2}):(\d{2})$/.exec(clock);
    if (!match)
        return null;
    return Number(match[1]) * 60 + Number(match[2]);
}
/** 现在落在哪个提醒窗口里；不在任何窗口就返回 null */
export function windowAt(now, times) {
    const current = now.getHours() * 60 + now.getMinutes();
    const morning = clockMinutes(times.morningTime);
    const evening = clockMinutes(times.eveningTime);
    // 跨零点的窗口（23:00 + 2h = 01:00）要回绕，否则 00:30 会被漏掉
    const within = (target) => {
        if (target === null)
            return false;
        const end = target + WINDOW_SPAN_MINUTES;
        if (end <= 1440)
            return current >= target && current < end;
        return current >= target || current < end - 1440;
    };
    if (within(morning))
        return 'morning';
    if (within(evening))
        return 'evening';
    return null;
}
export function dayKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function clockOf(item) {
    if (!item.due)
        return '';
    const date = new Date(item.due);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')} `;
}
function byDue(a, b) {
    if (!a.due && !b.due)
        return 0;
    if (!a.due)
        return 1;
    if (!b.due)
        return -1;
    return Date.parse(a.due) - Date.parse(b.due);
}
/**
 * 生成一条提醒文本。没有内容就返回 null——不发“今天没事”这种空提醒。
 *
 * 早间：今天要做的
 * 晚间：今天没做完的（含逾期）+ 明天的安排
 */
export function buildReminder(window, items, now = new Date()) {
    const pending = items.filter((item) => item.status === 'pending');
    if (window === 'morning') {
        const due = pending.filter((item) => {
            if (item.repeat)
                return occursToday(item) && !doneToday(item);
            if (!item.due)
                return false;
            const time = Date.parse(item.due);
            return time >= dayRange(0).start && time < dayRange(0).end;
        });
        if (due.length === 0)
            return null;
        const lines = due.map((item) => (item.repeat ? `· ${repeatText(item)} ${item.title}` : `· ${clockOf(item)}${item.title}`));
        return `☀️ 今天有 ${due.length} 件事：\n${lines.join('\n')}`;
    }
    const endOfToday = dayRange(0).end;
    const unfinished = pending
        .filter((item) => {
        if (item.repeat)
            return occursToday(item) && !doneToday(item);
        return item.due && Date.parse(item.due) < endOfToday;
    })
        .sort(byDue);
    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrow = pending
        .filter((item) => {
        if (item.repeat)
            return occursToday(item, tomorrowDate) && !doneToday(item, tomorrowDate);
        if (!item.due)
            return false;
        const time = Date.parse(item.due);
        return time >= dayRange(1).start && time < dayRange(1).end;
    })
        .sort(byDue);
    if (unfinished.length === 0 && tomorrow.length === 0)
        return null;
    const parts = [];
    if (unfinished.length > 0) {
        const lines = unfinished.map((item) => {
            if (item.repeat)
                return `· ${item.title}（${repeatText(item)}）`;
            return `· ${item.title}${item.due ? `（${clockOf(item).trim()} 截止）` : ''}`;
        });
        parts.push(`🌙 今天还有 ${unfinished.length} 件没做完：\n${lines.join('\n')}`);
    }
    if (tomorrow.length > 0) {
        const lines = tomorrow.map((item) => (item.repeat ? `· ${repeatText(item)} ${item.title}` : `· ${clockOf(item)}${item.title}`));
        parts.push(`明天有 ${tomorrow.length} 件事：\n${lines.join('\n')}`);
    }
    return parts.join('\n\n');
}
/** 挂起的提醒什么时候作废：晚间那条到次日 07:00，早间那条 4 小时后 */
export function reminderExpiry(window, now = new Date()) {
    if (window === 'evening') {
        const expiry = new Date(now);
        expiry.setDate(expiry.getDate() + 1);
        expiry.setHours(7, 0, 0, 0);
        return expiry.getTime();
    }
    return now.getTime() + 4 * 60 * 60 * 1000;
}
/** 现在是否落在 [clock, clock+span) 这个窗口里；支持跨零点 */
export function withinClockWindow(clock, spanMinutes, now = new Date()) {
    const target = clockMinutes(clock);
    if (target === null)
        return false;
    const current = now.getHours() * 60 + now.getMinutes();
    const end = target + spanMinutes;
    if (end <= 1440)
        return current >= target && current < end;
    return current >= target || current < end - 1440;
}
/** 现在该发哪条问候（不含“今天发过没有”的去重） */
export function greetingsDue(times, now = new Date()) {
    const due = [];
    if (times.morningGreeting && withinClockWindow(times.morningGreeting, 90, now))
        due.push('morning');
    if (times.eveningGreeting && withinClockWindow(times.eveningGreeting, 120, now))
        due.push('evening');
    return due;
}
