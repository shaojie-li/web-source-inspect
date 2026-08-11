// Deep nesting with memo/forwardRef wrappers to test component-chain and type-name handling.
import { forwardRef, memo } from 'react';

const Leaf = memo(function Leaf({ depth }: { depth: number }) {
  return <div className="deep-nest">Leaf node, depth = {depth}</div>;
});

const Middle = forwardRef<HTMLDivElement, { depth: number }>(function Middle({ depth }, ref) {
  return (
    <div className="deep-nest" ref={ref}>
      Middle layer, depth = {depth}
      <Leaf depth={depth + 1} />
    </div>
  );
});

export default function DeepNest() {
  return (
    <div className="card">
      <h2>3. Nested components + memo / forwardRef</h2>
      <div className="deep-nest">
        Outer layer
        <Middle depth={2} />
      </div>
    </div>
  );
}
