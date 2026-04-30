import React from "react";

export default function SourceChip({
  id,
  label,
  count,
  color,
  status,
  title,
  active = false,
  all = false,
  onClick,
}) {
  const className = `src-chip ${all ? "all " : ""}${active ? "active" : ""}`.trim();
  return (
    <button
      className={className}
      style={all ? undefined : { "--src-color": color }}
      title={title}
      onClick={onClick}
      data-testid={`source-chip-${id}`}
    >
      {!all && <span className={`src-status src-status-${status}`} />}
      {label}
      <span className="src-count">{count}</span>
    </button>
  );
}
