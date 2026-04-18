import { getTopicIdFromMessage } from "./session-key.js";

function buildPurgeAfterIso(retentionHours) {
  return new Date(Date.now() + retentionHours * 60 * 60 * 1000).toISOString();
}

function looksExpired(isoTimestamp) {
  const parsed = Date.parse(isoTimestamp);
  return Number.isFinite(parsed) && parsed <= Date.now();
}

function isPurgeEligibilityError(error) {
  return String(error?.message || "").includes("not purge-eligible");
}

export function isTopicUnavailableTelegramError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("message thread not found") ||
    message.includes("thread not found") ||
    message.includes("topic closed") ||
    message.includes("topic deleted") ||
    message.includes("topic was deleted") ||
    message.includes("message thread is not found")
  );
}

function getLifecycleEvent(message) {
  if (message?.forum_topic_closed) {
    return {
      kind: "closed",
      reason: "telegram/forum-topic-closed",
    };
  }

  if (message?.forum_topic_reopened) {
    return {
      kind: "reopened",
      reason: "telegram/forum-topic-reopened",
    };
  }

  if (message?.forum_topic_edited) {
    return {
      kind: "edited",
      reason: "telegram/forum-topic-edited",
      topicName: message.forum_topic_edited.name || null,
    };
  }

  return null;
}

export class SessionLifecycleManager {
  constructor({
    config,
    sessionStore,
    sessionCompactor = null,
    workerPool = null,
    runtimeObserver = null,
  }) {
    this.config = config;
    this.sessionStore = sessionStore;
    this.sessionCompactor = sessionCompactor;
    this.workerPool = workerPool;
    this.runtimeObserver = runtimeObserver;
  }

  async handleServiceMessage(message) {
    const event = getLifecycleEvent(message);
    if (!event) {
      return { handled: false };
    }

    if (String(message?.chat?.id) !== this.config.telegramForumChatId) {
      return { handled: false };
    }

    const topicId = getTopicIdFromMessage(message);
    if (!topicId) {
      return { handled: true, event: event.kind, session: null };
    }

    const session = await this.sessionStore.load(message.chat.id, topicId);
    if (!session) {
      return { handled: true, event: event.kind, session: null };
    }

    if (event.kind === "closed") {
      if (session.lifecycle_state === "purged") {
        return { handled: true, event: event.kind, session };
      }
      const parked = await this.parkSession(session, event.reason);
      return { handled: true, event: event.kind, session: parked };
    }

    if (event.kind === "reopened") {
      if (session.lifecycle_state === "purged") {
        return { handled: true, event: event.kind, session };
      }
      const active = await this.sessionStore.activate(session, event.reason);
      await this.runtimeObserver?.noteSessionLifecycle({
        action: "reactivated",
        session: active,
        reason: event.reason,
        previousState: session.lifecycle_state,
        nextState: active.lifecycle_state,
        trigger: "service-message",
      });
      return { handled: true, event: event.kind, session: active };
    }

    const updated = await this.sessionStore.patch(session, {
      topic_name: event.topicName || session.topic_name,
    });
    return { handled: true, event: event.kind, session: updated };
  }

  async handleTransportError(session, error) {
    if (!session || !isTopicUnavailableTelegramError(error)) {
      return { handled: false };
    }

    const current =
      (await this.sessionStore.load(session.chat_id, session.topic_id)) || session;
    if (current.lifecycle_state === "purged") {
      return { handled: true, parked: false, session: current };
    }

    const parked = await this.parkSession(current, "telegram/topic-unavailable");
    return { handled: true, parked: true, session: parked };
  }

  async parkSession(session, reason) {
    const alreadyParkedForReason =
      session.lifecycle_state === "parked" &&
      session.parked_reason === reason &&
      session.parked_at &&
      session.purge_after;
    if (alreadyParkedForReason) {
      return session;
    }

    const previousState = session.lifecycle_state;
    const parked = await this.sessionStore.park(session, reason, {
      purge_after: buildPurgeAfterIso(this.config.parkedSessionRetentionHours),
    });

    await this.runtimeObserver?.noteSessionLifecycle({
      action: "parked",
      session: parked,
      reason,
      previousState,
      nextState: parked.lifecycle_state,
      trigger: "lifecycle-manager",
    });

    return parked;
  }

  async sweepExpiredParkedSessions() {
    const sessions = await this.sessionStore.listSessions();
    let purgedCount = 0;

    for (const session of sessions) {
      if (session.lifecycle_state !== "parked") {
        continue;
      }

      if (session.retention_pin) {
        continue;
      }

      if (!session.purge_after || !looksExpired(session.purge_after)) {
        continue;
      }

      let purged = null;
      try {
        purged = await this.sessionStore.purge(
          session,
          "retention/expired-parked",
        );
      } catch (error) {
        if (isPurgeEligibilityError(error)) {
          continue;
        }
        throw error;
      }
      await this.runtimeObserver?.noteSessionLifecycle({
        action: "purged",
        session: purged,
        reason: "retention/expired-parked",
        previousState: session.lifecycle_state,
        nextState: purged.lifecycle_state,
        trigger: "retention-sweep",
      });
      purgedCount += 1;
    }

    return {
      scannedCount: sessions.length,
      purgedCount,
    };
  }
}
