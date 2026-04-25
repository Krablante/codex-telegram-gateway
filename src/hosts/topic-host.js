function normalizeText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

export function normalizeHostId(value, fallback = null) {
  const normalized = normalizeText(value);
  if (normalized) {
    return normalized.toLowerCase();
  }

  return normalizeText(fallback)?.toLowerCase() || null;
}

export function normalizeHostLabel(value, fallback = null) {
  return normalizeText(value) || normalizeText(fallback) || null;
}

export function getHostRecordId(host) {
  return normalizeHostId(host?.host_id ?? host?.hostId);
}

function getTopicHostSuffix(hostId) {
  const normalizedHostId = normalizeHostId(hostId);
  return normalizedHostId ? ` (${normalizedHostId})` : "";
}

function stripKnownTopicHostSuffix(topicName, hostIds = []) {
  const normalizedTopicName = normalizeText(topicName) || "";
  if (!normalizedTopicName) {
    return "";
  }

  const suffixes = [...new Set(
    hostIds
      .map((hostId) => getTopicHostSuffix(hostId))
      .filter(Boolean),
  )].sort((left, right) => right.length - left.length);

  for (const suffix of suffixes) {
    if (normalizedTopicName.endsWith(suffix)) {
      return normalizedTopicName.slice(0, -suffix.length).trimEnd();
    }
  }

  return normalizedTopicName;
}

export function appendTopicHostSuffix(
  topicName,
  hostId,
  maxLength = 128,
  knownHostIds = [],
) {
  const baseName = normalizeText(topicName) || "";
  const suffix = getTopicHostSuffix(hostId);
  if (!suffix) {
    return baseName.slice(0, maxLength);
  }

  const trimmedBaseName = stripKnownTopicHostSuffix(baseName, [
    hostId,
    ...knownHostIds,
  ]);

  if (!trimmedBaseName) {
    return suffix.trimStart().slice(0, maxLength);
  }

  const maxBaseLength = Math.max(0, maxLength - suffix.length);
  const trimmedBase = maxBaseLength > 0
    ? trimmedBaseName.slice(0, maxBaseLength).trimEnd()
    : "";

  return `${trimmedBase}${suffix}`.slice(0, maxLength);
}

export function formatExecutionHostName(hostLabel = null, hostId = null) {
  const normalizedHostId = normalizeHostId(hostId);
  const normalizedLabel = normalizeHostLabel(hostLabel, normalizedHostId);
  return normalizedLabel || "unknown";
}
