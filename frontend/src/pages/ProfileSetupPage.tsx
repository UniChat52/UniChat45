import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../services/api';
import { useAuthStore } from '../store/auth';

export default function ProfileSetupPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const updateUser = useAuthStore((s) => s.updateUser);

    const [username, setUsername] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [bio, setBio] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            const data: any = {};
            if (username) data.username = username;
            if (displayName) data.displayName = displayName;
            if (bio) data.bio = bio;

            const user = await api.updateProfile(data);
            updateUser(user);
            navigate('/chat');
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="profile-setup-page">
            <div className="profile-setup-card">
                <h2>✨ {t('profile.setup')}</h2>

                <form className="profile-setup-form" onSubmit={handleSubmit}>
                    <div className="input-group">
                        <label className="input-label">{t('profile.displayName')}</label>
                        <input
                            className="input"
                            type="text"
                            value={displayName}
                            onChange={(e) => setDisplayName(e.target.value)}
                            placeholder="Александр"
                            autoFocus
                        />
                    </div>

                    <div className="input-group">
                        <label className="input-label">{t('profile.username')}</label>
                        <input
                            className="input"
                            type="text"
                            value={username}
                            onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase())}
                            placeholder="username"
                        />
                    </div>

                    <div className="input-group">
                        <label className="input-label">{t('profile.bio')}</label>
                        <textarea
                            className="input"
                            value={bio}
                            onChange={(e) => setBio(e.target.value)}
                            placeholder="..."
                            rows={3}
                            style={{ resize: 'vertical' }}
                        />
                    </div>

                    {error && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>}

                    <button className="btn btn-primary" type="submit" disabled={loading}>
                        {loading ? '...' : t('profile.save')}
                    </button>

                    <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => navigate('/chat')}
                    >
                        {t('common.cancel')}
                    </button>
                </form>
            </div>
        </div>
    );
}
