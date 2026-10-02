'use strict';
/* global chrome */

var soundscapeList = document.getElementById('soundscape');
var soundscapeEmpty = document.getElementById('soundscape-empty');

document.getElementById('shortcuts').addEventListener('click', () => {
  chrome.tabs.create({url: 'chrome://extensions/shortcuts'});
});

async function renderSoundscape() {
  const stored = await chrome.storage.session.get('state');
  const windowId =
    stored.state && typeof stored.state.soundscapeWindow === 'number'
      ? stored.state.soundscapeWindow
      : null;
  const ids =
    stored.state && Array.isArray(stored.state.soundscape)
      ? stored.state.soundscape
      : [];
  soundscapeList.replaceChildren();
  if (windowId === null) {
    soundscapeEmpty.hidden = false;
    soundscapeEmpty.textContent =
      'Nothing here yet. Press Option+S to make the current window the soundscape. Media already playing in that window, and media that starts there later, is part of it. Option+S in another window pauses the previous one and moves the soundscape. Option+P pauses or resumes it.';
    return;
  }
  soundscapeEmpty.hidden = false;
  soundscapeEmpty.textContent = ids.length
    ? 'This window is the soundscape. Option+S in another window pauses it and moves the soundscape. Option+P pauses or resumes it.'
    : 'This window is the soundscape. Media that plays here will join it. Option+S in another window pauses it and moves the soundscape. Option+P pauses or resumes it.';
  for (const id of ids) {
    let label = 'Tab ' + id;
    try {
      const tab = await chrome.tabs.get(id);
      label = tab.title || tab.url || label;
    } catch {}
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = label;
    item.append(name);
    soundscapeList.append(item);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.state) renderSoundscape();
});

renderSoundscape();
