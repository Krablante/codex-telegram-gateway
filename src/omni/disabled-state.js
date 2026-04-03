import { normalizeAutoModeState } from "../session-manager/auto-mode.js";

function buildDisabledAutoModeState(currentAutoMode) {
  const now = new Date().toISOString();
  return {
    ...currentAutoMode,
    enabled: false,
    phase: "off",
    updated_at: now,
    last_state_changed_at: now,
    pending_user_input: null,
    sleep_until: null,
    sleep_next_prompt: null,
    blocked_reason: null,
    last_omni_prompt_message_id: null,
  };
}

export async function disableOmniStateAcrossSessions({
  sessionStore,
  promptHandoffStore,
}) {
  const sessions = await sessionStore.listSessions();
  let autoSessionsDisarmed = 0;
  let handoffsCleared = 0;

  for (const session of sessions) {
    const autoMode = normalizeAutoModeState(session.auto_mode);
    const hadActiveAutoMode =
      autoMode.enabled
      || autoMode.phase !== "off"
      || autoMode.pending_user_input
      || autoMode.sleep_until
      || autoMode.sleep_next_prompt
      || autoMode.blocked_reason
      || autoMode.last_omni_prompt_message_id;
    if (hadActiveAutoMode) {
      await sessionStore.patch(session, {
        auto_mode: buildDisabledAutoModeState(autoMode),
      });
      autoSessionsDisarmed += 1;
    }

    if (await promptHandoffStore.load(session)) {
      await promptHandoffStore.clear(session);
      handoffsCleared += 1;
    }
  }

  return {
    sessionsScanned: sessions.length,
    autoSessionsDisarmed,
    handoffsCleared,
  };
}
