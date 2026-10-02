'use strict';
/* global chrome */
var state = {};

const setItems = ['soundscape'];

state.soundscape = new Set(); // Playing tabs in the soundscape window.
state.soundscapeWindow = null; // Window whose media is the soundscape.
state.soundscapePausedBy = null; // Outside tab that paused the soundscape.
// Tabs paused by the playback shortcut. Later media must not resume them.
var shortcutPausedTabs = new Set();
// Tabs just paused because their window lost the soundscape. Ignore the
// pause echo so it does not immediately silence the new soundscape window.
var leavingSoundscape = new Set();

let resolveInitialization;
const initializationCompletePromise = new Promise((resolve) => {
  resolveInitialization = resolve;
});

async function save() {
  const temp = Object.assign({}, state);
  for (const value of setItems) {
    temp[value] = [...temp[value]];
  }
  await chrome.storage.session.set({state: temp});
  announceMembership(false);
}

// The main-world hook breaks Netflix playback.
const unsupportedWindowScripts = ['https://*.netflix.com/*'];

async function restore() {
  const result = await chrome.storage.session.get('state');
  if (typeof result.state === 'object' && result.state !== null) {
    for (const value of setItems) {
      result.state[value] = new Set(result.state[value] || []);
    }
    state.soundscape = result.state.soundscape;
    state.soundscapeWindow = result.state.soundscapeWindow ?? null;
    state.soundscapePausedBy = result.state.soundscapePausedBy ?? null;
  }
  if (typeof state.soundscapeWindow !== 'number' || state.soundscapeWindow < 0) {
    const hadMembers = state.soundscape.size > 0;
    state.soundscapeWindow = null;
    state.soundscape = new Set();
    state.soundscapePausedBy = null;
    if (hadMembers) await save();
  } else {
    try {
      await chrome.windows.get(state.soundscapeWindow);
    } catch {
      state.soundscapeWindow = null;
      state.soundscape = new Set();
      state.soundscapePausedBy = null;
      await save();
    }
  }
  applyDefaultShortcuts();
  announceMembership(true);
  resolveInitialization();
}

const defaultShortcuts = {
  togglePlayback: 'Alt+P',
  soundscapewindow: 'Alt+S'
};

async function applyDefaultShortcuts() {
  if (!chrome.commands || !chrome.commands.getAll || !chrome.commands.update)
    return;
  const commands = await chrome.commands.getAll();
  for (const command of commands) {
    const shortcut = defaultShortcuts[command.name];
    // Suggested keys apply on install only. Fill an empty shortcut without
    // replacing one the user already chose.
    if (!shortcut || command.shortcut) continue;
    try {
      await chrome.commands.update({
        name: command.name,
        shortcut
      });
    } catch {}
  }
}

restore();

chrome.runtime.onInstalled.addListener(async () => {
  await initializationCompletePromise;
  updateExtensionScripts();
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'soundscape-query') {
    initializationCompletePromise.then(() => {
      sendResponse({
        member: Boolean(sender.tab && state.soundscape.has(sender.tab.id))
      });
    });
    return true;
  }
  onRuntimeMessage(message, sender);
});

async function onRuntimeMessage(message, sender) {
  await initializationCompletePromise;
  // Security: Messages are from untrusted website content scripts.
  if (!hasProperty(sender, 'tab')) return;
  switch (message.type) {
    case 'play':
      await onPlay(sender.tab, Boolean(message.volumeChange));
      break;
    case 'pause':
      if (await isPlaying(sender.tab.id)) break;
      onPause(sender.tab.id);
      break;
    case 'media-key':
      if (!state.soundscape.has(sender.tab.id)) break;
      await onSoundscapeMediaKey(message.action);
      save();
      break;
  }
}

chrome.tabs.onReplaced.addListener(async (newId, oldId) => {
  await initializationCompletePromise;
  if (state.soundscape.has(oldId)) {
    state.soundscape.delete(oldId);
    state.soundscape.add(newId);
  }
  if (shortcutPausedTabs.has(oldId)) {
    shortcutPausedTabs.delete(oldId);
    shortcutPausedTabs.add(newId);
  }
  if (state.soundscapePausedBy === oldId) state.soundscapePausedBy = newId;
  save();
});

async function onPlay(tab, keepOthers = false) {
  if (!tab || leavingSoundscape.has(tab.id)) return;

  const inSoundscape =
    state.soundscapeWindow !== null && tab.windowId === state.soundscapeWindow;
  if (inSoundscape) state.soundscape.add(tab.id);

  // Outside media pauses a playing soundscape, and only that media may resume it.
  // A soundscape that is already paused stays paused when later media ends.
  if (
    tab.audible &&
    !keepOthers &&
    state.soundscapeWindow !== null &&
    !inSoundscape &&
    state.soundscapePausedBy === null &&
    (await soundscapeIsPlaying()) &&
    state.soundscapePausedBy === null
  ) {
    state.soundscapePausedBy = tab.id;
    for (const memberId of state.soundscape) pause(memberId);
  }
  save();
}

function onPause(id) {
  if (id === state.soundscapePausedBy) resumeSoundscape();
  save();
}

chrome.tabs.onDetached.addListener(async (id, info) => {
  await initializationCompletePromise;
  if (
    state.soundscapeWindow === null ||
    !info ||
    info.oldWindowId !== state.soundscapeWindow
  )
    return;
  state.soundscape.delete(id);
  shortcutPausedTabs.delete(id);
  save();
});

chrome.tabs.onAttached.addListener(async (tabId, info) => {
  await initializationCompletePromise;
  if (state.soundscapeWindow !== info.newWindowId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.audible) state.soundscape.add(tabId);
  } catch {}
  save();
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  await initializationCompletePromise;
  if (state.soundscapeWindow !== windowId) return;
  state.soundscapeWindow = null;
  state.soundscape.clear();
  state.soundscapePausedBy = null;
  save();
});

chrome.commands.onCommand.addListener(async (command) => {
  await initializationCompletePromise;
  switch (command) {
    case 'togglePlayback':
      await toggleSoundscape();
      break;
    case 'soundscapewindow':
      await designateSoundscapeWindow();
      break;
  }
  save();
});

function pauseSoundscape() {
  // A manual pause replaces any outside media that was holding the soundscape.
  state.soundscapePausedBy = null;
  for (const id of state.soundscape) shortcutPausedTabs.add(id);
  for (const id of state.soundscape) pause(id);
}

function playSoundscape() {
  state.soundscapePausedBy = null;
  shortcutPausedTabs.clear();
  for (const id of state.soundscape) play(id);
}

async function toggleSoundscape() {
  if (state.soundscapeWindow === null) return;
  if (await soundscapeIsPlaying()) pauseSoundscape();
  else playSoundscape();
}

let lastMediaKeyAt = 0;

async function onSoundscapeMediaKey(action) {
  const now = Date.now();
  if (now - lastMediaKeyAt < 400) return;
  lastMediaKeyAt = now;
  if (state.soundscapeWindow === null) return;
  if (action === 'play') playSoundscape();
  else if (action === 'pause') pauseSoundscape();
  else await toggleSoundscape();
}

var announcedMembers = new Set();

function announceMembership(forceAll) {
  if (forceAll) {
    chrome.tabs.query({}).then((tabs) => {
      for (const tab of tabs) {
        if (!tab.id) continue;
        send(tab.id, 'soundscape-member', state.soundscape.has(tab.id));
      }
    });
    announcedMembers = new Set(state.soundscape);
    return;
  }
  for (const id of announcedMembers) {
    if (!state.soundscape.has(id)) send(id, 'soundscape-member', false);
  }
  for (const id of state.soundscape) {
    if (!announcedMembers.has(id)) send(id, 'soundscape-member', true);
  }
  announcedMembers = new Set(state.soundscape);
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await initializationCompletePromise;
  shortcutPausedTabs.delete(tabId);
  state.soundscape.delete(tabId);
  onPause(tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await initializationCompletePromise;
  if (changeInfo.discarded) {
    shortcutPausedTabs.delete(tabId);
    state.soundscape.delete(tabId);
    onPause(tabId);
    return;
  }
  if (!hasProperty(changeInfo, 'audible')) return;
  if (changeInfo.audible) {
    send(tabId, 'audible');
    await onPlay(tab);
  } else {
    onPause(tabId);
  }
});

function pause(id) {
  send(id, 'pause');
}

function play(id) {
  shortcutPausedTabs.delete(id);
  send(id, 'play');
}

async function soundscapeIsPlaying() {
  if (state.soundscape.size === 0) return false;
  let heldByShortcut = true;
  for (const id of state.soundscape) {
    if (!shortcutPausedTabs.has(id)) heldByShortcut = false;
    if (await isAdvancing(id)) return true;
  }
  if (heldByShortcut) return false;
  try {
    const tabs = await chrome.tabs.query({
      windowId: state.soundscapeWindow,
      audible: true
    });
    return tabs.some(
      (tab) => state.soundscape.has(tab.id) && !shortcutPausedTabs.has(tab.id)
    );
  } catch {
    return false;
  }
}

async function pauseWindowMedia(windowId) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({windowId});
  } catch {
    tabs = [];
  }
  const members = [...state.soundscape];
  const ids = new Set();
  for (const tab of tabs) {
    if (tab.audible || members.includes(tab.id)) ids.add(tab.id);
  }
  if (tabs.length === 0) {
    for (const id of members) ids.add(id);
  }
  for (const id of ids) {
    leavingSoundscape.add(id);
    pause(id);
    setTimeout(() => leavingSoundscape.delete(id), 1500);
  }
}

async function designateSoundscapeWindow() {
  let win;
  try {
    win = await chrome.windows.getCurrent();
  } catch {
    return;
  }
  if (!win || win.id === chrome.windows.WINDOW_ID_NONE) return;

  if (state.soundscapeWindow !== win.id) {
    const previous = state.soundscapeWindow;
    state.soundscapePausedBy = null;
    if (typeof previous === 'number') await pauseWindowMedia(previous);
    state.soundscape = new Set();
    shortcutPausedTabs.clear();
    state.soundscapeWindow = win.id;
  }

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({windowId: win.id, audible: true});
  } catch {
    tabs = [];
  }
  for (const tab of tabs) state.soundscape.add(tab.id);
  save();
}

function resumeSoundscape() {
  state.soundscapePausedBy = null;
  for (const id of state.soundscape) play(id);
}

async function send(id, message, body) {
  const payload = {type: message};
  if (body !== undefined) payload.body = body;
  try {
    return await chrome.tabs.sendMessage(id, payload);
  } catch {}
}

async function isPlaying(id) {
  const response = await send(id, 'isplaying');
  return response === 'true';
}

async function isAdvancing(id) {
  const response = await send(id, 'isadvancing');
  return response === 'true';
}

function hasProperty(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isNetflix(url) {
  return unsupportedWindowScripts.some((pattern) => {
    const host = pattern.replace('https://*.', '').replace('/*', '');
    try {
      return new URL(url).hostname === host || new URL(url).hostname.endsWith('.' + host);
    } catch {
      return false;
    }
  });
}

async function updateExtensionScripts() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.url || !tab.id) continue;
    chrome.tabs.sendMessage(tab.id, {type: 'hi ya!'}).catch(async () => {
      await chrome.scripting.executeScript({
        target: {tabId: tab.id, allFrames: true},
        files: ['MediaKeyScript.js'],
        world: 'MAIN',
        injectImmediately: true
      });
      await chrome.scripting.executeScript({
        target: {tabId: tab.id, allFrames: true},
        files: ['ContentScript.js'],
        injectImmediately: true
      });
      if (isNetflix(tab.url)) return;
      await chrome.scripting.executeScript({
        target: {tabId: tab.id, allFrames: true},
        files: ['WindowScript.js'],
        world: 'MAIN',
        injectImmediately: true
      });
      send(tab.id, 'new');
    });
  }
}
