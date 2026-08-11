import { useState } from 'react';
import TodoItem from './TodoItem';

const INITIAL = [
  { id: 1, text: 'Check whether fiber exposes source locations', done: true },
  { id: 2, text: 'Restore source positions with sourcemaps', done: false },
  { id: 3, text: 'Build cursor:// editor links', done: false },
];

export default function TodoCard() {
  const [todos, setTodos] = useState(INITIAL);

  const toggle = (id: number) =>
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));

  return (
    <div className="card">
      <h2>2. List rendering (each item is in TodoItem.tsx)</h2>
      <ul className="todo-list">
        {todos.map((todo) => (
          <TodoItem key={todo.id} text={todo.text} done={todo.done} onToggle={() => toggle(todo.id)} />
        ))}
      </ul>
    </div>
  );
}
