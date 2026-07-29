// LIA-496 (WB4, review-fix) — W16 composer secondary row, per the plan's D3
// resolution: Fable rated the missing attach/model-picker row "low,
// acceptable for a spike"; GPT rated it "high, a real structural gap."
// Resolution landed here — a genuinely interactive model-picker dropdown
// (real `<button aria-haspopup="listbox">`, real popover, arrow-key +
// Escape + click-outside handling) toggling between two scripted labels
// ("Sonnet 5" default, one alternate).
//
// This is web-app-local presentation state, deliberately NOT exported from
// @lia496/shared and NOT imported from it — it is UI-structure demo state
// (which model label is currently showing), not fixture/runtime data, so
// `check-shared-purity.sh`'s gate has nothing to say about it: it never
// crosses the shared boundary at all.
//
// Also closes Fable's separate "static badge styled as interactive"
// finding: this replaces an inert `<span className="s-model">Sonnet 5
// </span>` that used to sit in Thread.tsx's top bar — a fixed label styled
// to LOOK clickable (rounded pill, border) but with no click handler, no
// keyboard affordance, and no `role`/`aria-*` at all. That span is now
// retired from Thread.tsx entirely; this component is the genuine
// replacement, relocated into the composer's own secondary row (see
// Composer.tsx's header comment for why it lives there instead).
import { useEffect, useId, useRef, useState, type FC, type KeyboardEvent as ReactKeyboardEvent } from "react";

const MODELS = ["Sonnet 5", "Opus 5"] as const;
type Model = (typeof MODELS)[number];

export const ModelPicker: FC = () => {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Model>(MODELS[0]);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Stable per-instance id prefix for the listbox options — needed so
  // `aria-activedescendant` (below) can reference the arrow-key-active
  // option's id without colliding if more than one ModelPicker ever mounts
  // at once.
  const optionIdPrefix = useId();

  // Click-outside close — a real pointerdown listener on `document`, not a
  // CSS-only or blur-based approximation, so it works the same whether the
  // dismissing click lands on the page background, the sidebar, or the
  // thread pane.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Real arrow-key navigation needs the listbox to actually hold focus —
  // move it there the moment the popover opens (and back to the trigger on
  // close, handled at each close site below) rather than leaving focus on
  // the trigger button while the menu is visually open.
  useEffect(() => {
    if (open) menuRef.current?.focus();
  }, [open]);

  const openMenu = () => {
    setActiveIndex(MODELS.indexOf(selected));
    setOpen(true);
  };

  const choose = (model: Model) => {
    setSelected(model);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onTriggerKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openMenu();
    }
  };

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % MODELS.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + MODELS.length) % MODELS.length);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(MODELS[activeIndex]);
    }
    if (e.key === "Tab") {
      // Don't trap Tab — just let the popover close like any other
      // dismissal so focus can keep moving through the page normally.
      setOpen(false);
    }
  };

  return (
    <div className="s-model-picker" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="s-model"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        {selected}
        <span className="s-model-caret" aria-hidden="true">
          ⌄
        </span>
      </button>
      {open && (
        <div
          className="s-model-menu"
          role="listbox"
          aria-label="Model"
          aria-activedescendant={`${optionIdPrefix}-${activeIndex}`}
          tabIndex={-1}
          ref={menuRef}
          onKeyDown={onMenuKeyDown}
        >
          {MODELS.map((model, i) => (
            <div
              key={model}
              id={`${optionIdPrefix}-${i}`}
              role="option"
              aria-selected={model === selected}
              className={`s-model-option${i === activeIndex ? " active" : ""}${model === selected ? " selected" : ""}`}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => choose(model)}
            >
              {model}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
