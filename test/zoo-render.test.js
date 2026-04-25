import test from "node:test";
import assert from "node:assert/strict";

import { renderTelegramHtml } from "../src/transport/telegram-reply-normalizer.js";
import {
  getZooPetTemperamentLabel,
  pickZooCharacterName,
} from "../src/zoo/creatures.js";
import {
  buildZooPetMarkup,
  buildZooPetText,
  buildZooRootText,
  buildZooRootMarkup,
  buildZooRootMarkupPage,
} from "../src/zoo/render.js";

test("buildZooPetText renders pose and stats as fenced code blocks and hides findings", () => {
  const text = buildZooPetText({
    language: "rus",
    pet: {
      pet_id: "pet-1",
      display_name: "gateway",
      creature_kind: "cat",
      temperament_id: "paladin",
      cwd_relative_to_workspace_root: "homelab/infra/automation/codex-telegram-gateway",
    },
    snapshot: {
      mood: "спокойный",
      flavor_line: "Тихо шуршу по самому длинному файлу.",
      project_summary: "Хорошо собранный проект с сильными тестами.",
      next_focus: "Разгрузить самый крупный роутер.",
      findings: ["не показывай меня в карточке"],
      refreshed_at: "2026-04-03T23:45:08.000Z",
      stats: {
        security: 85,
        shitcode: 18,
        junk: 12,
        tests: 98,
        structure: 93,
        docs: 92,
        operability: 95,
      },
      trends: {
        security: "same",
        shitcode: "same",
        junk: "same",
        tests: "same",
        structure: "same",
        docs: "same",
        operability: "same",
      },
    },
    state: {
      selected_pet_id: "pet-1",
      refreshing_pet_id: null,
      last_refresh_error_text: null,
    },
  });

  assert.doesNotMatch(text, /Project Zoo/u);
  assert.match(text, /```txt/u);
  assert.doesNotMatch(text, /Наблюдения/u);
  assert.doesNotMatch(text, /не показывай меня/u);
  assert.match(text, /Щиткод/u);
  assert.match(text, />> моё настроение: спокойный/u);
  assert.match(text, />> голос: Тихо шуршу по самому длинному файлу\./u);
  assert.match(text, />> суть: Хорошо собранный проект с сильными тестами\./u);
  assert.match(
    text,
    new RegExp(`кот · ${getZooPetTemperamentLabel({ pet_id: "pet-1", creature_kind: "cat", temperament_id: "paladin" }, "rus")}`, "u"),
  );
  assert.match(text, />> проект: gateway/u);
  assert.ok(text.indexOf(">> проект: gateway") > text.indexOf(">> следующий фокус: Разгрузить самый крупный роутер."));
  assert.ok(text.indexOf(">> проект: gateway") < text.indexOf(">> репо: homelab/infra/automation/codex-telegram-gateway"));
  assert.doesNotMatch(text, /"Тихо шуршу/u);
  assert.doesNotMatch(text, new RegExp(`^${pickZooCharacterName("pet-1")}$`, "mu"));

  const html = renderTelegramHtml(text);
  const preCount = Array.from(html.matchAll(/<pre>/gu)).length;
  assert.equal(preCount, 1);
  assert.match(html, /<blockquote expandable>моё настроение: спокойный/u);
  assert.match(html, /голос: Тихо шуршу по самому длинному файлу\./u);
});

test("Zoo render keeps buttons in English for every UI language", () => {
  assert.deepEqual(
    buildZooPetMarkup("pet-1", { language: "rus" }).inline_keyboard[0].map((button) => button.text),
    ["Refresh", "Remove"],
  );
  assert.deepEqual(
    buildZooRootMarkup([], "eng").inline_keyboard.at(-1).map((button) => button.text),
    ["Add project", "Respawn menu"],
  );
});

test("Zoo root markup paginates after six pets", () => {
  const pets = Array.from({ length: 6 }, (_, index) => ({
    pet_id: `pet-${index + 1}`,
    display_name: `project-${index + 1}`,
  }));

  const firstPageMarkup = buildZooRootMarkupPage(pets, "eng", {
    currentPage: 0,
    totalPages: 2,
  });
  assert.deepEqual(
    firstPageMarkup.inline_keyboard.at(-2).map((button) => button.text),
    ["Next ›"],
  );

  const middlePageMarkup = buildZooRootMarkupPage(pets, "eng", {
    currentPage: 1,
    totalPages: 3,
  });
  assert.deepEqual(
    middlePageMarkup.inline_keyboard.at(-2).map((button) => button.text),
    ["‹ Back", "Next ›"],
  );

  const lastPageMarkup = buildZooRootMarkupPage(pets, "eng", {
    currentPage: 1,
    totalPages: 2,
  });
  assert.deepEqual(
    lastPageMarkup.inline_keyboard.at(-2).map((button) => button.text),
    ["‹ Back"],
  );
});

test("Zoo root markup keeps public/private suffixes visible on long duplicate names", () => {
  const markup = buildZooRootMarkupPage([
    {
      pet_id: "pet-private",
      display_name: "codex-telegram-gateway [priv]",
    },
    {
      pet_id: "pet-public",
      display_name: "codex-telegram-gateway [pub]",
    },
  ], "eng", {
    currentPage: 0,
    totalPages: 1,
  });

  assert.equal(markup.inline_keyboard[0][0].text, "codex-telegram... [priv]");
  assert.equal(markup.inline_keyboard[0][1].text, "codex-telegram-... [pub]");
});

test("buildZooRootText renders pending add-project confirmation inside the menu", () => {
  const text = buildZooRootText({
    language: "rus",
    pets: [],
    state: {
      active_screen: "root",
      selected_pet_id: null,
      pending_add: {
        stage: "await_confirmation",
        busy: false,
        candidate_path: "/srv/codex-workspace/project-a",
        candidate_reason: "Похоже на нужный приватный gateway.",
        candidate_question: "Это нужный проект? Ответь Да или Нет.",
      },
    },
  });

  assert.match(text, /добавление проекта:/u);
  assert.match(text, /\/srv\/codex-workspace\/project-a/u);
  assert.match(text, /Ответь Да или Нет/u);
});

test("buildZooRootText does not duplicate the pet roster in plain text", () => {
  const text = buildZooRootText({
    language: "rus",
    pets: [
      { pet_id: "pet-1", display_name: "gateway-a" },
      { pet_id: "pet-2", display_name: "gateway-b" },
    ],
    totalPetCount: 2,
    state: {
      active_screen: "root",
      selected_pet_id: null,
    },
  });

  assert.match(text, /питомцы: 2/u);
  assert.doesNotMatch(text, /Команда:/u);
  assert.doesNotMatch(text, /gateway-a/u);
  assert.doesNotMatch(text, /gateway-b/u);
});

test("buildZooPetText does not suggest refresh while the first refresh is already running", () => {
  const text = buildZooPetText({
    language: "rus",
    pet: {
      pet_id: "pet-1",
      display_name: "gateway",
      creature_kind: "cat",
      cwd_relative_to_workspace_root: "homelab/infra/automation/codex-telegram-gateway",
    },
    snapshot: null,
    state: {
      selected_pet_id: "pet-1",
      refreshing_pet_id: "pet-1",
      refresh_status_text: "Анализирую весь проект...",
      last_refresh_error_text: null,
    },
  });

  assert.match(text, /Собираю первый снимок/u);
  assert.doesNotMatch(text, /Нажми Refresh/u);
  assert.match(text, /Щиткод\s+\[\.\.\.\.\.\.\.\.\.\.\]\s+--\s+·/u);
  assert.match(text, />> статус: Анализирую весь проект/u);
});

test("buildZooPetText switches from generic start text to temperament voice on later refresh frames", () => {
  const text = buildZooPetText({
    language: "rus",
    pet: {
      pet_id: "pet-1",
      display_name: "gateway",
      creature_kind: "cat",
      cwd_relative_to_workspace_root: "homelab/infra/automation/codex-telegram-gateway",
    },
    snapshot: null,
    state: {
      selected_pet_id: "pet-1",
      refreshing_pet_id: "pet-1",
      refresh_status_text: "Анализирую весь проект...",
      last_refresh_error_text: null,
    },
    poseFrameIndex: 1,
  });

  assert.match(text, />> статус:/u);
  assert.doesNotMatch(text, />> статус: Анализирую весь проект/u);
});

test("buildZooPetText keeps placeholder stats in the unified card before the first snapshot exists", () => {
  const text = buildZooPetText({
    language: "rus",
    pet: {
      pet_id: "pet-new",
      display_name: "gateway",
      creature_kind: "cat",
      cwd_relative_to_workspace_root: "homelab/infra/automation/codex-telegram-gateway",
    },
    snapshot: null,
    state: {
      selected_pet_id: "pet-new",
      refreshing_pet_id: null,
      last_refresh_error_text: null,
    },
  });

  const html = renderTelegramHtml(text);
  const preCount = Array.from(html.matchAll(/<pre>/gu)).length;
  assert.equal(preCount, 1);
  assert.match(text, /Безопасность\s+\[\.\.\.\.\.\.\.\.\.\.\]\s+--\s+·/u);
  assert.match(text, /Щиткод\s+\[\.\.\.\.\.\.\.\.\.\.\]\s+--\s+·/u);
});

test("buildZooPetText renders arrows for changed stats and keeps equals for unchanged ones", () => {
  const text = buildZooPetText({
    language: "rus",
    pet: {
      pet_id: "pet-trends",
      display_name: "gateway",
      creature_kind: "cat",
      cwd_relative_to_workspace_root: "homelab/infra/automation/codex-telegram-gateway",
    },
    snapshot: {
      mood: "боевой",
      flavor_line: "Сегодня я копаюсь в свежем diff.",
      project_summary: "Кодовая база живая и меняется.",
      next_focus: "Дожать несколько мелких шероховатостей.",
      findings: [],
      refreshed_at: "2026-04-04T12:40:00.000Z",
      stats: {
        security: 81,
        shitcode: 12,
        junk: 9,
        tests: 96,
        structure: 95,
        docs: 97,
        operability: 87,
      },
      trends: {
        security: "up",
        shitcode: "down",
        junk: "same",
        tests: "up",
        structure: "same",
        docs: "down",
        operability: "up",
      },
    },
    state: {
      selected_pet_id: "pet-trends",
      refreshing_pet_id: null,
      last_refresh_error_text: null,
    },
  });

  assert.match(text, /Безопасность\s+\[########\.\.\]\s+81\s+↑/u);
  assert.match(text, /Щиткод\s+\[#\.\.\.\.\.\.\.\.\.\]\s+12\s+↓/u);
  assert.match(text, /Мусор\s+\[#\.\.\.\.\.\.\.\.\.\]\s+\s*9\s+=/u);
});

test("buildZooPetText uses temperament-stable refresh voice for different pets", () => {
  const firstText = buildZooPetText({
    language: "eng",
    pet: {
      pet_id: "pet-1",
      display_name: "gateway",
      creature_kind: "cat",
      cwd_relative_to_workspace_root: "homelab/infra/automation/codex-telegram-gateway",
    },
    snapshot: null,
    state: {
      selected_pet_id: "pet-1",
      refreshing_pet_id: "pet-1",
      refresh_status_text: null,
      last_refresh_error_text: null,
    },
  });
  const secondText = buildZooPetText({
    language: "eng",
    pet: {
      pet_id: "pet-6",
      display_name: "gateway",
      creature_kind: "cat",
      cwd_relative_to_workspace_root: "homelab/infra/automation/codex-telegram-gateway",
    },
    snapshot: null,
    state: {
      selected_pet_id: "pet-6",
      refreshing_pet_id: "pet-6",
      refresh_status_text: null,
      last_refresh_error_text: null,
    },
  });

  const firstStatusLine = firstText.split("\n").find((line) => line.startsWith(">> status: "));
  const secondStatusLine = secondText.split("\n").find((line) => line.startsWith(">> status: "));

  assert.ok(firstStatusLine);
  assert.ok(secondStatusLine);
  assert.notEqual(firstStatusLine, secondStatusLine);
});
