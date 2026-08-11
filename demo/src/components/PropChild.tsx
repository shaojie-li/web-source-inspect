// Reproduces a confusing case from real projects: an element is passed to a child component as a prop.
// This span's source location is in PropChild (below), but it is attached inside Labeled in the fiber tree,
// so the innermost component in the chain is Labeled rather than PropChild. Both are correct; their semantics differ.
import type { ReactNode } from 'react';

function Labeled({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="todo-item">
      <span className="todo-text">{label}</span>
      {value}
    </div>
  );
}

export default function PropChild() {
  return (
    <div className="card">
      <h2>5. Element passed through a prop (source location ≠ fiber ownership)</h2>
      <Labeled
        label="Available balance"
        value={<span id="prop-child-span" className="badge">2.05 USDC</span>}
      />
    </div>
  );
}
