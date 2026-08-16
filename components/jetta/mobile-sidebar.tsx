"use client";

import { useState } from "react";
import { Dialog } from "radix-ui";
import { ConsoleSidebar } from "./console-sidebar";

/**
 * The sidebar as a drawer, under `md`. Same component, same nav model — the
 * only difference is that it never renders collapsed (a 3rem icon rail is a
 * desktop space-saving trick and pointless in an overlay) and closes itself on
 * navigation, which `onNavigate` signals.
 */
export function MobileSidebar({
  isAdmin,
  defaultCollapsed,
  icon,
}: {
  isAdmin: boolean;
  defaultCollapsed: boolean;
  icon: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        aria-label="Open navigation"
        className="-ml-1 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none md:hidden [&_svg]:size-4"
      >
        {icon}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 md:hidden data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed inset-y-0 left-0 z-50 w-60 border-r bg-sidebar md:hidden data-[state=open]:animate-in data-[state=open]:slide-in-from-left">
          <Dialog.Title className="sr-only">Navigation</Dialog.Title>
          <ConsoleSidebar
            isAdmin={isAdmin}
            defaultCollapsed={defaultCollapsed}
            onNavigate={() => setOpen(false)}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
