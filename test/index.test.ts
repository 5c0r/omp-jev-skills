import { afterEach, expect, mock, test } from "bun:test";
import type { Judge, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let extensionJudge: Judge = { label: "unavailable", async judge() { throw new Error("no judge model available"); } };
mock.module("@oh-my-pi/pi-coding-agent/judgment", () => ({
  journalJudgmentUsage: () => () => { },
  resolveJudge: () => extensionJudge,
}));
// Install the deterministic Judge mock before importing the extension's static binding.
const { default: extension, findSkills, formatReport, readConfig, recognizeSkillRead, recommendSkill, setConfig, skillSuggestion, skillsFromCommands } =
  await import("../src/index");

const dirs: string[] = [];
afterEach(async () => {
  extensionJudge = { label: "unavailable", async judge() { throw new Error("no judge model available"); } };
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
const commands = [
  { name: "skill:debugging", description: "Investigate runtime failures", source: "skill", path: "/opt/skills/debugging/SKILL.md" },
  { name: "skill:writing", description: "Improve user prose", source: "skill", path: "/opt/skills/writing/SKILL.md" },
  { name: "run", description: "Unrelated command", source: "extension", path: "/opt/skills/run/SKILL.md" },
  { name: "skill:incomplete", description: "No location", source: "skill" },
];
const usage = { input: 8, output: 2, totalTokens: 10, cost: { input: 0.02, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 } };
const judge = (scores: number[]): Judge => ({
  label: "test judge",
  async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
    // Typed boundary for dynamically keyed synthetic transport response.
    return {
      api: "typesafe", provider: "typesafe", model: "jev-latest", usage,
      answers: Object.fromEntries(Object.keys(request.questions).map((id, index) => [id, { type: "noul", noul: scores[index] }]))
    } as unknown as JudgmentResult<Q>;
  },
});

test("only discovered OMP skill commands with canonical locations enter the inventory", () => {
  expect(skillsFromCommands(commands)).toEqual([
    { name: "debugging", description: "Investigate runtime failures", path: "/opt/skills/debugging/SKILL.md", uri: "skill://debugging" },
    { name: "writing", description: "Improve user prose", path: "/opt/skills/writing/SKILL.md", uri: "skill://writing" },
  ]);
});

test("ranks skills per candidate, reports Judge model/cost and recommends only above threshold", async () => {
  const report = await findSkills("investigate a crash", skillsFromCommands(commands), judge([0.92, 0.15]), 0.65, 2000);
  expect(report.results.map(({ name, score, status }) => ({ name, score, status }))).toEqual([
    { name: "debugging", score: 0.92, status: "accepted" },
    { name: "writing", score: 0.15, status: "rejected" },
  ]);
  expect(report.models).toEqual(["typesafe/jev-latest"]);
  expect(report.usage).toEqual({ input: 8, output: 2, cost: 0.02 });
  expect(recommendSkill("writing", report)).toBe("debugging");
  expect(recommendSkill("debugging", report)).toBeUndefined();
  expect(skillSuggestion(report)).toContain("skill://debugging");
});

test("skill diagnostics show top five with omitted counts while retaining full scored inventory", async () => {
  const skills = Array.from({ length: 12 }, (_, index) => ({
    name: `s${index}`, description: `Skill ${index}`, path: `/s${index}/SKILL.md`, uri: `skill://s${index}`,
  }));
  const config = { debug: true, autoSuggest: false, checkCalls: false, threshold: 0.65, timeoutMs: 2000 };
  const mostlyRejected = await findSkills("debug", skills, judge([0.9, ...Array(11).fill(0.1)]), 0.65, 2000);
  const text = formatReport(mostlyRejected, config);
  expect(text).toContain("- skill://s0 90.0% [#########-]");
  expect(text.match(/^rejected:/gm)).toHaveLength(5);
  expect(text).toContain("6 more rejected");
  expect(mostlyRejected.results).toHaveLength(12);
  const allAccepted = await findSkills("debug", skills, judge(Array(12).fill(0.9)), 0.65, 2000);
  const acceptedText = formatReport(allAccepted, config);
  expect(acceptedText.match(/^- skill:\/\//gm)).toHaveLength(5);
  expect(acceptedText).toContain("7 more accepted");
});

test("canonical path stays in results but is not sent to Judge for relevance", async () => {
  const candidate = {
    name: "debugging", description: "Investigate failures",
    path: "/Users/private/repo/SKILL.md", uri: "skill://debugging"
  };
  const bounded: Judge = {
    label: "privacy judge",
    async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      if (JSON.stringify(request.state).includes("/Users/private")) throw new Error("private path leaked");
      return {
        api: "typesafe", provider: "typesafe", model: "jev-latest", usage,
        answers: { skill_0: { type: "noul", noul: 0.9 } }
      } as unknown as JudgmentResult<Q>;
    },
  };
  const report = await findSkills("investigate failures", [candidate], bounded, 0.65, 2000);
  expect(report.results[0].status).toBe("accepted");
  expect(report.results[0].path).toBe("/Users/private/repo/SKILL.md");
});

test("recognizes only known skill URIs and actual loaded SKILL.md reads, not arbitrary tools or paths", () => {
  const skills = skillsFromCommands(commands);
  expect(recognizeSkillRead("read", "skill://debugging/references/help.md", skills)).toBe("debugging");
  expect(recognizeSkillRead("read", "/opt/skills/writing/SKILL.md:3-10", skills)).toBe("writing");
  expect(recognizeSkillRead("write", "skill://debugging", skills)).toBeUndefined();
  expect(recognizeSkillRead("read", "skill://unlisted", skills)).toBeUndefined();
  expect(recognizeSkillRead("read", "/opt/skills/debugging/other.md", skills)).toBeUndefined();
});

test("recognizes namespaced skill URI without matching unknown namespace suffix", () => {
  const skills = skillsFromCommands([
    { name: "skill:superpowers", source: "skill", path: "/skills/base/SKILL.md" },
    { name: "skill:superpowers:using-superpowers", source: "skill", path: "/skills/child/SKILL.md" },
  ]);
  expect(recognizeSkillRead("read", "skill://superpowers:using-superpowers", skills)).toBe("superpowers:using-superpowers");
  expect(recognizeSkillRead("read", "skill://superpowers:using-superpowers/references/start.md", skills)).toBe("superpowers:using-superpowers");
  expect(recognizeSkillRead("read", "skill://superpowers:unknown", skills)).toBeUndefined();
});

test("malformed or failed Judge leaves candidates unjudged and never forces a read", async () => {
  const bad: Judge = {
    label: "bad", async judge<Q extends Questions>(): Promise<JudgmentResult<Q>> {
      return { api: "typesafe", provider: "typesafe", model: "jev", usage, answers: { extraneous: { type: "noul", noul: 2 } } } as unknown as JudgmentResult<Q>;
    }
  };
  const report = await findSkills("debug", skillsFromCommands(commands), bad, 0.65, 2000);
  expect(report.results.every(result => result.status === "unjudged" && result.score === undefined)).toBe(true);
  expect(recommendSkill("writing", report)).toBeUndefined();
  const unavailable = { label: "unavailable", async judge() { throw new Error("no judge model available"); } };
  const failed = await findSkills("debug", skillsFromCommands(commands), unavailable, 0.65, 2000);
  expect(failed.error).toContain("no judge model available");
  expect(failed.results.every(result => result.status === "unjudged")).toBe(true);
});

test("unabortable Judge settles before advisory deadline without blocking skill read", async () => {
  const hung: Judge = {
    label: "hung", judge<Q extends Questions>() {
      return Promise.withResolvers<JudgmentResult<Q>>().promise;
    }
  };
  // Real AbortSignal.timeout plus a permanently pending transport exercises OMP's wall-clock boundary.
  const { promise: safety, reject } = Promise.withResolvers<never>();
  const guard = setTimeout(() => reject(new Error("Judge stayed pending past host budget")), 300);
  try {
    const report = await Promise.race([
      findSkills("debug", skillsFromCommands(commands), hung, 0.65, 20), safety,
    ]);
    expect(report.error).toMatch(/timed out|timeout/i);
    expect(report.results.every(result => result.status === "unjudged")).toBe(true);
    expect(recommendSkill("debugging", report)).toBeUndefined();
    expect(skillSuggestion(report)).toBeUndefined();
  } finally {
    clearTimeout(guard);
  }
});

test("full skill inventory is judged across batches", async () => {
  const skills = Array.from({ length: 21 }, (_, i) => ({ name: `s${i}`, description: `Skill ${i}`, path: `/s${i}/SKILL.md`, uri: `skill://s${i}` }));
  const report = await findSkills("skill", skills, judge(Array(21).fill(0.8)), 0.65, 2000);
  expect(report.results).toHaveLength(21);
  expect(report.results.every(result => result.status === "accepted")).toBe(true);
});

test("later Judge batch failure retains explicit scores but suppresses skill-read advice", async () => {
  let calls = 0;
  const partial: Judge = {
    label: "partial",
    async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      if (++calls === 2) throw new Error("provider unavailable");
      return {
        api: "typesafe", provider: "typesafe", model: "jev-latest", usage,
        answers: Object.fromEntries(Object.keys(request.questions).map((id, index) => [
          id, { type: "noul", noul: index === 1 ? 0.1 : 0.9 },
        ])),
      } as unknown as JudgmentResult<Q>;
    },
  };
  const skills = Array.from({ length: 17 }, (_, index) => ({
    name: `s${index}`, description: `Skill ${index}`, path: `/s${index}/SKILL.md`, uri: `skill://s${index}`,
  }));
  const report = await findSkills("debug", skills, partial, 0.65, 2000);
  expect(report.error).toContain("provider unavailable");
  expect(report.results.filter(result => result.status === "accepted")).toHaveLength(15);
  expect(report.results.find(result => result.name === "s16")?.status).toBe("unjudged");
  expect(recommendSkill("s1", report)).toBeUndefined();
  expect(skillSuggestion(report)).toBeUndefined();
});

test("independent profile config persists concurrent updates and rejects invalid values without clobbering", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-skills-test-")); dirs.push(dir);
  const file = join(dir, "config.json");
  await Promise.all([setConfig(file, "autoSuggest", "true"), setConfig(file, "threshold", "0.75")]);
  expect(await readConfig(file)).toMatchObject({ autoSuggest: true, threshold: 0.75, checkCalls: false });
  const before = await readFile(file, "utf8");
  await expect(setConfig(file, "timeoutMs", "0")).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe(before);
});

test("extension factory does not access Settings before initialization", () => {
  const pi = {
    registerTool: () => { },
    registerCommand: () => { },
    on: () => { },
    getAllTools: () => [],
    getActiveTools: () => [],
    zod: { object: () => ({}), string: () => ({ describe: () => ({}) }) },
    logger: { warn: () => { } },
    pi: { Settings: {} as Record<string, unknown> },
  };
  Object.defineProperty(pi.pi.Settings, "instance", {
    get() { throw new Error("Settings not initialized. Call Settings.init() first."); },
  });
  expect(() => extension(pi as never)).not.toThrow();
});
type BeforeStartHandler = (event: { prompt: string }, ctx: unknown) => Promise<unknown> | unknown;
type LifecycleHandler = (event: unknown, ctx: unknown) => void;
type AsideMessage = {
  payload: { customType?: string; display?: boolean; content?: string };
  options?: { deliverAs?: string };
  afterAgentStart: boolean;
};

function controlledJudge(model: string) {
  const started = Promise.withResolvers<void>();
  const scoresReady = Promise.withResolvers<number[]>();
  let wasStarted = false;
  const controlled: Judge = {
    label: model,
    async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      wasStarted = true;
      started.resolve();
      const scores = await scoresReady.promise;
      return {
        api: "typesafe", provider: "typesafe", model, usage,
        answers: Object.fromEntries(Object.keys(request.questions).map((id, index) => [
          id, { type: "noul", noul: scores[index] },
        ])),
      } as unknown as JudgmentResult<Q>;
    },
  };
  return {
    judge: controlled,
    started: started.promise,
    wasStarted: () => wasStarted,
    resolve: (scores: number[]) => scoresReady.resolve(scores),
  };
}

async function extensionHarness() {
  const dir = await mkdtemp(join(tmpdir(), "jev-skills-extension-"));
  dirs.push(dir);
  const configFile = join(dir, "jev-skills.json");
  let turnRunning = false;
  let beforeStart: BeforeStartHandler | undefined;
  let agentStart: LifecycleHandler | undefined;
  let agentEnd: LifecycleHandler | undefined;
  const activations: string[][] = [];
  const messages: AsideMessage[] = [];
  const messageSent = Promise.withResolvers<AsideMessage>();
  const context = {
    modelRegistry: {},
    sessionManager: { getSessionId: () => "session-1" },
    isIdle: () => !turnRunning,
    hasUI: true,
    ui: { notify: () => { } },
  };
  extension({
    registerTool: () => { },
    registerCommand: () => { },
    on: (name: string, handler: unknown) => {
      if (name === "before_agent_start") beforeStart = handler as BeforeStartHandler;
      if (name === "agent_start") agentStart = handler as LifecycleHandler;
      if (name === "agent_end") agentEnd = handler as LifecycleHandler;
    },
    sendMessage: (payload: AsideMessage["payload"], options?: AsideMessage["options"]) => {
      const entry = { payload, options, afterAgentStart: turnRunning };
      messages.push(entry);
      messageSent.resolve(entry);
    },
    getCommands: () => commands,
    getActiveTools: () => [],
    setActiveTools: async (names: string[]) => { activations.push([...names]); },
    zod: { object: () => ({}), string: () => ({ describe: () => ({}) }) },
    logger: { warn: () => { } },
    pi: { Settings: { instance: { getAgentDir: () => dir } } },
  } as never);
  const prepare = async (prompt: string) => {
    if (!beforeStart) throw new Error("before_agent_start handler missing");
    return beforeStart({ prompt }, context);
  };
  const launch = () => {
    turnRunning = true;
    agentStart?.({}, context);
  };
  return {
    configFile,
    activations,
    messages,
    messageSent: messageSent.promise,
    prepare,
    launch,
    async start(prompt: string) {
      const result = await prepare(prompt);
      launch();
      return result;
    },
    end() {
      turnRunning = false;
      agentEnd?.({ willContinue: false }, context);
    },
  };
}

test("before_agent_start settles under 100ms with a never-resolving Judge", async () => {
  const harness = await extensionHarness();
  await writeFile(harness.configFile, JSON.stringify({ autoSuggest: true, timeoutMs: 1000 }));
  const judgeStarted = Promise.withResolvers<void>();
  extensionJudge = {
    label: "pending",
    judge<Q extends Questions>() {
      judgeStarted.resolve();
      return Promise.withResolvers<JudgmentResult<Q>>().promise;
    },
  };

  const startedAt = performance.now();
  const start = harness.start("debug this issue");
  await judgeStarted.promise;
  const hookResult = await start;
  const elapsedMs = performance.now() - startedAt;
  harness.end();

  expect(hookResult).toBeUndefined();
  expect(elapsedMs).toBeLessThan(100);
});

test("skills suggestions use aside delivery only after agent_start and never force skills", async () => {
  const harness = await extensionHarness();
  await writeFile(harness.configFile, JSON.stringify({ autoSuggest: true }));
  extensionJudge = judge([0.92, 0.15]);

  const hookResult = await harness.start("debug this issue");
  expect(hookResult).toBeUndefined();
  await harness.messageSent;

  expect(harness.messages).toHaveLength(1);
  expect(harness.messages[0].payload).toMatchObject({ customType: "jev-skills-suggestion", display: true });
  expect(harness.messages[0].payload.content).toContain("skill://debugging");
  expect(harness.messages[0].payload.content).not.toContain("/opt/skills");
  expect(harness.messages[0].options).toEqual({ deliverAs: "aside" });
  expect(harness.messages[0].afterAgentStart).toBe(true);
  expect(harness.activations).toEqual([]);
});

test("late Judge result after agent_end is discarded", async () => {
  const harness = await extensionHarness();
  await writeFile(harness.configFile, JSON.stringify({ autoSuggest: true }));
  const pending = controlledJudge("late");
  extensionJudge = pending.judge;

  const start = harness.start("debug this issue");
  await pending.started;
  harness.end();
  pending.resolve([0.92, 0.15]);
  const hookResult = await start;
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(hookResult).toBeUndefined();
  expect(harness.messages).toEqual([]);
  expect(harness.activations).toEqual([]);
});

test("overlapping prompts cancel old Judge work and only current generation delivers", async () => {
  const harness = await extensionHarness();
  await writeFile(harness.configFile, JSON.stringify({ autoSuggest: true }));
  const first = controlledJudge("first");
  const second = controlledJudge("second");
  extensionJudge = first.judge;

  const firstStart = harness.start("debug first prompt");
  await first.started;
  extensionJudge = second.judge;
  const secondStart = harness.start("debug second prompt");
  await second.started;
  first.resolve([0.92, 0.15]);
  second.resolve([0.15, 0.92]);
  const [firstResult, secondResult] = await Promise.all([firstStart, secondStart]);
  expect(firstResult).toBeUndefined();
  expect(secondResult).toBeUndefined();
  await harness.messageSent;
  harness.end();

  expect(harness.messages).toHaveLength(1);
  expect(harness.messages[0].payload.content).toContain("typesafe/second");
  expect(harness.messages[0].payload.content).not.toContain("typesafe/first");
  expect(harness.activations).toEqual([]);
});
test("before A then B binds agent_start to latest generation", async () => {
  const harness = await extensionHarness();
  await writeFile(harness.configFile, JSON.stringify({ autoSuggest: true }));
  const first = controlledJudge("first");
  const second = controlledJudge("second");
  extensionJudge = {
    label: "prompt dispatcher",
    judge<Q extends Questions>(request: JudgmentRequest<Q>) {
      const selected = JSON.stringify(request.state).includes("second prompt") ? second.judge : first.judge;
      return selected.judge(request);
    },
  };

  await harness.prepare("debug first prompt");
  await harness.prepare("debug second prompt");
  harness.launch();

  expect(first.wasStarted()).toBe(false);
  expect(second.wasStarted()).toBe(true);
  second.resolve([0.15, 0.92]);
  await harness.messageSent;
  harness.end();

  expect(harness.messages).toHaveLength(1);
  expect(harness.messages[0].payload.content).toContain("typesafe/second");
  expect(harness.messages[0].payload.content).not.toContain("typesafe/first");
  expect(harness.messages[0].payload.content).toContain("skill://writing");
  expect(harness.activations).toEqual([]);
});
