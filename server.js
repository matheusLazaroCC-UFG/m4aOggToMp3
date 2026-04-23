const archiver = require("archiver");
const crypto = require("crypto");
const express = require("express");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
const fs = require("fs");
const fsp = require("fs/promises");
const multer = require("multer");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { EventEmitter } = require("events");

const PORT = 9090;
const JOB_RETENTION_MS = 10 * 60 * 1000;
const ALLOWED_EXTENSIONS = new Set([".m4a", ".ogg"]);
const QUALITY_PRESETS = {
  "cbr-320": {
    label: "CBR 320 kbps (taxa fixa)",
    ffmpegArgs: ["-b:a", "320k", "-minrate", "320k", "-maxrate", "320k", "-bufsize", "640k"],
  },
  "vbr-v0": {
    label: "VBR V0 (qualidade maxima variavel)",
    ffmpegArgs: ["-q:a", "0"],
  },
  "cbr-256": {
    label: "CBR 256 kbps (taxa fixa)",
    ffmpegArgs: ["-b:a", "256k", "-minrate", "256k", "-maxrate", "256k", "-bufsize", "512k"],
  },
  "cbr-192": {
    label: "CBR 192 kbps (taxa fixa)",
    ffmpegArgs: ["-b:a", "192k", "-minrate", "192k", "-maxrate", "192k", "-bufsize", "384k"],
  },
};
const QUALITY_PRESET_KEYS = new Set(Object.keys(QUALITY_PRESETS));
const ALLOWED_SAMPLE_RATES = new Set(["source", "48000", "44100"]);
const ALLOWED_CHANNELS = new Set(["source", "2", "1"]);

if (!ffmpegPath) {
  throw new Error("Nao foi possivel encontrar o binario ffmpeg para esta plataforma.");
}

const uploadRoot = path.join(os.tmpdir(), "m4a-ogg-mp3-uploads");
fs.mkdirSync(uploadRoot, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadRoot),
  filename: (_req, file, cb) => {
    const safeBase = sanitizeFileName(path.parse(file.originalname).name) || "audio";
    const extension = path.extname(file.originalname).toLowerCase();
    cb(null, `${safeBase}-${crypto.randomUUID()}${extension}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.has(extension)) {
      cb(null, true);
      return;
    }
    cb(new Error("Apenas arquivos .m4a e .ogg sao aceitos."));
  },
});

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const jobProgressStore = new Map();
const progressBus = new EventEmitter();

function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9-_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}

function normalizeJobId(rawJobId) {
  if (typeof rawJobId !== "string") {
    return null;
  }

  const normalized = rawJobId.trim();
  if (!normalized) {
    return null;
  }

  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function pickAllowedOption(rawValue, allowedValues, fallback) {
  if (typeof rawValue !== "string") {
    return fallback;
  }

  const normalized = rawValue.trim();
  if (!allowedValues.has(normalized)) {
    return fallback;
  }

  return normalized;
}

function normalizeConversionOptions(rawBody) {
  const qualityPresetKey = pickAllowedOption(rawBody?.qualityPreset, QUALITY_PRESET_KEYS, "cbr-320");
  const sampleRate = pickAllowedOption(rawBody?.sampleRate, ALLOWED_SAMPLE_RATES, "48000");
  const channels = pickAllowedOption(rawBody?.channels, ALLOWED_CHANNELS, "2");
  const preserveMetadata = rawBody?.preserveMetadata === "1" || rawBody?.preserveMetadata === "true";

  return {
    qualityPresetKey,
    qualityLabel: QUALITY_PRESETS[qualityPresetKey].label,
    sampleRate,
    channels,
    preserveMetadata,
  };
}

function buildUniqueOutputName(baseName, usedNames) {
  let outputName = `${baseName}.mp3`;
  let suffix = 2;

  while (usedNames.has(outputName)) {
    outputName = `${baseName}-${suffix}.mp3`;
    suffix += 1;
  }

  usedNames.add(outputName);
  return outputName;
}

function parseFfmpegTimecode(value) {
  const match = value.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) {
    return null;
  }

  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseFloat(match[3]);

  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }

  return hours * 3600 + minutes * 60 + seconds;
}

function computeOverallPercent(files) {
  if (files.length === 0) {
    return 0;
  }

  const sum = files.reduce((acc, file) => acc + (Number.isFinite(file.percent) ? file.percent : 0), 0);
  return Math.min(100, Math.max(0, Math.round(sum / files.length)));
}

function buildJobPayload(job) {
  return {
    jobId: job.jobId,
    stage: job.stage,
    totalFiles: job.totalFiles,
    processedFiles: job.processedFiles,
    currentFileIndex: job.currentFileIndex,
    currentFileName: job.currentFileName,
    overallPercent: job.overallPercent,
    message: job.message,
    error: job.error,
    files: job.files.map((file) => ({
      index: file.index,
      inputName: file.inputName,
      outputName: file.outputName,
      status: file.status,
      percent: file.percent,
      error: file.error,
    })),
  };
}

function scheduleJobCleanup(job) {
  if (job.cleanupTimer) {
    clearTimeout(job.cleanupTimer);
  }

  job.cleanupTimer = setTimeout(() => {
    jobProgressStore.delete(job.jobId);
  }, JOB_RETENTION_MS);

  if (typeof job.cleanupTimer.unref === "function") {
    job.cleanupTimer.unref();
  }
}

function emitJobProgress(job) {
  job.processedFiles = job.files.filter((file) => file.status === "done").length;
  job.overallPercent = computeOverallPercent(job.files);
  progressBus.emit(job.jobId, buildJobPayload(job));
}

function createJobState(jobId, files) {
  const usedNames = new Set();
  const normalizedFiles = files.map((file, index) => {
    const fallbackName = `audio_${index + 1}`;
    const baseName = sanitizeFileName(path.parse(file.originalname).name) || fallbackName;

    return {
      index: index + 1,
      inputName: file.originalname,
      outputName: buildUniqueOutputName(baseName, usedNames),
      status: "pending",
      percent: 0,
      durationSeconds: null,
      error: null,
    };
  });

  const job = {
    jobId,
    stage: "queued",
    totalFiles: normalizedFiles.length,
    processedFiles: 0,
    currentFileIndex: 0,
    currentFileName: null,
    overallPercent: 0,
    message: "Arquivos recebidos. Preparando conversao...",
    error: null,
    files: normalizedFiles,
    cleanupTimer: null,
  };

  jobProgressStore.set(jobId, job);
  emitJobProgress(job);
  return job;
}

function getAudioDurationSeconds(inputPath) {
  return new Promise((resolve) => {
    if (!ffprobePath) {
      resolve(null);
      return;
    }

    const args = [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ];

    const ffprobe = spawn(ffprobePath, args, {
      stdio: ["ignore", "pipe", "ignore"],
    });

    let stdout = "";

    ffprobe.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    ffprobe.on("error", () => {
      resolve(null);
    });

    ffprobe.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }

      const duration = Number.parseFloat(stdout.trim());
      if (Number.isFinite(duration) && duration > 0) {
        resolve(duration);
        return;
      }

      resolve(null);
    });
  });
}

function convertToMp3(inputPath, outputPath, durationSeconds, conversionOptions, onProgress) {
  return new Promise((resolve, reject) => {
    const qualityPreset = QUALITY_PRESETS[conversionOptions.qualityPresetKey] || QUALITY_PRESETS["cbr-320"];

    const args = [
      "-y",
      "-hide_banner",
      "-i",
      inputPath,
      "-vn",
      "-codec:a",
      "libmp3lame",
      ...qualityPreset.ffmpegArgs,
    ];

    if (conversionOptions.sampleRate !== "source") {
      args.push("-ar", conversionOptions.sampleRate);
    }

    if (conversionOptions.channels !== "source") {
      args.push("-ac", conversionOptions.channels);
    }

    if (conversionOptions.preserveMetadata) {
      args.push("-map_metadata", "0", "-id3v2_version", "3", "-write_id3v1", "1");
    } else {
      args.push("-map_metadata", "-1");
    }

    args.push(
      "-stats_period",
      "0.2",
      "-progress",
      "pipe:1",
      "-nostats",
      outputPath,
    );

    const ffmpeg = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    let stderr = "";
    let lastReportedPercent = 0;

    if (typeof onProgress === "function") {
      onProgress(0);
    }

    ffmpeg.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();

      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        const separatorIndex = line.indexOf("=");
        if (separatorIndex <= 0) {
          continue;
        }

        const key = line.slice(0, separatorIndex).trim();
        const value = line.slice(separatorIndex + 1).trim();

        if (key === "out_time" && Number.isFinite(durationSeconds) && durationSeconds > 0) {
          const elapsedSeconds = parseFfmpegTimecode(value);
          if (elapsedSeconds === null) {
            continue;
          }

          const percent = Math.min(99, Math.max(0, Math.round((elapsedSeconds / durationSeconds) * 100)));
          if (percent > lastReportedPercent && typeof onProgress === "function") {
            lastReportedPercent = percent;
            onProgress(percent);
          }
        }

        if (key === "progress" && value === "end" && typeof onProgress === "function") {
          onProgress(100);
        }
      }
    });

    ffmpeg.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    ffmpeg.on("error", (error) => {
      reject(error);
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg encerrou com codigo ${code}: ${stderr}`));
    });
  });
}

async function safeUnlink(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Falha ao remover arquivo temporario:", filePath, error.message);
    }
  }
}

async function safeRm(targetPath) {
  try {
    await fsp.rm(targetPath, { recursive: true, force: true });
  } catch (error) {
    console.error("Falha ao remover pasta temporaria:", targetPath, error.message);
  }
}

app.get("/progress/:jobId", (req, res) => {
  const jobId = normalizeJobId(req.params.jobId);
  if (!jobId) {
    res.status(400).json({ error: "jobId invalido." });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const job = jobProgressStore.get(jobId);
  if (job) {
    send(buildJobPayload(job));
  } else {
    send({
      jobId,
      stage: "waiting",
      totalFiles: 0,
      processedFiles: 0,
      currentFileIndex: 0,
      currentFileName: null,
      overallPercent: 0,
      message: "Aguardando inicio da conversao...",
      error: null,
      files: [],
    });
  }

  const listener = (payload) => {
    send(payload);
  };

  progressBus.on(jobId, listener);

  const keepAlive = setInterval(() => {
    res.write(":keepalive\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(keepAlive);
    progressBus.off(jobId, listener);
  });
});

app.post("/convert", upload.array("audioFiles"), async (req, res) => {
  const files = req.files || [];

  if (files.length === 0) {
    res.status(400).send("Envie ao menos um arquivo .m4a ou .ogg.");
    return;
  }

  const jobId = normalizeJobId(req.body?.jobId) || crypto.randomUUID();
  const conversionOptions = normalizeConversionOptions(req.body);
  const job = createJobState(jobId, files);
  job.message = `Arquivos recebidos. Preparando conversao em ${conversionOptions.qualityLabel}...`;
  emitJobProgress(job);

  const jobDir = path.join(os.tmpdir(), `m4a-ogg-to-mp3-${crypto.randomUUID()}`);
  await fsp.mkdir(jobDir, { recursive: true });

  let hasCleanedUp = false;
  const cleanup = async () => {
    if (hasCleanedUp) {
      return;
    }
    hasCleanedUp = true;

    await Promise.allSettled([
      ...files.map((file) => safeUnlink(file.path)),
      safeRm(jobDir),
    ]);
  };

  res.on("finish", cleanup);
  res.on("close", cleanup);

  try {
    const convertedFiles = [];

    for (const [index, file] of files.entries()) {
      const jobFile = job.files[index];
      const outputPath = path.join(jobDir, jobFile.outputName);

      job.stage = "processing";
      job.currentFileIndex = jobFile.index;
      job.currentFileName = jobFile.inputName;
      job.message = `Convertendo arquivo ${jobFile.index}/${job.totalFiles}: ${jobFile.inputName}`;
      job.error = null;

      jobFile.status = "processing";
      emitJobProgress(job);

      const durationSeconds = await getAudioDurationSeconds(file.path);
      jobFile.durationSeconds = durationSeconds;

      let lastEmittedAt = 0;
      await convertToMp3(file.path, outputPath, durationSeconds, conversionOptions, (percent) => {
        const normalizedPercent = Math.min(100, Math.max(0, Math.round(percent)));
        if (normalizedPercent < jobFile.percent) {
          return;
        }

        jobFile.percent = normalizedPercent;

        const now = Date.now();
        if (normalizedPercent === 100 || now - lastEmittedAt > 200) {
          lastEmittedAt = now;
          emitJobProgress(job);
        }
      });

      jobFile.status = "done";
      jobFile.percent = 100;
      job.message = `Arquivo ${jobFile.index}/${job.totalFiles} convertido.`;
      emitJobProgress(job);

      convertedFiles.push({ outputPath, outputFileName: jobFile.outputName });
    }

    job.stage = "zipping";
    job.currentFileIndex = 0;
    job.currentFileName = null;
    job.message = "Compactando os MP3 em arquivo ZIP...";
    emitJobProgress(job);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", "attachment; filename=audios-convertidos-mp3.zip");

    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("error", (error) => {
      console.error("Falha ao criar zip:", error.message);

      job.stage = "error";
      job.message = "Erro ao compactar os arquivos convertidos.";
      job.error = error.message;
      emitJobProgress(job);
      scheduleJobCleanup(job);

      if (!res.headersSent) {
        res.status(500).send("Erro ao compactar os arquivos convertidos.");
      } else {
        res.end();
      }
    });

    archive.on("progress", (progressData) => {
      const processedEntries = progressData?.entries?.processed || 0;
      const totalEntries = progressData?.entries?.total || 0;

      if (totalEntries > 0) {
        job.message = `Compactando ZIP (${processedEntries}/${totalEntries})...`;
        emitJobProgress(job);
      }
    });

    archive.on("end", () => {
      job.stage = "done";
      job.message = "Conversao concluida. Download do ZIP pronto.";
      emitJobProgress(job);
      scheduleJobCleanup(job);
    });

    archive.pipe(res);
    for (const file of convertedFiles) {
      archive.file(file.outputPath, { name: file.outputFileName });
    }

    archive.finalize();
  } catch (error) {
    console.error("Falha na conversao:", error.message);

    if (job.currentFileIndex > 0) {
      const failedFile = job.files[job.currentFileIndex - 1];
      if (failedFile && failedFile.status !== "done") {
        failedFile.status = "error";
        failedFile.error = error.message;
      }
    }

    job.stage = "error";
    job.message = "Falha ao converter audio. Verifique se o arquivo e valido.";
    job.error = error.message;
    emitJobProgress(job);
    scheduleJobCleanup(job);

    if (!res.headersSent) {
      res.status(500).send("Falha ao converter audio. Verifique se o arquivo e valido.");
    }
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    res.status(400).send(`Erro de upload: ${error.message}`);
    return;
  }

  if (error) {
    res.status(400).send(error.message || "Erro inesperado no envio do arquivo.");
    return;
  }

  res.status(500).send("Erro interno do servidor.");
});

app.listen(PORT, () => {
  console.log(`Servidor iniciado em http://localhost:${PORT}`);
});
