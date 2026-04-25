import { drainPendingSpikePromptQueue } from "./prompt-queue.js";

async function loadCurrentSession(sessionStore, session) {
  return (await sessionStore.load(session.chat_id, session.topic_id)) || session;
}

export class SessionPromptQueueService {
  constructor({ sessionStore, promptQueueStore = null }) {
    this.sessionStore = sessionStore;
    this.promptQueueStore = promptQueueStore;
  }

  async listPromptQueue(session) {
    if (!this.promptQueueStore) {
      return [];
    }

    const current = await loadCurrentSession(this.sessionStore, session);
    return this.promptQueueStore.load(current);
  }

  async enqueuePromptQueue(session, payload) {
    if (!this.promptQueueStore) {
      throw new Error("Prompt queue store is not configured");
    }

    const current = await loadCurrentSession(this.sessionStore, session);
    return this.promptQueueStore.enqueue(current, payload);
  }

  async deletePromptQueueEntry(session, position) {
    if (!this.promptQueueStore) {
      return {
        entry: null,
        position: null,
        size: 0,
      };
    }

    const current = await loadCurrentSession(this.sessionStore, session);
    return this.promptQueueStore.deleteAt(current, position);
  }

  async drainPromptQueue(
    workerPool,
    {
      session = null,
      currentGenerationId = null,
      generationStore = null,
    } = {},
  ) {
    if (!this.promptQueueStore) {
      return [];
    }

    return drainPendingSpikePromptQueue({
      session,
      sessionStore: this.sessionStore,
      workerPool,
      promptQueueStore: this.promptQueueStore,
      currentGenerationId,
      generationStore,
    });
  }
}
