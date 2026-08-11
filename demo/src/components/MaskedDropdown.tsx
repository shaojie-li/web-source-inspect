// Reproduces two issues caused by Chakra/Radix-style dropdowns; this is where the probe is most likely to fail:
//   1. Opening the dropdown adds a fullscreen mask, so event.target becomes the mask (which is also a React element with a fiber).
//   2. The mask closes the dropdown during mousedown. By the time click arrives, the original element is gone from the DOM,
//      and event.target falls back to an ancestor or even <html>.
import { useState } from 'react';

const OPTIONS = ['0.001', '0.01', '0.1'];

export default function MaskedDropdown() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(OPTIONS[0]);

  return (
    <div className="card">
      <h2>6. Fullscreen-masked dropdown (the mask steals event.target)</h2>
      <div style={{ position: 'relative', display: 'inline-block' }}>
        <button id="dropdown-trigger" onClick={() => setOpen((o) => !o)}>
          {value} ▾
        </button>

        {open && (
          <>
            {/* Outside-click layer: closes on mousedown, before click fires. */}
            <div
              id="dropdown-mask"
              style={{ position: 'fixed', inset: 0, zIndex: 100 }}
              onMouseDown={() => setOpen(false)}
            />
            <ul
              id="dropdown-menu"
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                zIndex: 101,
                margin: '4px 0 0',
                padding: '4px 0',
                listStyle: 'none',
                background: '#fff',
                border: '1px solid #e5e5e5',
                borderRadius: '6px',
                boxShadow: '0 4px 16px rgba(0,0,0,.12)',
                minWidth: '90px',
              }}
            >
              {OPTIONS.map((opt) => (
                <li
                  key={opt}
                  className="dropdown-option"
                  style={{ padding: '6px 14px', cursor: 'pointer', fontSize: '13px' }}
                  onClick={() => {
                    setValue(opt);
                    setOpen(false);
                  }}
                >
                  {opt}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
