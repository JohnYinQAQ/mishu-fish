import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from "../config.js";
import { ruleText, titleSimilarity } from "./habits.js";
const MAX_AGE_DAYS = 120;
const MAX_ITEMS = 400;
/** 同一个活动、同一个星期几，至少出现几次才升级成候选 */
export const ACTIVITY_PROMOTE_THRESHOLD = 3;
function dateKeyOf(date) {
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}
function normalizeLabel(text) {
    return text.replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '').trim().slice(0, 20);
}
export function createActivityStore(baseDir) {
    const dir = baseDir ?? path.join(homeDir(), 'memory');
    const file = path.join(dir, 'activities.json');
    function read() {
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!Array.isArray(parsed.items))
                return [];
            return parsed.items
                .filter((item) => Boolean(item) && typeof item === 'object')
                .map((item) => ({
                label: String(item.label ?? '').trim(),
                weekday: Number(item.weekday),
                hour: Number(item.hour),
                dateKey: String(item.dateKey ?? ''),
                at: Number(item.at) || 0,
            }))
                .filter((item) => item.label && Number.isInteger(item.weekday) && Number.isInteger(item.hour));
        }
        catch {
            return [];
        }
    }
    function write(items) {
        try {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
            const kept = items
                .filter((item) => item.at >= cutoff)
                .sort((a, b) => a.at - b.at)
                .slice(-MAX_ITEMS);
            const tmp = `${file}.tmp-${process.pid}`;
            fs.writeFileSync(tmp, `${JSON.stringify({ items: kept }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(tmp, file);
        }
        catch {
            /* ignore */
        }
    }
    return {
        file,
        list: () => read(),
        record(label, at = Date.now()) {
            const clean = normalizeLabel(label);
            if (!clean)
                return null;
            const date = new Date(at);
            const dateKey = dateKeyOf(date);
            const items = read();
            // 同一天同一个活动只记一次
            const duplicated = items.some((item) => item.dateKey === dateKey && titleSimilarity(item.label, clean) >= 0.8);
            if (duplicated)
                return null;
            const observation = {
                label: clean,
                weekday: date.getDay(),
                hour: date.getHours(),
                dateKey,
                at,
            };
            write([...items, observation]);
            return observation;
        },
        promotable(existing) {
            const items = read();
            const groups = [];
            for (const item of items) {
                const matched = groups.find((group) => group.weekday === item.weekday && Math.abs(group.hours[0] - item.hour) <= 1 && titleSimilarity(group.label, item.label) >= 0.5);
                if (matched) {
                    matched.dates.add(item.dateKey);
                    matched.hours.push(item.hour);
                }
                else {
                    groups.push({ label: item.label, weekday: item.weekday, hours: [item.hour], dates: new Set([item.dateKey]) });
                }
            }
            return groups
                .filter((group) => group.dates.size >= ACTIVITY_PROMOTE_THRESHOLD)
                .map((group) => ({
                label: group.label,
                weekday: group.weekday,
                hour: Math.round(group.hours.reduce((sum, hour) => sum + hour, 0) / group.hours.length),
                count: group.dates.size,
            }))
                .filter((candidate) => {
                // 已经有同名的习惯就不再重复建议
                const time = `${String(candidate.hour).padStart(2, '0')}:00`;
                return !existing.some((habit) => habit.rule.kind === 'weekly' &&
                    habit.rule.weekday === candidate.weekday &&
                    habit.rule.time === time &&
                    titleSimilarity(habit.label, candidate.label) >= 0.5);
            });
        },
    };
}
/** 给设置页看的一句话 */
export function describeActivity(candidate) {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return `${names[candidate.weekday]} ${String(candidate.hour).padStart(2, '0')}:00 左右${candidate.label}（见过 ${candidate.count} 次）`;
}
export function toHabitInput(candidate) {
    return {
        label: candidate.label,
        rule: { kind: 'weekly', time: `${String(candidate.hour).padStart(2, '0')}:00`, weekday: candidate.weekday },
        source: 'inferred',
        status: 'candidate',
        afterAsk: true,
        askEstimate: /作业|学习|复习|背单词/.test(candidate.label),
    };
}
/** 便于测试和日志：候选的可读描述 */
export function candidateText(candidate) {
    return describeActivity({ ...candidate, count: 0 });
}
export { ruleText };
