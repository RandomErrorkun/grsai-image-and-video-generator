/** 页面还没接入时的占位：居中显示页面名称。 */
export function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="page page--placeholder">
      <span className="page__placeholder">{title}</span>
    </div>
  );
}
