/**
 * 秘书鱼 · DSH 设置页（客户端半边）
 *
 * 一个 section，配置一份文件（~/.dsh/mishu-fish/config.json）。
 * 渲染是数据驱动的：字段就是下面 describe() 里那一串，加字段只改这里。
 */
window.__ModuleLoader__.load({
  id: "mishu-fish",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React;

    const API = "/dsh-secretary/api";
    const CSS = `
      .msf{max-width:780px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:6px}
      .msf-title{margin:0;font-size:16px;font-weight:500;line-height:24px}
      .msf-intro{color:var(--dsw-alias-label-tertiary);margin:0 0 8px;font-size:13px;line-height:20px}
      .msf-pills{display:flex;flex-wrap:wrap;gap:8px;margin:2px 0 6px}
      .msf-pill{font-size:11.5px;line-height:18px;padding:2px 9px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
      .msf-pill.on{color:#22c55e;border-color:#22c55e66}
      .msf-pill.off{color:#f59e0b;border-color:#f59e0b66}
      .msf-group{margin-top:16px;font-size:13px;font-weight:600;line-height:20px}
      .msf-rows{display:flex;flex-direction:column}
      .msf-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px 20px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
      .msf-row:last-child{border-bottom:none}
      .msf-row>div:first-child{flex:1;min-width:180px}
      .msf-label{font-size:13px;line-height:19px}
      .msf-hint{color:var(--dsw-alias-label-tertiary);margin-top:3px;font-size:11.5px;line-height:17px}
      .msf-ctl{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
      .msf-input,.msf-select,.msf-area{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;padding:0 8px;height:28px;min-width:170px;outline:none;font-family:inherit}
      .msf-area{height:auto;min-height:96px;padding:7px 8px;line-height:19px;resize:vertical;width:360px;max-width:100%}
      .msf-input:focus-visible,.msf-select:focus-visible,.msf-area:focus-visible{border-color:var(--dsw-alias-brand-primary)}
      .msf-btn{border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;font-size:12.5px;height:28px;padding:0 12px;cursor:pointer}
      .msf-btn:hover{border-color:var(--dsw-alias-brand-primary)}
      .msf-btn:disabled{opacity:.45;cursor:default}
      .msf-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
      .msf-err{color:#f87171;font-size:12.5px;line-height:19px;margin-top:6px;white-space:pre-wrap}
      .msf-msg{color:#22c55e;font-size:12.5px;line-height:19px}
      .msf-toggle{width:40px;height:22px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;position:relative;cursor:pointer;padding:0}
      .msf-toggle i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:left .15s}
      .msf-toggle.on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
      .msf-toggle.on i{left:20px;background:#fff}
      .msf-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;align-items:center}
      .msf-logs{margin-top:8px;max-height:260px;overflow:auto;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;font-size:12px;line-height:18px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
      .msf-log{display:flex;gap:8px;padding:2px 0;white-space:pre-wrap;word-break:break-word}
      .msf-log .t{color:var(--dsw-alias-label-tertiary);flex:none}
      .msf-log .d{flex:none;width:1.2em;text-align:center}
      .msf-log.in .d{color:#38bdf8}.msf-log.out .d{color:#c084fc}.msf-log.sys .d{color:#f59e0b}
      .msf-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:6px 0}
      .msf-path{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin-top:2px;word-break:break-all}
    `;

    const CSS_TAG = "dsh-secretary/section.css";
    if (typeof document !== "undefined" && !document.querySelector(`style[data-msf="${CSS_TAG}"]`)) {
      const el = document.createElement("style");
      el.dataset.msf = CSS_TAG;
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    const TEMPLATES = [
      ["gentle", "温柔耐心"],
      ["blunt", "直率干脆"],
      ["work", "简洁工作向"],
      ["playful", "俏皮"],
      ["custom", "只要我写的"],
    ];
    const EMOJIS = [["none", "不用"], ["some", "偶尔"], ["lots", "可以多"]];
    const LANGS = [["zh", "中文"], ["en", "英文"], ["follow", "跟随对方"]];
    const MODES = [["inherit", "继承 DSH 默认"], ["manual", "手动指定"]];
    const LOG_LEVELS = [["info", "全部"], ["warn", "警告以上"], ["error", "仅错误"]];
    const PERMISSION_MODES = [
      ["danger-full-access", "完全权限"],
      ["workspace-write", "工作区可写"],
      ["", "不干预（跟随默认）"],
    ];
    const LEVEL_ORDER = { info: 0, warn: 1, error: 2 };

    function get(obj, path) {
      return path.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
    }
    function setIn(obj, path, value) {
      const keys = path.split(".");
      const next = Array.isArray(obj) ? obj.slice() : { ...obj };
      let cursor = next;
      for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        cursor[key] = cursor[key] == null ? {} : { ...cursor[key] };
        cursor = cursor[key];
      }
      cursor[keys[keys.length - 1]] = value;
      return next;
    }

    function Row(props) {
      return h(
        "div",
        { className: "msf-row" },
        h("div", null, h("div", { className: "msf-label" }, props.label), props.hint ? h("div", { className: "msf-hint" }, props.hint) : null),
        h("div", { className: "msf-ctl" }, props.children),
      );
    }

    function Text(props) {
      return h("input", {
        className: "msf-input",
        value: props.value ?? "",
        placeholder: props.placeholder ?? "",
        onChange: (e) => props.onChange(e.target.value),
        style: props.width ? { minWidth: props.width } : undefined,
      });
    }

    function Num(props) {
      return h("input", {
        className: "msf-input",
        type: "number",
        min: props.min,
        max: props.max,
        step: props.step ?? 1,
        value: props.value ?? 0,
        onChange: (e) => props.onChange(Number(e.target.value)),
        style: { minWidth: 92 },
      });
    }

    function Select(props) {
      return h(
        "select",
        { className: "msf-select", value: props.value, onChange: (e) => props.onChange(e.target.value) },
        props.options.map(([value, label]) => h("option", { key: value, value }, label)),
      );
    }

    function Toggle(props) {
      return h(
        "button",
        {
          type: "button",
          className: `msf-toggle${props.value ? " on" : ""}`,
          onClick: () => props.onChange(!props.value),
          "aria-pressed": props.value,
        },
        h("i"),
      );
    }

    function Area(props) {
      return h("textarea", {
        className: "msf-area",
        rows: props.rows ?? 4,
        value: props.value ?? "",
        placeholder: props.placeholder ?? "",
        onChange: (e) => props.onChange(e.target.value),
      });
    }

    function fmtTime(ms) {
      if (!ms) return "";
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
    }

    function MsfSection() {
      const [data, setData] = useState(null);
      const [draft, setDraft] = useState(null);
      const [busy, setBusy] = useState("");
      const [err, setErr] = useState("");
      const [msg, setMsg] = useState("");
      const [factsDraft, setFactsDraft] = useState("");
      const [logLevel, setLogLevel] = useState("info");
      const [scheduleTitle, setScheduleTitle] = useState("");
      const [scheduleDue, setScheduleDue] = useState("");
      const [repeatKind, setRepeatKind] = useState("none");
      const [repeatTime, setRepeatTime] = useState("22:00");
      const [habitLabel, setHabitLabel] = useState("");
      const [habitCategory, setHabitCategory] = useState("运动");
      const [habitKind, setHabitKind] = useState("weekly");
      const [habitWeekday, setHabitWeekday] = useState(new Date().getDay());
      const [habitTime, setHabitTime] = useState("17:00");
      const [habitLead, setHabitLead] = useState("30");
      const [habitAskEstimate, setHabitAskEstimate] = useState(false);
      const dirty = useRef(false);
      const factsDirty = useRef(false);

      const applyData = useCallback((next) => {
        setData(next);
        if (!dirty.current && next && next.config) setDraft(next.config);
        if (!factsDirty.current && next && next.memory) setFactsDraft(next.memory.facts || "");
      }, []);

      const load = useCallback(async () => {
        try {
          const res = await fetch(`${API}/state`, { cache: "no-store" });
          const json = await res.json();
          if (json.loadError) setErr(json.loadError);
          else setErr("");
          applyData(json);
        } catch (e) {
          setErr(`读取失败：${String(e && e.message ? e.message : e)}`);
        }
      }, [applyData]);

      useEffect(() => {
        load();
        const timer = setInterval(load, 5000);
        return () => clearInterval(timer);
      }, [load]);

      const change = useCallback((path, value) => {
        dirty.current = true;
        setMsg("");
        setDraft((prev) => setIn(prev, path, value));
      }, []);

      const save = useCallback(async () => {
        if (!draft) return;
        setBusy("save");
        setErr("");
        setMsg("");
        try {
          const res = await fetch(`${API}/config`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ config: draft }),
          });
          const json = await res.json();
          if (!json.ok) throw new Error(json.error || "保存失败");
          dirty.current = false;
          setDraft(json.config);
          setData(json);
          setMsg("已保存，下一条消息就生效");
        } catch (e) {
          setErr(String(e && e.message ? e.message : e));
        } finally {
          setBusy("");
        }
      }, [draft]);

      const clearRhythm = useCallback(async () => {
        setBusy("rhythm");
        setErr("");
        try {
          const res = await fetch(`${API}/rhythm`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "clear" }),
          });
          const json = await res.json();
          if (!json.ok) throw new Error(json.error || "清空失败");
          setData((prev) => (prev ? { ...prev, rhythm: json.rhythm } : prev));
          setMsg("作息样本已清空");
        } catch (e) {
          setErr(String(e && e.message ? e.message : e));
        } finally {
          setBusy("");
        }
      }, []);

      const habitAction = useCallback(async (payload) => {
        setBusy("habit");
        setErr("");
        try {
          const res = await fetch(`${API}/habits`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const json = await res.json();
          if (!json.ok) throw new Error(json.error || "操作失败");
          setData((prev) => (prev ? { ...prev, habits: json.habits } : prev));
          return json;
        } catch (e) {
          setErr(String(e && e.message ? e.message : e));
          return null;
        } finally {
          setBusy("");
        }
      }, []);

      const addHabit = useCallback(async () => {
        const label = habitLabel.trim();
        if (!label) return;
        const json = await habitAction({
          action: "add",
          label,
          category: habitCategory,
          rule:
            habitKind === "daily"
              ? { kind: "daily", time: habitTime }
              : { kind: "weekly", time: habitTime, weekday: habitWeekday },
          leadMinutes: Number(habitLead) || 30,
          afterAsk: true,
          askEstimate: habitAskEstimate,
        });
        if (json) {
          setHabitLabel("");
          setHabitAskEstimate(false);
        }
      }, [habitAction, habitLabel, habitCategory, habitKind, habitTime, habitWeekday, habitLead, habitAskEstimate]);

      const scheduleAction = useCallback(async (payload) => {
        setBusy("schedule");
        setErr("");
        try {
          const res = await fetch(`${API}/schedule`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const json = await res.json();
          if (!json.ok) throw new Error(json.error || "操作失败");
          setData((prev) => (prev ? { ...prev, schedule: json.items } : prev));
          setMsg(payload.action === "add" ? "已加入日程" : payload.action === "done" ? "已标记完成" : "已删除");
          return json;
        } catch (e) {
          setErr(String(e && e.message ? e.message : e));
          return null;
        } finally {
          setBusy("");
        }
      }, []);

      const addSchedule = useCallback(async () => {
        const title = scheduleTitle.trim();
        if (!title) return;
        const payload = { action: "add", title, due: scheduleDue || null };
        if (repeatKind !== "none") {
          payload.due = null;
          payload.repeat = {
            kind: repeatKind,
            time: repeatTime,
            ...(repeatKind === "weekly" ? { weekday: new Date().getDay() } : {}),
          };
        }
        const json = await scheduleAction(payload);
        if (json) {
          setScheduleTitle("");
          setScheduleDue("");
          setRepeatKind("none");
        }
      }, [scheduleAction, scheduleTitle, scheduleDue]);

      const runDigest = useCallback(async () => {
        setBusy("digest");
        setErr("");
        setMsg("");
        try {
          const res = await fetch(`${API}/digest`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          const json = await res.json();
          if (!json.ok) throw new Error(json.error || "摘要失败");
          setMsg(json.sent ? "摘要完成，日报已发出" : "摘要完成，但窗口关闭，日报已挂起");
          if (json.config) {
            dirty.current = false;
            setDraft(json.config);
          }
          setData(json);
        } catch (e) {
          setErr(String(e && e.message ? e.message : e));
        } finally {
          setBusy("");
        }
      }, []);

      const saveFacts = useCallback(async () => {
        setBusy("facts");
        setErr("");
        try {
          const res = await fetch(`${API}/memory`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ facts: factsDraft }),
          });
          const json = await res.json();
          if (!json.ok) throw new Error(json.error || "保存失败");
          factsDirty.current = false;
          setData((prev) => (prev ? { ...prev, memory: json.memory } : prev));
          setMsg("事实卡已保存");
        } catch (e) {
          setErr(String(e && e.message ? e.message : e));
        } finally {
          setBusy("");
        }
      }, [factsDraft]);

      const deleteFactLine = useCallback(async (line) => {
        const next = factsDraft
          .split("\n")
          .filter((entry) => entry.trim() !== String(line).trim())
          .join("\n");
        setFactsDraft(next);
        factsDirty.current = false;
        setBusy("facts");
        setErr("");
        try {
          const res = await fetch(`${API}/memory`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ facts: next }),
          });
          const json = await res.json();
          if (!json.ok) throw new Error(json.error || "删除失败");
          setData((prev) => (prev ? { ...prev, memory: json.memory } : prev));
          setMsg("已删除这一条");
        } catch (e) {
          setErr(String(e && e.message ? e.message : e));
        } finally {
          setBusy("");
        }
      }, [factsDraft]);

      const control = useCallback(async (action) => {
        setBusy(action);
        setErr("");
        try {
          const res = await fetch(`${API}/control`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action }),
          });
          const json = await res.json();
          if (!json.ok) throw new Error(json.error || "操作失败");
          if (json.config) {
            dirty.current = false;
            setDraft(json.config);
          }
          setData(json);
          if (action === "start") setMsg("已启动");
          if (action === "stop") setMsg("已停止");
          if (action === "reload-credentials") setMsg("已重新读取凭据");
          if (action === "clear-logs") setMsg("日志已清空");
        } catch (e) {
          setErr(String(e && e.message ? e.message : e));
        } finally {
          setBusy("");
        }
      }, []);

      if (!draft || !data) {
        return h("div", { className: "msf" }, h("h3", { className: "msf-title" }, "秘书鱼"), err ? h("div", { className: "msf-err" }, err) : h("div", { className: "msf-empty" }, "读取中…"));
      }

      const status = data.status || {};
      const providers = data.providers || [];
      const providerOptions = [
        ["", "自动（未指定）"],
        ...(providers.length
          ? providers.map((p) => [p.provider, p.provider])
          : [[draft.model.provider || "deepseek-account", draft.model.provider || "deepseek-account"]]),
      ].filter((entry, index, list) => list.findIndex((other) => other[0] === entry[0]) === index);
      const modelList = (providers.find((p) => p.provider === draft.model.provider) || {}).models || [];

      return h(
        "div",
        { className: "msf" },
        h("h3", { className: "msf-title" }, "秘书鱼"),
        h("p", { className: "msf-intro" }, "微信里的那个机器人。改这里，等于改她的性格和说话方式；改完保存，下一条消息就生效。"),

        h(
          "div",
          { className: "msf-pills" },
          h("span", { className: `msf-pill ${status.running ? "on" : "off"}` }, status.running ? "在线" : "离线"),
          h("span", { className: "msf-pill", title: status.accountId || "", style: { cursor: "default" } }, status.accountId ? "已连接" : "未登录"),
          h(
            "span",
            { className: "msf-pill" },
            status.windowLeftMin == null ? "会话窗口：未知" : `会话窗口：剩 ${status.windowLeftMin} 分钟`,
          ),
          h("span", { className: "msf-pill" }, `${status.provider || "?"} / ${status.model || "?"}`),
          h("span", { className: "msf-pill" }, `已回复 ${status.handled ?? 0} 条`),
          h(
            "span",
            { className: "msf-pill" },
            data.usage ? `今日 ${data.usage.calls} 次 / ${((data.usage.input ?? 0) + (data.usage.output ?? 0)).toLocaleString()} token` : "今日用量：—",
          ),
        ),
        data.loadError ? h("div", { className: "msf-err" }, data.loadError) : null,

        h("div", { className: "msf-group" }, "开关"),
        h(
          "div",
          { className: "msf-rows" },
          h(
            Row,
            { label: "启用秘书鱼", hint: "关掉后她还在线收消息，但不回复。调试时很方便。" },
            h(Toggle, { value: !!draft.enabled, onChange: (v) => change("enabled", v) }),
          ),
        ),

        h("div", { className: "msf-group" }, "人设"),
        h(
          "div",
          { className: "msf-rows" },
          h(Row, { label: "名字" }, h(Text, { value: draft.persona.name, onChange: (v) => change("persona.name", v), width: 130 })),
          h(Row, { label: "自称", hint: "她提到自己时用什么词。" }, h(Text, { value: draft.persona.selfCall, onChange: (v) => change("persona.selfCall", v), width: 110 })),
          h(Row, { label: "怎么叫你" }, h(Text, { value: draft.persona.callUser, onChange: (v) => change("persona.callUser", v), width: 110 })),
          h(Row, { label: "起点模板", hint: "只是起手式，下面的自由文本会盖过它。" }, h(Select, { value: draft.persona.template, options: TEMPLATES, onChange: (v) => change("persona.template", v) })),
          h(
            Row,
            { label: "人格正文", hint: "像给她写一封信：她是谁、怎么说话、在意什么、绝不做什么。" },
            h(Area, { value: draft.persona.text, rows: 5, placeholder: "例：你有点毒舌，但从不敷衍我。我抱怨的时候先顺着我说两句，再给一个具体的建议。", onChange: (v) => change("persona.text", v) }),
          ),
          h(Row, { label: "不许用的词", hint: "用顿号或逗号分隔。" }, h(Text, {
            value: (draft.persona.bannedWords || []).join("、"),
            onChange: (v) => change("persona.bannedWords", v.split(/[、,，]/).map((x) => x.trim()).filter(Boolean)),
            width: 240,
          })),
        ),

        h("div", { className: "msf-group" }, "表达"),
        h(
          "div",
          { className: "msf-rows" },
          h(Row, { label: "回复长度上限", hint: "字数。宁短不长，100–150 比较像真人聊天。" }, h(Num, { value: draft.style.maxChars, min: 20, max: 2000, onChange: (v) => change("style.maxChars", v) })),
          h(Row, { label: "表情" }, h(Select, { value: draft.style.emoji, options: EMOJIS, onChange: (v) => change("style.emoji", v) })),
          h(Row, { label: "语言" }, h(Select, { value: draft.style.language, options: LANGS, onChange: (v) => change("style.language", v) })),
          h(Row, { label: "允许 Markdown", hint: "微信不渲染，默认关；关了会自动清掉符号。" }, h(Toggle, { value: !!draft.style.markdown, onChange: (v) => change("style.markdown", v) })),
        ),

        h("div", { className: "msf-group" }, "行为"),
        h(
          "div",
          { className: "msf-rows" },
          h(Row, { label: "每条都回", hint: "关掉等于「被叫才回」，目前还没有唤醒词，所以会完全不回。" }, h(Toggle, { value: !!draft.behavior.replyToAll, onChange: (v) => change("behavior.replyToAll", v) })),
          h(Row, { label: "免打扰", hint: "这段时间收到消息只记日志，不回复。可跨零点。" },
            h("div", { className: "msf-ctl" },
              h(Text, { value: draft.behavior.quietStart, placeholder: "23:00", onChange: (v) => change("behavior.quietStart", v), width: 76 }),
              h("span", { className: "msf-hint" }, "到"),
              h(Text, { value: draft.behavior.quietEnd, placeholder: "07:00", onChange: (v) => change("behavior.quietEnd", v), width: 76 }),
            )),
          h(Row, { label: "每分钟最多回", hint: "防止刷屏，也防止模型调用失控。" }, h(Num, { value: draft.behavior.perMinute, min: 1, max: 30, onChange: (v) => change("behavior.perMinute", v) })),
          h(Row, { label: "模型失败时说的话" }, h(Text, { value: draft.behavior.fallback, onChange: (v) => change("behavior.fallback", v), width: 240 })),
        ),

        h("div", { className: "msf-group" }, "习惯"),
        h(Row, { label: "从聊天活动里学习惯", hint: "同一件事、同一个星期几，出现三次就建议成习惯。只记录不打扰。" },
          h(Toggle, { value: draft.habits?.learnFromActivities !== false, onChange: (v) => change("habits.learnFromActivities", v) })),
        h(Row, { label: "从聊天里学习惯", hint: "每条消息多一次判断；关掉就只从日程里发现。开启时连关键词都不需要。" },
          h(Toggle, { value: draft.habits?.learnFromChat !== false, onChange: (v) => change("habits.learnFromChat", v) })),
        h(
          "div",
          { className: "msf-rows" },
          ...(data.habits || [])
            .filter((habit) => habit.status === "candidate")
            .map((habit) =>
              h("div", { className: "msf-ctl", key: habit.id, style: { gap: 8, flexWrap: "wrap" } },
                h("span", { className: "msf-hint" }, "待确认"),
                h("strong", null, habit.label),
                h("span", { className: "msf-hint" }, `${habit.rule.kind === "daily" ? "每天" : "每周" + "日一二三四五六"[habit.rule.weekday ?? 0]} ${habit.rule.time}`),
                h("span", { className: "msf-hint" }, `见过 ${habit.evidence.count} 次`),
                h("button", { className: "msf-btn primary", onClick: () => habitAction({ action: "confirm", id: habit.id }), disabled: !!busy }, "确认"),
                h("button", { className: "msf-btn", onClick: () => habitAction({ action: "dismiss", id: habit.id }), disabled: !!busy }, "不要"),
              ),
            ),
          ...(data.habits || [])
            .filter((habit) => habit.status === "active")
            .map((habit) =>
              h("div", { className: "msf-ctl", key: habit.id, style: { gap: 8, flexWrap: "wrap" } },
                h("strong", null, habit.label),
                h("span", { className: "msf-hint" }, habit.category),
                h("span", { className: "msf-hint" }, `${habit.rule.kind === "daily" ? "每天" : "每周" + "日一二三四五六"[habit.rule.weekday ?? 0]} ${habit.rule.time}`),
                h("span", { className: "msf-hint" }, `提前 ${habit.leadMinutes} 分钟`),
                h(Text, {
                  value: String(habit.leadMinutes),
                  onChange: (v) => habitAction({ action: "update", id: habit.id, patch: { leadMinutes: Number(v) || 0 } }),
                  width: 56,
                }),
                h("button", { className: "msf-btn", onClick: () => habitAction({ action: "dismiss", id: habit.id }), disabled: !!busy }, "关闭"),
                h("button", { className: "msf-btn", onClick: () => habitAction({ action: "remove", id: habit.id }), disabled: !!busy }, "删除"),
              ),
            ),
          (data.habits || []).length === 0
            ? h("div", { className: "msf-hint" }, "还没有习惯。你在日程里用「每周三 17:00 滑冰」记几次，她会自己总结出来。")
            : null,
        ),
        h(
          "div",
          { className: "msf-ctl", style: { gap: 8, marginTop: 8, flexWrap: "wrap" } },
          h(Text, { value: habitLabel, placeholder: "滑冰", onChange: setHabitLabel, width: 120 }),
          h(Select, {
            value: habitCategory,
            options: [["运动", "运动"], ["学习", "学习"], ["工作", "工作"], ["社交", "社交"], ["家务", "家务"], ["健康", "健康"], ["其他", "其他"]],
            onChange: setHabitCategory,
          }),
          h(Select, {
            value: habitKind,
            options: [["weekly", "每周"], ["daily", "每天"]],
            onChange: setHabitKind,
          }),
          habitKind === "weekly"
            ? h(Select, {
                value: String(habitWeekday),
                options: [["0", "周日"], ["1", "周一"], ["2", "周二"], ["3", "周三"], ["4", "周四"], ["5", "周五"], ["6", "周六"]],
                onChange: (v) => setHabitWeekday(Number(v)),
              })
            : null,
          h(Text, { value: habitTime, placeholder: "17:00", onChange: setHabitTime, width: 80 }),
          h(Text, { value: habitLead, placeholder: "30", onChange: setHabitLead, width: 56 }),
          h("span", { className: "msf-hint" }, "分钟前提醒"),
          h("button", { className: "msf-btn primary", onClick: addHabit, disabled: !!busy || !habitLabel.trim() }, "添加习惯"),
        ),

        h("div", { className: "msf-group" }, "作息"),
        h(
          "div",
          { className: "msf-rows" },
          h(Row, { label: "作息画像", hint: "从你的消息时间推断作息；只存本地，不进模型上下文。" },
            h(Toggle, { value: !!draft.rhythm.enabled, onChange: (v) => change("rhythm.enabled", v) })),
          h(Row, { label: "手动先验：起床 / 睡觉", hint: "24 小时制（晚上 11 点半写 23:30）。留空则自动推断；填了这里，样本不足 5 天也能启动问候。" },
            h("div", { className: "msf-ctl" },
              h(Text, { value: draft.rhythm.wakeTime, placeholder: "07:40", onChange: (v) => change("rhythm.wakeTime", v), width: 76 }),
              h("span", { className: "msf-hint" }, "起"),
              h(Text, { value: draft.rhythm.sleepTime, placeholder: "23:30", onChange: (v) => change("rhythm.sleepTime", v), width: 76 }),
              h("span", { className: "msf-hint" }, "睡"),
            )),
          h(Row, { label: "写作业时段", hint: "到了这个时段会先问你打算写多久，再按估计间隔催。" },
            h("div", { className: "msf-ctl" },
              h(Text, { value: draft.rhythm.homeworkStart, placeholder: "15:00", onChange: (v) => change("rhythm.homeworkStart", v), width: 76 }),
              h("span", { className: "msf-hint" }, "到"),
              h(Text, { value: draft.rhythm.homeworkEnd, placeholder: "17:00", onChange: (v) => change("rhythm.homeworkEnd", v), width: 76 }),
            )),
          h(Row, { label: "早间问候", hint: "早上只发这一条：问候语 + 今天的日程 + 作息参考。留空则不问候。窗口 90 分钟，错过不补发。" },
            h(Text, { value: draft.rhythm.morningGreeting, placeholder: "07:30", onChange: (v) => change("rhythm.morningGreeting", v), width: 90 })),
          h(Row, { label: "晚间问候", hint: "睡前一条，带今天没做完的事和明天的安排。留空则不发。" },
            h(Text, { value: draft.rhythm.eveningGreeting, placeholder: "23:00", onChange: (v) => change("rhythm.eveningGreeting", v), width: 90 })),
          h(Row, { label: "当前画像", hint: data.rhythm?.canGreet ? "样本够，问候已启用" : "样本不足，自动问候不会启动" },
            h("span", { className: "msf-hint" }, data.rhythm?.description || "还没有样本")),
        ),
        h(
          "div",
          { className: "msf-actions", style: { marginTop: 8 } },
          h("button", { className: "msf-btn", onClick: clearRhythm, disabled: !!busy }, "清空作息样本"),
          h("span", { className: "msf-hint" }, `样本 ${data.rhythm?.samples ?? 0} 天`),
        ),

        h("div", { className: "msf-group" }, "日程"),
        h(
          "div",
          { className: "msf-rows" },
          h(Row, { label: "启用日程", hint: "关掉后不记录、也不提醒。" },
            h(Toggle, { value: !!draft.schedule.enabled, onChange: (v) => change("schedule.enabled", v) })),
          h(Row, { label: "触发词", hint: "微信里以它开头即为新增日程。留空则由她自动判断（每条消息多一次判断）。" },
            h(Text, { value: draft.schedule.triggerWord, onChange: (v) => change("schedule.triggerWord", v), width: 110 })),
          h(Row, { label: "系统通知兜底", hint: "微信窗口关闭时弹 macOS 通知。" },
            h(Toggle, { value: !!draft.schedule.notifyFallback, onChange: (v) => change("schedule.notifyFallback", v) })),
          h(Row, { label: "完成前先确认", hint: "命中某条待办时先问“算完成吗”。默认关；发现她误标完成就打开。" },
            h(Toggle, { value: !!draft.schedule.confirmOnComplete, onChange: (v) => change("schedule.confirmOnComplete", v) })),
        ),
        h(
          "div",
          { className: "msf-rows", style: { marginTop: 6 } },
          (data.schedule || []).length === 0
            ? h("div", { className: "msf-empty" }, "还没有日程。在下面加一条，或在微信里说「记一下：周五交报告」。")
            : (data.schedule || []).map((item) =>
                h(
                  "div",
                  { key: item.id, className: "msf-row" },
                  h(
                    "div",
                    null,
                    h("div", { className: "msf-label" }, item.title),
                    h(
                      "div",
                      { className: "msf-hint" },
                      (item.repeat
                        ? item.repeat.kind === "daily"
                          ? `每天 ${item.repeat.time}`
                          : `每周${"日一二三四五六"[item.repeat.weekday ?? 0]} ${item.repeat.time}`
                        : item.due
                          ? new Date(item.due).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
                          : "无期限") + (item.status === "done" ? " · 已完成" : ""),
                    ),
                  ),
                  h(
                    "div",
                    { className: "msf-ctl" },
                    item.status === "pending"
                      ? h("button", { className: "msf-btn", disabled: !!busy, onClick: () => scheduleAction({ action: "done", id: item.id }) }, "完成")
                      : null,
                    h("button", { className: "msf-btn", disabled: !!busy, onClick: () => scheduleAction({ action: "remove", id: item.id }) }, "删除"),
                  ),
                ),
              ),
        ),
        h(
          "div",
          { className: "msf-actions", style: { marginTop: 8 } },
          h(Text, { value: scheduleTitle, onChange: setScheduleTitle, placeholder: "新日程，例如：交报告", width: 220 }),
          h("input", {
            className: "msf-input",
            type: "datetime-local",
            value: scheduleDue,
            onChange: (e) => setScheduleDue(e.target.value),
            style: { minWidth: 190 },
          }),
          h(Select, {
            value: repeatKind,
            options: [["none", "不重复"], ["daily", "每天"], ["weekly", "每周"]],
            onChange: setRepeatKind,
          }),
          repeatKind !== "none"
            ? h(Text, { value: repeatTime, placeholder: "22:00", onChange: setRepeatTime, width: 80 })
            : null,
          h("button", { className: "msf-btn primary", onClick: addSchedule, disabled: !!busy || !scheduleTitle.trim() }, "添加"),
        ),

        h("div", { className: "msf-group" }, "记忆"),
        h(
          "div",
          { className: "msf-rows" },
          h(Row, { label: "启用记忆", hint: "关掉后每次回复都像第一次见你。" },
            h(Toggle, { value: !!draft.memory.enabled, onChange: (v) => change("memory.enabled", v) })),
          h(Row, { label: "带最近几条原文", hint: "保证接得上话。8 条约等于 4 轮对话。" },
            h(Num, { value: draft.memory.recentCount, min: 4, max: 20, onChange: (v) => change("memory.recentCount", v) })),
          h(Row, { label: "注入事实卡", hint: "长期成立的“你是谁”，每条消息都会带上。" },
            h(Toggle, { value: !!draft.memory.injectFacts, onChange: (v) => change("memory.injectFacts", v) })),
          h(Row, { label: "事实卡上限（字）", hint: "超了会先淘汰最久没被提到的那条。" },
            h(Num, { value: draft.memory.factsLimit, min: 200, max: 1000, onChange: (v) => change("memory.factsLimit", v) })),
          h(Row, { label: "摘要时间", hint: "每日摘要与凌晨日报的时间（日报功能下一步上线）。" },
            h(Text, { value: draft.memory.summaryTime, placeholder: "05:00", onChange: (v) => change("memory.summaryTime", v), width: 90 })),
          h(Row, { label: "周报", hint: "每周固定一天，把最近 7 天的摘要合成一条小结。" },
            h(Toggle, { value: !!draft.memory.weeklyReport, onChange: (v) => change("memory.weeklyReport", v) })),
          h(Row, { label: "周报时间", hint: "到点后 2 小时内补发；本周发过就不再发。" },
            h("div", { className: "msf-ctl" },
              h(Select, {
                value: String(draft.memory.weeklyDay ?? 0),
                options: [["0", "周日"], ["1", "周一"], ["2", "周二"], ["3", "周三"], ["4", "周四"], ["5", "周五"], ["6", "周六"]],
                onChange: (v) => change("memory.weeklyDay", Number(v)),
              }),
              h(Text, { value: draft.memory.weeklyTime, placeholder: "20:00", onChange: (v) => change("memory.weeklyTime", v), width: 84 }),
            )),
          h(Row, { label: "凌晨日报", hint: "摘要完成后发一条“今天记了什么”（下一步上线）。" },
            h(Toggle, { value: !!draft.memory.dailyReport, onChange: (v) => change("memory.dailyReport", v) })),
          h(Row, { label: "按需检索日摘要", hint: "只在命中触发词时才翻旧账，避免每次都塞历史。" },
            h(Toggle, { value: !!draft.memory.retrieveSummaries, onChange: (v) => change("memory.retrieveSummaries", v) })),
          h(Row, { label: "相关记忆检索", hint: "命中触发词时，去翻最近 7 天里相关的原话。" },
            h(Toggle, { value: !!draft.memory.recallEnabled, onChange: (v) => change("memory.recallEnabled", v) })),
          h(Row, { label: "检索最近几天", hint: "原话检索往回翻多少天。越大越能翻到旧事，也越慢一点。" },
            h(Num, { value: draft.memory.recallDays, min: 1, max: 90, onChange: (v) => change("memory.recallDays", v) })),
          h(Row, { label: "最多检索几条" },
            h(Num, { value: draft.memory.recallMaxLines, min: 2, max: 20, onChange: (v) => change("memory.recallMaxLines", v) })),
          h(Row, { label: "检索触发词", hint: "顿号或逗号分隔。命中任一才检索。" },
            h(Text, {
              value: (draft.memory.triggerWords || []).join("、"),
              onChange: (v) => change("memory.triggerWords", v.split(/[、,，]/).map((x) => x.trim()).filter(Boolean)),
              width: 240,
            })),
          h(Row, { label: "事实卡", hint: "关于你的长期事实。可以直接改，改完点保存。" },
            h(Area, {
              value: factsDraft,
              rows: 6,
              placeholder: "例：\n- 称呼：主人\n- 作息：21:00–01:00 活跃\n- 正在做：微信插件「秘书鱼」",
              onChange: (v) => {
                factsDirty.current = true;
                setMsg("");
                setFactsDraft(v);
              },
            })),
          factsDraft
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line, index) =>
              h("div", { className: "msf-ctl", key: `fact-${index}-${line}`, style: { gap: 8, alignItems: "flex-start" } },
                h("span", { className: "msf-hint", style: { flex: 1 } }, line),
                h("button", {
                  className: "msf-btn",
                  onClick: () => deleteFactLine(line),
                  disabled: !!busy,
                }, "删除"),
              ),
            ),
          h(Row, { label: "当前成本", hint: `最近 ${data.memory?.recentCount ?? 0} 条 + 事实卡 ${data.memory?.factsChars ?? 0} 字` },
            h("span", { className: "msf-hint" }, `每条消息约 +${data.memory?.approxExtraTokens ?? 0} token`)),
        ),
        h(
          "div",
          { className: "msf-actions", style: { marginTop: 8 } },
          h("button", { className: "msf-btn primary", onClick: saveFacts, disabled: !!busy }, busy === "facts" ? "保存中…" : "保存事实卡"),
          h("button", { className: "msf-btn", onClick: runDigest, disabled: !!busy || data.digest?.running }, busy === "digest" ? "整理中…" : "立即执行一次摘要"),
          data.digest?.pending ? h("span", { className: "msf-hint" }, "有挂起的日报，下次说话会自动补发") : null,
        ),

        h("div", { className: "msf-group" }, "agent 通道"),
        h(
          "div",
          { className: "msf-rows" },
          h(Row, { label: "启用 !dsh", hint: "⚠️ 打开后，以 !dsh 开头的消息会交给 DSH 的 agent 执行——能给你发微信的人就能在这台电脑上跑命令。默认关闭。" },
            h(Toggle, { value: !!draft.escalation.enabled, onChange: (v) => change("escalation.enabled", v) })),
          h(Row, { label: "触发前缀", hint: "区分大小写。默认 !dsh。" },
            h(Text, { value: draft.escalation.prefix, onChange: (v) => change("escalation.prefix", v), width: 100 })),
          h(Row, { label: "转后台时带上人设", hint: "不打开的话，后台回来的话会是 DSH 助手的口吻，不是秘书鱼的。" },
            h(Toggle, { value: !!draft.escalation.carryPersona, onChange: (v) => change("escalation.carryPersona", v) })),
          h(Row, { label: "转后台时带上最近对话", hint: "把最近几条聊天一起带过去，免得它不知道上下文。" },
            h(Toggle, { value: !!draft.escalation.carryMemory, onChange: (v) => change("escalation.carryMemory", v) })),
          h(Row, { label: "后台权限", hint: "后台 agent 用什么权限跑。改这里比在界面上切会话更可靠。" },
            h(Select, { value: draft.escalation.permissionPreset ?? "", options: PERMISSION_MODES, onChange: (v) => change("escalation.permissionPreset", v) })),
          h(Row, { label: "后台工作目录", hint: "留空用你的用户主目录。" },
            h(Text, { value: draft.escalation.cwd ?? "", placeholder: "/Users/…", onChange: (v) => change("escalation.cwd", v), width: 260 })),
          h(Row, { label: "超时（秒）", hint: "超过这个时间还没跑完，先回你一句，任务会留在 agent 里。" },
            h(Num, { value: draft.escalation.timeoutSec, min: 10, max: 300, onChange: (v) => change("escalation.timeoutSec", v) })),
        ),

        h("div", { className: "msf-group" }, "模型"),
        h(
          "div",
          { className: "msf-rows" },
          h(Row, { label: "用哪个模型", hint: "继承 DSH 的默认模型，不用单独填 key。" }, h(Select, { value: draft.model.mode, options: MODES, onChange: (v) => change("model.mode", v) })),
          draft.model.mode === "manual"
            ? h(
                "div",
                null,
                h(Row, {
                  label: "provider",
                  hint: "留空 = 自动：按账号可用的路由挑。选错了会报缺少凭据。",
                }, h(Select, { value: draft.model.provider, options: providerOptions, onChange: (v) => change("model.provider", v) })),
                h(Row, { label: "model" }, modelList.length
                  ? h(Select, { value: draft.model.model, options: modelList.map((m) => [m, m]), onChange: (v) => change("model.model", v) })
                  : h(Text, { value: draft.model.model, placeholder: "deepseek-flash", onChange: (v) => change("model.model", v), width: 180 })),
              )
            : null,
          h(Row, {
            label: "当前实际使用",
            hint: "设置只是偏好；真正在跑的是这一条。",
          }, h("span", { className: "msf-pill" }, status ? `${status.provider || "?"} / ${status.model || "?"}` : "未运行")),
          h(Row, { label: "temperature", hint: "越高越飘，0.6–0.8 适合聊天。" }, h(Num, { value: draft.model.temperature, min: 0, max: 2, step: 0.1, onChange: (v) => change("model.temperature", v) })),
          h(Row, { label: "maxTokens" }, h(Num, { value: draft.model.maxTokens, min: 50, max: 4000, onChange: (v) => change("model.maxTokens", v) })),
        ),

        h(
          "div",
          { className: "msf-actions" },
          h("button", { className: "msf-btn primary", onClick: save, disabled: !!busy }, busy === "save" ? "保存中…" : "保存"),
          h("button", { className: "msf-btn", onClick: () => control("start"), disabled: !!busy || status.running }, "启动"),
          h("button", { className: "msf-btn", onClick: () => control("stop"), disabled: !!busy || !status.running }, "停止"),
          h("button", { className: "msf-btn", onClick: () => control("reload-credentials"), disabled: !!busy }, "重新读取凭据"),
          msg ? h("span", { className: "msf-msg" }, msg) : null,
        ),
        err ? h("div", { className: "msf-err" }, err) : null,
        data.paths && data.paths.dataDir ? h("div", { className: "msf-path" }, `数据目录：${data.paths.dataDir}`) : null,

        h("div", { className: "msf-group" }, "最近的消息"),
        h(
          "div",
          { className: "msf-actions", style: { marginTop: 4 } },
          h(Select, { value: logLevel, options: LOG_LEVELS, onChange: setLogLevel }),
          h("button", { className: "msf-btn", onClick: () => control("clear-logs"), disabled: !!busy }, "清空"),
          h("button", { className: "msf-btn", onClick: load, disabled: !!busy }, "刷新"),
        ),
        h(
          "div",
          { className: "msf-logs" },
          (data.logs || []).filter((log) => LEVEL_ORDER[log.level || "info"] >= LEVEL_ORDER[logLevel]).length === 0
            ? h("div", { className: "msf-empty" }, "还没有符合该级别的记录。")
            : (data.logs || []).slice().reverse().filter((log) => LEVEL_ORDER[log.level || "info"] >= LEVEL_ORDER[logLevel]).map((log, i) =>
                h(
                  "div",
                  { key: `${log.at}-${i}`, className: `msf-log ${log.dir}` },
                  h("span", { className: "t" }, fmtTime(log.at)),
                  h("span", { className: "d" }, log.dir === "in" ? "←" : log.dir === "out" ? "→" : "!"),
                  h("span", null, log.text),
                  log.rid ? h("span", { className: "t" }, log.rid) : null,
                ),
              ),
        ),
      );
    }

    const inject = ["slots"];
    const NS = "secretary";
    const LABEL = "秘书鱼";

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register({ name: "settings.section", id: NS, order: 7, label: () => LABEL }, MsfSection),
            "secretary: settings section",
          ),
        "secretary: settings section",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.MsfSection = MsfSection;
    return module.exports;
  },
});
