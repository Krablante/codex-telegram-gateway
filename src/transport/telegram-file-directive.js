const TELEGRAM_FILE_DIRECTIVE_FENCE = "telegram-file";
const EXAMPLE_FILE_PATH = "<absolute-host-path-to-file>";

function normalizeDirectiveValue(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function isPlaceholderExampleDocument(document) {
  return document?.filePath === EXAMPLE_FILE_PATH;
}

function parseDirectiveBody(body, language = "rus") {
  const document = {
    action: null,
    filePath: null,
    fileName: null,
    caption: null,
  };
  const warnings = [];
  const lines = String(body || "")
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^([a-z_]+)\s*:\s*(.*)$/iu);
    if (!match) {
      continue;
    }

    const [, rawKey, rawValue] = match;
    const key = rawKey.toLowerCase();
    const value = normalizeDirectiveValue(rawValue);

    if (key === "action") {
      document.action = value ? value.toLowerCase() : null;
      continue;
    }

    if (key === "path") {
      document.filePath = value;
      continue;
    }

    if (["filename", "file_name", "name"].includes(key)) {
      document.fileName = value;
      continue;
    }

    if (key === "caption") {
      document.caption = value;
    }
  }

  if (document.action !== "send") {
    return {
      active: false,
      document: null,
      warnings,
    };
  }

  if (isPlaceholderExampleDocument(document)) {
    return {
      active: false,
      document: null,
      warnings,
    };
  }

  if (!document.filePath) {
    warnings.push(
      language === "eng"
        ? "Could not send file: the ```telegram-file``` block needs path: <absolute-host-path-to-file>."
        : "Не смог отправить файл: в блоке ```telegram-file``` нужен path: <absolute-host-path-to-file>.",
    );
    return {
      active: true,
      document: null,
      warnings,
    };
  }

  return {
    active: true,
    document: {
      filePath: document.filePath,
      fileName: document.fileName,
      caption: document.caption,
    },
    warnings,
  };
}

export function buildTelegramFileDirectiveInstructions() {
  return [
    "To attach a local file to the current Telegram topic, add a fenced block anywhere in the final reply.",
    "Example below is inert until you add action: send:",
    `\`\`\`${TELEGRAM_FILE_DIRECTIVE_FENCE}`,
    `path: ${EXAMPLE_FILE_PATH}`,
    "filename: report.txt",
    "caption: optional caption",
    "```",
    "Use a real absolute host path only in the live block you want executed.",
    "Add action: send only in the real block you want executed.",
    "Only blocks with action: send are executed.",
    "Blocks without that action stay visible as plain examples.",
    "The gateway strips active blocks from the visible reply and sends the file to the current topic.",
  ];
}

export function extractTelegramFileDirectives(text, { language = "rus" } = {}) {
  const source = String(text || "");
  const pattern = new RegExp(
    `\`\`\`${TELEGRAM_FILE_DIRECTIVE_FENCE}[ \\t]*\\r?\\n([\\s\\S]*?)\`\`\``,
    "giu",
  );
  const documents = [];
  const warnings = [];
  const visibleText = source.replace(pattern, (fullMatch, body) => {
    const parsed = parseDirectiveBody(body || "", language);
    if (!parsed.active) {
      return fullMatch;
    }

    if (parsed.document) {
      documents.push(parsed.document);
    }
    warnings.push(...parsed.warnings);
    return "";
  });

  return {
    documents,
    warnings,
    text: visibleText
      .replace(/\r\n/gu, "\n")
      .replace(/\n{3,}/gu, "\n\n")
      .trim(),
  };
}
