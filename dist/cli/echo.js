import { getUpdates, sendText, sendTyping } from "../ilink/bot.js";
import { isSessionExpired, isTimeout, sleep } from "../ilink/http.js";
import { describeNonText, isFromUser, isGroupMessage, messageKey, textOf } from "../text.js";
import { loadCredentials, loadState, rememberMessage, saveState } from "../store.js";
import { fail, incoming, info, outgoing, warn } from "../log.js";
function shortId(id) {
    return id.includes('@') ? id.split('@')[0].slice(0, 10) : id.slice(0, 10);
}
async function handle(msg, creds, state) {
    if (!isFromUser(msg, creds.accountId))
        return;
    const key = messageKey(msg);
    if (!rememberMessage(state, key))
        return;
    if (isGroupMessage(msg)) {
        warn('收到群消息：iLink 目前只支持单聊，已跳过（demo 不做群）');
        return;
    }
    const userId = msg.from_user_id ?? '';
    if (!userId)
        return;
    const contextToken = msg.context_token ?? '';
    if (contextToken)
        state.contextTokens[userId] = { token: contextToken, at: Date.now() };
    const text = textOf(msg);
    const display = text || describeNonText(msg);
    incoming(shortId(userId), display);
    if (!contextToken) {
        warn('这条消息没带 context_token，无法回复');
        return;
    }
    try {
        await sendTyping(creds, userId, contextToken, true);
    }
    catch {
        /* typing 只是锦上添花，失败不影响回复 */
    }
    const reply = text ? `🐟 收到：${text}` : `🐟 收到 ${display}。demo 目前只会复读文字，媒体能力后面再接。`;
    try {
        const parts = await sendText(creds, userId, contextToken, reply);
        outgoing(parts > 1 ? `${reply}（分 ${parts} 条）` : reply);
    }
    catch (err) {
        fail(`回复失败：${err.message}`);
    }
    finally {
        try {
            await sendTyping(creds, userId, contextToken, false);
        }
        catch {
            /* ignore */
        }
        saveState(state);
    }
}
async function main() {
    const creds = loadCredentials();
    if (!creds) {
        fail('还没有机器人账号。先运行：./bin/mishu login');
        process.exitCode = 1;
        return;
    }
    const state = loadState();
    info(`机器人：${creds.accountId}（token ${creds.token.slice(0, 6)}…）`);
    info(state.getUpdatesBuf
        ? `续上次的游标（${state.getUpdatesBuf.length} 字符，上次更新 ${state.updatedAt}）`
        : '首次拉取：从最新一条开始');
    info('监听中… 现在去微信里给它发一条消息。Ctrl-C 退出。');
    info('提示：如果点了「重新登录」，需要先跑一遍 ./bin/mishu login --force');
    let stopped = false;
    const stop = (signal) => {
        info(`收到 ${signal}，准备退出…`);
        stopped = true;
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
    let backoff = 1000;
    while (!stopped) {
        try {
            const res = await getUpdates(creds, state.getUpdatesBuf);
            backoff = 1000;
            if (res.get_updates_buf) {
                state.getUpdatesBuf = res.get_updates_buf;
                saveState(state);
            }
            for (const msg of res.msgs ?? []) {
                if (stopped)
                    break;
                await handle(msg, creds, state);
            }
        }
        catch (err) {
            if (isSessionExpired(err)) {
                fail('会话失效（ret=-14）。重新扫码：./bin/mishu login --force');
                process.exitCode = 2;
                break;
            }
            if (isTimeout(err))
                continue;
            warn(`拉取失败：${err.message}；${Math.round(backoff / 1000)} 秒后重试`);
            await sleep(backoff);
            backoff = Math.min(backoff * 2, 30_000);
        }
    }
    saveState(state);
    info('已退出，状态已保存');
}
main().catch((err) => {
    fail(err?.message ?? String(err));
    process.exitCode = 1;
});
