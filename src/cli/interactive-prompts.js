import process from "node:process";
import readline from "node:readline";
import readlinePromises from "node:readline/promises";

function normalizePromptValue(value) {
  return String(value ?? "").trim();
}

export async function promptText(
  prompt,
  {
    stdin = process.stdin,
    stdout = process.stdout,
  } = {},
) {
  const rl = readlinePromises.createInterface({
    input: stdin,
    output: stdout,
    terminal: Boolean(stdin?.isTTY && stdout?.isTTY),
  });

  try {
    return normalizePromptValue(await rl.question(prompt));
  } finally {
    rl.close();
  }
}

export async function promptPassword(
  prompt,
  {
    stdin = process.stdin,
    stdout = process.stdout,
  } = {},
) {
  if (
    !stdin
    || !stdout
    || !stdin.isTTY
    || !stdout.isTTY
    || typeof stdin.setRawMode !== "function"
  ) {
    return promptText(prompt, { stdin, stdout });
  }

  return new Promise((resolve, reject) => {
    const emitterInput = /** @type {import("node:events").EventEmitter} */ (stdin);
    const previousRawMode = Boolean(stdin.isRaw);
    let finished = false;
    let secret = "";

    const cleanup = () => {
      if (finished) {
        return;
      }
      finished = true;
      emitterInput.off("keypress", onKeypress);
      if (!previousRawMode) {
        stdin.setRawMode(false);
      }
      stdout.write("\n");
      stdin.pause?.();
    };

    const finishResolve = () => {
      cleanup();
      resolve(normalizePromptValue(secret));
    };

    const finishReject = (error) => {
      cleanup();
      reject(error);
    };

    const onKeypress = (chunk, key = {}) => {
      if (key.ctrl && key.name === "c") {
        finishReject(new Error("Interactive prompt canceled."));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        finishResolve();
        return;
      }
      if (key.name === "backspace") {
        secret = secret.slice(0, -1);
        return;
      }
      if (key.ctrl || key.meta || key.name === "escape") {
        return;
      }

      const text = typeof chunk === "string" ? chunk : String(chunk ?? "");
      secret += text;
    };

    readline.emitKeypressEvents(stdin);
    stdout.write(prompt);
    stdin.resume?.();
    if (!previousRawMode) {
      stdin.setRawMode(true);
    }
    emitterInput.on("keypress", onKeypress);
  });
}
