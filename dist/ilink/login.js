import { DEFAULT_BASE_URL, QR_POLL_TIMEOUT_MS } from "../config.js";
import { assertOk, getJson, isTimeout } from "./http.js";
/** 申请一张登录二维码 */
export async function fetchQrTicket(baseUrl = DEFAULT_BASE_URL) {
    const json = await getJson(`${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`, {
        timeoutMs: 20_000,
    });
    assertOk(json, '获取二维码');
    if (!json.qrcode || !json.qrcode_img_content) {
        throw new Error(`二维码响应缺少字段：${JSON.stringify(json).slice(0, 300)}`);
    }
    return { qrcode: json.qrcode, qrcodeImgContent: json.qrcode_img_content };
}
/**
 * 轮询扫码状态。这是长轮询：正常情况下会被服务端挂住 30 秒左右才返回。
 * 本地超时等价于「还没人扫」，不是错误。
 */
export async function fetchQrStatus(baseUrl, qrcode, timeoutMs = QR_POLL_TIMEOUT_MS) {
    let json;
    try {
        json = await getJson(`${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, { timeoutMs });
    }
    catch (err) {
        if (isTimeout(err))
            return { status: 'wait' };
        throw err;
    }
    switch (json.status) {
        case 'scaned':
            return { status: 'scaned' };
        case 'expired':
            return { status: 'expired' };
        case 'confirmed': {
            if (!json.bot_token || !json.ilink_bot_id) {
                throw new Error(`登录成功但响应缺少凭据：${JSON.stringify(json).slice(0, 300)}`);
            }
            return {
                status: 'confirmed',
                botToken: json.bot_token,
                botId: json.ilink_bot_id,
                userId: json.ilink_user_id ?? '',
                baseUrl: json.baseurl || baseUrl,
            };
        }
        case 'wait':
        case undefined:
            return { status: 'wait' };
        default:
            return { status: 'wait' };
    }
}
/** 完整的扫码登录流程：申请二维码 → 轮询 → 过期自动换一张 → 拿到凭据 */
export async function loginWithQr(options) {
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    const deadline = Date.now() + (options.deadlineMs ?? 6 * 60_000);
    let ticket = await fetchQrTicket(baseUrl);
    await options.onQr(ticket);
    let lastStatus = '';
    while (Date.now() < deadline) {
        const status = await fetchQrStatus(baseUrl, ticket.qrcode, options.pollTimeoutMs ?? QR_POLL_TIMEOUT_MS);
        if (status.status === 'expired') {
            ticket = await fetchQrTicket(baseUrl);
            await options.onQr(ticket);
            continue;
        }
        if (status.status !== lastStatus) {
            lastStatus = status.status;
            options.onStatus?.(status.status);
        }
        if (status.status === 'confirmed') {
            return {
                token: status.botToken,
                baseUrl: status.baseUrl,
                accountId: status.botId,
                userId: status.userId,
                savedAt: new Date().toISOString(),
            };
        }
    }
    throw new Error('等待扫码超时，请重新运行 login');
}
