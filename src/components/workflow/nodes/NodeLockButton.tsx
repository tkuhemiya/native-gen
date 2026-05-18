"use client";

type Props = {
  locked: boolean;
  disabled?: boolean;
  /** Shown when `disabled` (tooltip + aria) */
  disabledTitle?: string;
  lockedTitle: string;
  unlockedTitle: string;
  onToggle: (locked: boolean) => void;
  /**
   * `card` — minimal right inset (primitives, simple nodes).
   * `inset` — further left so the icon clears a right-hand handle column (generate / video / scene).
   */
  variant?: "card" | "inset";
};

export function NodeLockButton({
  locked,
  disabled,
  disabledTitle,
  lockedTitle,
  unlockedTitle,
  onToggle,
  variant = "card",
}: Props) {
  const pos = variant === "inset" ? "right-10 top-1.5" : "right-2 top-1.5";
  const title = disabled ? (disabledTitle ?? "Unavailable") : locked ? lockedTitle : unlockedTitle;

  return (
    <button
      type="button"
      aria-label={title}
      aria-pressed={locked}
      disabled={disabled}
      title={title}
      className={`nodrag nopan absolute ${pos} z-[5] flex size-7 items-center justify-center rounded-md border border-border/70 bg-card/95 text-muted-foreground shadow-sm transition-colors hover:border-border hover:bg-muted/90 hover:text-foreground disabled:pointer-events-none disabled:opacity-40 dark:bg-card/80 ${
        locked && !disabled ? "border-amber-500/60 text-amber-600 dark:border-amber-500/50 dark:text-amber-400" : ""
      }`}
      onClick={() => {
        if (!disabled) onToggle(!locked);
      }}
    >
      {locked ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-[15px]"
          aria-hidden
        >
          <rect x="5" y="11" width="14" height="10" rx="2" />
          <path d="M8 11V8a4 4 0 018 0v3" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-[15px]"
          aria-hidden
        >
          <rect x="5" y="11" width="14" height="10" rx="2" />
          <path d="M8 11V8a4 4 0 017.5-1.3" />
        </svg>
      )}
    </button>
  );
}
