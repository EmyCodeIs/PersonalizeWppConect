'use strict';

const path = require('path');
const Persistence = require('./persistence');

const DATA_DIR = path.join(process.cwd(), 'data');
const STATE_PATH = path.join(DATA_DIR, 'system-state.json');

function readJson(filePath, fallback) {
  return Persistence.readJson(filePath, fallback);
}

function writeJson(filePath, data) {
  return Persistence.writeJson(filePath, data);
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