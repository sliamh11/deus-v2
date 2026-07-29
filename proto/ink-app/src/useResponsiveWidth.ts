// LIA-496 IB1 (I4) — real resize subscription. `useStdout()` alone is a
// bare context read with no resize subscription of its own (confirmed by
// reading `node_modules/ink/build/hooks/use-stdout.js` directly — it's
// nothing but `useContext(StdoutContext)`). `StdoutContext`'s own default
// value is the real `process.stdout` (`StdoutContext.js`), a genuine Node
// `WriteStream`/TTY that emits its own `'resize'` event — this hook adds
// the manual `stdout.on('resize', ...)` listener the plan's own
// constraint (Q2) requires, cleaned up on unmount, updating local state
// that drives frame width. `App.tsx` uses the returned width for the
// dynamic-tail frame; `committedBlocks.tsx`'s `<Static>` region takes the
// same value as a prop so already-committed and still-dynamic output stay
// visually aligned at any terminal size.
import { useEffect, useState } from "react";
import { useStdout } from "ink";

const FALLBACK_WIDTH = 104;

export function useResponsiveWidth(): number {
  const { stdout } = useStdout();
  const [width, setWidth] = useState<number>(() => stdout?.columns ?? FALLBACK_WIDTH);

  useEffect(() => {
    if (!stdout) return;
    const handleResize = () => setWidth(stdout.columns ?? FALLBACK_WIDTH);
    handleResize();
    stdout.on("resize", handleResize);
    return () => {
      stdout.off("resize", handleResize);
    };
  }, [stdout]);

  return width;
}
