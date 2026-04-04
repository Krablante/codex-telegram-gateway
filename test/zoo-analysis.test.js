import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAnalysisPrompt,
  validateAnalysisPayload,
} from "../src/zoo/analysis.js";

test("validateAnalysisPayload requires all mandatory Zoo stats", () => {
  assert.doesNotThrow(() =>
    validateAnalysisPayload({
      stats: {
        security: 10,
        shitcode: 20,
        junk: 30,
        tests: 40,
        structure: 50,
        docs: 60,
        operability: 70,
      },
    }),
  );

  assert.throws(
    () =>
      validateAnalysisPayload({
        stats: {
          security: 10,
          shitcode: 20,
          junk: 30,
          tests: 40,
          structure: 50,
          docs: 60,
        },
      }),
    /operability/u,
  );
});

test("buildAnalysisPrompt enforces the selected language and creature persona", () => {
  const prompt = buildAnalysisPrompt({
    language: "rus",
    pet: {
      pet_id: "pet-1",
      display_name: "gateway",
      creature_kind: "cat",
      character_name: "Rainbow Dash",
      temperament_id: "paladin",
      cwd: "/workspace/project",
    },
    previousSnapshot: null,
  });

  assert.match(prompt, /All human-readable fields must be written in Russian/u);
  assert.match(prompt, /Ты буквально кот/u);
  assert.match(prompt, /temperament_label/u);
  assert.match(prompt, /стабильный темперамент/u);
  assert.match(prompt, /Rainbow Dash/u);
  assert.match(prompt, /строгий паладин/u);
  assert.match(prompt, /flavor_line should be one short first-person line/u);
  assert.match(prompt, /project_summary should be a separate concise summary/u);
  assert.match(prompt, /Avoid generic assistant tone/u);
});
