'use strict';
/* global chrome */
var permissions = [];
var options = {};

// ID for each checkbox
const supported = [
  'disableresume',
  'pauseoninactive',
  'multipletabs',
  'ignoretabchange',
  'muteonpause',
  'ignoreother',
  'ignoreshort',
  'nopermission',
  'permediapause',
  'checkidle',
  'resumelimit',
  'allowactive',
  'ask',
  'noauto'
];

var userinput = document.getElementById('userinput');
var exclude = document.getElementById('exclude');
var soundscapeList = document.getElementById('soundscape');
var soundscapeEmpty = document.getElementById('soundscape-empty');

// User presses enter
window.addEventListener('keyup', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    permissionUpdate();
  }
});

chrome.permissions.onAdded.addListener(getPermissions);
chrome.permissions.onRemoved.addListener(getPermissions);

// Security: chrome.storage.sync is not safe from website content scripts.
chrome.storage.sync.get(
  ['options', 'exclude', 'appliedDefaults', 'appliedDefaultsVersion'],
  (result) => {
    if (typeof result.options === 'object' && result.options !== null) {
      options = result.options;
    }
    let defaultsVersion = result.appliedDefaultsVersion || 0;
    if (!defaultsVersion && result.appliedDefaults) defaultsVersion = 1;
    if (defaultsVersion < 1) options.multipletabs = true;
    if (defaultsVersion < 2) options.ignoretabchange = true;
    applyChanges();
    if (Array.isArray(result.exclude)) {
      exclude.value = result.exclude.join(' ');
    }
  }
);

chrome.storage.onChanged.addListener((result) => {
  if (typeof result.options === 'object' && result.options !== null) {
    options = result.options.newValue;
    applyChanges();
  }
  if (
    typeof result.exclude === 'object' &&
    result.exclude !== null &&
    Array.isArray(result.exclude.newValue)
  ) {
    exclude.value = result.exclude.newValue.join(' ');
  }
});

function applyChanges() {
  supported.forEach((id) => {
    var state = hasProperty(options, id);
    document.getElementById(id).checked = state;
  });
}

supported.forEach((id) => {
  document.getElementById(id).onclick = () => {
    toggleOption(id);
  };
});

function hasProperty(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function toggleOption(o) {
  if (hasProperty(options, o)) {
    delete options[o];
  } else {
    options[o] = true;
  }
  return new Promise((resolve) => {
    chrome.storage.sync.set(
      {
        options
      },
      function (result) {
        resolve(result);
      }
    );
  });
}

function getPermissions() {
  chrome.permissions.getAll((resp) => {
    permissions = resp.origins;
    userinput.value = permissions.join(' ');
  });
}

getPermissions();

const common = new Map([
  ['youtube', 'https://www.youtube.com/*'],
  ['soundcloud', 'https://soundcloud.com/*'],
  ['twitch', 'https://www.twitch.tv/*'],
  ['pandora', 'https://*.pandora.com/*'],
  ['wrif', 'https://wrif.com/*'],
  ['ustvgo', 'https://ustvgo.tv/*'],
  ['picarto', 'https://picarto.tv/*'],
  ['meet', 'https://meet.google.com/*'],
  ['discord', 'https://discord.com/*'],
  ['zoom', 'https://*.zoom.us/*'],
  ['teams', 'https://teams.live.com/*'],
  ['messenger', 'https://www.messenger.com/*'],
  ['whatsapp', 'https://web.whatsapp.com/*'],
  ['twitter', 'https://x.com/*'],
  ['facebook', 'https://www.facebook.com/*']
]);

function autoComplete(e) {
  e.oninput = () => {
    let result = e.value.split(' ');
    for (let [index, value] of result.entries()) {
      const key = value.toLowerCase();
      if (common.has(key)) {
        result[index] = common.get(key);
      }
    }
    e.value = result.join(' ');
  };
}

autoComplete(userinput);
autoComplete(exclude);

async function permissionUpdate() {
  const domains = userinput.value.split(' ');
  const regex = /^(https?|file|ftp|\*):\/\/(\*|\*\.[^*/]+|[^*/]+)\/.*$/;

  const add = domains.filter(
    (domain) => domain === '<all_urls>' || regex.test(domain)
  );
  const remove = permissions.filter(
    (permission) => !domains.includes(permission)
  );

  if (remove.length > 0) {
    chrome.permissions.remove(
      {
        origins: remove
      },
      () => {
        getPermissions();
      }
    );
  }
  // Security: Maybe discourage the usage of <all_urls>
  if (add.length > 0) {
    chrome.permissions.request(
      {
        origins: add
      },
      () => {
        getPermissions();
      }
    );
  }

  const newExclude = exclude.value
    .split(' ')
    .filter((domain) => domain === '<all_urls>' || regex.test(domain));
  chrome.storage.sync.set({exclude: newExclude});
  exclude.value = newExclude.join(' ');
}

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
      'Nothing here yet. Press Option+S to make the current window the soundscape. Media already playing in that window, and media that starts there later, is part of it. Option+S in another window pauses the previous one and moves the soundscape.';
    return;
  }
  soundscapeEmpty.hidden = false;
  soundscapeEmpty.textContent = ids.length
    ? 'This window is the soundscape. Option+S in another window pauses it and moves the soundscape.'
    : 'This window is the soundscape. Media that plays here will join it. Option+S in another window pauses it and moves the soundscape.';
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
