export const LARGE_EXCHANGE_LOG_THRESHOLD_BYTES = 256 * 1024;
export const LARGE_EXCHANGE_LOG_THRESHOLD_ENTRIES = 80;
export const COMPACTION_SOURCE_FILENAME = "compaction-source.md";

export const BOUNDED_ACTIVE_BRIEF_MAX_BYTES = 64 * 1024;
export const BOUNDED_RECENT_EXCHANGE_MAX_BYTES = 64 * 1024;
export const BOUNDED_RECENT_PROGRESS_MAX_BYTES = 48 * 1024;
export const BOUNDED_HIGH_SIGNAL_EXCHANGE_MAX_BYTES = 32 * 1024;
export const BOUNDED_CHRONOLOGY_CHECKPOINT_MAX_BYTES = 24 * 1024;
export const BOUNDED_ENTRY_FIELD_MAX_BYTES = 8 * 1024;
export const BOUNDED_PROGRESS_NOTE_MAX_BYTES = 8 * 1024;

export const BOUNDED_RECENT_EXCHANGE_TARGET_ENTRIES = 20;
export const BOUNDED_RECENT_PROGRESS_TARGET_NOTES = 40;
export const BOUNDED_HIGH_SIGNAL_TARGET_ENTRIES = 12;
export const BOUNDED_CHRONOLOGY_CHECKPOINT_TARGET_ENTRIES = 8;

export const HIGH_SIGNAL_EXCHANGE_RE =
  /(?:\b(?:rule|rules|preference|preferences|remember|always|never|must|should|important|send|deliver|delivery|route|routing|saved messages|telegram|artifact|output|format|json|markdown|pdf|apk|english|russian|language|locale|host|cwd|path)\b|важно|правил[ао]?|запомни|всегда|никогда|обязательно|нужно|надо|отправь|отправляй|пришли|скинь|сюда|ответь|ответ|файл|артефакт|формат|рус(?:ски[йм]|ском)?|англ(?:ийски[йм]|ийском)?|язык|хост|путь)/iu;
