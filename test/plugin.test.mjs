import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/** Codex Plugin資材とnpm manifestをrepository相対で検査するproject root。 */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Pluginへ登録するSkill名と、公開に必要なmetadata pathの対応。 */
const pluginSkillNames = ["configure-pixarium-worker", "migrate-to-pixarium", "use-pixarium"];

/**
 * 目的: 同じリポジトリで管理するPlugin資材がnpm archiveの対象から分離されることを保証する。
 * 対象: package manifestのfiles allowlistとCodex PluginのSkill path。
 * 前提: Pluginはrepository rootにあり、npm packageはdistとREADMEだけを公開する。
 */
test("Codex Plugin assets stay outside the npm package allowlist", async () => {
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const pluginJson = JSON.parse(
    await readFile(path.join(projectRoot, ".codex-plugin", "plugin.json"), "utf8"),
  );

  assert.deepEqual(packageJson.files, ["dist/", "README.md"]);
  assert.equal(pluginJson.skills, "./skills/");
  assert.equal(pluginJson.mcpServers, undefined);
});

/**
 * 目的: 各Plugin SkillがCodex表示metadataとともに配布されることを保証する。
 * 対象: Skillごとの`SKILL.md`と`agents/openai.yaml`。
 * 前提: Plugin manifestのskills pathはrepository rootの`skills/`を指す。
 */
test("every Pixarium Plugin Skill includes Codex metadata", async () => {
  for (const skillName of pluginSkillNames) {
    const skillRoot = path.join(projectRoot, "skills", skillName);
    const [skill, metadata] = await Promise.all([
      readFile(path.join(skillRoot, "SKILL.md"), "utf8"),
      readFile(path.join(skillRoot, "agents", "openai.yaml"), "utf8"),
    ]);
    assert.match(skill, new RegExp(`^---\\nname: ${skillName}\\n`));
    assert.match(metadata, new RegExp(`\\$${skillName}`));
  }
});
