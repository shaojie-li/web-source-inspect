// Intentionally inserts content with the native DOM API: these nodes have no fiber.
// This exercises the probe's fallback path (show "no React fiber" or fall back to the nearest React ancestor).
import { useEffect, useRef } from 'react';

export default function NativeBlock() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;
    host.current.innerHTML = `
      <div class="deep-nest" id="native-child">
        I was inserted with innerHTML; I have no fiber.
        <button id="native-btn">Native button</button>
      </div>
    `;
  }, []);

  return (
    <div className="card">
      <h2>4. Non-React DOM nodes (fallback case)</h2>
      <div ref={host} />
    </div>
  );
}
