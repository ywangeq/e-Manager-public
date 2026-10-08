export default function MetricCard({ label, value, detail, onClick }) {
  const content = (
    <>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </>
  );

  if (onClick) {
    return (
      <button className="metric-card is-interactive" type="button" onClick={onClick} aria-label={`查看${label}`}>
        {content}
      </button>
    );
  }

  return <article className="metric-card">{content}</article>;
}
