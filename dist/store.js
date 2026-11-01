import fs from 'node:fs';
import path from 'node:path';
import { filePath, homeDir } from "./config.js";
export const MAX_SEEN = 200;
export function emptyState() {
    return { getUpdatesBuf: '', contextTokens: {}, seen: [], updatedAt: new Date().toISOString() };
}
export function ensureHome() {
    fs.mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
}
/** 原子写入 + 0600。先写临时文件再 rename，避免进程被杀时留下半个 JSON */
export function writeJsonAtomic(file, value) {
    // 测试里必须显式指定 MISHU_HOME。否则（比如测试已经结束、残留的轮询循环还在跑）
    // 会写进真实的 ~/.dsh/mishu-fish，把线上游标冲掉——这个坑已经踩过一次。
    if (!process.env.MISHU_HOME && process.env.NODE_TEST_CONTEXT) {
        throw new Error(`测试里必须设置 MISHU_HOME，拒绝写入真实目录：${file}`);
    }
    ensureHome();
    const tmp = `${file}.tmp-${process.pid}`;
    try {
        fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, file);
        try {
            fs.chmodSync(file, 0o600);
        }
        catch {
            /* 某些文件系统不支持 chmod，忽略 */
        }
    }
    catch (err) {
        try {
            fs.unlinkSync(tmp);
        }
        catch {
            /* ignore */
        }
        throw err;
    }
}
function readJson(file) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return null;
        throw err;
    }
    try {
        return JSON.parse(raw);
    }
    catch {
        throw new Error(`文件不是合法 JSON：${file}（可以删掉它重新登录）`);
    }
}
export function loadCredentials() {
    const value = readJson(filePath('credentials.json'));
    if (!value)
        return null;
    if (!value.token || !value.baseUrl || !value.accountId) {
        throw new Error(`凭据文件缺少字段：${filePath('credentials.json')}（删掉后重新登录）`);
    }
    return {
        token: value.token,
        baseUrl: value.baseUrl,
        accountId: value.accountId,
        userId: value.userId ?? '',
        savedAt: value.savedAt ?? '',
    };
}
export function saveCredentials(creds) {
    writeJsonAtomic(filePath('credentials.json'), creds);
}
export function clearCredentials() {
    const file = filePath('credentials.json');
    if (fs.existsSync(file))
        fs.unlinkSync(file);
}
export function loadState() {
    const value = readJson(filePath('state.json'));
    const base = emptyState();
    if (!value)
        return base;
    return {
        getUpdatesBuf: typeof value.getUpdatesBuf === 'string' ? value.getUpdatesBuf : '',
        contextTokens: value.contextTokens && typeof value.contextTokens === 'object' ? value.contextTokens : {},
        seen: Array.isArray(value.seen) ? value.seen.filter((x) => typeof x === 'string') : [],
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : base.updatedAt,
    };
}
export function saveState(state) {
    state.updatedAt = new Date().toISOString();
    state.seen = state.seen.slice(-MAX_SEEN);
    writeJsonAtomic(filePath('state.json'), state);
}
export function rememberMessage(state, key) {
    if (state.seen.includes(key))
        return false;
    state.seen.push(key);
    if (state.seen.length > MAX_SEEN)
        state.seen = state.seen.slice(-MAX_SEEN);
    return true;
}
/** 日志里不要出现完整 token */
export function maskToken(token) {
    if (!token)
        return '(空)';
    if (token.length <= 10)
        return `${token.slice(0, 2)}***`;
    return `${token.slice(0, 8)}…${token.slice(-4)}`;
}
export function credentialsFile() {
    return filePath('credentials.json');
}
export function stateFile() {
    return filePath('state.json');
}
export function dataDir() {
    return path.join(homeDir());
}
