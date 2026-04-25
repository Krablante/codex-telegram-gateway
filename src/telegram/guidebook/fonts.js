import fs from "node:fs";
import path from "node:path";

const LINUX_FONT_CANDIDATES = {
  sans: [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
  ],
  bold: [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
  ],
  mono: [
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
  ],
};

function buildWindowsFontCandidates(env = process.env) {
  const windowsRoots = Array.from(
    new Set([env.WINDIR, env.SystemRoot, "C:\\Windows"].filter(Boolean)),
  );

  return {
    sans: windowsRoots.flatMap((root) => [
      path.win32.join(root, "Fonts", "arial.ttf"),
      path.win32.join(root, "Fonts", "segoeui.ttf"),
      path.win32.join(root, "Fonts", "tahoma.ttf"),
    ]),
    bold: windowsRoots.flatMap((root) => [
      path.win32.join(root, "Fonts", "arialbd.ttf"),
      path.win32.join(root, "Fonts", "segoeuib.ttf"),
      path.win32.join(root, "Fonts", "tahomabd.ttf"),
    ]),
    mono: windowsRoots.flatMap((root) => [
      path.win32.join(root, "Fonts", "consola.ttf"),
      path.win32.join(root, "Fonts", "cour.ttf"),
      path.win32.join(root, "Fonts", "lucon.ttf"),
    ]),
  };
}

export function buildFontCandidates({
  platform = process.platform,
  env = process.env,
} = {}) {
  if (platform === "win32") {
    return buildWindowsFontCandidates(env);
  }

  return LINUX_FONT_CANDIDATES;
}

function resolveFontPath(candidates = [], existsSync = fs.existsSync) {
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolveFontSet({
  platform = process.platform,
  env = process.env,
  existsSync = fs.existsSync,
} = {}) {
  const candidates = buildFontCandidates({ platform, env });
  return {
    sans: resolveFontPath(candidates.sans, existsSync),
    bold: resolveFontPath(candidates.bold, existsSync),
    mono: resolveFontPath(candidates.mono, existsSync),
  };
}

const RESOLVED_FONTS = resolveFontSet();

export function ensureUnicodeFontCoverage(
  markdown,
  sourcePath,
  fontSet = RESOLVED_FONTS,
) {
  if (!/[\u0400-\u04FF]/u.test(String(markdown || ""))) {
    return;
  }
  if (fontSet.sans) {
    return;
  }

  throw new Error(
    `Could not find a Unicode-capable PDF font for Cyrillic guidebook text (${sourcePath}).`,
  );
}

export function registerFonts(doc, fontSet = RESOLVED_FONTS) {
  if (fontSet.sans) {
    doc.registerFont("GuideSans", fontSet.sans);
  }
  if (fontSet.bold) {
    doc.registerFont("GuideBold", fontSet.bold);
  }
  if (fontSet.mono) {
    doc.registerFont("GuideMono", fontSet.mono);
  }
}

export function getFontName(kind, fontSet = RESOLVED_FONTS) {
  if (kind === "bold") {
    if (fontSet.bold) {
      return "GuideBold";
    }
    if (fontSet.sans) {
      return "GuideSans";
    }
    return "Helvetica-Bold";
  }
  if (kind === "mono") {
    if (fontSet.mono) {
      return "GuideMono";
    }
    if (fontSet.sans) {
      return "GuideSans";
    }
    return "Courier";
  }
  return fontSet.sans ? "GuideSans" : "Helvetica";
}
