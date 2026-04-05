export async function performRunOnceMaintenance({
  promptFragmentAssembler,
  queuePromptAssembler,
  runtimeObserver,
  scanPendingOmniPrompts,
  scanPendingSpikeQueue,
  sessionLifecycleManager,
}) {
  await scanPendingOmniPrompts();
  await scanPendingSpikeQueue();
  await sessionLifecycleManager.sweepExpiredParkedSessions();
  const completedAt = Date.now();
  await runtimeObserver.noteRetentionSweep(
    new Date(completedAt).toISOString(),
  );
  await promptFragmentAssembler.flushAll();
  await queuePromptAssembler.flushAll();
  return completedAt;
}
