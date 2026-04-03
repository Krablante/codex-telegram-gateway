const DEFAULT_FLUSH_DELAY_MS = 1200;
const DEFAULT_FLUSH_GRACE_MS = 250;
const DEFAULT_LONG_PROMPT_THRESHOLD_CHARS = 3000;

function normalizeKeyPart(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return String(value);
}

export function buildPromptFragmentKey(message) {
  const chatId = message?.chat?.id;
  const fromId = message?.from?.id;
  if (chatId === undefined || chatId === null || fromId === undefined || fromId === null) {
    return null;
  }

  const keyParts = [
    normalizeKeyPart(chatId, "chat"),
    normalizeKeyPart(message?.message_thread_id, "general"),
    normalizeKeyPart(fromId, "user"),
  ];
  if (message?.media_group_id) {
    keyParts.push("group", normalizeKeyPart(message.media_group_id, "media-group"));
  }

  return keyParts.join(":");
}

function buildManualWaitWindowKey(message) {
  const chatId = message?.chat?.id;
  const fromId = message?.from?.id;
  if (chatId === undefined || chatId === null || fromId === undefined || fromId === null) {
    return null;
  }

  return [
    "wait",
    "global",
    normalizeKeyPart(chatId, "chat"),
    normalizeKeyPart(fromId, "user"),
  ].join(":");
}

function buildLocalManualWaitWindowKey(message) {
  const chatId = message?.chat?.id;
  const fromId = message?.from?.id;
  if (chatId === undefined || chatId === null || fromId === undefined || fromId === null) {
    return null;
  }

  return [
    "wait",
    "topic",
    normalizeKeyPart(chatId, "chat"),
    normalizeKeyPart(message?.message_thread_id, "general"),
    normalizeKeyPart(fromId, "user"),
  ].join(":");
}

function isSameTopicMessage(left, right) {
  return (
    normalizeKeyPart(left?.chat?.id, "chat") === normalizeKeyPart(right?.chat?.id, "chat") &&
    normalizeKeyPart(left?.message_thread_id, "general") ===
      normalizeKeyPart(right?.message_thread_id, "general")
  );
}

function buildEntry(key, { flush = null, flushDelayMs, mode = "auto" } = {}) {
  return {
    key,
    messages: [],
    flush,
    flushDelayMs,
    mode,
    flushing: false,
    timer: null,
  };
}

function isManualEntryMode(mode) {
  return mode === "manual-local" || mode === "manual-global";
}

function describeEntry(entry, inFlight = false) {
  if (!entry && !inFlight) {
    return {
      active: false,
      key: null,
      mode: null,
      entryMode: null,
      scope: null,
      persistent: false,
      messageCount: 0,
      flushDelayMs: null,
      flushing: false,
    };
  }

  const entryMode = entry?.mode ?? null;
  const manual = isManualEntryMode(entryMode);
  const scope =
    entryMode === "manual-global"
      ? "global"
      : entryMode === "manual-local"
        ? "topic"
        : "topic";

  return {
    active: true,
    key: entry?.key ?? null,
    mode: manual ? "manual" : entryMode,
    entryMode,
    scope,
    persistent: entryMode === "manual-global",
    messageCount: entry?.messages.length ?? 0,
    flushDelayMs: entry?.flushDelayMs ?? null,
    flushing: Boolean(entry?.flushing || inFlight),
  };
}

export class PromptFragmentAssembler {
  constructor({
    flushDelayMs = DEFAULT_FLUSH_DELAY_MS,
    flushGraceMs = DEFAULT_FLUSH_GRACE_MS,
    longPromptThresholdChars = DEFAULT_LONG_PROMPT_THRESHOLD_CHARS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.flushDelayMs = flushDelayMs;
    this.flushGraceMs = flushGraceMs;
    this.longPromptThresholdChars = longPromptThresholdChars;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.entries = new Map();
    this.inFlight = new Map();
  }

  getActiveLocalManualWindowKey(message) {
    const key = buildLocalManualWaitWindowKey(message);
    if (!key) {
      return null;
    }

    const entry = this.entries.get(key);
    if (isManualEntryMode(entry?.mode) || this.inFlight.has(key)) {
      return key;
    }

    return null;
  }

  getActiveGlobalManualWindowKey(message) {
    const key = buildManualWaitWindowKey(message);
    if (!key) {
      return null;
    }

    const entry = this.entries.get(key);
    if (isManualEntryMode(entry?.mode) || this.inFlight.has(key)) {
      return key;
    }

    return null;
  }

  getActiveManualWindowKey(message) {
    return this.getActiveLocalManualWindowKey(message)
      || this.getActiveGlobalManualWindowKey(message);
  }

  getActiveTopicBufferKey(message) {
    const key = buildPromptFragmentKey(message);
    if (!key) {
      return null;
    }

    if (this.entries.has(key) || this.inFlight.has(key)) {
      return key;
    }

    return null;
  }

  getPreferredActiveKey(message) {
    return this.getActiveManualWindowKey(message) || this.getActiveTopicBufferKey(message);
  }

  shouldBufferMessage(message, rawPrompt) {
    if (!buildPromptFragmentKey(message)) {
      return false;
    }

    if (this.getPreferredActiveKey(message)) {
      return true;
    }

    if (message?.media_group_id) {
      return true;
    }

    return String(rawPrompt || "").trim().length >= this.longPromptThresholdChars;
  }

  hasPendingForMessage(message) {
    const key = this.getPreferredActiveKey(message);
    if (!key) {
      return false;
    }

    const entry = this.entries.get(key);
    return Boolean((entry && entry.messages.length > 0) || this.inFlight.has(key));
  }

  hasPendingForSameTopicMessage(message) {
    const key = this.getPreferredActiveKey(message);
    if (!key) {
      return false;
    }

    const entry = this.entries.get(key);
    if (entry?.messages?.length > 0) {
      return isSameTopicMessage(entry.messages[0], message);
    }

    return this.getActiveTopicBufferKey(message) === key && this.inFlight.has(key);
  }

  hasBufferedForMessage(message) {
    const key = this.getPreferredActiveKey(message);
    if (!key) {
      return false;
    }

    const entry = this.entries.get(key);
    return Boolean(entry && entry.messages.length > 0);
  }

  getStateForMessage(message) {
    const key = this.getPreferredActiveKey(message);
    const entry = key ? this.entries.get(key) : null;
    const effective = describeEntry(entry, key ? this.inFlight.has(key) : false);
    const localKey = buildLocalManualWaitWindowKey(message);
    const globalKey = buildManualWaitWindowKey(message);

    return {
      ...effective,
      local: describeEntry(
        localKey ? this.entries.get(localKey) : null,
        localKey ? this.inFlight.has(localKey) : false,
      ),
      global: describeEntry(
        globalKey ? this.entries.get(globalKey) : null,
        globalKey ? this.inFlight.has(globalKey) : false,
      ),
    };
  }

  openWindow({ message, flushDelayMs = this.flushDelayMs, flush, scope = "topic" } = {}) {
    const key =
      scope === "global"
        ? buildManualWaitWindowKey(message)
        : buildLocalManualWaitWindowKey(message);
    if (!key) {
      return {
        buffered: false,
        reason: "missing-buffer-key",
      };
    }

    let entry = this.entries.get(key);
    if (!entry) {
      entry = buildEntry(key, {
        flushDelayMs,
        flush,
        mode: scope === "global" ? "manual-global" : "manual-local",
      });
      this.entries.set(key, entry);
    }

    entry.mode = scope === "global" ? "manual-global" : "manual-local";
    entry.flushDelayMs = flushDelayMs;
    if (typeof flush === "function") {
      entry.flush = flush;
    }

    this.clearEntryTimer(entry);
    if (entry.messages.length > 0) {
      this.reschedule(entry);
    }

    return {
      buffered: true,
      key,
      mode: isManualEntryMode(entry.mode) ? "manual" : entry.mode,
      scope,
      partCount: entry.messages.length,
      flushDelayMs: entry.flushDelayMs,
    };
  }

  enqueue({ message, flush }) {
    const manualKey = this.getActiveManualWindowKey(message);
    const key = manualKey || buildPromptFragmentKey(message);
    if (!key) {
      return {
        buffered: false,
        reason: "missing-buffer-key",
      };
    }

    let entry = this.entries.get(key);
    if (!entry) {
      entry = buildEntry(key, {
        flush,
        flushDelayMs: this.flushDelayMs,
        mode: manualKey ? "manual" : "auto",
      });
      this.entries.set(key, entry);
    }

    if (typeof flush === "function") {
      entry.flush = flush;
    }

    entry.messages.push(message);
    this.reschedule(entry);

    return {
      buffered: true,
      key,
      partCount: entry.messages.length,
      mode: entry.mode,
      flushDelayMs: entry.flushDelayMs,
    };
  }

  async flushPendingForMessage(message) {
    const key = this.getPreferredActiveKey(message);
    return this.flushKey(key);
  }

  cancelPendingForMessage(message, options = {}) {
    let key = null;
    if (options.scope === "global") {
      key = buildManualWaitWindowKey(message);
    } else if (options.scope === "topic") {
      key = buildLocalManualWaitWindowKey(message);
    } else {
      key = this.getPreferredActiveKey(message);
    }
    return this.cancelKey(key, options);
  }

  cancelAll() {
    let canceledEntries = 0;
    let canceledMessages = 0;

    for (const key of [...this.entries.keys()]) {
      const canceled = this.cancelKey(key);
      if (!canceled) {
        continue;
      }

      if (canceled.messageCount > 0) {
        canceledEntries += 1;
        canceledMessages += canceled.messageCount;
      }
    }

    return {
      canceledEntries,
      canceledMessages,
    };
  }

  async flushAll() {
    const keys = new Set([
      ...this.entries.keys(),
      ...this.inFlight.keys(),
    ]);
    await Promise.all([...keys].map((key) => this.flushKey(key)));
  }

  reschedule(entry) {
    this.clearEntryTimer(entry);

    const delayMs =
      Number.isFinite(entry.flushDelayMs) && entry.flushDelayMs > 0
        ? entry.flushDelayMs
        : this.flushDelayMs;

    entry.flushing = false;
    entry.timer = this.setTimer(() => {
      entry.flushing = true;
      entry.timer = this.setTimer(() => {
        void this.flushKey(entry.key).catch((error) => {
          console.error(`prompt fragment flush failed for ${entry.key}: ${error.message}`);
        });
      }, this.flushGraceMs);
      entry.timer?.unref?.();
    }, delayMs);
    entry.timer?.unref?.();
  }

  clearEntryTimer(entry) {
    if (!entry?.timer) {
      return;
    }

    this.clearTimer(entry.timer);
    entry.timer = null;
  }

  cancelKey(key, { preserveManualWindow = false } = {}) {
    if (!key) {
      return null;
    }

    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }

    this.clearEntryTimer(entry);
    entry.flushing = false;
    const messageCount = entry.messages.length;

    if (preserveManualWindow && isManualEntryMode(entry.mode)) {
      entry.messages = [];
    } else {
      this.entries.delete(key);
    }

    return {
      key,
      messageCount,
    };
  }

  async flushKey(key) {
    if (!key) {
      return false;
    }

    const inFlightPromise = this.inFlight.get(key);
    if (inFlightPromise) {
      await inFlightPromise;
      return true;
    }

    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }

    this.clearEntryTimer(entry);
    entry.flushing = false;

    const messages = [...entry.messages];
    if (messages.length === 0) {
      if (entry.mode !== "manual-global") {
        this.entries.delete(key);
      }
      return false;
    }

    const keepManualWindow = entry.mode === "manual-global";
    if (keepManualWindow) {
      entry.messages = [];
    } else {
      this.entries.delete(key);
    }

    const flushPromise = Promise.resolve()
      .then(async () => {
        if (typeof entry.flush !== "function") {
          return;
        }

        await entry.flush(messages, {
          key,
          mode: entry.mode,
        });
      })
      .catch((error) => {
        if (keepManualWindow) {
          entry.messages = [...messages, ...entry.messages];
        } else if (!this.entries.has(key)) {
          this.entries.set(key, entry);
        }
        this.reschedule(entry);
        throw error;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, flushPromise);
    await flushPromise;
    return true;
  }
}
