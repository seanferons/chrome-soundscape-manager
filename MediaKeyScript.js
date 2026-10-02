// Runs in the page so hardware media keys can be taken over for a soundscape tab.
(function () {
  'use strict';
  const sessionProto = window.MediaSession && MediaSession.prototype;
  if (!sessionProto || typeof sessionProto.setActionHandler !== 'function') return;
  if (sessionProto.__csmMediaKey) return;
  sessionProto.__csmMediaKey = true;

  const original = sessionProto.setActionHandler;
  const mediaActions = ['play', 'pause', 'playpause'];
  const pageHandlers = {play: null, pause: null, playpause: null};
  let member = false;
  let wantPlaying = true;
  let keepAliveTimer = null;
  let savedMetadata = null;
  let holdingMetadata = false;
  const playbackDescriptor = Object.getOwnPropertyDescriptor(
    sessionProto,
    'playbackState'
  );

  // While the soundscape is held, ignore the page setting this back to playing.
  // macOS uses that state to decide the hardware key is still a play command.
  if (playbackDescriptor && playbackDescriptor.get && playbackDescriptor.set) {
    try {
      Object.defineProperty(sessionProto, 'playbackState', {
        configurable: true,
        enumerable: playbackDescriptor.enumerable,
        get() {
          return playbackDescriptor.get.call(this);
        },
        set(value) {
          if (member && !wantPlaying) value = 'paused';
          playbackDescriptor.set.call(this, value);
        }
      });
    } catch {}
  }

  function ourHandler(action) {
    return function () {
      window.postMessage({source: 'csm-media-key', action: action}, '*');
    };
  }

  function applyAll() {
    const session = navigator.mediaSession;
    if (!session) return;
    for (let i = 0; i < mediaActions.length; i++) {
      const action = mediaActions[i];
      try {
        original.call(
          session,
          action,
          member ? ourHandler(action) : pageHandlers[action]
        );
      } catch {}
    }
  }

  sessionProto.setActionHandler = function (action, handler) {
    if (mediaActions.indexOf(action) === -1) {
      return original.call(this, action, handler);
    }
    pageHandlers[action] = handler;
    if (!member) return original.call(this, action, handler);
    return original.call(this, action, ourHandler(action));
  };

  function stopKeepAlive() {
    if (!keepAliveTimer) return;
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }

  function restoreMetadata(session) {
    if (!holdingMetadata) return;
    holdingMetadata = false;
    try {
      session.metadata = savedMetadata;
    } catch {}
    savedMetadata = null;
  }

  // Chrome drops Now Playing after a long pause. Republish a paused session so
  // the Mac hardware key still has somewhere to send play.
  function publishSession() {
    const session = navigator.mediaSession;
    if (!session) return;
    try {
      session.playbackState = wantPlaying ? 'playing' : 'paused';
    } catch {}
    if (!member || wantPlaying) {
      stopKeepAlive();
      restoreMetadata(session);
      return;
    }
    try {
      if (!holdingMetadata) {
        savedMetadata = session.metadata;
        holdingMetadata = true;
      }
      if (typeof MediaMetadata === 'function') {
        session.metadata = new MediaMetadata({
          title: 'Soundscape',
          artist: 'Chrome Soundscape Manager'
        });
      }
    } catch {}
    try {
      if (typeof session.setPositionState === 'function') {
        session.setPositionState({duration: 1, playbackRate: 1, position: 0});
      }
    } catch {}
    if (keepAliveTimer) return;
    keepAliveTimer = setInterval(publishSession, 15000);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.source !== 'csm-soundscape-member') return;
    member = Boolean(event.data.member);
    wantPlaying = Boolean(event.data.playing);
    applyAll();
    publishSession();
  });
})();
