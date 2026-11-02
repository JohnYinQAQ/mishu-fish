import { buildSystemPrompt, stripMarkdown } from "./persona.js";
const KIND_RULES = {
    morning: [
        '这是早上他刚醒时的一条消息。',
        '要包含：问候 + 今天要做的事（没写就不提）+ 一句作息参考。',
        '语气自然，像熟人发来的早安，不要客服腔。',
    ].join('\n'),
    evening: [
        '这是晚上睡前的一条消息。',
        '要包含：今天还没做完的事、明天的安排（没有就不提）、以及一句提醒他早点睡的话。',
        '不要列成待办清单的口吻，像在关心他。',
    ].join('\n'),
    'homework-start': [
        '到了他平时写作业的时段，你要提醒他开始。',
        '同时问一句“打算多久写完”，让他回一个时间。',
        '不要长篇大论，两三句就够。',
    ].join('\n'),
    habit: [
        '他有一件按习惯要做的事，马上到点了。',
        '用一句自然的问句提起它，比如“你是不是 5 点准备去滑冰了”，不要用命令句。',
        '可以带一句关心或提醒（注意安全、记得带东西），但不要编造细节。',
        '不要在句子里堆信息，两三句就够。',
    ].join('\n'),
    welcome: [
        '这是你们第一次说话。先做一个简短的自我介绍：你是谁、能帮他做什么。',
        '能做的事只提这几样，各一句：记得住他说过的事、能记日程和提醒、会学他的作息、会在他做事前找他。',
        '最后问三个问题：怎么称呼他、平时几点睡几点起、最近想让你帮着记什么。',
        '不要列功能清单式的广告，像新同事第一次打招呼那样自然。',
        '不要一次说太多，控制在 150 字以内。',
    ].join('\n'),
    'habit-after': [
        '他按习惯要做的事，时间差不多过去了。',
        '问一句做完了没有，语气轻松，不要像查岗。',
        '如果提醒里没提过这件事，简单说明你在问哪件事。',
    ].join('\n'),
    'homework-nudge': [
        '他正在写作业，到了该问一句的间隔。',
        '问他写完了没有，语气轻松，不要像监工。',
        '不要重复上一条催促的原话。',
    ].join('\n'),
};
export function buildProactiveMessages(config, facts, context) {
    const system = [
        buildSystemPrompt(config, facts),
        '',
        '## 这次的任务',
        KIND_RULES[context.kind],
        '',
        '## 硬性要求',
        `- 纯文本，不要 Markdown，不超过 ${Math.max(80, config.style.maxChars)} 字。`,
        '- 不要编造事实卡和日程里没有的事。',
        '- 不要自称“系统”“助手”，按人设说话。',
        context.previous ? '- 下面会给你上一次的同类消息，这次必须换一种说法，不要重复。' : '',
    ]
        .filter(Boolean)
        .join('\n');
    const lines = [];
    if (context.today?.length)
        lines.push(`今天的事：\n${context.today.map((item) => `- ${item}`).join('\n')}`);
    if (context.unfinished?.length) {
        lines.push(`今天还没做完：\n${context.unfinished.map((item) => `- ${item}`).join('\n')}`);
    }
    if (context.tomorrow?.length)
        lines.push(`明天的事：\n${context.tomorrow.map((item) => `- ${item}`).join('\n')}`);
    if (context.rhythm)
        lines.push(`他的作息：${context.rhythm}`);
    if (context.extra)
        lines.push(context.extra);
    if (context.previous)
        lines.push(`上一次我说过：「${context.previous}」`);
    return { system, user: lines.join('\n\n') || '（没有特别的事项）' };
}
const PROACTIVE_TIMEOUT_MS = 30_000;
/** 生成一条主动消息；失败返回 null，调用方负责回落到模板 */
export async function generateProactive(llm, route, config, facts, context) {
    const attempt = async (system, user) => {
        const signal = AbortSignal.timeout(PROACTIVE_TIMEOUT_MS);
        let text = '';
        let failure = '';
        const stream = llm.stream({
            provider: route.provider,
            model: route.model,
            system,
            messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
            temperature: 0.8,
            maxTokens: 600,
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
        return stripMarkdown(text).trim();
    };
    const { system, user } = buildProactiveMessages(config, facts, context);
    const first = await attempt(system, user);
    if (first)
        return first.slice(0, 500);
    // 第一次空返回：可能被长背景挤掉了输出预算，换一个最小提示再试
    const minimal = buildProactiveMessages(config, '', { ...context, previous: undefined });
    const second = await attempt(minimal.system, minimal.user);
    return second ? second.slice(0, 500) : null;
}
