const { Plugin, PluginSettingTab, Setting } = require("obsidian");
const { spawn } = require("child_process");
const { writeFileSync, unlinkSync } = require("fs");
const { join } = require("path");
const { tmpdir, homedir } = require("os");

const VENV_PYTHON = join(homedir(), ".genotools", "audiobook", ".venv", "bin", "python3");
const SAMPLE_RATE = 24000;
const SPEED_FILE = join(tmpdir(), "genovox-speed.txt");

const DEFAULT_SETTINGS = {
  voice: "",
  speed: 0,
};

class GenoVoxPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.ttsProcess = null;
    this.isGenerating = false;
    this.isPlaying = false;
    this.isPaused = false;
    this.audioCtx = null;
    this.gainNode = null;
    this.currentSource = null;
    this.audioQueue = [];
    this.audioHistory = [];
    this.currentChunkData = null;
    this.chunkTexts = [];
    this.currentChunkIndex = -1;
    this.kokoroSpeed = 1.0;
    this.generationDone = false;
    this.elapsedSecs = 0;
    this.chunkStartTime = 0;
    this.lastSpeedChangeTime = 0;
    this.consecutiveSpeedChanges = 0;
    this.hudEl = null;
    this.hudTimer = null;

    this.ribbonIcon = this.addRibbonIcon("audio-lines", "GenoVox", () => {
      if (this.isPlaying || this.isGenerating) {
        this.stop();
      } else {
        this.readActiveNote();
      }
    });

    this.addCommand({ id: "read-note", name: "Read current note", callback: () => this.readActiveNote() });
    this.addCommand({ id: "read-selection", name: "Read selected text", callback: () => this.readSelection() });
    this.addCommand({ id: "stop", name: "Stop playback", callback: () => this.stop() });
    this.addCommand({ id: "pause-resume", name: "Pause / Resume", callback: () => this.togglePause() });
    this.addCommand({ id: "speed-up", name: "Speed up playback", callback: () => this.changeSpeed(1) });
    this.addCommand({ id: "speed-down", name: "Slow down playback", callback: () => this.changeSpeed(-1) });
    this.addCommand({ id: "skip-forward", name: "Skip forward one chunk", callback: () => this.skipForward() });
    this.addCommand({ id: "skip-back", name: "Skip back one chunk", callback: () => this.skipBack() });

    this.addSettingTab(new GenoVoxSettingTab(this.app, this));

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("genovox-status");
    this.statusBarEl.addEventListener("click", () => { if (this.isPlaying) this.togglePause(); });
    this.updateStatus("idle");

    // Create the persistent HUD overlay
    this.createHUD();
  }

  onunload() {
    this.stop();
    if (this.hudEl) { this.hudEl.remove(); this.hudEl = null; }
  }

  createHUD() {
    this.hudEl = document.createElement("div");
    this.hudEl.className = "genovox-hud";
    this.hudEl.innerHTML = `
      <div class="genovox-hud-speed"></div>
      <div class="genovox-hud-text"></div>
    `;
    document.body.appendChild(this.hudEl);
  }

  showHUD(content, autoHide = 3000) {
    if (!this.hudEl) return;
    const speedEl = this.hudEl.querySelector(".genovox-hud-speed");
    const textEl = this.hudEl.querySelector(".genovox-hud-text");

    if (content.speed !== undefined) {
      speedEl.textContent = `${content.speed.toFixed(2)}x`;
      speedEl.style.display = "";
    } else {
      speedEl.style.display = "none";
    }

    if (content.html) {
      textEl.innerHTML = content.html;
    } else if (content.text) {
      textEl.textContent = content.text;
    }

    this.hudEl.classList.add("visible");

    if (this.hudTimer) clearTimeout(this.hudTimer);
    if (autoHide > 0) {
      this.hudTimer = setTimeout(() => {
        this.hudEl.classList.remove("visible");
        this.hudTimer = null;
      }, autoHide);
    }
  }

  hideHUD() {
    if (!this.hudEl) return;
    this.hudEl.classList.remove("visible");
    if (this.hudTimer) { clearTimeout(this.hudTimer); this.hudTimer = null; }
  }

  // Build the scrub context HTML: faded words before, highlighted current phrase, faded words after
  buildScrubHTML(chunkIndex) {
    const CONTEXT_WORDS = 12;
    const current = this.chunkTexts[chunkIndex] || "";
    const prev = this.chunkTexts[chunkIndex - 1] || "";
    const next = this.chunkTexts[chunkIndex + 1] || "";

    // Get trailing words from previous chunk
    const prevWords = prev.split(/\s+/).filter(Boolean);
    const beforeWords = prevWords.slice(-CONTEXT_WORDS).join(" ");

    // Get first ~15 words of current chunk as the highlight
    const curWords = current.split(/\s+/).filter(Boolean);
    const highlightWords = curWords.slice(0, 15).join(" ");
    const restCurrent = curWords.slice(15).join(" ");

    // Get leading words from next chunk (or rest of current)
    const afterSource = restCurrent || next;
    const afterWords = afterSource.split(/\s+/).filter(Boolean).slice(0, CONTEXT_WORDS).join(" ");

    const parts = [];
    if (beforeWords) parts.push(`<span class="before">...${beforeWords} </span>`);
    parts.push(`<span class="current">${highlightWords}</span>`);
    if (afterWords) parts.push(`<span class="after"> ${afterWords}...</span>`);

    return parts.join("");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  updateStatus(state, detail) {
    this.statusBarEl.empty();
    switch (state) {
      case "idle": break;
      case "generating":
        this.statusBarEl.createSpan({ cls: "spinner" });
        this.statusBarEl.createSpan({ text: detail || "Generating..." });
        break;
      case "streaming":
        this.statusBarEl.createSpan({ text: `▶ ${detail || "Streaming..."}` });
        break;
      case "playing":
        this.statusBarEl.createSpan({ text: `▶ ${detail || "Playing"}` });
        break;
      case "paused":
        this.statusBarEl.createSpan({ text: `⏸ ${detail || "Paused"}` });
        break;
    }
  }

  readActiveNote() {
    const editor = this.app.workspace.activeEditor?.editor;
    if (editor) {
      const selection = editor.getSelection();
      if (selection && selection.trim()) {
        this.streamAndPlay(selection, "selection");
        return;
      }
    }
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    this.app.vault.read(file).then((text) => {
      if (text.trim()) this.streamAndPlay(text, file.basename);
    });
  }

  readSelection() {
    const editor = this.app.workspace.activeEditor?.editor;
    if (!editor) return;
    const selection = editor.getSelection();
    if (selection && selection.trim()) this.streamAndPlay(selection, "selection");
  }

  streamAndPlay(text, label) {
    this.stop();

    this.isGenerating = true;
    this.isPlaying = false;
    this.isPaused = false;
    this.kokoroSpeed = this.settings.speed > 0 ? this.settings.speed : 1.0;
    this.audioQueue = [];
    this.audioHistory = [];
    this.currentChunkData = null;
    this.chunkTexts = [];
    this.currentChunkIndex = -1;
    this.currentSource = null;
    this.currentBuffer = null;
    this.chunkOffset = 0;
    this.generationDone = false;
    this.elapsedSecs = 0;
    this.chunkStartTime = 0;
    this.label = label;
    this.sourceText = text;
    this.updateStatus("generating", "Loading Kokoro...");

    this.audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.gainNode = this.audioCtx.createGain();
    this.gainNode.connect(this.audioCtx.destination);

    const inputPath = join(tmpdir(), `genovox-input-${Date.now()}.txt`);
    const vaultBase = this.app.vault.adapter.basePath;
    const workerPath = join(vaultBase, this.manifest.dir, "tts_worker.py");

    try {
      writeFileSync(inputPath, text, "utf-8");
    } catch (e) {
      this.isGenerating = false;
      this.updateStatus("idle");
      return;
    }

    const args = [workerPath, "--input", inputPath, "--speed-file", SPEED_FILE];
    if (this.settings.voice) args.push("--voice", this.settings.voice);
    if (this.settings.speed > 0) args.push("--speed", String(this.settings.speed));

    try { writeFileSync(SPEED_FILE, String(this.kokoroSpeed), "utf-8"); } catch (_) {}

    this.showHUD({ text: `Loading "${label}"...`, speed: this.kokoroSpeed }, 0);

    const proc = spawn(VENV_PYTHON, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.ttsProcess = proc;

    let stdoutBuffer = Buffer.alloc(0);
    let firstChunkPlayed = false;

    proc.stdout.on("data", (data) => {
      stdoutBuffer = Buffer.concat([stdoutBuffer, data]);
      while (stdoutBuffer.length >= 4) {
        const chunkSize = stdoutBuffer.readUInt32LE(0);
        if (stdoutBuffer.length < 4 + chunkSize) break;
        const pcmData = stdoutBuffer.slice(4, 4 + chunkSize);
        stdoutBuffer = stdoutBuffer.slice(4 + chunkSize);
        const float32 = new Float32Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength / 4);
        this.enqueueAudio(float32);
        if (!firstChunkPlayed) {
          firstChunkPlayed = true;
          this.isPlaying = true;
          this.updateStatus("streaming", `${label} (${this.kokoroSpeed.toFixed(2)}x)`);
          this.startPlaybackTimer();
          this.hideHUD();
        }
      }
    });

    let stderrBuffer = "";
    proc.stderr.on("data", (data) => {
      stderrBuffer += data.toString();
      const lines = stderrBuffer.split("\n");
      stderrBuffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.chunk_text) this.chunkTexts.push(msg.chunk_text);
          if (msg.done) {
            this.generationDone = true;
            this.isGenerating = false;
          } else if (msg.percent && this.isPlaying) {
            this.updateStatus("streaming", `${label} (${this.kokoroSpeed.toFixed(2)}x, gen: ${msg.percent}%)`);
          } else if (msg.message && !this.isPlaying) {
            this.updateStatus("generating", msg.message);
          }
        } catch (_) {}
      }
    });

    proc.on("close", (code) => {
      this.ttsProcess = null;
      this.isGenerating = false;
      this.generationDone = true;
      try { unlinkSync(inputPath); } catch (_) {}
      if (code !== 0 && code !== null && !this.isPlaying) this.updateStatus("idle");
    });

    proc.on("error", (err) => {
      this.ttsProcess = null;
      this.isGenerating = false;
      this.updateStatus("idle");
      try { unlinkSync(inputPath); } catch (_) {}
    });
  }

  enqueueAudio(float32Data) {
    const index = this.audioQueue.length + this.audioHistory.length;
    this.audioQueue.push({ audio: float32Data, index });
    if (!this.currentSource) this.playNext();
  }

  playNext(offset = 0) {
    if (!this.audioCtx) return;

    if (this.audioQueue.length === 0) {
      this.currentSource = null;
      this.currentBuffer = null;
      if (this.generationDone) {
        this.isPlaying = false;
        this.updateStatus("idle");
        this.showHUD({ text: "Finished" }, 2000);
        if (this.playbackTimer) { clearInterval(this.playbackTimer); this.playbackTimer = null; }
      }
      return;
    }

    const entry = this.audioQueue.shift();
    this.currentChunkData = entry;
    this.currentChunkIndex = entry.index;
    this.audioHistory.push(entry);

    const buffer = this.audioCtx.createBuffer(1, entry.audio.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(entry.audio);
    this.currentBuffer = buffer;

    this.playFromOffset(buffer, entry, offset);
  }

  playFromOffset(buffer, entry, offset) {
    // Clamp offset
    offset = Math.max(0, Math.min(offset, buffer.duration - 0.05));
    this.chunkOffset = offset;

    const source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    // No playbackRate — Kokoro handles speed natively, no chipmunk
    source.connect(this.gainNode);
    source.onended = () => {
      this.elapsedSecs += buffer.duration - offset;
      this.chunkOffset = 0;
      this.playNext();
    };
    source.start(0, offset);
    this.currentSource = source;
    this.chunkStartTime = this.audioCtx.currentTime;

    this.scrollToChunkWord(entry.index, offset, buffer.duration);
  }

  changeSpeed(direction) {
    const now = Date.now();
    if (now - this.lastSpeedChangeTime < 400) {
      this.consecutiveSpeedChanges = Math.min(this.consecutiveSpeedChanges + 1, 20);
    } else {
      this.consecutiveSpeedChanges = 0;
    }
    this.lastSpeedChangeTime = now;

    const step = Math.min(0.01 + this.consecutiveSpeedChanges * 0.002, 0.05);
    this.kokoroSpeed = Math.round(Math.max(0.5, Math.min(2.0, this.kokoroSpeed + direction * step)) * 100) / 100;

    // Write speed for any in-progress generation
    try { writeFileSync(SPEED_FILE, String(this.kokoroSpeed), "utf-8"); } catch (_) {}

    // If generation is done, re-generate the queued chunks at the new speed
    if (this.generationDone && this.audioQueue.length > 0) {
      this.regenerateQueue();
    }

    if (this.isPlaying || this.isGenerating) {
      const html = this.currentChunkIndex >= 0 ? this.buildScrubHTML(this.currentChunkIndex) : "";
      this.showHUD({ speed: this.kokoroSpeed, html: html || `${this.kokoroSpeed.toFixed(2)}x` }, 2000);
    }
  }

  regenerateQueue() {
    // Collect text of remaining queued chunks
    const remainingTexts = [];
    for (const entry of this.audioQueue) {
      const t = this.chunkTexts[entry.index];
      if (t) remainingTexts.push(t);
    }
    if (remainingTexts.length === 0) return;

    // Clear the queue (current chunk keeps playing)
    const oldQueueLen = this.audioQueue.length;
    this.audioQueue = [];
    this.generationDone = false;
    this.isGenerating = true;

    // Write remaining text and launch a new worker
    const inputPath = join(tmpdir(), `genovox-regen-${Date.now()}.txt`);
    const vaultBase = this.app.vault.adapter.basePath;
    const workerPath = join(vaultBase, this.manifest.dir, "tts_worker.py");

    try {
      writeFileSync(inputPath, remainingTexts.join("\n\n"), "utf-8");
    } catch (_) { return; }

    const args = [workerPath, "--input", inputPath, "--speed-file", SPEED_FILE,
                  "--speed", String(this.kokoroSpeed)];
    if (this.settings.voice) args.push("--voice", this.settings.voice);

    // Kill old worker if still running
    if (this.ttsProcess) { this.ttsProcess.kill("SIGTERM"); this.ttsProcess = null; }

    const proc = spawn(VENV_PYTHON, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.ttsProcess = proc;

    // Track new chunk indices starting after current
    let regenCount = 0;
    let stdoutBuffer = Buffer.alloc(0);

    proc.stdout.on("data", (data) => {
      stdoutBuffer = Buffer.concat([stdoutBuffer, data]);
      while (stdoutBuffer.length >= 4) {
        const chunkSize = stdoutBuffer.readUInt32LE(0);
        if (stdoutBuffer.length < 4 + chunkSize) break;
        const pcmData = stdoutBuffer.slice(4, 4 + chunkSize);
        stdoutBuffer = stdoutBuffer.slice(4 + chunkSize);
        const float32 = new Float32Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength / 4);
        // Reuse original indices
        const origIndex = this.currentChunkIndex + 1 + regenCount;
        this.audioQueue.push({ audio: float32, index: origIndex });
        regenCount++;
        if (!this.currentSource) this.playNext();
      }
    });

    proc.stderr.on("data", () => {}); // ignore stderr for regen

    proc.on("close", () => {
      this.ttsProcess = null;
      this.isGenerating = false;
      this.generationDone = true;
      try { unlinkSync(inputPath); } catch (_) {}
    });
  }

  skipForward() {
    if (!this.isPlaying || !this.audioCtx) return;
    const WORD_SECS = 0.35;

    // Calculate current position in chunk
    const elapsed = this.audioCtx.currentTime - this.chunkStartTime;
    const currentPos = this.chunkOffset + elapsed;
    const newPos = currentPos + WORD_SECS;

    // Stop current source
    if (this.currentSource) {
      this.currentSource.onended = null;
      try { this.currentSource.stop(); } catch (_) {}
      this.currentSource = null;
    }

    // If past end of current chunk, move to next
    if (this.currentBuffer && newPos >= this.currentBuffer.duration) {
      if (this.audioQueue.length === 0 && this.generationDone) return;
      this.elapsedSecs += this.currentBuffer.duration / this.kokoroSpeed;
      this.chunkOffset = 0;
      this.playNext();
    } else if (this.currentBuffer) {
      this.playFromOffset(this.currentBuffer, this.currentChunkData, newPos);
    }

    this.showScrubHUD();
  }

  skipBack() {
    if (!this.isPlaying || !this.audioCtx) return;
    const WORD_SECS = 0.35;

    // Calculate current position in chunk
    const elapsed = this.audioCtx.currentTime - this.chunkStartTime;
    const currentPos = this.chunkOffset + elapsed;
    const newPos = currentPos - WORD_SECS;

    // Stop current source
    if (this.currentSource) {
      this.currentSource.onended = null;
      try { this.currentSource.stop(); } catch (_) {}
      this.currentSource = null;
    }

    // If before start of current chunk, move to previous
    if (newPos < 0) {
      if (this.audioHistory.length <= 1) {
        // At the very beginning, just restart current chunk
        if (this.currentBuffer) this.playFromOffset(this.currentBuffer, this.currentChunkData, 0);
        this.showScrubHUD();
        return;
      }
      // Put current chunk back
      if (this.currentChunkData) {
        this.audioQueue.unshift(this.currentChunkData);
        this.audioHistory.pop();
      }
      const prev = this.audioHistory.pop();
      if (prev) {
        this.audioQueue.unshift(prev);
        // Start near the end of the previous chunk
        const prevBuffer = this.audioCtx.createBuffer(1, prev.audio.length, SAMPLE_RATE);
        prevBuffer.getChannelData(0).set(prev.audio);
        const prevOffset = Math.max(0, prevBuffer.duration + newPos); // newPos is negative
        this.playNext(prevOffset);
      }
    } else if (this.currentBuffer) {
      this.playFromOffset(this.currentBuffer, this.currentChunkData, newPos);
    }

    this.showScrubHUD();
  }

  showScrubHUD() {
    if (this.currentChunkIndex < 0) return;
    const text = this.chunkTexts[this.currentChunkIndex] || "";
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 0) return;

    // Estimate which word we're at based on position in chunk
    const duration = this.currentBuffer ? this.currentBuffer.duration : 1;
    const fraction = Math.max(0, Math.min(1, this.chunkOffset / duration));
    const wordIndex = Math.floor(fraction * words.length);

    const CONTEXT = 8;
    const start = Math.max(0, wordIndex - CONTEXT);
    const end = Math.min(words.length, wordIndex + CONTEXT + 1);

    const before = words.slice(start, wordIndex).join(" ");
    const current = words.slice(wordIndex, Math.min(wordIndex + 3, end)).join(" ");
    const after = words.slice(Math.min(wordIndex + 3, end), end).join(" ");

    let html = "";
    if (start > 0) html += `<span class="before">...`;
    if (before) html += `<span class="before">${before} </span>`;
    html += `<span class="current">${current}</span>`;
    if (after) html += `<span class="after"> ${after}</span>`;
    if (end < words.length) html += `...</span>`;

    this.showHUD({ speed: this.kokoroSpeed, html }, 2500);
  }

  scrollToChunkWord(chunkIndex, offset, duration) {
    const text = this.chunkTexts[chunkIndex];
    if (!text) return;

    const editor = this.app.workspace.activeEditor?.editor;
    if (!editor) return;

    const doc = editor.getValue();
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length < 2) return;

    // Estimate word position from audio offset
    const fraction = duration > 0 ? Math.max(0, Math.min(1, offset / duration)) : 0;
    const wordIdx = Math.floor(fraction * words.length);

    // Search for words around the estimated position
    const searchStart = Math.max(0, wordIdx);
    const searchWords = words.slice(searchStart, searchStart + 6);
    if (searchWords.length < 2) return;

    try {
      const pattern = searchWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]{0,20}");
      const regex = new RegExp(pattern, "i");
      const match = doc.match(regex);
      if (match) {
        const before = doc.slice(0, match.index);
        const line = (before.match(/\n/g) || []).length;
        editor.setCursor({ line, ch: 0 });
        editor.scrollIntoView(
          { from: { line: Math.max(0, line - 3), ch: 0 }, to: { line: line + 5, ch: 0 } },
          true
        );
      }
    } catch (_) {}
  }

  startPlaybackTimer() {
    if (this.playbackTimer) clearInterval(this.playbackTimer);
    this.playbackTimer = setInterval(() => {
      if (!this.isPlaying || !this.audioCtx) {
        clearInterval(this.playbackTimer); this.playbackTimer = null; return;
      }
      if (this.isPaused) return;
      const chunkElapsed = this.audioCtx.currentTime - this.chunkStartTime;
      const total = this.elapsedSecs + chunkElapsed;
      const cur = this.formatTime(Math.max(0, total));
      const state = this.generationDone ? "playing" : "streaming";
      this.updateStatus(state, `${cur} (${this.kokoroSpeed.toFixed(2)}x)`);
    }, 500);
  }

  formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  togglePause() {
    if (!this.audioCtx || !this.isPlaying) return;
    if (this.isPaused) {
      this.audioCtx.resume();
      this.isPaused = false;
      this.updateStatus("playing");
      this.hideHUD();
    } else {
      this.audioCtx.suspend();
      this.isPaused = true;
      this.updateStatus("paused");
      if (this.currentChunkIndex >= 0) {
        this.showHUD({ speed: this.kokoroSpeed, html: this.buildScrubHTML(this.currentChunkIndex), text: null }, 0);
      }
    }
  }

  stop() {
    if (this.ttsProcess) { this.ttsProcess.kill("SIGTERM"); this.ttsProcess = null; }
    if (this.currentSource) { try { this.currentSource.stop(); } catch (_) {} this.currentSource = null; }
    this.audioQueue = [];
    this.audioHistory = [];
    if (this.audioCtx) { this.audioCtx.close().catch(() => {}); this.audioCtx = null; }
    if (this.playbackTimer) { clearInterval(this.playbackTimer); this.playbackTimer = null; }
    this.isGenerating = false;
    this.isPlaying = false;
    this.isPaused = false;
    this.generationDone = false;
    this.consecutiveSpeedChanges = 0;
    try { unlinkSync(SPEED_FILE); } catch (_) {}
    this.hideHUD();
    this.updateStatus("idle");
  }
}

class GenoVoxSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "GenoVox TTS Settings" });
    containerEl.createEl("p", {
      text: "Leave voice and speed blank to use your ~/.genotools/tts/config.yaml settings.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Voice").setDesc("Kokoro voice ID (e.g. af_heart, af_bella, af_nova)")
      .addText((t) => t.setPlaceholder("From config").setValue(this.plugin.settings.voice)
        .onChange(async (v) => { this.plugin.settings.voice = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Speed").setDesc("Speech speed multiplier (e.g. 1.0, 1.2)")
      .addText((t) => t.setPlaceholder("From config (1.0)")
        .setValue(this.plugin.settings.speed > 0 ? String(this.plugin.settings.speed) : "")
        .onChange(async (v) => { const n = parseFloat(v); this.plugin.settings.speed = isNaN(n) ? 0 : n; await this.plugin.saveSettings(); }));

    containerEl.createEl("h3", { text: "Available Voices" });
    const vl = containerEl.createEl("div", { cls: "setting-item-description" });
    vl.createEl("strong", { text: "Female: " });
    vl.appendText("af_heart, af_alloy, af_aoede, af_bella, af_jessica, af_kore, af_nicole, af_nova, af_river, af_sarah, af_sky");
    vl.createEl("br");
    vl.createEl("strong", { text: "Male: " });
    vl.appendText("am_adam, am_echo, am_eric, am_fenrir, am_liam, am_michael, am_onyx, am_puck");
  }
}

module.exports = GenoVoxPlugin;
