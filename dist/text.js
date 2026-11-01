import { ITEM_TYPE, MESSAGE_TYPE } from "./ilink/types.js";
import { MAX_TEXT_LENGTH } from "./config.js";
/** 取出消息里的纯文本（多条 text item 用换行拼接） */
export function textOf(msg) {
    const parts = [];
    for (const item of msg.item_list ?? []) {
        const text = item.text_item?.text;
        if (typeof text === 'string' && text.length > 0)
            parts.push(text);
    }
    return parts.join('\n').trim();
}
/** 这条消息是不是用户发给我们的（不是我们自己发的） */
export function isFromUser(msg, botId) {
    if ((msg.message_type ?? MESSAGE_TYPE.USER) !== MESSAGE_TYPE.USER)
        return false;
    if (msg.to_user_id && botId && msg.to_user_id !== botId)
        return false;
    return true;
}
export function isGroupMessage(msg) {
    return typeof msg.group_id === 'string' && msg.group_id.length > 0;
}
/** 消息的稳定标识：优先 message_id，其次 client_id */
export function messageKey(msg) {
    if (typeof msg.message_id === 'number')
        return `m:${msg.message_id}`;
    if (msg.client_id)
        return `c:${msg.client_id}`;
    return `s:${msg.session_id ?? ''}:${msg.create_time_ms ?? 0}`;
}
/** 非文本消息的简短说明，用于 demo 里回显「你发来一个图片」 */
export function describeNonText(msg) {
    const labels = (msg.item_list ?? []).map((item) => labelOf(item)).filter(Boolean);
    return labels.join('、') || '未知内容';
}
function labelOf(item) {
    switch (item.type) {
        case ITEM_TYPE.IMAGE:
            return '图片';
        case ITEM_TYPE.VOICE:
            return item.voice_item?.text ? `语音转文字：${item.voice_item.text}` : '语音';
        case ITEM_TYPE.FILE:
            return `文件${item.file_item?.file_name ? `：${item.file_item.file_name}` : ''}`;
        case ITEM_TYPE.VIDEO:
            return '视频';
        case ITEM_TYPE.TEXT:
            return '';
        default:
            return '';
    }
}
/**
 * 按上限切分长文本。
 *
 * 微信/iLink 单条消息的文本上限没有公开常量，社区按 2000 字符处理。
 * 切分优先级：空行 > 换行 > 空格 > 硬切，保证不会把 emoji（代理对）切坏。
 */
export function chunkText(input, limit = MAX_TEXT_LENGTH) {
    const text = input.replace(/\r\n/g, '\n').trim();
    if (!text)
        return [];
    if (limit <= 0)
        throw new Error('limit 必须为正数');
    const chars = [...text];
    if (chars.length <= limit)
        return [text];
    const chunks = [];
    let rest = chars;
    while (rest.length > limit) {
        const window = rest.slice(0, limit);
        let cut = -1;
        for (let i = window.length - 1; i > 0; i--) {
            if (window[i] === '\n' && window[i - 1] === '\n') {
                cut = i + 1;
                break;
            }
        }
        if (cut < 0) {
            for (let i = window.length - 1; i > 0; i--) {
                if (window[i] === '\n') {
                    cut = i + 1;
                    break;
                }
            }
        }
        if (cut < 0) {
            for (let i = window.length - 1; i > 0; i--) {
                if (window[i] === ' ') {
                    cut = i + 1;
                    break;
                }
            }
        }
        // 切点太靠前就硬切，避免产生大量碎片
        if (cut < Math.floor(limit * 0.5))
            cut = limit;
        chunks.push(window.slice(0, cut).join('').trimEnd());
        rest = rest.slice(cut);
        while (rest.length > 0 && (rest[0] === '\n' || rest[0] === ' '))
            rest = rest.slice(1);
    }
    if (rest.length > 0)
        chunks.push(rest.join('').trimEnd());
    return chunks.filter((chunk) => chunk.length > 0);
}
