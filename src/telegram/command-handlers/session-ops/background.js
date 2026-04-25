import { getSessionUiLanguage } from "../../../i18n/ui-language.js";
import { buildReplyMessageParams } from "../../command-parsing.js";
import { safeSendMessage } from "../../topic-delivery.js";
import {
  buildCompactFailureMessage,
  buildCompactMessage,
} from "../topic-commands.js";

export function launchCompactionInBackground({
  api,
  lifecycleManager,
  message,
  session,
  compactPromise,
}) {
  void (async () => {
    try {
      const compacted = await compactPromise;
      await safeSendMessage(
        api,
        buildReplyMessageParams(
          message,
          buildCompactMessage(
            compacted.session,
            compacted,
            getSessionUiLanguage(compacted.session),
          ),
        ),
        compacted.session,
        lifecycleManager,
      );
    } catch (error) {
      console.error(
        `background compact failed for ${session.session_key}: ${error.message}`,
      );
      try {
        await safeSendMessage(
          api,
          buildReplyMessageParams(
            message,
            buildCompactFailureMessage(
              session,
              error,
              getSessionUiLanguage(session),
            ),
          ),
          session,
          lifecycleManager,
        );
      } catch (deliveryError) {
        console.error(
          `background compact failure reply failed for ${session.session_key}: ${deliveryError.message}`,
        );
      }
    }
  })();
}
