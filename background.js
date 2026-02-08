
import { SupabaseClient } from './lib/supabase-client.js';
import { CONFIG } from './config.js';

const SUPABASE_URL = CONFIG.SUPABASE_URL;
const SUPABASE_KEY = CONFIG.SUPABASE_KEY;

const supabase = new SupabaseClient(SUPABASE_URL, SUPABASE_KEY);
const STORAGE_KEY = 'gemini_folders_data';
let isSyncing = false; // Prevent loops

// Listen for storage changes
chrome.storage.onChanged.addListener(async (changes, namespace) => {
    if (namespace === 'local') {
        // 1. Check if Folders Changed
        if (changes[STORAGE_KEY]) {
            // Avoid reacting to our own writes (if we pull from cloud)
            // For now, assume writes from Content Script need to go to Cloud.

            const newValue = changes[STORAGE_KEY].newValue;
            if (!newValue) return; // Deleted?

            await syncToCloud(newValue.folders);
        }

        // 2. Check if Session Changed (User logged in/out)
        if (changes['supabase_session']) {
            const session = changes['supabase_session'].newValue;
            if (session && session.access_token) {
                supabase.setSession(session.access_token);
                // Maybe trigger a pull on login?
            } else {
                supabase.setSession(null);
            }
        }
    }
}
});

// LISTEN FOR MESSAGES FROM CONTENT SCRIPT (Mainly Auth)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'handleSession') {
        handleSessionSetup(request.session).then(res => sendResponse(res));
        return true; // async response
    }

    if (request.action === 'updatePassword') {
        updateUserPassword(request.token, request.password).then(res => sendResponse(res));
        return true; // async response
    }
});

async function handleSessionSetup(sessionPartial) {
    try {
        const token = sessionPartial.access_token;
        supabase.setSession(token);

        // Fetch User Details to complete the session object
        // We need to fetch user from Supabase Auth API
        // Typically GET /auth/v1/user
        // We don't have a direct method in our client for this yet, let's add or use raw fetch

        // Actually, our client.getUser(token) exists? Let's check config.
        // Yes, supabase-client.js has getUser(token).

        // We need to instantiate a client here? 'supabase' is already instantiated at top of file.
        // Wait, 'supabase' in this file is an instance.
        // Does it have getUser?
        // Let's modify supabase-client.js if needed or use existing.
        // The file `lib/supabase-client.js` has `getUser(token)`.

        // But `supabase.getUser` is not exposed in the simple instance we created?
        // Ah, `supabase` is `new SupabaseClient(...)`. So yes it has methods.
        // WAIT: The `supabase-client.js` I read earlier creates the class.

        const userData = await supabase.getUser(token);
        // userData might vary structure depending on API.
        // Usually it returns User object directly or { user: ... }

        // If successful
        const fullSession = {
            access_token: token,
            refresh_token: sessionPartial.refresh_token,
            expires_in: sessionPartial.expires_in,
            token_type: sessionPartial.token_type,
            user: userData // Save the full user object
        };

        await chrome.storage.local.set({ 'supabase_session': fullSession });
        return { success: true };

    } catch (e) {
        console.error('Session Setup Failed:', e);
        return { success: false, error: e.message };
    }
}

async function updateUserPassword(token, newPassword) {
    try {
        supabase.setSession(token);
        const result = await supabase.updateUser({ password: newPassword });
        return { success: true, data: result };
    } catch (e) {
        console.error('Password Update Failed:', e);
        return { success: false, error: e.message };
    }
}

async function syncToCloud(folders) {
    if (isSyncing) return;

    // Get current session from storage if not set
    if (!supabase.token) {
        const stored = await chrome.storage.local.get(['supabase_session']);
        if (stored.supabase_session && stored.supabase_session.access_token) {
            supabase.setSession(stored.supabase_session.access_token);
        } else {
            return; // No user logged in, cannot sync
        }
    }

    // Get User ID
    // Optimally we store user info or get it from token. 
    // Our popup saves 'user' object in session. Let's get it.
    const stored = await chrome.storage.local.get(['supabase_session']);
    const user = stored.supabase_session?.user;

    if (!user || !user.id) return;

    try {
        isSyncing = true;
        console.log('[Background] Pushing changes to Supabase...');
        await supabase.upsertFolders(user.id, { folders: folders });
        console.log('[Background] Sync Success');
    } catch (err) {
        console.error('[Background] Sync Failed', JSON.stringify(err, null, 2));
    } finally {
        isSyncing = false;
    }
}
