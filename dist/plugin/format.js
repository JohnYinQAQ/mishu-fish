/** 把日程项排成“每天 22:00 写作业”“10-31 14:00 开会”这样的短句 */
export function itemLines(items) {
    return items.map((item) => {
        if (item.repeat) {
            return item.repeat.kind === 'daily'
                ? `每天 ${item.repeat.time} ${item.title}`
                : `每周${'日一二三四五六'[item.repeat.weekday ?? 0]} ${item.repeat.time} ${item.title}`;
        }
        if (!item.due)
            return item.title;
        const date = new Date(item.due);
        return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')} ${item.title}`;
    });
}
