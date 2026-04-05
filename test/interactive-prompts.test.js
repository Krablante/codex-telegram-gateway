import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { promptPassword, promptText } from "../src/cli/interactive-prompts.js";

class CaptureWritable extends Writable {
  constructor() {
    super();
    this.chunks = [];
    this.isTTY = true;
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk).toString("utf8"));
    callback();
  }

  text() {
    return this.chunks.join("");
  }
}

class FakePasswordInput extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.isRaw = false;
    this.rawTransitions = [];
  }

  setRawMode(value) {
    this.isRaw = Boolean(value);
    this.rawTransitions.push(this.isRaw);
  }

  resume() {}

  pause() {}
}

test("promptText trims terminal input via builtin readline", async () => {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  const stdout = new CaptureWritable();

  const promptPromise = promptText("Prompt: ", { stdin, stdout });
  stdin.end("  12345  \n");

  assert.equal(await promptPromise, "12345");
  assert.match(stdout.text(), /Prompt: /u);
});

test("promptPassword collects hidden tty input without echoing the secret", async () => {
  const stdin = new FakePasswordInput();
  const stdout = new CaptureWritable();

  const promptPromise = promptPassword("Password: ", { stdin, stdout });
  stdin.emit("keypress", "s", { name: "s" });
  stdin.emit("keypress", "e", { name: "e" });
  stdin.emit("keypress", "x", { name: "x" });
  stdin.emit("keypress", "x", { name: "x" });
  stdin.emit("keypress", "", { name: "backspace" });
  stdin.emit("keypress", "r", { name: "r" });
  stdin.emit("keypress", "e", { name: "e" });
  stdin.emit("keypress", "t", { name: "t" });
  stdin.emit("keypress", "", { name: "return" });

  assert.equal(await promptPromise, "sexret");
  assert.deepEqual(stdin.rawTransitions, [true, false]);
  assert.equal(stdout.text(), "Password: \n");
  assert.doesNotMatch(stdout.text(), /sexret/u);
});
