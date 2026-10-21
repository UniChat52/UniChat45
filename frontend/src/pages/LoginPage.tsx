import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../services/api';
import { useAuthStore } from '../store/auth';

export default function LoginPage() {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const setAuth = useAuthStore((s) => s.setAuth);

    const [step, setStep] = useState<'phone' | 'code'>('phone');
    const [phone, setPhone] = useState('');
    const [code, setCode] = useState('');
    const [devCode, setDevCode] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const switchLang = (lng: string) => {
        i18n.changeLanguage(lng);
        localStorage.setItem('locale', lng);
    };

    const handleSendCode = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);
        try {
            const result = await api.sendCode(phone);
            if (result.error) {
                setError(result.error);
            } else {
                setStep('code');
                if (result.code) setDevCode(result.code);
            }
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const handleVerifyCode = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);
        try {
            const fingerprint = `${navigator.userAgent}-${screen.width}x${screen.height}`;
            const result = await api.verifyCode(phone, code, fingerprint);
            if (result.error) {
                setError(result.error);
            } else {
                setAuth(result);
                navigate(result.isNewUser ? '/profile-setup' : '/chat');
            }
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="login-page">
            <div className="login-card">
                <div className="login-lang">
                    <div className="lang-switch">
                        <button className={`lang-btn ${i18n.language === 'ru' ? 'active' : ''}`} onClick={() => switchLang('ru')}>RU</button>
                        <button className={`lang-btn ${i18n.language === 'en' ? 'active' : ''}`} onClick={() => switchLang('en')}>EN</button>
                    </div>
                </div>

                <div className="login-logo">
                    <div className="login-logo-icon">💬</div>
                    <h1>UniChat</h1>
                    <p>{t('auth.title')}</p>
                </div>

                {step === 'phone' ? (
                    <form className="login-form" onSubmit={handleSendCode}>
                        <div className="input-group">
                            <label className="input-label">{t('auth.phone')}</label>
                            <input
                                className="input"
                                type="tel"
                                placeholder={t('auth.phonePlaceholder')}
                                value={phone}
                                onChange={(e) => setPhone(e.target.value)}
                                required
                                autoFocus
                            />
                        </div>

                        {error && <div className={`login-error ${error === 'Ваш аккаунт заблокирован!' ? 'blocked-account' : ''}`}>{error}</div>}

                        <button className="btn btn-primary" type="submit" disabled={loading || !phone} style={{ width: '100%', padding: '14px' }}>
                            {loading ? (
                                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span>
                                    {t('auth.sending')}
                                </span>
                            ) : (
                                <>→ {t('auth.sendCode')}</>
                            )}
                        </button>
                    </form>
                ) : (
                    <form className="login-form" onSubmit={handleVerifyCode}>
                        <div style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6 }}>
                            {t('auth.codeSent')}
                            <br />
                            <strong style={{ color: 'var(--text-accent)' }}>{phone}</strong>
                        </div>

                        {devCode && (
                            <div className="dev-code">
                                <div className="dev-code-label">🔧 {t('auth.devCode')}</div>
                                <div className="dev-code-value">{devCode}</div>
                            </div>
                        )}

                        <div className="input-group">
                            <label className="input-label">{t('auth.code')}</label>
                            <input
                                className="input"
                                type="text"
                                placeholder="• • • • • •"
                                value={code}
                                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                maxLength={6}
                                required
                                autoFocus
                                style={{ textAlign: 'center', fontSize: 28, letterSpacing: 12, fontWeight: 700, padding: '14px 16px' }}
                            />
                        </div>

                        {error && <div className={`login-error ${error === 'Ваш аккаунт заблокирован!' ? 'blocked-account' : ''}`}>{error}</div>}

                        <button className="btn btn-primary" type="submit" disabled={loading || code.length !== 6} style={{ width: '100%', padding: '14px' }}>
                            {loading ? (
                                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span>
                                    {t('auth.verifying')}
                                </span>
                            ) : (
                                <>✓ {t('auth.verify')}</>
                            )}
                        </button>

                        <button type="button" className="btn btn-ghost" onClick={() => { setStep('phone'); setCode(''); setDevCode(''); setError(''); }} style={{ width: '100%' }}>
                            ← {t('auth.phone')}
                        </button>
                    </form>
                )}
            </div>
        </div>
    );
}
