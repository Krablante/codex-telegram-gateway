export function getUtf8ByteLength(text) {
  return Buffer.byteLength(String(text || ""), "utf8");
}

function sliceStartToUtf8Bytes(text, maxBytes) {
  const normalized = String(text || "");
  if (maxBytes <= 0 || !normalized) {
    return "";
  }
  if (getUtf8ByteLength(normalized) <= maxBytes) {
    return normalized;
  }

  let low = 0;
  let high = normalized.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (getUtf8ByteLength(normalized.slice(0, mid)) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return normalized.slice(0, low);
}

function sliceEndToUtf8Bytes(text, maxBytes) {
  const normalized = String(text || "");
  if (maxBytes <= 0 || !normalized) {
    return "";
  }
  if (getUtf8ByteLength(normalized) <= maxBytes) {
    return normalized;
  }

  let low = 0;
  let high = normalized.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (getUtf8ByteLength(normalized.slice(normalized.length - mid)) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return normalized.slice(normalized.length - low);
}

export function truncateTextToUtf8Bytes(text, maxBytes) {
  const normalized = String(text || "");
  if (maxBytes <= 0 || !normalized) {
    return "";
  }
  if (getUtf8ByteLength(normalized) <= maxBytes) {
    return normalized;
  }

  const suffix = "\n\n[truncated for compaction safety]\n";
  const suffixBytes = getUtf8ByteLength(suffix);
  if (suffixBytes >= maxBytes) {
    return "";
  }

  return `${sliceStartToUtf8Bytes(normalized, maxBytes - suffixBytes)}${suffix}`;
}

export function truncateTextMiddleToUtf8Bytes(text, maxBytes) {
  const normalized = String(text || "");
  if (maxBytes <= 0 || !normalized) {
    return "";
  }
  if (getUtf8ByteLength(normalized) <= maxBytes) {
    return normalized;
  }

  const marker = "\n\n[truncated middle for compaction safety]\n\n";
  const markerBytes = getUtf8ByteLength(marker);
  if (markerBytes >= maxBytes) {
    return "";
  }

  const availableBytes = maxBytes - markerBytes;
  const headBytes = Math.ceil(availableBytes * 0.45);
  const tailBytes = availableBytes - headBytes;

  return [
    sliceStartToUtf8Bytes(normalized, headBytes).trimEnd(),
    marker.trim(),
    sliceEndToUtf8Bytes(normalized, tailBytes).trimStart(),
  ].join("\n");
}
