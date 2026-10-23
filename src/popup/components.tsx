import type { ComponentChildren } from 'preact';
import { useId } from 'preact/hooks';

export function Switch(props: { checked: boolean; onChange: (v: boolean) => void; label: string; size?: 'lg' | 'sm' }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      class={`switch ${props.size === 'lg' ? 'switch-lg' : ''}`}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="switch-thumb" />
    </button>
  );
}

export function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label: string; hint: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  const index = Math.max(0, props.options.findIndex((o) => o.value === props.value));
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = props.options[(index + step + props.options.length) % props.options.length]!;
    props.onChange(next.value);
    (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role=radio]')[props.options.indexOf(next)]?.focus();
  };
  return (
    <div
      class="segmented"
      role="radiogroup"
      aria-label={props.label}
      onKeyDown={onKey}
      style={{ '--seg-count': props.options.length, '--seg-index': index }}
    >
      <span class="segmented-pill" aria-hidden="true" />
      {props.options.map((o) => (
        <button
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          tabIndex={o.value === props.value ? 0 : -1}
          title={o.hint}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onInput: (v: number) => void;
  onCommit: (v: number) => void;
  hint?: string;
}) {
  const id = useId();
  const pct = ((props.value - props.min) / (props.max - props.min)) * 100;
  return (
    <div class="slider" title={props.hint}>
      <div class="slider-head">
        <label for={id}>{props.label}</label>
        <output for={id}>{props.format(props.value)}</output>
      </div>
      <input
        id={id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        style={{ '--pct': `${pct}%` }}
        onInput={(e) => props.onInput(Number((e.target as HTMLInputElement).value))}
        onChange={(e) => props.onCommit(Number((e.target as HTMLInputElement).value))}
      />
    </div>
  );
}

export function ToggleRow(props: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  icon: ComponentChildren;
  note?: string;
  disabled?: boolean;
}) {
  return (
    <div class={`toggle-row ${props.disabled ? 'is-disabled' : ''}`}>
      <span class="toggle-icon" aria-hidden="true">
        {props.icon}
      </span>
      <span class="toggle-text">
        <span>{props.label}</span>
        {props.note && <small>{props.note}</small>}
      </span>
      <Switch checked={props.checked} onChange={props.onChange} label={props.label} size="sm" />
    </div>
  );
}

/** 16px stroke icons, drawn to match the system UI weight rather than pulled from a font. */
export const Icon = {
  accents: (
    <svg viewBox="0 0 16 16"><path d="M8 1.5a6.5 6.5 0 1 0 0 13c.9 0 1.3-.6 1.3-1.2 0-.9-.8-1.1-.8-1.9 0-.6.5-1 1.1-1h1.6a3.3 3.3 0 0 0 3.3-3.3C14.5 3.9 11.6 1.5 8 1.5Z" /><circle cx="4.8" cy="7.2" r=".9" /><circle cx="7" cy="4.4" r=".9" /><circle cx="10.4" cy="4.9" r=".9" /></svg>
  ),
  progress: (
    <svg viewBox="0 0 16 16"><path d="M1.5 8h13" /><path d="M1.5 8h7" class="strong" /><circle cx="8.5" cy="8" r="2" /></svg>
  ),
  glow: (
    <svg viewBox="0 0 16 16"><rect x="3.5" y="5" width="9" height="6" rx="1.5" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8H2M14 8h.5M3.2 3.2l.8.8M12 12l.8.8M12.8 3.2l-.8.8M4 12l-.8.8" /></svg>
  ),
  scrollbar: (
    <svg viewBox="0 0 16 16"><rect x="2.5" y="1.5" width="11" height="13" rx="2" /><path d="M10.5 4v4" class="strong" /></svg>
  ),
  tint: (
    <svg viewBox="0 0 16 16"><path d="M8 1.8s4.3 4.6 4.3 7.6a4.3 4.3 0 0 1-8.6 0C3.7 6.4 8 1.8 8 1.8Z" /></svg>
  ),
  keep: (
    <svg viewBox="0 0 16 16"><path d="M4.5 1.5h7v13L8 11.5l-3.5 3Z" /></svg>
  ),
  copy: (
    <svg viewBox="0 0 16 16"><rect x="5" y="5" width="9" height="9" rx="1.5" /><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" /></svg>
  ),
};
