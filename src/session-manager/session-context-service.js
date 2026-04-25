import {
  buildLegacyContextSnapshot,
  normalizeContextSnapshot,
  readLatestContextSnapshot,
} from "./context-snapshot.js";

function normalizeBackend(value) {
  return String(value || "").trim().toLowerCase();
}

function isLegacyAppServerBackend(value) {
  const backend = normalizeBackend(value);
  return backend === "app-server" || backend === "appserver";
}

function shouldReadLegacyRolloutSnapshot(session, config) {
  if (!isLegacyAppServerBackend(config?.codexGatewayBackend)) {
    return false;
  }

  return isLegacyAppServerBackend(
    session?.codex_backend
    || session?.last_run_backend
    || config?.codexGatewayBackend,
  );
}

function stripLegacySnapshotFields(snapshot) {
  if (!snapshot) {
    return null;
  }

  return {
    ...snapshot,
    session_id: null,
    rollout_path: null,
  };
}

export class SessionContextService {
  constructor({ sessionStore, config }) {
    this.sessionStore = sessionStore;
    this.config = config;
  }

  async resolveContextSnapshot(
    session,
    {
      threadId =
        session.codex_thread_id
        ?? null,
      providerSessionId =
        session.provider_session_id
        ?? null,
      rolloutPath = session.codex_rollout_path ?? null,
    } = {},
  ) {
    const storedSnapshot = normalizeContextSnapshot(session.last_context_snapshot);
    const legacyAppServerSnapshot = shouldReadLegacyRolloutSnapshot(
      session,
      this.config,
    );
    const execJsonSnapshot =
      !legacyAppServerSnapshot
      && threadId
      && this.config.codexSessionsRoot;

    if (
      (legacyAppServerSnapshot || execJsonSnapshot)
      && (threadId || providerSessionId)
      && this.config.codexSessionsRoot
    ) {
      const resolved = await readLatestContextSnapshot({
        threadId,
        providerSessionId: legacyAppServerSnapshot ? providerSessionId : null,
        sessionsRoot: this.config.codexSessionsRoot,
        knownRolloutPath: legacyAppServerSnapshot
          ? rolloutPath || storedSnapshot?.rollout_path || null
          : null,
      });

      if (resolved.snapshot) {
        const resolvedSnapshot = legacyAppServerSnapshot
          ? resolved.snapshot
          : stripLegacySnapshotFields(resolved.snapshot);
        const patch = {};
        const normalizedStoredUsage = JSON.stringify(
          storedSnapshot?.last_token_usage ?? null,
        );
        const normalizedNextUsage = JSON.stringify(
          resolvedSnapshot.last_token_usage ?? null,
        );

        if (
          legacyAppServerSnapshot
          && resolved.rolloutPath
          && resolved.rolloutPath !== session.codex_rollout_path
        ) {
          patch.codex_rollout_path = resolved.rolloutPath;
        }
        if (
          resolvedSnapshot.thread_id
          && resolvedSnapshot.thread_id !== session.codex_thread_id
        ) {
          patch.codex_thread_id = resolvedSnapshot.thread_id;
        }
        if (
          legacyAppServerSnapshot
          && resolvedSnapshot.session_id
          && resolvedSnapshot.session_id !== session.provider_session_id
        ) {
          patch.runtime_provider = "codex";
          patch.provider_session_id = resolvedSnapshot.session_id;
        }
        if (
          JSON.stringify(storedSnapshot) !== JSON.stringify(resolvedSnapshot)
        ) {
          patch.last_context_snapshot = resolvedSnapshot;
        }
        if (normalizedStoredUsage !== normalizedNextUsage) {
          patch.last_token_usage = resolvedSnapshot.last_token_usage;
        }

        if (Object.keys(patch).length > 0) {
          return {
            session: await this.sessionStore.patch(session, patch),
            snapshot: resolvedSnapshot,
          };
        }

        return {
          session,
          snapshot: resolvedSnapshot,
        };
      }
    }

    if (
      !legacyAppServerSnapshot
      && (
        session.provider_session_id
        || session.codex_rollout_path
        || storedSnapshot?.session_id
        || storedSnapshot?.rollout_path
      )
    ) {
      const patched = await this.sessionStore.patch(session, {
        provider_session_id: null,
        codex_rollout_path: null,
        ...(storedSnapshot?.session_id || storedSnapshot?.rollout_path
          ? { last_context_snapshot: null }
          : {}),
      });

      return {
        session: patched,
        snapshot: buildLegacyContextSnapshot({
          usage: patched.last_token_usage,
          contextWindow: this.config.codexContextWindow ?? null,
        }),
      };
    }

    return {
      session,
      snapshot:
        storedSnapshot
        ?? buildLegacyContextSnapshot({
          usage: session.last_token_usage,
          contextWindow: this.config.codexContextWindow ?? null,
        }),
    };
  }
}
