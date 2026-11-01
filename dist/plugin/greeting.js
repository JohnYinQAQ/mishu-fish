/**
 * 早间问候的文案拼装。抽成纯函数是为了能离线模拟：
 * 调度器只负责“什么时候调”，这里负责“说什么”。
 */
export function composeMorningGreeting(options) {
    const lines = [`早上好，${options.callUser}。`];
    if (options.reminderText) {
        // 复用早间提醒的列表，去掉它自己的 ☀️ 前缀
        lines.push(options.reminderText.replace(/^☀️\s*/, ''));
    }
    if (options.description)
        lines.push(`（作息参考：${options.description}）`);
    return lines.join('\n');
}
/** 晚间一条：清单 + 一句作息提醒（有睡眠画像时才加） */
export function composeEveningMessage(options) {
    const lines = [options.reminderText];
    if (options.sleepClock) {
        lines.push('');
        lines.push(`（你平常 ${options.sleepClock} 左右睡，别熬太晚。）`);
    }
    return lines.join('\n');
}
