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

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.source !== 'csm-soundscape-member') return;
    member = Boolean(event.data.member);
    applyAll();
    try {
      if (navigator.mediaSession) {
        navigator.mediaSession.playbackState = event.data.playing ? 'playing' : 'paused';
      }
    } catch {}
  });
})();
