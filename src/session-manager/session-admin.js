function looksExpired(isoTimestamp) {
  const parsed = Date.parse(isoTimestamp);
  return Number.isFinite(parsed) && parsed <= Date.now();
}

function buildPurgeAfterIso(retentionHours) {
  return new Date(Date.now() + retentionHours * 60 * 60 * 1000).toISOString();
}

function compareUpdatedDescending(left, right) {
  return String(right.updated_at || "").localeCompare(String(left.updated_at || ""));
}

export function buildSessionCounts(sessions) {
  const counts = {
    total: sessions.length,
    active: 0,
    parked: 0,
    purged: 0,
    pinned: 0,
  };

  for (const session of sessions) {
    if (session.lifecycle_state === "active") {
      counts.active += 1;
    } else if (session.lifecycle_state === "parked") {
      counts.parked += 1;
    } else if (session.lifecycle_state === "purged") {
      counts.purged += 1;
    }

    if (session.retention_pin) {
      counts.pinned += 1;
    }
  }

  return counts;
}

export class SessionAdmin {
  constructor({
    sessionStore,
    config,
    runtimeObserver = null,
  }) {
    this.sessionStore = sessionStore;
    this.config = config;
    this.runtimeObserver = runtimeObserver;
  }

  async listSessions({ state = null } = {}) {
    const sessions = await this.sessionStore.listSessions();
    return sessions
      .filter((session) => !state || session.lifecycle_state === state)
      .sort(compareUpdatedDescending);
  }

  async getSession(chatId, topicId) {
    const session = await this.sessionStore.load(chatId, topicId);
    if (!session) {
      throw new Error(`Session not found: ${chatId}:${topicId}`);
    }

    return session;
  }

  async setRetentionPin(chatId, topicId, pinned) {
    const session = await this.getSession(chatId, topicId);
    const nextPinned = Boolean(pinned);
    const patch = {
      retention_pin: nextPinned,
      ...(nextPinned ? { purge_after: null } : {}),
    };

    if (!nextPinned && session.lifecycle_state === "parked") {
      patch.purge_after = buildPurgeAfterIso(
        this.config.parkedSessionRetentionHours,
      );
    }

    if (
      !nextPinned &&
      session.lifecycle_state === "parked" &&
      session.purge_after &&
      !looksExpired(session.purge_after)
    ) {
      patch.purge_after = session.purge_after;
    }

    const updated = await this.sessionStore.patch(session, patch);
    return updated;
  }

  async reactivateSession(chatId, topicId, reason = "admin/reactivate") {
    const session = await this.getSession(chatId, topicId);

    if (session.lifecycle_state === "purged") {
      throw new Error(
        `Cannot reactivate purged session ${session.session_key}; create a fresh topic session instead.`,
      );
    }

    if (session.lifecycle_state === "active") {
      return session;
    }

    const active = await this.sessionStore.activate(session, reason);
    await this.runtimeObserver?.noteSessionLifecycle({
      action: "reactivated",
      session: active,
      reason,
      previousState: session.lifecycle_state,
      nextState: active.lifecycle_state,
      trigger: "admin-cli",
    });
    return active;
  }

  async purgeSession(chatId, topicId, reason = "admin/purge") {
    const session = await this.getSession(chatId, topicId);
    if (session.last_run_status === "running") {
      throw new Error(
        `Cannot purge active session ${session.session_key}; interrupt the run first.`,
      );
    }
    const purged = await this.sessionStore.purge(session, reason);
    await this.runtimeObserver?.noteSessionLifecycle({
      action: "purged",
      session: purged,
      reason,
      previousState: session.lifecycle_state,
      nextState: purged.lifecycle_state,
      trigger: "admin-cli",
    });
    return purged;
  }
}
