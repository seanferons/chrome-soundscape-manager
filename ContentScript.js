'use strict';
/* global chrome */

var Targets = new Set();

var Elements = new Map();

// True while pauseElement is calling pause(), so a play event from that call
// is not treated as the page starting media.
var holdingPause = false;

if (window.documentPictureInPicture)
  documentPictureInPicture.addEventListener('enter', (event) => {
    if (event.isTrusted && event instanceof DocumentPictureInPictureEvent) {
      // For the top documentPictureInPicture window we are sharing the opener tab audible value
      addListener(event.window.document);
    }
  });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Sheets and other long-lived pages keep this listener after a reload.
  // The invalidated context throws as soon as this script runs; keep that off the console.
  try {
    if (!extensionAlive()) return;
    onExtensionMessage(message, sendResponse);
  } catch {}
});

function onExtensionMessage(message, sendResponse) {
  switch (message.type) {
    case 'pause':
      pause();
      break;
    case 'play':
      // When there media already playing tell the background script.
      if (isPlaying()) send('play');
      resume();
      break;
    case 'audible':
      checkShadow();
      break;
    case 'isplaying':
      if (!isPlaying()) break;
      sendResponse('true');
      break;
    case 'isadvancing':
      if (!isAdvancing()) break;
      sendResponse('true');
      break;
    case 'new':
      checkShadow();
      checkDOM();
      break;
    case 'soundscape-member':
      setSoundscapeMember(Boolean(message.body));
      break;
  }
}

let soundscapeMember = false;
let lastMediaKeyAt = 0;

function publishSoundscapeMember(playing) {
  window.postMessage(
    {
      source: 'csm-soundscape-member',
      member: soundscapeMember,
      playing: playing === undefined ? isAdvancing() : playing
    },
    '*'
  );
}

function setSoundscapeMember(member) {
  soundscapeMember = member;
  const root = document.documentElement;
  if (root) {
    if (member) root.dataset.csmSoundscape = '1';
    else delete root.dataset.csmSoundscape;
  }
  // The page-world script takes the hardware media key for this tab.
  publishSoundscapeMember();
  syncPlaybackState();
}

function onMediaKey(action) {
  if (!soundscapeMember) return;
  const now = Date.now();
  if (now - lastMediaKeyAt < 400) return;
  lastMediaKeyAt = now;
  send('media-key', action);
}

function onMediaKeyDown(event) {
  if (!soundscapeMember) return;
  const key = event.key || event.code;
  let action = '';
  if (key === 'MediaPlay') action = 'play';
  else if (key === 'MediaPause') action = 'pause';
  else if (key === 'MediaPlayPause') action = 'playpause';
  else return;
  event.preventDefault();
  event.stopImmediatePropagation();
  onMediaKey(action);
}

window.addEventListener('keydown', onMediaKeyDown, true);
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data) return;
  if (event.data.source !== 'csm-media-key') return;
  onMediaKey(event.data.action);
});

try {
  chrome.runtime.sendMessage({type: 'soundscape-query'}, (response) => {
    if (chrome.runtime.lastError) return;
    if (response && response.member) setSoundscapeMember(true);
  });
} catch {}

function syncPlaybackState(playing) {
  if (!navigator.mediaSession) return;
  try {
    navigator.mediaSession.playbackState =
      playing === undefined
        ? isAdvancing()
          ? 'playing'
          : 'paused'
        : playing
          ? 'playing'
          : 'paused';
  } catch {}
}

function isPlaying() {
  checkShadow();
  const audibleElements = [...Elements].filter((e, data) => !isMuted(e[0]));
  return audibleElements.length !== 0;
}

// Unlike isPlaying(), this is false while an extension pause is holding the
// element (wasPlaying), so the playback shortcut can toggle back to resume.
function isAdvancing() {
  checkShadow();
  for (const [e, data] of Elements) {
    if (data.wasPlaying) continue;
    if (e.paused || e.ended || e.playbackRate === 0) continue;
    if (isMuted(e)) continue;
    return true;
  }
  return false;
}

function isPaused(e) {
  return e.paused || e.playbackRate === 0;
}

function onPlay(e, volumeChange) {
  if (!Elements.has(e) || isMuted(e)) return;
  send('play', volumeChange);
  if (soundscapeMember) publishSoundscapeMember(true);
}

function validMedia(e) {
  try {
    //  documentPictureInPicture window.top media is tracked by the opener
    if (opener.documentPictureInPicture.window === window) return;
  } catch {}

  return (
    typeof e.play === 'function' &&
    typeof e.pause === 'function' &&
    typeof e.playbackRate === 'number' &&
    typeof e.muted === 'boolean' &&
    typeof e.paused === 'boolean'
  );
}

function addListener(src) {
  if (Targets.has(src)) return;
  Targets.add(src);
  // On media play event
  src.addEventListener(
    'play',
    function (event) {
      const media = event.srcElement;
      if (!validMedia(media)) return;
      const data = Elements.get(media);
      // The page often calls play() as soon as it sees a pause. Keep the hold.
      if (data && data.wasPlaying) {
        event.stopImmediatePropagation();
        if (!media.paused) pauseElement(media, data);
        return;
      }
      addMedia(media);
      onPlay(media);
    },
    {
      capture: true
    }
  );
}

function isMuted(e) {
  if (e.muted) return true;
  return e.volume === 0;
}

function addMedia(src) {
  if (Elements.has(src)) return;

  Elements.set(src, {});
  let controller = new AbortController();

  src.addEventListener(
    'volumechange',
    async (event) => {
      const media = event.srcElement;
      if (!validMedia(media)) return;
      if (!isPaused(media)) {
        if (isMuted(media)) await sleep(200);
        onPlay(media, true);
      }
    },
    {
      signal: controller.signal,
      capture: true,
      passive: true
    }
  );

  src.addEventListener(
    'pause',
    (event) => {
      let src = event.srcElement;
      onPause(src, controller);
    },
    {
      signal: controller.signal,
      capture: true,
      passive: true
    }
  );

  src.addEventListener(
    'abort',
    (event) => {
      onPause(event.srcElement, controller);
    },
    {
      signal: controller.signal,
      capture: true,
      passive: true
    }
  );

  src.addEventListener(
    'ratechange',
    function (event) {
      const media = event.srcElement;
      if (!validMedia(media)) return;
      if (!isPaused(media)) onPlay(media);
    },
    {
      signal: controller.signal,
      capture: true
    }
  );
}

addListener(document);

async function onPause(src, controller) {
  await sleep(200);
  if (validMedia(src) && src.paused) {
    const data = Elements.get(src);
    // Extension pause. Keep the element so resume can call play().
    if (data && data.wasPlaying) return;
    controller.abort();
    Elements.delete(src);
    // Check if all elements have paused.
    if (!isPlaying()) {
      send('pause');
      if (soundscapeMember) publishSoundscapeMember(false);
    }
  }
}

function pauseElement(e, data) {
  data.wasPlaying = true;
  Elements.set(e, data);
  if (holdingPause || e.paused) return;
  holdingPause = true;
  try {
    e.pause();
    // A pause handler on the page may have called play() before this returned.
    if (!e.paused) e.pause();
  } catch {}
  holdingPause = false;
}

function pause() {
  // Elements.forEach itself throws "Extension context invalidated" once this
  // content script's extension context is dead, so the try has to wrap the call.
  try {
    Elements.forEach((data, e) => {
      try {
        if (isPaused(e)) return;
        pauseElement(e, data);
      } catch {}
    });
  } catch {}
  syncPlaybackState(false);
  if (soundscapeMember) publishSoundscapeMember(false);
}

function resume() {
  Elements.forEach((data, e) => {
    if (!data.wasPlaying) return;
    // Clear the hold before play(), or the play listener will pause it again.
    data.wasPlaying = false;
    if (!e.paused) return;
    try {
      const pending = e.play();
      if (pending) pending.catch(() => {});
    } catch {}
  });
  syncPlaybackState(true);
  if (soundscapeMember) publishSoundscapeMember(true);
}

function checkShadow(DOM = document) {
  // If we are checking this document also check documentPictureInPicture
  if (
    DOM === document &&
    window.documentPictureInPicture &&
    documentPictureInPicture.window
  )
    checkShadow(documentPictureInPicture.window.document);
  [...DOM.querySelectorAll('*')].map((e) => {
    let shadowDOM = shadow(e);
    if (shadowDOM !== null) {
      checkShadow(shadowDOM);
      addListener(shadowDOM);
      [...shadowDOM.querySelectorAll('*')].map((e) => {
        if (!isPaused(e)) {
          if (validMedia(e)) {
            addMedia(e);
            onPlay(e);
          }
        }
      });
    }
  });
}

function checkDOM() {
  for (const e of document.querySelectorAll('*')) {
    if (!isPaused(e)) {
      if (validMedia(e)) {
        addMedia(e);
        onPlay(e);
      }
    }
  }
}

function extensionAlive() {
  try {
    return Boolean(chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

function send(message, extra) {
  if (!extensionAlive()) return;
  const msg = {type: message};
  if (message === 'play' && extra) msg.volumeChange = true;
  if (message === 'media-key' && extra) msg.action = extra;
  // sendMessage returns a promise in MV3. After a reload that promise rejects
  // with "Extension context invalidated" if nothing catches it.
  try {
    const pending = chrome.runtime.sendMessage(msg);
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch {}
}

window.addEventListener(
  'pagehide',
  () => {
    send('pause');
  },
  {
    passive: true
  }
);

function shadow(e) {
  try {
    if ('openOrClosedShadowRoot' in e) {
      return e.openOrClosedShadowRoot;
    } else {
      return chrome.dom.openOrClosedShadowRoot(e);
    }
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
