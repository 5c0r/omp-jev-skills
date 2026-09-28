import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { cfgExtensionHandlersToolCallTimeoutMs } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { journalJudgmentUsage, resolveJudge } from "@oh-my-pi/pi-coding-agent/judgment";
const defaults = { debug: true, autoSuggest: false, checkCalls: false, threshold: 0.65, timeoutMs: 10000 };
const batchSize = 16;
export function skillsFromCommands(commands) {
    return commands
        .filter(command => command.source === "skill" && command.name.startsWith("skill:")
        && command.name.length > 6 && typeof command.path === "string" && command.path.length > 0)
        .map(command => ({
        name: command.name.slice(6), description: command.description ?? "",
        path: command.path, uri: `skill://${command.name.slice(6)}`,
    }));
}
export function recognizeSkillRead(toolName, readPath, skills) {
    if (toolName !== "read")
        return undefined;
    let matched;
    for (const skill of skills) {
        const suffix = readPath.startsWith(skill.uri) ? readPath.slice(skill.uri.length) : undefined;
        const uriRead = suffix !== undefined && (suffix === "" || suffix.startsWith("/")
            || /^:(?:\d|raw(?::|$)|img(?::|$)|conflicts(?::|$))/.test(suffix));
        const fileRead = readPath === skill.path || readPath.startsWith(`${skill.path}:`);
        if ((uriRead || fileRead) && (!matched || skill.uri.length > matched.uri.length))
            matched = skill;
    }
    return matched?.name;
}
function settleOnAbort(work, signal) {
    if (signal.aborted)
        return Promise.reject(signal.reason);
    const { promise, resolve, reject } = Promise.withResolvers();
    const onAbort = () => reject(signal.reason ?? new Error("Judge aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(value => { signal.removeEventListener("abort", onAbort); resolve(value); }, cause => { signal.removeEventListener("abort", onAbort); reject(cause); });
    return promise;
}
export async function findSkills(task, skills, judge, threshold, timeoutMs, externalSignal) {
    const started = Date.now();
    const results = skills.map(skill => ({ ...skill, status: "unjudged" }));
    const models = [];
    let usage;
    let error;
    const signal = externalSignal
        ? AbortSignal.any([externalSignal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
    for (let offset = 0; offset < results.length; offset += batchSize) {
        const batch = results.slice(offset, offset + batchSize);
        const questions = Object.fromEntries(batch.map((_, index) => [
            `skill_${index}`, { type: "noul", instructions: `Would skill_${index} help accomplish the user's task? Judge relevance, not whether to load it.` },
        ]));
        try {
            if (signal.aborted)
                throw signal.reason;
            const response = await settleOnAbort(judge.judge({
                state: JSON.stringify({ task, skills: batch.map((skill, index) => ({
                        id: `skill_${index}`, name: skill.name, description: skill.description,
                    })) }),
                questions,
            }, { signal }), signal);
            const answers = response.answers;
            if (!answers || typeof answers !== "object" || Array.isArray(answers)
                || Object.keys(answers).length !== batch.length
                || typeof response.provider !== "string" || !response.provider
                || typeof response.model !== "string" || !response.model) {
                throw new Error("Judge returned malformed answer IDs or model");
            }
            // Validate whole batch before applying scores: missing/malformed never counts as zero.
            const indexed = answers;
            const scores = batch.map((_, index) => {
                const answer = indexed[`skill_${index}`];
                if (!answer || typeof answer !== "object" || Array.isArray(answer)
                    || !("type" in answer) || answer.type !== "noul"
                    || !("noul" in answer) || typeof answer.noul !== "number"
                    || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
                    throw new Error(`Judge returned invalid score for skill_${index}`);
                }
                return answer.noul;
            });
            scores.forEach((score, index) => {
                batch[index].score = score;
                batch[index].status = score >= threshold ? "accepted" : "rejected";
            });
            const model = `${response.provider}/${response.model}`;
            if (!models.includes(model))
                models.push(model);
            const reported = response.usage;
            if (reported && Number.isFinite(reported.input) && Number.isFinite(reported.output)
                && Number.isFinite(reported.cost?.total)) {
                usage = {
                    input: (usage?.input ?? 0) + reported.input,
                    output: (usage?.output ?? 0) + reported.output,
                    cost: (usage?.cost ?? 0) + reported.cost.total,
                };
            }
        }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
            break;
        }
    }
    results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    return { results, models, usage, elapsedMs: Date.now() - started, error };
}
export function recommendSkill(chosen, report) {
    if (report.error)
        return undefined;
    const current = report.results.find(result => result.name === chosen);
    const best = report.results.find(result => result.status === "accepted");
    return current?.status === "rejected" && best && best.name !== chosen ? best.name : undefined;
}
export function skillSuggestion(report) {
    if (report.error)
        return undefined;
    // ponytail: Show top three only after judging whole inventory; expand display if needed.
    const picks = report.results.filter(result => result.status === "accepted").slice(0, 3);
    if (!picks.length)
        return undefined;
    return `Optional skill suggestions (Judge ${report.models.join(", ")}, advisory only): ${picks.map(pick => `${pick.uri} ${(pick.score * 100).toFixed(1)}%`).join(", ")}. Load only if useful.`;
}
function parseValue(key, value) {
    if (!Object.hasOwn(defaults, key))
        throw new Error(`Unknown setting: ${key}`);
    if (key === "debug" || key === "autoSuggest" || key === "checkCalls") {
        if (value !== "true" && value !== "false")
            throw new Error(`${key} must be true or false`);
        return value === "true";
    }
    const number = Number(value);
    if (!value.trim() || !Number.isFinite(number))
        throw new Error(`${key} must be a finite number`);
    if (key === "threshold" && (number < 0 || number > 1))
        throw new Error("threshold must be between 0 and 1");
    if (key === "timeoutMs" && (!Number.isInteger(number) || number < 100 || number > 20000)) {
        throw new Error("timeoutMs must be an integer between 100 and 20000");
    }
    return number;
}
export async function readConfig(file) {
    let raw;
    try {
        raw = await readFile(file, "utf8");
    }
    catch (cause) {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
            return { ...defaults };
        throw cause;
    }
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid Jev skills config: expected object");
    }
    const config = { ...defaults };
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry !== "boolean" && typeof entry !== "number")
            throw new Error(`Invalid Jev skills config: ${key}`);
        const parsed = parseValue(key, String(entry));
        if (parsed !== entry)
            throw new Error(`Invalid Jev skills config: ${key}`);
        Object.assign(config, { [key]: parsed });
    }
    return config;
}
export async function setConfig(file, key, value) {
    const parsed = parseValue(key, value);
    await mkdir(dirname(file), { recursive: true });
    const lock = `${file}.lock`;
    let handle;
    for (let attempt = 0; attempt < 80; attempt++) {
        try {
            handle = await open(lock, "wx", 0o600);
            break;
        }
        catch (cause) {
            if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST"))
                throw cause;
            await pause(25);
        }
    }
    // ponytail: Crash leaves lock; fail closed after 2s. Clear stale lock manually;
    // upgrade to OS advisory locking if automatic recovery becomes necessary.
    if (!handle)
        throw new Error(`Jev skills config busy: ${lock}`);
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
        const config = { ...await readConfig(file), [key]: parsed };
        await writeFile(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
        await rename(temp, file);
        return config;
    }
    finally {
        await unlink(temp).catch(cause => {
            if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
                throw cause;
        });
        await handle.close();
        await unlink(lock);
    }
}
export function formatReport(report, config) {
    const lines = [`Skills · threshold ${config.threshold} · ${report.elapsedMs}ms`];
    if (report.error)
        lines.push(`Judge unavailable: ${report.error}`);
    lines.push(`Model: ${report.models.join(", ") || "unavailable"}`);
    lines.push(report.usage
        ? `Tokens: ${report.usage.input} in / ${report.usage.output} out · Cost: $${report.usage.cost.toFixed(6)}`
        : "Tokens/cost: unavailable");
    // ponytail: Five per group fits TUI; use an expandable renderer if deeper inspection is needed.
    const limit = 5;
    const accepted = report.results.filter(result => result.status === "accepted");
    if (!accepted.length)
        lines.push("No confident skill match (or no discovered skill commands).");
    for (const skill of accepted.slice(0, limit)) {
        const score = skill.score;
        lines.push(`- ${skill.uri} ${(score * 100).toFixed(1)}% [${"#".repeat(Math.round(score * 10)).padEnd(10, "-")}] ${skill.description}`);
        lines.push(`  path: ${skill.path}`);
    }
    if (accepted.length > limit)
        lines.push(`${accepted.length - limit} more accepted (omitted from display)`);
    if (config.debug) {
        const rejected = report.results.filter(result => result.status === "rejected");
        for (const skill of rejected.slice(0, limit))
            lines.push(`rejected: ${skill.uri} ${(skill.score * 100).toFixed(1)}%`);
        if (rejected.length > limit)
            lines.push(`${rejected.length - limit} more rejected (omitted from display)`);
        const unjudged = report.results.filter(result => result.status === "unjudged");
        for (const skill of unjudged.slice(0, limit))
            lines.push(`unjudged: ${skill.uri}`);
        if (unjudged.length > limit)
            lines.push(`${unjudged.length - limit} more unjudged (omitted from display)`);
    }
    return lines.join("\n");
}
export default function (pi) {
    const configFile = join(pi.pi.Settings.instance.getAgentDir(), "jev-skills.json");
    let lastTask;
    const judgeFor = (ctx) => resolveJudge({
        settings: pi.pi.Settings.instance, registry: ctx.modelRegistry,
        sessionId: ctx.sessionManager.getSessionId(),
        onUsage: journalJudgmentUsage(ctx.sessionManager, "jev-skills"),
    });
    const run = async (task, config, ctx, signal) => findSkills(task, skillsFromCommands(pi.getCommands()), judgeFor(ctx), config.threshold, config.timeoutMs, signal);
    pi.registerTool({
        name: "jev_skills", label: "Jev Skill Finder",
        description: "Rank discovered OMP skills for a task with native Judge confidence; never loads suggested skills.",
        approval: "read",
        loadMode: "essential",
        parameters: pi.zod.object({ task: pi.zod.string().describe("Task needing a skill") }),
        async execute(_id, { task }, signal, _update, ctx) {
            if (!task.trim())
                return { content: [{ type: "text", text: "Task required." }] };
            try {
                const config = await readConfig(configFile);
                return { content: [{ type: "text", text: formatReport(await run(task, config, ctx, signal), config) }] };
            }
            catch (cause) {
                return { content: [{ type: "text", text: `Jev skills finder unavailable: ${cause instanceof Error ? cause.message : String(cause)}` }] };
            }
        },
    });
    pi.registerCommand("jev-skills", {
        description: "Find relevant discovered skills: /jev-skills <task>",
        async handler(args, ctx) {
            if (!args.trim())
                return ctx.ui.notify("Usage: /jev-skills <task>", "warning");
            try {
                const config = await readConfig(configFile);
                ctx.ui.notify(formatReport(await run(args, config, ctx), config), "info");
            }
            catch (cause) {
                ctx.ui.notify(`Jev skills finder unavailable: ${cause instanceof Error ? cause.message : String(cause)}`, "error");
            }
        },
    });
    pi.registerCommand("jev-skills-config", {
        description: "Show or set Jev skills config: /jev-skills-config [status|set <key> <value>]",
        async handler(args, ctx) {
            try {
                const parts = args.trim().split(/\s+/);
                if (!args.trim() || parts[0] === "show" || parts[0] === "status") {
                    ctx.ui.notify(`${configFile}\n${JSON.stringify(await readConfig(configFile), null, 2)}`, "info");
                }
                else if (parts[0] === "set" && parts.length === 3) {
                    ctx.ui.notify(JSON.stringify(await setConfig(configFile, parts[1], parts[2]), null, 2), "info");
                }
                else {
                    ctx.ui.notify("Usage: /jev-skills-config [status|set <debug|autoSuggest|checkCalls|threshold|timeoutMs> <value>]", "warning");
                }
            }
            catch (cause) {
                ctx.ui.notify(`Jev skills config: ${cause instanceof Error ? cause.message : String(cause)}`, "error");
            }
        },
    });
    pi.on("before_agent_start", async (event, ctx) => {
        lastTask = { sessionId: ctx.sessionManager.getSessionId(), prompt: event.prompt };
        try {
            const config = await readConfig(configFile);
            if (!config.autoSuggest || !event.prompt.trim())
                return;
            const suggestion = skillSuggestion(await run(event.prompt, config, ctx));
            if (!suggestion)
                return;
            return { message: { customType: "jev-skills-suggestion", display: true, content: suggestion } };
        }
        catch (cause) {
            pi.logger.warn("Jev skills suggestion unavailable", { error: cause instanceof Error ? cause.message : String(cause) });
        }
    });
    pi.on("tool_call", async (event, ctx) => {
        try {
            const config = await readConfig(configFile);
            if (!config.checkCalls || event.toolName !== "read")
                return;
            const readPath = event.input.path;
            if (typeof readPath !== "string")
                return;
            const skills = skillsFromCommands(pi.getCommands());
            const chosen = recognizeSkillRead(event.toolName, readPath, skills);
            if (!chosen)
                return;
            const task = lastTask?.sessionId === ctx.sessionManager.getSessionId() ? lastTask.prompt : undefined;
            if (!task)
                return;
            const hostCap = cfgExtensionHandlersToolCallTimeoutMs.get(pi.pi.Settings.instance);
            // ponytail: Skip advisory if host gives under 500ms; keep a 500ms margin for hook cleanup.
            if (hostCap <= 500)
                return;
            const report = await findSkills(task, skills, judgeFor(ctx), config.threshold, Math.min(config.timeoutMs, hostCap - 500));
            const better = recommendSkill(chosen, report);
            if (better && ctx.hasUI) {
                ctx.ui.notify(`Jev skills advisory: ${chosen} scored below ${config.threshold}; ${better} scored higher. Original read proceeds unchanged.`, "warning");
            }
        }
        catch (cause) {
            pi.logger.warn("Jev skills check unavailable", { error: cause instanceof Error ? cause.message : String(cause) });
        }
    });
}
