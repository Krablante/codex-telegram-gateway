function truncateText(text, limit = 3800) {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}\n\n[truncated]`;
}

const FLUSH_INTERVAL_MS = 900;
const RETRY_DELAY_MS = 1800;

function getErrorMessage(error) {
  return String(error?.message || "").toLowerCase();
}

function isBenignNoopEditError(error) {
  return getErrorMessage(error).includes("message is not modified");
}

function isReplaceableEditError(error) {
  const message = getErrorMessage(error);
  return (
    message.includes("message can't be edited") ||
    message.includes("message to edit not found") ||
    message.includes("message identifier is not specified")
  );
}

export class TelegramProgressMessage {
  constructor({ api, chatId, messageThreadId = null, onDeliveryError = null }) {
    this.api = api;
    this.chatId = chatId;
    this.messageThreadId = messageThreadId;
    this.onDeliveryError = onDeliveryError;
    this.appendOnlyMode = false;
    this.messageId = null;
    this.currentText = null;
    this.pendingText = null;
    this.flushTimer = null;
    this.lastFlushAt = 0;
  }

  buildSendParams(text) {
    const params = {
      chat_id: this.chatId,
      text: truncateText(text),
    };

    if (this.messageThreadId !== null) {
      params.message_thread_id = this.messageThreadId;
    }

    return params;
  }

  async reportDeliveryError(error) {
    return this.onDeliveryError?.(error);
  }

  async sendAppendOnly(text) {
    const previousMessageId = this.messageId;
    const sent = await this.api.sendMessage(this.buildSendParams(text));
    this.messageId = sent.message_id;
    this.currentText = truncateText(text);
    this.lastFlushAt = Date.now();
    if (
      previousMessageId !== null &&
      previousMessageId !== this.messageId &&
      typeof this.api.deleteMessage === "function"
    ) {
      try {
        await this.api.deleteMessage({
          chat_id: this.chatId,
          message_id: previousMessageId,
        });
      } catch (error) {
        await this.reportDeliveryError(error);
      }
    }
    return sent;
  }

  async sendInitial(text) {
    try {
      return await this.sendAppendOnly(text);
    } catch (error) {
      const lifecycleResult = await this.reportDeliveryError(error);
      if (lifecycleResult?.handled) {
        error.deliveryHandled = true;
      }
      throw error;
    }
  }

  queueUpdate(text) {
    const nextText = truncateText(text);
    if (this.messageId === null) {
      return;
    }

    if (nextText === this.currentText) {
      return;
    }

    this.pendingText = nextText;
    const now = Date.now();
    const elapsed = now - this.lastFlushAt;
    const delay = elapsed >= FLUSH_INTERVAL_MS ? 0 : FLUSH_INTERVAL_MS - elapsed;

    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      try {
        await this.flushPending();
      } catch (error) {
        await this.reportDeliveryError(error).catch(() => {});
      }
    }, delay);
    this.flushTimer.unref?.();
  }

  async flushPending() {
    if (!this.pendingText || this.messageId === null) {
      return;
    }

    const nextText = this.pendingText;
    this.pendingText = null;

    if (this.appendOnlyMode) {
      try {
        await this.sendAppendOnly(nextText);
      } catch (error) {
        await this.reportDeliveryError(error);
        this.pendingText = nextText;
        this.scheduleRetry();
      }
      return;
    }

    try {
      await this.api.editMessageText({
        chat_id: this.chatId,
        message_id: this.messageId,
        text: nextText,
      });
      this.currentText = nextText;
      this.lastFlushAt = Date.now();
    } catch (error) {
      if (isBenignNoopEditError(error)) {
        this.currentText = nextText;
        this.lastFlushAt = Date.now();
        return;
      }

      const lifecycleResult = await this.reportDeliveryError(error);
      if (lifecycleResult?.handled) {
        this.pendingText = nextText;
        return;
      }

      if (isReplaceableEditError(error)) {
        this.appendOnlyMode = true;
        this.pendingText = nextText;
        try {
          await this.sendAppendOnly(nextText);
          this.pendingText = null;
        } catch (appendError) {
          await this.reportDeliveryError(appendError);
          this.pendingText = nextText;
          this.scheduleRetry();
        }
        return;
      }

      this.pendingText = nextText;
      this.scheduleRetry();
    }
  }

  scheduleRetry(delay = RETRY_DELAY_MS) {
    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      try {
        await this.flushPending();
      } catch (error) {
        await this.reportDeliveryError(error).catch(() => {});
      }
    }, delay);
    this.flushTimer.unref?.();
  }

  async finalize(text) {
    this.pendingText = truncateText(text);
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushPending();
  }

  async dismiss() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingText = null;

    if (this.messageId === null || typeof this.api.deleteMessage !== "function") {
      return false;
    }

    const messageId = this.messageId;
    try {
      await this.api.deleteMessage({
        chat_id: this.chatId,
        message_id: messageId,
      });
      if (this.messageId === messageId) {
        this.messageId = null;
        this.currentText = null;
      }
      return true;
    } catch (error) {
      await this.reportDeliveryError(error);
      return false;
    }
  }
}
