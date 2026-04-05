import { DEFAULT_UI_LANGUAGE } from "../i18n/ui-language.js";
import { runZooProjectAnalysis } from "./analysis.js";
import { runZooProjectLookup } from "./lookup.js";
import {
  beginLookup,
  confirmPendingAdd,
  handleZooReply,
  persistCanonicalPetDisplayNames,
  reconcilePetDisplayNames,
  runLookup,
} from "./service-add-flow.js";
import {
  buildMenuPayload,
  ensureZooMenu,
  ensureZooTopic,
  handleZooCommand,
  isZooTopicMessage,
  maybeHandleIncomingMessage,
  pickPetIdentity,
  recoverZooTopicFromMessageContext,
  resolveUiLanguage,
} from "./service-menu.js";
import {
  clearMissingPetRefreshState,
  handleCallbackQuery,
  runRefresh,
  startPetTicker,
  stopPetTicker,
  syncPetAnimationTicker,
} from "./service-refresh.js";
import { ZooStore } from "./store.js";

export class ZooService {
  constructor({
    config,
    sessionService,
    globalControlPanelStore = null,
    zooStore = null,
    lookupRunner = runZooProjectLookup,
    analysisRunner = runZooProjectAnalysis,
    randomSource = Math.random,
  }) {
    this.config = config;
    this.sessionService = sessionService;
    this.globalControlPanelStore = globalControlPanelStore;
    this.zooStore = zooStore || new ZooStore(config.stateRoot);
    this.lookupRunner = lookupRunner;
    this.analysisRunner = analysisRunner;
    this.randomSource = randomSource;
    this.activeRefreshByPetId = new Map();
    this.petFrameIndexByPetId = new Map();
    this.petTickerByPetId = new Map();
    this.petTickerIntervalByPetId = new Map();
  }

  async resolveUiLanguage(message = null) {
    return resolveUiLanguage(this, message);
  }

  pickPetIdentity(existingPets = []) {
    return pickPetIdentity(this, existingPets);
  }

  async isZooTopicMessage(message) {
    return isZooTopicMessage(this, message);
  }

  async recoverZooTopicFromMessageContext(message, options = {}) {
    return recoverZooTopicFromMessageContext(this, message, options);
  }

  async ensureZooTopic(api, {
    uiLanguage = DEFAULT_UI_LANGUAGE,
  } = {}) {
    return ensureZooTopic(this, api, { uiLanguage });
  }

  async buildMenuPayload() {
    return buildMenuPayload(this);
  }

  async ensureZooMenu(api, {
    forceNew = false,
  } = {}) {
    return ensureZooMenu(this, api, { forceNew });
  }

  async handleZooCommand({
    api,
    message,
  }) {
    return handleZooCommand(this, { api, message });
  }

  async maybeHandleIncomingMessage({
    api,
    botUsername,
    message,
  }) {
    return maybeHandleIncomingMessage(this, {
      api,
      botUsername,
      message,
    });
  }

  async handleZooReply({
    api,
    message,
  }) {
    return handleZooReply(this, { api, message });
  }

  async beginLookup({
    api,
    message,
    description,
  }) {
    return beginLookup(this, { api, message, description });
  }

  async runLookup({
    api,
    description,
    requestedByUserId,
    language,
    lookupRequestId,
  }) {
    return runLookup(this, {
      api,
      description,
      requestedByUserId,
      language,
      lookupRequestId,
    });
  }

  async confirmPendingAdd({
    api,
    message,
    topicState,
  }) {
    return confirmPendingAdd(this, { api, message, topicState });
  }

  async persistCanonicalPetDisplayNames(pets, displayNames) {
    return persistCanonicalPetDisplayNames(this, pets, displayNames);
  }

  async reconcilePetDisplayNames(pets = null, extraPets = []) {
    return reconcilePetDisplayNames(this, pets, extraPets);
  }

  async clearMissingPetRefreshState(api, petId) {
    return clearMissingPetRefreshState(this, api, petId);
  }

  async handleCallbackQuery({
    api,
    callbackQuery,
  }) {
    return handleCallbackQuery(this, { api, callbackQuery });
  }

  async runRefresh({
    api,
    pet,
    language,
  }) {
    return runRefresh(this, { api, pet, language });
  }

  syncPetAnimationTicker(api, payload) {
    return syncPetAnimationTicker(this, api, payload);
  }

  startPetTicker(api, petId, intervalMs) {
    return startPetTicker(this, api, petId, intervalMs);
  }

  stopPetTicker(petId) {
    return stopPetTicker(this, petId);
  }
}
