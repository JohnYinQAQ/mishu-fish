/** iLink Bot API 的数据结构（只声明 demo 用得到的那部分） */
export const ITEM_TYPE = {
    TEXT: 1,
    IMAGE: 2,
    VOICE: 3,
    FILE: 4,
    VIDEO: 5,
};
export const MESSAGE_TYPE = {
    /** 用户发来的消息 */
    USER: 1,
    /** 机器人发出的消息 */
    BOT: 2,
};
export const MESSAGE_STATE = {
    NEW: 0,
    GENERATING: 1,
    FINISH: 2,
};
