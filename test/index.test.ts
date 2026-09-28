import { afterEach, expect, test } from "bun:test";
import type { Judge, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../src/index";
import { findSkills, formatReport, readConfig, recognizeSkillRead, recommendSkill, setConfig, skillSuggestion, skillsFromCommands } from "../src/index";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
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
    return { api: "typesafe", provider: "typesafe", model: "jev-latest", usage,
      answers: Object.fromEntries(Object.keys(request.questions).map((id, index) => [id, { type: "noul", noul: scores[index] }])) } as unknown as JudgmentResult<Q>;
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
  const candidate = { name: "debugging", description: "Investigate failures",
    path: "/Users/private/repo/SKILL.md", uri: "skill://debugging" };
  const bounded: Judge = {
    label: "privacy judge",
    async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      if (JSON.stringify(request.state).includes("/Users/private")) throw new Error("private path leaked");
      return { api: "typesafe", provider: "typesafe", model: "jev-latest", usage,
        answers: { skill_0: { type: "noul", noul: 0.9 } } } as unknown as JudgmentResult<Q>;
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
  const bad: Judge = { label: "bad", async judge<Q extends Questions>(): Promise<JudgmentResult<Q>> {
    return { api: "typesafe", provider: "typesafe", model: "jev", usage, answers: { extraneous: { type: "noul", noul: 2 } } } as unknown as JudgmentResult<Q>;
  } };
  const report = await findSkills("debug", skillsFromCommands(commands), bad, 0.65, 2000);
  expect(report.results.every(result => result.status === "unjudged" && result.score === undefined)).toBe(true);
  expect(recommendSkill("writing", report)).toBeUndefined();
  const unavailable = { label: "unavailable", async judge() { throw new Error("no judge model available"); } };
  const failed = await findSkills("debug", skillsFromCommands(commands), unavailable, 0.65, 2000);
  expect(failed.error).toContain("no judge model available");
  expect(failed.results.every(result => result.status === "unjudged")).toBe(true);
});

test("unabortable Judge settles before advisory deadline without blocking skill read", async () => {
  const hung: Judge = { label: "hung", judge<Q extends Questions>() {
    return Promise.withResolvers<JudgmentResult<Q>>().promise;
  } };
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

test("extension factory registers without initialized Settings", () => {
  // Git-install validation runs the factory before Settings.init(); agent-dir access must be deferred.
  const registered: string[] = [];
  const pi = {
    registerTool: () => registered.push("tool"),
    registerCommand: () => registered.push("command"),
    on: () => registered.push("hook"),
    getAllTools: () => [],
    getActiveTools: () => [],
    zod: { object: () => ({}), string: () => ({ describe: () => ({}) }) },
    logger: { warn: () => {} },
    pi: { Settings: {} as Record<string, unknown> },
  };
  Object.defineProperty(pi.pi.Settings, "instance", {
    get() { throw new Error("Settings not initialized. Call Settings.init() first."); },
  });
  expect(() => extension(pi as never)).not.toThrow();
  expect(registered).toEqual(["tool", "command", "command", "hook", "hook"]);
});
