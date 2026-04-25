export async function performRunOnceMaintenance({
  promptFragmentAssembler,
  queuePromptAssembler,
  runtimeObserver,
  scanPendingSpikeQueue,
  sessionLifecycleManager,
}) {
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
