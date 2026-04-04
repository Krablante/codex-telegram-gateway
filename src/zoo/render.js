import { DEFAULT_UI_LANGUAGE, normalizeUiLanguage } from "../i18n/ui-language.js";
import {
  getZooCreatureLabel,
  getZooPoseLines,
  getZooPetRefreshStatus,
  getZooPetTemperamentLabel,
} from "./creatures.js";

export const ZOO_COMMAND = "zoo";
export const ZOO_CALLBACK_PREFIX = "zoo";
export const ZOO_DEFAULT_TOPIC_NAME = "Zoo";
export const ZOO_ROOT_PAGE_SIZE = 6;

const STAT_DEFS = [
  {
    id: "security",
    labels: { eng: "Security", rus: "Безопасность" },
  },
  {
    id: "shitcode",
    labels: { eng: "Shitcode", rus: "Щиткод" },
  },
  {
    id: "junk",
    labels: { eng: "Junk", rus: "Мусор" },
  },
  {
    id: "tests",
    labels: { eng: "Tests", rus: "Тесты" },
  },
  {
    id: "structure",
    labels: { eng: "Structure", rus: "Структура" },
  },
  {
    id: "docs",
    labels: { eng: "Docs", rus: "Документация" },
  },
  {
    id: "operability",
    labels: { eng: "Operability", rus: "Эксплуатация" },
  },
];

function isEnglish(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng";
}

function truncateLine(text, maxLength = 48) {
  const normalized = String(text || "").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function truncatePetButtonLabel(text, maxLength = 24) {
  const normalized = String(text || "").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const qualifierMatch = normalized.match(/^(.*)\s(\[(?:pub|priv)\])$/u);
  if (!qualifierMatch) {
    return truncateLine(normalized, maxLength);
  }

  const [, baseName, qualifier] = qualifierMatch;
  const suffix = ` ${qualifier}`;
  const available = maxLength - suffix.length;
  if (available <= 3) {
    return truncateLine(normalized, maxLength);
  }

  if (baseName.length <= available) {
    return `${baseName}${suffix}`;
  }

  return `${baseName.slice(0, available - 3)}...${suffix}`;
}

function buildCodeFence(lines) {
  return [
    "```txt",
    ...lines,
    "```",
  ].join("\n");
}

function appendLabeledLine(lines, label, text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return;
  }
  lines.push(`${label}: ${normalized}`);
}

function buildExpandableQuoteBlock(lines) {
  return lines
    .map((line) => (line ? `>> ${line}` : ">>"))
    .join("\n");
}

function renderBar(value) {
  const normalized = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const filled = Math.round(normalized / 10);
  return `[${"#".repeat(filled)}${".".repeat(10 - filled)}]`;
}

function renderTrend(trend) {
  if (trend === "up") {
    return "↑";
  }
  if (trend === "down") {
    return "↓";
  }
  return "=";
}

function buildStatLines(snapshot, language = DEFAULT_UI_LANGUAGE) {
  const normalizedLanguage = isEnglish(language) ? "eng" : "rus";
  const labelWidth = STAT_DEFS.reduce(
    (maxWidth, definition) =>
      Math.max(maxWidth, definition.labels[normalizedLanguage].length),
    0,
  );

  return STAT_DEFS.map((definition) => {
    const label = definition.labels[normalizedLanguage].padEnd(labelWidth, " ");
    if (!snapshot) {
      return `${label} [..........]  -- ·`;
    }

    const value = String(snapshot.stats?.[definition.id] ?? 0).padStart(3, " ");
    return `${label} ${renderBar(snapshot.stats?.[definition.id])} ${value} ${renderTrend(snapshot.trends?.[definition.id])}`;
  });
}

function buildPendingAddLines(state, language) {
  const pendingAdd = state?.pending_add;
  if (!pendingAdd) {
    return [];
  }

  if (pendingAdd.busy) {
    return [
      isEnglish(language) ? "add project:" : "добавление проекта:",
      pendingAdd.prompt_hint_text || (
        isEnglish(language)
          ? "searching the workspace"
          : "ищу по workspace"
      ),
    ];
  }

  if (pendingAdd.stage === "await_confirmation") {
    const english = isEnglish(language);
    return [
      english ? "add project:" : "добавление проекта:",
      pendingAdd.prompt_hint_text || (
        english
          ? "check the candidate below and reply Yes or No"
          : "проверь кандидата ниже и ответь Да или Нет"
      ),
      ...(pendingAdd.candidate_path ? ["", pendingAdd.candidate_path] : []),
      ...(pendingAdd.candidate_reason ? ["", pendingAdd.candidate_reason] : []),
      "",
      pendingAdd.candidate_question || (
        english
          ? "Is this the right project? Reply Yes or No."
          : "Это нужный проект? Ответь Да или Нет."
      ),
    ];
  }

  return [
    isEnglish(language) ? "add project:" : "добавление проекта:",
    pendingAdd.prompt_hint_text || (
      isEnglish(language)
        ? "reply with a project description so I can find it"
        : "ответь описанием проекта, чтобы я смог его найти"
    ),
  ];
}

function buildPetDisplayLabel(pet) {
  return pet?.display_name || "project";
}

function buildPetTemperamentLabel(pet, language = DEFAULT_UI_LANGUAGE) {
  return getZooPetTemperamentLabel(pet, language);
}

function buildPetRoleLabel(pet, language = DEFAULT_UI_LANGUAGE) {
  return `${getZooCreatureLabel(pet.creature_kind, language)} · ${buildPetTemperamentLabel(pet, language)}`;
}

function getProjectPathLabel(pet) {
  return pet.cwd_relative_to_workspace_root || pet.cwd || pet.resolved_path || pet.display_name;
}

function buildCreatureCardBlock({
  pet,
  isRefreshing = false,
  poseFrameIndex = 0,
  snapshot = null,
  language = DEFAULT_UI_LANGUAGE,
}) {
  const lines = [
    ...getZooPoseLines({
      creatureKind: pet.creature_kind,
      mode: isRefreshing ? "refresh" : "idle",
      frameIndex: poseFrameIndex,
    }),
  ];

  lines.push("");
  lines.push(...buildStatLines(snapshot, language));

  return buildCodeFence(lines);
}

function buildRefreshStatusLine({
  pet,
  language = DEFAULT_UI_LANGUAGE,
  poseFrameIndex = 0,
  fallbackText = null,
}) {
  if (fallbackText && poseFrameIndex <= 0) {
    return fallbackText;
  }

  return getZooPetRefreshStatus({
    pet,
    language,
    frameIndex: poseFrameIndex,
  });
}

export function buildZooRootText({
  language = DEFAULT_UI_LANGUAGE,
  pets = [],
  totalPetCount = pets.length,
  state,
  selectedPet = null,
  selectedSnapshot = null,
  currentPage = 0,
  totalPages = 1,
}) {
  const english = isEnglish(language);
  const lines = [
    english ? "Project Pets" : "Питомцы проектов",
    "",
    `${english ? "pets" : "питомцы"}: ${totalPetCount}`,
  ];

  if (totalPages > 1) {
    lines.push(`${english ? "page" : "страница"}: ${currentPage + 1}/${totalPages}`);
  }

  const pendingLines = buildPendingAddLines(state, language);
  if (pendingLines.length > 0) {
    lines.push(...pendingLines);
  }
  if (state?.refreshing_pet_id && selectedPet) {
    lines.push(
      `${english ? "refresh" : "обновление"}: ${buildPetDisplayLabel(selectedPet)}`,
    );
  }
  if (state?.last_refresh_error_text && selectedPet) {
    lines.push(
      `${english ? "last error" : "последняя ошибка"}: ${state.last_refresh_error_text}`,
    );
  }

  lines.push("");
  if (pets.length === 0) {
    lines.push(
      english
        ? "Stable is empty. Tap Add project."
        : "Стойло пусто. Нажми Add project.",
    );
  }

  if (selectedPet && selectedSnapshot && state?.active_screen === "root") {
    lines.push("");
    lines.push(
      english
        ? `last viewed: ${selectedPet.display_name}`
        : `последний просмотр: ${selectedPet.display_name}`,
    );
  }

  return lines.join("\n");
}

export function buildZooPetText({
  language = DEFAULT_UI_LANGUAGE,
  pet,
  snapshot = null,
  state,
  poseFrameIndex = 0,
}) {
  const english = isEnglish(language);
  const projectPathLabel = getProjectPathLabel(pet);
  const refreshing = state?.refreshing_pet_id === pet.pet_id;
  const lines = [
    buildPetRoleLabel(pet, language),
    "",
    buildCreatureCardBlock({
      pet,
      language,
      isRefreshing: refreshing,
      poseFrameIndex,
      snapshot,
    }),
  ];

  const detailLines = [];
  if (refreshing) {
    detailLines.push(
      `${english ? "status" : "статус"}: ${buildRefreshStatusLine({
        pet,
        language,
        poseFrameIndex,
        fallbackText: state?.refresh_status_text,
      })}`,
    );
  } else if (snapshot?.mood) {
    detailLines.push(`${english ? "my mood" : "моё настроение"}: ${snapshot.mood}`);
  }

  if (state?.last_refresh_error_text && state?.selected_pet_id === pet.pet_id) {
    detailLines.push(`${english ? "last error" : "последняя ошибка"}: ${state.last_refresh_error_text}`);
  }

  if (!snapshot) {
    detailLines.push(
      refreshing
        ? (english ? "First snapshot is brewing." : "Собираю первый снимок.")
        : (english ? "No snapshot yet. Tap Refresh." : "Снимка пока нет. Нажми Refresh."),
    );
    detailLines.push(`${english ? "project" : "проект"}: ${pet.display_name}`);
    detailLines.push(`${english ? "repo" : "репо"}: ${projectPathLabel}`);
    lines.push("");
    lines.push(buildExpandableQuoteBlock(detailLines));
    return lines.join("\n");
  }

  appendLabeledLine(
    detailLines,
    english ? "voice" : "голос",
    snapshot.flavor_line,
  );
  appendLabeledLine(
    detailLines,
    english ? "summary" : "суть",
    snapshot.project_summary,
  );
  if (snapshot.next_focus) {
    if (detailLines.at(-1) !== "") {
      detailLines.push("");
    }
    detailLines.push(
      `${english ? "next focus" : "следующий фокус"}: ${snapshot.next_focus}`,
    );
  }
  if (detailLines.at(-1) !== "") {
    detailLines.push("");
  }
  detailLines.push(`${english ? "project" : "проект"}: ${pet.display_name}`);
  detailLines.push(`${english ? "repo" : "репо"}: ${projectPathLabel}`);
  detailLines.push(`${english ? "refreshed" : "обновлено"}: ${snapshot.refreshed_at}`);
  lines.push("");
  lines.push(buildExpandableQuoteBlock(detailLines));

  return lines.join("\n");
}

export function buildZooRemoveConfirmText({
  language = DEFAULT_UI_LANGUAGE,
  pet,
}) {
  const english = isEnglish(language);
  return [
    english ? "Remove this pet?" : "Удалить этого питомца?",
    buildPetRoleLabel(pet, language),
    `${english ? "project" : "проект"}: ${pet.display_name}`,
    `${english ? "repo" : "репо"}: ${getProjectPathLabel(pet)}`,
    "",
    english
      ? "This removes Zoo state only."
      : "Это удалит только Zoo state.",
  ].join("\n");
}

function buildInlineButton(text, callbackData) {
  return {
    text,
    callback_data: callbackData,
  };
}

function chunkRows(entries, size = 2) {
  const rows = [];
  for (let index = 0; index < entries.length; index += size) {
    rows.push(entries.slice(index, index + size));
  }
  return rows;
}

export function buildZooRootMarkup(pets = [], language = DEFAULT_UI_LANGUAGE) {
  const currentPage = 0;
  const totalPages = 1;
  return buildZooRootMarkupPage(pets, language, {
    currentPage,
    totalPages,
  });
}

export function buildZooRootMarkupPage(
  pets = [],
  language = DEFAULT_UI_LANGUAGE,
  {
    currentPage = 0,
    totalPages = 1,
  } = {},
) {
  const navigationRow = [];
  if (currentPage > 0) {
    navigationRow.push(
      buildInlineButton(
        "‹ Back",
        `${ZOO_CALLBACK_PREFIX}:p:${currentPage - 1}`,
      ),
    );
  }
  if (currentPage + 1 < totalPages) {
    navigationRow.push(
      buildInlineButton(
        "Next ›",
        `${ZOO_CALLBACK_PREFIX}:p:${currentPage + 1}`,
      ),
    );
  }

  return {
    inline_keyboard: [
      ...chunkRows(
        pets.map((pet) =>
          buildInlineButton(
            truncatePetButtonLabel(buildPetDisplayLabel(pet), 24),
            `${ZOO_CALLBACK_PREFIX}:v:${pet.pet_id}`,
          )),
        2,
      ),
      ...(navigationRow.length > 0 ? [navigationRow] : []),
      [
        buildInlineButton(
          "Add project",
          `${ZOO_CALLBACK_PREFIX}:a:start`,
        ),
        buildInlineButton(
          "Respawn menu",
          `${ZOO_CALLBACK_PREFIX}:m:respawn`,
        ),
      ],
    ],
  };
}

export function buildZooPetMarkup(petId, {
  canRefresh = true,
  canRemove = true,
  language = DEFAULT_UI_LANGUAGE,
} = {}) {
  return {
    inline_keyboard: [
      [
        buildInlineButton(
          "Refresh",
          canRefresh
            ? `${ZOO_CALLBACK_PREFIX}:r:${petId}`
            : `${ZOO_CALLBACK_PREFIX}:noop:refreshing`,
        ),
        buildInlineButton(
          "Remove",
          canRemove
            ? `${ZOO_CALLBACK_PREFIX}:d:${petId}`
            : `${ZOO_CALLBACK_PREFIX}:noop:removing-disabled`,
        ),
      ],
      [
        buildInlineButton(
          "Back",
          `${ZOO_CALLBACK_PREFIX}:n:root`,
        ),
        buildInlineButton(
          "Respawn menu",
          `${ZOO_CALLBACK_PREFIX}:m:respawn`,
        ),
      ],
    ],
  };
}

export function buildZooRemoveConfirmMarkup(petId, language = DEFAULT_UI_LANGUAGE) {
  return {
    inline_keyboard: [
      [
        buildInlineButton(
          "Confirm remove",
          `${ZOO_CALLBACK_PREFIX}:x:${petId}`,
        ),
        buildInlineButton(
          "Cancel",
          `${ZOO_CALLBACK_PREFIX}:v:${petId}`,
        ),
      ],
      [
        buildInlineButton(
          "Back",
          `${ZOO_CALLBACK_PREFIX}:n:root`,
        ),
      ],
    ],
  };
}
