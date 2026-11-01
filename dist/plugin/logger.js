import fs from 'node:fs';
const MARKS = { in: '<-', out: '->', sys: '!!' };
const LEVEL_ORDER = { info: 0, warn: 1, error: 2 };
export function levelOf(entry) {
    return entry.level ?? 'info';
}
/** 默认 info 全看；选 warn / error 时只看该级别及以上 */
export function withinLevel(entry, minLevel) {
    return LEVEL_ORDER[levelOf(entry)] >= LEVEL_ORDER[minLevel];
}
/** 超过上限就把老文件往后挪：.log → .log.1 → .log.2 …，保留 keep 份 */
export function rotateIfNeeded(file, maxBytes = 2 * 1024 * 1024, keep = 3) {
    try {
        const size = fs.statSync(file).size;
        if (size < maxBytes)
            return;
        const oldest = `${file}.${keep}`;
        if (fs.existsSync(oldest))
            fs.rmSync(oldest);
        for (let index = keep - 1; index >= 1; index--) {
            const from = `${file}.${index}`;
            if (fs.existsSync(from))
                fs.renameSync(from, `${file}.${index + 1}`);
        }
        fs.renameSync(file, `${file}.1`);
    }
    catch {
        /* 文件还不存在就没什么可轮转的 */
    }
}
export function appendLine(file, line, options = {}) {
    rotateIfNeeded(file, options.maxBytes, options.keep);
    try {
        fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
    }
    catch {
        /* 日志写失败不能影响主流程 */
    }
}
/**
 * 一份人读的 .log + 一份机器读的 .log.jsonl。
 * 人读的保持原来的一行式，方便 grep；机器读的带 level / rid / usage，方便统计。
 */
export function createLogger(file) {
    const jsonl = `${file}.jsonl`;
    return {
        file,
        jsonlFile: jsonl,
        write(entry) {
            const level = levelOf(entry);
            const rid = entry.rid ? ` [${entry.rid}]` : '';
            const usage = entry.usage ? ` tokens=${entry.usage.input}/${entry.usage.output}` : '';
            const meta = entry.meta ? ` (${entry.meta})` : '';
            appendLine(file, `${new Date(entry.at).toISOString()} ${MARKS[entry.dir] ?? '!!'}${rid} ${entry.text}${usage}${meta}`);
            appendLine(jsonl, JSON.stringify({ level, ...entry }));
        },
    };
}
