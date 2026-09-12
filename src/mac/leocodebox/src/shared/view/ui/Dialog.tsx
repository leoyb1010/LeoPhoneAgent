import * as React from 'react';
import { createPortal } from 'react-dom';

import { cn } from '../../../lib/utils';

import { activateModalLayer } from './modalFocus';

interface DialogContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: React.MutableRefObject<HTMLElement | null>;
  depth: number;
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

function useDialog() {
  const ctx = React.useContext(DialogContext);
  if (!ctx) throw new Error('Dialog components must be used within <Dialog>');
  return ctx;
}

interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

const Dialog: React.FC<DialogProps> = ({ open: controlledOpen, onOpenChange: controlledOnOpenChange, defaultOpen = false, children }) => {
  const parent = React.useContext(DialogContext);
  const depth = parent ? parent.depth + 1 : 0;
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const triggerRef = React.useRef<HTMLElement | null>(null) as React.MutableRefObject<HTMLElement | null>;
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const onOpenChange = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setInternalOpen(next);
      controlledOnOpenChange?.(next);
    },
    [isControlled, controlledOnOpenChange]
  );

  const value = React.useMemo(() => ({ open, onOpenChange, triggerRef, depth }), [open, onOpenChange, depth]);

  return <DialogContext.Provider value={value}>{children}</DialogContext.Provider>;
};

const DialogTrigger = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }>(
  ({ onClick, children, asChild, ...props }, ref) => {
    const { onOpenChange, triggerRef } = useDialog();

    const handleClick = React.useCallback(
      (e: React.MouseEvent<HTMLButtonElement>) => {
        onOpenChange(true);
        onClick?.(e);
      },
      [onOpenChange, onClick]
    );

    // asChild: clone child element and compose onClick + capture ref
    if (asChild && React.isValidElement(children)) {
      const child = children as React.ReactElement<any>;
      return React.cloneElement(child, {
        onClick: (e: React.MouseEvent<HTMLElement>) => {
          onOpenChange(true);
          child.props.onClick?.(e);
        },
        ref: (node: HTMLElement | null) => {
          triggerRef.current = node;
          // Forward the outer ref
          if (typeof ref === 'function') ref(node as any);
          else if (ref) (ref as React.MutableRefObject<any>).current = node;
        },
      });
    }

    return (
      <button
        ref={(node) => {
          triggerRef.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) ref.current = node;
        }}
        type="button"
        onClick={handleClick}
        {...props}
      >
        {children}
      </button>
    );
  }
);
DialogTrigger.displayName = 'DialogTrigger';

interface DialogContentProps extends React.HTMLAttributes<HTMLDivElement> {
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onPointerDownOutside?: () => void;
  wrapperClassName?: string;
  placement?: 'center' | 'left';
}

const DialogContent = React.forwardRef<HTMLDivElement, DialogContentProps>(
  ({ className, children, onEscapeKeyDown, onPointerDownOutside, wrapperClassName, placement = 'center', ...props }, ref) => {
    const { open, onOpenChange, triggerRef, depth } = useDialog();
    const contentRef = React.useRef<HTMLDivElement | null>(null);
    const rootRef = React.useRef<HTMLDivElement | null>(null);
    const callbacksRef = React.useRef({ onOpenChange, onEscapeKeyDown });
    callbacksRef.current = { onOpenChange, onEscapeKeyDown };
    const [present, setPresent] = React.useState(open);

    React.useEffect(() => {
      if (open) {
        setPresent(true);
        return undefined;
      }
      const timer = window.setTimeout(() => setPresent(false), 140);
      return () => window.clearTimeout(timer);
    }, [open]);

    React.useLayoutEffect(() => {
      if (!open || !present || !rootRef.current || !contentRef.current) return undefined;
      return activateModalLayer({
        root: rootRef.current,
        content: contentRef.current,
        depth,
        restoreFocusTo: triggerRef.current,
        onDismiss: () => callbacksRef.current.onOpenChange(false),
        onEscapeKeyDown: (event) => callbacksRef.current.onEscapeKeyDown?.(event),
      });
    }, [open, present, depth, triggerRef]);

    if (!present) return null;

    return createPortal(
      // z-[10000] keeps dialogs above the Settings modal (z-[9999]) so a dialog
      // opened from inside Settings (e.g. the Agent Hub profile editor) is not
      // painted behind it. Dialogs are the active interaction — always topmost.
      <div ref={rootRef} data-dialog-layer data-state={open ? 'open' : 'closed'} {...(!open ? { inert: '' } : {})} style={{ pointerEvents: open ? undefined : 'none' }} className={cn('fixed inset-0 z-[10000]', wrapperClassName)}>
        {/* Overlay */}
        <div
          className="dialog-overlay fixed inset-0 bg-black/50 backdrop-blur-sm"
          onClick={() => {
            onPointerDownOutside?.();
            onOpenChange(false);
          }}
          aria-hidden
        />
        {/* Content */}
        <div
          ref={(node) => {
            contentRef.current = node;
            if (typeof ref === 'function') ref(node);
            else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
          }}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
          className={cn(
            placement === 'left'
              ? 'dialog-drawer-content fixed bottom-0 left-0 top-0 z-[10000] flex w-[320px] max-w-[92vw] flex-col border-r'
              : 'dialog-content fixed left-1/2 top-1/2 z-[10000] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border',
            'bg-popover text-popover-foreground shadow-elevation-2',
            className
          )}
          {...props}
        >
          {children}
        </div>
      </div>,
      document.body
    );
  }
);
DialogContent.displayName = 'DialogContent';

const DialogTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h2 ref={ref} className={cn('sr-only', className)} {...props} />
  )
);
DialogTitle.displayName = 'DialogTitle';

export { Dialog, DialogTrigger, DialogContent, DialogTitle, useDialog };
