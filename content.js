/**
 * Gemini Architect - Content Script v2.15
 * Changes in 2.15:
 * - Moved bulk select button to same line as global search input
 */

const CONFIG = {
  selectors: {
    sidebarContainer: '.conversations-container',
    chatsList: '#conversations-list-0, .conversations-container',
    chatsHeader: 'h1.title, .conversation-items-container .title',
    chatLink: 'a.conversation',
    chatTitle: '.conversation-title, [data-test-id="conversation-line-item-title"], .conversation-copy',
    ipText: '.location-footer-atl-text',
    copyButton: 'button[data-test-id="copy-button"]',
    responseContainer: '.response-container, .model-response-text, [data-message-author-role="model"]',
    userMessage: '.query-text, [data-message-author-role="user"]',
    modelMessage: '.model-response-text, .response-content, [data-message-author-role="model"]',
    conversationTurn: '.conversation-turn, .chat-turn',
    mainContent: '.conversation-container, main, .chat-window'
  },
  storageKey: 'gemini_folders_data',
  settingsKey: 'gemini_architect_settings',
  baseUrl: 'https://gemini.google.com'
};

const DEFAULT_SHORTCUTS = {
  copyLast: { key: 'c', alt: true, ctrl: false, shift: false },
  copyAll: { key: 'c', alt: true, ctrl: false, shift: true },
  wideMode: { key: 'w', alt: true, ctrl: false, shift: false },
  newChat: { key: 'n', alt: true, ctrl: false, shift: false }
};

const FOLDER_EMOJIS = [
  '😀', '😊', '🥰', '😎', '🤓', '🤔', '😴', '🥳',
  '👍', '👎', '👏', '🙌', '💪', '🤝', '✌️', '🤞',
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍',
  '📁', '📂', '🗂️', '📚', '📖', '📝', '✏️', '📌',
  '⭐', '💡', '🔥', '💼', '🎯', '🚀', '💻', '🔧',
  '🎨', '🎬', '🎵', '📷', '🌟', '💎', '🏠', '🔒',
  '🌈', '☀️', '🌙', '⚡', '🌸', '🍀', '🌲', '🌊'
];

let folderState = { folders: [] };
let settings = { wideMode: false, shortcuts: DEFAULT_SHORTCUTS };

let draggedItem = null; // { type: 'folder'|'chat', data: ... }
let bulkSelectMode = false;
let fileManagerOpen = false;
let addChatMode = false;
let fmSearchTerm = "";
let currentPath = []; // Array of indices representing path to current folder

// New State Variables
let clipboard = { items: [], op: 'copy' }; // items: [{type, data, pathStr, index}], op: 'copy'|'cut'
let viewMode = 'grid'; // 'grid' | 'list'
let sortMode = { field: 'name', direction: 'asc' }; // field: 'name'|'date', direction: 'asc'|'desc'
let selectedItems = new Set(); // Set of "type:index" strings e.g. "folder:0", "chat:2"

// Helper: Get current folder object based on currentPath
function getCurrentFolder() {
  let current = folderState.folders;
  let folder = null;

  for (const index of currentPath) {
    if (!current || !current[index]) return null;
    folder = current[index];
    current = folder.folders;
  }
  return { folder, list: current }; // list is the array containing the children
}

// Helper to get folder and parent from path string "0:1:2"
function getFolderByPath(path) {
  if (path === null || path === undefined) return null;
  const indices = (typeof path === 'string' ? path.split(':').map(Number) : path);
  let current = folderState.folders;
  let folder = null;
  let parent = null;
  let index = -1;

  for (let i = 0; i < indices.length; i++) {
    index = indices[i];
    if (!current || !current[index]) {
      // This can happen if path is invalid or folder deleted
      return { list: current, folder: null, parent: parent, index: -1, indices: indices };
    }
    parent = current;
    folder = current[index];
    current = folder.folders; // move deeper
  }
  return { folder, parent, index, indices, list: current };
}

// Listen for messages from Popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'refreshFolders') {
    // Reload state and re-render
    chrome.storage.local.get([CONFIG.storageKey], (result) => {
      if (result[CONFIG.storageKey]) {
        folderState = result[CONFIG.storageKey];
        if (fileManagerOpen) renderFileManager(); // Only re-render if FM is open
      }
    });
  }
});

async function init() {
  try {
    const data = await chrome.storage.local.get([CONFIG.storageKey, CONFIG.settingsKey]);
    if (data[CONFIG.storageKey]) {
      folderState = migrateData(data[CONFIG.storageKey]);
    }
    if (data[CONFIG.settingsKey]) {
      settings = { ...settings, ...data[CONFIG.settingsKey] };
      if (!settings.shortcuts) settings.shortcuts = DEFAULT_SHORTCUTS;
      if (settings.viewMode) viewMode = settings.viewMode;
      if (settings.sortMode) sortMode = settings.sortMode;
    }
  } catch (err) {
    console.error('Gemini Architect: Failed to load state', err);
  }

  applyWideMode();
  setupKeyboardShortcuts();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes[CONFIG.storageKey]) {
        folderState = migrateData(changes[CONFIG.storageKey].newValue);
        if (fileManagerOpen) renderFileManager();
      }
      if (changes[CONFIG.settingsKey]) {
        settings = { ...settings, ...changes[CONFIG.settingsKey].newValue };
        if (!settings.shortcuts) settings.shortcuts = DEFAULT_SHORTCUTS;
        if (settings.viewMode) viewMode = settings.viewMode;
        if (settings.sortMode) sortMode = settings.sortMode;
        applyWideMode();
        updateHeaderButtonTitles();
      }
    }
  });

  const observer = new MutationObserver(() => {
    const sidebar = document.querySelector(CONFIG.selectors.sidebarContainer);
    if (sidebar) {
      // Removed sidebar folder injection
      const chatList = document.querySelector(CONFIG.selectors.chatsList);
      if (chatList && !document.getElementById('gemini-global-search-container')) {
        injectGlobalSearch(chatList);
      }
    }


    injectHeaderButtons();
    injectCheckboxes();
    injectCopyConversationButtons();
    makeChatsDraggable();
    scrubPrivacyInfo();
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// ============================================
// CUSTOM MODALS
// ============================================
function showModal({ title, content, buttons, onClose }) {
  document.getElementById('architect-modal-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'architect-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'architect-modal';

  let html = '<div class="architect-modal-header">' + title + '</div>';
  html += '<div class="architect-modal-content">' + content + '</div>';
  html += '<div class="architect-modal-buttons">';
  buttons.forEach((btn, i) => {
    html += '<button class="architect-modal-btn ' + (btn.primary ? 'primary' : '') + ' ' + (btn.danger ? 'danger' : '') + '" data-btn-index="' + i + '">' + btn.text + '</button>';
  });
  html += '</div>';

  modal.innerHTML = html;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const input = modal.querySelector('input');
  if (input) {
    input.focus();
    input.select();
  }

  modal.querySelectorAll('.architect-modal-btn').forEach(btn => {
    btn.onclick = () => {
      const index = parseInt(btn.dataset.btnIndex);
      const result = buttons[index].onClick?.();
      if (result !== false) {
        overlay.remove();
      }
    };
  });

  overlay.onclick = (e) => {
    if (e.target === overlay) {
      onClose?.();
      overlay.remove();
    }
  };

  const handleEscape = (e) => {
    if (e.key === 'Escape') {
      onClose?.();
      overlay.remove();
      document.removeEventListener('keydown', handleEscape);
    }
  };
  document.addEventListener('keydown', handleEscape);

  if (input) {
    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        const primaryBtn = buttons.find(b => b.primary);
        if (primaryBtn) {
          const result = primaryBtn.onClick?.();
          if (result !== false) {
            overlay.remove();
          }
        }
      }
    };
  }

  return overlay;
}

function showPromptModal(title, defaultValue, onConfirm) {
  showModal({
    title,
    content: '<input type="text" class="architect-modal-input" value="' + (defaultValue || '') + '" placeholder="Enter name...">',
    buttons: [
      { text: 'Cancel' },
      {
        text: 'Save',
        primary: true,
        onClick: () => {
          const input = document.querySelector('.architect-modal-input');
          const value = input?.value?.trim();
          if (value) {
            onConfirm(value);
            return true;
          }
          return false;
        }
      }
    ]
  });
}

function showConfirmModal(title, message, onConfirm, isDanger = false) {
  showModal({
    title,
    content: '<p class="architect-modal-message">' + message + '</p>',
    buttons: [
      { text: 'Cancel' },
      {
        text: 'Delete',
        danger: isDanger,
        primary: !isDanger,
        onClick: () => {
          onConfirm();
          return true;
        }
      }
    ]
  });
}

// ============================================
// DATA MIGRATION
// ============================================
function migrateData(data) {
  if (Array.isArray(data.folders)) {
    // Ensure all folders have a 'folders' array for nesting
    const ensureSubfolders = (list) => {
      list.forEach(f => {
        if (!f.folders) f.folders = [];
        if (f.folders.length > 0) ensureSubfolders(f.folders);
      });
    };
    ensureSubfolders(data.folders);
    return data;
  }

  if (data.folders && typeof data.folders === 'object') {
    const newFolders = Object.entries(data.folders).map(([name, chats]) => ({
      name,
      icon: '📁',
      chats: chats || [],
      folders: []
    }));
    return { folders: newFolders };
  }

  return { folders: [] };
}

// ============================================
// KEYBOARD SHORTCUTS
// ============================================
function formatShortcut(shortcut) {
  if (!shortcut || !shortcut.key) return 'Not set';
  const parts = [];
  if (shortcut.ctrl) parts.push('Ctrl');
  if (shortcut.alt) parts.push('Alt');
  if (shortcut.shift) parts.push('Shift');
  parts.push(shortcut.key.toUpperCase());
  return parts.join('+');
}

function matchesShortcut(e, shortcut) {
  if (!shortcut || !shortcut.key) return false;
  return e.key.toLowerCase() === shortcut.key.toLowerCase() &&
    e.altKey === !!shortcut.alt &&
    e.ctrlKey === !!shortcut.ctrl &&
    e.shiftKey === !!shortcut.shift;
}

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
      return;
    }

    const shortcuts = settings.shortcuts || DEFAULT_SHORTCUTS;

    if (matchesShortcut(e, shortcuts.copyAll)) {
      e.preventDefault();
      copyEntireConversation();
      return;
    }

    if (matchesShortcut(e, shortcuts.copyLast)) {
      e.preventDefault();
      copyLastResponse();
      return;
    }

    if (matchesShortcut(e, shortcuts.wideMode)) {
      e.preventDefault();
      toggleWideMode();
      return;
    }

    if (matchesShortcut(e, shortcuts.newChat)) {
      e.preventDefault();
      window.location.href = '/app';
      return;
    }
  });

  // File Manager Keyboard Listener
  document.addEventListener('keydown', (e) => {
    if (!fileManagerOpen) return;
    if (document.querySelector('.architect-modal')) return; // Don't interfere if modal open
    if (e.target.tagName === 'INPUT') return; // Don't interfere with search/inputs

    // Select All
    if (e.ctrlKey && e.key === 'a') {
      e.preventDefault();
      selectAllItems();
      return;
    }

    // Copy
    if (e.ctrlKey && e.key === 'c') {
      e.preventDefault();
      copySelectedItems();
      return;
    }

    // Cut
    if (e.ctrlKey && e.key === 'x') {
      e.preventDefault();
      cutSelectedItems();
      return;
    }

    // Paste
    if (e.ctrlKey && e.key === 'v') {
      e.preventDefault();
      pasteFromClipboard();
      return;
    }

    // Delete
    if (e.key === 'Delete') {
      e.preventDefault();
      deleteSelectedItems();
      return;
    }

    // Enter (Open)
    if (e.key === 'Enter') {
      e.preventDefault();
      openSelectedItems();
      return;
    }
  });
}

function copyLastResponse() {
  const responses = document.querySelectorAll('.model-response-text, .response-content, [data-message-author-role="model"] .message-content');
  const lastResponse = responses[responses.length - 1];

  if (lastResponse) {
    const text = lastResponse.innerText.trim();
    navigator.clipboard.writeText(text).then(() => {
      showToast('Response copied!');
    }).catch(err => {
      console.error('Failed to copy:', err);
      showToast('Failed to copy');
    });
  } else {
    showToast('No response found');
  }
}

// ============================================
// WIDE MODE
// ============================================
function applyWideMode() {
  if (settings.wideMode) {
    document.body.classList.add('architect-wide-mode');
  } else {
    document.body.classList.remove('architect-wide-mode');
  }
  updateHeaderButtonTitles();
}

function updateHeaderButtonTitles() {
  const shortcuts = settings.shortcuts || DEFAULT_SHORTCUTS;
  const wideBtn = document.getElementById('wide-mode-btn');
  if (wideBtn) {
    wideBtn.classList.toggle('active', settings.wideMode);
    wideBtn.title = (settings.wideMode ? 'Disable' : 'Enable') + ' Wide Mode (' + formatShortcut(shortcuts.wideMode) + ')';
  }
  const newChatBtn = document.querySelector('#gemini-header-actions a.header-btn');
  if (newChatBtn) {
    newChatBtn.title = 'New Chat (' + formatShortcut(shortcuts.newChat) + ')';
  }
}

async function toggleWideMode() {
  settings.wideMode = !settings.wideMode;
  applyWideMode();
  showToast(settings.wideMode ? 'Wide mode on' : 'Wide mode off');
  try {
    await chrome.storage.local.set({ [CONFIG.settingsKey]: settings });
  } catch (err) {
    console.error('Gemini Architect: Failed to save settings', err);
  }
}

// ============================================
// CLIPBOARD & SORT HELPERS
// ============================================
// ============================================
// CLIPBOARD & SELECTION LOGIC
// ============================================

function toggleSelection(id, multi) {
  if (multi) {
    if (selectedItems.has(id)) selectedItems.delete(id);
    else selectedItems.add(id);
  } else {
    selectedItems.clear();
    selectedItems.add(id);
  }
  renderFileManager();
}

function selectAllItems() {
  selectedItems.clear();
  const overlay = document.getElementById('file-manager-overlay');
  if (!overlay) return;

  overlay.querySelectorAll('.fm-item').forEach(item => {
    const type = item.dataset.type;
    const index = item.dataset.index; // This needs to be the display index or data index?
    // We use combined ID logic: "type:index"
    // But index in DOM is _origIndex
    selectedItems.add(`${type}:${index}`);
  });
  renderFileManager();
}

function getSelectedObjects() {
  const objects = [];
  const { list, folder } = getCurrentFolder(); // Current context
  const chats = folder ? folder.chats : [];
  const folders = list || []; // This is current list of folders

  // We need to map selection IDs back to objects.
  selectedItems.forEach(id => {
    const [type, idxStr] = id.split(':');
    const index = parseInt(idxStr);
    const folderPath = currentPath.join(':');
    const pathStr = (type === 'folder')
      ? (folderPath ? folderPath + ':' + index : '' + index)
      : (folderPath ? folderPath + ':c:' + index : 'c:' + index);

    if (type === 'folder' && folders[index]) {
      objects.push({ type: 'folder', data: folders[index], pathStr, index });
    } else if (type === 'chat' && chats[index]) {
      objects.push({ type: 'chat', data: chats[index], pathStr, index });
    }
  });
  return objects;
}

function copySelectedItems() {
  const items = getSelectedObjects();
  if (items.length) addToClipboard(items, 'copy');
}

function cutSelectedItems() {
  const items = getSelectedObjects();
  if (items.length) addToClipboard(items, 'cut');
  // Visual feedback handled by adding 'cut-mode' class if we tracked it in state, 
  // but for now simpler to just copy to clipboard with op=cut.
}

async function deleteSelectedItems() {
  const items = getSelectedObjects();
  if (!items.length) return;

  showConfirmModal('Delete Items', `Are you sure you want to delete ${items.length} item(s)?`, async () => {
    // Sort items to delete by index DESC to avoid shifting issues?
    // Actually, deleteItemByPath handles splicing. 
    // If we delete multiple from same array, indices shift.
    // We must delete from highest index to lowest.

    // Group by parent container (should be same for all typically, unless search result support added later)
    // Here we are in one view.

    // Sort by Index Descending
    items.sort((a, b) => b.index - a.index);

    for (const item of items) {
      if (item.type === 'folder') {
        await deleteItemByPath(item.pathStr, 'folder');
      } else {
        await deleteItemByPath(item.pathStr, 'chat');
      }
    }

    selectedItems.clear();
    await saveState();
    renderFileManager();
    showToast('Items deleted');
  }, true);
}

function openSelectedItems() {
  // Only open the last selected item? Or all?
  // Usually Enter opens the focused one. 
  // Let's open the first one in the set (or last added).
  // Iterating Set:
  if (selectedItems.size === 0) return;

  const [id] = selectedItems;
  const [type, idxStr] = id.split(':');
  const index = parseInt(idxStr);

  if (type === 'folder') {
    currentPath.push(index);
    selectedItems.clear();
    renderFileManager();
  } else {
    const { folder } = getCurrentFolder();
    if (folder && folder.chats[index]) {
      window.open(folder.chats[index].url, '_blank');
    }
  }
}

function addToClipboard(items, op) {
  clipboard = { items, op };
  showToast(`${items.length} item(s) ${op === 'cut' ? 'cut' : 'copied'} to clipboard`);
  renderFileManager(); // Re-render to update Paste button state
}


async function pasteFromClipboard() {
  if (!clipboard.items || clipboard.items.length === 0) return;

  const targetFolderData = getCurrentFolder();
  let targetList = targetFolderData.list;
  // If we are at root, targetList is folderState.folders

  let pasteCount = 0;

  for (const item of clipboard.items) {
    // 1. Get source item
    // If cut, we need to remove from original location first, OR we handle it after.
    // Issue with Cut: Indices shift.
    // Better strategy for Cut: We need robust path tracking.
    // Simplification for now:
    // Copy: Clone data.
    // Cut: Clone data, then delete original (by path).

    // Get item data
    let itemData = null;
    if (item.type === 'folder') {
      itemData = JSON.parse(JSON.stringify(item.data)); // Deep clone
    } else {
      itemData = { ...item.data };
    }

    // Add to target
    if (item.type === 'folder') {
      // Check name collision
      let newName = itemData.name;
      let counter = 1;
      while (targetList.some(f => f.name === newName)) {
        newName = `${itemData.name} (${counter++})`;
      }
      itemData.name = newName;
      targetList.push(itemData);
    } else {
      // Chat
      // Check existence? Allow duplicates?
      // Usually allow duplicates in different folders.
      if (itemData.url) { // Basic validation
        // Ensure target folder supports chats.
        // Wait, our structure: folders can have chats AND subfolders.
        // Start: targetFolderData.folder is the object.
        // If root (targetFolderData.folder is null), we can only have folders?
        // Render logic: root can have chats?
        // renderFileManager: "Current List" is folders. "Current Folder.chats" is chats.
        // Root level chats are NOT supported in current data structure (folders array only).
        // Structure: { folders: [ { name, chats: [], folders: [] } ] }
        // So chats MUST be inside a folder.
        if (!targetFolderData.folder) {
          showToast("Cannot paste chats in root. Please open a folder.");
          continue;
        }
        targetFolderData.folder.chats.push(itemData);
      }
    }
    pasteCount++;
  }

  // Handle Cut Operation - Delete originals
  if (clipboard.op === 'cut') {
    // We need to delete from original paths.
    // Sort paths descending to avoid index shift issues if in same folder?
    // Path string "0:1"
    // Actually, simply re-reading the source might fail if we already modified the tree (pasted into same tree).
    // BUT, we have the original paths.
    // If we paste into a subfolder of the cut folder, that's a problem (infinite recursion).
    // Check for circular dependency for folders.
    // For now, simple implementation:
    // We perform delete.
    // But we must be careful about indices shifting if we delete multiple items from same folder.
    // Strategy: Delete by path.
    // 1. Group by parent folder. 2. Delete by index descending.

    // For MVP:
    // We will clear clipboard after cut-paste.
    // We will attempt to delete.

    // Sort items by path length desc (deepest first) and then index desc
    // However, pathStr is "0:1". item.pathStr.

    // Filter out items that were successfully pasted?
    // We'll just assume success.

    clipboard.items.sort((a, b) => {
      const pathA = a.pathStr.split(':').map(Number);
      const pathB = b.pathStr.split(':').map(Number);
      // Compare lengths? No, compare actual indices.
      // Actually, deleting items: we should handle this carefully.
      // Let's defer "Cut" for complex cases or just do one-by-one with refresh?
      // No, refresh is bad.

      // Simpler: Just reload the whole state? No.
      return 0;
    });

    // We need a robust 'deleteItemByPath' function.
    // Let's implement delete logic here differently: 
    // We have the source data references? No, these are copies.

    // Post-Paste Delete for Cut:
    for (const item of clipboard.items) {
      if (item.type === 'folder') {
        await deleteItemByPath(item.pathStr, 'folder');
      } else {
        await deleteItemByPath(item.pathStr, 'chat');
      }
    }

    clipboard = { items: [], op: 'copy' }; // Clear clipboard
  }

  await saveState();
  renderFileManager();
  showToast(`Pasted ${pasteCount} items`);
}

async function deleteItemByPath(pathStr, type) {
  const indices = pathStr.split(':').map(Number);
  const index = indices.pop();
  const parentPathStr = indices.join(':');
  const result = getFolderByPath(parentPathStr);

  if (result && result.list) {
    if (type === 'folder') {
      // result.list is the folders array
      if (result.list[index]) {
        result.list.splice(index, 1);
      }
    } else {
      // Chat
      // Chats are in result.folder.chats
      if (result.folder && result.folder.chats) {
        result.folder.chats.splice(index, 1);
      }
    }
  }
}

function sortItems(list, type) {
  if (!list) return [];
  return [...list].sort((a, b) => {
    let valA, valB;
    if (sortMode.field === 'name') {
      valA = (a.name || a.title || '').toLowerCase();
      valB = (b.name || b.title || '').toLowerCase();
    } else {
      // Default to name
      valA = (a.name || a.title || '').toLowerCase();
      valB = (b.name || b.title || '').toLowerCase();
    }

    if (valA < valB) return sortMode.direction === 'asc' ? -1 : 1;
    if (valA > valB) return sortMode.direction === 'asc' ? 1 : -1;
    return 0;
  });
}

function toggleView() {
  viewMode = viewMode === 'grid' ? 'list' : 'grid';
  saveSettings();
  renderFileManager();
}

function toggleSort() {
  // Cycle: Name Asc -> Name Desc
  // Could accept args but for single button toggle:
  if (sortMode.direction === 'asc') sortMode.direction = 'desc';
  else sortMode.direction = 'asc';
  saveSettings();
  renderFileManager();
}

async function saveSettings() {
  settings.viewMode = viewMode;
  settings.sortMode = sortMode;
  await chrome.storage.local.set({ [CONFIG.settingsKey]: settings });
}

// ============================================
// COPY CONVERSATION
// ============================================
function injectCopyConversationButtons() {
  document.querySelectorAll(CONFIG.selectors.copyButton).forEach(copyBtn => {
    if (copyBtn.parentElement?.querySelector('.architect-copy-convo-btn')) return;

    const shortcuts = settings.shortcuts || DEFAULT_SHORTCUTS;
    const copyAllBtn = document.createElement('button');
    copyAllBtn.className = 'architect-copy-convo-btn';
    copyAllBtn.title = 'Copy entire conversation (' + formatShortcut(shortcuts.copyAll) + ')';
    copyAllBtn.textContent = 'All';
    copyAllBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      copyEntireConversation();
    };

    copyBtn.parentElement?.insertBefore(copyAllBtn, copyBtn.nextSibling);
  });
}

function copyEntireConversation() {
  let conversationText = '';

  const turns = document.querySelectorAll('.conversation-turn, [data-turn-index]');

  if (turns.length > 0) {
    turns.forEach(turn => {
      const userMsg = turn.querySelector('.query-text, [data-message-author-role="user"] .message-content');
      const modelMsg = turn.querySelector('.model-response-text, [data-message-author-role="model"] .message-content, .response-content');

      if (userMsg) {
        conversationText += '**You:**\n' + userMsg.innerText.trim() + '\n\n';
      }
      if (modelMsg) {
        conversationText += '**Gemini:**\n' + modelMsg.innerText.trim() + '\n\n';
      }
    });
  } else {
    const allMessages = document.querySelectorAll('[data-message-author-role]');
    allMessages.forEach(msg => {
      const role = msg.getAttribute('data-message-author-role');
      const content = msg.querySelector('.message-content')?.innerText || msg.innerText;
      if (role === 'user') {
        conversationText += '**You:**\n' + content.trim() + '\n\n';
      } else if (role === 'model') {
        conversationText += '**Gemini:**\n' + content.trim() + '\n\n';
      }
    });
  }

  if (!conversationText.trim()) {
    const queries = document.querySelectorAll('.query-text');
    const responses = document.querySelectorAll('.model-response-text, .response-content');

    queries.forEach((q, i) => {
      conversationText += '**You:**\n' + q.innerText.trim() + '\n\n';
      if (responses[i]) {
        conversationText += '**Gemini:**\n' + responses[i].innerText.trim() + '\n\n';
      }
    });
  }

  if (conversationText.trim()) {
    navigator.clipboard.writeText(conversationText.trim()).then(() => {
      showToast('Conversation copied!');
    }).catch(err => {
      console.error('Failed to copy:', err);
      showToast('Failed to copy');
    });
  } else {
    showToast('No conversation found');
  }
}

function showToast(message) {
  document.getElementById('architect-toast')?.remove();

  const toast = document.createElement('div');
  toast.id = 'architect-toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  });
}

// ============================================
// PRIVACY
// ============================================
function scrubPrivacyInfo() {
  document.querySelectorAll(CONFIG.selectors.ipText).forEach(span => {
    if (span.innerText.includes('IP address')) span.innerText = 'Location Protected';
  });
  document.querySelectorAll('.location-footer-name').forEach(span => {
    if (!span.dataset.protected) {
      span.innerText = 'Private Area';
      span.dataset.protected = "true";
    }
  });
}

// ============================================
// FOLDERS
// ============================================
function getCleanTitle(element) {
  const titleEl = element.querySelector(CONFIG.selectors.chatTitle) || element;
  const clone = titleEl.cloneNode(true);
  clone.querySelectorAll('mat-icon, .google-symbols, svg, .icon-container, button').forEach(el => el.remove());
  const ligatures = ['edit_square', 'push_pin', 'delete', 'more_vert', 'share', 'chat_bubble', 'history', 'star', 'keep'];
  const ligatureRegex = new RegExp('\\b(' + ligatures.join('|') + ')\\b', 'gi');
  return clone.innerText.replace(ligatureRegex, '').split('\n')[0].replace(/\s\s+/g, ' ').trim() || "Untitled Chat";
}

// ============================================
// FILE MANAGER UI
// ============================================
function openFileManager() {
  fileManagerOpen = true;
  currentPath = []; // Reset to root
  renderFileManager();
}

function closeFileManager() {
  fileManagerOpen = false;
  addChatMode = false;
  document.getElementById('file-manager-overlay')?.remove();
}

function toggleAddChatMode() {
  addChatMode = !addChatMode;
  renderFileManager();

  // Automate Sidebar using User's specific button
  const toggleBtn = document.querySelector('button[data-test-id="side-nav-menu-button"]');

  // Check if sidebar is currently visible/expanded
  // Strategy: Rail mode has small width (~70px), Expanded mode has large width (~250-300px)
  const sidebar = document.querySelector(CONFIG.selectors.sidebarContainer);
  // We use 200px as a safe threshold to distinguish between Rail and Expanded
  const isExpanded = sidebar && sidebar.getBoundingClientRect().width > 200 && window.getComputedStyle(sidebar).display !== 'none';

  if (toggleBtn) {
    if (addChatMode) {
      // ENABLE: Ensure Expanded
      if (!isExpanded) {
        toggleBtn.click();
      }
    } else {
      // DISABLE: Ensure Collapsed
      // User wants sidebar to collapse when exiting Add Chat mode
      if (isExpanded) {
        toggleBtn.click();
      }
    }
  }
}

function renderFileManager() {
  let overlay = document.getElementById('file-manager-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'file-manager-overlay';
    overlay.className = 'glass-overlay';
    if (addChatMode) overlay.classList.add('shrink');
    document.body.appendChild(overlay);

    // Close on click outside - REMOVED per user request
    // overlay.onclick = (e) => {
    //   if (e.target === overlay) closeFileManager();
    // };
  }

  // Calculate breadcrumbs and current content
  let breadcrumbsHtml = '<span class="crumb" data-path="-1">Home</span>';
  let navPath = [];
  let currentList = folderState.folders;
  let currentFolder = null;

  currentPath.forEach((index, i) => {
    if (currentList && currentList[index]) {
      const f = currentList[index];
      navPath.push(index);
      const pathStr = navPath.join(':');
      breadcrumbsHtml += ` <span class="crumb-separator">/</span> <span class="crumb" data-path="${pathStr}">${f.name}</span>`;
      currentFolder = f;
      currentList = f.folders;
    }
  });

  // Content Generation
  let contentHtml = '';

  // Search Logic
  if (fmSearchTerm) {
    contentHtml = '';
    const results = searchFileManager(folderState.folders, fmSearchTerm);

    if (results.length === 0) {
      contentHtml = '<div class="fm-empty">No results found</div>';
    } else {
      results.sort((a, b) => { // Basic Search Sort
        return (a.item.name || a.item.title || '').localeCompare(b.item.name || b.item.title || '');
      });

      results.forEach((res, idx) => {
        // ... existing search results (omitted in this partial replacement? No, need to keep)
        // Wait, the original code had the loop.
        // Let's assume search results are not affected by Sort/View mode for now as they are a flat list from search.
        const item = res;
        if (item.type === 'folder') {
          contentHtml += `
                    <div class="fm-item folder${item.folder.color ? ' folder-' + item.folder.color : ''}" onclick="jumpToPath('${item.pathStr}')">
                        <div class="fm-icon">${item.folder.icon || '📁'}</div>
                        <div class="fm-name">${item.folder.name}</div>
                        <div class="fm-info">Folder</div>
                    </div>`;
        } else {
          contentHtml += `
                    <div class="fm-item chat">
                        <div class="fm-icon">📄</div>
                        <div class="fm-name"><a href="${item.chat.url}" target="_blank">${item.chat.title}</a></div>
                        <div class="fm-info">Chat</div>
                    </div>`;
        }
      });
    }
  } else {
    // Normal Render
    // Normal Render with Sort and View

    // 1. Combine and Sort
    // Actually we render folders then chats usually.
    // Let's respect that separation but sort within them?
    // Or mix them? Windows Explorer mixes but keeps folders top usually.

    let displayFolders = currentList ? [...currentList] : [];
    let displayChats = (currentFolder && currentFolder.chats) ? [...currentFolder.chats] : [];

    // Add original index tracking before sort
    displayFolders = displayFolders.map((f, i) => ({ ...f, _origIndex: i }));
    displayChats = displayChats.map((c, i) => ({ ...c, _origIndex: i }));

    displayFolders = sortItems(displayFolders, 'folder');
    displayChats = sortItems(displayChats, 'chat');

    // Generate HTML
    displayFolders.forEach(folder => {
      const colorClass = folder.color ? ' folder-' + folder.color : '';
      const id = `folder:${folder._origIndex}`;
      const isSelected = selectedItems.has(id);
      const isCut = (clipboard.op === 'cut' && clipboard.items.some(i => i.type === 'folder' && i.data.name === folder.name)); // Rough match for visual

      contentHtml += `
                <div class="fm-item folder${colorClass} ${isSelected ? 'selected' : ''} ${isCut ? 'cut-mode' : ''}" 
                     draggable="true" 
                     data-type="folder" 
                     data-index="${folder._origIndex}">
                    <div class="fm-icon">${folder.icon || '📁'}</div>
                    <div class="fm-name">${folder.name}</div>
                    ${viewMode === 'list' ? '<div class="fm-info">Folder</div>' : ''}
                </div>`;
    });

    displayChats.forEach(chat => {
      const id = `chat:${chat._origIndex}`;
      const isSelected = selectedItems.has(id);
      const isCut = (clipboard.op === 'cut' && clipboard.items.some(i => i.type === 'chat' && i.data.url === chat.url));

      contentHtml += `
                <div class="fm-item chat ${isSelected ? 'selected' : ''} ${isCut ? 'cut-mode' : ''}" 
                     draggable="true" 
                     data-type="chat" 
                     data-index="${chat._origIndex}">
                    <div class="fm-icon">📄</div>
                    <div class="fm-name"><a href="${chat.url}" target="_blank" onclick="return false;">${chat.title}</a></div>
                    ${viewMode === 'list' ? '<div class="fm-info">Chat</div>' : ''}
                </div>`;
    });

    if (!contentHtml) {
      contentHtml = '<div class="fm-empty">Empty folder</div>';
    }
  }

  overlay.className = 'glass-overlay' + (addChatMode ? ' shrink' : '');

  // Controls HTML
  const pasteDisabled = (!clipboard.items || clipboard.items.length === 0);
  const sortIcon = sortMode.direction === 'asc' ? 'ArrowUp' : 'ArrowDown';
  const viewIcon = viewMode === 'grid' ? 'Grid' : 'List';
  // Removed Click Mode button

  overlay.innerHTML = `
    <div class="file-manager-window glass-panel${addChatMode ? ' shrink' : ''} ${viewMode}-view">
        <div class="fm-header">
            <div class="fm-breadcrumbs">${breadcrumbsHtml}</div>
            <div class="fm-controls">
                <input type="text" id="fm-search-input" placeholder="Search..." value="${fmSearchTerm}">
                
                <div class="fm-divider"></div>
                
                <button id="fm-paste-btn" class="fm-btn" title="Paste (Ctrl+V)" ${pasteDisabled ? 'disabled' : ''}>📋</button>
                <button id="fm-view-btn" class="fm-btn" title="Toggle View: ${viewMode}">Display: ${viewMode}</button>
                <div class="fm-dropdown-group">
                    <button id="fm-sort-btn" class="fm-btn" title="Sort by Name">Sort: Name ${sortMode.direction === 'asc' ? '↑' : '↓'}</button>
                </div>
                
                <div class="fm-divider"></div>

                <button id="fm-add-chat-btn" class="fm-btn ${addChatMode ? 'active' : ''}" title="Toggle Sidebar to Drag & Drop Chats">Add Chat</button>
                <button id="fm-new-folder-btn" class="fm-btn">New Folder</button>
                <button id="fm-close-btn" class="fm-btn close">×</button>
            </div>
        </div>
        <div class="fm-content-area custom-scrollbar ${viewMode}-view" id="fm-content">
            ${contentHtml}
        </div>
    </div>
  `;

  // Event Listeners - Toolbar
  document.getElementById('fm-paste-btn').onclick = pasteFromClipboard;
  document.getElementById('fm-view-btn').onclick = toggleView;
  document.getElementById('fm-sort-btn').onclick = toggleSort;
  // Removed click btn listener

  document.getElementById('fm-close-btn').onclick = closeFileManager;
  const searchInput = document.getElementById('fm-search-input');
  searchInput.oninput = (e) => {
    fmSearchTerm = e.target.value.toLowerCase();
    renderFileManager();
  };

  // Re-focus helper
  setTimeout(() => {
    const el = document.getElementById('fm-search-input');
    if (el) {
      // Only focus if user was typing in it?
      // Actually, renderFileManager is called on every char.
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, 0);

  document.getElementById('fm-add-chat-btn').onclick = toggleAddChatMode;
  document.getElementById('fm-new-folder-btn').onclick = () => {
    showPromptModal('New Folder', '', async (name) => {
      const newFolder = { name: name.trim(), icon: '📁', color: 'default', chats: [], folders: [] };
      const { list } = getCurrentFolder();
      let targetList = list; // Use the returned list directly
      // Note: getCurrentFolder Logic:
      // if currentPath = [], returns { folder: null, list: folderState.folders }

      targetList.push(newFolder);
      await saveState();
      renderFileManager();
    });
  };

  overlay.querySelectorAll('.crumb').forEach(c => {
    c.onclick = () => {
      const pathStr = c.dataset.path;
      if (pathStr === '-1') currentPath = [];
      else currentPath = pathStr.split(':').map(Number);
      renderFileManager();
    };
  });

  overlay.querySelectorAll('.fm-item.folder').forEach(item => {
    const idx = parseInt(item.dataset.index);
    const id = `folder:${idx}`;

    item.onclick = (e) => {
      // Single Click = Open
      currentPath.push(idx);
      selectedItems.clear(); // Clear selection on navigation
      renderFileManager();
    };

    // Context Menu
    item.oncontextmenu = (e) => {
      e.preventDefault();
      // Right click selects for operations
      toggleSelection(id, false);

      const fullPath = [...currentPath, idx].join(':');
      const { list } = getCurrentFolder();
      const folderObj = list[idx];

      showContextMenu(e.clientX, e.clientY, [
        { label: 'Open', action: () => { currentPath.push(idx); selectedItems.clear(); renderFileManager(); } },
        { label: 'Cut', action: () => addToClipboard([{ type: 'folder', data: folderObj, pathStr: fullPath, index: idx }], 'cut') },
        { label: 'Copy', action: () => addToClipboard([{ type: 'folder', data: folderObj, pathStr: fullPath, index: idx }], 'copy') },
        { label: 'Rename', action: () => renameItem('folder', idx) },
        { label: 'Change Icon', action: () => showEmojiPicker(fullPath) },
        // Change Color removed
        { label: 'Delete', action: () => deleteItem('folder', idx) }
      ]);
    };
  });

  overlay.querySelectorAll('.fm-item.chat').forEach(item => {
    const idx = parseInt(item.dataset.index);
    const id = `chat:${idx}`;

    item.onclick = (e) => {
      // Single Click = Open
      const { folder } = getCurrentFolder();
      if (folder && folder.chats[idx]) {
        window.open(folder.chats[idx].url, '_blank');
      }
    };

    // Chats logic ... (PathStr calculation)
    const folderPath = currentPath.join(':');
    const chatPathStr = (folderPath ? folderPath + ':' : '') + 'c:' + idx;

    // Get chat object
    const { folder } = getCurrentFolder();
    const chatObj = folder ? folder.chats[idx] : null;

    item.oncontextmenu = (e) => {
      e.preventDefault();
      if (!chatObj) return;
      // Right click selects
      toggleSelection(id, false);

      showContextMenu(e.clientX, e.clientY, [
        { label: 'Open', action: () => window.open(chatObj.url, '_blank') },
        { label: 'Cut', action: () => addToClipboard([{ type: 'chat', data: chatObj, pathStr: chatPathStr, index: idx }], 'cut') },
        { label: 'Copy', action: () => addToClipboard([{ type: 'chat', data: chatObj, pathStr: chatPathStr, index: idx }], 'copy') },
        { label: 'Rename', action: () => renameItem('chat', idx) },
        { label: 'Remove from folder', action: () => deleteItem('chat', idx) },
        { label: 'Delete Permanently', action: () => deletePermanently('chat', idx) }
      ]);
    };
  });

  // Background click to deselect
  overlay.querySelector('.fm-content-area').onclick = (e) => {
    if (e.target === e.currentTarget) {
      selectedItems.clear();
      renderFileManager();
    }
  };

  setupFileManagerDragDrop(overlay);
  setupFolderItemDragListeners(overlay);
}

async function deletePermanently(type, index) {
  if (type !== 'chat') return;

  let folder = null;
  let chats = [];
  if (currentPath.length > 0) {
    const result = getFolderByPath(currentPath.join(':'));
    if (result && result.folder) {
      folder = result.folder;
      chats = folder.chats;
    }
  }

  if (folder && chats[index]) {
    const chat = chats[index];

    const result = await triggerNativeDelete(chat);

    if (result && result.success) {
      closeFileManager();
      // Wait for user to click CONFIRM in the dialog
      waitForDeleteConfirmation(folder, index);
    } else {
      showToast('Chat not found in sidebar (cannot delete permanently)');
    }
  }
}

async function triggerNativeDelete(chatData) {
  // 1. Find Chat
  // Reuse logic from rename but target delete button
  const relativeUrl = chatData.url.replace(CONFIG.baseUrl, '');
  const chatLink = document.querySelector(`a[href="${relativeUrl}"], a[href="${chatData.url}"]`);

  if (!chatLink) return { success: false };

  // 2. Find Options Button
  const container = chatLink.closest('div.conversation-container') || chatLink.closest('div') || chatLink.parentElement;
  const optionsBtn = container.querySelector('button[aria-haspopup="menu"], button[aria-label="More options"]');

  if (!optionsBtn) return { success: false };

  // 3. Click Options Button
  optionsBtn.click();

  // 4. Wait for Menu and Click DELETE
  return new Promise((resolve) => {
    setTimeout(() => {
      const deleteBtn = document.querySelector('button[data-test-id="delete-button"]');
      if (deleteBtn) {
        deleteBtn.click();
        resolve({ success: true, element: chatLink });
      } else {
        // Try finding by text
        const allBtns = document.querySelectorAll('.mat-mdc-menu-content button');
        const textBtn = Array.from(allBtns).find(b => b.innerText.includes('Delete'));
        if (textBtn) {
          textBtn.click();
          resolve({ success: true, element: chatLink });
        } else {
          resolve({ success: false });
        }
      }
    }, 200);
  });
}

function waitForDeleteConfirmation(folder, chatIndex) {
  // Watch body for the dialog to appear
  const observer = new MutationObserver((mutations) => {
    const confirmBtn = document.querySelector('button[data-test-id="confirm-button"]');
    if (confirmBtn) {
      // Found the button! Add click listener
      confirmBtn.addEventListener('click', () => {
        // User confirmed delete!
        // Wait a bit for the action to complete/sidebar to update
        setTimeout(async () => {
          folder.chats.splice(chatIndex, 1);
          await saveState();

          // Reopen FM
          fileManagerOpen = true;
          renderFileManager();
          showToast('Deleted permanently & synced');
        }, 500);
      });
      observer.disconnect(); // Stop watching for dialog
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Timeout in case dialog never appears or user cancels (clicked outside/cancel)
  // If they cancel, we don't do anything, which is correct.
  setTimeout(() => observer.disconnect(), 10000);
}

function setupFolderItemDragListeners(overlay) {
  overlay.querySelectorAll('.fm-item.folder').forEach(item => {
    item.ondragstart = (e) => {
      const index = parseInt(item.dataset.index);
      // Construct path: currentPath is array of indices
      // We need to pass the string representation for moveFolderToFolder
      // Note: currentPath is [0, 1] etc.
      // The item at 'index' in the current view has path keys [...currentPath, index]
      const fullPath = [...currentPath, index].join(':');

      e.dataTransfer.setData('application/json', JSON.stringify({
        type: 'folder',
        path: fullPath
      }));
      e.stopPropagation();
    };

    item.ondragover = (e) => {
      e.preventDefault();
      item.classList.add('drag-over');
    };

    item.ondragleave = () => item.classList.remove('drag-over');

    item.ondrop = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      item.classList.remove('drag-over');

      let data;
      try { data = JSON.parse(e.dataTransfer.getData('application/json')); } catch { return; }

      const targetIndex = parseInt(item.dataset.index);
      const targetPath = [...currentPath, targetIndex].join(':');

      if (data.type === 'folder') {
        await moveFolderToFolder(data.path, targetPath);
      } else if (data.url) {
        // Chat drop
        await moveChatToFolder(data, targetPath);
      }
    };
  });
}

async function moveFolderToFolder(sourcePath, targetPath) {
  if (sourcePath === targetPath) return;

  // Check circular
  // sourcePath "0", targetPath "0:1" -> "0:1".startsWith("0:") -> true
  if (targetPath === sourcePath || targetPath.startsWith(sourcePath + ':')) {
    showToast("Cannot move folder into itself");
    return;
  }

  const source = getFolderByPath(sourcePath);
  const target = getFolderByPath(targetPath);

  if (!source || !target || !source.parent || !target.folder) return;

  // Splice removes from array, effectively moving it
  const [movedFolder] = source.parent.splice(source.index, 1);
  target.folder.folders.push(movedFolder);

  await saveState();
  renderFileManager();
}

async function moveChatToFolder(chatData, targetPath) {
  const result = getFolderByPath(targetPath);
  if (!result || !result.folder) return;
  const { folder } = result;

  if (chatData.url.startsWith('/')) chatData.url = CONFIG.baseUrl + chatData.url;

  if (!folder.chats.some(c => c.url === chatData.url)) {
    folder.chats.push(chatData);
    await saveState();
    renderFileManager();
    showToast('Saved to ' + folder.name);
  } else {
    showToast('Chat already in folder');
  }
}

function showContextMenu(x, y, options) {
  document.getElementById('fm-context-menu')?.remove();
  const menu = document.createElement('div');
  menu.id = 'fm-context-menu';
  menu.className = 'glass-panel context-menu';
  menu.style.top = y + 'px';
  menu.style.left = x + 'px';

  options.forEach(opt => {
    const item = document.createElement('div');
    item.className = 'cm-item';
    item.textContent = opt.label;
    item.onclick = () => {
      opt.action();
      menu.remove();
    };
    menu.appendChild(item);
  });

  document.body.appendChild(menu);

  setTimeout(() => {
    document.addEventListener('click', function close(e) {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', close);
      }
    });
  }, 0);
}

async function renameItem(type, index) {
  if (type === 'folder') {
    let list = folderState.folders;
    for (const i of currentPath) list = list[i].folders;
    const item = list[index];

    showPromptModal('Rename', item.name, async (name) => {
      item.name = name.trim();
      await saveState();
      renderFileManager();
    });
  } else {
    // Rename Chat
    let folder = null;
    let chats = [];
    if (currentPath.length > 0) {
      const result = getFolderByPath(currentPath.join(':'));
      if (result && result.folder) {
        folder = result.folder;
        chats = folder.chats;
      }
    }

    if (folder && chats[index]) {
      const chat = chats[index];

      // Try to trigger native rename first
      const result = await triggerNativeRename(chat);

      if (result && result.success) {
        // Native Trigger Success
        // 1. Close FM to avoid blocking the dialog
        closeFileManager();

        // 2. Observe the sidebar element for title change to sync state
        observeRename(result.element, folder, index);

      } else {
        // Fallback to local rename
        showPromptModal('Rename (Local Only)', chat.title, async (newName) => {
          chat.title = newName.trim();
          await saveState();
          renderFileManager();
          showToast('Renamed locally (Chat not found in sidebar)');
        });
      }
    }
  }
}

async function triggerNativeRename(chatData) {
  // 1. Find Chat in Sidebar
  const relativeUrl = chatData.url.replace(CONFIG.baseUrl, '');
  const chatLink = document.querySelector(`a[href="${relativeUrl}"], a[href="${chatData.url}"]`);

  if (!chatLink) return { success: false };

  // 2. Find Options Button
  const container = chatLink.closest('div.conversation-container') || chatLink.closest('div') || chatLink.parentElement;
  const optionsBtn = container.querySelector('button[aria-haspopup="menu"], button[aria-label="More options"]');

  if (!optionsBtn) return { success: false };

  // 3. Click Options Button
  optionsBtn.click();

  // 4. Wait for Menu and Click Rename
  return new Promise((resolve) => {
    setTimeout(() => {
      const renameBtn = document.querySelector('button[data-test-id="rename-button"]');
      if (renameBtn) {
        renameBtn.click();
        resolve({ success: true, element: chatLink });
      } else {
        // Try finding by text
        const allBtns = document.querySelectorAll('.mat-mdc-menu-content button');
        const textBtn = Array.from(allBtns).find(b => b.innerText.includes('Rename'));
        if (textBtn) {
          textBtn.click();
          resolve({ success: true, element: chatLink });
        } else {
          resolve({ success: false });
        }
      }
    }, 200);
  });
}

function observeRename(element, folder, chatIndex) {
  const titleEl = element.querySelector(CONFIG.selectors.chatTitle);
  if (!titleEl) return;

  const originalTitle = titleEl.innerText;

  /* 
   * NEW LOGIC: 
   * 1. Watch Title element for changes (Success).
   * 2. Watch document.body for the Rename Dialog to appear, then disappear (Completion/Cancel).
   * 3. Reopen FM when dialog is gone.
   */

  let dialogFound = false;
  let titleObserver = null;
  let dialogObserver = null;
  let closeObserver = null;

  const cleanup = () => {
    if (titleObserver) titleObserver.disconnect();
    if (dialogObserver) dialogObserver.disconnect();
    if (closeObserver) closeObserver.disconnect();
  };

  // 1. Title Observer
  titleObserver = new MutationObserver(() => {
    const newTitle = getCleanTitle(element);
    if (newTitle && newTitle !== originalTitle && newTitle !== "Untitled Chat") {
      folder.chats[chatIndex].title = newTitle;
      saveState();
      // We don't act here, we wait for dialog close to reopen FM
    }
  });
  titleObserver.observe(titleEl, { characterData: true, subtree: true, childList: true });

  // 2. Dialog Lifecycle Observer
  const checkDialogClosure = (dialog) => {
    closeObserver = new MutationObserver(() => {
      if (!document.body.contains(dialog)) {
        // Dialog has been removed (Closed/Cancelled/Saved)
        setTimeout(() => {
          fileManagerOpen = true;
          renderFileManager();

          // Optional: Check title one last time
          const newTitle = getCleanTitle(element);
          if (newTitle && newTitle !== originalTitle) {
            folder.chats[chatIndex].title = newTitle;
            saveState();
          }

          cleanup();
        }, 300); // Short delay for UI
      }
    });
    closeObserver.observe(document.body, { childList: true, subtree: true });
  };

  // Watch for Dialog Appearance
  dialogObserver = new MutationObserver(() => {
    // Look for standard Gemini dialog or menu content
    // Often .mat-mdc-dialog-container or role="dialog"
    const dialog = document.querySelector('div[role="dialog"]') || document.querySelector('.mat-mdc-dialog-container');

    if (dialog && !dialogFound) {
      dialogFound = true;
      dialogObserver.disconnect(); // Found it, stop looking for appearance
      checkDialogClosure(dialog);
    }
  });
  dialogObserver.observe(document.body, { childList: true, subtree: true });

  // Timeout safety
  setTimeout(() => {
    if (!dialogFound) cleanup();
    // If we never found a dialog in 10s, something is wrong or it wasn't a dialog flow.
    // But we shouldn't force reopen if user is doing something else.
  }, 10000);
}

async function deleteItem(type, index) {
  let list = folderState.folders;
  let folder = null;

  if (currentPath.length > 0) {
    let ptr = folderState.folders;
    for (const i of currentPath) {
      folder = ptr[i];
      ptr = folder.folders;
    }
    list = ptr;
  }

  if (type === 'folder') {
    const item = list[index];
    showConfirmModal('Delete', `Delete "${item.name}"?`, async () => {
      list.splice(index, 1);
      await saveState();
      renderFileManager();
    }, true);
  } else {
    if (folder) {
      folder.chats.splice(index, 1);
      await saveState();
      renderFileManager();
    }
  }
}

function setupFileManagerDragDrop(overlay) {
  const content = overlay.querySelector('#fm-content');

  content.ondragover = (e) => {
    e.preventDefault();
    content.classList.add('drag-over');
  };
  content.ondragleave = () => content.classList.remove('drag-over');

  content.ondrop = async (e) => {
    e.preventDefault();
    content.classList.remove('drag-over');

    // Handle Sidebar Chat Drop
    let data;
    try {
      data = JSON.parse(e.dataTransfer.getData('application/json'));
    } catch { return; }

    if (!data?.url) return;

    // Find current folder
    let folder = null;
    if (currentPath.length > 0) {
      let ptr = folderState.folders;
      for (const i of currentPath) {
        folder = ptr[i];
        ptr = folder.folders;
      }
    }

    if (folder) {
      if (data.url.startsWith('/')) data.url = CONFIG.baseUrl + data.url;
      if (!folder.chats.some(c => c.url === data.url)) {
        folder.chats.push(data);
        await saveState();
        renderFileManager();
        showToast('Saved to ' + folder.name);
      }
    } else {
      showToast('Cannot save to root (create a folder first)');
    }
  };
}



function injectGlobalSearch(target) {
  if (document.getElementById('gemini-global-search-container')) return;
  const div = document.createElement('div');
  div.id = 'gemini-global-search-container';
  div.innerHTML = '<div class="global-search-row">' +
    '<input type="text" id="gemini-global-search" placeholder="Search all chats...">' +
    '<button id="sidebar-bulk-select-btn" class="sidebar-select-btn" title="Select chats for bulk delete">' +
    '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">' +
    '<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zM17.99 9l-1.41-1.42-6.59 6.59-2.58-2.57-1.42 1.41 4 3.99z"/>' +
    '</svg>' +
    '</button>' +
    '</div>';
  target.prepend(div);

  document.getElementById('gemini-global-search').oninput = (e) => {
    currentGlobalSearch = e.target.value.toLowerCase();
    applyGlobalFilter();
  };

  document.getElementById('sidebar-bulk-select-btn').onclick = toggleBulkSelectMode;
}

function applyGlobalFilter() {
  document.querySelectorAll(CONFIG.selectors.chatLink).forEach(chat => {
    const title = getCleanTitle(chat).toLowerCase();
    chat.style.display = title.includes(currentGlobalSearch) ? "" : "none";
  });
}

// ============================================
// HEADER BUTTONS (Wide Mode + New Chat only)
// ============================================
function injectHeaderButtons() {
  if (document.getElementById('gemini-header-actions')) return;
  const shortcuts = settings.shortcuts || DEFAULT_SHORTCUTS;
  const div = document.createElement('div');
  div.id = 'gemini-header-actions';
  div.innerHTML = '<button id="wide-mode-btn" class="header-btn ' + (settings.wideMode ? 'active' : '') + '" title="' + (settings.wideMode ? 'Disable' : 'Enable') + ' Wide Mode (' + formatShortcut(shortcuts.wideMode) + ')">' +
    '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">' +
    '<path d="M4 4h16v16H4V4zm2 2v12h12V6H6zm1 5h10v2H7v-2z"/>' +
    '</svg>' +
    '</button>' +
    '<button id="file-manager-btn" class="header-btn" title="Open File Manager">' +
    '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/></svg>' +
    '</button>' +
    '<a href="/app" class="header-btn" title="New Chat (' + formatShortcut(shortcuts.newChat) + ')">' +
    '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"></path></svg>' +
    '</a>';
  document.body.appendChild(div);

  document.getElementById('wide-mode-btn').onclick = toggleWideMode;
  document.getElementById('file-manager-btn').onclick = openFileManager;
}

// ============================================
// BULK SELECT MODE
// ============================================
function toggleBulkSelectMode() {
  bulkSelectMode = !bulkSelectMode;
  document.body.classList.toggle('architect-bulk-mode', bulkSelectMode);

  const btn = document.getElementById('sidebar-bulk-select-btn');
  if (btn) {
    btn.classList.toggle('active', bulkSelectMode);
    btn.title = bulkSelectMode ? 'Exit select mode' : 'Select chats for bulk delete';
  }

  if (!bulkSelectMode) {
    document.querySelectorAll('.gemini-bulk-checkbox:checked').forEach(cb => cb.checked = false);
    updateBulkDeleteUI();
  }
}

function injectCheckboxes() {
  document.querySelectorAll(CONFIG.selectors.chatLink).forEach(chat => {
    if (chat.querySelector('.gemini-bulk-checkbox')) return;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'gemini-bulk-checkbox';
    cb.onclick = (e) => { e.stopPropagation(); updateBulkDeleteUI(); };
    chat.prepend(cb);
  });
}

function updateBulkDeleteUI() {
  let bar = document.getElementById('gemini-bulk-bar');
  const sel = document.querySelectorAll('.gemini-bulk-checkbox:checked');
  if (sel.length > 0 && bulkSelectMode) {
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'gemini-bulk-bar';
      bar.innerHTML = '<span class="bulk-count">' + sel.length + ' selected</span>' +
        '<button id="bulk-cancel-btn">Cancel</button>' +
        '<button id="bulk-del-btn">Delete</button>';
      document.body.appendChild(bar);

      document.getElementById('bulk-del-btn').onclick = () => {
        showConfirmModal(
          'Delete Chats',
          'Are you sure you want to delete ' + sel.length + ' chat' + (sel.length > 1 ? 's' : '') + '? This cannot be undone.',
          async () => {
            for (const c of Array.from(sel)) {
              const chat = c.closest('a');
              chat?.parentElement?.querySelector('button[aria-haspopup="menu"]')?.click();
              await new Promise(r => setTimeout(r, 200));
              document.querySelector('button[data-test-id="delete-button"]')?.click();
              await new Promise(r => setTimeout(r, 400));
              (document.querySelector('button[data-test-id="confirm-button"]') ||
                Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Delete')))?.click();
              await new Promise(r => setTimeout(r, 600));
            }
            location.reload();
          },
          true
        );
      };

      document.getElementById('bulk-cancel-btn').onclick = () => {
        toggleBulkSelectMode();
      };
    } else {
      bar.querySelector('.bulk-count').innerText = sel.length + ' selected';
    }
  } else if (bar) {
    bar.remove();
  }
}

// ============================================
// FOLDER CRUD
// ============================================

// Re-adding essential helpers that were deleted but shouldn't have been, or moving them here
async function saveState() {
  try {
    await chrome.storage.local.set({ [CONFIG.storageKey]: folderState });
  } catch (err) {
    console.error('Gemini Architect: Failed to save state', err);
    showToast('Failed to save. Storage may be full.');
  }
}

// ============================================
// CHAT DRAG & DROP (ADD TO FOLDER)
// ============================================
function makeChatsDraggable() {
  document.querySelectorAll(CONFIG.selectors.chatLink).forEach(chat => {
    if (chat.getAttribute('draggable') === 'true') return;
    chat.setAttribute('draggable', true);
    chat.ondragstart = (e) => {
      e.dataTransfer.setData('application/json', JSON.stringify({
        url: chat.getAttribute('href'),
        title: getCleanTitle(chat)
      }));
    };
  });
}

function searchFileManager(list, term, currentPath = []) {
  let results = [];
  list.forEach((folder, idx) => {
    const path = [...currentPath, idx];
    const pathStr = path.join(':');

    if (folder.name.toLowerCase().includes(term)) {
      results.push({ type: 'folder', folder: folder, pathStr: pathStr });
    }

    // Search chats
    if (folder.chats) {
      folder.chats.forEach(chat => {
        if (chat.title.toLowerCase().includes(term)) {
          results.push({ type: 'chat', chat: chat, pathStr: pathStr });
        }
      });
    }

    // Recurse
    if (folder.folders) {
      results = results.concat(searchFileManager(folder.folders, term, path));
    }
  });
  return results;
}

function jumpToPath(pathStr) {
  fmSearchTerm = "";
  currentPath = pathStr.split(':').map(Number);
  renderFileManager();
}

function showColorPicker(path) {
  const result = getFolderByPath(path);
  if (!result || !result.folder) return;
  const { folder } = result;

  document.getElementById('color-picker-popup')?.remove();

  const colors = ['default', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'grey'];

  const picker = document.createElement('div');
  picker.id = 'color-picker-popup';
  picker.className = 'glass-panel';
  picker.innerHTML = '<div class="picker-title">Choose Color</div>' +
    '<div class="color-grid">' +
    colors.map(c =>
      `<div class="color-option ${c} ${folder.color === c ? 'selected' : ''}" data-color="${c}"></div>`
    ).join('') +
    '</div>';

  document.body.appendChild(picker);

  // Position near cursor or center? path logic implies specific item.
  // We can find the item by data-index but we only have path here.
  // Let's position centered for simplicity or find the element.
  // We can traverse current path to find index.
  const indices = path.split(':');
  const index = indices[indices.length - 1];

  // Find element in current view
  const idx = parseInt(index);
  const iconEl = document.querySelector(`.fm-item.folder[data-index="${idx}"]`);

  if (iconEl) {
    const rect = iconEl.getBoundingClientRect();
    picker.style.top = (rect.bottom + 5) + 'px';
    picker.style.left = Math.max(10, rect.left) + 'px';
  } else {
    // Fallback to center
    picker.style.position = 'fixed';
    picker.style.top = '50%';
    picker.style.left = '50%';
    picker.style.transform = 'translate(-50%, -50%)';
  }

  picker.querySelectorAll('.color-option').forEach(opt => {
    opt.onclick = async () => {
      const result2 = getFolderByPath(path); // Re-fetch to ensure fresh reference
      if (result2 && result2.folder) {
        result2.folder.color = opt.dataset.color;
        await saveState();
        renderFileManager();
      }
      picker.remove();
    };
  });

  setTimeout(() => {
    document.addEventListener('click', function close(e) {
      if (!picker.contains(e.target) && !e.target.closest('.context-menu')) {
        picker.remove();
        document.removeEventListener('click', close);
      }
    });
  }, 0);
}

function showEmojiPicker(path) {
  const result = getFolderByPath(path);
  if (!result || !result.folder) return;
  const { folder } = result;

  document.getElementById('emoji-picker-popup')?.remove();

  const picker = document.createElement('div');
  picker.id = 'emoji-picker-popup';
  picker.className = 'glass-panel';
  picker.innerHTML = '<div class="picker-title">Choose Icon</div>' +
    '<div class="emoji-grid">' +
    FOLDER_EMOJIS.map(e =>
      `<div class="emoji-option" data-emoji="${e}">${e}</div>`
    ).join('') +
    '</div>';

  document.body.appendChild(picker);

  // We can find the item by data-index but we only have path here.
  const indices = path.split(':');
  const index = indices[indices.length - 1];

  // Find element in current view
  const idx = parseInt(index);
  const iconEl = document.querySelector(`.fm-item.folder[data-index="${idx}"]`);

  if (iconEl) {
    const rect = iconEl.getBoundingClientRect();
    picker.style.top = (rect.bottom + 5) + 'px';
    picker.style.left = Math.max(10, rect.left - 50) + 'px';
  } else {
    picker.style.position = 'fixed';
    picker.style.top = '50%';
    picker.style.left = '50%';
    picker.style.transform = 'translate(-50%, -50%)';
  }

  picker.querySelectorAll('.emoji-option').forEach(opt => {
    opt.onclick = async () => {
      const result2 = getFolderByPath(path);
      if (result2 && result2.folder) {
        result2.folder.icon = opt.dataset.emoji;
        await saveState();
        renderFileManager();
      }
      picker.remove();
    };
  });

  setTimeout(() => {
    document.addEventListener('click', function close(e) {
      if (!picker.contains(e.target) && !e.target.closest('.context-menu')) {
        picker.remove();
        document.removeEventListener('click', close);
      }
    });
  }, 0);
}


// ============================================
// AUTH HANDLER (URL INTERCEPTION)
// ============================================
function handleAuthCallback() {
  const hash = window.location.hash.substring(1); // Remove '#'
  if (!hash) return;

  const params = new URLSearchParams(hash);
  const accessToken = params.get('access_token');
  const type = params.get('type');
  const error = params.get('error_description');

  // Clear hash to clean URL? Maybe better to keep it for debugging or let app handle it if needed.
  // Actually, Gemini might overwrite it. We should grab it ASAP.

  if (error) {
    showToast(`Auth Error: ${error.replace(/\+/g, ' ')}`);
    return;
  }

  if (accessToken) {
    // 1. Save Session (Login)
    const expiresIn = params.get('expires_in');
    const refreshToken = params.get('refresh_token');

    // We need to fetch user details to store full session format expected by popup/background
    // We'll send a message to background to handle this session setup.
    chrome.runtime.sendMessage({
      action: 'handleSession',
      session: {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: expiresIn,
        token_type: params.get('token_type'),
        user: null // Background will fetch user
      }
    }, (response) => {
      if (response && response.success) {
        showToast('Logged in successfully via Extension!');
        if (type === 'recovery') {
          showPasswordResetModal(accessToken);
        } else {
          // Just a login (Magic Link or similar)
          setTimeout(() => {
            // Optional: Close tab or just let user continue
          }, 2000);
        }
      } else {
        showToast('Failed to save session via Extension.');
      }
    });
  }
}

function showPasswordResetModal(token) {
  showModal({
    title: 'Reset Password',
    content: `
      <p>Set a new password for your Gemini Chat Folders account.</p>
      <input type="password" id="reset-new-password" placeholder="New Password" class="architect-modal-input" style="margin-bottom: 10px;">
      <input type="password" id="reset-confirm-password" placeholder="Confirm Password" class="architect-modal-input">
    `,
    buttons: [
      { text: 'Cancel' },
      {
        text: 'Update Password',
        primary: true,
        onClick: () => {
          const pass = document.getElementById('reset-new-password').value;
          const confirm = document.getElementById('reset-confirm-password').value;

          if (pass.length < 6) {
            showToast('Password must be at least 6 characters');
            return false;
          }
          if (pass !== confirm) {
            showToast('Passwords do not match');
            return false;
          }

          // Send to background to update
          chrome.runtime.sendMessage({
            action: 'updatePassword',
            token: token,
            password: pass
          }, (res) => {
            if (res && res.success) {
              showToast('Password updated successfully!');
            } else {
              showToast('Failed to update password: ' + (res.error || 'Unknown error'));
            }
          });
          return true; // Close modal
        }
      }
    ]
  });
}

// Run auth check on init
if (window.location.hash.includes('access_token')) {
  // Small delay to ensure extension is ready
  setTimeout(handleAuthCallback, 500);
}

init();
