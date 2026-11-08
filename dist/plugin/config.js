import { filePath } from "../config.js";
import { writeJsonAtomic } from "../store.js";
import fs from 'node:fs';
export const TEMPLATES = ['gentle', 'blunt', 'work', 'playful', 'custom'];
export const EMOJI_MODES = ['none', 'some', 'lots'];
export const LANGUAGES = ['zh', 'en', 'follow'];
export const MODEL_MODES = ['inherit', 'manual'];
export const DEFAULT_CONFIG = {
    enabled: true,
    persona: {
        name: '秘书鱼',
        selfCall: '我',
        callUser: '你',
        template: 'gentle',
        text: '',
        bannedWords: [],
    },
    style: { maxChars: 120, emoji: 'some', language: 'zh', markdown: false },
    behavior: {
        replyToAll: true,
        quietStart: '',
        quietEnd: '',
        perMinute: 6,
        fallback: '我这边卡了一下，等下再试。',
    },
    model: { mode: 'inherit', provider: '', model: '', temperature: 0.7, maxTokens: 400 },
    escalation: {
        // 开源版默认关闭：拿到你微信的人等于拿到你电脑的命令执行权
        enabled: false,
        prefix: '!dsh',
        timeoutSec: 60,
        carryPersona: true,
        carryMemory: true,
        permissionPreset: 'danger-full-access',
        cwd: '',
    },
    schedule: {
        enabled: true,
        eveningTime: '23:00',
        morningTime: '07:00',
        triggerWord: '记一下',
        notifyFallback: true,
        confirmOnComplete: false,
    },
    habits: {
        learnFromChat: true,
        learnFromActivities: true,
    },
    onboarding: {
        welcome: true,
    },
    reply: {
        modelReplies: true,
    },
    rhythm: {
        enabled: true,
        wakeTime: '',
        sleepTime: '',
        homeworkStart: '',
        homeworkEnd: '',
        morningGreeting: '07:30',
        eveningGreeting: '23:00',
    },
    memory: {
        enabled: true,
        recentCount: 8,
        injectFacts: true,
        retrieveSummaries: false,
        recallEnabled: true,
        recallMaxLines: 6,
        recallDays: 30,
        triggerWords: ['上次', '前几天', '之前', '那个事', '还记得', '记得我', '我说过'],
        factsLimit: 400,
        summaryTime: '05:00',
        weeklyReport: true,
        weeklyDay: 0,
        weeklyTime: '20:00',
        dailyReport: true,
        digestRetentionDays: 90,
    },
};
function str(value, max, fallback) {
    if (typeof value !== 'string')
        return fallback;
    const trimmed = value.trim();
    return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}
function bool(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
function int(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}
function float(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, n));
}
function oneOf(value, allowed, fallback) {
    return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}
/** 时间写成 HH:MM；不合法就当没设置 */
function clock(value) {
    if (typeof value !== 'string')
        return '';
    const match = /^(\d{1,2}):(\d{1,2})$/.exec(value.trim());
    if (!match)
        return '';
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59)
        return '';
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
/**
 * 把任意输入收敛成合法配置。
 * 设置页、手改 JSON、旧版本配置都会走这里，所以边界值一律夹紧而不是报错。
 */
export function normalizeConfig(raw) {
    const input = (raw && typeof raw === 'object' ? raw : {});
    const persona = (input.persona ?? {});
    const style = (input.style ?? {});
    const behavior = (input.behavior ?? {});
    const model = (input.model ?? {});
    const escalation = (input.escalation ?? {});
    const memory = (input.memory ?? {});
    const schedule = (input.schedule ?? {});
    const rhythm = (input.rhythm ?? {});
    const habits = (input.habits ?? {});
    const onboarding = (input.onboarding ?? {});
    const reply = (input.reply ?? {});
    const banned = Array.isArray(persona.bannedWords)
        ? persona.bannedWords
            .filter((word) => typeof word === 'string')
            .map((word) => word.trim())
            .filter(Boolean)
            .slice(0, 20)
        : [];
    return {
        enabled: bool(input.enabled, DEFAULT_CONFIG.enabled),
        persona: {
            name: str(persona.name, 20, DEFAULT_CONFIG.persona.name) || DEFAULT_CONFIG.persona.name,
            selfCall: str(persona.selfCall, 20, DEFAULT_CONFIG.persona.selfCall),
            callUser: str(persona.callUser, 20, DEFAULT_CONFIG.persona.callUser),
            template: oneOf(persona.template, TEMPLATES, DEFAULT_CONFIG.persona.template),
            text: str(persona.text, 4000, DEFAULT_CONFIG.persona.text),
            bannedWords: banned,
        },
        style: {
            maxChars: int(style.maxChars, 20, 2000, DEFAULT_CONFIG.style.maxChars),
            emoji: oneOf(style.emoji, EMOJI_MODES, DEFAULT_CONFIG.style.emoji),
            language: oneOf(style.language, LANGUAGES, DEFAULT_CONFIG.style.language),
            markdown: bool(style.markdown, DEFAULT_CONFIG.style.markdown),
        },
        behavior: {
            replyToAll: bool(behavior.replyToAll, DEFAULT_CONFIG.behavior.replyToAll),
            quietStart: clock(behavior.quietStart),
            quietEnd: clock(behavior.quietEnd),
            perMinute: int(behavior.perMinute, 1, 30, DEFAULT_CONFIG.behavior.perMinute),
            fallback: str(behavior.fallback, 200, DEFAULT_CONFIG.behavior.fallback),
        },
        model: {
            mode: oneOf(model.mode, MODEL_MODES, DEFAULT_CONFIG.model.mode),
            provider: str(model.provider, 60, ''),
            model: str(model.model, 60, ''),
            temperature: float(model.temperature, 0, 2, DEFAULT_CONFIG.model.temperature),
            maxTokens: int(model.maxTokens, 50, 4000, DEFAULT_CONFIG.model.maxTokens),
        },
        escalation: {
            enabled: bool(escalation.enabled, DEFAULT_CONFIG.escalation.enabled),
            prefix: str(escalation.prefix, 12, DEFAULT_CONFIG.escalation.prefix) || DEFAULT_CONFIG.escalation.prefix,
            timeoutSec: int(escalation.timeoutSec, 10, 300, DEFAULT_CONFIG.escalation.timeoutSec),
            carryPersona: bool(escalation.carryPersona, DEFAULT_CONFIG.escalation.carryPersona),
            carryMemory: bool(escalation.carryMemory, DEFAULT_CONFIG.escalation.carryMemory),
            permissionPreset: str(escalation.permissionPreset, 40, DEFAULT_CONFIG.escalation.permissionPreset),
            cwd: str(escalation.cwd, 200, DEFAULT_CONFIG.escalation.cwd),
        },
        schedule: {
            enabled: bool(schedule.enabled, DEFAULT_CONFIG.schedule.enabled),
            eveningTime: clock(schedule.eveningTime) || DEFAULT_CONFIG.schedule.eveningTime,
            morningTime: clock(schedule.morningTime) || DEFAULT_CONFIG.schedule.morningTime,
            // 留空 = 自动判断；空串要保留，不能回落到默认词
            triggerWord: schedule.triggerWord === undefined
                ? DEFAULT_CONFIG.schedule.triggerWord
                : String(schedule.triggerWord).trim().slice(0, 12),
            notifyFallback: bool(schedule.notifyFallback, DEFAULT_CONFIG.schedule.notifyFallback),
            confirmOnComplete: bool(schedule.confirmOnComplete, DEFAULT_CONFIG.schedule.confirmOnComplete),
        },
        habits: {
            learnFromChat: bool(habits.learnFromChat, DEFAULT_CONFIG.habits.learnFromChat),
            learnFromActivities: bool(habits.learnFromActivities, DEFAULT_CONFIG.habits.learnFromActivities),
        },
        onboarding: {
            welcome: bool(onboarding.welcome, DEFAULT_CONFIG.onboarding.welcome),
        },
        reply: {
            modelReplies: bool(reply.modelReplies, DEFAULT_CONFIG.reply.modelReplies),
        },
        rhythm: {
            enabled: bool(rhythm.enabled, DEFAULT_CONFIG.rhythm.enabled),
            wakeTime: clock(rhythm.wakeTime),
            sleepTime: clock(rhythm.sleepTime),
            homeworkStart: clock(rhythm.homeworkStart),
            homeworkEnd: clock(rhythm.homeworkEnd),
            // 未填时用默认时刻；显式填空串表示“不要问候”
            morningGreeting: rhythm.morningGreeting === undefined
                ? DEFAULT_CONFIG.rhythm.morningGreeting
                : clock(rhythm.morningGreeting),
            eveningGreeting: rhythm.eveningGreeting === undefined
                ? DEFAULT_CONFIG.rhythm.eveningGreeting
                : clock(rhythm.eveningGreeting),
        },
        memory: {
            enabled: bool(memory.enabled, DEFAULT_CONFIG.memory.enabled),
            recentCount: int(memory.recentCount, 4, 20, DEFAULT_CONFIG.memory.recentCount),
            injectFacts: bool(memory.injectFacts, DEFAULT_CONFIG.memory.injectFacts),
            retrieveSummaries: bool(memory.retrieveSummaries, DEFAULT_CONFIG.memory.retrieveSummaries),
            recallEnabled: bool(memory.recallEnabled, DEFAULT_CONFIG.memory.recallEnabled),
            recallMaxLines: int(memory.recallMaxLines, 2, 20, DEFAULT_CONFIG.memory.recallMaxLines),
            recallDays: int(memory.recallDays, 1, 90, DEFAULT_CONFIG.memory.recallDays),
            triggerWords: Array.isArray(memory.triggerWords)
                ? memory.triggerWords
                    .filter((word) => typeof word === 'string')
                    .map((word) => word.trim())
                    .filter(Boolean)
                    .slice(0, 12)
                : DEFAULT_CONFIG.memory.triggerWords,
            factsLimit: int(memory.factsLimit, 200, 1000, DEFAULT_CONFIG.memory.factsLimit),
            summaryTime: clock(memory.summaryTime) || DEFAULT_CONFIG.memory.summaryTime,
            weeklyReport: bool(memory.weeklyReport, DEFAULT_CONFIG.memory.weeklyReport),
            weeklyDay: int(memory.weeklyDay, 0, 6, DEFAULT_CONFIG.memory.weeklyDay),
            weeklyTime: clock(memory.weeklyTime) || DEFAULT_CONFIG.memory.weeklyTime,
            dailyReport: bool(memory.dailyReport, DEFAULT_CONFIG.memory.dailyReport),
            digestRetentionDays: int(memory.digestRetentionDays, 30, 365, DEFAULT_CONFIG.memory.digestRetentionDays),
        },
    };
}
export function loadConfig() {
    const file = filePath('config.json');
    try {
        return normalizeConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return normalizeConfig({});
        // 配置坏了不要让人进不去设置页：回默认值，界面上会提示
        return normalizeConfig({});
    }
}
export function saveConfig(config) {
    const next = normalizeConfig(config);
    writeJsonAtomic(filePath('config.json'), next);
    return next;
}
export function configFile() {
    return filePath('config.json');
}
