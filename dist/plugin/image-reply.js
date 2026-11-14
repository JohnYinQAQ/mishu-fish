import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from "../config.js";
import { buildSystemPrompt, stripMarkdown } from "./persona.js";
export function parseImageReply(raw) {
    const cleaned = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
    try {
        const value = JSON.parse(cleaned);
        const reply = typeof value.reply === 'string' ? stripMarkdown(value.reply).trim() : '';
        const topic = typeof value.topic === 'string' ? value.topic.trim() : '';
        if (!reply)
            return null;
        return { reply: reply.slice(0, 500), topic: topic.slice(0, 12) };
    }
    catch {
        return null;
    }
}
/**
 * 收到图片后：用她的人设 + 事实卡回应，同时给这张图归一个类别。
 * 一次调用同时产出「回应」和「主题」，避免为同一张图花两次钱。
 */
export async function composeImageReply(llm, route, config, facts, description, history = []) {
    const system = [
        buildSystemPrompt(config, facts),
        '',
        '## 这次的场景',
        '他刚给你发了一张图片。后台看图的描述在下面。',
        '你要像平时聊天那样回应他：可能是分享日常、分享一件要做的事、或单纯给你看个景。',
        '不要复述描述，也不要逐条列举画面里的东西；挑你注意到的、和他有关的点说，1–3 句。',
        '',
        '同时判断这张图属于哪一类（用来慢慢了解他的生活），例如：海边、学校、宠物、食物、风景、工作、动漫、截图、其他。',
        'topic 只写一个词，2–6 个字。',
        '',
        '只输出 JSON，不要代码块：{"reply":"你要说的话","topic":"类别"}',
    ].join('\n');
    const recent = history.slice(-4).map((entry) => `${entry.role === 'user' ? '他' : '你'}：${entry.text}`).join('\n');
    const user = [recent ? `最近的对话：\n${recent}` : '', `图片描述：${description}`].filter(Boolean).join('\n\n');
    const signal = AbortSignal.timeout(40_000);
    let text = '';
    let failure = '';
    const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
        temperature: 0.7,
        maxTokens: 400,
        signal,
    });
    for await (const chunk of stream) {
        const value = (chunk ?? {});
        if (value.type === 'finish') {
            const reason = (value.reason ?? {});
            if (reason.kind === 'error') {
                const fail = (reason.failure ?? {});
                failure = [fail.code, fail.message].filter(Boolean).join(': ') || '模型调用失败';
            }
        }
        if (value.type === 'text-delta' && typeof value.text === 'string')
            text += value.text;
    }
    if (failure)
        throw new Error(failure);
    return parseImageReply(text);
}
/** 图片主题计数：同一类图反复出现，说明他生活里常出现这个场景 */
export function createTopicStore(baseDir) {
    const dir = baseDir ?? path.join(homeDir(), 'memory');
    const file = path.join(dir, 'image-topics.json');
    function read() {
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            return parsed.topics ?? {};
        }
        catch {
            return {};
        }
    }
    function write(topics) {
        try {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            const tmp = `${file}.tmp-${process.pid}`;
            fs.writeFileSync(tmp, `${JSON.stringify({ topics }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(tmp, file);
        }
        catch {
            /* ignore */
        }
    }
    return {
        file,
        list: () => Object.values(read()),
        record(topic, at = Date.now()) {
            const clean = topic.trim().slice(0, 12);
            if (!clean)
                return null;
            const topics = read();
            const date = new Date(at);
            const day = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
            const existing = topics[clean] ?? { topic: clean, count: 0, days: [], firstSeen: at, lastSeen: at };
            existing.count += 1;
            if (!existing.days.includes(day))
                existing.days.push(day);
            existing.lastSeen = at;
            topics[clean] = existing;
            write(topics);
            return existing;
        },
    };
}
/** 同一类图跨 ≥3 天出现过 5 次以上，就值得写进事实卡 */
export function shouldRecordTopic(record) {
    return record.count >= 5 && record.days.length >= 3;
}
/** 给事实卡准备的那一行 */
export function topicFactLine(topic) {
    return `- 常发${topic}相关的图片`;
}
