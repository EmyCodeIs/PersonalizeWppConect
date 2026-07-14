'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');
const STATE_PATH = path.join(DATA_DIR, 'system-state.json');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureDataDir();
  fs.writeFileSync(`${filePath}.tmp`, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(`${filePath}.tmp`, filePath);
}

function nowIso() {
  return new Date().toISOString();
}

const state = readJson(STATE_PATH, {
  paused: false,
  reason: null,
  pausedAt: null,
  updatedAt: null,
});

function persist() {
  state.updatedAt = nowIso();
  writeJson(STATE_PATH, state);
}

function getState() {
  return {
    paused: state.paused === true,
    reason: state.reason || null,
    pausedAt: state.pausedAt || null,
    updatedAt: state.updatedAt || null,
  };
}

function pause(reason = null) {
  state.paused = true;
  state.reason = String(reason || '').trim() || null;
  state.pausedAt = nowIso();
  persist();
  return getState();
}

function resume() {
  state.paused = false;
  state.reason = null;
  state.pausedAt = null;
  persist();
  return getState();
}

function reset() {
  state.paused = false;
  state.reason = null;
  state.pausedAt = null;
  persist();
  return getState();
}

module.exports = {
  getState,
  pause,
  resume,
  reset,
};