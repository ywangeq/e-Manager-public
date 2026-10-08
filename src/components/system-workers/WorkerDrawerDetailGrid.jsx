export default function WorkerDrawerDetailGrid({ items }) {
  return (
    <dl className="worker-drawer-detail-grid">
      {items
        .filter(([, value]) => value)
        .map(([label, value], index) => {
          const textValue = String(value);
          const itemClassName = textValue.length > 26 ? "worker-drawer-detail-item is-wide" : "worker-drawer-detail-item";

          return (
            <div className={itemClassName} key={`${label}-${index}`}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          );
        })}
    </dl>
  );
}
