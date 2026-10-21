type VerifiedBadgeProps = { label?: string };

export default function VerifiedBadge({ label = 'Верифицированный аккаунт' }: VerifiedBadgeProps) {
    return <span className="verified-badge" role="img" aria-label={label} title={label}>✓</span>;
}
