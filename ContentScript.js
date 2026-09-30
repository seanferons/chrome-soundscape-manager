'use strict';
/* global chrome */

var Targets = new Set();

var Elements = new Map();

// True while pauseElement is applying playbackRate/volume, so the hold
// listeners do not treat that change as the page undoing a pause.
var holdingPause = false;

if (window.documentPictureInPicture)
  documentPictureInPicture.addEventListener('enter', (event) => {
    if (event.isTrusted && event instanceof DocumentPictureInPictureEvent) {
      // For the top documentPictureInPicture window we are sharing the opener tab audible value
      addListener(event.window.document);
      event.window.addEventListener('focus', (e) => {
        if (e.isTrusted) send('tabFocus');
      });
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
    case 'visablePopup':
      if (!visablePopup()) break;
      sendResponse('true');
      break;
    case 'toggleFastPlayback':
      toggleRate();
      break;
    case 'Rewind':
      Rewind();
      break;
    case 'allowplayback':
      resume(false);
      break;
    case 'next':
      next();
      break;
    case 'previous':
      previous();
      break;
    case 'pause':
      pause();
      break;
    case 'play':
      // When there media already playing tell the background script.
      if (isPlaying()) send('play');
      resume(true);
      break;
    case 'audible':
      checkShadow();
      break;
    case 'hidden':
      checkVisibility();
      break;
    case 'isplaying':
      if (!isPlaying()) break;
      sendResponse('true');
      break;
    case 'isadvancing':
      if (!isAdvancing()) break;
      sendResponse('true');
      break;
    case 'pauseOther':
      pauseOther(message.body);
      break;
    case 'new':
      checkShadow();
      checkDOM();
      break;
  }
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

function next() {
  Elements.forEach((data, e) => {
    if (isPaused(e)) return;
    e.currentTime = e.duration;
  });
}

function previous() {
  Elements.forEach((data, e) => {
    if (isPaused(e)) return;
    // Go to start of media
    e.currentTime = 0;
  });
}

// Controlled by global fast forward shortcut
function toggleRate() {
  Elements.forEach((data, e) => {
    if (isPaused(e)) return;
    if (e.playbackRate > 1) {
      e.playbackRate = 1;
    } else {
      e.playbackRate = 2;
    }
  });
}

function pauseOther(id) {
  Elements.forEach((data, e) => {
    if (e.paused || isMuted(e)) return;
    if (data.id !== id) e.pause();
  });
}

// Controlled by global rewind shortcut
function Rewind() {
  Elements.forEach((data, e) => {
    if (isPaused(e)) return;
    e.currentTime -= 30;
  });
}

function onPlay(e, volumeChange) {
  let data = Elements.get(e);
  if (isMuted(e)) {
    send('playMuted');
    return;
  }
  // If duration is unknown, wait for metadata before reporting to background.
  // This lets the background correctly identify short media (e.g. notification sounds).
  if (isNaN(e.duration)) {
    let sent = false;
    const sendOnce = () => {
      if (sent) return;
      sent = true;
      if (!isPaused(e) && !isMuted(e)) {
        send('play', data.id, e.duration, volumeChange);
      }
    };
    e.addEventListener('durationchange', sendOnce, {once: true});
    setTimeout(sendOnce, 500);
    return;
  }
  send('play', data.id, e.duration, volumeChange);
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
      if (validMedia(event.srcElement)) {
        addMedia(event.srcElement);
        onPlay(event.srcElement);
      }
    },
    {
      capture: true,
      passive: true
    }
  );
}

function isMuted(e) {
  if (e.muted) return true;
  if (Elements.has(e)) {
    let data = Elements.get(e);
    if (data.wasPlaying) {
      return data.wasVolume === 0;
    }
  }
  return e.volume === 0;
}

function addMedia(src) {
  if (Elements.has(src)) return;

  let mediaID = '';
  try {
    mediaID = crypto.randomUUID();
  } catch {
    // On insecure website we cant have a ID :(
  }

  Elements.set(src, {id: mediaID});
  let controller = new AbortController();

  src.addEventListener(
    'volumechange',
    async (event) => {
      const media = event.srcElement;
      if (!validMedia(media)) return;
      const data = Elements.get(media);
      // Keep extension pauses silent when the page restores volume.
      if (data && data.wasPlaying) {
        if (!holdingPause && media.volume !== 0) {
          holdingPause = true;
          media.volume = 0;
          holdingPause = false;
        }
        event.stopImmediatePropagation();
        return;
      }
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

  // Dont tell the media please. stopImmediatePropagation is required because
  // stopPropagation still lets other listeners on this element run, and pages
  // use those to set playbackRate back to 1 while volume stays 0.
  src.addEventListener(
    'ratechange',
    function (event) {
      const media = event.srcElement;
      if (!validMedia(media)) return;
      const data = Elements.get(media) || {};
      if (data.wasPlaying) {
        if (!holdingPause && media.playbackRate !== 0) holdPlayback(media);
        event.stopImmediatePropagation();
        return;
      }
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
    // Real pause() fallback while an extension pause is in effect. Keep the
    // element tracked so resume can call play() without a new user gesture path.
    if (data && data.wasPlaying) return;
    controller.abort();
    normalPlayback(src);
    Elements.delete(src);
    // Check if all elements have paused.
    if (!isPlaying()) {
      send('pause');
    }
  }
}

function normalPlayback(src) {
  let data = Elements.has(src) ? Elements.get(src) : {};
  if (data.wasPlaying) {
    const volume = data.wasVolume;
    const rate = data.wasPlaybackRate;
    // Clear the hold before restoring, or volume/rate listeners will reapply it.
    data.wasPlaying = false;
    src.volume = volume;
    try {
      src.playbackRate = rate;
    } catch {}
  }
}

function holdPlayback(e) {
  holdingPause = true;
  try {
    e.playbackRate = 0;
    if (e.playbackRate !== 0 && !e.paused) e.pause();
  } catch {}
  holdingPause = false;
}

function pauseElement(e, data) {
  // If media attempts to play when it should be paused dont change its old values.
  if (!data.wasPlaying) {
    data.wasVolume = e.volume;
    data.wasPlaybackRate = e.playbackRate;
  }
  // Rate change event will stopImmediatePropagation.
  data.wasPlaying = true;
  Elements.set(e, data);
  holdingPause = true;
  try {
    e.playbackRate = 0;
    e.volume = 0;
    if (e.playbackRate !== 0 && !e.paused) e.pause();
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
}

async function resume(shouldPlay) {
  Elements.forEach((data, e) => {
    if (!data.wasPlaying) return;
    // Pause foreground media normaly
    if (shouldPlay === false) e.pause();
    normalPlayback(e);
    // playbackRate 0 cannot stick on some media, so pauseElement calls pause().
    if (shouldPlay !== false && e.paused) {
      const pending = e.play();
      if (pending) pending.catch(() => {});
    }
  });
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

function send(message, body = '', duration, volumeChange) {
  if (!extensionAlive()) return;
  const msg = {
    type: message,
    body: body,
    userActivation: navigator.userActivation.isActive
  };
  if (duration !== undefined) msg.duration = duration;
  if (volumeChange) msg.volumeChange = true;
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

function visablePopup() {
  if (window.documentPictureInPicture) {
    if (documentPictureInPicture.window !== null) return true;
  }
  return (
    document.visibilityState !== 'hidden' || document.pictureInPictureElement
  );
}

function checkVisibility() {
  if (!visablePopup()) {
    checkShadow();
    send('hidden');
  }
}

window.addEventListener('visibilitychange', checkVisibility, {
  capture: true,
  passive: true
});

function hasProperty(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

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
