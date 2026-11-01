import crypto from 'node:crypto';
import { APP_CLIENT_VERSION } from "../config.js";
/** 请求超时（长轮询的正常现象，调用方通常当成「这一轮没有消息」） */
export class TimeoutError extends Error {
    constructor(message = '请求超时') {
        super(message);
        this.name = 'TimeoutError';
    }
}
export class ILinkError extends Error {
    status;
    ret;
    errcode;
    body;
    constructor(message, extra = {}) {
        super(message);
        this.name = 'ILinkError';
        this.status = extra.status;
        this.ret = extra.ret;
        this.errcode = extra.errcode;
        this.body = extra.body;
    }
}
export function isTimeout(err) {
    return err instanceof TimeoutError;
}
/** 会话失效：需要重新扫码 */
export function isSessionExpired(err) {
    return err instanceof ILinkError && (err.ret === -14 || err.errcode === -14);
}
/**
 * X-WECHAT-UIN：随机 uint32 → 十进制字符串 → base64。
 * 每次请求都要重新生成（协议要求）。
 */
export function randomWechatUin() {
    const value = crypto.randomBytes(4).readUInt32BE(0);
    return Buffer.from(String(value), 'utf8').toString('base64');
}
/** 业务请求的公共头（getupdates / sendmessage / getconfig / sendtyping 都用这套） */
export function botHeaders(token) {
    return {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        Authorization: `Bearer ${token}`,
        'X-WECHAT-UIN': randomWechatUin(),
    };
}
async function request(url, init, timeoutMs) {
    let res;
    try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    }
    catch (err) {
        const name = err?.name;
        if (name === 'TimeoutError' || name === 'AbortError') {
            throw new TimeoutError(`请求超时（${timeoutMs}ms）: ${url}`);
        }
        throw new ILinkError(`网络请求失败: ${err?.message ?? String(err)}`);
    }
    const text = await res.text();
    let body = null;
    try {
        body = text ? JSON.parse(text) : {};
    }
    catch {
        body = null;
    }
    if (!res.ok) {
        throw new ILinkError(`HTTP ${res.status}`, { status: res.status, body: text.slice(0, 500) });
    }
    if (body === null) {
        throw new ILinkError('响应不是合法 JSON', { status: res.status, body: text.slice(0, 300) });
    }
    return body;
}
/** 登录阶段的 GET（二维码 / 扫码状态） */
export async function getJson(url, opts = {}) {
    return request(url, {
        method: 'GET',
        headers: {
            'iLink-App-ClientVersion': APP_CLIENT_VERSION,
            ...opts.headers,
        },
    }, opts.timeoutMs ?? 20_000);
}
/** 业务 POST（带 bot token） */
export async function postBot(url, body, token, opts = {}) {
    return request(url, {
        method: 'POST',
        headers: botHeaders(token),
        body: JSON.stringify(body),
    }, opts.timeoutMs ?? 20_000);
}
/** 业务响应：ret/errcode 非 0 即失败（-14 = 会话失效） */
export function assertOk(json, what) {
    const ret = json.ret ?? 0;
    const errcode = json.errcode ?? 0;
    if (ret !== 0 || errcode !== 0) {
        throw new ILinkError(`${what}失败: ret=${ret} errcode=${errcode} ${json.errmsg ?? ''}`.trim(), {
            ret,
            errcode,
            body: json,
        });
    }
}
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
