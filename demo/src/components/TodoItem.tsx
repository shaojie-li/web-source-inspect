type Props = {
  text: string;
  done: boolean;
  onToggle: () => void;
};

export default function TodoItem({ text, done, onToggle }: Props) {
  return (
    <li className={done ? 'todo-item done' : 'todo-item'}>
      <input type="checkbox" checked={done} onChange={onToggle} />
      <span className="todo-text">{text}</span>
      {done && <span className="badge">Done</span>}
    </li>
  );
}
