import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from "../config.js";
function dayKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
function shiftDays(date, delta) {
    const next = new Date(date);
    next.setDate(next.getDate() + delta);
    return next;
}
export function createMemoryStore(baseDir) {
    const dir = baseDir ?? path.join(homeDir(), 'memory');
    function dayFile(date = new Date()) {
        return path.join(dir, `${dayKey(date)}.jsonl`);
    }
    function ensure() {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    function append(entry) {
        try {
            ensure();
            fs.appendFileSync(dayFile(new Date(entry.at)), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
        }
        catch {
            /* 记忆写失败不能影响回复 */
        }
    }
    function readDay(date) {
        const file = dayFile(date);
        let raw;
        try {
            raw = fs.readFileSync(file, 'utf8');
        }
        catch {
            return [];
        }
        const out = [];
        for (const line of raw.split('\n')) {
            if (!line.trim())
                continue;
            try {
                const value = JSON.parse(line);
                if (value && typeof value.text === 'string' && (value.role === 'user' || value.role === 'assistant')) {
                    out.push(value);
                }
            }
            catch {
                /* 单行坏了就跳过，不整份作废 */
            }
        }
        return out;
    }
    function recent(count, options = {}) {
        if (count <= 0)
            return [];
        const cutoff = options.before ?? Date.now();
        const start = new Date(cutoff);
        const collected = [];
        // 从今天往回翻，最多翻 7 天；按时间正序返回
        for (let offset = 0; offset < 7 && collected.length < count; offset++) {
            const day = shiftDays(start, -offset);
            const entries = readDay(day)
                .filter((entry) => entry.at <= cutoff)
                .filter((entry) => (options.scope ? entry.scope === options.scope : true));
            collected.unshift(...entries);
        }
        return collected.slice(-count);
    }
    /** 中文没有空格，用二元组 + 英文单词做特征，够用且不引依赖 */
    function features(text) {
        const normalized = text.toLowerCase().replace(/\s+/g, ' ');
        const out = new Set();
        for (const word of normalized.match(/[a-z0-9]{2,}/g) ?? [])
            out.add(word);
        const cjk = normalized.replace(/[^\u4e00-\u9fa5]/g, '');
        for (let i = 0; i < cjk.length - 1; i++)
            out.add(cjk.slice(i, i + 2));
        return [...out];
    }
    function search(query, options = {}) {
        const limit = options.limit ?? 6;
        const days = options.days ?? 7;
        const wanted = features(query);
        if (wanted.length === 0)
            return [];
        const scored = [];
        const today = new Date();
        for (let offset = 0; offset < days; offset++) {
            for (const entry of readDay(shiftDays(today, -offset))) {
                if (options.scope && entry.scope !== options.scope)
                    continue;
                const have = new Set(features(entry.text));
                let score = 0;
                for (const feature of wanted)
                    if (have.has(feature))
                        score += 1;
                if (score >= 1)
                    scored.push({ ...entry, score });
            }
        }
        scored.sort((a, b) => b.score - a.score || b.at - a.at);
        return scored.slice(0, limit);
    }
    function summariesDir() {
        return path.join(dir, 'summaries');
    }
    function summaryFile(date) {
        return path.join(summariesDir(), `${dayKey(date)}.md`);
    }
    function writeSummary(date, text) {
        try {
            fs.mkdirSync(summariesDir(), { recursive: true, mode: 0o700 });
            fs.writeFileSync(summaryFile(date), `${text.trim()}\n`, { mode: 0o600 });
        }
        catch {
            /* ignore */
        }
    }
    function readSummary(date) {
        try {
            return fs.readFileSync(summaryFile(date), 'utf8').trim();
        }
        catch {
            return '';
        }
    }
    function hasDigest(date) {
        return fs.existsSync(summaryFile(date));
    }
    function factsFile() {
        return path.join(dir, 'facts.md');
    }
    function facts() {
        try {
            return fs.readFileSync(factsFile(), 'utf8').trim();
        }
        catch {
            return '';
        }
    }
    function writeFacts(text) {
        try {
            ensure();
            fs.writeFileSync(factsFile(), `${text.trim()}\n`, { mode: 0o600 });
        }
        catch {
            /* ignore */
        }
    }
    return {
        append,
        recent,
        search,
        day: (date = new Date()) => readDay(date),
        writeSummary,
        readSummary,
        hasDigest,
        summariesDir: summariesDir(),
        facts,
        writeFacts,
        dayFile,
        dir,
    };
}
