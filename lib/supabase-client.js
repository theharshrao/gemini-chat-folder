export class SupabaseClient {
    constructor(supabaseUrl, supabaseKey) {
        this.supabaseUrl = supabaseUrl;
        this.supabaseKey = supabaseKey;
        this.token = null;
    }

    async _fetch(endpoint, options = {}) {
        const url = `${this.supabaseUrl}${endpoint}`;
        const headers = {
            'apikey': this.supabaseKey,
            'Content-Type': 'application/json',
            'Authorization': this.token ? `Bearer ${this.token}` : undefined,
            ...options.headers
        };

        const response = await fetch(url, { ...options, headers });

        // Robust parsing: Handle empty bodies (204, 201, etc) gracefully
        let data = null;
        try {
            const text = await response.text();
            if (text && text.trim().length > 0) {
                data = JSON.parse(text);
            }
        } catch (e) {
            // Ignore parse errors if response was ok, otherwise we might miss error details?
            // If response is NOT ok, and we failed to parse, we still throw status.
        }

        if (!response.ok) throw { error: data, status: response.status };
        return data;
    }

    // Auth Methods
    async signUp(email, password) {
        return this._fetch('/auth/v1/signup', {
            method: 'POST',
            body: JSON.stringify({ email, password })
        });
    }

    async signIn(email, password) {
        const data = await this._fetch('/auth/v1/token?grant_type=password', {
            method: 'POST',
            body: JSON.stringify({ email, password })
        });
        if (data.access_token) this.token = data.access_token;
        return data;
    }

    async getUser(token) {
        return this._fetch('/auth/v1/user', {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        });
    }

    // Database Methods
    async getFolders(userId) {
        // Select * from folders where user_id = userId
        return this._fetch(`/rest/v1/folders?user_id=eq.${userId}&select=*`, {
            method: 'GET'
        });
    }

    async upsertFolders(userId, folderData) {
        // Upsert logic: Use 'resolution=merge-duplicates' AND specify the conflict column 'on_conflict=user_id'
        return this._fetch('/rest/v1/folders?on_conflict=user_id', {
            method: 'POST',
            headers: { 'Prefer': 'resolution=merge-duplicates' },
            body: JSON.stringify({ user_id: userId, data: folderData })
        });
    }

    setSession(token) {
        this.token = token;
    }
}
