import { useState } from 'react';
import TodoCard from './components/TodoCard';
import DeepNest from './components/DeepNest';
import NativeBlock from './components/NativeBlock';
import PropChild from './components/PropChild';
import MaskedDropdown from './components/MaskedDropdown';

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="page">
      <h1>source-inspect demo</h1>

      <div className="hint">
        Hold <b>Alt</b> and move your mouse → the blue outline follows, with the location shown in the tooltip
        <br />
        <b>Alt + click</b> → pin the orange outline and open the card; click a blue source link to open your editor, or press <b>Esc</b> to close
        <br />
        Try each section below to see how the probe handles nesting, cross-file rendering, and non-React elements.
      </div>

      <div className="card">
        <h2>1. Simple elements in one file</h2>
        <p>This paragraph and the button below are both defined in App.tsx.</p>
        <button onClick={() => setCount((c) => c + 1)}>Clicked {count} times</button>
      </div>

      <TodoCard />
      <DeepNest />
      <NativeBlock />
      <PropChild />
      <MaskedDropdown />
    </div>
  );
}
